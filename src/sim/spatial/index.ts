// ============================================================================
// src/sim/spatial/index.ts — the SpatialIndex interface (one structure, 3 jobs).
// ============================================================================
//
// A single deterministic spatial partition serves THREE consumers
// (ENGINE-ARCHITECTURE.md "The spatial index serves THREE consumers"):
//   1. BROADPHASE collision — find candidate body pairs cheaply (src/sim/collide).
//   2. AREA OF INTEREST — what's near a crew's Anchor = the tight-sync set; a
//      cluster-merge is "do two Anchor regions overlap" (src/net rollback grouping).
//   3. RENDER / coalescence CULL — what to draw near the camera (src/render).
// All three reduce to the same primitive: "give me the bodies in this region."
//
// DERIVED-STATE CONTRACT (critical for rollback): the index is REBUILT from the
// authoritative WorldState every tick and is NEVER part of clone()/restoreInto().
// It carries no information between ticks, so a rollback that restores the world
// and re-simulates reconstructs an identical index for free. Nothing may read the
// index before rebuild() has run for the current tick.
//
// DETERMINISM CONTRACT: query results are returned in ASCENDING entity-id order,
// so no consumer ever depends on bucket/Map iteration order. Insertion is an
// ascending-id sweep of the world. (See grid.ts for the implementation.)
// ============================================================================

import type { WorldState } from '../world/state.ts';

export interface SpatialIndex {
  /**
   * Clear and repopulate from the world's ALIVE bodies (ascending-id sweep).
   * Call once per tick before any query. Carries no cross-tick state.
   */
  rebuild(w: WorldState): void;

  /**
   * Append the ids of all bodies whose CENTER lies within `r` (Fixed, raw) of the
   * ground-plane point (x, z) into `out`, in ascending-id order. `out` is cleared
   * first. Returns `out` for chaining. Uses ground-plane (x,z) distance; vertical
   * (y) is intentionally ignored here (consumers that care about height filter it).
   */
  queryRadius(x: number, z: number, r: number, out: number[]): number[];

  /**
   * Append the ids of all bodies whose center lies within the ground-plane AABB
   * [minX,maxX] × [minZ,maxZ] (Fixed raw) into `out`, ascending-id. `out` cleared first.
   */
  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[];

  /**
   * Visit every UNORDERED candidate pair (a<b) of bodies sharing or neighbouring a
   * cell — the broadphase. The callback may be invoked with non-colliding pairs
   * (it is a conservative over-approximation); the narrowphase filters. Pairs are
   * delivered in a deterministic order (ascending a, then ascending b).
   */
  eachCandidatePair(cb: (a: number, b: number) => void): void;
}
