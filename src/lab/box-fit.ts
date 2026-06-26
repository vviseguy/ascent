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
  /** Voxel edge length (object-local metres). Smaller = tighter fit, more cost.
   *  Default 0.08 — finer than the old 0.12 now that the loose cover won't shatter. */
  cell?: number;
  /** PRIMARY GROWTH KNOB — minimum solid density of the BOUNDARY SLAB a face-grow adds
   *  (solid voxels / slab voxels, 0..1). A face grows by one voxel-thick slab only while
   *  that slab is ≥ edgeDensity solid; it stops the instant the next slab is sparser.
   *  This brakes growth at the real solid boundary in EACH direction while ignoring
   *  interior voids (a grooved tabletop still has a dense top face → the box grows over
   *  the groove). Default 0.5. Raise toward 1.0 to hug tighter (more, smaller boxes);
   *  lower to swallow more empty space in fewer boxes. */
  edgeDensity?: number;
  /** Optional GLOBAL fill safety cap (0..1): refuse any face-grow that would drop the
   *  whole box's solid-fill below this. edgeDensity is the real brake; this is just a
   *  backstop against a box accreting many borderline slabs. 1.0 = also require every
   *  box 100% solid (reproduces the old strict cover, regardless of edgeDensity).
   *  Default 0 (off — edge-density alone governs growth). */
  minFill?: number;
  /** Stop emitting boxes once this fraction of all solid voxels is covered (0..1).
   *  The remaining sliver voxels are left to the collider's slop. Default 0.93. */
  coverageTarget?: number;
  /** Hard cap on emitted boxes; if exceeded the cell coarsens (×1.4) and we retry. */
  maxBoxes?: number;
  /** Drop any emitted box whose LONGEST edge is below this (so a knob/handle is
   *  not promoted to a collider). Object-local metres. */
  minBox?: number;
  /** Dilate the solid set by N voxels AFTER voxelization (collision errs bigger).
   *  Default 0 — the outward envelope rounding already pads slightly. Bump to 1 for
   *  a genuinely leaky mesh that needs its seams closed. */
  dilate?: number;
}

