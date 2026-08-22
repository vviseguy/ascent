// ============================================================================
// src/floor/cell-maze.ts — maze strategies over the cell grid.
// ============================================================================
//
// At 2u this is the textbook formulation and nothing more: nodes are CELLS, and the "wall between two
// cells" is one owned field. So a maze edge IS a wall — no seam, no arm pair, no dual lattice.
//
//   maze graph:  nodes = cells (w×h)      edges = the wall each pair shares
//
// Every strategy produces the same thing — an ORDER in which to try walling — and the caller's gate
// decides what is allowed. A strategy proposes; `cell-emergent.ts` disposes, so the solvability
// machinery is untouched by any of this.
//
// THE ONE THAT MATTERS. `scatter` walls a pair if the TARGETS stay reachable. A real maze algorithm
// maintains connectivity over EVERY cell, and that difference is the whole dead-space problem: a wall
// sealing off a quarter of the floor passes a target-only gate because nobody asked about the sealed
// quarter. `kruskal` is the same loop with "no cell may be lost" as the gate — Kruskal's component
// test with the sense inverted (Kruskal REMOVES a wall when it joins two components; we ADD one when
// it splits none).
//
// BRAIDING IS NOT OPTIONAL. A perfect maze is a spanning tree: exactly one path between any two
// points, so no route choice, no shortcuts, no overtaking. ASCENT is a race. `braid` is the fraction
// of would-be walls deliberately left open, turning the tree back into a graph with loops.
//
// Deterministic: seeded shuffles over index arrays, fixed enumeration order, no float / no Map
// iteration on an output-affecting path.

import { shuffleInPlace, nextInt, type Rng } from './rng.ts';
import { type CellGrid } from './cell-grid.ts';

export const MAZE_KINDS = ['none', 'scatter', 'kruskal', 'backtracker', 'prim'] as const;
export type MazeKind = (typeof MAZE_KINDS)[number];

/**
 * One candidate barrier between two BLOCKS: every wall that would have to close, and the two blocks
 * it separates.
 *
 * At `step` 1 a block is a cell and a barrier is one wall. At `step` 2 a block is 2x2 cells and a
 * barrier is TWO walls, so the corridors that survive are 2 cells — 4u — across, which is the width
 * the meshes were authored for. That is the whole reason the step exists: a maze carved cell-by-cell
 * on a 2u grid gives 2u corridors, which are half the intended width.
 */
export interface MazeEdge {
  /** The cells that OWN this barrier's walls, and which wall of each. Length === step. */
  pins: { x: number; y: number; side: 'N' | 'W' }[];
  a: number;
  b: number;
}

/** Every barrier between two in-bounds blocks, in a fixed order. N and W only, so each is listed once.
 *  Cells past the last whole block (a map size that is not a multiple of `step`) are never proposed
 *  and simply keep whatever the earlier phases decided. */
export function mazeEdges(g: CellGrid, step = 1): MazeEdge[] {
  const out: MazeEdge[] = [];
  const bw = Math.floor(g.w / step), bh = Math.floor(g.h / step);
  const block = (bx: number, by: number): number => by * bw + bx;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (by > 0) {
        out.push({
          pins: Array.from({ length: step }, (_, k) => ({ x: bx * step + k, y: by * step, side: 'N' as const })),
          a: block(bx, by), b: block(bx, by - 1),
        });
      }
      if (bx > 0) {
        out.push({
          pins: Array.from({ length: step }, (_, k) => ({ x: bx * step, y: by * step + k, side: 'W' as const })),
          a: block(bx, by), b: block(bx - 1, by),
        });
      }
    }
  }
  return out;
}

/* ------------------------------- spanning trees ------------------------------- */

const adjacency = (edges: readonly MazeEdge[], nodes: number): number[][] => {
  const adj: number[][] = Array.from({ length: nodes }, () => []);
  edges.forEach((e, i) => { adj[e.a]!.push(i); adj[e.b]!.push(i); });
  return adj;
};

/** RECURSIVE BACKTRACKER (randomised DFS): walks as far as it can before backtracking, so the tree is
 *  long snaking runs — the classic twisty maze, few but long dead ends. Returns the tree's edge ids. */
