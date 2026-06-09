// ============================================================================
// src/sim/verbs/abilities.ts — the ROLE ABILITY system (Button.Ability).
// ============================================================================
//
// applyAbilities(w, inputs, index, tick) is ONE deterministic sub-system that
// turns each player's Button.Ability press into the per-role context verb from
// docs/02 §6. It is wired into applyVerbs (verbs.ts) as a new sub-system that runs
// AFTER STRUGGLE and THROW/SHOVE but BEFORE ENCUMBRANCE (so a freshly-spawned
// bridge or a freed body is encumbrance-clamped this tick, and so the ability sees
// the same post-grab/throw linkage state the throw sub-system just settled). See
// verbs.ts for the exact slot + rationale.
//
// Per docs/02 §6 each role's Ability does:
//   - MENDER   : REVIVE a downed ally in reach — channel a few ticks, then clear
//                Downed + bleedUntil, restore ~50% health, grant brief stand-up
//                immunity (regrabUntil). The escort linchpin.
//   - BULWARK  : UNHAND / body-block — break a grab on a nearby ally (force-drop the
//                grabber's hold + arm the ally's regrab immunity) AND brace briefly
//                (reduced incoming knockback). The answer to Anchor-theft (§4.5).
//   - ENGINEER : BRIDGE — spawn a one-shot Heavy static solid block in front (a body
//                the crew can stand on / that fills a gap), on a cooldown (§6.4).
//   - BREAKER  : a strong AoE SHOVE in reach + a post-shove flag (full destructible
//                terrain is future — kept a safe stub, §6.5).
//   - RUNNER   : SCOUT — tag the nearest hazard / highest reachable body (a minimal
//                deterministic mark; cheap, cosmetic-only, §6.1).
//
// DETERMINISM (the frozen rules): pure function of (state, inputs, tick); integer +
// Fixed math only (fixed.ts); ascending-id sweeps only; NO Map/Set on output paths;
// NO floats / Math.random / Date. All cooldowns/timers are hashed Int32 tick fields
// (state.ts) so the whole subsystem rolls back bit-identically. The ability fires on
// the PRESS EDGE (prevButtons), so a held button fires once; edge detection reads the
// SAME prevButtons snapshot the rest of applyVerbs uses (committed at end-of-tick).
// ============================================================================

import {
  type Fixed,
  add, sub, mul, div, sqrt, cos, sin, gt, gte, lt, lte, min, max, clamp,
  fromInt, ZERO, ONE, toRaw, fromRaw,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, MassClass, Role, NO_ENTITY, NO_CREW, MASS_OF,
  spawnBody, hasFlag, setFlag, clearFlag,
} from '../world/state.ts';
import { type PlayerInput, Button, isDown, NEUTRAL_INPUT } from '../world/input.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import {
  REVIVE_REACH, REVIVE_CHANNEL_TICKS, REVIVE_HEAL_FRAC, REVIVE_IMMUNITY_TICKS,
  REVIVE_CD_TICKS,
  UNHAND_REACH, BRACE_TICKS, BRACE_KNOCKBACK_MUL, UNHAND_CD_TICKS,
  BRIDGE_OFFSET, BRIDGE_HALF, BRIDGE_LIFETIME_TICKS, BRIDGE_CD_TICKS,
  BREAK_SHOVE_RADIUS, BREAK_SHOVE_J, BREAK_SHOVE_BEAT_TICKS, BREAK_CD_TICKS,
  SCOUT_RADIUS, SCOUT_CD_TICKS,
} from './config.ts';

/** Max health a revived ally is restored to (full = 100, the spawn default). */
const FULL_HEALTH: Fixed = fromInt(100);

/** A scratch id buffer reused across queries (length reset each use; not state). */
const scratch: number[] = [];

const inputOf = (inputs: ReadonlyArray<PlayerInput | undefined>, id: number): PlayerInput =>
  inputs[id] ?? NEUTRAL_INPUT;

/** Press EDGE: Ability down this tick AND up last tick (per stored prevButtons). */
function abilityEdge(w: WorldState, inp: PlayerInput, i: number): boolean {
  const now = (inp.buttons & Button.Ability) !== 0;
  const prev = (w.prevButtons[i]! & Button.Ability) !== 0;
  return now && !prev;
}

/** Is body i staggered right now (can't use abilities, per §2.1)? */
function isStaggered(w: WorldState, i: number, tick: number): boolean {
  return w.staggerUntil[i]! >= 0 && tick < w.staggerUntil[i]!;
}

