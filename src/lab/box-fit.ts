// ============================================================================
// src/lab/box-fit.ts — COLLISION-BOX GENERATOR (solid voxelize → loose-box cover).
// ============================================================================
//
// Turns an arbitrary mesh (a KayKit GLB, a procedural prop) into a SMALL set of
// object-local AABBs that HUG its solid volume — the `footprint` a WorldObject
// hands the collider. We never hand-author boxes for real assets: a table comes
// out as a top slab + legs, a barrel as ~1-2 chunky boxes, a chest as a body block,
// a bed as a frame slab + mattress + posts, a wall as one box.
//
// WHY SOLID VOXELIZE + LOOSE-BOX COVER:
//  - A collider wants the SOLID OBSTACLE, not a hollow shell: you can't walk through
//    a barrel even though its model is an open-topped tube. So we want the FILLED volume.
//    We get it by SURFACE-SHELLING the mesh then FLOODING THE EXTERIOR: solid = whatever
//    the outside-air flood can't reach (see §2). This never WELDS separate features the
//    way the old outermost-span fill did — the air between table legs is exterior, so it
//    stays empty and the legs stay distinct boxes.
//  - We then cover the filled voxels with a handful of boxes. The OLD cover required
//    every box to be 100% solid, which SHATTERS into slivers at a fine cell (a bed's
//    slatted frame, a chest's curved lid). The NEW cover is an EDGE-DENSITY grow: a box
//    grows a face only while the one-voxel-thick BOUNDARY SLAB it adds is dense enough
//    (≥ `edgeDensity` solid). A loose box that pokes a little past the mesh is SAFE for
//    collision (it errs slightly bigger), and it lets ONE box span a slatted frame or a
//    rounded lid instead of a dozen slivers.
//
// THE OBJECTIVE (don't get this backwards): we maximize box SIZE, braked by the EDGE.
// We do NOT gate on the whole box's average fill — a dense bulk would dilute a sparse
// slab and let the box over-grow into empty space. Instead each face-grow is judged on
// the DENSITY OF THE SLAB BEING ADDED: accept iff that boundary slab is ≥ edgeDensity
// solid. Growth therefore stops exactly at the solid boundary in EACH direction, yet
// ignores INTERIOR voids (a grooved top face is still dense → the box grows over the
// groove). Bigger where the solid extends, tight at the real edges. A 1-voxel box is
// trivially "100% filled" so a fill objective degenerates to slivers — edge density
// does not. (`minFill` survives only as an optional global safety cap; `minFill: 1.0`
// still reproduces the old strict every-box-100%-solid cover.)
//
// ROBUST INSIDE-TEST (handles non-watertight KayKit parts): rather than an inside/parity
// test (which needs watertightness) we SURFACE-SHELL the mesh, DILATE the shell by 1 to seal
// sub-voxel cracks, and FLOOD THE EXTERIOR from the grid boundary through empty voxels — solid
// is everything the flood can't reach (shell + sealed interior). No watertightness required,
// and a table's underside / leg-gaps are exterior-reachable so they stay OPEN (legs, not a
// welded block). Accepted caveat: a big OPEN FACE (open-top barrel) can flood partly hollow —
// fine for collision (a body can't enter a small prop). See §2 for the full rationale.
//
// DETERMINISM: this runs OFFLINE / at lab-load (FLOATS ARE FINE here — docs say so).
// Only the RESULTING boxes would later become fixed-point sim constants (boxesToConsts).
// Every order is fixed (surface raster + boundary flood, deterministic seed selection, and a
// pass-counter-driven 6-face relaxation rotation), so same mesh+seed → same boxes. The
// `random-best` sampler uses a SEEDED mulberry32, never Math.random.
// ============================================================================

import * as THREE from 'three';
import { mulberry32 } from './element.ts';
import { stitchHoles } from './mesh-stitch.ts';

/** An axis-aligned box in object-local metres: inclusive corners. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

/** Seeding strategy for the loose-box cover (which unclaimed-solid voxel(s) to grow from).
 *  - `scan`        : first unclaimed-solid voxel in z→y→x scan order (simplest, deterministic).
 *  - `cluster`     : interior peaks of the largest remaining blobs (+ alternates); relax each
 *                    and place the biggest-COVERAGE box (the established default, now coverage-first).
 *  - `random-best` : sample N random unclaimed-solid voxels (SEEDED PRNG), relax a box from
 *                    each, place the best by COVERAGE-aware score (tie-break larger); see `looseCover`. */
export type SeedMode = 'scan' | 'cluster' | 'random-best';

export interface FitBoxesOpts {
  /** EXPLICIT voxel edge length (object-local metres). Normally LEFT UNSET so the cell is
   *  derived RELATIVE to the mesh (bbox-diagonal / `cellDivisor`, clamped to
   *  [`cellMin`,`cellMax`]) — that auto-scales resolution to any object with ZERO per-object
   *  tuning. Set this only to pin a fixed resolution. */
  cell?: number;
  /** Voxels along the mesh's bbox DIAGONAL when `cell` is auto-derived (cell = diag /
   *  cellDivisor). Higher = finer. Default 26 — enough to separate a table's legs/stretcher
   *  without shattering simple props. Clamped by cellMin/cellMax. */
  cellDivisor?: number;
  /** Floor/ceiling (object-local metres) on the auto-derived cell, so a tiny prop doesn't
   *  voxelize absurdly fine nor a huge one absurdly coarse. Defaults 0.04 / 0.16. */
  cellMin?: number;
  cellMax?: number;
  /** SIZE-BASED STOP (the real terminator): only EMIT a relaxed box whose longest edge is
   *  ≥ minBoxSize, and keep seeding while big-enough boxes remain. An absolute,
   *  collision-relevant floor SHARED by every object (no per-object count). Default 0.14u.
   *  (Replaces minBox as the primary limit; minBox is kept as an alias if set.) */
  minBoxSize?: number;
  /** PRIMARY GROWTH KNOB — minimum (edge-weighted) solid density of the BOUNDARY SLAB a
   *  face-grow adds (solid voxels / slab voxels, 0..1). In the GROW+SHRINK relaxation a
   *  face grows by one slab while the NEXT slab (just beyond the edge) is ≥ edgeDensity
   *  solid, and RETRACTS while its own outermost slab is < edgeDensity — so each face
   *  settles exactly at the density transition (outer slab passes, next fails), regardless
   *  of where the seed sat. This brakes growth at the real solid boundary in EACH direction
   *  while ignoring interior voids (a grooved tabletop still has a dense top face → the box
   *  grows over the groove). Default 0.7. Raise toward 1.0 to hug tighter (more, smaller
   *  boxes); lower to swallow more empty space in fewer boxes. */
  edgeDensity?: number;
  /** EDGE-WEIGHTED emptiness weight (≥1). A slab's PERIMETER/CORNER voxels count this many
   *  times more toward its weighted density than its centre voxels: weighted = Σ w·solid/Σ w
   *  with w = edgeWeight on the slab rim, 1 in the interior. So a face stops/retracts the
   *  moment its leading EDGE drifts off the solid (a feature narrowing or ending) even while
   *  the slab CENTRE is still solid — this is what peels a box back to a single leg/feature
   *  rather than letting it bridge a gap on a still-dense core. Default 1.5; 1.0 = uniform
   *  (the old behaviour). */
  edgeWeight?: number;
  /** NON-OVERLAPPING boxes — the main SEPARATION lever (default TRUE). Each placed box
   *  CLAIMS its whole AABB volume; later boxes may only grow into UNCLAIMED volume (a slab
   *  touching any claimed voxel can't be grown into). Boxes therefore partition the solid
   *  into ABUTTING but non-overlapping chunks → individual legs, the stretcher in the gap
   *  between claimed legs, a pillow and blanket each in their own box. Set false for the old
   *  overlap-allowed cover. */
  nonOverlap?: boolean;
  /** Optional GLOBAL fill safety cap (0..1): refuse any face-grow that would drop the
   *  whole box's solid-fill below this. edgeDensity is the real brake; this is just a
   *  backstop against a box accreting many borderline slabs. 1.0 = also require every
   *  box 100% solid (reproduces the old strict cover, regardless of edgeDensity).
   *  Default 0 (off — edge-density alone governs growth). */
  minFill?: number;
  /** Stop emitting boxes once this fraction of all solid voxels is covered (0..1).
   *  The remaining sliver voxels are left to the collider's slop. Default 0.93. */
  coverageTarget?: number;
  /** FAR SAFETY BACKSTOP on emitted boxes (NOT the real limit — `minBoxSize` is). If
   *  exceeded the cell coarsens (×1.4) and we retry. Default 24 — generous, so size, not
   *  count, governs normal objects. */
  maxBoxes?: number;
  /** DEPRECATED alias for `minBoxSize` (kept so old specs still parse). If both are set,
   *  minBoxSize wins. */
  minBox?: number;
  /** Dilate the solid set by N voxels AFTER voxelization (collision errs bigger).
   *  Default 0 — the outward envelope rounding already pads slightly. Bump to 1 for
   *  a genuinely leaky mesh that needs its seams closed. */
  dilate?: number;
  /** SEEDING STRATEGY for the cover. Default `cluster` (interior peaks of the largest blobs,
   *  now coverage-first). `scan` seeds the centroid-nearest unclaimed-solid voxel; `random-best`
   *  samples voxels and keeps the best by coverage-aware score (see `samples`/`beam`). */
  seedMode?: SeedMode;
  /** `random-best` only: # of random unclaimed-solid voxels SAMPLED per round; each is
   *  relaxed to a full box and the best (highest COVERAGE-aware score, tie-break larger) is
   *  placed. Default 10. Higher = better boxes, more fit time. */
  samples?: number;
  /** `random-best` only: TREEING beam width B. After scoring the round's samples we keep the
   *  top-B candidate boxes as branches, provisionally claim each, do a SHALLOW 1-level
   *  lookahead (one more best-of-`samples` box on the remaining volume), and place the branch
   *  whose 2-box total fill is best. B=1 disables treeing (pure greedy). Default 2 (shallow,
   *  per Jacob). */
  beam?: number;
  /** SEED for `random-best`'s mulberry32 PRNG (so the same mesh+seed reproduces the same
   *  boxes — these footprints get baked). Defaults to 1; the lab passes the build seed. */
  randomSeed?: number;
  /** COVERAGE/FILL balance λ for candidate SELECTION (≥0). A relaxed candidate is scored by
   *  `coverage · (1 + λ·fill)` where `coverage` = the NEWLY-claimed solid voxels (not yet
   *  covered) the box would add. This makes a BIG tight box (a whole cork, a whole leg) beat a
   *  small tight SLIVER — a sliver is ~100% fill but covers almost nothing, so coverage
   *  dominates while fill only breaks ties between similarly-sized boxes. Default 0.5. Raise to
   *  favour tightness (more, smaller boxes); lower toward 0 for pure largest-coverage. Used by
   *  `random-best` selection AND by `cluster`/`scan` alternate-seed selection. */
  coverageWeight?: number;
}

