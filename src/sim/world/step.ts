// ============================================================================
// src/sim/world/step.ts — the deterministic motion core, in composable phases.
// ============================================================================
//
// `step(w, inputs)` advances ONE tick of the MOTION core only (no collision,
// verbs, or hazards). It is kept bit-identical to its original behavior so the
// world rollback proof (world/prove.ts) keeps passing — it composes two exported
// phases plus the tick bump:
//
//     step = motionPhase (SYSTEMS 1-4) → carryPhase (SYSTEM 5) → tick++
//
// The FULL game pipeline (collision + hazards + verbs interleaved in the agreed
// system order) lives in sim.ts's `advance(w, inputs, ctx)`, which calls these
// same phases so there is exactly one implementation of motion and carry. See
// sim.ts for the integrated order and the rationale.
//
// MOTION PHASE (SYSTEMS 1-4, free/non-carried bodies, ascending id):
//   1 input→accel   2 gravity   3 integrate   4 ground-plane resolve + friction
// CARRY PHASE (SYSTEM 5): slaved bodies follow their carrier's socket (kinematic
//   parent-socket, no two-body solver — ENGINE-ARCHITECTURE.md).
//
// The system ORDER is fixed and must never depend on engine iteration order.
// ============================================================================

import {
  type Fixed,
  add, sub, mul, fromInt, fromFloatConst, fromRaw, toRaw, ZERO, ONE, sign, abs, lt, gt, neg, clamp, sin, cos,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, NO_ENTITY, MASS_OF,
} from './state.ts';
import { type PlayerInput, NEUTRAL_INPUT, moveVec } from './input.ts';

/** Fixed timestep: 60 Hz. dt = 1/60 s as Fixed. */
export const TICK_HZ = 60;
const DT: Fixed = fromFloatConst(1 / TICK_HZ);

// --- tuning constants (authoring; converted once) ---
const GRAVITY: Fixed = fromFloatConst(-22); // m/s^2 (snappy platformer gravity)
const MAX_SPEED: Fixed = fromFloatConst(7); // base horizontal speed cap (m/s)
const GROUND_Y: Fixed = ZERO; // the single ground plane (floor terrain comes later)
/** Distance in front of a carrier where a held body sits (socket offset, m). */
const CARRY_REACH: Fixed = fromFloatConst(0.9);

// MOVEMENT FEEL (a "well-oiled" target-velocity controller, fully deterministic):
// instead of accel + exponential friction (which creeps and never crisply stops),
// we drive the horizontal velocity TOWARD a target (stick·maxSpeed) at a fixed rate,
// using a faster rate when STOPPING (no input or reversing) than when ACCELERATING.
// This gives responsive starts, a firm auto-stop on release, and a snap-to-zero
// dead band so the body parks cleanly. All in fixed-point → identical every peer.
/** Max horizontal speed change per TICK while accelerating toward the stick (u/s per tick). */
const ACCEL_PER_TICK: Fixed = fromFloatConst(1.1);
/** Max horizontal speed change per TICK while braking to a stop / reversing (firmer). */
const BRAKE_PER_TICK: Fixed = fromFloatConst(1.9);
/** Below this speed with no input, snap straight to 0 (clean park, no infinite creep). */
const STOP_EPS: Fixed = fromFloatConst(0.25);
/** Airborne control authority (fraction of ground rate) — some drift, not zero. */
const AIR_CONTROL: Fixed = fromFloatConst(0.45);

/**
 * Per-mass-class horizontal speed multiplier — the Anchor is slower, light objects
 * irrelevant (they don't self-move). Index by MassClass. This is the "Anchor is
 * heavy/slow" expressed in motion, and the basis for grab-encumbrance later.
 */
const SPEED_MUL: readonly Fixed[] = [
  fromFloatConst(1.0), // Light  (unused for self-move)
  fromFloatConst(1.0), // Player
  fromFloatConst(0.7), // Heavy
  fromFloatConst(0.78), // Anchor — heavy but still an active player (pillar 1)
];

/**
 * Advance the MOTION core by exactly one tick, in place (motion + carry + tick++).
 * Pure function of (prior w, inputs). MUTATES `w` and returns it. The full game
 * pipeline is sim.ts `advance()`; this is the motion-only step the world proof and
 * any motion-only consumer use.
 */
export function step(w: WorldState, inputs: ReadonlyArray<PlayerInput | undefined>): WorldState {
  motionPhase(w, inputs);
  carryPhase(w);
  w.tick = (w.tick + 1) | 0;
  return w;
}

/**
 * SYSTEMS 1-4 for every alive, non-carried body (ascending id). Does NOT bump the
 * tick. Exported so sim.ts can interleave collision/hazards between this and carry.
 */
