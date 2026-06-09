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
//   F. ABILITIES: the Button.Ability role verb (revive/unhand/bridge/break/scout).
//      Runs AFTER throw/shove (so it sees the settled grab/throw linkage + can free a
//      body / spawn a bridge this tick) and BEFORE encumbrance (so a freshly-freed or
//      newly-carried body is speed-clamped this same tick). See abilities.ts.
//   G. ENCUMBRANCE: clamp each carrier's horizontal speed to the carried-tier cap.
//   H. prevButtons <- buttons (must be LAST so every edge detector above saw the
//      previous tick's buttons).
// ============================================================================

import {
  type Fixed,
  add, sub, mul, div, neg, abs, lt, gt, gte, lte, clamp, min, max,
  sqrt, sin, cos, fromInt, ZERO, ONE, toRaw, fromRaw,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, MassClass, NO_ENTITY, NO_CREW, MASS_OF,
  hasFlag, setFlag, clearFlag,
} from '../world/state.ts';
import { type PlayerInput, Button, isDown, NEUTRAL_INPUT } from '../world/input.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import {
  RUSH_DIST, RUSH_TICKS, RUSH_CD_TICKS, RUSH_STAGGER_TICKS,
  RUSH_PUSHBACK_BASE, RUSH_PUSHBACK_MIN, RUSH_PUSHBACK_MAX, RUSH_HIT_RADIUS,
  GRAB_REACH, GRAB_HALF_ANGLE, GRAB_LATCH_TICKS, CARRY_REACH,
  CATCH_LATCH_TICKS, CATCH_FALL_VY, CATCH_VERTICAL_REACH, MAX_TRAIN_LEN,
  THROW_CHARGE_TICKS, THROW_J, THROW_ANGLE_MIN, THROW_ANGLE_MAX,
  THROW_ANGLE_DEFAULT, THROW_JITTER_RANGE,
  THROW_AIM_SPOIL_RANGE, THROW_CHARGE_BLEED_PER_TICK, THROW_CHARGE_BLEED_FLOOR_TICKS,
  HELD_CHIP_PERIOD, HELD_CHIP_DAMAGE,
  SHOVE_J, SHOVE_REACH, SHOVE_CD_TICKS,
  STRUGGLE_BREAK, STRUGGLE_BREAK_FRIENDLY, STRUGGLE_PRESS, STRUGGLE_DEBOUNCE_TICKS,
  STRUGGLE_IDLE_TICKS, STRUGGLE_DECAY, CARRIER_GRIP,
  STRUGGLE_BURST_WINDOW, STRUGGLE_RAMP_STEP, STRUGGLE_RAMP_MIN, STRUGGLE_RAMP_MAX,
  STRUGGLE_JITTER_RANGE, ENCUMBRANCE_VERB_MUL,
  REGRAB_IMMUNITY_TICKS, MAX_HELPLESS_TICKS,
  Role, THROW_STRENGTH, STRUGGLE_STRENGTH, CARRY_SPEED_MUL,
  JUMP_SPEED, JUMP_MUL,
} from './config.ts';
import { jitterUnit, JitterChannel } from './jitter.ts';
import { applyAbilities, knockbackMul } from './abilities.ts';

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

  // ---- F. ABILITIES (role Button.Ability verb) -----------------------------
  // After throw/shove (settled linkage) and before encumbrance (so a freed/spawned
  // body is speed-clamped this tick). Reads role via w.role[id]. See abilities.ts.
  applyAbilities(w, inputs, index, tick);

  // ---- G. ENCUMBRANCE ------------------------------------------------------
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
    // pending latch interrupted: a stagger CANCELS an in-progress grab attempt
    // (docs/02 §2.1) where t is the target of someone's pending latch...
    cancelPendingLatchOn(w, t);
    // ...and where t OWNS a pending latch (t was mid-grabbing someone): a rush
    // staggers the would-be grabber so its acquire fails (it's also gated by
    // !isStaggered in grabSystem C1, but cancel here so the bookkeeping is clean).
    cancelLatchByCarrier(w, t);

    // bump-to-break (pressure e): a rush onto a CARRIER SHORTENS (never snaps) its
    // hold — docs/02 §2.1: "stagger ... does NOT break an established hold (you have
    // to STRUGGLE or get a Bulwark for that)." So we push the victim's struggle
    // progress toward — but capped strictly BELOW — the break threshold. This makes
    // the next real struggle/bump land faster without the rush itself freeing the
    // body. No REGRAB_IMMUNITY arms here because no break happens.
    const victim = w.holding[t]!;
    if (victim !== NO_ENTITY) {
      const prog = fromRaw(w.struggleProgress[victim]!);
      const bumped = add(prog, div(STRUGGLE_BREAK, fromInt(2))); // +50 progress
      // clamp just under threshold (BREAK - 1 raw unit) so a single rush can never
      // cross it; only an actual STRUGGLE press (or a Bulwark Unhand) breaks the hold.
      const ceil = sub(STRUGGLE_BREAK, fromRaw(1));
      w.struggleProgress[victim] = toRaw(min(bumped, ceil));
    }

    // pushback 1.5u * (rusher_mass/target_mass) clamped [0.3,3.0]u, along dx/dz.
    const rm = MASS_OF[w.massClass[rusher]!]!;
    const tm = MASS_OF[w.massClass[t]!]!;
    let push = mul(RUSH_PUSHBACK_BASE, div(rm, tm));
    push = clamp(push, RUSH_PUSHBACK_MIN, RUSH_PUSHBACK_MAX);
    // BULWARK brace (§4.5): a braced target takes halved incoming knockback.
    push = mul(push, knockbackMul(w, t, tick));
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

    // TRAIN (pressure d, docs/02 §2.3/§4.4): a carrier that gets grabbed KEEPS its
    // cargo — the whole stack travels together ("the whole stack flies"). We do NOT
    // auto-drop here; the held-of-held linkage chains through carryPhase (step.ts),
    // and the train is bounded at MAX_TRAIN_LEN by the grab-acquire check (C2). The
    // previous behavior (drop-on-grabbed) collapsed every train instantly.

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
        } else if (since >= 0) {
          // HELD-PLAYER CHIP (docs/02 §4.2): a held PLAYER/Anchor deals 1 HP every 12
          // ticks to the carrier (a small cost to holding; never lethal alone). World
          // objects (Throwable, non-player) don't chip. Integer-tick for determinism.
          const heldIsPerson =
            hasFlag(w, held, BodyFlag.Player) || hasFlag(w, held, BodyFlag.Anchor);
          const elapsed = tick - since;
          if (heldIsPerson && elapsed > 0 && elapsed % HELD_CHIP_PERIOD === 0) {
            const hp = sub(fromRaw(w.health[i]!), HELD_CHIP_DAMAGE);
            w.health[i] = toRaw(max(ZERO, hp)); // clamp at 0 (death/downed owned by sim)
          }
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
    // begin latch on target. CATCH fast-latch (docs/02 §5.3/§5.4): catching a body
    // that is AIRBORNE / falling / thrown uses a SHORT fixed latch (the "alley-oop"
    // / safety-net) instead of the mass-scaled time — otherwise a fast faller passes
    // through the cone before a 22-tick Anchor latch could ever complete.
    const latchTicks = isCatchable(w, target)
      ? CATCH_LATCH_TICKS
      : GRAB_LATCH_TICKS[w.massClass[target]!]!;
    w.grabLatchBy[target] = i;
    w.grabLatchUntil[target] = tick + latchTicks;
  }
}