// GLOBAL DEFAULTS — tuned to give good footprints on ANY mesh with ZERO per-object knobs.
// `cell` is left undefined so it derives RELATIVE to the object (bbox-diag / cellDivisor).
// cellDivisor is the EXPERIMENTAL 4× granularity (26 → 104): 4× finer voxels per axis.
// cellMin shrinks ×4 too so the absolute floor doesn't clamp the finer cell back up.
const DEFAULTS = {
  cellDivisor: 104,
  cellMin: 0.01,
  cellMax: 0.16,
  // edgeDensity 0.5 (reset from the 0.7 tightening experiment): a face grows into a boundary
  // slab that is ≥50% solid — the balanced baseline. The live lab control overrides this.
  edgeDensity: 0.5,
  edgeWeight: 1.5,
  nonOverlap: true,
  minFill: 0,
  coverageTarget: 0.93,
  maxBoxes: 24,
  minBoxSize: 0.14,
  dilate: 0,
  seedMode: 'cluster' as SeedMode,
  samples: 10,
  beam: 2,
  randomSeed: 1,
  coverageWeight: 0.5,
} as const;

/** Per-fit diagnostics surfaced to the lab HUD (how well the boxes hug). */
export interface FitStats {
  /** Voxel edge actually used (after any coarsening retries). */
  cell: number;
  /** # solid voxels found by the voxelizer. */
  solidVoxels: number;
  /** Fraction of solid voxels the emitted boxes cover (0..1). */
  coverage: number;
  /** Overall solid-fill of the union of emitted boxes: solidCovered / totalBoxVoxels
   *  (1 = boxes contain only solid; lower = boxes swallowed empty space). */
  fill: number;
  /** # boxes emitted (post sliver-drop). */
  boxCount: number;
}

/** A flat triangle soup baked into ONE object-local space (positions only). */
interface TriSoup {
  /** xyz triplets per triangle vertex: [ax,ay,az, bx,by,bz, cx,cy,cz] × N. */
  tris: Float32Array;
  count: number;
  box: THREE.Box3;
}

/**
 * Fit a small set of object-local collision AABBs to `object`.
 * Returns boxes in the object's OWN local frame (child transforms are baked; the
 * root's transform is treated as identity, matching how a WorldObject authors its
 * `footprint` about its own origin at y=0).
 */
export function fitBoxes(object: THREE.Object3D, opts: FitBoxesOpts = {}): AABB[] {
  return fitBoxesWithStats(object, opts).boxes;
}

/**
 * Same as `fitBoxes` but also returns the {@link FitStats} for HUD/tooling — the
 * coverage + fill% + box count so a reviewer can see how tightly the boxes hug.
 */
export function fitBoxesWithStats(object: THREE.Object3D, opts: FitBoxesOpts = {}): { boxes: AABB[]; stats: FitStats } {
  const edgeDensity = opts.edgeDensity ?? DEFAULTS.edgeDensity;
  const edgeWeight = opts.edgeWeight ?? DEFAULTS.edgeWeight;
  const nonOverlap = opts.nonOverlap ?? DEFAULTS.nonOverlap;
  const minFill = opts.minFill ?? DEFAULTS.minFill;
  const coverageTarget = opts.coverageTarget ?? DEFAULTS.coverageTarget;
  const maxBoxes = opts.maxBoxes ?? DEFAULTS.maxBoxes;
  // minBoxSize is the SIZE-BASED stop; minBox survives only as a deprecated alias.
  const minBoxSize = opts.minBoxSize ?? opts.minBox ?? DEFAULTS.minBoxSize;
  const dilate = opts.dilate ?? DEFAULTS.dilate;
  const seedMode = opts.seedMode ?? DEFAULTS.seedMode;
  const samples = opts.samples ?? DEFAULTS.samples;
  const beam = opts.beam ?? DEFAULTS.beam;
  const randomSeed = opts.randomSeed ?? DEFAULTS.randomSeed;
  const coverageWeight = opts.coverageWeight ?? DEFAULTS.coverageWeight;

  const soup = bakeSoup(object);

  // RELATIVE cell: derive from the bbox diagonal so resolution auto-scales to the mesh,
  // clamped to a sane absolute band. An explicit `cell` opt pins it instead.
  const b0 = soup.box;
  const diag = soup.count > 0 ? Math.hypot(b0.max.x - b0.min.x, b0.max.y - b0.min.y, b0.max.z - b0.min.z) : 1;
  const cellMin = opts.cellMin ?? DEFAULTS.cellMin, cellMax = opts.cellMax ?? DEFAULTS.cellMax;
  const cellDivisor = opts.cellDivisor ?? DEFAULTS.cellDivisor;
  const autoCell = clamp(diag / cellDivisor, cellMin, cellMax);

  if (soup.count === 0) {
    return { boxes: [], stats: { cell: opts.cell ?? autoCell, solidVoxels: 0, coverage: 0, fill: 0, boxCount: 0 } };
  }

  // Start at the (auto or explicit) cell; coarsen (×1.4) only if the box count blows the
  // far backstop — size, not count, is the normal terminator. `groundSeal` falls back to the
  // leak-tolerant flood when stitching couldn't close every hole (set by bakeSoup → lastStitchInfo).
  const groundSeal = lastStitchInfo.failed > 0;
  let cell = opts.cell ?? autoCell;
  for (let attempt = 0; attempt < 9; attempt++) {
    const grid = voxelize(soup, cell, dilate, groundSeal);
    if (grid && grid.solidCount > 0) {
      const res = looseCover(grid, { edgeDensity, edgeWeight, nonOverlap, minFill, coverageTarget, maxBoxes, minBoxSize, seedMode, samples, beam, randomSeed, coverageWeight });
      if (res.boxes.length > 0 && res.boxes.length <= maxBoxes) {
        return { boxes: res.boxes, stats: { cell, solidVoxels: grid.solidCount, ...res.stats } };
      }
    }
    cell *= 1.4;
  }
  // Last resort: a single tight bounding box (always valid, never explodes the count).
  const b = soup.box;
  const boxes: AABB[] = [{ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }];
  return { boxes, stats: { cell, solidVoxels: 0, coverage: 1, fill: 1, boxCount: 1 } };
}

