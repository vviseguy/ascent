// ============================================================================
// src/sim/collide/terrain.ts — the TERRAIN contract + a move-and-slide resolver.
// ============================================================================
//
// Bodies live in a hand/level-authored static world. We model that world as the
// cheapest thing that is both expressive enough for a tower arena and trivially
// deterministic:
//   - ONE ground plane at a fixed Y (the floor a body rests its base on), and
//   - a set of axis-aligned solid BOXES (walls, ledges, pillars, crates that are
//     baked into the level rather than dynamic bodies).
//
// WHY AXIS-ALIGNED BOXES
// ----------------------
// AABBs make body-vs-terrain a pure integer min/max test with no rotation, no
// dot products, no transcendentals — so the whole resolver is exact Q16.16
// arithmetic, identical on every engine (the determinism mandate, CLAUDE.md).
// Anything fancier (slopes, OBBs) can be approximated by stacked boxes for now
// and the interface below does not change.
//
// WHY MOVE-AND-SLIDE (axis-separated), NOT AN IMPULSE SOLVER
// ----------------------------------------------------------
// Terrain is INFINITE-mass and never moves; the only correct response is to push
// the body out of the solid by the SMALLEST penetration axis and zero the inbound
// velocity ON THAT AXIS only (so a body sliding along a wall keeps its tangential
// speed — "move and slide"). Resolving one axis at a time, X then Z then Y, in a
// fixed order, is order-independent for disjoint solids and fully deterministic.
//
// DERIVED/STATIC: a Terrain is authored level data, NOT part of WorldState. It is
// constant for a match, so it is never cloned/hashed/restored — rollback restores
// the bodies and re-runs the resolver against the same constant terrain.
// ============================================================================

import { type Fixed, toRaw, add, sub, lt, gt, ZERO } from '../fixed/fixed.ts';
import { type WorldState, BodyFlag } from '../world/state.ts';

/**
 * One axis-aligned solid box. All six bounds are RAW Q16.16 ints (matching the
 * world-state convention). minX<=maxX, minY<=maxY, minZ<=maxZ (caller's contract;
 * makeBox enforces it). y is UP (consistent with vec3 / step.ts).
 */
