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
//    a barrel even though its model is an open-topped tube. So we fill the SOLID
//    ENVELOPE (the span between the outermost surface crossings) per scan-row, not
//    the thin wall shells a naive parity fill leaves — that's what made the old boxes
//    explode into a loose cage.
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
// ROBUST INSIDE-TEST (handles non-watertight KayKit parts): we scan along ALL THREE
// axes and a voxel is SOLID where the X-, Y- and Z-envelopes carry a MAJORITY vote
// (≥2 of 3 agree). The majority carves hollows back out (a table's underside reads as
// 0-1 votes → stays open → legs, not a solid block) while a single stray crossing on
// one axis can't make a voxel solid. ≥2 (not ≥3) is deliberate: a THIN feature — a
// 0.1u tabletop — sits between voxel centres on the two horizontal scans, so only the
// vertical ray reliably hits it; requiring all 3 would erase the whole top. Erring
// slightly bigger is safe for collision, so the envelope rounds OUTWARD.
//
// DETERMINISM: this runs OFFLINE / at lab-load (FLOATS ARE FINE here — docs say so).
// Only the RESULTING boxes would later become fixed-point sim constants (boxesToConsts).
// The scan order is fixed (axis 0→2 voxelize, then z→y→x seed, then a fixed
// face-grow order X-,X+,Y-,Y+,Z-,Z+), so same mesh → same boxes. NO Math.random.
// ============================================================================

import * as THREE from 'three';

/** An axis-aligned box in object-local metres: inclusive corners. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

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
   *  grows over the groove). Default 0.5. Raise toward 1.0 to hug tighter (more, smaller
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
}

// GLOBAL DEFAULTS — tuned to give good footprints on ANY mesh with ZERO per-object knobs.
// `cell` is left undefined so it derives RELATIVE to the object (bbox-diag / cellDivisor).
// cellDivisor is the EXPERIMENTAL 4× granularity (26 → 104): 4× finer voxels per axis.
// cellMin shrinks ×4 too so the absolute floor doesn't clamp the finer cell back up.
const DEFAULTS = {
  cellDivisor: 104,
  cellMin: 0.01,
  cellMax: 0.16,
  edgeDensity: 0.5,
  edgeWeight: 1.5,
  nonOverlap: true,
  minFill: 0,
  coverageTarget: 0.93,
  maxBoxes: 24,
  minBoxSize: 0.14,
  dilate: 0,
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
  // far backstop — size, not count, is the normal terminator.
  let cell = opts.cell ?? autoCell;
  for (let attempt = 0; attempt < 9; attempt++) {
    const grid = voxelize(soup, cell, dilate);
    if (grid && grid.solidCount > 0) {
      const res = looseCover(grid, { edgeDensity, edgeWeight, nonOverlap, minFill, coverageTarget, maxBoxes, minBoxSize });
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

// ---------------------------------------------------------------------------
// 1. Bake every Mesh under `object` into one object-local triangle soup.
// ---------------------------------------------------------------------------
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
  return { tris: new Float32Array(out), count: out.length / 9, box };
}

// ---------------------------------------------------------------------------
// 2. SOLID voxelize: a voxel is solid where a MAJORITY of the X-, Y-, Z-axis solid
//    envelopes agree (≥2 of 3 votes). Tight to the surface, robust to leaky parts.
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

/** The two grid-axis indices that are NOT `axis` (axis 0→[1,2], 1→[0,2], 2→[0,1]). */
function otherAxes(axis: number): [number, number] {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

/** Voxelize; returns null if the grid would be unreasonably large (caller coarsens). */
function voxelize(soup: TriSoup, cell: number, dilate: number): Grid | null {
  const b = soup.box;
  const O = [b.min.x, b.min.y, b.min.z];
  const nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / cell));
  const ny = Math.max(1, Math.ceil((b.max.y - b.min.y) / cell));
  const nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / cell));
  if (nx * ny * nz > 4_000_000) return null; // too fine for this object — coarsen
  const dims = [nx, ny, nz];

  // votes[i] counts how many of the 3 axis-envelopes mark this voxel solid (0..3).
  const votes = new Uint8Array(nx * ny * nz);
  const xs: number[] = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const cell3 = [cell, cell, cell];
  const ijk = [0, 0, 0]; // scratch voxel index per scan

  for (let axis = 0; axis < 3; axis++) {
    const [o0, o1] = otherAxes(axis);
    const na = dims[o0]!, nb = dims[o1]!;
    for (let ia = 0; ia < na; ia++) {
      const ca = O[o0]! + (ia + 0.5) * cell3[o0]!;
      for (let ib = 0; ib < nb; ib++) {
        const cb = O[o1]! + (ib + 0.5) * cell3[o1]!;
        xs.length = 0;
        for (let t = 0; t < soup.count; t++) {
          const o = t * 9;
          A.set(soup.tris[o]!, soup.tris[o + 1]!, soup.tris[o + 2]!);
          B.set(soup.tris[o + 3]!, soup.tris[o + 4]!, soup.tris[o + 5]!);
          C.set(soup.tris[o + 6]!, soup.tris[o + 7]!, soup.tris[o + 8]!);
          const h = rayHitAxis(axis, o0, o1, ca, cb, A, B, C);
          if (h !== null) xs.push(h);
        }
        if (xs.length < 2) continue;
        xs.sort((p, q) => p - q);
        // SOLID ENVELOPE: fill the span between the OUTERMOST crossings (treat the
        // part as a solid obstacle along this axis). Round OUTWARD (err bigger).
        const lo = xs[0]!, hi = xs[xs.length - 1]!;
        const v0 = clamp(Math.floor((lo - O[axis]!) / cell), 0, dims[axis]! - 1);
        const v1 = clamp(Math.ceil((hi - O[axis]!) / cell) - 1, 0, dims[axis]! - 1);
        ijk[o0] = ia; ijk[o1] = ib;
        for (let k = v0; k <= v1; k++) {
          ijk[axis] = k;
          votes[ijk[2]! * ny * nx + ijk[1]! * nx + ijk[0]!]!++;
        }
      }
    }
  }

  // SOLID = a MAJORITY of the envelopes (≥2 of 3 axes agree). Carves hollows out (the
  // table underside scores 0-1 → stays open → legs) while a thin slab that only the
  // vertical scan reliably hits still survives (2 votes once a horizontal scan grazes
  // it). A single stray crossing (1 vote) never becomes solid.
  const solid = new Uint8Array(nx * ny * nz);
  let solidCount = 0;
  for (let i = 0; i < votes.length; i++) {
    if (votes[i]! >= 2) { solid[i] = 1; solidCount++; }
  }
  const grid: Grid = { nx, ny, nz, cell, ox: O[0]!, oy: O[1]!, oz: O[2]!, solid, solidCount };
  for (let i = 0; i < dilate; i++) dilateOnce(grid);
  return grid;
}

