// ============================================================================
// src/sim/verbs/verbs.ts — the VERB SYSTEM: RUSH / GRAB / THROW / STRUGGLE.
// ============================================================================
//
// applyVerbs(w, inputs, index) is ONE deterministic system that turns per-player
// input into the four verbs plus the five "grab pressures" from
// docs/02-roles-anchor-verbs.md. It is a pure function of (state, inputs, tick):
// integer + Fixed math only, ascending-id sweeps only, all tick-state stored in
// WorldState (so it is hashed + survives rollback). No Date / Math.random / float.
//
// WHERE IT SLOTS IN step()  (recommendation for the integrator)
// -------------------------------------------------------------
// Run applyVerbs as a NEW system AFTER the existing SYSTEM 5 (carry transform),
// i.e. as SYSTEM 6, the LAST thing in step(), BEFORE `w.tick++`:
//
//     step(w, inputs):
//       1 input->accel  2 gravity  3 integrate  4 ground+friction
//       5 carry transform
//       6 applyVerbs(w, inputs, index)   // <-- here
//       w.tick++
//
// WHY LAST: applyVerbs needs post-integration positions to resolve grab cones,
// rush contacts and shove/throw geometry against where bodies actually ended up
// this tick; and it takes FINAL authority over velocity for the kinematic rush
// sweep and the encumbrance speed-cap (pressure c), which must override the base
// motion clamp. Held bodies are already slaved by SYSTEM 5; applyVerbs only
// manages the linkage + the held body's escape (struggle), never re-positions a
// held body (no fight with the carry transform). The rush DASH is applied as a
// kinematic position sweep this tick (+ matching velocity), per the spec
// ("Kinematic sweep, not a solver impulse").
//
// IMPORTANT: the spatial index passed in must already be rebuilt for the current
// tick (the integrator rebuilds it once per tick); applyVerbs only queries it.
//
// SUB-SYSTEM ORDER inside applyVerbs (fixed, all ascending-id):
//   A. tick bookkeeping: expire stagger, reset air-rush on ground, decay struggle.
//   B. RUSH: start dashes; advance active dashes (ease-out sweep); bump-to-break.
//   C. GRAB: start/advance/complete latch; validate existing holds (grabber-prey,
//      MAX_HELPLESS); enforce REGRAB_IMMUNITY; encumbrance disables new grabs.
//   D. STRUGGLE: press-edge debounced accumulate; break a hold past threshold.
//   E. THROW / SHOVE: idempotent impulse on the release tick.
//   F. ENCUMBRANCE: clamp each carrier's horizontal speed to the carried-tier cap.
//   G. prevButtons <- buttons (must be LAST so every edge detector above saw the
//      previous tick's buttons).
// ============================================================================

import {
  type Fixed,
  add, sub, mul, div, neg, abs, lt, gt, gte, lte, clamp, min, max,
  sqrt, sin, cos, fromInt, ZERO, ONE, toRaw, fromRaw,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, MassClass, NO_ENTITY, MASS_OF,
  hasFlag, setFlag, clearFlag,
} from '../world/state.ts';
import { type PlayerInput, Button, isDown, NEUTRAL_INPUT } from '../world/input.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import {
  RUSH_DIST, RUSH_TICKS, RUSH_CD_TICKS, RUSH_STAGGER_TICKS,
  RUSH_PUSHBACK_BASE, RUSH_PUSHBACK_MIN, RUSH_PUSHBACK_MAX, RUSH_HIT_RADIUS,
  GRAB_REACH, GRAB_HALF_ANGLE, GRAB_LATCH_TICKS, CARRY_REACH,
  THROW_CHARGE_TICKS, THROW_J, THROW_ANGLE_MIN, THROW_ANGLE_MAX,
  THROW_ANGLE_DEFAULT, THROW_JITTER_RANGE,
  SHOVE_J, SHOVE_REACH, SHOVE_CD_TICKS,
  STRUGGLE_BREAK, STRUGGLE_PRESS, STRUGGLE_DEBOUNCE_TICKS, STRUGGLE_IDLE_TICKS,
  STRUGGLE_DECAY, CARRIER_GRIP,
  REGRAB_IMMUNITY_TICKS, MAX_HELPLESS_TICKS,
  Role, THROW_STRENGTH, STRUGGLE_STRENGTH, CARRY_SPEED_MUL,
  JUMP_SPEED, JUMP_MUL,
} from './config.ts';
import { jitterUnit, JitterChannel } from './jitter.ts';

/** MAX_SPEED base (mirrors step.ts; encumbrance scales this for carriers). */
const MAX_SPEED: Fixed = (() => {
  // step.ts uses fromFloatConst(7); we re-derive the same raw constant here so the
  // encumbrance cap matches the base motion cap without importing step (avoids a
  // cycle: step is a consumer of verbs, not the other way around).
  return fromRaw(7 << 16);
})();

