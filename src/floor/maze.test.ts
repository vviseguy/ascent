import { describe, it, expect } from 'vitest';
import { generateEmergent, resolveEmergent } from './emergent.ts';
import { buildCornerGraph, reachableFromSet, cornerCount } from './corner-graph.ts';
import { planMaze, mazeEdges, MAZE_KINDS, type MazeKind } from './maze.ts';
import { makeGrid } from './tile-grid.ts';
import { makeRng } from './rng.ts';

const W = 12, H = 10;
const CARVERS: MazeKind[] = ['kruskal', 'backtracker', 'prim'];

const measure = (kind: MazeKind, braid: number, seed: bigint) => {
  const r = generateEmergent({ width: W, height: H, seed, maze: { kind, braid } });
  const tiles = resolveEmergent(r, seed);
  const g = buildCornerGraph(tiles, W, H);
  const seen = reachableFromSet(g, [r.entryCorner]);
  const V = cornerCount(W, H);
  const reachable = seen.filter(Boolean).length;
  let E = 0, deadEnds = 0;
  for (let n = 0; n < V; n++) {
    if (!seen[n]) continue;
    const deg = g.adj[n]!.filter((m) => seen[m]).length;
    E += deg;
    if (deg === 1) deadEnds++;
  }
  return { reachable, V, loops: E / 2 - reachable + 1, deadEnds, walls: r.stats.wallsPlaced };
};

describe('maze — the edge set is the CROSS SEAMS, one per corner connection', () => {
  it('every maze edge names a distinct corner pair', () => {
    const edges = mazeEdges(makeGrid(W, H));
    const keys = edges.map((e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`);
    expect(new Set(keys).size).toBe(edges.length);
  });

  it('a tree strategy plans FEWER walls than considering every seam', () => {
    const g = makeGrid(W, H);
    const all = planMaze(g, makeRng(1n), { kind: 'kruskal', braid: 0 }).order.length;
    const tree = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 }).order.length;
    expect(tree).toBeLessThan(all); // the tree's own edges are never proposed for walling
  });

  it('braid drops walls in proportion', () => {
    const g = makeGrid(W, H);
    const none = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 }).order.length;
    const half = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0.5 }).order.length;
    expect(half).toBeCloseTo(none * 0.5, -1);
  });

  it('is deterministic per strategy', () => {
    for (const kind of MAZE_KINDS) {
      const a = planMaze(makeGrid(W, H), makeRng(7n), { kind, braid: 0.2 });
      const b = planMaze(makeGrid(W, H), makeRng(7n), { kind, braid: 0.2 });
      expect(JSON.stringify(a.order)).toBe(JSON.stringify(b.order));
    }
  });
});

describe('maze — THE invariant a real maze keeps that a target-only gate does not', () => {
  it('every carver leaves most of the floor reachable; `scatter` demonstrably does not', () => {
    for (const seed of [3n, 23n, 101n]) {
      for (const kind of CARVERS) {
        expect(measure(kind, 0.15, seed).reachable / cornerCount(W, H)).toBeGreaterThan(0.85);
      }
      // THE CONTROL: the old target-only gate seals off half the floor and still "passes" its own gate
      expect(measure('scatter', 0, seed).reachable / cornerCount(W, H)).toBeLessThan(0.7);
    }
  });

  it('the DFS carvers are the tightest — backtracker and prim leave ≥95%', () => {
    for (const seed of [3n, 23n, 101n]) {
      for (const kind of ['backtracker', 'prim'] as MazeKind[]) {
        expect(measure(kind, 0.15, seed).reachable / cornerCount(W, H)).toBeGreaterThan(0.95);
      }
    }
  });
});

describe('maze — braiding buys route choice, which is what a RACE needs', () => {
  it('more braid ⇒ more independent loops and fewer dead ends', () => {
    let loLoops = 0, hiLoops = 0, loDead = 0, hiDead = 0;
    for (const seed of [3n, 23n, 101n]) {
      const lo = measure('backtracker', 0, seed);
      const hi = measure('backtracker', 0.3, seed);
      loLoops += lo.loops; hiLoops += hi.loops;
      loDead += lo.deadEnds; hiDead += hi.deadEnds;
    }
    expect(hiLoops).toBeGreaterThan(loLoops);
    expect(hiDead).toBeLessThan(loDead);
  });

  it('backtracker beats kruskal on both metrics that matter for a race', () => {
    let btLoops = 0, krLoops = 0, btDead = 0, krDead = 0;
    for (const seed of [3n, 23n, 101n]) {
      const bt = measure('backtracker', 0.15, seed);
      const kr = measure('kruskal', 0.15, seed);
      btLoops += bt.loops; krLoops += kr.loops;
      btDead += bt.deadEnds; krDead += kr.deadEnds;
    }
    expect(btLoops).toBeGreaterThan(krLoops); // more route choice
    expect(btDead).toBeLessThan(krDead); // fewer pointless detours
  });
});
