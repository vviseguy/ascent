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
  add, sub, mul, fromInt, fromFloatConst, fromRaw, toRaw, ZERO, abs, lt, gt, neg, clamp, sin, cos,
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
const MOVE_ACCEL: Fixed = fromFloatConst(60); // ground accel toward stick (m/s^2)
const MAX_SPEED: Fixed = fromFloatConst(7); // base horizontal speed cap (m/s)
const GROUND_FRICTION: Fixed = fromFloatConst(0.86); // per-tick horizontal damping when grounded
const GROUND_Y: Fixed = ZERO; // the single ground plane (floor terrain comes later)
/** Distance in front of a carrier where a held body sits (socket offset, m). */
const CARRY_REACH: Fixed = fromFloatConst(0.9);

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
export function motionPhase(w: WorldState, inputs: ReadonlyArray<PlayerInput | undefined>): void {
  const count = w.count;
  for (let i = 0; i < count; i++) {
    const fl = w.flags[i]!;
    if ((fl & BodyFlag.Alive) === 0) continue;

    // Carried bodies are slaved in carryPhase; skip their own dynamics.
    if (w.grabbedBy[i] !== NO_ENTITY) continue;

    // SYSTEM 1: input → horizontal acceleration (players only).
    if ((fl & BodyFlag.Player) !== 0 || (fl & BodyFlag.Anchor) !== 0) {
      const inp: PlayerInput = inputs[i] ?? NEUTRAL_INPUT;
      const mv = moveVec(inp);
      const sm = SPEED_MUL[w.massClass[i]!]!;
      // accel toward stick direction; clamp resulting horizontal speed to MAX_SPEED*sm
      w.vx[i] = toRaw(applyAccel(fromRaw(w.vx[i]!), mul(mv.x, MOVE_ACCEL), DT));
      w.vz[i] = toRaw(applyAccel(fromRaw(w.vz[i]!), mul(mv.z, MOVE_ACCEL), DT));
      const cap = mul(MAX_SPEED, sm);
      clampHorizontalSpeed(w, i, cap);
      // face the aim direction (view/aim; cheap, deterministic)
      w.facing[i] = inp.aim;
    }

    // SYSTEM 2: gravity (unless flagged NoGravity).
    if ((fl & BodyFlag.NoGravity) === 0) {
      w.vy[i] = toRaw(add(fromRaw(w.vy[i]!), mul(GRAVITY, DT)));
    }

    // SYSTEM 3: integrate position.
    w.px[i] = toRaw(add(fromRaw(w.px[i]!), mul(fromRaw(w.vx[i]!), DT)));
    w.py[i] = toRaw(add(fromRaw(w.py[i]!), mul(fromRaw(w.vy[i]!), DT)));
    w.pz[i] = toRaw(add(fromRaw(w.pz[i]!), mul(fromRaw(w.vz[i]!), DT)));

    // SYSTEM 4: ground plane resolve + friction.
    const floorY = add(GROUND_Y, fromRaw(w.halfHeight[i]!)); // base rests on the plane
    if (lt(fromRaw(w.py[i]!), floorY)) {
      w.py[i] = toRaw(floorY);
      if (lt(fromRaw(w.vy[i]!), ZERO)) w.vy[i] = 0;
      w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
    } else {
      w.flags[i] = w.flags[i]! & ~BodyFlag.Grounded & 0xffff;
    }
    if ((w.flags[i]! & BodyFlag.Grounded) !== 0) {
      w.vx[i] = toRaw(mul(fromRaw(w.vx[i]!), GROUND_FRICTION));
      w.vz[i] = toRaw(mul(fromRaw(w.vz[i]!), GROUND_FRICTION));
    }
  }
}

/**
 * SYSTEM 5 — carry transform. Slaved bodies (grabbedBy set) follow a socket in
 * front of their carrier; the carrier owns the transform (no two-body solver).
 * Does NOT bump the tick. Exported so sim.ts runs it at the right point.
 */
export function carryPhase(w: WorldState): void {
  const count = w.count;
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
      continue;
    }
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
}

/** v' = v + a*dt (one Euler step for a velocity component). */
function applyAccel(v: Fixed, a: Fixed, dt: Fixed): Fixed {
  return add(v, mul(a, dt));
}

/** Clamp the horizontal (x,z) speed of body i to `cap` while preserving direction. */
function clampHorizontalSpeed(w: WorldState, i: number, cap: Fixed): void {
  const vx = fromRaw(w.vx[i]!);
  const vz = fromRaw(w.vz[i]!);
  // Compare squared magnitude vs cap^2 to avoid a sqrt on the common path.
  const speedSq = add(mul(vx, vx), mul(vz, vz));
  const capSq = mul(cap, cap);
  if (gt(speedSq, capSq)) {
    // scale down by cap/|v| — needs the magnitude; use fixed sqrt (deterministic).
    const mag = fixedSqrtMag(vx, vz);
    if (gt(mag, ZERO)) {
      const s = divSafe(cap, mag);
      w.vx[i] = toRaw(mul(vx, s));
      w.vz[i] = toRaw(mul(vz, s));
    }
  }
}

// local helpers kept tiny; import sqrt/div lazily to avoid widening the hot import
import { sqrt as fxSqrt, div as fxDiv } from '../fixed/fixed.ts';
function fixedSqrtMag(x: Fixed, z: Fixed): Fixed {
  return fxSqrt(add(mul(x, x), mul(z, z)));
}
function divSafe(a: Fixed, b: Fixed): Fixed {
  return fxDiv(a, b);
}

/** Mass (Fixed) of a body, by its class. Exposed for the verb/collision layers. */
export function massOf(w: WorldState, id: number): Fixed {
  return MASS_OF[w.massClass[id]!]!;
}

// Re-exports so consumers can pull tuning without reaching into internals.
export { DT as TICK_DT, GRAVITY, MAX_SPEED, GROUND_Y };
// (abs/neg/clamp imported for future systems; referenced here to keep them live)
void abs; void neg; void clamp;