/**
 * Optional per-body role lookup (defaults to Runner). WorldState has no role field
 * yet, so the caller may pass roles[id]; absent => Runner baseline. This keeps the
 * role-strength numbers usable without a state schema change beyond the verb fields.
 */
export type RoleMap = ReadonlyArray<Role | undefined> | undefined;

// Prefer an explicit RoleMap override; else read the body's own role from world
// state (set at spawn). Anchor/None map to Runner-baseline strength (they aren't in
// the strength tables' 0..5 role slots beyond Anchor=5, which IS valid).
const roleOf = (w: WorldState, roles: RoleMap, id: number): Role => {
  const r = roles?.[id];
  if (r !== undefined) return r;
  const wr = w.role[id]!;
  return wr <= Role.Anchor ? (wr as Role) : Role.Runner;
};

const inputOf = (inputs: ReadonlyArray<PlayerInput | undefined>, id: number): PlayerInput =>
  inputs[id] ?? NEUTRAL_INPUT;

/** Half-height-aware "is grounded" convenience. */
const grounded = (w: WorldState, id: number): boolean => hasFlag(w, id, BodyFlag.Grounded);

/** A scratch id buffer reused across queries (length reset each use; not state). */
const scratch: number[] = [];

/**
 * The verb system. Mutates and returns `w`. `inputs[id]` is body id's input this
 * tick (undefined => neutral). `index` must be rebuilt for the current tick.
 * `roles` is optional (defaults all bodies to Runner strength).
 */
export function applyVerbs(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  roles?: RoleMap,
): WorldState {
  const count = w.count;
  const tick = w.tick;

  // ---- A. tick bookkeeping -------------------------------------------------
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    // expire stagger (stagger does NOT use the Downed flag — Downed is the
    // fall/throw-down beat with its own downedUntil countdown, expired below).
    if (w.staggerUntil[i]! >= 0 && tick >= w.staggerUntil[i]!) {
      w.staggerUntil[i] = -1;
    }
    // expire the DOWNED beat (fall/throw-down vulnerable window) on its own timer.
    if (w.downedUntil[i]! >= 0 && tick >= w.downedUntil[i]!) {
      w.downedUntil[i] = -1;
      clearFlag(w, i, BodyFlag.Downed);
    }
    // reset air-rush when grounded
    if (grounded(w, i)) w.airRushUsed[i] = 0;
    // expire an active rush dash whose window has ended
    if (w.rushUntil[i]! >= 0 && tick >= w.rushUntil[i]!) {
      w.rushUntil[i] = -1;
      w.rushStart[i] = -1;
    }
    // STRUGGLE idle decay: if held and no recent press, bleed progress down.
    const carrier = w.grabbedBy[i]!;
    if (carrier !== NO_ENTITY && w.struggleProgress[i]! > 0) {
      const last = w.struggleLastPress[i]!;
      if (last < 0 || tick - last >= STRUGGLE_IDLE_TICKS) {
        const dec = STRUGGLE_DECAY;
        const cur = fromRaw(w.struggleProgress[i]!);
        w.struggleProgress[i] = toRaw(max(ZERO, sub(cur, dec)));
      }
    }
  }

  // ---- B0. JUMP ------------------------------------------------------------
  jumpSystem(w, inputs, count, tick);

  // ---- B. RUSH -------------------------------------------------------------
  rushSystem(w, inputs, index, count, tick);

  // ---- C. GRAB -------------------------------------------------------------
  grabSystem(w, inputs, index, count, tick);

  // ---- D. STRUGGLE ---------------------------------------------------------
  struggleSystem(w, inputs, count, tick, roles);

  // ---- E. THROW / SHOVE ----------------------------------------------------
  throwSystem(w, inputs, index, count, tick, roles);

  // ---- F. ENCUMBRANCE ------------------------------------------------------
  encumbranceSystem(w, count);

  // NOTE: prevButtons is committed by the SIM at the very END of the tick (after
  // beacons/other edge-reading systems also run), via commitPrevButtons() — not
  // here — so every edge detector this tick saw the SAME previous-tick buttons.
  return w;
}

/**
 * Commit each body's buttons into prevButtons for next-tick edge detection. MUST be
 * the LAST thing in the tick (after verbs AND beacons), so all edge-reading systems
 * share one consistent previous-buttons snapshot. Pure ascending-id sweep.
 */
export function commitPrevButtons(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
): void {
  for (let i = 0; i < w.count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    w.prevButtons[i] = inputOf(inputs, i).buttons | 0;
  }
}

