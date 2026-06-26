// ============================================================================
// src/lab/mesh-stitch.ts — make a triangle soup WATERTIGHT by stitching its holes.
// ============================================================================
//
// KayKit (and most GLB) meshes are NON-WATERTIGHT: vertices are split per-face, and
// some parts (a wall's unseen bottom, a chest's open back) simply omit faces. A solid
// voxelizer needs a closed surface — otherwise an interior fill leaks out through the
// holes (a hollow shell) or a span fill welds separate features together (bridges).
//
// THE PIPELINE (deterministic, floats fine — this is offline lab tooling):
//   1. WELD vertices by QUANTIZED POSITION. Per-face splitting means the same 3D point
//      appears as many indices; we merge any vertices whose positions match within a
//      small epsilon so shared edges are actually shared (else every edge looks like a
//      boundary). Quantize to an epsilon grid + dedupe — exact, order-independent.
//   2. BOUNDARY EDGES. Build undirected edge → triangle-count. A boundary edge is used
//      by exactly ONE triangle (interior edges by two).
//   3. TRACE LOOPS. Walk boundary edges (following the next boundary edge at the shared
//      vertex) into closed loops — each loop is one HOLE.
//   4. STITCH each loop watertight via LIEPA advancing-front (Filling Holes in Meshes):
//      repeatedly cut the EAR at the loop vertex of smallest gap (its two neighbours
//      closest together), emit that triangle, advance the front, until 3 vertices remain
//      → one final triangle. Robust min-gap ear cutting = the advancing front.
//
// FALLBACK: a degenerate / non-manifold loop (a vertex visited twice, an open walk) is
// SKIPPED and reported — the caller then relies on flood-fill-exterior for that object
// rather than hanging. We never throw.
// ============================================================================

/** Result of stitching: the (possibly extended) triangle soup + diagnostics. */
export interface StitchResult {
  /** Flat xyz triplets per triangle vertex, 9 floats/triangle (input tris + stitch tris). */
  tris: Float32Array;
  /** Triangle count (tris.length / 9). */
  count: number;
  /** # boundary loops found. */
  loops: number;
  /** # loops successfully stitched closed. */
  stitched: number;
  /** # loops skipped (degenerate/non-manifold) → caller should treat the mesh as still leaky. */
  failed: number;
}

/** Weld vertices by quantized position. Returns unique vertex xyz + per-triangle vertex indices.
 *  Epsilon is a fraction of the bbox diagonal so it scales with the mesh; quantize-and-key makes
 *  the dedupe exact and order-independent (deterministic). */
