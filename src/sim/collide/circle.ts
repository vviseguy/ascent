// ============================================================================
// src/sim/collide/circle.ts — body-vs-body narrowphase + positional resolution.
// ============================================================================
//
// Bodies are upright capsules. On the ground plane they are CIRCLES (radius); they
// also carry a vertical extent (halfHeight) so two bodies only collide when their
// plan circles overlap AND their height spans overlap (a body high in the air does
// not push one standing on the floor). This is the "2.5D" model the rest of the
// sim uses (vec.ts header).
//
// RESOLUTION = POSITIONAL, SPLIT BY INVERSE MASS
// ----------------------------------------------
// We do NOT run a velocity impulse solver here (carry is kinematic; throws/rushes
// are scripted impulses elsewhere — step.ts header). Body-body contact is resolved
// purely by PUSHING the two circles apart along their center-to-center axis until
// they just touch. The push is split by INVERSE mass so the heavier body moves
// less (an Anchor barely budges; a Light object gets shoved): each body moves a
// fraction invMass_self / (invMass_a + invMass_b) of the overlap. Equal masses
// split 50/50; a finite-vs-finite pair always fully separates in one pass.
//
// DETERMINISM (the whole point):
//   - Pairs come from SpatialIndex.eachCandidatePair in broadphase order (a<b).
//   - Corrections are ACCUMULATED into scratch arrays, then APPLIED in ascending
//     id order. So the result never depends on the order pairs happened to arrive,
//     only on the (fixed) set of pairs and the (fixed) ascending apply order.
//   - A small fixed number of ITERATIONS (ITERATIONS) re-resolves residual overlap
//     from multi-body clusters; the count is constant, so it is deterministic.
//   - All math is Q16.16 integer (fixed.ts); no float, no Map iteration on output.
//
// SCRATCH STATE IS NOT WORLD STATE: the accumulators below live for the duration of
// one applyCollision() call and are zeroed each call. They cross NO tick boundary,
// so they are NOT added to WorldState / hash / snapshot. Rollback restores the
// bodies and re-runs applyCollision, reproducing identical corrections. (This is
// why the collision layer needed ZERO new WorldState fields — see prove.ts.)
// ============================================================================

import {
  type Fixed, fromRaw, toRaw, fromFloatConst, add, sub, mul, div, gt, lt, ZERO, ONE,
} from '../fixed/fixed.ts';
import { type WorldState, BodyFlag, MASS_OF } from '../world/state.ts';
import type { SpatialIndex } from '../spatial/index.ts';

/** Fixed number of resolution passes. Constant ⇒ deterministic; 2 is stable for our densities. */
export const ITERATIONS = 4;

/**
 * UNDER-RELAXATION factor in [0,1] applied to every positional correction.
 *
 * WHY: corrections are accumulated for ALL pairs and applied at once (a Jacobi
 * sweep, chosen because it is order-independent → trivially deterministic). The
 * price of Jacobi is that a body squeezed between several contacts receives the
 * SUM of their pushes and can OVERSHOOT, then overshoot back next pass — a small
 * limit-cycle that leaves a sub-centimetre residual overlap forever. Scaling each
 * correction by RELAX (<1) damps that oscillation so the cluster converges to a
 * clean rest state, at the cost of needing a few more ITERATIONS. RELAX*ITERATIONS
 * is the convergence budget; both are CONSTANTS, so the whole thing stays a pure
 * deterministic function (no float, no data-dependent loop counts).
 */
const RELAX: Fixed = fromFloatConst(0.8);

/**
 * Inverse mass per MassClass, precomputed once (authoring-time, from MASS_OF which
 * is itself authored). invMass = 1/mass. Larger mass ⇒ smaller invMass ⇒ moves
 * less under the same overlap. (Anchor is infinite-ish relative to Light.)
 */
const INV_MASS_OF: readonly Fixed[] = MASS_OF.map((m) => div(ONE, m));

/**
 * Reusable correction accumulators (per body, RAW Fixed). Grown on demand; their
 * CONTENTS are scratch (zeroed each applyCollision call) so they hold no cross-tick
 * state. Module-level for allocation reuse only — never read across calls.
 */
let accX = new Int32Array(0);
let accZ = new Int32Array(0);

function ensureScratch(n: number): void {
  if (accX.length < n) {
    accX = new Int32Array(n);
    accZ = new Int32Array(n);
  }
}

/** Vertical spans overlap iff |centerYa - centerYb| < halfA + halfB (touching = no push). */
function verticalOverlap(w: WorldState, a: number, b: number): boolean {
  const dy = w.py[a]! - w.py[b]!;
  const absDy = dy < 0 ? -dy : dy;
  return absDy < w.halfHeight[a]! + w.halfHeight[b]!;
}