/** The SOLID voxel grid the fitter sees, for the lab's voxel-visualization overlay (?voxels=1).
 *  Returns the cell size and the OBJECT-LOCAL CENTRE of every solid voxel — render these as small
 *  cubes to SEE exactly what the voxelizer marked solid (does a table's leg-gap / under-top read
 *  as solid? a concavity over-fill?). Mirrors fitBoxesWithStats' cell derivation (auto cell +
 *  coarsen-on-too-fine) so the viz matches the grid the fit actually used. Pure tooling. */
export function voxelGridForViz(object: THREE.Object3D, opts: FitBoxesOpts = {}): { cell: number; centers: Float32Array; count: number } {
  const dilate = opts.dilate ?? DEFAULTS.dilate;
  const soup = bakeSoup(object);
  if (soup.count === 0) return { cell: opts.cell ?? DEFAULTS.cellMin, centers: new Float32Array(0), count: 0 };
  const b0 = soup.box;
  const diag = Math.hypot(b0.max.x - b0.min.x, b0.max.y - b0.min.y, b0.max.z - b0.min.z) || 1;
  const cellMin = opts.cellMin ?? DEFAULTS.cellMin, cellMax = opts.cellMax ?? DEFAULTS.cellMax;
  const cellDivisor = opts.cellDivisor ?? DEFAULTS.cellDivisor;
  let cell = opts.cell ?? clamp(diag / cellDivisor, cellMin, cellMax);
  const groundSeal = lastStitchInfo.failed > 0; // mirror the fit's fallback choice (set by bakeSoup)
  // mirror the fit's coarsen-on-too-fine retry so the viz grid == the grid the fit used.
  for (let attempt = 0; attempt < 9; attempt++) {
    const grid = voxelize(soup, cell, dilate, groundSeal);
    if (grid && grid.solidCount > 0) {
      const out = new Float32Array(grid.solidCount * 3);
      let w = 0;
      const { nx, ny, nz, solid } = grid;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        if (!solid[z * ny * nx + y * nx + x]) continue;
        out[w++] = grid.ox + (x + 0.5) * cell;
        out[w++] = grid.oy + (y + 0.5) * cell;
        out[w++] = grid.oz + (z + 0.5) * cell;
      }
      return { cell, centers: out, count: grid.solidCount };
    }
    cell *= 1.4;
  }
  return { cell, centers: new Float32Array(0), count: 0 };
}

// ---------------------------------------------------------------------------
// 1. Bake every Mesh under `object` into one object-local triangle soup.
// ---------------------------------------------------------------------------

/** Diagnostics from the most recent {@link bakeSoup} stitch pass (for the lab HUD / tooling).
 *  `failed > 0` means some boundary loop could not be closed → the voxelizer used the
 *  ground-seal flood fallback for that mesh. Reset at the start of each bake. */
export let lastStitchInfo: { loops: number; stitched: number; failed: number } = { loops: 0, stitched: 0, failed: 0 };

function bakeSoup(object: THREE.Object3D): TriSoup {
  object.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const out: number[] = [];
  const box = new THREE.Box3();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const local = new THREE.Matrix4();

  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    // child world matrix, then back into the ROOT's local frame
    local.copy(rootInv).multiply(mesh.matrixWorld);
    const index = geo.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      vA.fromBufferAttribute(pos, ia).applyMatrix4(local);
      vB.fromBufferAttribute(pos, ib).applyMatrix4(local);
      vC.fromBufferAttribute(pos, ic).applyMatrix4(local);
      out.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);
      box.expandByPoint(vA); box.expandByPoint(vB); box.expandByPoint(vC);
    }
  });
  // STITCH the holes so the voxelizer sees a WATERTIGHT surface (weld → boundary loops → Liepa
  // advancing-front fill; see mesh-stitch.ts). With holes closed, the exterior flood can't leak
  // into a sealed shell, so the solid is correctly filled with no hollow and no bridges — without
  // the ground-seal heuristic. A loop the stitcher can't close is reported in `lastStitchInfo`
  // (failed > 0) so the voxelizer falls back to the leak-tolerant ground-seal flood for that mesh.
  const st = stitchHoles(new Float32Array(out), out.length / 9);
  lastStitchInfo = { loops: st.loops, stitched: st.stitched, failed: st.failed };
  return { tris: st.tris, count: st.count, box };
}

// ---------------------------------------------------------------------------
// 2. SOLID voxelize via SURFACE SHELL + FLOOD-THE-EXTERIOR over the STITCHED (now
//    watertight) mesh. Because bakeSoup already closed the holes (mesh-stitch.ts), the
//    flood can't leak into a sealed shell — the fill is correct with NO hollow and NO
//    bridges, and never welds separate features (a real gap has no solid to grow into):
//
//      (a) SURFACE-voxelize: mark every voxel the mesh SURFACE passes through (a
//          ~1-voxel-thick shell). Per-triangle point rasterization, not a span fill.
//      (b) DILATE the shell by 1 voxel: seals sub-voxel cracks from quantization.
//      (c) FLOOD the EXTERIOR: 6-connected BFS from the grid boundary through EMPTY
//          (non-shell) voxels. For a watertight mesh, seed all six faces; for the
//          GROUND-SEAL fallback (a hole the stitcher couldn't close), skip the −Y face
//          + close thin cavities so an open-bottomed leaky prop still fills solid.
//      (d) SOLID = every voxel the flood did NOT reach (the shell + everything sealed
//          inside it).
//
//    Why this fixes the BRIDGES: the air BETWEEN a table's legs and UNDER its top is
//    reachable from the grid boundary → flooded → EMPTY. The old outermost-span fill
//    instead filled the whole span between the first and last surface crossing on each
//    axis, so it welded the legs together with phantom solid. Gone now.
//
//    ACCEPTED CAVEAT: a prop with a genuinely BIG open face (an open-top barrel) can
//    flood partly hollow — usually FINE for collision (a body can't fit inside a small
//    prop, so a hollow shell collides like a solid). We do NOT hole-fill here; only a
//    large WALK-IN structure would need it (then: Liepa boundary triangulation, later).
// ---------------------------------------------------------------------------
interface Grid {
  nx: number; ny: number; nz: number;
  cell: number;
  /** grid-cell origin (min corner of voxel 0,0,0) in object-local space. */
  ox: number; oy: number; oz: number;
  /** solid[z*ny*nx + y*nx + x] — 1 = inside, 0 = empty. */
  solid: Uint8Array;
  solidCount: number;
}

/** Voxelize; returns null if the grid would be unreasonably large (caller coarsens). When the mesh
 *  is WATERTIGHT (stitched) we flood from ALL SIX faces — the sealed shell keeps the flood out, so
 *  the fill is correct and tight. When stitching FAILED for this mesh, `groundSeal` falls back to
 *  the leak-tolerant flood (skip the −Y bottom face + close thin cavities) so an open-bottomed
 *  leaky prop still fills solid instead of hollowing. */
