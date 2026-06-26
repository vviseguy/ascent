// ============================================================================
// src/lab/box-fit.ts — COLLISION-BOX GENERATOR (solid voxelize → greedy cover).
// ============================================================================
//
// Turns an arbitrary mesh (a KayKit GLB, a procedural prop) into a SMALL set of
// object-local AABBs that HUG its solid volume — the `footprint` a WorldObject
// hands the collider. We never hand-author boxes for real assets: a table comes
// out as a top slab + legs, a barrel as ~1-2 chunky boxes, a chest as a body block.
//
// WHY SOLID VOXELIZE + GREEDY COVER:
//  - A collider wants the SOLID OBSTACLE, not a hollow shell: you can't walk through
//    a barrel even though its model is an open-topped tube. So we fill the SOLID
//    ENVELOPE (the span between the outermost surface crossings) per scan-row, not
//    the thin wall shells a naive parity fill leaves — that's what made the old boxes
//    explode into a loose cage. The greedy MAXIMAL-box cover then merges the filled
//    voxels into a handful of tight boxes (the table's whole top becomes ONE box).
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
// The scan order is fixed (axis 0→2, then z→y→x cover), so same mesh → same boxes.
// ============================================================================

import * as THREE from 'three';

/** An axis-aligned box in object-local metres: inclusive corners. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

export interface FitBoxesOpts {
  /** Voxel edge length (object-local metres). Smaller = tighter fit, more cost. */
  cell?: number;
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

const DEFAULTS = { cell: 0.12, maxBoxes: 12, minBox: 0.1, dilate: 0 } as const;

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
  const maxBoxes = opts.maxBoxes ?? DEFAULTS.maxBoxes;
  const minBox = opts.minBox ?? DEFAULTS.minBox;
  const dilate = opts.dilate ?? DEFAULTS.dilate;

  const soup = bakeSoup(object);
  if (soup.count === 0) return [];

  // Start at the requested cell; coarsen (×1.4) until the box count fits the cap.
  let cell = opts.cell ?? DEFAULTS.cell;
  for (let attempt = 0; attempt < 9; attempt++) {
    const grid = voxelize(soup, cell, dilate);
    if (grid && grid.solidCount > 0) {
      const boxes = greedyCover(grid, minBox);
      if (boxes.length > 0 && boxes.length <= maxBoxes) return boxes;
    }
    cell *= 1.4;
  }
  // Last resort: a single tight bounding box (always valid, never explodes the count).
  const b = soup.box;
  return [{ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }];
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
// 2. SOLID voxelize: a voxel is solid where the X-, Y- and Z-axis solid envelopes
//    all AGREE (intersection). Tight to the surface, robust to non-watertight parts.
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
// 3. Greedy maximal-box cover over the solid grid.
//    Scan z→y→x to the first uncovered solid voxel; grow +X while the row stays
//    solid+uncovered, then +Y over that whole X-span, then +Z over that whole
//    slab; emit the box, mark covered, repeat. Fixed scan order = deterministic.
// ---------------------------------------------------------------------------
function greedyCover(g: Grid, minBox: number): AABB[] {
  const { nx, ny, nz, solid } = g;
  const covered = new Uint8Array(solid.length);
  const idx = (x: number, y: number, z: number) => z * ny * nx + y * nx + x;
  const isFree = (x: number, y: number, z: number) => solid[idx(x, y, z)] === 1 && covered[idx(x, y, z)] === 0;
  const boxes: AABB[] = [];
  const maxX = g.ox + nx * g.cell, maxY = g.oy + ny * g.cell, maxZ = g.oz + nz * g.cell;

  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!isFree(x, y, z)) continue;

    // grow +X
    let ex = x;
    while (ex + 1 < nx && isFree(ex + 1, y, z)) ex++;
    // grow +Y while the whole [x..ex] row stays free
    let ey = y;
    grow_y: while (ey + 1 < ny) {
      for (let xx = x; xx <= ex; xx++) if (!isFree(xx, ey + 1, z)) break grow_y;
      ey++;
    }
    // grow +Z while the whole [x..ex]×[y..ey] slab stays free
    let ez = z;
    grow_z: while (ez + 1 < nz) {
      for (let yy = y; yy <= ey; yy++) for (let xx = x; xx <= ex; xx++) {
        if (!isFree(xx, yy, ez + 1)) break grow_z;
      }
      ez++;
    }
    // mark covered
    for (let zz = z; zz <= ez; zz++) for (let yy = y; yy <= ey; yy++) for (let xx = x; xx <= ex; xx++) {
      covered[idx(xx, yy, zz)] = 1;
    }
    // emit as object-local AABB (voxel min corner → voxel max corner), clamped to
    // the true mesh bound so the outward rounding never sticks out past the model.
    const aabb: AABB = {
      min: [g.ox + x * g.cell, g.oy + y * g.cell, g.oz + z * g.cell],
      max: [Math.min(maxX, g.ox + (ex + 1) * g.cell), Math.min(maxY, g.oy + (ey + 1) * g.cell), Math.min(maxZ, g.oz + (ez + 1) * g.cell)],
    };
    const dx = aabb.max[0] - aabb.min[0], dy = aabb.max[1] - aabb.min[1], dz = aabb.max[2] - aabb.min[2];
    if (Math.max(dx, dy, dz) >= minBox) boxes.push(aabb); // drop tiny boxes (knobs)
  }
  return boxes;
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