/**
 * Choose a grab target in i's cone by the 4-tier priority (docs/02 §4.1), resolved
 * deterministically by stable id on ties. Honors an explicit inp.grabTarget if that
 * id is a valid in-cone candidate.
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
  // widen the spatial query by the catch vertical reach so a faller above/below the
  // catcher's plane is still returned (the cone test does the precise filtering).
  const reach = toRaw(add(add(fromRaw(w.radius[i]!), GRAB_REACH), CATCH_VERTICAL_REACH));
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
    const tier = grabTier(w, i, t);
    if (tier < bestTier || (tier === bestTier && (best === NO_ENTITY || t < best))) {
      bestTier = tier;
      best = t;
    }
  }
  return best;
}

/**
 * Grab priority tier (lower = higher priority), 4 tiers w/ crew (docs/02 §4.1):
 *   0 enemy Anchor (a DIFFERENT crew's Anchor — the prize)
 *   1 friendly / prompt-able player (a same-crew ally — co-op carry / hand-up)
 *   2 world object (throwable)
 *   3 generic player (a rival non-Anchor)
 * IMPORTANT (audit: own-anchor): your OWN Anchor is never the top adversarial target
 * — a same-crew Anchor falls into the friendly tier (1), not the enemy-Anchor tier.
 */
function grabTier(w: WorldState, i: number, t: number): number {
  const sameCrew = isSameCrew(w, i, t);
  if (hasFlag(w, t, BodyFlag.Anchor)) return sameCrew ? 1 : 0; // own=friendly, rival=prize
  if (sameCrew && hasFlag(w, t, BodyFlag.Player)) return 1; // friendly/prompt-able ally
  if (hasFlag(w, t, BodyFlag.Throwable)) return 2; // world object
  if (hasFlag(w, t, BodyFlag.Player)) return 3; // generic (rival) player
  return 4;
}