// ============================================================================
// JUMP — vertical launch (docs/02 §1, §2.1, §4.1)
// ============================================================================
// On the Jump press-edge, while GROUNDED, NOT staggered, and HANDS-FREE
// (Pressure A: holding anything disables JUMP), set vy to a per-mass jump speed
// and clear Grounded. The Anchor's low JUMP_MUL is its gap-lock constraint — it
// cannot self-clear a real chasm, forcing the crew to carry/throw it across.
function jumpSystem(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  count: number,
  tick: number,
): void {
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const inp = inputOf(inputs, i);
    if (!edge(w, inp, Button.Jump, i)) continue;
    if (!grounded(w, i)) continue; // ground jump only (air-rush is the air option)
    if (w.holding[i] !== NO_ENTITY) continue; // Pressure A: hands-full disables jump
    if (isStaggered(w, i, tick)) continue; // staggered can't jump
    const speed = mul(JUMP_SPEED, JUMP_MUL[w.massClass[i]!]!);
    w.vy[i] = toRaw(speed);
    clearFlag(w, i, BodyFlag.Grounded);
  }
}

// ============================================================================
// RUSH — dash + bump-to-break (pressure e)
// ============================================================================
function rushSystem(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  count: number,
  tick: number,
): void {
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;

    const inp = inputOf(inputs, i);
    const pressedRush = edge(w, inp, Button.Rush, i);

    // --- start a new dash on a fresh Rush press edge ---
    if (
      pressedRush &&
      w.rushUntil[i]! < 0 && // not already dashing
      (w.rushCdUntil[i]! < 0 || tick >= w.rushCdUntil[i]!) && // off cooldown
      !isStaggered(w, i, tick) // staggered can't ability
    ) {
      const airborne = !grounded(w, i);
      if (!airborne || w.airRushUsed[i]! === 0) {
        if (airborne) w.airRushUsed[i] = 1; // air-rush once until grounded
        w.rushStart[i] = tick;
        w.rushUntil[i] = tick + RUSH_TICKS;
        w.rushCdUntil[i] = tick + RUSH_CD_TICKS;
        w.facing[i] = inp.aim; // dash along current aim
      }
    }

    // --- advance an active dash this tick (ease-out kinematic sweep) ---
    if (w.rushUntil[i]! >= 0) {
      const start = w.rushStart[i]!;
      // progress fraction through the dash, ease-out so most distance is early.
      const elapsed = tick - start; // 0..RUSH_TICKS-1 while active
      let stepDist = rushStepDistance(elapsed);
      // ENCUMBRANCE (Pressure C, §2.1): a hands-full rush is shortened by the
      // carried tier's carry-speed multiplier — rushing while carrying the Anchor
      // covers ~1.0u, not the full 4.0u.
      const held = w.holding[i]!;
      if (held !== NO_ENTITY) stepDist = mul(stepDist, CARRY_SPEED_MUL[w.massClass[held]!]!);
      if (gt(stepDist, ZERO)) {
        const f = fromRaw(w.facing[i]!);
        const dx = mul(stepDist, cos(f));
        const dz = mul(stepDist, sin(f));
        const oldX = fromRaw(w.px[i]!);
        const oldZ = fromRaw(w.pz[i]!);
        w.px[i] = toRaw(add(oldX, dx));
        w.pz[i] = toRaw(add(oldZ, dz));
        // carry velocity so it feels like momentum (will be capped by encumbrance)
        w.vx[i] = toRaw(mul(dx, fromInt(60))); // dx per tick -> per second
        w.vz[i] = toRaw(mul(dz, fromInt(60)));
        // --- bump-to-break: rush contact onto another body ---
        rushBump(w, index, i, tick, stepDist);
      }
    }
  }
}

/**
 * Distance covered on THIS tick of the dash, given ticks elapsed since start.
 * Ease-out: the per-tick share decreases linearly so total over RUSH_TICKS sums
 * to ~RUSH_DIST. Weight w(k) = (RUSH_TICKS - k); share = RUSH_DIST * w(k)/sum(w).
 * sum(w) over k=0..N-1 = N*(N+1)/2. All Fixed/integer — deterministic.
 */
function rushStepDistance(elapsed: number): Fixed {
  if (elapsed < 0 || elapsed >= RUSH_TICKS) return ZERO;
  const wK = RUSH_TICKS - elapsed; // N..1
  const denom = (RUSH_TICKS * (RUSH_TICKS + 1)) / 2; // integer
  // RUSH_DIST * wK / denom
  return div(mul(RUSH_DIST, fromInt(wK)), fromInt(denom));
}

