// ============================================================================
// src/sim/collide/index.ts — the COLLISION system entry point.
// ============================================================================
//
// One call resolves the whole tick's collisions:
//
//     applyCollision(w, index, terrain)
//
// It runs, in a FIXED order:
//   1. TERRAIN  — resolveTerrain(w, terrain): keep bodies out of solids + on the
//      ground plane (move & slide, axis-separated). Terrain is infinite-mass, so
//      it is resolved first: it establishes the hard constraints the body-body
//      pass then has to respect.
//   2. BODY-BODY — circleResolve(w, index): push overlapping body pairs apart,
//      split by inverse mass, over a fixed number of iterations.
//
// `index` MUST already be rebuilt for the current tick (derived state — see
// spatial/index.ts). `terrain` is constant authored level data (terrain.ts).
//
// ----------------------------------------------------------------------------
// INTEGRATOR NOTE — WHERE THIS SLOTS INTO step() (I do NOT edit step.ts):
// ----------------------------------------------------------------------------
// Current step() SYSTEM ORDER (step.ts):
//   1 input→accel   2 gravity   3 integrate   4 ground-plane resolve+friction
//   5 carry transform
//
// RECOMMENDED: run collision as a new system RIGHT AFTER integrate (3) and BEFORE
// the carry transform (5), i.e. as SYSTEM 3.5:
//
//     // ... after the integrate loop, before SYSTEM 5 ...
//     index.rebuild(w);                       // derived state for THIS tick
//     applyCollision(w, index, terrain);      // terrain then body-body
//
// Rationale:
//   - It must come AFTER integrate (3) so it corrects the just-moved positions.
//   - It must come BEFORE carry (5) so a carrier shoved out of a wall drags its
//     held body's socket to a legal place the same tick (carry re-derives from the
//     carrier transform, which collision has already made legal). Carried bodies
//     are deliberately skipped by both collide passes (grabbedBy linkage), so they
//     never fight the socket.
//
// REDUNDANCY FLAG for the integrator: once terrain is wired, step()'s existing
// SYSTEM 4 ground-plane resolve becomes REDUNDANT — resolveTerrain already lifts
// bodies onto terrain.groundY and sets Grounded. Keep step's friction (it reads
// the Grounded flag, which resolveTerrain sets), but the ground-CLAMP half of
// SYSTEM 4 can be removed to avoid doing it twice. Until that cleanup lands,
// running both is harmless (idempotent: both clamp to the same groundY+half).
// Pass terrain.groundY equal to step's GROUND_Y (currently 0) so they agree.
// ============================================================================

import type { WorldState } from '../world/state.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import { type Terrain, resolveTerrain } from './terrain.ts';
import { circleResolve } from './circle.ts';

/**
 * Run the full collision system for one tick: terrain first, then body-body.
 * MUTATES `w` in place. Pure function of (w, index contents, terrain).
 *
 * @param w       world state, already integrated for this tick (step SYSTEM 3 done)
 * @param index   spatial index, ALREADY rebuilt for this tick
 * @param terrain constant authored level geometry
 */
export function applyCollision(w: WorldState, index: SpatialIndex, terrain: Terrain): void {
  resolveTerrain(w, terrain); // 1. hard static constraints (infinite mass)
  circleResolve(w, index); //    2. dynamic body-body, inverse-mass split
}

// re-exports so consumers import the whole layer from one place
export { resolveTerrain, circleResolve };
export { type Terrain, type AABB, makeBox, makeArena, flatGround } from './terrain.ts';
export { ITERATIONS } from './circle.ts';
