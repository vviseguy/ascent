// ============================================================================
// src/floor/maze.ts — maze strategies over the CORNER graph.
// ============================================================================
//
// The walkable space is the corner lattice (corner-graph.ts), so a maze here is a spanning structure
// over CORNERS, and its "walls between cells" are CROSS SEAMS (seams.ts) — one seam is exactly one
// corner-pair connection, because the seam's three cells cover both flanking arms at once.
//
//   maze graph:  nodes = corners (w+1)×(h+1)      edges = cross seams
//
// Every strategy below produces the same thing — an ORDER in which to try walling seams — and the
// caller's gate decides what is actually allowed. That keeps the solvability machinery untouched: a
// strategy proposes, `emergent.ts` disposes.
//
// THE ONE THAT MATTERS. `scatter` (what we had) walls a seam if the TARGETS stay reachable. A real
// maze algorithm maintains connectivity over EVERY cell, and that difference is the whole dead-space
// problem: a wall that seals off a quarter of the floor passes a target-only gate, because nobody
// asked about the sealed quarter. `kruskal` below is the same loop with "no corner may be lost" as
// the gate — which is Kruskal's algorithm with the test inverted (Kruskal REMOVES a wall when it
// joins two components; we ADD one when it splits none).
//
// BRAIDING IS NOT OPTIONAL HERE. A perfect maze is a spanning tree: exactly one path between any two
// points, so no route choice, no shortcuts, no overtaking. ASCENT is a race. `braid` is the fraction
// of would-be walls deliberately left open, turning the tree back into a graph with loops.
//
// Deterministic: seeded shuffles over index arrays, fixed enumeration order, no float / no Map
// iteration on an output-affecting path.

import { shuffleInPlace, nextInt, type Rng } from './rng.ts';
import { armCorners } from './tile-reach.ts';
import { crossSeam, type CellRef } from './seams.ts';
import { cornerCount } from './corner-graph.ts';
import type { TileGrid } from './tile-grid.ts';

export const MAZE_KINDS = ['none', 'scatter', 'kruskal', 'backtracker', 'prim'] as const;
export type MazeKind = (typeof MAZE_KINDS)[number];

/** One candidate wall: the seam to stamp and the two corners it would separate. */
export interface MazeEdge {
  seam: CellRef[];
  a: number;
  b: number;
}

/** Every cross seam on the grid, paired with the corner connection it controls. Fixed order. */
export function mazeEdges(g: TileGrid): MazeEdge[] {
  const out: MazeEdge[] = [];
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      for (const d of ['E', 'S'] as const) {
        const seam = crossSeam(g, x, y, d);
        if (!seam) continue;
        const [a, b] = armCorners(g.w, x, y, d);
        out.push({ seam, a, b });
      }
    }
  }
  return out;
}

/* ------------------------------- spanning trees ------------------------------- */

/** Adjacency over corners, from the candidate edge list (index into `edges`). */
function adjacency(edges: readonly MazeEdge[], nodes: number): number[][] {
  const adj: number[][] = Array.from({ length: nodes }, () => []);
  edges.forEach((e, i) => { adj[e.a]!.push(i); adj[e.b]!.push(i); });
  return adj;
}

/**
 * RECURSIVE BACKTRACKER (randomised DFS). Walks as far as it can before backtracking, so the tree is
 * made of long snaking runs — the classic twisty maze with few, long dead ends.
 * Returns the set of edge indices that are IN the tree (i.e. must stay open).
 */
function backtrackerTree(edges: readonly MazeEdge[], nodes: number, start: number, rng: Rng): Set<number> {
  const adj = adjacency(edges, nodes);
  const tree = new Set<number>();
  const seen = new Uint8Array(nodes);
  const stack: number[] = [start];
  seen[start] = 1;
  while (stack.length) {
    const n = stack[stack.length - 1]!;
    const options = adj[n]!.filter((i) => {
      const e = edges[i]!;
      return seen[e.a === n ? e.b : e.a] === 0;
    });
    if (options.length === 0) { stack.pop(); continue; }
    const i = options[nextInt(rng, options.length)]!;
    const e = edges[i]!;
    const next = e.a === n ? e.b : e.a;
    tree.add(i);
    seen[next] = 1;
    stack.push(next);
  }
  return tree;
}