/** Apply bump-to-break + stagger + pushback to bodies the rusher contacts. */
function rushBump(
  w: WorldState,
  index: SpatialIndex,
  rusher: number,
  tick: number,
  _stepDist: Fixed,
): void {
  const rx = w.px[rusher]!;
  const rz = w.pz[rusher]!;
  const reach = toRaw(add(fromRaw(w.radius[rusher]!), RUSH_HIT_RADIUS));
  index.queryRadius(rx, rz, reach, scratch);
  for (const t of scratch) {
    if (t === rusher) continue;
    if (!hasFlag(w, t, BodyFlag.Alive)) continue;
    // distance check including target radius
    const dx = sub(fromRaw(w.px[t]!), fromRaw(rx));
    const dz = sub(fromRaw(w.pz[t]!), fromRaw(rz));
    const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
    const hitR = add(add(fromRaw(w.radius[rusher]!), fromRaw(w.radius[t]!)), RUSH_HIT_RADIUS);
    if (gt(dist, hitR)) continue;

    // stagger (target can't grab/jump/ability) — interrupts a pending latch.
    applyStagger(w, t, tick);
    // pending latch interrupted (but an established hold is NOT auto-broken here;
    // bump-to-break SHORTENS/breaks the hold of a body that is itself a CARRIER):
    cancelPendingLatchOn(w, t);

    // bump-to-break (pressure e): if the staggered body is HOLDING someone,
    // shorten/break that hold — universal soft counter to grabs.
    const victim = w.holding[t]!;
    if (victim !== NO_ENTITY) {
      // shorten by pushing struggle progress near threshold; if already high, break.
      const prog = fromRaw(w.struggleProgress[victim]!);
      const bumped = add(prog, div(STRUGGLE_BREAK, fromInt(2))); // +50 progress
      if (gte(bumped, STRUGGLE_BREAK)) {
        breakHold(w, t, victim, tick);
      } else {
        w.struggleProgress[victim] = toRaw(bumped);
      }
    }

    // pushback 1.5u * (rusher_mass/target_mass) clamped [0.3,3.0]u, along dx/dz.
    const rm = MASS_OF[w.massClass[rusher]!]!;
    const tm = MASS_OF[w.massClass[t]!]!;
    let push = mul(RUSH_PUSHBACK_BASE, div(rm, tm));
    push = clamp(push, RUSH_PUSHBACK_MIN, RUSH_PUSHBACK_MAX);
    // direction from rusher to target (normalize; if coincident, push along facing)
    let nx: Fixed; let nz: Fixed;
    if (gt(dist, ZERO)) {
      nx = div(dx, dist);
      nz = div(dz, dist);
    } else {
      const f = fromRaw(w.facing[rusher]!);
      nx = cos(f); nz = sin(f);
    }
    // a carried target can't be shoved out of position by pushback (carrier owns it)
    if (w.grabbedBy[t] === NO_ENTITY) {
      w.px[t] = toRaw(add(fromRaw(w.px[t]!), mul(push, nx)));
      w.pz[t] = toRaw(add(fromRaw(w.pz[t]!), mul(push, nz)));
    }
  }
}

// ============================================================================
// GRAB — latch + carry; pressures a (hands-full) & d (grabber-is-prey) & invariants
// ============================================================================
function grabSystem(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  count: number,
  tick: number,
): void {
  // C1. Validate / maintain existing holds + pending latches first.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;

    // grabber-is-prey (pressure d): if carrier i is itself now held, it can't keep
    // a victim parented through it cleanly — drop what i holds (i becomes cargo).
    if (w.grabbedBy[i] !== NO_ENTITY && w.holding[i] !== NO_ENTITY) {
      breakHold(w, i, w.holding[i]!, tick);
    }

    const held = w.holding[i]!;
    if (held !== NO_ENTITY) {
      // carrier dead/invalid? drop.
      if (!hasFlag(w, held, BodyFlag.Alive) || w.grabbedBy[held] !== i) {
        forceDrop(w, i, tick);
      } else {
        // MAX_HELPLESS invariant: force-break a hold that has lasted too long.
        const since = w.heldSince[held]!;
        if (since >= 0 && tick - since >= MAX_HELPLESS_TICKS) {
          breakHold(w, i, held, tick);
        }
      }
    }

    // advance a pending latch owned by some carrier on body i (i is the target)
    const latchBy = w.grabLatchBy[i]!;
    if (latchBy !== NO_ENTITY) {
      const validCarrier =
        hasFlag(w, latchBy, BodyFlag.Alive) &&
        w.holding[latchBy] === NO_ENTITY &&
        !carrierEncumbered(w, latchBy) &&
        !isStaggered(w, latchBy, tick) &&
        stillHoldingGrab(inputs, latchBy) &&
        inCone(w, latchBy, i);
      if (!validCarrier) {
        cancelPendingLatchOn(w, i);
      } else if (tick >= w.grabLatchUntil[i]!) {
        // latch completes -> establish hold
        establishHold(w, latchBy, i, tick);
      }
    }
  }

  // C2. Start new latches from carriers pressing Grab with empty hands.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    if (w.holding[i] !== NO_ENTITY) continue; // hands-full (pressure a): no new grabs
    if (w.grabbedBy[i] !== NO_ENTITY) continue; // i is itself held -> can't grab
    if (isStaggered(w, i, tick)) continue; // staggered can't grab

    const inp = inputOf(inputs, i);
    if (!isDown(inp, Button.Grab)) {
      // releasing grab cancels any latch this carrier owns
      cancelLatchByCarrier(w, i);
      continue;
    }
    // already latching? (keep its target; validated in C1)
    if (ownsPendingLatch(w, i, count)) continue;

    const target = pickGrabTarget(w, index, i, inp, count, tick);
    if (target === NO_ENTITY) continue;
    // begin latch on target
    const latchTicks = GRAB_LATCH_TICKS[w.massClass[target]!]!;
    w.grabLatchBy[target] = i;
    w.grabLatchUntil[target] = tick + latchTicks;
  }
}