function voxelize(soup: TriSoup, cell: number, dilate: number, groundSeal: boolean): Grid | null {
  const b = soup.box;
  // PAD the grid by 1 voxel on every side so there is always a guaranteed-empty boundary
  // shell for the exterior flood to start from (even if the mesh touches its own bbox).
  const ox = b.min.x - cell, oy = b.min.y - cell, oz = b.min.z - cell;
  const nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / cell)) + 2;
  const ny = Math.max(1, Math.ceil((b.max.y - b.min.y) / cell)) + 2;
  const nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / cell)) + 2;
  if (nx * ny * nz > 4_000_000) return null; // too fine for this object — coarsen

  // (a) SURFACE SHELL — mark every voxel the surface passes through.
  const shell = new Uint8Array(nx * ny * nz);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let t = 0; t < soup.count; t++) {
    const o = t * 9;
    A.set(soup.tris[o]!, soup.tris[o + 1]!, soup.tris[o + 2]!);
    B.set(soup.tris[o + 3]!, soup.tris[o + 4]!, soup.tris[o + 5]!);
    C.set(soup.tris[o + 6]!, soup.tris[o + 7]!, soup.tris[o + 8]!);
    rasterizeTriangle(A, B, C, shell, nx, ny, nz, ox, oy, oz, cell);
  }

  // (b) DILATE the shell by 1 ONLY in the leak-tolerant fallback (groundSeal = stitch failed),
  // to seal sub-voxel cracks so the flood can't leak through. A WATERTIGHT (stitched) mesh is
  // already closed (the dense rasterization marks every crossed voxel), so dilating there just
  // inflates the SOLID by a full voxel EVERYWHERE — skip it on the normal (watertight) path.
  if (groundSeal) {
    const shellGrid: Grid = { nx, ny, nz, cell, ox, oy, oz, solid: shell, solidCount: 0 };
    dilateOnce(shellGrid);
  }

  // (c) FLOOD the exterior: BFS from the boundary through EMPTY (non-shell) voxels. For a WATERTIGHT
  // (stitched) mesh, seed ALL SIX faces — the closed shell blocks the flood, so the interior fills
  // correctly. For the GROUND-SEAL fallback (stitch failed), seed the four SIDE faces and the TOP
  // but NOT the −Y bottom: a leaky open-bottomed prop rests on the floor, so its underside is
  // sealed by the ground, not open to air — this keeps it solid instead of hollow, while a real
  // gap between features is still reached HORIZONTALLY from the sides (legs stay separate).
  const exterior = new Uint8Array(nx * ny * nz);
  const q = new Int32Array(nx * ny * nz);
  let head = 0, tail = 0;
  const push = (i: number): void => { if (!shell[i] && !exterior[i]) { exterior[i] = 1; q[tail++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(z * ny * nx + y * nx + 0); push(z * ny * nx + y * nx + (nx - 1)); }     // ±X
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(z * ny * nx + (ny - 1) * nx + x); if (!groundSeal) push(z * ny * nx + 0 * nx + x); } // +Y (and −Y unless ground-sealed)
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(0 * ny * nx + y * nx + x); push((nz - 1) * ny * nx + y * nx + x); }     // ±Z
  while (head < tail) {
    const c = q[head++]!;
    const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
    if (x > 0) push(c - 1);
    if (x < nx - 1) push(c + 1);
    if (y > 0) push(c - nx);
    if (y < ny - 1) push(c + nx);
    if (z > 0) push(c - ny * nx);
    if (z < nz - 1) push(c + ny * nx);
  }

  // (d) SOLID = everything the exterior flood did NOT reach (shell + sealed interior).
  const solid = new Uint8Array(nx * ny * nz);
  let solidCount = 0;
  for (let i = 0; i < solid.length; i++) {
    if (!exterior[i]) { solid[i] = 1; solidCount++; }
  }
  const grid: Grid = { nx, ny, nz, cell, ox, oy, oz, solid, solidCount };
  // (e) FALLBACK ONLY: CLOSE thin internal cavities the leak-tolerant flood may have left (a flat
  // WALL whose hollow the flood reached through a side crack → front+back shells). A small-radius
  // close re-welds ≤~4-voxel cavities while leaving WIDE real gaps (legs) open. A watertight
  // (stitched) mesh fills correctly with no cavity, so the close is skipped there (no-op anyway).
  if (groundSeal) closeSolid(grid, 2);
  for (let i = 0; i < dilate; i++) dilateOnce(grid);
  return grid;
}

/** Rasterize ONE triangle into the shell grid: mark every voxel the triangle surface passes
 *  through. Point-samples the triangle on a barycentric lattice fine enough (step ≤ cell/2) that
 *  no voxel the triangle crosses is missed, plus its 3 edges (so thin/degenerate tris still mark).
 *  Each sample point marks the voxel CONTAINING it. Robust, no watertightness needed. */
function rasterizeTriangle(A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3, shell: Uint8Array, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number, cell: number): void {
  const mark = (px: number, py: number, pz: number): void => {
    const x = Math.floor((px - ox) / cell), y = Math.floor((py - oy) / cell), z = Math.floor((pz - oz) / cell);
    if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return;
    shell[z * ny * nx + y * nx + x] = 1;
  };
  // sample density: longest edge / (cell/2), so consecutive samples are ≤ half a voxel apart.
  const eAB = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
  const eAC = Math.hypot(C.x - A.x, C.y - A.y, C.z - A.z);
  const eBC = Math.hypot(C.x - B.x, C.y - B.y, C.z - B.z);
  const longest = Math.max(eAB, eAC, eBC, 1e-9);
  const steps = Math.max(1, Math.ceil((longest * 2) / cell));
  // walk the triangle in barycentric coords (i over edge AB-direction, j over AC-direction).
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    for (let j = 0; j <= steps - i; j++) {
      const v = j / steps;
      const w = 1 - u - v;
      mark(A.x * w + B.x * u + C.x * v, A.y * w + B.y * u + C.y * v, A.z * w + B.z * u + C.z * v);
    }
  }
}

/** MORPHOLOGICAL CLOSE the solid set by radius `k`: dilate k rounds then erode k rounds. This
 *  fills THIN internal cavities (≤ ~2k voxels wide) WITHOUT changing the outer shape — exactly
 *  what re-solidifies a flat panel (a WALL) whose hollow interior the exterior flood leaked into
 *  through an open bottom/edge: the front-face and back-face shells, ≤2k apart, get welded into
 *  one solid slab. A WIDE gap (table legs, dozens of voxels apart) is far wider than 2k, so it
 *  stays OPEN — the close distinguishes a thin manufacturing cavity from a real gap by SCALE.
 *  Operates on a working copy so the dilation's growth is fully undone by the erosion except where
 *  it closed a pocket. k is kept small (2) so only genuinely-thin cavities are filled. */
function closeSolid(g: Grid, k: number): void {
  if (k <= 0) return;
  const N = g.nx * g.ny * g.nz, nx = g.nx, ny = g.ny, nz = g.nz;
  let cur = g.solid.slice();
  let next = new Uint8Array(N);
  const dilateStep = (src: Uint8Array, dst: Uint8Array): void => {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = z * ny * nx + y * nx + x;
      dst[i] = (src[i] ||
        (x > 0 && src[i - 1]) || (x < nx - 1 && src[i + 1]) ||
        (y > 0 && src[i - nx]) || (y < ny - 1 && src[i + nx]) ||
        (z > 0 && src[i - ny * nx]) || (z < nz - 1 && src[i + ny * nx])) ? 1 : 0;
    }
  };
  // erode = a solid voxel survives only if ALL 6 neighbours (clamped at the grid edge) are solid.
  const erodeStep = (src: Uint8Array, dst: Uint8Array): void => {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = z * ny * nx + y * nx + x;
      if (!src[i]) { dst[i] = 0; continue; }
      const keep = (x === 0 || src[i - 1]!) && (x === nx - 1 || src[i + 1]!) &&
        (y === 0 || src[i - nx]!) && (y === ny - 1 || src[i + nx]!) &&
        (z === 0 || src[i - ny * nx]!) && (z === nz - 1 || src[i + ny * nx]!);
      dst[i] = keep ? 1 : 0;
    }
  };
  for (let s = 0; s < k; s++) { dilateStep(cur, next); [cur, next] = [next, cur]; }
  for (let s = 0; s < k; s++) { erodeStep(cur, next); [cur, next] = [next, cur]; }
  let solidCount = 0;
  for (let i = 0; i < N; i++) { g.solid[i] = cur[i]!; if (cur[i]) solidCount++; }
  g.solidCount = solidCount;
}