/** Ground-plane distance (Fixed) between two bodies. */
function planeDist(w: WorldState, a: number, b: number): Fixed {
  const dx = sub(fromRaw(w.px[b]!), fromRaw(w.px[a]!));
  const dz = sub(fromRaw(w.pz[b]!), fromRaw(w.pz[a]!));
  return sqrt(add(mul(dx, dx), mul(dz, dz)));
}

/** Is a a player-like (Player or Anchor) body? (the only bodies that act) */
function isPlayerLike(w: WorldState, i: number): boolean {
  return hasFlag(w, i, BodyFlag.Player) || hasFlag(w, i, BodyFlag.Anchor);
}

/** Is body i ready to use its role ability (off cooldown)? */
function abilityReady(w: WorldState, i: number, tick: number): boolean {
  return tick >= w.abilityCdUntil[i]!;
}

/**
 * The role-ability sub-system. Mutates and returns `w`. `inputs[id]` is body id's
 * input this tick (undefined => neutral). `index` must be rebuilt for the current
 * tick (the integrator rebuilds it once before applyVerbs). Pure / deterministic.
 *
 * SUB-PHASE ORDER (fixed, all ascending-id):
 *   1. tick bookkeeping: dissolve expired bridge blocks; expire brace / breaker-beat.
 *   2. advance any in-progress MENDER revive CHANNELS (validate + complete).
 *   3. on the Ability press EDGE, dispatch the role ability (cooldown-gated).
 */
export function applyAbilities(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  tick: number,
): WorldState {
  const count = w.count;

  // ---- 1. tick bookkeeping (ascending id) ----------------------------------
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    // ENGINEER bridge: dissolve a spawned block whose lifetime has elapsed.
    if (w.bridgeExpireAt[i]! >= 0 && tick >= w.bridgeExpireAt[i]!) {
      dissolveBridge(w, i);
      continue; // slot is now dead; nothing else to bookkeep for it
    }
    // BULWARK brace: expire the brace window.
    if (w.braceUntil[i]! >= 0 && tick >= w.braceUntil[i]!) w.braceUntil[i] = -1;
    // BREAKER post-shove beat: expire the flag.
    if (w.breakerShoveUntil[i]! >= 0 && tick >= w.breakerShoveUntil[i]!) {
      w.breakerShoveUntil[i] = -1;
    }
  }

  // ---- 2. advance MENDER revive channels (ascending id) --------------------
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (w.abilityChanUntil[i]! < 0) continue; // no channel in progress
    advanceReviveChannel(w, inputs, i, tick);
  }

  // ---- 3. dispatch ability press edges (ascending id) ----------------------
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const inp = inputOf(inputs, i);
    if (!abilityEdge(w, inp, i)) continue;
    if (isStaggered(w, i, tick)) continue; // staggered can't ability (§2.1)
    if (hasFlag(w, i, BodyFlag.Downed)) continue; // downed can't ability
    // Hands-full disables class abilities (Pressure A, §4.1) EXCEPT the Bulwark's
    // Unhand, which is the emergency rescue button and must work mid-carry.
    const role = w.role[i]! as Role;
    if (w.holding[i] !== NO_ENTITY && role !== Role.Bulwark) continue;
    if (!abilityReady(w, i, tick)) continue;

    switch (role) {
      case Role.Mender: tryMenderRevive(w, index, i, tick); break;
      case Role.Bulwark: tryBulwarkUnhand(w, index, i, tick); break;
      case Role.Engineer: tryEngineerBridge(w, i, tick); break;
      case Role.Breaker: tryBreakerShove(w, index, i, tick); break;
      case Role.Runner: tryRunnerScout(w, index, i, tick); break;
      default: break; // Anchor/None: no Ability-1 here (Anchor beacon is Recall)
    }
  }

  return w;
}

// ============================================================================
// MENDER — REVIVE (docs/02 §6.3, §8.3): channel, then raise a downed ally.
// ============================================================================

/** Is body t a revivable downed ally of mender m? (downed + bleeding + same crew) */
function isRevivable(w: WorldState, m: number, t: number): boolean {
  if (t === m) return false;
  if (!hasFlag(w, t, BodyFlag.Alive)) return false;
  if (!hasFlag(w, t, BodyFlag.Player)) return false; // regular players are revived
  if (!hasFlag(w, t, BodyFlag.Downed)) return false;
  if (w.bleedUntil[t]! < 0) return false; // only a bleeding-out downed (§8.3), not a stagger beat
  if (w.respawnAt[t]! >= 0) return false; // already dead/awaiting respawn — not revivable
  // same crew (an enemy downed body is cargo, not a revive target). NO_CREW never matches.
  if (w.crewId[m] !== w.crewId[t] || w.crewId[m] === NO_CREW) return false;
  return true;
}