export function motionPhase(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  groundY: Fixed = GROUND_Y,
): void {
  const count = w.count;
  for (let i = 0; i < count; i++) {
    const fl = w.flags[i]!;
    if ((fl & BodyFlag.Alive) === 0) continue;

    // Carried bodies are slaved in carryPhase; skip their own dynamics.
    if (w.grabbedBy[i] !== NO_ENTITY) continue;

    // SYSTEM 1: input → horizontal velocity via a target-velocity controller
    // (players only). Drive vx/vz toward (stick · maxSpeed) at a capped per-tick
    // rate — faster when braking/reversing than when accelerating — with a snap-to-0
    // dead band so the body parks cleanly instead of creeping. Deterministic.
    if ((fl & BodyFlag.Player) !== 0 || (fl & BodyFlag.Anchor) !== 0) {
      const inp: PlayerInput = inputs[i] ?? NEUTRAL_INPUT;
      const mv = moveVec(inp); // components in ~[-1,1]
      const sm = SPEED_MUL[w.massClass[i]!]!;
      const maxV = mul(MAX_SPEED, sm);
      const onGround = (w.flags[i]! & BodyFlag.Grounded) !== 0;
      // air control reduces authority but never to zero (some steering mid-jump)
      const authority = onGround ? ONE : AIR_CONTROL;
      const tgtX = mul(mv.x, maxV);
      const tgtZ = mul(mv.z, maxV);
      w.vx[i] = toRaw(approach(fromRaw(w.vx[i]!), tgtX, authority));
      w.vz[i] = toRaw(approach(fromRaw(w.vz[i]!), tgtZ, authority));
      w.facing[i] = inp.aim; // aim/facing (view); cheap, deterministic
    }

    // SYSTEM 2: gravity (unless flagged NoGravity).
    if ((fl & BodyFlag.NoGravity) === 0) {
      w.vy[i] = toRaw(add(fromRaw(w.vy[i]!), mul(GRAVITY, DT)));
    }

    // SYSTEM 3: integrate position.
    w.px[i] = toRaw(add(fromRaw(w.px[i]!), mul(fromRaw(w.vx[i]!), DT)));
    w.py[i] = toRaw(add(fromRaw(w.py[i]!), mul(fromRaw(w.vy[i]!), DT)));
    w.pz[i] = toRaw(add(fromRaw(w.pz[i]!), mul(fromRaw(w.vz[i]!), DT)));

    // SYSTEM 4: ground plane resolve. The terrain layer owns the authoritative floor
    // in the integrated sim; we pass the SAME groundY so the two agree (no double
    // floor), and a body in an open void (below groundY, no terrain under it) is NOT
    // caught here — the terrain layer / kill-plane decide. (Horizontal braking now
    // lives in the SYSTEM-1 controller, not a separate friction multiply.)
    const floorY = add(groundY, fromRaw(w.halfHeight[i]!)); // base rests on the plane
    if (lt(fromRaw(w.py[i]!), floorY)) {
      w.py[i] = toRaw(floorY);
      if (lt(fromRaw(w.vy[i]!), ZERO)) w.vy[i] = 0;
      w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
    } else {
      w.flags[i] = w.flags[i]! & ~BodyFlag.Grounded & 0xffff;
    }
  }
}

/**
 * SYSTEM 5 — carry transform. Slaved bodies (grabbedBy set) follow a socket in
 * front of their carrier; the carrier owns the transform (no two-body solver).
 * Does NOT bump the tick. Exported so sim.ts runs it at the right point.
 *
 * TRAIN chaining (docs/02 §2.3/§4.4): a held body whose CARRIER is itself held forms
 * a stack ("the whole stack flies"). We resolve each held body against its carrier's
 * ALREADY-updated socket, processing in chain-DEPTH order (carriers before their
 * cargo) so a held-of-held body follows its carrier this same tick regardless of id
 * order. For a single (non-train) hold this is bit-identical to the previous one-pass
 * placement, so the world/sim rollback proofs are unchanged.
 */
