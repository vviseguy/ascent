// ============================================================================
// src/lab/facets.ts — the FACET PARTITION, as a pure function of a geometry.
// ============================================================================
//
// A FACET is a maximal run of edge-connected triangles within an angle tolerance. It is the unit a
// texture gets "ironed onto": one paver of a floor tile, one protruding brick of a wall.
//
// This lives on its own because it has TWO callers:
//   • face-select.ts   — the interactive picker (hover preview, the `show groups` overlay)
//   • group-anchors.ts — the BUILD-time baker, for `facetCentroid`: a saved group's ANCHOR
//
// Note what the baker does NOT use: `partitionFacets`. The auto partition proposes regions for a
// human to save; it does not decide what varies. Variation applies only to hand-saved groups
// (group-anchors.ts explains why the default has to be the identity transform), so the overlay is
// a selection aid and the flood that draws it is shared with the picker, not with the shader.
//
// Everything here is pure: geometry in, arrays out. No THREE.Scene, no DOM, no mutation of the
// input. (THREE.Vector3 is used only as a value type for the centroid/normal.)
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import { triCount } from './face-surfaces.ts';

/**
 * How a flood spreads.
 *
 * - `planar` — one cone about the seed normal. Gives the flat faces themselves.
 * - `carve`  — the seed face PLUS the slants that roll down off it, stopping at the concave crease
 *              where the neighbouring tile's slant comes back up. Gives a tile the way a mason
 *              would think of one: the face and its own chamfers, fitted against the next tile.
 *
 * The difference is the SIGN of the fold, not its angle. On a KayKit floor tile the bevels off each
 * paver (convex, 20-45°) and the rut bottoms between pavers (concave, 60-65°) are both just "edges"
 * to an angle threshold; only convexity separates them.
 */
export type GrowMode = 'planar' | 'carve';

/** Per-mode default tolerance in DEGREES. The tolerance means a different thing in each mode: in
 *  `planar` the cone IS the boundary rule, in `carve` the creases draw the boundaries and the cone
 *  only caps how far down a slant may roll — so it wants to be much higher. Measured on
 *  `floor_tile_large`, carve is FLAT at 17 facets (one per paver) from 65° to 89°. */
export const DEFAULT_TOL_DEG: Record<GrowMode, number> = { planar: 15, carve: 75 };

/** Below this, two faces are "the same plane" and the convex/concave sign is meaningless noise —
 *  the centroid offset is nearly in-plane, so its sign is arbitrary. Always join these. */
const FLAT_EPS_COS = Math.cos(THREE.MathUtils.degToRad(8));

/**
 * A maximal run of edge-connected triangles within the angle tolerance.
 *
 * MESH-LOCAL by construction. Facets that abut across two placed instances — the corner pieces of
 * four floor tiles meeting to form one diamond — are separate facets here, and can only be joined
 * once world positions are known. That is a different mechanism, deliberately not this one.
 */
export interface FacetInfo {
  id: number;
  tris: number[];
  /** Local-space, area-weighted centroid. This is the per-group texture ANCHOR. */
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  /** Surface area — the only honest way to sort facets. A triangle count says more about how the
   *  exporter happened to triangulate than about how big the face actually is. */
  area: number;
}

/** One geometry's precomputed topology. A few hundred triangles on these models, so cheap — but
 *  cached per geometry all the same, because the game builds it once per GLB and then places
 *  thousands of clones that share it. */
export interface MeshTopology {
  /** The geometry it was built from — the UNFILTERED source, always (see face-surfaces.ts). */
  source: THREE.BufferGeometry;
  tris: number;
  /** Vertex COUNT of the source buffer (not of the index) — what an anchor attribute must span. */
  verts: number;
  /** Flat [ax,ay,az, bx,by,bz, cx,cy,cz] per triangle, local space. */
  pos: Float32Array;
  /** Unit normal per triangle, local space. */
  normals: Float32Array;
  /** Centroid per triangle, local space — needed to tell a convex fold from a concave crease. */
  cents: Float32Array;
  /** triangle -> up to 3 edge-adjacent triangles. */
  adj: Int32Array;
  adjCount: Uint8Array;
  /** triangle -> its three vertex ids in the SOURCE buffer. */
  vidx: Uint32Array;
}

const _topoCache = new WeakMap<THREE.BufferGeometry, MeshTopology>();