function backtrackerTree(edges: readonly MazeEdge[], nodes: number, start: number, rng: Rng): Set<number> {
  const adj = adjacency(edges, nodes);
  const tree = new Set<number>();
  const seen = new Uint8Array(nodes);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const n = stack[stack.length - 1]!;
    const options = adj[n]!.filter((i) => { const e = edges[i]!; return seen[e.a === n ? e.b : e.a] === 0; });
    if (!options.length) { stack.pop(); continue; }
    const i = options[nextInt(rng, options.length)]!;
    const e = edges[i]!;
    const next = e.a === n ? e.b : e.a;
    tree.add(i);
    seen[next] = 1;
    stack.push(next);
  }
  return tree;
}

/** RANDOMISED PRIM: grows from a frontier rather than a path, so branches stay short — bushy, with
 *  many short dead ends instead of few long corridors. */
function primTree(edges: readonly MazeEdge[], nodes: number, start: number, rng: Rng): Set<number> {
  const adj = adjacency(edges, nodes);
  const tree = new Set<number>();
  const seen = new Uint8Array(nodes);
  seen[start] = 1;
  const frontier = [...adj[start]!];
  while (frontier.length) {
    const k = nextInt(rng, frontier.length);
    const i = frontier[k]!;
    frontier[k] = frontier[frontier.length - 1]!;
    frontier.pop();
    const e = edges[i]!;
    const inA = seen[e.a] === 1, inB = seen[e.b] === 1;
    if (inA === inB) continue; // both in (a loop) or both out (not growable yet)
    const next = inA ? e.b : e.a;
    tree.add(i);
    seen[next] = 1;
    for (const j of adj[next]!) if (!tree.has(j)) frontier.push(j);
  }
  return tree;
}

/* ------------------------------- the plan ------------------------------- */

export interface MazeParams {
  kind: MazeKind;
  /** Fraction of would-be barriers left open on purpose → loops. 0 = a perfect maze (a tree). */
  braid: number;
  /** Cells per corridor. 1 = a 2u corridor, 2 = a 4u one (the authored mesh width). Default 2. */
  step?: number;
}

export interface MazePlan {
  /** Walls to TRY, in order. The caller's gate still decides each one. */
  order: MazeEdge[];
  note: string;
}

/**
 * Plan which walls to try. Tree strategies wall everything OUTSIDE their spanning tree, so what stays
 * open IS the tree; `scatter` and `kruskal` shuffle every wall and let the gate carve the shape.
 */
export function planMaze(g: CellGrid, rng: Rng, p: MazeParams, startCell = 0): MazePlan {
  if (p.kind === 'none') return { order: [], note: 'no maze' };
  const step = Math.max(1, p.step ?? 2);
  const edges = mazeEdges(g, step);
  const bw = Math.floor(g.w / step), bh = Math.floor(g.h / step);
  const nodes = bw * bh;
  // the carve root is a BLOCK, so translate the caller's cell into one
  const sx = Math.min(bw - 1, Math.floor((startCell % g.w) / step));
  const sy = Math.min(bh - 1, Math.floor(Math.floor(startCell / g.w) / step));
  const start = Math.max(0, sy * bw + sx);

  let candidates: MazeEdge[];
  let note: string;
  if (p.kind === 'backtracker' || p.kind === 'prim') {
    // A carve has to start somewhere the graph reaches. Every in-bounds cell has at least one wall
    // unless the grid is 1x1, but the guard costs nothing and a rootless carve degrades silently to
    // "wall everything" — which is exactly the bug that hid in the 4u version.
    const adj0 = adjacency(edges, nodes);
    const root = adj0[start]!.length > 0 ? start : adj0.findIndex((a) => a.length > 0);
    const tree = p.kind === 'backtracker'
      ? backtrackerTree(edges, nodes, root, rng)
      : primTree(edges, nodes, root, rng);
    candidates = edges.filter((_, i) => !tree.has(i));
    note = `${p.kind} step${step}: ${tree.size} tree edges kept, ${candidates.length} walled`;
  } else {
    candidates = [...edges];
    note = `${p.kind} step${step}: ${candidates.length} barriers considered`;
  }

  // shuffle INDICES then map — never shuffle the objects, so the seeded order stays pure
  const idx = candidates.map((_, i) => i);
  shuffleInPlace(rng, idx);
  const order = idx.map((i) => candidates[i]!);

  // BRAID: drop a fraction so loops survive. Taken off an already-shuffled list, so it is unbiased.
  const drop = Math.min(order.length, Math.round(order.length * Math.max(0, Math.min(1, p.braid))));
  return { order: order.slice(drop), note: `${note}, braid drops ${drop}` };
}