export interface AABB {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * The static terrain: a ground plane (raw Fixed Y) plus a list of solid boxes.
 * A plain immutable struct — authored once, shared, never mutated by the sim.
 */
export interface Terrain {
  /** The single ground plane height (raw Fixed). A body's BASE rests here. */
  readonly groundY: number;
  /** Solid boxes the bodies must stay out of. Iterated in array order (stable). */
  readonly solids: readonly AABB[];
}

/** Build an AABB from Fixed bounds, normalizing min/max so callers can be sloppy. */
export function makeBox(
  minX: Fixed, minY: Fixed, minZ: Fixed,
  maxX: Fixed, maxY: Fixed, maxZ: Fixed,
): AABB {
  return {
    minX: toRaw(lt(minX, maxX) ? minX : maxX),
    minY: toRaw(lt(minY, maxY) ? minY : maxY),
    minZ: toRaw(lt(minZ, maxZ) ? minZ : maxZ),
    maxX: toRaw(gt(maxX, minX) ? maxX : minX),
    maxY: toRaw(gt(maxY, minY) ? maxY : minY),
    maxZ: toRaw(gt(maxZ, minZ) ? maxZ : minZ),
  };
}

/**
 * Convenience: a flat floor at groundY plus four perimeter walls forming an arena
 * of half-extent `halfExtent` (meters, Fixed), wall height `wallHeight`, wall
 * thickness `thickness`. Handy for proofs/sandboxes; real levels author their own
 * Terrain. Deterministic (pure Fixed arithmetic).
 */
export function makeArena(
  groundY: Fixed,
  halfExtent: Fixed,
  wallHeight: Fixed,
  thickness: Fixed,
): Terrain {
  const lo = sub(ZERO, halfExtent); // -halfExtent
  const hi = halfExtent;
  const top = add(groundY, wallHeight);
  const inLo = add(lo, thickness);
  const inHi = sub(hi, thickness);
  const solids: AABB[] = [
    // west wall (−X face)
    makeBox(lo, groundY, lo, inLo, top, hi),
    // east wall (+X face)
    makeBox(inHi, groundY, lo, hi, top, hi),
    // south wall (−Z face), between the X walls so corners don't double-thick
    makeBox(inLo, groundY, lo, inHi, top, inLo),
    // north wall (+Z face)
    makeBox(inLo, groundY, inHi, inHi, top, hi),
  ];
  return { groundY: toRaw(groundY), solids };
}

/**
 * Keep every ALIVE, non-carried body out of the terrain solids and on/above the
 * ground plane. MUTATES `w` in place. Pure function of (w, terrain).
 *
 * ALGORITHM (per body, ascending id — the only iteration order):
 *   1. Ground plane: if the body's base is below groundY, lift it so the base
 *      rests on the plane and zero downward Y velocity; mark Grounded.
 *   2. For each solid box (array order): treat the body as a circle of `radius`
 *      in plan with a vertical span [base, base+2*halfHeight]. The body-vs-box
 *      overlap region is the box inflated by the body's radius on X/Z (Minkowski
 *      sum of an AABB and a circle, conservatively boxed — exact for face contacts
 *      and slightly generous at corners, which is fine and stays deterministic).
 *      If the inflated box overlaps on all three axes, push the body out along the
 *      axis of MINIMUM penetration and zero that velocity component (move & slide).
 *
 * Carried bodies (grabbedBy set) are owned by the carry transform (step SYSTEM 5),
 * so we skip them here — the carrier's own terrain resolution keeps the pair sane.
 */
export function resolveTerrain(w: WorldState, terrain: Terrain): void {
  const count = w.count;
  const groundY = terrain.groundY;
  const solids = terrain.solids;
  for (let i = 0; i < count; i++) {
    const fl = w.flags[i]!;
    if ((fl & BodyFlag.Alive) === 0) continue;
    if (w.grabbedBy[i] !== -1) continue; // carried — carrier owns transform

    // --- 1. ground plane (base on the plane) ---
    const half = w.halfHeight[i]!;
    const baseFloor = groundY + half; // center Y so the base sits on groundY
    if (w.py[i]! < baseFloor) {
      w.py[i] = baseFloor;
      if (w.vy[i]! < 0) w.vy[i] = 0;
      w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
    }

    // --- 2. solid boxes (move & slide, min-penetration axis) ---
    const r = w.radius[i]!;
    for (let s = 0; s < solids.length; s++) {
      const box = solids[s]!;
      // inflate the box by the body radius on X/Z (circle-vs-AABB → point-vs-inflated-AABB)
      const bMinX = box.minX - r;
      const bMaxX = box.maxX + r;
      const bMinZ = box.minZ - r;
      const bMaxZ = box.maxZ + r;
      // vertical span of the (upright capsule) body: [base, top]
      const base = w.py[i]! - half;
      const topY = w.py[i]! + half;

      const px = w.px[i]!;
      const pz = w.pz[i]!;
      // overlap test on all three axes
      if (px <= bMinX || px >= bMaxX) continue;
      if (pz <= bMinZ || pz >= bMaxZ) continue;
      if (topY <= box.minY || base >= box.maxY) continue;

      // penetration depth toward each face (always positive given the overlap above)
      const penXNeg = px - bMinX; // push to −X
      const penXPos = bMaxX - px; // push to +X
      const penZNeg = pz - bMinZ; // push to −Z
      const penZPos = bMaxZ - pz; // push to +Z
      const penYNeg = topY - box.minY; // push down (body below box) — rare
      const penYPos = box.maxY - base; // push up (body on top of box)

      // smallest of the six → the separation axis (ties resolved by fixed order)
      const minX = penXNeg < penXPos ? penXNeg : penXPos;
      const minZ = penZNeg < penZPos ? penZNeg : penZPos;
      const minY = penYNeg < penYPos ? penYNeg : penYPos;

      if (minX <= minZ && minX <= minY) {
        // resolve on X
        if (penXNeg < penXPos) w.px[i] = px - penXNeg;
        else w.px[i] = px + penXPos;
        w.vx[i] = 0;
      } else if (minZ <= minY) {
        // resolve on Z
        if (penZNeg < penZPos) w.pz[i] = pz - penZNeg;
        else w.pz[i] = pz + penZPos;
        w.vz[i] = 0;
      } else {
        // resolve on Y
        if (penYPos <= penYNeg) {
          // sitting on top of the box → treat its top as a floor
          w.py[i] = box.maxY + half;
          if (w.vy[i]! < 0) w.vy[i] = 0;
          w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
        } else {
          // bumped the underside of the box
          w.py[i] = box.minY - half;
          if (w.vy[i]! > 0) w.vy[i] = 0;
        }
      }
    }
  }
}

/** Empty terrain (just a ground plane at y) — for tests that want body-body only. */
export function flatGround(groundY: Fixed = ZERO): Terrain {
  return { groundY: toRaw(groundY), solids: [] };
}