/**
 * Choose a grab target in i's cone per priority:
 *   enemy Anchor > prompt-able player > world object > player; ties -> lower id.
 * (We have no team data yet, so "enemy Anchor" == any Anchor; "prompt-able player"
 *  == a player flagged Throwable/Downed isn't modeled, so player tier is single.)
 * Honors an explicit inp.grabTarget if that id is a valid in-cone candidate.
 */
function pickGrabTarget(
  w: WorldState,
  index: SpatialIndex,
  i: number,
  inp: PlayerInput,
  count: number,
  tick: number,
): number {
  const px = w.px[i]!;
  const pz = w.pz[i]!;
  const reach = toRaw(add(fromRaw(w.radius[i]!), GRAB_REACH));
  index.queryRadius(px, pz, reach, scratch);

  // explicit target intent wins if valid
  if (inp.grabTarget >= 0 && inp.grabTarget < count) {
    const t = inp.grabTarget;
    if (isGrabbable(w, t, i, tick) && inCone(w, i, t)) return t;
  }

  let bestTier = 99;
  let best = NO_ENTITY;
  for (const t of scratch) {
    if (t === i) continue;
    if (!isGrabbable(w, t, i, tick)) continue;
    if (!inCone(w, i, t)) continue;
    const tier = grabTier(w, t);
    if (tier < bestTier || (tier === bestTier && (best === NO_ENTITY || t < best))) {
      bestTier = tier;
      best = t;
    }
  }
  return best;
}

/** Priority tier (lower = higher priority). */
function grabTier(w: WorldState, t: number): number {
  if (hasFlag(w, t, BodyFlag.Anchor)) return 0; // enemy Anchor
  if (hasFlag(w, t, BodyFlag.Throwable)) return 2; // world object
  if (hasFlag(w, t, BodyFlag.Player)) return 3; // player
  return 4;
}

/** Can body t be grabbed by i right now? (alive, not held, not on regrab immunity) */
function isGrabbable(w: WorldState, t: number, i: number, tick: number): boolean {
  if (!hasFlag(w, t, BodyFlag.Alive)) return false;
  if (t === i) return false;
  if (w.grabbedBy[t] !== NO_ENTITY) return false; // already held
  if (w.holding[t] !== NO_ENTITY) return false; // a carrier isn't directly grabbable mid-hold
  if (w.regrabUntil[t]! >= 0 && tick < w.regrabUntil[t]!) return false; // REGRAB_IMMUNITY
  // must be a grabbable kind: player, anchor, or throwable object
  return (
    hasFlag(w, t, BodyFlag.Player) ||
    hasFlag(w, t, BodyFlag.Anchor) ||
    hasFlag(w, t, BodyFlag.Throwable)
  );
}

/** Is target t inside i's frontal grab cone (reach + half-angle)? */
function inCone(w: WorldState, i: number, t: number): boolean {
  const dx = sub(fromRaw(w.px[t]!), fromRaw(w.px[i]!));
  const dz = sub(fromRaw(w.pz[t]!), fromRaw(w.pz[i]!));
  const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
  const reach = add(add(fromRaw(w.radius[i]!), fromRaw(w.radius[t]!)), GRAB_REACH);
  if (gt(dist, reach)) return false;
  if (lte(dist, ZERO)) return true; // coincident -> in cone
  // angle between facing and (dx,dz): compare via dot product vs cos(halfAngle).
  const f = fromRaw(w.facing[i]!);
  const fx = cos(f);
  const fz = sin(f);
  const nx = div(dx, dist);
  const nz = div(dz, dist);
  const dot = add(mul(fx, nx), mul(fz, nz)); // = cos(angle)
  const cosHalf = cos(GRAB_HALF_ANGLE);
  return gte(dot, cosHalf);
}

/** Establish a hold: parent target to carrier, set NoGravity, init invariants. */
function establishHold(w: WorldState, carrier: number, target: number, tick: number): void {
  w.holding[carrier] = target;
  w.grabbedBy[target] = carrier;
  setFlag(w, target, BodyFlag.NoGravity);
  w.heldSince[target] = tick;
  w.struggleProgress[target] = 0;
  w.struggleLastPress[target] = -1;
  // clear the pending latch bookkeeping on the target
  w.grabLatchBy[target] = NO_ENTITY;
  w.grabLatchUntil[target] = -1;
}