/** Topology of one geometry, memoised. Pass the UNFILTERED source: hidden faces renumber
 *  triangles, and every stored index numbers the original. */
export function buildTopology(g: THREE.BufferGeometry): MeshTopology {
  const hit = _topoCache.get(g);
  if (hit) return hit;

  const posAttr = g.getAttribute('position');
  const idx = g.index;
  const tris = triCount(g);
  const pos = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 3);
  const cents = new Float32Array(tris * 3);
  const vidx = new Uint32Array(tris * 3);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const vi = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) vidx[t * 3 + k] = vi(t, k);
    a.fromBufferAttribute(posAttr, vidx[t * 3]!);
    b.fromBufferAttribute(posAttr, vidx[t * 3 + 1]!);
    c.fromBufferAttribute(posAttr, vidx[t * 3 + 2]!);
    pos.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 9);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() > 1e-20) n.normalize(); else n.set(0, 1, 0); // degenerate tri: harmless filler
    normals.set([n.x, n.y, n.z], t * 3);
    cents.set([(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3], t * 3);
  }

  // edge -> triangles, keyed by QUANTISED endpoint positions so UV/normal seams don't split it. A
  // GLB duplicates vertices at every seam, so two triangles that visually share an edge routinely
  // share no index; keying on position is what lets a fill cross a seam instead of stopping dead.
  const Q = 1e4;
  const key = (t: number, k: number): string => {
    const o = t * 9 + k * 3;
    return `${Math.round(pos[o]! * Q)},${Math.round(pos[o + 1]! * Q)},${Math.round(pos[o + 2]! * Q)}`;
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const p = key(t, k), q = key(t, (k + 1) % 3);
      const ek = p < q ? p + '|' + q : q + '|' + p;
      const list = edges.get(ek);
      if (list) list.push(t); else edges.set(ek, [t]);
    }
  }
  const adj = new Int32Array(tris * 3).fill(-1);
  const adjCount = new Uint8Array(tris);
  for (const list of edges.values()) {
    if (list.length < 2) continue;
    for (const t of list) {
      for (const u of list) {
        if (u === t || adjCount[t]! >= 3) continue;
        let dup = false;
        for (let k = 0; k < adjCount[t]!; k++) if (adj[t * 3 + k] === u) { dup = true; break; }
        if (!dup) { adj[t * 3 + adjCount[t]!] = u; adjCount[t]!++; }
      }
    }
  }

  const topo: MeshTopology = { source: g, tris, verts: posAttr.count, pos, normals, cents, adj, adjCount, vidx };
  _topoCache.set(g, topo);
  return topo;
}

/** Is the edge between two triangles a convex fold (the surface rolling AWAY) or a concave crease
 *  (the surface folding back on itself)? Convex when the neighbour's centroid sits BEHIND this
 *  face's plane. This is the whole difference between "the bevel off the top of a paver" and "the
 *  bottom of the rut where two pavers meet" — they sit at similar angles and only the sign
 *  separates them. */
function isConvex(topo: MeshTopology, t: number, u: number): boolean {
  const dx = topo.cents[u * 3]! - topo.cents[t * 3]!;
  const dy = topo.cents[u * 3 + 1]! - topo.cents[t * 3 + 1]!;
  const dz = topo.cents[u * 3 + 2]! - topo.cents[t * 3 + 2]!;
  return topo.normals[t * 3]! * dx + topo.normals[t * 3 + 1]! * dy + topo.normals[t * 3 + 2]! * dz < 0;
}

/**
 * Flood across shared edges from `seed`, taking any triangle whose normal is within the tolerance
 * OF THE SEED. Seed-relative rather than neighbour-relative on purpose: chaining
 * neighbour-to-neighbour walks all the way around a curved surface a fraction of a degree at a
 * time, which is never what you meant by "these faces are basically the same face".
 *
 * `tolCos` is cos(tolerance) — pre-cosined so the flood never calls acos.
 */
