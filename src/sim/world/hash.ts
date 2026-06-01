// ============================================================================
// src/sim/world/hash.ts — deterministic state checksum (FNV-1a, 32-bit).
// ============================================================================
//
// Rollback netcode needs a cheap, deterministic fingerprint of the whole world
// state for two jobs (00-master-vision §12, GENERATION-SOLVABILITY is unrelated):
//   1. DESYNC / TAMPER detection: peers periodically exchange the hash of a given
//      tick ("check-frames"); a mismatch means two peers' simulations diverged
//      (a determinism bug, or a cheat).
//   2. Rollback self-test: after re-simulating, the hash of a re-derived tick must
//      equal the hash computed the first time that tick was reached.
//
// We use FNV-1a over the raw integer fields. Every input word is a 32-bit integer
// (raw Fixed, enums, flags), and FNV-1a is pure integer math (xor + Math.imul),
// so the result is bit-identical on every JS engine. We fold each field array in
// the FIXED order declared by INT32_FIELDS, plus the small per-body byte fields,
// over ids [0, count). Dead slots are still folded (their cleared values are part
// of the canonical state) so two peers with the same logical state always agree.
//
// 32 bits is ample for periodic equality checks; collisions are astronomically
// unlikely to coincide with a real divergence, and a missed divergence would be
// caught by the next check-frame anyway. (We can widen to a 64-bit pair later if
// ever warranted — kept simple now.)
// ============================================================================

import { type WorldState, INT32_FIELDS } from './state.ts';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Fold one 32-bit word into a running FNV-1a hash. */
function fold(h: number, word: number): number {
  h ^= word >>> 0; // treat as unsigned 32-bit; raw Int32 negatives fold cleanly
  return Math.imul(h, FNV_PRIME) >>> 0;
}

/**
 * Compute the FNV-1a checksum of a world state over ids [0, count).
 *
 * Determinism notes:
 *  - We include `tick` and `count` first so structurally different states with
 *    coincidentally equal bodies still differ.
 *  - Int32 field arrays are folded in INT32_FIELDS order; for each field we sweep
 *    ascending id. Then the byte fields (massClass, flags) are folded.
 *  - Only [0, count) is folded; capacity (allocation size) is NOT part of identity,
 *    so two peers with different capacities but the same logical bodies agree.
 */
export function hashWorld(w: WorldState): number {
  let h = FNV_OFFSET;
  h = fold(h, w.tick | 0);
  h = fold(h, w.count | 0);
  const count = w.count;

  for (const field of INT32_FIELDS) {
    const arr = w[field] as Int32Array;
    for (let i = 0; i < count; i++) h = fold(h, arr[i]!);
  }
  // byte/small fields
  for (let i = 0; i < count; i++) h = fold(h, w.massClass[i]!);
  for (let i = 0; i < count; i++) h = fold(h, w.flags[i]!);

  return h >>> 0;
}

/**
 * Hash as an unsigned 8-char hex string — handy for logs / wire transmission of a
 * check-frame value.
 */
export function hashHex(w: WorldState): string {
  return hashWorld(w).toString(16).padStart(8, '0');
}