/** Break a hold (struggle/bump/MAX_HELPLESS): drop + REGRAB_IMMUNITY on the freed body. */
function breakHold(w: WorldState, carrier: number, target: number, tick: number): void {
  forceDrop(w, carrier, tick);
}

/** Drop whatever `carrier` holds, restoring gravity + arming REGRAB_IMMUNITY. */
function forceDrop(w: WorldState, carrier: number, tick: number): void {
  const target = w.holding[carrier]!;
  if (target === NO_ENTITY) return;
  w.holding[carrier] = NO_ENTITY;
  if (w.grabbedBy[target] === carrier) w.grabbedBy[target] = NO_ENTITY;
  clearFlag(w, target, BodyFlag.NoGravity);
  w.heldSince[target] = -1;
  w.struggleProgress[target] = 0;
  w.struggleLastPress[target] = -1;
  w.regrabUntil[target] = tick + REGRAB_IMMUNITY_TICKS;
}

/** Cancel a pending latch where body `t` is the target. */
function cancelPendingLatchOn(w: WorldState, t: number): void {
  if (w.grabLatchBy[t] !== NO_ENTITY || w.grabLatchUntil[t]! >= 0) {
    w.grabLatchBy[t] = NO_ENTITY;
    w.grabLatchUntil[t] = -1;
  }
}

/** Cancel any pending latch OWNED by carrier `c` (scan targets). */
function cancelLatchByCarrier(w: WorldState, c: number): void {
  const n = w.count;
  for (let t = 0; t < n; t++) {
    if (w.grabLatchBy[t] === c) {
      w.grabLatchBy[t] = NO_ENTITY;
      w.grabLatchUntil[t] = -1;
    }
  }
}

/** Does carrier c currently own a pending latch on some target? */
function ownsPendingLatch(w: WorldState, c: number, count: number): boolean {
  for (let t = 0; t < count; t++) if (w.grabLatchBy[t] === c) return true;
  return false;
}

/** Is the carrier still holding the Grab button (latch persistence)? */
function stillHoldingGrab(
  inputs: ReadonlyArray<PlayerInput | undefined>,
  carrier: number,
): boolean {
  return isDown(inputOf(inputs, carrier), Button.Grab);
}

// ============================================================================
// STRUGGLE — pressure b (break holds); press-edge debounced
// ============================================================================
function struggleSystem(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  count: number,
  tick: number,
  roles: RoleMap,
): void {
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    const carrier = w.grabbedBy[i]!;
    if (carrier === NO_ENTITY) continue; // only held bodies struggle

    // held-never-inert invariant: a held body can ALWAYS struggle (we read its
    // input every tick regardless of any other gating).
    const inp = inputOf(inputs, i);
    const pressed = edge(w, inp, Button.Struggle, i);
    if (!pressed) continue;

    // debounce: ignore presses < STRUGGLE_DEBOUNCE_TICKS apart.
    const last = w.struggleLastPress[i]!;
    if (last >= 0 && tick - last < STRUGGLE_DEBOUNCE_TICKS) continue;
    w.struggleLastPress[i] = tick;

    // press = 6 * struggler_strength * (struggler_mass / carrier_grip)
    const strength = STRUGGLE_STRENGTH[roleOf(w, roles, i)]!;
    const mass = MASS_OF[w.massClass[i]!]!;
    const grip = CARRIER_GRIP; // carrier resistance (uniform for now)
    const inc = mul(mul(STRUGGLE_PRESS, strength), div(mass, grip));
    const next = add(fromRaw(w.struggleProgress[i]!), inc);
    if (gte(next, STRUGGLE_BREAK)) {
      // break free
      forceDrop(w, carrier, tick);
    } else {
      w.struggleProgress[i] = toRaw(next);
    }
  }
}