export function growFacet(topo: MeshTopology, seed: number, mode: GrowMode, tolCos: number): number[] {
  const sx = topo.normals[seed * 3]!, sy = topo.normals[seed * 3 + 1]!, sz = topo.normals[seed * 3 + 2]!;
  const seen = new Uint8Array(topo.tris);
  const out: number[] = [];
  const stack = [seed];
  seen[seed] = 1;
  while (stack.length) {
    const t = stack.pop()!;
    out.push(t);
    for (let k = 0; k < topo.adjCount[t]!; k++) {
      const u = topo.adj[t * 3 + k]!;
      if (u < 0 || seen[u]) continue;
      const ux = topo.normals[u * 3]!, uy = topo.normals[u * 3 + 1]!, uz = topo.normals[u * 3 + 2]!;
      const dSeed = sx * ux + sy * uy + sz * uz;          // how far off the SEED plane
      if (mode === 'carve') {
        // CARVED-TILE mode: a tile is its flat top plus the slants that roll down off it, ending
        // where the neighbouring tile's slant comes back up — that meeting is a concave crease.
        // So: always cross a near-flat edge, otherwise cross only CONVEX folds, and never a
        // crease. The seed cone still caps how far down a slant may go.
        const dLocal = topo.normals[t * 3]! * ux + topo.normals[t * 3 + 1]! * uy + topo.normals[t * 3 + 2]! * uz;
        if (dLocal < FLAT_EPS_COS) {
          if (!isConvex(topo, t, u)) continue;            // concave crease — the rut bottom
          if (dSeed < tolCos) continue;                   // rolled too far from the tile's face
        }
      } else if (dSeed < tolCos) continue;                // PLANAR mode: one cone about the seed
      seen[u] = 1;
      stack.push(u);
    }
  }
  return out;
}

export interface Partition {
  /** Largest facet first — that is the order you want to read them in, so it is the id order too. */
  list: FacetInfo[];
  /** triangle -> facet id. Total: every triangle lands in exactly one. */
  byTri: Int32Array;
}

/**
 * The same flood the hover preview uses, run to exhaustion instead of from a single seed: every
 * triangle lands in exactly one facet.
 *
 * The tolerance is not a filter over some fixed truth — it IS the definition of what counts as one
 * surface, so a change to it recomputes the partition rather than refining it. Callers cache
 * against (mode, tolerance) for that reason.
 */
export function partitionFacets(topo: MeshTopology, mode: GrowMode, tolCos: number): Partition {
  const byTri = new Int32Array(topo.tris).fill(-1);
  const list: FacetInfo[] = [];
  for (let seed = 0; seed < topo.tris; seed++) {
    if (byTri[seed]! >= 0) continue;
    const tris = growFacet(topo, seed, mode, tolCos);
    const id = list.length;
    for (const t of tris) byTri[t] = id;
    const { centroid, area } = facetCentroid(topo, tris);
    list.push({
      id, tris, centroid, area,
      normal: new THREE.Vector3(topo.normals[seed * 3]!, topo.normals[seed * 3 + 1]!, topo.normals[seed * 3 + 2]!),
    });
  }
  // biggest first — that is the order you want to read them in, so make it the id order too
  list.sort((x, y) => y.area - x.area);
  const remap = new Int32Array(list.length);
  list.forEach((f, i) => { remap[f.id] = i; f.id = i; });
  for (let t = 0; t < byTri.length; t++) byTri[t] = remap[byTri[t]!]!;
  return { list, byTri };
}

/**
 * The AREA-WEIGHTED centroid of a triangle set, plus its area.
 *
 * Area-weighting is not a refinement. An exporter's fan triangulation clusters many slivers at one
 * corner of a face, and a plain per-triangle mean would drag the anchor over there instead of
 * leaving it in the middle where a texture wants to be centred — and the anchor is what the
 * per-group texture phase hashes, so a lopsided one is a lopsided decision.
 */
export function facetCentroid(topo: MeshTopology, tris: readonly number[]): { centroid: THREE.Vector3; area: number } {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), mid = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let area = 0;
  for (const t of tris) {
    if (t < 0 || t >= topo.tris) continue;
    a.set(topo.pos[t * 9]!, topo.pos[t * 9 + 1]!, topo.pos[t * 9 + 2]!);
    b.set(topo.pos[t * 9 + 3]!, topo.pos[t * 9 + 4]!, topo.pos[t * 9 + 5]!);
    c.set(topo.pos[t * 9 + 6]!, topo.pos[t * 9 + 7]!, topo.pos[t * 9 + 8]!);
    const w = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
    area += w;
    mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    centroid.addScaledVector(mid, w);
  }
  if (area > 1e-12) centroid.multiplyScalar(1 / area);
  return { centroid, area };
}