export function carryPhase(w: WorldState): void {
  const count = w.count;

  // Pass 0: dangling-link cleanup (a vanished/dead carrier drops both ends). Done as
  // its own ascending-id sweep first so the depth-ordered placement below sees a
  // consistent linkage (no half-broken chains).
  for (let i = 0; i < count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    const carrier = w.grabbedBy[i]!;
    if (carrier === NO_ENTITY) continue;
    if (carrier < 0 || carrier >= count || (w.flags[carrier]! & BodyFlag.Alive) === 0) {
      // carrier vanished — drop BOTH ends of the linkage so neither side dangles
      // (a dead carrier left "holding" a freed body corrupts verb invariants).
      w.grabbedBy[i] = NO_ENTITY;
      w.flags[i] = w.flags[i]! & ~BodyFlag.NoGravity & 0xffff;
      if (carrier >= 0 && carrier < count && w.holding[carrier] === i) {
        w.holding[carrier] = NO_ENTITY;
      }
    }
  }

  // Depth-ordered placement: depth 0 = a held body whose carrier is FREE; depth 1 =
  // carrier is itself held by a free body; etc. Bounded by MAX_CARRY_DEPTH passes
  // (the train cap). Within a pass we sweep ascending id (deterministic order).
  for (let depth = 0; depth < MAX_CARRY_DEPTH; depth++) {
    for (let i = 0; i < count; i++) {
      if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
      const carrier = w.grabbedBy[i]!;
      if (carrier === NO_ENTITY) continue;
      if (carrierChainDepth(w, i) !== depth) continue; // place at its own depth only
      placeAtSocket(w, i, carrier);
    }
  }
}

/** Max carry-chain depth resolved per tick (matches the train-length cap of 3). */
const MAX_CARRY_DEPTH = 3;

/**
 * Depth of body i in its carry chain: 0 if i's carrier is FREE (not itself held),
 * else 1 + the carrier's depth. Bounded by the entity count (no cycles possible).
 */
function carrierChainDepth(w: WorldState, i: number): number {
  let d = 0;
  let carrier = w.grabbedBy[i]!;
  for (let guard = 0; guard < w.count && carrier !== NO_ENTITY; guard++) {
    const above = w.grabbedBy[carrier]!;
    if (above === NO_ENTITY) break;
    d++;
    carrier = above;
  }
  return d;
}

/** Place held body i at its carrier's carry socket (the single-hold transform). */
function placeAtSocket(w: WorldState, i: number, carrier: number): void {
  const f = fromRaw(w.facing[carrier]!);
  const ox = mul(CARRY_REACH, cos(f));
  const oz = mul(CARRY_REACH, sin(f));
  const prevX = fromRaw(w.px[i]!);
  const prevZ = fromRaw(w.pz[i]!);
  w.px[i] = toRaw(add(fromRaw(w.px[carrier]!), ox));
  w.pz[i] = toRaw(add(fromRaw(w.pz[carrier]!), oz));
  // held slightly above the carrier's base
  w.py[i] = toRaw(add(fromRaw(w.py[carrier]!), mul(fromRaw(w.halfHeight[carrier]!), fromInt(1))));
  // velocity tracks the displacement so a subsequent throw inherits motion
  w.vx[i] = toRaw(sub(fromRaw(w.px[i]!), prevX));
  w.vz[i] = toRaw(sub(fromRaw(w.pz[i]!), prevZ));
  w.vy[i] = 0;
}

/**
 * Move a velocity component `v` toward `target` by at most a per-tick step, choosing
 * the ACCEL rate when speeding up toward the target and the firmer BRAKE rate when
 * slowing/reversing (target smaller in magnitude, or opposite sign). `authority` ∈
 * (0,1] scales the rate (air control). Snaps to 0 in the dead band when target is 0,
 * so the body parks cleanly. Pure fixed-point → deterministic.
 */
function approach(v: Fixed, target: Fixed, authority: Fixed): Fixed {
  // braking when there's no input, or the target pulls toward/through zero
  const slowing = eqZero(target) || (sign(v) !== 0 && sign(target) !== sign(v)) || lt(absF(target), absF(v));
  let rate = mul(slowing ? BRAKE_PER_TICK : ACCEL_PER_TICK, authority);
  if (lt(rate, ZERO)) rate = ZERO;
  const diff = sub(target, v);
  let next: Fixed;
  if (lt(absF(diff), rate)) next = target; // close enough — land exactly on target
  else next = gt(diff, ZERO) ? add(v, rate) : sub(v, rate);
  // dead-band snap: if we're meant to be stopping and we're under STOP_EPS, park at 0
  if (eqZero(target) && lt(absF(next), STOP_EPS)) return ZERO;
  return next;
}
function absF(a: Fixed): Fixed { return lt(a, ZERO) ? sub(ZERO, a) : a; }
function eqZero(a: Fixed): boolean { return !lt(a, ZERO) && !gt(a, ZERO); }

/** Mass (Fixed) of a body, by its class. Exposed for the verb/collision layers. */
export function massOf(w: WorldState, id: number): Fixed {
  return MASS_OF[w.massClass[id]!]!;
}

// Re-exports so consumers can pull tuning without reaching into internals.
export { DT as TICK_DT, GRAVITY, MAX_SPEED, GROUND_Y };
// (abs/neg/clamp imported for future systems; referenced here to keep them live)
void abs; void neg; void clamp;