/** Ray (along +`axis`, from -inf) vs triangle → the axis-coordinate of the hit, or null. */
function rayHitAxis(axis: number, o0: number, o1: number, ca: number, cb: number, A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3): number | null {
  const BIG = 1e6;
  // direction = +axis
  const dx = axis === 0 ? 1 : 0, dy = axis === 1 ? 1 : 0, dz = axis === 2 ? 1 : 0;
  // origin: non-axis coords = (ca on o0, cb on o1); axis coord = -BIG
  const org = [0, 0, 0];
  org[axis] = -BIG; org[o0] = ca; org[o1] = cb;
  // Möller–Trumbore
  const e1x = B.x - A.x, e1y = B.y - A.y, e1z = B.z - A.z;
  const e2x = C.x - A.x, e2y = C.y - A.y, e2z = C.z - A.z;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tvx = org[0]! - A.x, tvy = org[1]! - A.y, tvz = org[2]! - A.z;
  const u = (tvx * px + tvy * py + tvz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = tvy * e1z - tvz * e1y, qy = tvz * e1x - tvx * e1z, qz = tvx * e1y - tvy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return -BIG + tt; // axis coordinate of the hit
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
//    its CURRENT outermost slab FAILS it — repeating over all 6 faces in a fixed order
//    until STABLE. Each face then sits at the density transition (outer slab passes,
//    next fails), so the box HUGS the feature regardless of where the seed landed. This
//    converges: grow only adds passing slabs, shrink only drops failing ones, so a face
//    can't oscillate. The criterion is EDGE-WEIGHTED: a slab's rim voxels count more, so
//    a face retracts the instant its leading EDGE drifts off the solid (a feature ending)
//    even while the slab centre is still solid.
//
//    NON-OVERLAP (default) is the SEPARATION lever: each placed box CLAIMS its whole AABB
//    volume; later boxes treat claimed voxels as empty (a slab containing any claimed
//    voxel can't be grown into), so boxes ABUT but never overlap → individual legs, the
//    stretcher in the gap between claimed legs, pillow/blanket each in their own box.
//    Seeds are taken in z→y→x SCAN ORDER (the first unclaimed solid voxel each round).
//
//    A SIZE-BASED stop governs the box count: a relaxed box is kept only if its longest
//    edge ≥ minBoxSize (no count cap). The loop ends when coverage is met or no unclaimed
//    solid voxel remains. Fixed seed order + fixed face order = deterministic. NO Math.random.
// ---------------------------------------------------------------------------
interface CoverOpts { edgeDensity: number; edgeWeight: number; nonOverlap: boolean; minFill: number; coverageTarget: number; maxBoxes: number; minBoxSize: number; }

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

  // CLUSTER-CENTERED SEED. Instead of "first unclaimed-solid voxel in scan order", label the
  // unclaimed-solid voxels into 6-connected components (blobs), pick the LARGEST blob, and seed
  // at its MOST-INTERIOR voxel (the L1 distance-transform PEAK within the blob — furthest from
  // any non-blob voxel). So a box starts centred on a feature and grows/shrinks symmetrically
  // outward. Deterministic: BFS in fixed z→y→x order, blob chosen by (size desc, then first
  // scan index), peak chosen by (distance desc, then first scan index). Returns null when no
  // unclaimed-solid voxel remains. Scratch arrays are reused across rounds.
  const comp = new Int32Array(solid.length);   // component id per voxel (-1 = none this round)
  const bfsQ = new Int32Array(solid.length);    // BFS queue
  const blobIdx: number[] = [];                 // flat indices of the current largest blob
  const pickClusterSeed = (): [number, number, number] | null => {
    comp.fill(-1);
    let bestSize = -1, bestStart = -1, nextId = 0;
    // first pass: flood every unclaimed-solid blob, track the largest (size, then earliest start)
    for (let s = 0; s < solid.length; s++) {
      if (!solid[s] || claimed[s] || comp[s] !== -1) continue;
      const id = nextId++;
      let head = 0, tail = 0, size = 0;
      bfsQ[tail++] = s; comp[s] = id;
      while (head < tail) {
        const c = bfsQ[head++]!; size++;
        const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
        // 6-neighbours
        if (x > 0)      { const n = c - 1;         if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (x < nx - 1) { const n = c + 1;         if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (y > 0)      { const n = c - nx;        if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (y < ny - 1) { const n = c + nx;        if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (z > 0)      { const n = c - ny * nx;   if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
        if (z < nz - 1) { const n = c + ny * nx;   if (solid[n] && !claimed[n] && comp[n] === -1) { comp[n] = id; bfsQ[tail++] = n; } }
      }
      if (size > bestSize) { bestSize = size; bestStart = s; }
    }
    if (bestSize < 0) return null;
    const bestId = comp[bestStart]!;
    // collect the largest blob's voxels in scan order
    blobIdx.length = 0;
    for (let s = 0; s < solid.length; s++) if (comp[s] === bestId) blobIdx.push(s);
    // L1 distance transform WITHIN the blob: distance to the nearest non-blob voxel. Two-pass
    // chamfer over the blob's voxels (scan order then reverse) seeded so border voxels start
    // at 1 (a neighbour outside the blob is distance-0). The PEAK is the most-interior voxel.
    const BIG = nx + ny + nz + 2;
    const dist = new Int32Array(blobIdx.length);
    const pos = new Map<number, number>(); // flat index -> position in blobIdx
    for (let k = 0; k < blobIdx.length; k++) pos.set(blobIdx[k]!, k);
    const inBlob = (c: number) => pos.has(c);
    // forward pass
    for (let k = 0; k < blobIdx.length; k++) {
      const c = blobIdx[k]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      // a voxel on the grid edge, or with any 6-neighbour outside the blob, is a border (dist 1)
      let border = (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1);
      if (!border) {
        if (!inBlob(c - 1) || !inBlob(c + 1) || !inBlob(c - nx) || !inBlob(c + nx) || !inBlob(c - ny * nx) || !inBlob(c + ny * nx)) border = true;
      }
      let d = border ? 1 : BIG;
      // chamfer from already-processed lower neighbours (-x,-y,-z)
      if (x > 0)      { const p = pos.get(c - 1);       if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (y > 0)      { const p = pos.get(c - nx);      if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (z > 0)      { const p = pos.get(c - ny * nx); if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      dist[k] = d;
    }
    // backward pass
    for (let k = blobIdx.length - 1; k >= 0; k--) {
      const c = blobIdx[k]!;
      const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
      let d = dist[k]!;
      if (x < nx - 1) { const p = pos.get(c + 1);       if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (y < ny - 1) { const p = pos.get(c + nx);      if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      if (z < nz - 1) { const p = pos.get(c + ny * nx); if (p !== undefined) d = Math.min(d, dist[p]! + 1); }
      dist[k] = d;
    }
    // PEAK = max distance, ties broken by earliest scan index (blobIdx is already scan-ordered).
    let bestD = -1, bestK = 0;
    for (let k = 0; k < blobIdx.length; k++) if (dist[k]! > bestD) { bestD = dist[k]!; bestK = k; }
    const c = blobIdx[bestK]!;
    const z = (c / (ny * nx)) | 0, y = ((c - z * ny * nx) / nx) | 0, x = c - z * ny * nx - y * nx;
    return [x, y, z];
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

    // Relax until STABLE: a full pass over the 6 faces that neither grows nor shrinks.
    // Bounded iteration count (can't exceed the grid span) guarantees termination.
    let changed = true, guard = 0;
    const guardMax = (nx + ny + nz) * 2 + 8;
    while (changed && guard++ < guardMax) {
      changed = false;
      // fixed face order: X-,X+,Y-,Y+,Z-,Z+. Try grow then shrink on each.
      if (tryGrow(0, -1)) changed = true; else if (tryShrink(0, -1)) changed = true;
      if (tryGrow(0, +1)) changed = true; else if (tryShrink(0, +1)) changed = true;
      if (tryGrow(1, -1)) changed = true; else if (tryShrink(1, -1)) changed = true;
      if (tryGrow(1, +1)) changed = true; else if (tryShrink(1, +1)) changed = true;
      if (tryGrow(2, -1)) changed = true; else if (tryShrink(2, -1)) changed = true;
      if (tryGrow(2, +1)) changed = true; else if (tryShrink(2, +1)) changed = true;
    }

    // discard a box that relaxed to no solid (e.g. the seed was a lone speck the shrink ate).
    if (solidIn(x0, y0, z0, x1, y1, z1) === 0) return null;
    return { x0, y0, z0, x1, y1, z1 };
  };

  // Seed loop — SIZE-DRIVEN, CLUSTER-CENTERED seeding. Each round we seed at the interior peak
  // of the LARGEST remaining blob of unclaimed-solid voxels (pickClusterSeed), then RELAX a box
  // from it, then KEEP it only if its longest edge ≥ minBoxSize. A relaxed box is always CLAIMED
  // (so its volume isn't re-seeded and the loop terminates) even if it is below the floor — so
  // the box COUNT auto-adapts to the mesh, governed by an absolute size floor rather than a
  // count cap. `maxBoxes` is only a far backstop. We stop when coverage is met or no unclaimed
  // solid voxel remains.
  while (coveredSolid < solidCount * o.coverageTarget && gboxes.length < o.maxBoxes) {
    const seed = pickClusterSeed();
    if (!seed) break;
    const [sx, sy, sz] = seed;

    const r = relax(sx, sy, sz);
    if (!r) {
      // box vanished — claim the seed so we don't loop on it forever.
      claimed[idx(sx, sy, sz)] = 1; covered[idx(sx, sy, sz)] = 1;
      continue;
    }
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
    // a box claiming no NEW solid voxels is useless — claim its seed and move on.
    if (gained === 0) { claimed[idx(sx, sy, sz)] = 1; covered[idx(sx, sy, sz)] = 1; continue; }

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