/** Pick the nearest revivable ally in reach (ascending id breaks ties). */
function pickReviveTarget(w: WorldState, index: SpatialIndex, m: number, tick: number): number {
  void tick;
  const reach = toRaw(add(fromRaw(w.radius[m]!), REVIVE_REACH));
  index.queryRadius(w.px[m]!, w.pz[m]!, reach, scratch);
  let best = NO_ENTITY;
  let bestDist: Fixed = ZERO;
  for (const t of scratch) {
    if (!isRevivable(w, m, t)) continue;
    const d = planeDist(w, m, t);
    if (gt(d, add(add(fromRaw(w.radius[m]!), fromRaw(w.radius[t]!)), REVIVE_REACH))) continue;
    if (best === NO_ENTITY || lt(d, bestDist) || (d === bestDist && t < best)) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** Start a revive channel on the Ability press edge if a downed ally is in reach. */
function tryMenderRevive(w: WorldState, index: SpatialIndex, m: number, tick: number): void {
  if (w.abilityChanUntil[m]! >= 0) return; // already channelling
  const target = pickReviveTarget(w, index, m, tick);
  if (target === NO_ENTITY) return;
  w.abilityChanUntil[m] = tick + REVIVE_CHANNEL_TICKS;
  w.abilityChanTarget[m] = target;
  // cooldown is armed at channel START so spamming the button can't stack channels.
  w.abilityCdUntil[m] = tick + REVIVE_CD_TICKS;
}

/**
 * Advance an in-progress revive channel for mender m. Cancels if the target is no
 * longer revivable or has left reach; completes (raises the ally) when the channel
 * tick is reached. Pure / deterministic.
 */
function advanceReviveChannel(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  m: number,
  tick: number,
): void {
  const target = w.abilityChanTarget[m]!;
  const valid =
    target !== NO_ENTITY &&
    isDown(inputOf(inputs, m), Button.Ability) && // must hold to channel
    !isStaggered(w, m, tick) &&
    !hasFlag(w, m, BodyFlag.Downed) &&
    isRevivable(w, m, target) &&
    lte(
      planeDist(w, m, target),
      add(add(fromRaw(w.radius[m]!), fromRaw(w.radius[target]!)), REVIVE_REACH),
    );
  if (!valid) {
    // cancel the channel (cooldown already spent — channelling is the commitment).
    w.abilityChanUntil[m] = -1;
    w.abilityChanTarget[m] = NO_ENTITY;
    return;
  }
  if (tick < w.abilityChanUntil[m]!) return; // still channelling
  // --- channel complete: raise the downed ally ---
  completeRevive(w, target, tick);
  w.abilityChanUntil[m] = -1;
  w.abilityChanTarget[m] = NO_ENTITY;
}

/** Clear the downed state, restore ~50% health, arm brief stand-up immunity. */
function completeRevive(w: WorldState, t: number, tick: number): void {
  clearFlag(w, t, BodyFlag.Downed);
  w.bleedUntil[t] = -1;
  w.downedUntil[t] = -1;
  // restore REVIVE_HEAL_FRAC of full health (~50%).
  w.health[t] = toRaw(mul(FULL_HEALTH, REVIVE_HEAL_FRAC));
  // brief stand-up immunity: cannot be re-grabbed for a moment (reuse the grab
  // immunity channel the grab system already honors).
  w.regrabUntil[t] = tick + REVIVE_IMMUNITY_TICKS;
}

// ============================================================================
// BULWARK — UNHAND / body-block + brace (docs/02 §4.5, §6.2).
// ============================================================================

/**
 * Break a grab on a nearby ALLY (force-drop the grabber's hold, free the ally, and
 * arm the freed ally's regrab immunity), then brace briefly (reduced knockback).
 * Targets the nearest GRABBED ally of the Bulwark's crew within UNHAND_REACH.
 */
function tryBulwarkUnhand(w: WorldState, index: SpatialIndex, b: number, tick: number): void {
  const reach = toRaw(add(fromRaw(w.radius[b]!), UNHAND_REACH));
  index.queryRadius(w.px[b]!, w.pz[b]!, reach, scratch);
  let best = NO_ENTITY;
  let bestDist: Fixed = ZERO;
  for (const ally of scratch) {
    if (ally === b) continue;
    if (!hasFlag(w, ally, BodyFlag.Alive)) continue;
    const grabber = w.grabbedBy[ally]!;
    if (grabber === NO_ENTITY) continue; // not grabbed -> nothing to unhand
    // an ALLY (same crew) or the crew's own Anchor (also same crew). NO_CREW skipped.
    if (w.crewId[b] === NO_CREW || w.crewId[ally] !== w.crewId[b]) continue;
    const d = planeDist(w, b, ally);
    if (gt(d, add(add(fromRaw(w.radius[b]!), fromRaw(w.radius[ally]!)), UNHAND_REACH))) continue;
    if (best === NO_ENTITY || lt(d, bestDist) || (d === bestDist && ally < best)) {
      best = ally;
      bestDist = d;
    }
  }
  // brace regardless (the defensive stance is the always-on part of the ability).
  w.braceUntil[b] = tick + BRACE_TICKS;
  w.abilityCdUntil[b] = tick + UNHAND_CD_TICKS;
  if (best === NO_ENTITY) return;
  // force-drop the grabber's hold on the ally + arm the freed ally's immunity.
  const grabber = w.grabbedBy[best]!;
  if (grabber !== NO_ENTITY && grabber >= 0 && grabber < w.count) {
    if (w.holding[grabber] === best) w.holding[grabber] = NO_ENTITY;
  }
  w.grabbedBy[best] = NO_ENTITY;
  clearFlag(w, best, BodyFlag.NoGravity);
  w.heldSince[best] = -1;
  w.struggleProgress[best] = 0;
  w.struggleLastPress[best] = -1;
  // also cancel any pending latch targeting the freed body so it can't insta-relatch.
  w.grabLatchBy[best] = NO_ENTITY;
  w.grabLatchUntil[best] = -1;
  w.regrabUntil[best] = tick + REVIVE_IMMUNITY_TICKS;
}

// ============================================================================
// ENGINEER — BRIDGE (docs/02 §6.4): a one-shot temporary Heavy static solid.
// ============================================================================

/**
 * Spawn a Heavy, NoGravity (static) Throwable solid block a short distance in front
 * of the Engineer — a body the crew can stand on / that fills a gap. It dissolves on
 * a deterministic tick (bridgeExpireAt). On a cooldown.
 */
function tryEngineerBridge(w: WorldState, e: number, tick: number): void {
  // capacity guard: if the world is full, the ability simply no-ops (still on cd so
  // it can't be hammered every tick) — deterministic + safe.
  if (w.count >= w.capacity) {
    let freeSlot = -1;
    for (let i = 0; i < w.count; i++) {
      if ((w.flags[i]! & BodyFlag.Alive) === 0) { freeSlot = i; break; }
    }
    if (freeSlot === -1) { w.abilityCdUntil[e] = tick + BRIDGE_CD_TICKS; return; }
  }
  const f = fromRaw(w.facing[e]!);
  const dist = add(BRIDGE_OFFSET, fromRaw(w.radius[e]!));
  const bx = add(fromRaw(w.px[e]!), mul(dist, cos(f)));
  const bz = add(fromRaw(w.pz[e]!), mul(dist, sin(f)));
  // place the block on the ground in front (its base at the Engineer's foot height).
  const baseY = sub(fromRaw(w.py[e]!), fromRaw(w.halfHeight[e]!));
  const by = add(baseY, BRIDGE_HALF);
  const block = spawnBody(w, {
    px: bx, py: by, pz: bz,
    radius: BRIDGE_HALF, halfHeight: BRIDGE_HALF,
    massClass: MassClass.Heavy,
    // Throwable so the crew can also grab/throw it (§6.4); NoGravity so it is a
    // STATIC platform that fills a gap rather than falling.
    flags: BodyFlag.Throwable | BodyFlag.NoGravity,
    role: Role.None,
  });
  // tag it with a dissolve tick so bookkeeping kills it when its lifetime elapses.
  w.bridgeExpireAt[block] = tick + BRIDGE_LIFETIME_TICKS;
  w.abilityCdUntil[e] = tick + BRIDGE_CD_TICKS;
}

/** Dissolve (kill) a spawned bridge block whose lifetime elapsed. */
function dissolveBridge(w: WorldState, block: number): void {
  // break any hold on/by the block so no linkage dangles, then mark it dead.
  const carrier = w.grabbedBy[block]!;
  if (carrier !== NO_ENTITY && carrier >= 0 && carrier < w.count) {
    if (w.holding[carrier] === block) w.holding[carrier] = NO_ENTITY;
  }
  const held = w.holding[block]!;
  if (held !== NO_ENTITY && held >= 0 && held < w.count) {
    if (w.grabbedBy[held] === block) {
      w.grabbedBy[held] = NO_ENTITY;
      clearFlag(w, held, BodyFlag.NoGravity);
    }
  }
  w.flags[block] = 0; // dead (slot reusable; matches killBody's flag clear)
  w.grabbedBy[block] = NO_ENTITY;
  w.holding[block] = NO_ENTITY;
  w.bridgeExpireAt[block] = -1;
}

// ============================================================================
// BREAKER — AoE SHOVE (docs/02 §6.5; full destructible terrain is future).
// ============================================================================

/**
 * A strong radial shove on every nearby non-self body, scaled by 1/mass (so an
 * Anchor barely budges, per §2.1), plus a brief post-shove beat flag on each. Full
 * destructible terrain is future work — this is the safe shove+flag stub.
 */
function tryBreakerShove(w: WorldState, index: SpatialIndex, br: number, tick: number): void {
  const reach = toRaw(add(fromRaw(w.radius[br]!), BREAK_SHOVE_RADIUS));
  index.queryRadius(w.px[br]!, w.pz[br]!, reach, scratch);
  const ox = fromRaw(w.px[br]!);
  const oz = fromRaw(w.pz[br]!);
  for (const t of scratch) {
    if (t === br) continue;
    if (!hasFlag(w, t, BodyFlag.Alive)) continue;
    if (w.grabbedBy[t] !== NO_ENTITY) continue; // carried bodies are owned by carrier
    const dx = sub(fromRaw(w.px[t]!), ox);
    const dz = sub(fromRaw(w.pz[t]!), oz);
    const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
    const r = add(add(fromRaw(w.radius[br]!), fromRaw(w.radius[t]!)), BREAK_SHOVE_RADIUS);
    if (gt(dist, r)) continue;
    // radial direction away from the breaker (push along facing if coincident).
    let nx: Fixed; let nz: Fixed;
    if (gt(dist, ZERO)) {
      nx = div(dx, dist);
      nz = div(dz, dist);
    } else {
      const f = fromRaw(w.facing[br]!);
      nx = cos(f); nz = sin(f);
    }
    const mass = MASS_OF[w.massClass[t]!]!;
    let j = div(BREAK_SHOVE_J, mass);
    // Anchors clamp to a negligible nudge (can't meaningfully move, §2.1).
    if (hasFlag(w, t, BodyFlag.Anchor)) j = min(j, fromRaw(2 << 14));
    w.vx[t] = toRaw(add(fromRaw(w.vx[t]!), mul(j, nx)));
    w.vz[t] = toRaw(add(fromRaw(w.vz[t]!), mul(j, nz)));
    // brief post-shove beat flag (the future destructible hook).
    w.breakerShoveUntil[t] = tick + BREAK_SHOVE_BEAT_TICKS;
  }
  w.abilityCdUntil[br] = tick + BREAK_CD_TICKS;
}

// ============================================================================
// RUNNER — SCOUT (docs/02 §6.1): tag nearest hazard / highest reachable body.
// ============================================================================

/**
 * Tag the most useful nearby body for the crew HUD: prefer the highest-y body in
 * range (a route/reachable point), excluding self. A minimal deterministic mark
 * (scoutMark = tagged id); carries no physics effect. Cheap + cosmetic.
 */
function tryRunnerScout(w: WorldState, index: SpatialIndex, r: number, tick: number): void {
  const reach = toRaw(add(fromRaw(w.radius[r]!), SCOUT_RADIUS));
  index.queryRadius(w.px[r]!, w.pz[r]!, reach, scratch);
  let best = NO_ENTITY;
  let bestY = ZERO;
  for (const t of scratch) {
    if (t === r) continue;
    if (!hasFlag(w, t, BodyFlag.Alive)) continue;
    const y = fromRaw(w.py[t]!);
    // highest reachable point; ascending id breaks ties (deterministic).
    if (best === NO_ENTITY || gt(y, bestY) || (y === bestY && t < best)) {
      best = t;
      bestY = y;
    }
  }
  w.scoutMark[r] = best; // NO_ENTITY if nothing in range (still a deterministic mark)
  w.abilityCdUntil[r] = tick + SCOUT_CD_TICKS;
}

/**
 * Knockback multiplier for body t this tick: a braced Bulwark (braceUntil active)
 * halves incoming knockback (§4.5); otherwise 1.0. Exported so the rush pushback
 * path (verbs.ts) can scale a hit on a braced body. Pure / deterministic.
 */
export function knockbackMul(w: WorldState, t: number, tick: number): Fixed {
  if (w.braceUntil[t]! >= 0 && tick < w.braceUntil[t]!) return BRACE_KNOCKBACK_MUL;
  return ONE;
}

// keep a few imports live for clarity / future tuning without widening churn.
void gte; void clamp; void max;