// ============================================================================
// THROW / SHOVE — idempotent impulse on the release tick
// ============================================================================
function throwSystem(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  count: number,
  tick: number,
  roles: RoleMap,
): void {
  // The four-button control model (docs/02 §1): GRAB and THROW share the grab
  // button by HOLD-vs-RELEASE. Holding GRAB with something in hand BUILDS charge;
  // RELEASING GRAB throws the held body at that charge. SHOVE (empty-hand) is the
  // separate Throw button, a tap. So:
  //   THROW (of held) := GRAB release-edge while holding, charge from throwCharge.
  //   SHOVE           := Throw press-edge while NOT holding.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;

    const inp = inputOf(inputs, i);
    const grabNow = isDown(inp, Button.Grab);
    const grabPrev = (w.prevButtons[i]! & Button.Grab) !== 0;
    const grabReleaseEdge = grabPrev && !grabNow;
    const throwNow = isDown(inp, Button.Throw);
    const throwPrev = (w.prevButtons[i]! & Button.Throw) !== 0;
    const throwPressEdge = throwNow && !throwPrev;

    // --- charged THROW of the held body, on GRAB release ---
    const target = w.holding[i]!;
    if (grabReleaseEdge && target !== NO_ENTITY) {
      if (w.lastThrowTick[i]! === tick) continue; // idempotency per (thrower, tick)
      const c = chargeFraction(w, i);
      applyThrow(w, i, target, c, tick, roles);
      w.lastThrowTick[i] = tick;
      w.throwCharge[i] = 0; // reset charge accumulator
      continue;
    }

    // --- empty-hand SHOVE, on a Throw-button tap with nothing held ---
    if (throwPressEdge && w.holding[i] === NO_ENTITY) {
      if (w.lastShoveTick[i]! >= 0 && tick - w.lastShoveTick[i]! < SHOVE_CD_TICKS) continue;
      applyShove(w, index, i, inp, tick);
      w.lastShoveTick[i] = tick;
    }
  }

  // Charge accumulation: while GRAB is held AND hands are full, ramp throwCharge
  // (ticks) toward THROW_CHARGE_TICKS. Released/empty → reset to 0.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const inp = inputOf(inputs, i);
    if (isDown(inp, Button.Grab) && w.holding[i] !== NO_ENTITY) {
      const t = w.throwCharge[i]! + 1;
      w.throwCharge[i] = t > THROW_CHARGE_TICKS ? THROW_CHARGE_TICKS : t;
    } else if (w.holding[i] === NO_ENTITY) {
      w.throwCharge[i] = 0;
    }
  }
}

/** Charge fraction c in [0,1] as Fixed (throwCharge/THROW_CHARGE_TICKS). */
function chargeFraction(w: WorldState, i: number): Fixed {
  const t = w.throwCharge[i]!;
  const c = div(fromInt(t), fromInt(THROW_CHARGE_TICKS));
  return clamp(c, ZERO, ONE);
}

/**
 * Apply a charged throw as a SINGLE impulse on the release tick. Pure function of
 * (charge, target mass, thrower strength, seeded jitter) -> deterministic, and
 * idempotent via the (thrower, releaseTick) guard in the caller. The held body is
 * released first (gravity restored), then given the launch velocity.
 *
 * J = THROW_J * c * (1/sqrt(mass_target)) * thrower_strength
 * Direction: thrower facing, lofted at THROW_ANGLE_DEFAULT + tiny seeded jitter,
 *            clamped to [THROW_ANGLE_MIN, THROW_ANGLE_MAX].
 */
function applyThrow(
  w: WorldState,
  thrower: number,
  target: number,
  c: Fixed,
  tick: number,
  roles: RoleMap,
): void {
  // release linkage (no regrab immunity needed on a throw — it's intentional)
  w.holding[thrower] = NO_ENTITY;
  w.grabbedBy[target] = NO_ENTITY;
  clearFlag(w, target, BodyFlag.NoGravity);
  w.heldSince[target] = -1;
  w.struggleProgress[target] = 0;
  w.struggleLastPress[target] = -1;
  w.regrabUntil[target] = tick + REGRAB_IMMUNITY_TICKS;

  const mass = MASS_OF[w.massClass[target]!]!;
  const invSqrtM = div(ONE, sqrt(mass)); // 1/sqrt(mass)
  const strength = THROW_STRENGTH[roleOf(w, roles, thrower)]!;
  const j = mul(mul(mul(THROW_J, c), invSqrtM), strength);

  // arc angle = default + jitter, clamped.
  const jit = mul(THROW_JITTER_RANGE, jitterUnit(tick, thrower, JitterChannel.ThrowAngle));
  const angle = clamp(add(THROW_ANGLE_DEFAULT, jit), THROW_ANGLE_MIN, THROW_ANGLE_MAX);

  // decompose: horizontal along facing scaled by cos(angle); vertical by sin(angle).
  const f = fromRaw(w.facing[thrower]!);
  const horiz = mul(j, cos(angle));
  const vert = mul(j, sin(angle));
  w.vx[target] = toRaw(mul(horiz, cos(f)));
  w.vz[target] = toRaw(mul(horiz, sin(f)));
  w.vy[target] = toRaw(vert);
  // nudge the thrown body to just beyond the carry socket so it doesn't re-collide
  // with the thrower (use CARRY_REACH — where it actually was — not GRAB_REACH).
  const nudge = add(CARRY_REACH, fromRaw(w.radius[target]!));
  w.px[target] = toRaw(add(fromRaw(w.px[thrower]!), mul(nudge, cos(f))));
  w.pz[target] = toRaw(add(fromRaw(w.pz[thrower]!), mul(nudge, sin(f))));
}