/**
 * RANDOMISED PRIM. Grows from a frontier rather than a path, so branches stay short and the maze is
 * bushy — many short dead ends instead of few long corridors.
 */
function primTree(edges: readonly MazeEdge[], nodes: number, start: number, rng: Rng): Set<number> {
  const adj = adjacency(edges, nodes);
  const tree = new Set<number>();
  const seen = new Uint8Array(nodes);
  seen[start] = 1;
  const frontier: number[] = [...adj[start]!];
  while (frontier.length) {
    const k = nextInt(rng, frontier.length);
    const i = frontier[k]!;
    frontier[k] = frontier[frontier.length - 1]!;
    frontier.pop();
    const e = edges[i]!;
    const inA = seen[e.a] === 1, inB = seen[e.b] === 1;
    if (inA === inB) continue; // both in (would make a loop) or both out (not yet growable)
    const next = inA ? e.b : e.a;
    tree.add(i);
    seen[next] = 1;
    for (const j of adj[next]!) if (!tree.has(j)) frontier.push(j);
  }
  return tree;
}

/* ------------------------------- the strategy ------------------------------- */

export interface MazePlan {
  /** Seams to TRY walling, in order. The caller's gate still decides each one. */
  order: MazeEdge[];
  /** Human-readable note for stats/debugging. */
  note: string;
}

export interface MazeParams {
  kind: MazeKind;
  /** Fraction of would-be walls left open on purpose → loops. 0 = perfect maze (a tree), 1 = no walls.
   *  A race needs loops: a tree has exactly one path between any two points. */
  braid: number;
}

/**
 * Plan which seams to try walling. Tree strategies wall everything OUTSIDE their spanning tree (so
 * what survives is the tree — the maze); `scatter` and `kruskal` just shuffle every seam and let the
 * caller's gate carve the shape.
 */
export function planMaze(g: TileGrid, rng: Rng, p: MazeParams, start = 0): MazePlan {
  const edges = mazeEdges(g);
  const nodes = cornerCount(g.w, g.h);
  if (p.kind === 'none') return { order: [], note: 'no maze' };

  let candidates: MazeEdge[];
  let note: string;
  if (p.kind === 'backtracker' || p.kind === 'prim') {
    // A carve must start somewhere the seam graph actually reaches. The four MAP CORNERS touch no
    // cross seam at all — each of their corner-pairs has only one flanking tile, so no seam controls
    // them (which is also why the perimeter ring always stays open). Starting there would walk
    // nowhere and return an empty tree, silently degrading the strategy to "wall everything".
    const adj0 = adjacency(edges, nodes);
    const root = adj0[start]!.length > 0 ? start : adj0.findIndex((a) => a.length > 0);
    const tree = p.kind === 'backtracker'
      ? backtrackerTree(edges, nodes, root, rng)
      : primTree(edges, nodes, root, rng);
    // wall everything the tree does not need; what remains open IS the tree
    candidates = edges.filter((_, i) => !tree.has(i));
    note = `${p.kind}: ${tree.size} tree edges kept, ${candidates.length} walled`;
  } else {
    candidates = [...edges];
    note = `${p.kind}: ${candidates.length} seams considered`;
  }

  // deterministic shuffle over INDICES, then map (never shuffle objects — keeps the seeded order pure)
  const idx = candidates.map((_, i) => i);
  shuffleInPlace(rng, idx);
  const order = idx.map((i) => candidates[i]!);

  // BRAID: drop a fraction of the walls so loops survive. Taken off the front of an already-shuffled
  // list, so it is an unbiased sample.
  const keepFrom = Math.min(order.length, Math.round(order.length * Math.max(0, Math.min(1, p.braid))));
  return { order: order.slice(keepFrom), note: `${note}, braid drops ${keepFrom}` };
}
