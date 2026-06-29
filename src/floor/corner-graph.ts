// ============================================================================
// src/floor/corner-graph.ts — the DUAL-OF-WALLS traversal graph (docs/16 §2-graph).
// ============================================================================
//
// The thing you pathfind and PROVE solvability on is the open space — the dual of the walls. Nodes
// are the tile CORNERS on the (w+1)×(h+1) lattice (a corner is shared by the 4 tiles meeting at it).
// A corner↔corner connection crosses exactly ONE arm — the `edge` + `inner` cell on that side of a
// tile — and is OPEN unless that arm is a FULL wall. Because two tiles flank every interior boundary,
// a corner-pair gets up to TWO routes (one through each tile); both are emitted (see `buildCornerGraph`).
//
// Edges are DIRECTED so gravity can plug in: descending a connection is free, ascending it is gated by
// what the body can do (jump/climb height, the `profile` FULL/LOW/GAP — the `route-check.ts` RouteProbe
// model). Today the tile carries no vertical profile, so a passable arm links BOTH directions equally;
// the asymmetric gate is the single seam marked in `link()`, to wire once `profile` rides on the tile.
//
// Pure + deterministic — integer node ids, ascending adjacency, BFS over arrays (no float / no
// Map/Set iteration on an output-affecting path; a Set is used only during construction, then sorted).

import type { WallTile, Seg } from './wall-tile.ts';
import { resolveGrid, type TileGrid } from './tile-grid.ts';

export interface CornerGraph {
  readonly w: number;
  readonly h: number;
  /** number of corner nodes = (w+1)*(h+1). */
  readonly nodeCount: number;
  /** directed adjacency, indexed by node id; each list is ascending (deterministic). */
  readonly adj: ReadonlyArray<readonly number[]>;
}

/** Corner node id on the (w+1)×(h+1) lattice. Corner (cx,cy) is the shared corner of the (up to) four
 *  tiles around it; cx∈[0,w], cy∈[0,h]. */
export const cornerId = (w: number, cx: number, cy: number): number => cy * (w + 1) + cx;
export const cornerCount = (w: number, h: number): number => (w + 1) * (h + 1);

/** Does this arm FULLY seal its side to a body? Only a full-height wall on BOTH cells blocks — a
 *  partial arm (one cell open) leaves a gap you slip through, and a low `barrier` is surmountable.
 *  (docs/16 §2-graph predicate.) */
export const armBlocks = (edge: Seg, inner: Seg): boolean => edge === 'wall' && inner === 'wall';

/**
 * Build the directed corner-graph from RESOLVED tiles (row-major, length w*h; a null cell is a
 * conflicted/void tile and contributes no edges). Each non-null tile emits its four arm-gated
 * corner↔corner connections; shared corner-pairs therefore accumulate a route from each flanking
 * tile — the "two routes per boundary" of §2-graph.
 */
export function buildCornerGraph(tiles: ReadonlyArray<WallTile | null>, w: number, h: number): CornerGraph {
  const nodeCount = cornerCount(w, h);
  const out: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  // A passable arm links its two corners. DIRECTED seam: today both ways (horizontal walk is
  // symmetric); when `profile` rides on the tile, split into out[a].add(b) / out[b].add(a) gated by
  // the per-direction ascend/descend test (the RouteProbe model) instead of linking unconditionally.
  const link = (a: number, b: number): void => { out[a]!.add(b); out[b]!.add(a); };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const t = tiles[ty * w + tx];
      if (!t) continue;
      const nw = cornerId(w, tx, ty);
      const ne = cornerId(w, tx + 1, ty);
      const se = cornerId(w, tx + 1, ty + 1);
      const sw = cornerId(w, tx, ty + 1);
      if (!armBlocks(t.edge.N, t.inner.N)) link(nw, ne); // N arm gates the top corner-pair
      if (!armBlocks(t.edge.E, t.inner.E)) link(ne, se); // E arm gates the right pair
      if (!armBlocks(t.edge.S, t.inner.S)) link(se, sw); // S arm gates the bottom pair
      if (!armBlocks(t.edge.W, t.inner.W)) link(sw, nw); // W arm gates the left pair
    }
  }
  const adj = out.map((s) => [...s].sort((a, b) => a - b));
  return { w, h, nodeCount, adj };
}

/** Convenience: collapse + owner-resolve a grid, then build its corner-graph. The resolved tiles are
 *  the same ones `tilePlacements`/collision consume, so the graph proves the truth the sim collides on. */
export function cornerGraphOf(
  grid: TileGrid,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): CornerGraph {
  return buildCornerGraph(resolveGrid(grid, pick), grid.w, grid.h);
}

/** Corners reachable from `start` (inclusive), as a boolean array indexed by node id. Deterministic
 *  BFS over the directed graph (ascending adjacency, numeric queue). */
export function reachableFrom(g: CornerGraph, start: number): boolean[] {
  const seen = new Array<boolean>(g.nodeCount).fill(false);
  if (start < 0 || start >= g.nodeCount) return seen;
  seen[start] = true;
  const queue: number[] = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi]!;
    for (const m of g.adj[n]!) {
      if (!seen[m]) {
        seen[m] = true;
        queue.push(m);
      }
    }
  }
  return seen;
}

/** Is corner `b` reachable from corner `a` (following directed edges)? */
export function cornerReachable(g: CornerGraph, a: number, b: number): boolean {
  return reachableFrom(g, a)[b] ?? false;
}
