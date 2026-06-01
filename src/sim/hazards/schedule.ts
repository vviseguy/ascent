// ============================================================================
// src/sim/hazards/schedule.ts — the PURE f(tick) cores of the hazard layer.
// ============================================================================
//
// WHY ISOLATE THESE: the assignment requires crusher position and tile solidity
// (and the turret projectile) to be EXACT pure functions of tick that can be
// recomputed at arbitrary, out-of-order ticks. Pulling them out of the apply loop
// lets us unit-test them directly (prove.ts) and reuse them for rendering /
// prediction. Every function here reads NOTHING but its arguments and uses only
// integer / Fixed math (no floats, no state, no clock).
// ============================================================================

import {
  type Fixed, ZERO, ONE, add, sub, mul, div, lerp, fromInt, fromRaw, toRaw,
} from '../fixed/fixed.ts';
import type { CrusherHazard, TileHazard, TurretHazard } from './model.ts';

/** Cycle position (tick+phase) wrapped into [0, period). Pure integer. */
function cyclePos(tick: number, period: number, phase: number): number {
  if (period <= 0) return 0;
  let p = (tick + phase) % period;
  if (p < 0) p += period;
  return p;
}

/**
 * Triangle wave parameter t ∈ Fixed [0,1] for a tick/period/phase. t ramps 0→1
 * over the first half-period then 1→0 over the second half, so a crusher eases
 * A→B→A. Pure integer/Fixed math (uses fixed.div on integer endpoints).
 */
export function triangle01(tick: number, period: number, phase: number): Fixed {
  if (period <= 0) return ZERO;
  const p = cyclePos(tick, period, phase);
  const half = period >> 1; // integer half-period (period even in practice)
  if (half === 0) return ZERO;
  if (p <= half) {
    return div(fromInt(p), fromInt(half)); // ramp up p/half
  }
  const down = period - half;
  if (down === 0) return ONE;
  return sub(ONE, div(fromInt(p - half), fromInt(down))); // ramp down
}

/** Crusher center at a given tick (raw Fixed components). PURE f(tick). */
export function crusherPos(
  h: CrusherHazard,
  tick: number,
): { x: number; y: number; z: number } {
  const t = triangle01(tick, h.period, h.phase);
  return {
    x: toRaw(lerp(fromRaw(h.ax), fromRaw(h.bx), t)),
    y: toRaw(lerp(fromRaw(h.ay), fromRaw(h.by), t)),
    z: toRaw(lerp(fromRaw(h.az), fromRaw(h.bz), t)),
  };
}

/** Whether a collapsing tile is solid at a given tick. PURE f(tick). */
export function tileSolid(h: TileHazard, tick: number): boolean {
  if (h.period <= 0) return true;
  return cyclePos(tick, h.period, h.phase) < h.solidTicks;
}

/** Turret projectile state for a given tick — all PURE f(tick). */
export interface TurretShot {
  /** True if a live projectile exists this tick. */
  active: boolean;
  /** Ticks since the projectile was fired (0 = fire tick). */
  age: number;
  /** Projectile center (raw Fixed). */
  x: number; y: number; z: number;
}

const INACTIVE_SHOT: TurretShot = { active: false, age: 0, x: 0, y: 0, z: 0 };

/**
 * Compute the live projectile for a turret at `tick` (single-shot channel: the
 * most recent fire owns it; the projectile travels muzzle + dir*speed*age). PURE
 * f(tick): position is closed-form, no spawned entity, no stored state.
 */
export function turretShot(h: TurretHazard, tick: number): TurretShot {
  if (h.fireEvery <= 0) return INACTIVE_SHOT;
  const age = cyclePos(tick, h.fireEvery, h.phase);
  if (age >= h.projectileLife) return INACTIVE_SHOT;
  const travel: Fixed = mul(fromInt(age), fromRaw(h.speed)); // speed is per-tick
  return {
    active: true,
    age,
    x: toRaw(add(fromRaw(h.mx), mul(fromRaw(h.dx), travel))),
    y: toRaw(add(fromRaw(h.my), mul(fromRaw(h.dy), travel))),
    z: toRaw(add(fromRaw(h.mz), mul(fromRaw(h.dz), travel))),
  };
}
