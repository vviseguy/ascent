// ============================================================================
// src/floor/cell-graph.ts — the traversal graph: CELLS are the nodes.
// ============================================================================
//
// With walls on cell boundaries rather than inside cells, the graph is the ordinary grid-maze one:
// a node per cell, an edge between orthogonal neighbours, blocked iff the wall between them is a
// full-height wall. No dual, no corner lattice, no "two routes per boundary".
//
// (The 4u model had to pathfind on the CORNERS, because a wall lived inside a tile and cut it into
// pieces — so a tile was not a single place you could be. A 2u cell is one place, so it is one node.)
//
// OPENINGS are the one thing that is not a plain wall test. A 4u door sits on a lattice POINT and
// spans the two collinear wall segments either side of it, so it connects the cells on one side of
// that run to the cells on the other — see `cell.ts:openingGroups`. It counts only when both spanned
// segments really are walls, which is exactly when the renderer has 4u of wall to put the arch into:
// the graph and the mesh agree by construction, which is the whole point.
//
// Pure + deterministic — integer node ids, ascending adjacency, BFS over dense arrays.

import {
  AXES, blocks, cornerIsOpen, openingGroups, openingWalls, stepped,
  type Axis, type Cell, type Dir, type Seg,
} from './cell.ts';
import { DIRS } from './cell.ts';

export interface CellGraph {
  readonly w: number;
  readonly h: number;
  readonly nodeCount: number;
  /** adjacency by node id; each list ascending (deterministic). */
  readonly adj: ReadonlyArray<readonly number[]>;
}

export const nodeId = (w: number, x: number, y: number): number => y * w + x;
export const nodeXY = (w: number, id: number): { x: number; y: number } => ({ x: id % w, y: Math.floor(id / w) });
export const nodeCount = (w: number, h: number): number => w * h;

/**
 * THE builder, parameterised by the two questions a caller can answer differently for concrete cells
 * versus domains (see `cell-reach.ts`):
 *   `stepOpen(x,y,d)`   — can a body cross the wall on side `d` of this cell?
 *   `openingOn(x,y,ax)` — does this cell's NW point carry a live opening on that axis?
 * One builder means the topology can never drift between the two readings.
 */
export function buildCellGraphFrom(
  w: number,
  h: number,
  stepOpen: (x: number, y: number, d: Dir) => boolean,
  openingOn?: (x: number, y: number, axis: Axis) => boolean,
): CellGraph {
  const n = nodeCount(w, h);
  const out: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const inside = (p: { x: number; y: number }): boolean => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
  const link = (a: number, b: number): void => { out[a]!.add(b); out[b]!.add(a); };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // only N and W are walked, so each shared wall is consulted exactly once
      for (const d of ['N', 'W'] as Dir[]) {
        const p = stepped(x, y, d);
        if (!inside(p) || !stepOpen(x, y, d)) continue;
        link(nodeId(w, x, y), nodeId(w, p.x, p.y));
      }
      if (!openingOn) continue;
      for (const ax of AXES) {
        if (!openingOn(x, y, ax)) continue;
        const { a, b } = openingGroups(x, y, ax);
        for (const p of a) for (const q of b) {
          if (inside(p) && inside(q)) link(nodeId(w, p.x, p.y), nodeId(w, q.x, q.y));
        }
      }
    }
  }
  return { w, h, nodeCount: n, adj: out.map((s) => [...s].sort((a, b) => a - b)) };
}

/**
 * Is the opening at cell (x,y)'s NW point live on `axis`?
 *
 * The LOCAL half is `cornerIsOpen` — corner is `air` and the wallType is a door or arch, both fields
 * on this one cell, and it short-circuits so the common case costs no neighbour reads at all.
 *
 * The axis is DERIVED, because an archway is 4u and has to span a straight run: the run exists only
 * if BOTH arms on that axis are walls. A CROSS — both axes walled — is deliberately not an opening;
 * you cannot span a four-way junction with an arch, and guessing an axis there would over-claim
 * reachability, which is the one direction a solvability check must never err.
 */
export function openingActive(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, axis: Axis): boolean {
  const c = cells[y * w + x];
  if (!c || !cornerIsOpen(c)) return false;
  const runOn = (ax: Axis): boolean => openingWalls(x, y, ax).every((o) => {
    if (o.x < 0 || o.y < 0 || o.x >= w || o.y >= h) return true; // the perimeter shell counts as wall
    const n = cells[o.y * w + o.x];
    const s: Seg | undefined = n ? n[o.side === 'N' ? 'wallN' : 'wallW'] : 'wall';
    return s === 'wall';
  });
  const other: Axis = axis === 'H' ? 'V' : 'H';
  return runOn(axis) && !runOn(other);
}

/** The graph of a resolved grid — the same cells the renderer and the collider consume. */
export function buildCellGraph(cells: readonly (Cell | null)[], w: number, h: number): CellGraph {
  const wallOn = (x: number, y: number, d: Dir): Seg => {
    const o = d === 'N' ? { x, y, side: 'N' as const }
      : d === 'W' ? { x, y, side: 'W' as const }
      : d === 'S' ? { x, y: y + 1, side: 'N' as const }
      : { x: x + 1, y, side: 'W' as const };
    if (o.x < 0 || o.y < 0 || o.x >= w || o.y >= h) return 'wall';
    const c = cells[o.y * w + o.x];
    return c ? c[o.side === 'N' ? 'wallN' : 'wallW'] : 'wall';
  };
  return buildCellGraphFrom(
    w, h,
    (x, y, d) => (cells[y * w + x] ? !blocks(wallOn(x, y, d)) : false),
    (x, y, ax) => openingActive(cells, w, h, x, y, ax),
  );
}

/* --------------------------------- traversal ---------------------------------- */

/** Nodes reachable from any of `starts`, as a boolean array. Deterministic multi-source BFS. */
export function reachableFromSet(g: CellGraph, starts: readonly number[]): boolean[] {
  const seen = new Array<boolean>(g.nodeCount).fill(false);
  const queue: number[] = [];
  for (const s of starts) if (s >= 0 && s < g.nodeCount && !seen[s]) { seen[s] = true; queue.push(s); }
  for (let qi = 0; qi < queue.length; qi++) {
    for (const m of g.adj[queue[qi]!]!) if (!seen[m]) { seen[m] = true; queue.push(m); }
  }
  return seen;
}

export const reachableFrom = (g: CellGraph, start: number): boolean[] => reachableFromSet(g, [start]);
export const reaches = (g: CellGraph, a: number, b: number): boolean => reachableFrom(g, a)[b] === true;

/** The node ids along one outer edge of the grid, ascending. */
export function edgeNodes(g: CellGraph, side: Dir): number[] {
  const ids: number[] = [];
  if (side === 'N' || side === 'S') {
    const y = side === 'N' ? 0 : g.h - 1;
    for (let x = 0; x < g.w; x++) ids.push(nodeId(g.w, x, y));
  } else {
    const x = side === 'W' ? 0 : g.w - 1;
    for (let y = 0; y < g.h; y++) ids.push(nodeId(g.w, x, y));
  }
  return ids;
}

/** Does any cell on the `from` side reach any cell on the `to` side? */
export function connectsSides(g: CellGraph, from: Dir, to: Dir): boolean {
  const seen = reachableFromSet(g, edgeNodes(g, from));
  return edgeNodes(g, to).some((id) => seen[id] === true);
}

/** All four directions, re-exported so callers need one import for a walk. */
export { DIRS };
