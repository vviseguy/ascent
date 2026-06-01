// ============================================================================
// src/sim/world/snapshot.ts — save / restore for rollback.
// ============================================================================
//
// Rollback keeps a ring of recent confirmed states; when a late/corrected remote
// input arrives for tick T, we RESTORE the saved state at T and re-simulate
// forward. The two operations here are the entire interface the rollback manager
// needs for state persistence:
//   - clone(w)            → an independent copy (a saved frame).
//   - restoreInto(dst,src)→ overwrite dst's contents with src's (reuse buffers).
//
// Both are pure typed-array copies (no per-body allocation), which is what keeps
// the rollback hot path cheap — the design rationale for SoA (state.ts).
//
// CRITICAL INVARIANT (proved in prove.ts): restore is exact. After
// restoreInto(a, snapshot) the state `a` is byte-for-byte identical to the state
// at save time, so re-simulation from a restored frame reproduces the original
// future exactly. Any drift here breaks rollback silently — hence the proof.
// ============================================================================

import { type WorldState, INT32_FIELDS, createWorld } from './state.ts';

/** Deep, independent copy of a world state (a saved rollback frame). */
export function clone(w: WorldState): WorldState {
  const c = createWorld(w.capacity);
  c.count = w.count;
  c.tick = w.tick;
  for (const field of INT32_FIELDS) {
    (c[field] as Int32Array).set(w[field] as Int32Array);
  }
  c.massClass.set(w.massClass);
  c.flags.set(w.flags);
  return c;
}

/**
 * Overwrite `dst` with the contents of `src` (rollback restore). `dst` is reused
 * (no allocation) — the rollback manager keeps a working state and a ring of
 * frames and copies frames back into the working state. Capacities must match.
 */
export function restoreInto(dst: WorldState, src: WorldState): void {
  if (dst.capacity !== src.capacity) {
    throw new Error('restoreInto: capacity mismatch');
  }
  dst.count = src.count;
  dst.tick = src.tick;
  for (const field of INT32_FIELDS) {
    (dst[field] as Int32Array).set(src[field] as Int32Array);
  }
  dst.massClass.set(src.massClass);
  dst.flags.set(src.flags);
}

/**
 * True iff two states are byte-for-byte equal over [0, count) and headers match.
 * Used by tests/proofs; not on the hot path. (Hash equality is the cheap runtime
 * check; this is the exact one for debugging a hash collision vs real equality.)
 */
export function statesEqual(a: WorldState, b: WorldState): boolean {
  if (a.count !== b.count || a.tick !== b.tick) return false;
  const n = a.count;
  for (const field of INT32_FIELDS) {
    const aa = a[field] as Int32Array;
    const bb = b[field] as Int32Array;
    for (let i = 0; i < n; i++) if (aa[i] !== bb[i]) return false;
  }
  for (let i = 0; i < n; i++) if (a.massClass[i] !== b.massClass[i]) return false;
  for (let i = 0; i < n; i++) if (a.flags[i] !== b.flags[i]) return false;
  return true;
}