const DEFAULTS = {
  cell: 0.08,
  edgeDensity: 0.5,
  minFill: 0,
  coverageTarget: 0.93,
  maxBoxes: 12,
  minBox: 0.1,
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
  const minFill = opts.minFill ?? DEFAULTS.minFill;
  const coverageTarget = opts.coverageTarget ?? DEFAULTS.coverageTarget;
  const maxBoxes = opts.maxBoxes ?? DEFAULTS.maxBoxes;
  const minBox = opts.minBox ?? DEFAULTS.minBox;
  const dilate = opts.dilate ?? DEFAULTS.dilate;

  const soup = bakeSoup(object);
  if (soup.count === 0) {
    return { boxes: [], stats: { cell: opts.cell ?? DEFAULTS.cell, solidVoxels: 0, coverage: 0, fill: 0, boxCount: 0 } };
  }

  // Start at the requested cell; coarsen (×1.4) until the box count fits the cap.
  let cell = opts.cell ?? DEFAULTS.cell;
  for (let attempt = 0; attempt < 9; attempt++) {
    const grid = voxelize(soup, cell, dilate);
    if (grid && grid.solidCount > 0) {
      const res = looseCover(grid, { edgeDensity, minFill, coverageTarget, maxBoxes, minBox });
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
// 3. LOOSE-BOX cover over the solid grid (the edge-density grow).
//    Seed z→y→x at the first uncovered solid voxel; grow each of the 6 faces
//    OUTWARD greedily while the boundary SLAB the grow adds is ≥ edgeDensity solid
//    (an optional global minFill cap also applies); emit the maximal loose box; mark
//    its solid voxels covered; repeat until coverage ≥ coverageTarget or maxBoxes.
//    Fixed seed + round-robin face order = deterministic.
// ---------------------------------------------------------------------------
interface CoverOpts { edgeDensity: number; minFill: number; coverageTarget: number; maxBoxes: number; minBox: number; }

function looseCover(g: Grid, o: CoverOpts): { boxes: AABB[]; stats: Omit<FitStats, 'cell' | 'solidVoxels'> } {
  const { nx, ny, nz, solid, solidCount } = g;
  const covered = new Uint8Array(solid.length); // solid voxels already claimed by a box
  const idx = (x: number, y: number, z: number) => z * ny * nx + y * nx + x;
  const maxXm = g.ox + nx * g.cell, maxYm = g.oy + ny * g.cell, maxZm = g.oz + nz * g.cell;

  const boxes: AABB[] = [];
  let coveredSolid = 0;
  // accumulators for the union fill stat (sum over emitted boxes)
  let unionSolid = 0, unionVoxels = 0;

  // # solid voxels inside box [x0..x1]×[y0..y1]×[z0..z1] (inclusive).
  const solidIn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
    let s = 0;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const row = z * ny * nx + y * nx;
      for (let x = x0; x <= x1; x++) if (solid[row + x]) s++;
    }
    return s;
  };
  // # solid voxels on ONE candidate face slab (the layer we'd add by growing a face).
  const slabSolid = (ax: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, at: number): number => {
    // ax: 0=x face,1=y,2=z. `at` is the new index on that axis; the slab is the
    // full cross-section at that index over the box's other two spans.
    let s = 0;
    if (ax === 0) { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) if (solid[idx(at, y, z)]) s++; }
    else if (ax === 1) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (solid[idx(x, at, z)]) s++; }
    else { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (solid[idx(x, y, at)]) s++; }
    return s;
  };

  for (let sz = 0; sz < nz && coveredSolid < solidCount * o.coverageTarget; sz++) {
    for (let sy = 0; sy < ny; sy++) {
      for (let sx = 0; sx < nx; sx++) {
        if (!solid[idx(sx, sy, sz)] || covered[idx(sx, sy, sz)]) continue;
        if (boxes.length >= o.maxBoxes) break;

        // grow a LOOSE box outward from the seed voxel.
        let x0 = sx, x1 = sx, y0 = sy, y1 = sy, z0 = sz, z1 = sz;
        let boxVox = 1, boxSolid = 1; // seed is solid

        // attempt one face-grow; returns true if it grew. ax: axis, dir: -1|+1.
        // GATE = the density of the BOUNDARY SLAB being added (Jacob's refinement):
        // accept iff slabSolid/slabCount ≥ edgeDensity. The slab — not the whole box —
        // is the brake, so a dense bulk can't dilute a sparse edge into acceptance, and
        // the box stops exactly at the solid boundary in this direction. An optional
        // global minFill (default off) is a backstop against many borderline slabs.
        const tryGrow = (ax: number, dir: number): boolean => {
          let at: number, slabCount: number;
          if (ax === 0) { at = dir < 0 ? x0 - 1 : x1 + 1; if (at < 0 || at >= nx) return false; slabCount = (y1 - y0 + 1) * (z1 - z0 + 1); }
          else if (ax === 1) { at = dir < 0 ? y0 - 1 : y1 + 1; if (at < 0 || at >= ny) return false; slabCount = (x1 - x0 + 1) * (z1 - z0 + 1); }
          else { at = dir < 0 ? z0 - 1 : z1 + 1; if (at < 0 || at >= nz) return false; slabCount = (x1 - x0 + 1) * (y1 - y0 + 1); }
          const slabSol = slabSolid(ax, x0, y0, z0, x1, y1, z1, at);
          if (slabSol === 0) return false;                      // never grow into pure void
          if (slabSol < slabCount * o.edgeDensity) return false; // PRIMARY brake: edge slab density
          const newVox = boxVox + slabCount;
          const newSolid = boxSolid + slabSol;
          if (o.minFill > 0 && newSolid < newVox * o.minFill) return false; // optional global cap
          // commit the grow
          if (ax === 0) { if (dir < 0) x0 = at; else x1 = at; }
          else if (ax === 1) { if (dir < 0) y0 = at; else y1 = at; }
          else { if (dir < 0) z0 = at; else z1 = at; }
          boxVox = newVox; boxSolid = newSolid;
          return true;
        };

        // round-robin the 6 faces in a fixed order until no face can grow. This keeps
        // the box near-cubic as it expands rather than racing one axis to the wall,
        // which yields larger maximal boxes under the fill floor.
        let grew = true;
        while (grew) {
          grew = false;
          if (tryGrow(0, -1)) grew = true;
          if (tryGrow(0, +1)) grew = true;
          if (tryGrow(1, -1)) grew = true;
          if (tryGrow(1, +1)) grew = true;
          if (tryGrow(2, -1)) grew = true;
          if (tryGrow(2, +1)) grew = true;
        }

        // mark the box's SOLID voxels covered (empty ones it swallowed don't count
        // toward coverage — they were never solid to begin with).
        const before = coveredSolid;
        for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = idx(x, y, z);
          if (solid[i] && !covered[i]) { covered[i] = 1; coveredSolid++; }
        }
        const gained = coveredSolid - before;
        // a box that claims no NEW solid voxels (fully overlapped a prior box) is useless.
        if (gained === 0) { covered[idx(sx, sy, sz)] = 1; continue; }

        // emit as object-local AABB, clamped to the true mesh bound so the outward
        // rounding / loose padding never sticks out past the model.
        const aabb: AABB = {
          min: [g.ox + x0 * g.cell, g.oy + y0 * g.cell, g.oz + z0 * g.cell],
          max: [Math.min(maxXm, g.ox + (x1 + 1) * g.cell), Math.min(maxYm, g.oy + (y1 + 1) * g.cell), Math.min(maxZm, g.oz + (z1 + 1) * g.cell)],
        };
        const dx = aabb.max[0] - aabb.min[0], dy = aabb.max[1] - aabb.min[1], dz = aabb.max[2] - aabb.min[2];
        if (Math.max(dx, dy, dz) >= o.minBox) {
          boxes.push(aabb);
          unionSolid += solidIn(x0, y0, z0, x1, y1, z1);
          unionVoxels += boxVox;
        }
      }
      if (boxes.length >= o.maxBoxes) break;
    }
    if (boxes.length >= o.maxBoxes) break;
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