/**
 * True if the pair must be SKIPPED for body-body resolution:
 *  - either body dead,
 *  - one is carried BY the other (the carry transform owns that relationship), or
 *  - both are carried (each is slaved to its carrier; pushing them fights the socket).
 * (A carried body vs a third free body IS still resolved — a held object can still
 *  bump a bystander; the carry transform re-asserts next tick.)
 */
function skipPair(w: WorldState, a: number, b: number): boolean {
  if ((w.flags[a]! & BodyFlag.Alive) === 0) return true;
  if ((w.flags[b]! & BodyFlag.Alive) === 0) return true;
  if (w.grabbedBy[a]! === b || w.grabbedBy[b]! === a) return true; // linked pair
  if (w.grabbedBy[a]! !== -1 && w.grabbedBy[b]! !== -1) return true; // both carried
  return false;
}

/**
 * Resolve all body-vs-body overlaps reported by `index` (which must have been
 * rebuilt for the current tick). MUTATES `w`. Runs ITERATIONS passes; each pass
 * accumulates per-body positional corrections from every candidate pair, then
 * applies them in ascending id order. Pure function of (w, index contents).
 */
export function circleResolve(w: WorldState, index: SpatialIndex): void {
  const count = w.count;
  ensureScratch(count);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // zero accumulators for this pass over [0,count)
    for (let i = 0; i < count; i++) {
      accX[i] = 0;
      accZ[i] = 0;
    }

    // --- accumulate corrections from every candidate pair (broadphase order) ---
    index.eachCandidatePair((a, b) => {
      if (skipPair(w, a, b)) return;
      if (!verticalOverlap(w, a, b)) return;

      const dxRaw = w.px[b]! - w.px[a]!;
      const dzRaw = w.pz[b]! - w.pz[a]!;
      const rSum = fromRaw(w.radius[a]! + w.radius[b]!);

      // ground-plane center distance (Fixed)
      const dx = fromRaw(dxRaw);
      const dz = fromRaw(dzRaw);
      const distSq = add(mul(dx, dx), mul(dz, dz));
      const rSumSq = mul(rSum, rSum);
      if (!lt(distSq, rSumSq)) return; // not overlapping (touching counts as clear)

      // separation axis + penetration depth
      let nx: Fixed;
      let nz: Fixed;
      let pen: Fixed;
      if (gt(distSq, ZERO)) {
        const dist = fixedSqrt(distSq);
        // unit normal from a → b
        nx = div(dx, dist);
        nz = div(dz, dist);
        pen = sub(rSum, dist);
      } else {
        // exactly coincident centers — pick a deterministic axis (+X) to break the tie
        nx = ONE;
        nz = ZERO;
        pen = rSum;
      }

      // split the push by inverse mass: heavier moves less
      const invA = INV_MASS_OF[w.massClass[a]!]!;
      const invB = INV_MASS_OF[w.massClass[b]!]!;
      const invSum = add(invA, invB);
      if (!gt(invSum, ZERO)) return; // both infinite mass — neither moves (defensive)

      const fracA = div(invA, invSum); // a's share of the correction
      const fracB = div(invB, invSum);
      // a moves AGAINST the normal (toward −n), b moves WITH it (toward +n).
      // Scale by RELAX to damp Jacobi overshoot in dense contact (see RELAX doc).
      const penR = mul(pen, RELAX);
      const corrA = mul(penR, fracA);
      const corrB = mul(penR, fracB);

      accX[a] = toRaw(sub(fromRaw(accX[a]!), mul(nx, corrA)));
      accZ[a] = toRaw(sub(fromRaw(accZ[a]!), mul(nz, corrA)));
      accX[b] = toRaw(add(fromRaw(accX[b]!), mul(nx, corrB)));
      accZ[b] = toRaw(add(fromRaw(accZ[b]!), mul(nz, corrB)));
    });

    // --- apply accumulated corrections in ASCENDING id order (deterministic) ---
    for (let i = 0; i < count; i++) {
      if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
      if (w.grabbedBy[i]! !== -1) continue; // carried bodies are positioned by SYSTEM 5
      if (accX[i] === 0 && accZ[i] === 0) continue;
      w.px[i] = toRaw(add(fromRaw(w.px[i]!), fromRaw(accX[i]!)));
      w.pz[i] = toRaw(add(fromRaw(w.pz[i]!), fromRaw(accZ[i]!)));
    }
  }
}

// fixed.sqrt re-imported with a local name to keep the hot import list narrow.
import { sqrt as fixedSqrt } from '../fixed/fixed.ts';