function weld(tris: Float32Array, count: number): { verts: number[]; tri: Int32Array } {
  // bbox diagonal for a relative epsilon
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count * 9; i += 3) {
    const x = tris[i]!, y = tris[i + 1]!, z = tris[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  // quantize step: 1e-5 of the diagonal — merges "different but really close" floats, far below
  // any real feature size, so distinct vertices never collapse.
  const q = diag * 1e-5;
  const key = (x: number, y: number, z: number): string =>
    `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tri = new Int32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const x = tris[o]!, y = tris[o + 1]!, z = tris[o + 2]!;
      const kk = key(x, y, z);
      let id = map.get(kk);
      if (id === undefined) { id = verts.length / 3; map.set(kk, id); verts.push(x, y, z); }
      tri[t * 3 + k] = id;
    }
  }
  return { verts, tri };
}

/** Undirected edge key from two welded vertex ids (order-independent). */
function edgeKey(a: number, b: number): number {
  return a < b ? a * 0x4000000 + b : b * 0x4000000 + a; // pack (min,max); supports up to ~67M verts
}

/** Trace boundary loops from the boundary edges. Each loop is an ordered ring of vertex ids.
 *  Returns the loops; degenerate walks (a vertex with ≠1 onward boundary edge) terminate that
 *  loop early and it is dropped by the caller if it didn't close. */
function traceLoops(boundary: Array<[number, number]>): number[][] {
  // vertex → list of boundary-neighbour vertices
  const adj = new Map<number, number[]>();
  const addAdj = (a: number, b: number): void => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
  for (const [a, b] of boundary) { addAdj(a, b); addAdj(b, a); }
  // used-edge set so each undirected boundary edge is walked once
  const used = new Set<number>();
  const loops: number[][] = [];
  for (const [sa, sb] of boundary) {
    const sk = edgeKey(sa, sb);
    if (used.has(sk)) continue;
    // walk a loop starting sa → sb
    const loop: number[] = [sa];
    let prev = sa, cur = sb;
    used.add(sk);
    let guard = 0;
    const guardMax = boundary.length * 2 + 8;
    while (guard++ < guardMax) {
      loop.push(cur);
      if (cur === sa) break; // closed
      // pick the onward boundary neighbour that is not `prev` and whose edge is unused
      const nbrs = adj.get(cur) ?? [];
      let next = -1;
      for (const n of nbrs) { if (n === prev) continue; const k = edgeKey(cur, n); if (!used.has(k)) { next = n; break; } }
      if (next === -1) { // try ANY unused edge (handles a vertex of degree>2 fan)
        for (const n of nbrs) { const k = edgeKey(cur, n); if (!used.has(k)) { next = n; break; } }
      }
      if (next === -1) break; // dead end → open walk, dropped below
      used.add(edgeKey(cur, next));
      prev = cur; cur = next;
    }
    // a closed loop ends with sa repeated; drop the duplicate and keep loops of ≥3 verts.
    if (loop.length >= 4 && loop[loop.length - 1] === sa) { loop.pop(); loops.push(loop); }
  }
  return loops;
}

/** Liepa-style advancing-front fill of ONE loop: cut the min-gap ear repeatedly. Appends the new
 *  triangles' xyz (9 floats each) to `out`. Returns true on success, false if it stalled. */
function stitchLoop(loop: number[], verts: number[], out: number[]): boolean {
  // work on a mutable ring of vertex ids
  const ring = loop.slice();
  const px = (id: number) => verts[id * 3]!, py = (id: number) => verts[id * 3 + 1]!, pz = (id: number) => verts[id * 3 + 2]!;
  const d2 = (a: number, b: number): number => {
    const dx = px(a) - px(b), dy = py(a) - py(b), dz = pz(a) - pz(b);
    return dx * dx + dy * dy + dz * dz;
  };
  let guard = 0;
  while (ring.length > 3 && guard++ < loop.length + 8) {
    // find the ear (i-1, i, i+1) whose two neighbours (i-1,i+1) are CLOSEST — advancing front
    // closes the smallest gap first. Deterministic: scan in order, strict-less keeps earliest.
    let bi = -1, bestGap = Infinity;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n]!, c = ring[(i + 1) % n]!;
      const gap = d2(a, c);
      if (gap < bestGap - 1e-18) { bestGap = gap; bi = i; }
    }
    if (bi === -1) return false;
    const a = ring[(bi - 1 + n) % n]!, b = ring[bi]!, c = ring[(bi + 1) % n]!;
    out.push(px(a), py(a), pz(a), px(b), py(b), pz(b), px(c), py(c), pz(c));
    ring.splice(bi, 1); // advance the front: drop the cut ear's apex
  }
  if (ring.length === 3) {
    const a = ring[0]!, b = ring[1]!, c = ring[2]!;
    out.push(px(a), py(a), pz(a), px(b), py(b), pz(b), px(c), py(c), pz(c));
    return true;
  }
  return false;
}

/**
 * Make a triangle soup watertight by stitching its boundary holes. Returns the extended soup +
 * diagnostics. Never throws; loops it can't close are reported in `failed` so the caller can fall
 * back to flood-fill-exterior for that object.
 */
export function stitchHoles(tris: Float32Array, count: number): StitchResult {
  if (count === 0) return { tris, count, loops: 0, stitched: 0, failed: 0 };
  const { verts, tri } = weld(tris, count);

  // (2) boundary edges: undirected edge → use count.
  const edgeCount = new Map<number, number>();
  for (let t = 0; t < count; t++) {
    const a = tri[t * 3]!, b = tri[t * 3 + 1]!, c = tri[t * 3 + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      if (u === v) continue; // skip a degenerate edge (collapsed by the weld)
      const k = edgeKey(u, v);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  // recover the (a,b) pair for each boundary edge (count === 1)
  const boundary: Array<[number, number]> = [];
  for (let t = 0; t < count; t++) {
    const a = tri[t * 3]!, b = tri[t * 3 + 1]!, c = tri[t * 3 + 2]!;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      if (u === v) continue;
      if (edgeCount.get(edgeKey(u, v)) === 1) boundary.push([u, v]);
    }
  }
  if (boundary.length === 0) return { tris, count, loops: 0, stitched: 0, failed: 0 }; // already watertight

  // (3) trace loops, (4) stitch each.
  const loops = traceLoops(boundary);
  const add: number[] = [];
  let stitched = 0, failed = 0;
  for (const loop of loops) {
    // skip absurdly large loops (likely a mis-trace through a non-manifold fan) — fall back.
    if (loop.length < 3 || loop.length > 4096) { failed++; continue; }
    const before = add.length;
    if (stitchLoop(loop, verts, add)) stitched++;
    else { add.length = before; failed++; }
  }
  if (add.length === 0) return { tris, count, loops: loops.length, stitched, failed };

  const merged = new Float32Array(tris.length + add.length);
  merged.set(tris, 0);
  merged.set(add, tris.length);
  return { tris: merged, count: count + add.length / 9, loops: loops.length, stitched, failed };
}
