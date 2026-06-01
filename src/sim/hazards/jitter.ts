// ============================================================================
// src/sim/hazards/jitter.ts — deterministic seeded jitter for hazards.
// ============================================================================
//
// WHY: hazards (crusher knockback, turret hit shove) want a tiny non-uniform
// wobble so repeated effects aren't perfectly axis-locked. JS Math.random is
// nondeterministic and would break rollback, so — exactly like the floor
// generator's splitmix-style RNG (src/floor/rng.ts) — we derive the value purely
// from (tick, entityId, channel) via an integer hash. The same (tick,id,channel)
// ALWAYS yields the same jitter, so a re-sim after rollback reproduces it.
//
// Everything is integer math (Math.imul / xor / shifts), which is bit-identical
// across engines, then the result is expressed as a Fixed via fixed.ts ops.
// ============================================================================

import { type Fixed, mul, fromRaw, ONE_RAW } from '../fixed/fixed.ts';

/** 32-bit integer avalanche hash of three integer coordinates. */
export function hash3(tick: number, entityId: number, channel: number): number {
  let h = (0x9e3779b1 ^ (tick | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h ^ (entityId | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (channel | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

/**
 * Signed jitter as a Fixed in roughly [-amp, +amp]. amp is a Fixed magnitude.
 *
 * Maps the hash's low 16 bits to a centered fraction in (-1, 1): bits in
 * [0, 65535] minus 32768 give [-32768, 32767] which, read as a raw Q16.16, is a
 * value in [-0.5, 0.5); doubling (×2) gives ~[-1, 1). Scaling by amp keeps the
 * whole thing deterministic Fixed math.
 */
export function jitterFixed(
  tick: number,
  entityId: number,
  channel: number,
  amp: Fixed,
): Fixed {
  const h = hash3(tick, entityId, channel);
  const centeredRaw = (h & 0xffff) - (ONE_RAW >> 1); // raw Q16.16 in [-0.5, 0.5)
  const unit = fromRaw(centeredRaw * 2); // ~[-1, 1) as Fixed
  return mul(unit, amp);
}