/** Can body t be grabbed by i right now? (alive, not held, not on regrab immunity) */
function isGrabbable(w: WorldState, t: number, i: number, tick: number): boolean {
  if (!hasFlag(w, t, BodyFlag.Alive)) return false;
  if (t === i) return false;
  if (w.grabbedBy[t] !== NO_ENTITY) return false; // already held
  if (w.regrabUntil[t]! >= 0 && tick < w.regrabUntil[t]!) return false; // REGRAB_IMMUNITY
  // TRAIN (docs/02 §4.4): a body that is itself a CARRIER CAN be grabbed (you grab
  // the carrier and the whole stack travels) — UNLESS doing so would exceed the
  // train-length cap. (Previously a carrier was never directly grabbable, which made
  // trains impossible.)
  if (w.holding[t] !== NO_ENTITY && 1 + heldChainCount(w, t) > MAX_TRAIN_LEN) return false;
  // must be a grabbable kind: player, anchor, or throwable object
  return (
    hasFlag(w, t, BodyFlag.Player) ||
    hasFlag(w, t, BodyFlag.Anchor) ||
    hasFlag(w, t, BodyFlag.Throwable)
  );
}

/**
 * Two bodies are SAME-crew iff both carry a real (non-NO_CREW) crew id and they match.
 * A body with no crew (world object / unassigned) is never "friendly" to anyone — so
 * absent crew data, every player reads as a rival and the old single-tier behavior is
 * preserved (no regression for crew-less sandboxes).
 */
function isSameCrew(w: WorldState, a: number, b: number): boolean {
  const ca = w.crewId[a]!;
  const cb = w.crewId[b]!;
  return ca !== NO_CREW && ca === cb;
}

/**
 * Count the bodies in the held-of-held chain STARTING at `target` and descending via
 * `holding` (target, target.holding, ...). Used to bound train length. The descent is
 * deterministic (single linked chain) and guarded against cycles by the entity cap.
 */
function heldChainCount(w: WorldState, target: number): number {
  let n = 0;
  let cur = target;
  // capacity-bounded loop: a hold chain can be at most `count` long, and cycles are
  // impossible (a body holds at most one thing and is held by at most one), but bound
  // anyway for safety/determinism.
  for (let guard = 0; guard < w.count && cur !== NO_ENTITY; guard++) {
    n++;
    cur = w.holding[cur]!;
  }
  return n;
}

/** Is target catchable as an in-flight body (significant downward vy)? (docs/02 §5.3/§5.4) */
function isCatchable(w: WorldState, t: number): boolean {
  // a held body has NoGravity and vy 0; only free, fast-descending bodies are "fallers".
  if (hasFlag(w, t, BodyFlag.NoGravity)) return false;
  const vy = fromRaw(w.vy[t]!);
  return lt(vy, neg(CATCH_FALL_VY)); // descending faster than the threshold
}

/**
 * Is target t inside i's frontal grab cone (horizontal reach + half-angle), AND —
 * for a CATCH of an in-flight faller — within the VERTICAL catch reach (docs/02
 * §5.3/§5.4)? The cone math is in the (x,z) plane (the camera/aim plane); the vertical
 * span only matters when catching a faller that is above/below the catcher's own plane.
 */