/** Empty-hand SHOVE: micro impulse on the first body in a short frontal cone. */
function applyShove(
  w: WorldState,
  index: SpatialIndex,
  i: number,
  inp: PlayerInput,
  tick: number,
): void {
  void tick;
  const px = w.px[i]!;
  const pz = w.pz[i]!;
  const reach = toRaw(add(fromRaw(w.radius[i]!), SHOVE_REACH));
  index.queryRadius(px, pz, reach, scratch);
  // shove the highest-priority in-cone body (lowest id wins ties); skip anchors
  // ("can't meaningfully move an Anchor").
  let best = NO_ENTITY;
  for (const t of scratch) {
    if (t === i) continue;
    if (!hasFlag(w, t, BodyFlag.Alive)) continue;
    if (!shoveCone(w, i, t)) continue;
    if (best === NO_ENTITY || t < best) best = t;
  }
  if (best === NO_ENTITY) return;
  const f = fromRaw(w.facing[i]!);
  const mass = MASS_OF[w.massClass[best]!]!;
  // micro impulse scaled by 1/mass so an Anchor barely budges.
  const j = div(SHOVE_J, mass);
  // Anchors: clamp to a negligible nudge (can't meaningfully move).
  const eff = hasFlag(w, best, BodyFlag.Anchor) ? min(j, fromRaw(2 << 14)) : j;
  if (w.grabbedBy[best] === NO_ENTITY) {
    w.vx[best] = toRaw(add(fromRaw(w.vx[best]!), mul(eff, cos(f))));
    w.vz[best] = toRaw(add(fromRaw(w.vz[best]!), mul(eff, sin(f))));
  }
}

/** Short frontal cone for shove (reuse cone test with SHOVE_REACH). */
function shoveCone(w: WorldState, i: number, t: number): boolean {
  const dx = sub(fromRaw(w.px[t]!), fromRaw(w.px[i]!));
  const dz = sub(fromRaw(w.pz[t]!), fromRaw(w.pz[i]!));
  const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
  const reach = add(add(fromRaw(w.radius[i]!), fromRaw(w.radius[t]!)), SHOVE_REACH);
  if (gt(dist, reach)) return false;
  if (lte(dist, ZERO)) return true;
  const f = fromRaw(w.facing[i]!);
  const dot = add(mul(cos(f), div(dx, dist)), mul(sin(f), div(dz, dist)));
  return gte(dot, cos(GRAB_HALF_ANGLE));
}

// ============================================================================
// ENCUMBRANCE — pressure c: clamp carrier speed by carried tier
// ============================================================================
function encumbranceSystem(w: WorldState, count: number): void {
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    const held = w.holding[i]!;
    if (held === NO_ENTITY) continue;
    const mulC = CARRY_SPEED_MUL[w.massClass[held]!]!;
    const cap = mul(MAX_SPEED, mulC);
    // clamp horizontal velocity magnitude to cap (preserve direction).
    const vx = fromRaw(w.vx[i]!);
    const vz = fromRaw(w.vz[i]!);
    const speedSq = add(mul(vx, vx), mul(vz, vz));
    const capSq = mul(cap, cap);
    if (gt(speedSq, capSq)) {
      const mag = sqrt(speedSq);
      if (gt(mag, ZERO)) {
        const s = div(cap, mag);
        w.vx[i] = toRaw(mul(vx, s));
        w.vz[i] = toRaw(mul(vz, s));
      }
    }
  }
}

// ============================================================================
// shared helpers
// ============================================================================
function isPlayerLike(w: WorldState, i: number): boolean {
  return hasFlag(w, i, BodyFlag.Player) || hasFlag(w, i, BodyFlag.Anchor);
}

function isStaggered(w: WorldState, i: number, tick: number): boolean {
  return w.staggerUntil[i]! >= 0 && tick < w.staggerUntil[i]!;
}

/** Apply (or refresh) stagger to body t; interrupts a pending latch it owns/targets. */
function applyStagger(w: WorldState, t: number, tick: number): void {
  const until = tick + RUSH_STAGGER_TICKS;
  if (until > (w.staggerUntil[t]! < 0 ? -1 : w.staggerUntil[t]!)) {
    w.staggerUntil[t] = until;
  }
  setFlag(w, t, BodyFlag.Downed); // visible stagger beat
}

/**
 * Press EDGE detector: true iff button b is down this tick and was UP last tick
 * (per the body's stored prevButtons). Used for Rush/Grab/Struggle so a held
 * button fires once, and so the anti-autoclicker can count edges only.
 */
function edge(w: WorldState, inp: PlayerInput, b: Button, i: number): boolean {
  const now = (inp.buttons & b) !== 0;
  const prev = (w.prevButtons[i]! & b) !== 0;
  return now && !prev;
}

/** Is carrier c hands-full (already holding)? (pressure a gate) */
function carrierEncumbered(w: WorldState, c: number): boolean {
  return w.holding[c] !== NO_ENTITY;
}

// Keep a few imports referenced for future tuning without widening churn.
void abs; void neg; void lt; void MassClass;
