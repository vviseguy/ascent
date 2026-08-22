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

import { tileOpening, type WallTile, type Seg, type Dir } from './wall-tile.ts';
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
 * THE corner-graph builder, parameterised by one predicate: "is tile (tx,ty)'s `dir` arm passable?".
 *
 * There are two truths a caller can ask about, and they share this exact skeleton — only the
 * predicate differs (see `tile-reach.ts`):
 *   • CONCRETE tiles     — the arm's values are known (`buildCornerGraph` below).
 *   • DOMAINS (a field)  — the arm still holds a SET of values, so passability is a modality:
 *                          "could be open" (optimistic) vs "is guaranteed open" (pessimistic).
 * Keeping one builder means the graph topology, the two-routes-per-boundary behaviour and the
 * determinism discipline can never drift between the two.
 *
 * Each tile emits its four arm-gated corner↔corner connections; shared corner-pairs therefore
 * accumulate a route from each flanking tile — the "two routes per boundary" of §2-graph. A tile the
 * predicate cannot speak for (a null/conflicted cell) simply contributes no edges.
 */
export function buildCornerGraphFrom(
  w: number,
  h: number,
  armPassable: (tx: number, ty: number, dir: Dir) => boolean,
  tileOpen?: (tx: number, ty: number) => boolean,
): CornerGraph {
  const nodeCount = cornerCount(w, h);
  const out: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  // A passable arm links its two corners. DIRECTED seam: today both ways (horizontal walk is
  // symmetric); when `profile` rides on the tile, split into out[a].add(b) / out[b].add(a) gated by
  // the per-direction ascend/descend test (the RouteProbe model) instead of linking unconditionally.
  const link = (a: number, b: number): void => { out[a]!.add(b); out[b]!.add(a); };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const nw = cornerId(w, tx, ty);
      const ne = cornerId(w, tx + 1, ty);
      const se = cornerId(w, tx + 1, ty + 1);
      const sw = cornerId(w, tx, ty + 1);
      if (armPassable(tx, ty, 'N')) link(nw, ne); // N arm gates the top corner-pair
      if (armPassable(tx, ty, 'E')) link(ne, se); // E arm gates the right pair
      if (armPassable(tx, ty, 'S')) link(se, sw); // S arm gates the bottom pair
      if (armPassable(tx, ty, 'W')) link(sw, nw); // W arm gates the left pair
      // AN OPENING JOINS ALL FOUR CORNERS. A door or arch clears the tile's CENTRE, and every corner
      // can reach the centre — so all four end up in one component, whatever the arms say. That is
      // why it is not "re-open the two arms of the spanning axis": with the centre open you can also
      // slip around the inner end of a PERPENDICULAR arm, so NE↔SW is real too. Four links (a cycle)
      // are enough to merge them.
      if (tileOpen?.(tx, ty)) { link(nw, ne); link(ne, se); link(se, sw); link(sw, nw); }
    }
  }
  const adj = out.map((s) => [...s].sort((a, b) => a - b));
  return { w, h, nodeCount, adj };
}

/**
 * Build the directed corner-graph from RESOLVED tiles (row-major, length w*h; a null cell is a
 * conflicted/void tile and contributes no edges).
 */
export function buildCornerGraph(tiles: ReadonlyArray<WallTile | null>, w: number, h: number): CornerGraph {
  return buildCornerGraphFrom(
    w, h,
    (tx, ty, d) => {
      const t = tiles[ty * w + tx];
      return t ? !armBlocks(t.edge[d], t.inner[d]) : false;
    },
    (tx, ty) => {
      const t = tiles[ty * w + tx];
      return t ? tileOpening(t) : false;
    },
  );
}

/** Convenience: collapse + owner-resolve a grid, then build its corner-graph. The resolved tiles are
 *  the same ones `tilePlacements`/collision consume, so the graph proves the truth the sim collides on. */
export function cornerGraphOf(
  grid: TileGrid,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): CornerGraph {
  return buildCornerGraph(resolveGrid(grid, pick), grid.w, grid.h);
}

/** Corners reachable from ANY of `starts` (inclusive), as a boolean array indexed by node id.
 *  Deterministic multi-source BFS over the directed graph (ascending adjacency, numeric queue). */
export function reachableFromSet(g: CornerGraph, starts: readonly number[]): boolean[] {
  const seen = new Array<boolean>(g.nodeCount).fill(false);
  const queue: number[] = [];
  for (const s of starts) if (s >= 0 && s < g.nodeCount && !seen[s]) { seen[s] = true; queue.push(s); }
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

/** Corners reachable from a single `start`. */
export function reachableFrom(g: CornerGraph, start: number): boolean[] {
  return reachableFromSet(g, [start]);
}

/** Is corner `b` reachable from corner `a` (following directed edges)? */
export function cornerReachable(g: CornerGraph, a: number, b: number): boolean {
  return reachableFrom(g, a)[b] ?? false;
}

/** The corner node ids along one outer edge of the grid, ascending. (N = top row cy=0, S = bottom row
 *  cy=h, W = left col cx=0, E = right col cx=w.) These are the candidate entry/exit bands a floor
 *  traversal check runs between — the generator decides which side is entry vs exit. */
export function edgeCorners(g: CornerGraph, side: Dir): number[] {
  const ids: number[] = [];
  if (side === 'N' || side === 'S') {
    const cy = side === 'N' ? 0 : g.h;
    for (let cx = 0; cx <= g.w; cx++) ids.push(cornerId(g.w, cx, cy));
  } else {
    const cx = side === 'W' ? 0 : g.w;
    for (let cy = 0; cy <= g.h; cy++) ids.push(cornerId(g.w, cx, cy));
  }
  return ids;
}

/** Does any corner on the `from` edge reach any corner on the `to` edge? The generic floor-traversal
 *  solvability check the §2 bridge needs: a body entering along one side can cross to the other. */
export function connectsSides(g: CornerGraph, from: Dir, to: Dir): boolean {
  const seen = reachableFromSet(g, edgeCorners(g, from));
  return edgeCorners(g, to).some((id) => seen[id] === true);
}