function inCone(w: WorldState, i: number, t: number): boolean {
  const dx = sub(fromRaw(w.px[t]!), fromRaw(w.px[i]!));
  const dz = sub(fromRaw(w.pz[t]!), fromRaw(w.pz[i]!));
  const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
  // VERTICAL reach: ONLY a CATCH of an in-flight faller is vertically gated (so a body
  // dropping above/below your plane is reachable up to CATCH_VERTICAL_REACH). A normal
  // grab is NOT vertically constrained here (unchanged from before) — the cone math is
  // in the (x,z) plane; standing/ledge grabs keep working as they did.
  if (isCatchable(w, t)) {
    const dyAbs = abs(sub(fromRaw(w.py[t]!), fromRaw(w.py[i]!)));
    const vReach = add(
      add(fromRaw(w.halfHeight[i]!), fromRaw(w.halfHeight[t]!)),
      CATCH_VERTICAL_REACH,
    );
    if (gt(dyAbs, vReach)) return false; // faller is outside the vertical catch envelope
  }
  // horizontal reach: a catch gets the same in-plane reach (the vertical span is the
  // extra allowance); both use GRAB_REACH for the cone radius.
  const reach = add(add(fromRaw(w.radius[i]!), fromRaw(w.radius[t]!)), GRAB_REACH);
  if (gt(dist, reach)) return false;
  if (lte(dist, ZERO)) return true; // coincident (in plan) -> in cone
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
  w.struggleBurst[target] = 0; // fresh hold -> fresh mash burst
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
  w.struggleBurst[target] = 0; // hold ended -> reset mash burst
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

    // debounce: ignore presses < STRUGGLE_DEBOUNCE_TICKS apart (turbo gains nothing).
    const last = w.struggleLastPress[i]!;
    const gap = last >= 0 ? tick - last : -1;
    if (gap >= 0 && gap < STRUGGLE_DEBOUNCE_TICKS) continue;

    // MASH RAMP (docs/02 §4.2): consecutive presses within the burst window ramp the
    // per-press value. Increment the burst counter when this press is within the
    // window of the last; otherwise it's a fresh burst (n=1). Stored in the hashed
    // struggleBurst field so it survives rollback.
    let burst = w.struggleBurst[i]!;
    burst = gap >= 0 && gap <= STRUGGLE_BURST_WINDOW ? burst + 1 : 1;
    w.struggleBurst[i] = burst;
    w.struggleLastPress[i] = tick;

    // ramp = clamp(1 + 0.12*(n-1), 1, 1.8) — ramps to 1.8x after ~7 presses, then caps.
    const ramp = clamp(
      add(STRUGGLE_RAMP_MIN, mul(STRUGGLE_RAMP_STEP, fromInt(burst - 1))),
      STRUGGLE_RAMP_MIN,
      STRUGGLE_RAMP_MAX,
    );

    // press = 6 * struggler_strength * (struggler_mass / carrier_grip) * ramp
    const strength = STRUGGLE_STRENGTH[roleOf(w, roles, i)]!;
    const mass = MASS_OF[w.massClass[i]!]!;
    const grip = CARRIER_GRIP; // carrier resistance (uniform for now)
    let inc = mul(mul(mul(STRUGGLE_PRESS, strength), div(mass, grip)), ramp);

    // ENCUMBRANCE (Pressure C, §4.3): a struggler who is itself HANDS-FULL (a train
    // link carrying cargo) struggles at -20% — you're committed.
    if (w.holding[i] !== NO_ENTITY) inc = mul(inc, ENCUMBRANCE_VERB_MUL);

    // ANTI-AUTOCLICKER seeded jitter (§4.2/§10.4): ±5% per press, keyed on
    // (tick, heldId, Struggle) so perfect-bot timing isn't optimal. Deterministic.
    const jit = mul(STRUGGLE_JITTER_RANGE, jitterUnit(tick, i, JitterChannel.Struggle));
    inc = mul(inc, add(ONE, jit));

    // FRIENDLY carry (docs/02 §5.1): if carrier and held are the SAME crew, the ally
    // dismounts almost instantly (low threshold ~30); an adversarial hold uses 100.
    const breakAt = isSameCrew(w, carrier, i) ? STRUGGLE_BREAK_FRIENDLY : STRUGGLE_BREAK;

    const next = add(fromRaw(w.struggleProgress[i]!), inc);
    if (gte(next, breakAt)) {
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

    // --- SHOVE, on a Throw-button tap. Empty-hand is the canonical case (§2.3); a
    //     hands-full carrier may also shove, ENCUMBERED at -20% (§4.3). Note a held
    //     body cannot be the thrower here (it's gated out of the throw path by the
    //     control model: a held body struggles, it doesn't shove).
    if (throwPressEdge) {
      if (w.lastShoveTick[i]! >= 0 && tick - w.lastShoveTick[i]! < SHOVE_CD_TICKS) continue;
      applyShove(w, index, i, inp, tick);
      w.lastShoveTick[i] = tick;
    }
  }

  // Charge accumulation: while GRAB is held AND hands are full, ramp throwCharge
  // (ticks) toward THROW_CHARGE_TICKS. Released/empty → reset to 0. A struggling held
  // body BLEEDS the carrier's charge (docs/02 §4.2) so a contested throw goes weak.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const inp = inputOf(inputs, i);
    const target = w.holding[i]!;
    if (isDown(inp, Button.Grab) && target !== NO_ENTITY) {
      const t = w.throwCharge[i]! + 1;
      w.throwCharge[i] = t > THROW_CHARGE_TICKS ? THROW_CHARGE_TICKS : t;
      // CHARGE-BLEED (§4.2): if the held body is ACTIVELY struggling, drain charge by
      // ~0.02*THROW_CHARGE_TICKS/tick, but never below the bleed floor (~0.6 charge) —
      // a fully-pinned victim caps the carrier's effective charge, never zeroes it.
      if (isActivelyStruggling(w, target, tick)) {
        // current charge as Fixed ticks, minus the per-tick bleed, floored to int,
        // clamped >= the bleed floor (and >= 0). All Fixed/integer — deterministic.
        const cur = fromInt(w.throwCharge[i]!);
        const bled = sub(cur, THROW_CHARGE_BLEED_PER_TICK);
        const floored = floorToTicks(max(ZERO, bled));
        w.throwCharge[i] = floored < THROW_CHARGE_BLEED_FLOOR_TICKS
          ? Math.min(THROW_CHARGE_BLEED_FLOOR_TICKS, w.throwCharge[i]!)
          : floored;
      }
    } else if (target === NO_ENTITY) {
      w.throwCharge[i] = 0;
    }
  }
}

