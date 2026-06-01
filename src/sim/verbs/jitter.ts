// ============================================================================
// src/sim/verbs/jitter.ts — deterministic per-event "randomness".
// ============================================================================
//
// The design spec wants a "tiny seeded jitter" on a throw's arc so identical
// throws don't feel robotic — but the sim BANS JS Math.random (it would desync
// rollback). Instead we derive a reproducible value from (tick, entityId,
// channel) with a small integer avalanche hash. Same (tick,id,channel) always
// yields the same number on every peer and on every rollback re-sim, so a throw
// re-applied after a rollback reproduces its arc exactly.
//
// We use a 32-bit integer mix (Math.imul-based, like an xorshift/murmur finalizer)
// — pure integer math, identical across engines.
// ============================================================================

import { type Fixed, fromRaw, mul, sub } from '../fixed/fixed.ts';

/** Distinct channels so two effects on the same (tick,id) don't correlate. */
export const JitterChannel = {
  ThrowAngle: 0x9e3779b1,
} as const;
export type JitterChannel = (typeof JitterChannel)[keyof typeof JitterChannel];

/** 32-bit avalanche of one word (murmur3 finalizer). */
function mix32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A deterministic value in [-1, 1] as Fixed for (tick, entityId, channel).
 * Built from a 32-bit hash → map its low 16 bits to a signed Q16.16 in [-1,1).
 */
export function jitterUnit(tick: number, entityId: number, channel: number): Fixed {
  // Fold the three coordinates together, then avalanche.
  let h = mix32((tick | 0) ^ Math.imul(entityId | 0, 0x27d4eb2f));
  h = mix32(h ^ (channel | 0));
  // low 16 bits → [0, 65535] raw → fraction in [0,1); shift to [-1,1).
  const frac = (h & 0xffff) >>> 0; // 0..65535  (== a Q16.16 fraction of 1.0)
  // value = 2*frac/ONE - 1  →  in raw: (2*frac) - ONE_RAW, kept as Fixed directly.
  // frac is already a raw Q16.16 in [0, ONE_RAW); represent f = frac as Fixed.
  const f01 = fromRaw(frac); // [0,1)
  return sub(mul(f01, fromRaw(2 << 16)), fromRaw(1 << 16)); // 2*f01 - 1 ∈ [-1,1)
}