/** One round of 6-neighbour dilation (grow the solid set outward by one voxel). */
function dilateOnce(g: Grid): void {
  const src = g.solid.slice();
  const at = (x: number, y: number, z: number) => src[z * g.ny * g.nx + y * g.nx + x]!;
  for (let z = 0; z < g.nz; z++) for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    if (at(x, y, z)) continue;
    if ((x > 0 && at(x - 1, y, z)) || (x < g.nx - 1 && at(x + 1, y, z)) ||
        (y > 0 && at(x, y - 1, z)) || (y < g.ny - 1 && at(x, y + 1, z)) ||
        (z > 0 && at(x, y, z - 1)) || (z < g.nz - 1 && at(x, y, z + 1))) {
      g.solid[z * g.ny * g.nx + y * g.nx + x] = 1;
      g.solidCount++;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. LOOSE-BOX cover over the solid grid — GROW+SHRINK relaxation, EDGE-WEIGHTED
//    emptiness, and NON-OVERLAPPING claimed-volume partitioning (Jacob's pass).
//
//    For each seed we RELAX a box: every face GROWS by one slab while the NEXT slab
//    (just beyond the edge) PASSES the edge criterion, and SHRINKS by one slab while
//    its CURRENT outermost slab FAILS it — repeating over all 6 faces until STABLE. Each
//    face then sits at the density transition (outer slab passes, next fails), so the box
//    HUGS the feature regardless of where the seed landed. This converges: grow only adds
//    passing slabs, shrink only drops failing ones, so a face can't oscillate. The criterion
//    is EDGE-WEIGHTED: a slab's rim voxels count more, so a face retracts the instant its
//    leading EDGE drifts off the solid (a feature ending) even while the slab centre is still
//    solid. The 6-face order is ROTATED/flipped each pass (de-biased) so no axis/direction is
//    systematically favoured → a mirrored mesh relaxes to a mirrored box. A box can't bridge a
//    real gap because there is no solid there to grow into — the §2 flood-the-exterior voxelizer
//    leaves the air between separate features EMPTY, so the edge-density brake stops the face.
//
//    NON-OVERLAP (default) is the SEPARATION lever: each placed box CLAIMS its whole AABB
//    volume; later boxes treat claimed voxels as empty (a slab containing any claimed
//    voxel can't be grown into), so boxes ABUT but never overlap → individual legs, the
//    stretcher in the gap between claimed legs, pillow/blanket each in their own box.
//
//    COVERAGE-FIRST SELECTION: each round prefers the box with the most NEWLY-COVERED solid
//    (scored coverage·(1+λ·fill), λ = coverageWeight), so a BIG tight feature (a whole cork, a
//    whole leg) is claimed before a small tight SLIVER — a sliver is ~100% fill but covers
//    almost nothing, so it can no longer out-score a real feature.
//
//    A SIZE-BASED stop governs the box count: a relaxed box is kept only if its longest
//    edge ≥ minBoxSize (no count cap). The loop ends when coverage is met or no unclaimed
//    solid voxel remains. Fixed seed/sample order + deterministic face rotation = deterministic.
//
//    SEED MODE (`seedMode`) chooses WHICH unclaimed-solid voxel(s) to grow from each round:
//      cluster (default) — interior peaks of the largest few blobs + alternates; relax each and
//                          keep the biggest-coverage box (pickClusterSeeds + coverage selection);
//      scan              — the unclaimed-solid voxel NEAREST the remaining-solid centroid
//                          (corner-debiased, mirror-symmetric);
//      random-best       — sample `samples` random voxels (SEEDED mulberry32, NOT Math.random,
//                          so footprints reproduce), relax a box from each, keep the best by the
//                          coverage-aware score (tie-break larger), with a SHALLOW 1-level treeing
//                          lookahead over the top-`beam` candidates. Deterministic for a fixed seed.
// ---------------------------------------------------------------------------
interface CoverOpts { edgeDensity: number; edgeWeight: number; nonOverlap: boolean; minFill: number; coverageTarget: number; maxBoxes: number; minBoxSize: number; seedMode: SeedMode; samples: number; beam: number; randomSeed: number; coverageWeight: number; }

function looseCover(g: Grid, o: CoverOpts): { boxes: AABB[]; stats: Omit<FitStats, 'cell' | 'solidVoxels'> } {
  const { nx, ny, nz, solid, solidCount } = g;
  const covered = new Uint8Array(solid.length); // solid voxels already claimed by a box (coverage stat)
  // CLAIMED tracks every voxel (solid OR empty) inside a placed box's AABB. Under nonOverlap
  // a later box may not grow into any claimed voxel, so the boxes partition the volume.
  const claimed = new Uint8Array(solid.length);
  const idx = (x: number, y: number, z: number) => z * ny * nx + y * nx + x;
  const maxXm = g.ox + nx * g.cell, maxYm = g.oy + ny * g.cell, maxZm = g.oz + nz * g.cell;

  // Placed boxes as GRID EXTENTS (inclusive), converted to metre AABBs at the end.
  type GBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  const gboxes: GBox[] = [];
  let coveredSolid = 0;

  // # solid voxels inside box [x0..x1]×[y0..y1]×[z0..z1] (inclusive).
  const solidIn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
    let s = 0;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const row = z * ny * nx + y * nx;
      for (let x = x0; x <= x1; x++) if (solid[row + x]) s++;
    }
    return s;
  };

  // EDGE-WEIGHTED slab density: a voxel on the slab RIM (outer ring of the slab's 2D
  // cross-section) weighs `edgeWeight`, an interior voxel weighs 1; a CLAIMED voxel reads
  // as EMPTY (weight still counts, solid contribution 0) so a box can't reclaim another's
  // volume. Returns weighted_density = Σ w·solid / Σ w over the slab, or -1 for an empty
  // slab (no voxels). `at` is the new index on `ax`; the slab spans the box's other two axes.
  const slabDensity = (ax: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, at: number): number => {
    let wSolid = 0, wTotal = 0;
    if (ax === 0) {
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
        const rim = (y === y0 || y === y1 || z === z0 || z === z1);
        const w = rim ? o.edgeWeight : 1;
        wTotal += w;
        const i = idx(at, y, z);
        if (solid[i] && !claimed[i]) wSolid += w;
      }
    } else if (ax === 1) {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const rim = (x === x0 || x === x1 || z === z0 || z === z1);
        const w = rim ? o.edgeWeight : 1;
        wTotal += w;
        const i = idx(x, at, z);
        if (solid[i] && !claimed[i]) wSolid += w;
      }
    } else {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const rim = (x === x0 || x === x1 || y === y0 || y === y1);
        const w = rim ? o.edgeWeight : 1;
        wTotal += w;
        const i = idx(x, y, at);
        if (solid[i] && !claimed[i]) wSolid += w;
      }
    }
    return wTotal > 0 ? wSolid / wTotal : -1;
  };
  // Does the slab at index `at` (on axis `ax`, over the box's other two spans) contain ANY
  // claimed voxel? Under nonOverlap such a slab is off-limits to growth.
  const slabHasClaimed = (ax: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, at: number): boolean => {
    if (ax === 0) { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) if (claimed[idx(at, y, z)]) return true; }
    else if (ax === 1) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (claimed[idx(x, at, z)]) return true; }
    else { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (claimed[idx(x, y, at)]) return true; }
    return false;
  };

  // CLUSTER-CENTERED SEEDS (coverage-first). Label the unclaimed-solid voxels into 6-connected
  // components (blobs); then return a SHORT LIST of candidate interior-peak seeds so the caller
  // can relax a box from each and place the BIGGEST-COVERAGE one. Candidates are: the L1
  // distance-transform PEAK of each of the largest few blobs (so a separate feature — a cork, a
  // detached leg — gets its own seed), PLUS a couple of alternate peaks WITHIN the single largest
  // blob that are spatially far from its primary peak (so an elongated/branchy blob can be hit
  // off-centre and yield a bigger-coverage relaxed box than the centre seed). Deterministic: BFS
  // in fixed z→y→x order, blobs ranked by (size desc, earliest start), peaks by (distance desc,
  // earliest scan index). Returns [] when no unclaimed-solid voxel remains. Scratch reused.
  const comp = new Int32Array(solid.length);   // component id per voxel (-1 = none this round)
  const bfsQ = new Int32Array(solid.length);    // BFS queue
  const blobIdx: number[] = [];                 // flat indices of the blob currently being peaked
  // distance-transform peaks of ONE blob (its voxels = `voxels`, scan-ordered): returns up to
  // `want` interior peaks, the global peak first then alternates ≥ minSep voxels away from any
  // already-chosen peak (Chebyshev-ish via L1), each a local max of the in-blob distance field.
  const blobPeaks = (voxels: number[], want: number, minSep: number): [number, number, number][] => {
    const BIG = nx + ny + nz + 2;
    const dist = new Int32Array(voxels.length);
    const pos = new Map<number, number>();
    for (let k = 0; k < voxels.length; k++) pos.set(voxels[k]!, k);
    const inBlob = (c: number) => pos.has(c);
    for (let k = 0; k < voxels.length; k++) {
      const c = voxels[k]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      let border = (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1);
      if (!border) {
        if (!inBlob(c - 1) || !inBlob(c + 1) || !inBlob(c - nx) || !inBlob(c + nx) || !inBlob(c - ny * nx) || !inBlob(c + ny * nx)) border = true;
      }
      let d = border ? 1 : BIG;
      if (x > 0)      { const p = pos.get(c - 1);       if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (y > 0)      { const p = pos.get(c - nx);      if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (z > 0)      { const p = pos.get(c - ny * nx); if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      dist[k] = d;
    }
    for (let k = voxels.length - 1; k >= 0; k--) {
      const c = voxels[k]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      let d = dist[k]!;
      if (x < nx - 1) { const p = pos.get(c + 1);       if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (y < ny - 1) { const p = pos.get(c + nx);      if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (z < nz - 1) { const p = pos.get(c + ny * nx); if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      dist[k] = d;
    }
    // greedily pick `want` peaks: highest distance first, each ≥ minSep (L1) from prior picks.
    const picks: [number, number, number][] = [];
    const order = [...voxels.keys()].sort((a, b) => (dist[b]! - dist[a]!) || (voxels[a]! - voxels[b]!));
    for (const k of order) {
      if (picks.length >= want) break;
      const c = voxels[k]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      let ok = true;
      for (const [px, py, pz] of picks) { if (Math.abs(px - x) + Math.abs(py - y) + Math.abs(pz - z) < minSep) { ok = false; break; } }
      if (ok) picks.push([x, y, z]);
    }
    if (picks.length === 0 && voxels.length > 0) {
      const c = voxels[0]!; const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      picks.push([x, y, z]);
    }
    return picks;
  };
  const pickClusterSeeds = (): [number, number, number][] => {
    comp.fill(-1);
    let nextId = 0;
    const blobs: { id: number; size: number; start: number }[] = [];
    for (let s = 0; s < solid.length; s++) {
      if (!solid[s] || claimed[s] || comp[s] !== -1) continue;
      const id = nextId++;
      let head = 0, tail = 0, size = 0;
      bfsQ[tail++] = s; comp[s] = id;
      while (head < tail) {
        const c = bfsQ[head++]!; size++;
        const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
        if (x > 0)      { const n = c - 1;         if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (x < nx - 1) { const n = c + 1;         if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (y > 0)      { const n = c - nx;        if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (y < ny - 1) { const n = c + nx;        if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (z > 0)      { const n = c - ny * nx;   if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (z < nz - 1) { const n = c + ny * nx;   if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
      }
      blobs.push({ id, size, start: s });
    }
    if (blobs.length === 0) return [];
    // rank blobs by size (desc), earliest start as tie-break.
    blobs.sort((a, b) => (b.size - a.size) || (a.start - b.start));
    const seeds: [number, number, number][] = [];
    // The largest few blobs each contribute their interior peak (a SEPARATE feature → own seed);
    // the single largest also contributes a couple of far-apart alternate peaks.
    // SEPARATE features get their own seed: the interior peak of each of the largest few blobs.
    // We deliberately take only ONE peak PER blob — alternate peaks WITHIN a blob were found to
    // seed off-centre in an elongated apron/leg region and relax to a WIDE box that merges two
    // legs across the (apron-bridged) gap, regressing the hand-made table from 5 boxes to 3.
    // One peak per blob keeps each box centred on a feature; coverage scoring across blobs (plus
    // the per-round greedy loop) still claims big features first, so the cork/medium-table wins
    // hold while the long table's legs stay individual.
    const NB = Math.min(4, blobs.length);
    for (let bi = 0; bi < NB; bi++) {
      const bid = blobs[bi]!.id;
      blobIdx.length = 0;
      for (let s = 0; s < solid.length; s++) if (comp[s] === bid) blobIdx.push(s);
      for (const p of blobPeaks(blobIdx, 1, 0)) seeds.push(p);
    }
    return seeds;
  };

  // Relax ONE box from a seed voxel: grow+shrink each face to the density transition.
  // Returns the stabilised box, or null if it relaxed to empty (caller reseeds).
  const relax = (sx: number, sy: number, sz: number): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null => {
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy, z0 = sz, z1 = sz;

    // GROW face (ax,dir) by one slab iff the NEXT slab passes (edge-weighted ≥ edgeDensity,
    // not all-claimed under nonOverlap, and the optional global minFill backstop holds).
    const tryGrow = (ax: number, dir: number): boolean => {
      let at: number;
      if (ax === 0) { at = dir < 0 ? x0 - 1 : x1 + 1; if (at < 0 || at >= nx) return false; }
      else if (ax === 1) { at = dir < 0 ? y0 - 1 : y1 + 1; if (at < 0 || at >= ny) return false; }
      else { at = dir < 0 ? z0 - 1 : z1 + 1; if (at < 0 || at >= nz) return false; }
      if (o.nonOverlap && slabHasClaimed(ax, x0, y0, z0, x1, y1, z1, at)) return false; // can't enter claimed volume
      const d = slabDensity(ax, x0, y0, z0, x1, y1, z1, at);
      if (d < o.edgeDensity) return false; // PRIMARY brake: edge-weighted boundary-slab density
      if (o.minFill > 0) { // optional global fill backstop
        const slabCount = ax === 0 ? (y1 - y0 + 1) * (z1 - z0 + 1) : ax === 1 ? (x1 - x0 + 1) * (z1 - z0 + 1) : (x1 - x0 + 1) * (y1 - y0 + 1);
        const cur = solidIn(x0, y0, z0, x1, y1, z1), vox = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
        if (cur + Math.round(d * slabCount) < (vox + slabCount) * o.minFill) return false;
      }
      if (ax === 0) { if (dir < 0) x0 = at; else x1 = at; }
      else if (ax === 1) { if (dir < 0) y0 = at; else y1 = at; }
      else { if (dir < 0) z0 = at; else z1 = at; }
      return true;
    };

    // SHRINK face (ax,dir) by one slab iff its CURRENT outermost slab FAILS the criterion.
    // Never shrink below 1 slab on an axis. (claimed voxels read empty, so a slab that
    // strayed onto another box's volume fails and is retracted.)
    const tryShrink = (ax: number, dir: number): boolean => {
      let at: number;
      if (ax === 0) { if (x1 - x0 < 1) return false; at = dir < 0 ? x0 : x1; }
      else if (ax === 1) { if (y1 - y0 < 1) return false; at = dir < 0 ? y0 : y1; }
      else { if (z1 - z0 < 1) return false; at = dir < 0 ? z0 : z1; }
      // edge-weighted density of the box's CURRENT outermost slab on this axis at `at`.
      const d = slabDensity(ax, x0, y0, z0, x1, y1, z1, at);
      if (d >= o.edgeDensity) return false; // outermost slab still passes — keep it
      if (ax === 0) { if (dir < 0) x0 = at + 1; else x1 = at - 1; }
      else if (ax === 1) { if (dir < 0) y0 = at + 1; else y1 = at - 1; }
      else { if (dir < 0) z0 = at + 1; else z1 = at - 1; }
      return true;
    };

    // Relax until STABLE: full passes over the 6 faces that neither grow nor shrink.
    // DE-BIASED ORDER: the old fixed X-,X+,Y-,Y+,Z-,Z+ sweep systematically favoured the
    // earlier-touched faces (a feature touched first by X- could grab a slab before Z+ got a
    // turn), giving lopsided/mirror-asymmetric fits. Instead we ROTATE the 6-face order every
    // pass (cyclic shift) AND flip the +/- direction priority on alternate passes, so over a
    // few passes no axis or direction is consistently first → a mirrored mesh relaxes to a
    // mirrored box. Still deterministic (the rotation is driven only by the pass counter).
    const FACES: [number, number][] = [[0, -1], [0, +1], [1, -1], [1, +1], [2, -1], [2, +1]];
    let changed = true, guard = 0, pass = 0;
    const guardMax = (nx + ny + nz) * 2 + 8;
    while (changed && guard++ < guardMax) {
      changed = false;
      const off = pass % 6;            // cyclic start-face rotation
      const flip = (pass & 1) === 1;   // alternate which direction of each axis goes first
      for (let i = 0; i < 6; i++) {
        let [ax, dir] = FACES[(i + off) % 6]!;
        if (flip) dir = -dir;          // on flip passes prefer the opposite face of the axis
        if (tryGrow(ax, dir)) changed = true; else if (tryShrink(ax, dir)) changed = true;
      }
      pass++;
    }

    // discard a box that relaxed to no solid (e.g. the seed was a lone speck the shrink ate).
    if (solidIn(x0, y0, z0, x1, y1, z1) === 0) return null;
    return { x0, y0, z0, x1, y1, z1 };
  };

  type RBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  // FILL% of a relaxed box: solid voxels / total voxels (1 = all solid). Higher fill = a box
  // that swallowed less empty space, hugging the feature.
  const boxFill = (b: RBox): number => {
    const vox = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
    return vox > 0 ? solidIn(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1) / vox : 0;
  };
  // box SIZE (longest edge in voxels) — the fill tie-breaker (prefer the larger box).
  const boxSpan = (b: RBox): number => Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
  // NEW COVERAGE of a relaxed box: how many SOLID voxels it would claim that aren't covered yet.
  // This is the heart of the coverage-aware selection — a big tight box (a whole cork, a leg)
  // has high new-coverage; a sliver has ~zero. Counts only solid AND not-yet-covered voxels.
  const boxNewCoverage = (b: RBox): number => {
    let s = 0;
    for (let z = b.z0; z <= b.z1; z++) for (let y = b.y0; y <= b.y1; y++) {
      const row = z * ny * nx + y * nx;
      for (let x = b.x0; x <= b.x1; x++) { const i = row + x; if (solid[i] && !covered[i]) s++; }
    }
    return s;
  };
  // COVERAGE-AWARE SELECTION SCORE: coverage · (1 + λ·fill). Coverage (newly-claimed solid)
  // is the dominant term so a BIG tight box beats a small tight SLIVER (the sliver covers little
  // even at ~100% fill); fill (λ = o.coverageWeight) only sharpens the choice between boxes of
  // similar coverage, preferring the tighter one. A box covering nothing scores 0 → never chosen
  // over a real one. This replaces the old fill-first objective that rewarded slivers.
  const boxScore = (b: RBox): number => {
    const cov = boxNewCoverage(b);
    if (cov === 0) return 0;
    return cov * (1 + o.coverageWeight * boxFill(b));
  };

  // SCAN seed (DE-BIASED): the old "first unclaimed-solid voxel in z→y→x order" always seeded the
  // MIN CORNER, biasing every scan box toward -x/-y/-z (and breaking mirror symmetry). Instead we
  // seed the unclaimed-solid voxel NEAREST the CENTROID of all remaining unclaimed-solid voxels —
  // a corner-neutral, mirror-symmetric starting point. Ties broken by earliest scan index for
  // determinism. Returns null when none remain.
  const pickScanSeed = (): [number, number, number] | null => {
    let sumX = 0, sumY = 0, sumZ = 0, cnt = 0;
    for (let s = 0; s < solid.length; s++) {
      if (!solid[s] || claimed[s]) continue;
      const z = (s / (ny * nx)) | 0, y = ((s - z * ny * nx) / nx) | 0, x = s - z * ny * nx - y * nx;
      sumX += x; sumY += y; sumZ += z; cnt++;
    }
    if (cnt === 0) return null;
    const cx = sumX / cnt, cy = sumY / cnt, cz = sumZ / cnt;
    let bestD = Infinity, bx = 0, by = 0, bz = 0;
    for (let s = 0; s < solid.length; s++) {
      if (!solid[s] || claimed[s]) continue;
      const z = (s / (ny * nx)) | 0, y = ((s - z * ny * nx) / nx) | 0, x = s - z * ny * nx - y * nx;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz);
      if (d < bestD - 1e-9) { bestD = d; bx = x; by = y; bz = z; }
    }
    return [bx, by, bz];
  };

  // ---- random-best machinery (SEEDED PRNG — reproducible, footprints get baked) ----
  // One PRNG for the whole cover so the sample sequence is fixed for a given mesh+seed.
  const rng = mulberry32(o.randomSeed >>> 0);
  // Collect every currently-unclaimed-solid voxel flat index (rebuilt each round since
  // claiming shrinks the pool). Returns the list so we can sample WITHOUT replacement.
  const collectUnclaimed = (): number[] => {
    const pool: number[] = [];
    for (let s = 0; s < solid.length; s++) if (solid[s] && !claimed[s]) pool.push(s);
    return pool;
  };
  // Relax a box from up to `samples` DISTINCT random voxels of `pool`; return the best box by the
  // COVERAGE-AWARE score (coverage·(1+λ·fill), tie-break larger span), or null if none relaxed to
  // solid. Coverage dominance is what makes a big tight feature beat a tight sliver.
  // Sampling is Fisher–Yates partial-shuffle on the pool index (seeded) — distinct picks.
  const bestSampledBox = (pool: number[]): { box: RBox; score: number; span: number } | null => {
    const n = pool.length;
    if (n === 0) return null;
    const k = Math.min(o.samples, n);
    // partial shuffle: pick k distinct positions from the front. Mutates a scratch copy so
    // the caller's pool order is preserved for the lookahead's own (independent) sampling.
    const scratch = pool.slice();
    let best: { box: RBox; score: number; span: number } | null = null;
    for (let i = 0; i < k; i++) {
      const j = i + ((rng() * (n - i)) | 0);
      const tmp = scratch[i]!; scratch[i] = scratch[j]!; scratch[j] = tmp;
      const c = scratch[i]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      const r = relax(x, y, z);
      if (!r) continue;
      const score = boxScore(r), span = boxSpan(r);
      // strictly-better score, or equal score with a larger span — keep it.
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && span > best.span)) {
        best = { box: r, score, span };
      }
    }
    return best;
  };
  // Claim a box's AABB into `claimed` (mutates) — used both to place a box for real and to
  // PROVISIONALLY claim a branch during the shallow lookahead (then rolled back).
  const claimBox = (b: RBox, into: Uint8Array): void => {
    for (let z = b.z0; z <= b.z1; z++) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) into[idx(x, y, z)] = 1;
  };

  // ROUND of random-best WITH SHALLOW TREEING: take the top-B candidate boxes from this round's
  // samples as branches (ranked by the COVERAGE-AWARE score so a big feature outranks a sliver);
  // for each branch provisionally claim it, run ONE more best-score lookahead box on the remaining
  // volume, and score the branch by the 2-box COMBINED coverage-score (branch + lookahead). Place
  // the best branch's box. SHALLOW (1 level) per Jacob. B=1 short-circuits to pure greedy.
  const randomBestRound = (): RBox | null => {
    const pool = collectUnclaimed();
    if (pool.length === 0) return null;
    // gather the top-B distinct candidate boxes by (coverage-score desc, span desc) from one sample set.
    const branches: { box: RBox; score: number; span: number }[] = [];
    {
      const n = pool.length, k = Math.min(o.samples, n), scratch = pool.slice();
      for (let i = 0; i < k; i++) {
        const j = i + ((rng() * (n - i)) | 0);
        const tmp = scratch[i]!; scratch[i] = scratch[j]!; scratch[j] = tmp;
        const c = scratch[i]!;
        const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
        const r = relax(x, y, z);
        if (!r) continue;
        branches.push({ box: r, score: boxScore(r), span: boxSpan(r) });
      }
    }
    if (branches.length === 0) return null;
    branches.sort((a, b) => (b.score - a.score) || (b.span - a.span));
    const B = Math.max(1, o.beam);
    if (B === 1 || branches.length === 1) return branches[0]!.box; // pure greedy, no lookahead

    let bestBranch: RBox | null = null, bestScore = -1;
    const topB = branches.slice(0, B);
    for (const br of topB) {
      // provisionally claim this branch, sample ONE lookahead box on what remains, score the
      // pair, then ROLL BACK the provisional claim. (Shallow: exactly one level deep.)
      claimBox(br.box, claimed);
      const look = bestSampledBox(collectUnclaimed());
      // restore: clear only THIS branch's voxels (nothing else touched `claimed`).
      for (let z = br.box.z0; z <= br.box.z1; z++) for (let y = br.box.y0; y <= br.box.y1; y++) for (let x = br.box.x0; x <= br.box.x1; x++) claimed[idx(x, y, z)] = 0;
      const score = br.score + (look ? look.score : 0); // combined 2-box coverage-score
      if (score > bestScore + 1e-9) { bestScore = score; bestBranch = br.box; }
    }
    return bestBranch ?? topB[0]!.box;
  };

  // Pick the next box for the configured mode. `random-best` samples internally. `scan` relaxes
  // its single corner-debiased seed. `cluster` is now COVERAGE-FIRST: it relaxes a box from each
  // candidate interior peak (largest few blobs + alternates) and returns the BIGGEST-COVERAGE
  // box (coverage·(1+λ·fill)), so a big feature (cork, whole leg) is claimed before slivers.
  // Returns null when no unclaimed-solid voxel remains; a `dead` marker box when a seed relaxed
  // to nothing (already claimed so we don't spin).
  const nextBox = (): RBox | null => {
    if (o.seedMode === 'random-best') return randomBestRound();
    if (o.seedMode === 'scan') {
      const seed = pickScanSeed();
      if (!seed) return null;
      const r = relax(seed[0], seed[1], seed[2]);
      if (!r) { const i = idx(seed[0], seed[1], seed[2]); claimed[i] = 1; covered[i] = 1; return { x0: seed[0], y0: seed[1], z0: seed[2], x1: seed[0], y1: seed[1], z1: seed[2], dead: true } as RBox & { dead: true }; }
      return r;
    }
    // cluster: relax each candidate seed, keep the highest coverage-score box.
    const seeds = pickClusterSeeds();
    if (seeds.length === 0) return null;
    let best: RBox | null = null, bestScore = -1;
    for (const [sx, sy, sz] of seeds) {
      const r = relax(sx, sy, sz);
      if (!r) continue;
      const sc = boxScore(r);
      if (sc > bestScore + 1e-9 || (Math.abs(sc - bestScore) <= 1e-9 && best && boxSpan(r) > boxSpan(best))) { bestScore = sc; best = r; }
    }
    if (!best) { // every candidate relaxed to nothing — claim the first seed so we don't loop.
      const [sx, sy, sz] = seeds[0]!; const i = idx(sx, sy, sz); claimed[i] = 1; covered[i] = 1;
      return { x0: sx, y0: sy, z0: sz, x1: sx, y1: sy, z1: sz, dead: true } as RBox & { dead: true };
    }
    return best;
  };

  // Seed loop — SIZE-DRIVEN. Each round picks the next box per `seedMode` (cluster interior
  // peak / scan order / random-best sampling), CLAIMS it (so its volume isn't re-seeded and
  // the loop terminates), then KEEPS it only if its longest edge ≥ minBoxSize. The box COUNT
  // auto-adapts to the mesh, governed by an absolute size floor rather than a count cap.
  // `maxBoxes` is only a far backstop. We stop when coverage is met or nothing unclaimed remains.
  while (coveredSolid < solidCount * o.coverageTarget && gboxes.length < o.maxBoxes) {
    const r = nextBox();
    if (!r) break;
    if ((r as RBox & { dead?: boolean }).dead) continue; // seed relaxed to nothing — already claimed
    const { x0, y0, z0, x1, y1, z1 } = r;

    // CLAIM the box's whole AABB (every voxel, solid or empty) under nonOverlap, so the
    // next box can't grow into it. Always mark its SOLID voxels covered (coverage stat).
    const before = coveredSolid;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = idx(x, y, z);
      claimed[i] = 1;
      if (solid[i] && !covered[i]) { covered[i] = 1; coveredSolid++; }
    }
    const gained = coveredSolid - before;
    // a box claiming no NEW solid voxels is useless — claim a corner voxel so we don't spin.
    if (gained === 0) { const i = idx(x0, y0, z0); claimed[i] = 1; covered[i] = 1; continue; }

    // SIZE-BASED STOP: only KEEP boxes whose longest edge clears the absolute floor (in
    // metres). A sub-threshold box is still claimed (above) so its sliver volume won't be
    // re-seeded — the box COUNT auto-adapts to the mesh, governed by size not a count cap.
    const sxm = (x1 - x0 + 1) * g.cell, sym = (y1 - y0 + 1) * g.cell, szm = (z1 - z0 + 1) * g.cell;
    if (Math.max(sxm, sym, szm) >= o.minBoxSize) {
      gboxes.push({ x0, y0, z0, x1, y1, z1 });
    }
  }

  // convert to object-local AABBs, clamped to the true mesh bound so the outward rounding /
  // loose padding never sticks out past the model. Accumulate the union fill stat.
  const boxes: AABB[] = [];
  let unionSolid = 0, unionVoxels = 0;
  for (const bx of gboxes) {
    boxes.push({
      min: [g.ox + bx.x0 * g.cell, g.oy + bx.y0 * g.cell, g.oz + bx.z0 * g.cell],
      max: [Math.min(maxXm, g.ox + (bx.x1 + 1) * g.cell), Math.min(maxYm, g.oy + (bx.y1 + 1) * g.cell), Math.min(maxZm, g.oz + (bx.z1 + 1) * g.cell)],
    });
    unionSolid += solidIn(bx.x0, bx.y0, bx.z0, bx.x1, bx.y1, bx.z1);
    unionVoxels += (bx.x1 - bx.x0 + 1) * (bx.y1 - bx.y0 + 1) * (bx.z1 - bx.z0 + 1);
  }

  const coverage = solidCount > 0 ? coveredSolid / solidCount : 1;
  const fill = unionVoxels > 0 ? unionSolid / unionVoxels : 1;
  return { boxes, stats: { coverage, fill, boxCount: boxes.length } };
}

// ---------------------------------------------------------------------------
// 4. Export to sim-ready constants (the boxes become fixed-point later).
// ---------------------------------------------------------------------------
/**
 * Render boxes as a `fromFloatConst(...)`-ready string: one `{ min, max }` literal
 * per box with numbers rounded to mm. Drop-in for later sim wiring (the caller wraps
 * each scalar in fromFloatConst to bake the fixed-point constant).
 */
export function boxesToConsts(boxes: AABB[]): string {
  const f = (n: number) => `fromFloatConst(${n.toFixed(3)})`;
  const lines = boxes.map((b) =>
    `  { min: [${f(b.min[0])}, ${f(b.min[1])}, ${f(b.min[2])}], ` +
    `max: [${f(b.max[0])}, ${f(b.max[1])}, ${f(b.max[2])}] },`,
  );
  return `[\n${lines.join('\n')}\n]`;
}

/** Convert AABBs (min/max) → FootprintBox (centre + half-extent), the WorldObject form. */
export function aabbToFootprintBox(b: AABB): { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number } {
  return {
    cx: (b.min[0] + b.max[0]) / 2, cy: (b.min[1] + b.max[1]) / 2, cz: (b.min[2] + b.max[2]) / 2,
    hx: (b.max[0] - b.min[0]) / 2, hy: (b.max[1] - b.min[1]) / 2, hz: (b.max[2] - b.min[2]) / 2,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