/** Floor a non-negative Fixed value to an integer tick count (deterministic shift). */
function floorToTicks(v: Fixed): number {
  // raw >> 16 is the integer part for a non-negative Fixed (arithmetic shift, exact).
  return toRaw(v) >> 16;
}

/**
 * Is held body `target` ACTIVELY struggling right now? True iff it has accumulated
 * struggle progress AND pressed struggle within the idle window (so it is currently
 * fighting, not coasting). Used to gate charge-bleed and aim-spoil (§4.2).
 */
function isActivelyStruggling(w: WorldState, target: number, tick: number): boolean {
  if (w.struggleProgress[target]! <= 0) return false;
  const last = w.struggleLastPress[target]!;
  return last >= 0 && tick - last < STRUGGLE_IDLE_TICKS;
}

/**
 * Struggle INTENSITY of a held body in [0,1] as Fixed: its current struggle progress
 * relative to the adversarial break threshold. Drives aim-spoil magnitude (§4.2).
 */
function struggleIntensity(w: WorldState, target: number): Fixed {
  const prog = fromRaw(w.struggleProgress[target]!);
  return clamp(div(prog, STRUGGLE_BREAK), ZERO, ONE);
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
  // AIM-SPOIL (docs/02 §4.2): capture the held body's struggle intensity BEFORE we
  // clear its struggle state below — a struggling victim wriggles the throw aim by
  // ±(intensity × 8°). Seeded per (thrower, releaseTick, ThrowAim) so it reproduces
  // exactly on a rollback resim of the release tick.
  const intensity = struggleIntensity(w, target);

  // release linkage (no regrab immunity needed on a throw — it's intentional)
  w.holding[thrower] = NO_ENTITY;
  w.grabbedBy[target] = NO_ENTITY;
  clearFlag(w, target, BodyFlag.NoGravity);
  w.heldSince[target] = -1;
  w.struggleProgress[target] = 0;
  w.struggleLastPress[target] = -1;
  w.struggleBurst[target] = 0;
  w.regrabUntil[target] = tick + REGRAB_IMMUNITY_TICKS;

  const mass = MASS_OF[w.massClass[target]!]!;
  const invSqrtM = div(ONE, sqrt(mass)); // 1/sqrt(mass)
  const strength = THROW_STRENGTH[roleOf(w, roles, thrower)]!;
  const j = mul(mul(mul(THROW_J, c), invSqrtM), strength);

  // arc angle = default + base jitter, clamped.
  const jit = mul(THROW_JITTER_RANGE, jitterUnit(tick, thrower, JitterChannel.ThrowAngle));
  const angle = clamp(add(THROW_ANGLE_DEFAULT, jit), THROW_ANGLE_MIN, THROW_ANGLE_MAX);

  // AIM-SPOIL: rotate the HORIZONTAL facing by ±(intensity × 8°). Applied to the
  // facing (heading), not the arc elevation, so a contested toss scatters in plan.
  const spoil = mul(
    mul(THROW_AIM_SPOIL_RANGE, intensity),
    jitterUnit(tick, thrower, JitterChannel.ThrowAim),
  );
  const f = add(fromRaw(w.facing[thrower]!), spoil);
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
  let j = div(SHOVE_J, mass);
  // ENCUMBRANCE (Pressure C, §4.3): a hands-full shover is 20% weaker (committed).
  if (w.holding[i] !== NO_ENTITY) j = mul(j, ENCUMBRANCE_VERB_MUL);
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

/** Ticks the RIGHT button must be held to count as a HOLD (→Rush); a shorter press
 *  is a TAP (→Ability). ~9 ticks ≈ 150 ms — snappy but distinguishable. */
export const RIGHT_HOLD_TICKS = 9;

/**
 * Mouse-first control resolver. Translates the raw RIGHT button (Button.RightHold)
 * into the existing Rush/Ability semantics, deterministically, BEFORE the verb
 * systems run. Returns a NEW per-tick input array (originals untouched) that both
 * applyVerbs and commitPrevButtons consume, so edge detection stays consistent.
 *
 * Rule (per-body, tracked in the hashed rightHoldStart field):
 *   - while RightHold is held past RIGHT_HOLD_TICKS → set Rush (a sustained dash);
 *     Rush's own press-edge + cooldown make this "hold to dash".
 *   - on RELEASE before the threshold → it was a TAP → set Ability for that one tick.
 * Keyboard Rush/Ability bits already present pass through untouched.
 */
export function resolveRightButton(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  out: (PlayerInput | undefined)[],
): (PlayerInput | undefined)[] {
  const tick = w.tick;
  out.length = w.count;
  for (let i = 0; i < w.count; i++) {
    const inp = inputs[i];
    if (!inp) { out[i] = undefined; continue; }
    const rightNow = (inp.buttons & Button.RightHold) !== 0;
    const rightPrev = (w.prevButtons[i]! & Button.RightHold) !== 0;
    // KEEP the raw RightHold bit in `buttons` so prevButtons records it next tick
    // (stripping it broke press-edge detection — every tick looked like a fresh press).
    let buttons = inp.buttons;
    if (rightNow) {
      if (!rightPrev) w.rightHoldStart[i] = tick; // press edge — start the clock
      const held = w.rightHoldStart[i]! >= 0 ? tick - w.rightHoldStart[i]! : 0;
      // emit a Rush press-EDGE exactly on the tick we cross the hold threshold (so the
      // rush system's own edge detector fires once → one dash per hold).
      if (held === RIGHT_HOLD_TICKS) buttons |= Button.Rush;
    } else if (rightPrev) {
      // release: a short hold was a TAP → fire the role ability this tick
      const start = w.rightHoldStart[i]!;
      if (start >= 0 && tick - start < RIGHT_HOLD_TICKS) buttons |= Button.Ability;
      w.rightHoldStart[i] = -1;
    }
    out[i] = buttons === inp.buttons ? inp : { ...inp, buttons };
  }
  return out;
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

// Keep the MassClass import referenced (it's part of the public state vocabulary the
// verb layer reads through MASS_OF; kept imported for readers of this module).
void MassClass;
