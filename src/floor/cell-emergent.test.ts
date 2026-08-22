import { describe, it, expect } from 'vitest';
import { generateEmergent, resolveEmergent } from './cell-emergent.ts';
import { buildCellGraph, reachableFrom, nodeId } from './cell-graph.ts';
import { hasConflict, domainSize, FIELD_KEYS } from './cell-field.ts';
import { listStructures, getStructure } from './cell-structures.ts';
import { planMaze, mazeEdges, MAZE_KINDS, type MazeKind } from './cell-maze.ts';
import { makeGrid } from './cell-grid.ts';
import { makeRng } from './rng.ts';
import type { Cell } from './cell.ts';

const W = 30, H = 24;
const SEEDS = [3n, 23n, 101n];
const run = (seed: bigint, maze?: { kind: MazeKind; braid: number }) =>
  generateEmergent({ width: W, height: H, seed, ...(maze ? { maze } : {}) });

describe('cell-maze — the edge set is the walls themselves', () => {
  it('lists every shared wall exactly once', () => {
    const g = makeGrid(6, 5);
    // interior walls: (w-1)*h vertical + w*(h-1) horizontal
    expect(mazeEdges(g)).toHaveLength((6 - 1) * 5 + 6 * (5 - 1));
    const keys = mazeEdges(g).map((e) => `${e.pin.x},${e.pin.y},${e.pin.side}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a tree strategy proposes FEWER walls than considering every one', () => {
    const g = makeGrid(10, 10);
    const all = planMaze(g, makeRng(1n), { kind: 'kruskal', braid: 0 }).order.length;
    const tree = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 }).order.length;
    expect(tree).toBeLessThan(all);
    expect(tree).toBeGreaterThan(0); // a rootless carve would silently propose everything
  });

  it('braid drops walls in proportion', () => {
    const g = makeGrid(10, 10);
    const none = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 }).order.length;
    const half = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0.5 }).order.length;
    expect(half).toBeCloseTo(none * 0.5, -1);
  });

  it('every strategy is deterministic', () => {
    for (const kind of MAZE_KINDS) {
      const a = planMaze(makeGrid(8, 8), makeRng(7n), { kind, braid: 0.2 });
      const b = planMaze(makeGrid(8, 8), makeRng(7n), { kind, braid: 0.2 });
      expect(JSON.stringify(a.order)).toBe(JSON.stringify(b.order));
    }
  });
});

describe('cell-emergent — the field ends fully DETERMINED', () => {
  it.each(SEEDS)('seed %s — every cell collapses, and nothing is left undecided', (seed) => {
    const r = run(seed);
    expect(r.grid.cells.every((f) => !hasConflict(f))).toBe(true);
    for (const f of r.grid.cells) {
      for (const k of FIELD_KEYS) expect(domainSize(f[k])).toBe(1);
    }
  });

  it.each(SEEDS)('seed %s — the output does not depend on the collapse pick', (seed) => {
    const r = run(seed);
    const a = JSON.stringify(resolveEmergent(r, seed));
    const b = JSON.stringify(resolveEmergent(r, seed + 999n)); // a different pick seed
    expect(a).toBe(b); // fully settled ⇒ nothing left for the pick to choose
  });

  it.each(SEEDS)('seed %s — identical inputs give a byte-identical floor', (seed) => {
    expect(JSON.stringify(run(seed).grid)).toBe(JSON.stringify(run(seed).grid));
  });
});

describe('cell-emergent — SOLVABILITY, agreed by an independent walk of the collapsed cells', () => {
  it.each(SEEDS)('seed %s — the exit and every structure are reachable from the entry', (seed) => {
    const r = run(seed);
    const cells = resolveEmergent(r, seed) as (Cell | null)[];
    const seen = reachableFrom(buildCellGraph(cells, W, H), r.entry);
    expect(seen[r.exit]).toBe(true);
    for (const p of r.placed) expect(seen[p.centre]).toBe(true);
  });

  it.each(SEEDS)('seed %s — the whole floor stays reachable, not just the targets', (seed) => {
    const r = run(seed);
    const cells = resolveEmergent(r, seed) as (Cell | null)[];
    const seen = reachableFrom(buildCellGraph(cells, W, H), r.entry);
    expect(seen.filter(Boolean).length / (W * H)).toBeGreaterThan(0.95);
  });

  it('NEGATIVE CONTROL: a target-only gate strands a large part of the floor', () => {
    const r = run(23n, { kind: 'scatter', braid: 0 });
    const cells = resolveEmergent(r, 23n) as (Cell | null)[];
    const seen = reachableFrom(buildCellGraph(cells, W, H), r.entry);
    expect(seen.filter(Boolean).length / (W * H)).toBeLessThan(0.9);
  });
});

describe('cell-emergent — structures are the ONLY rooms, and they land as authored', () => {
  it('places structures from the authored store and nothing else', () => {
    const known = new Set(listStructures());
    for (const seed of SEEDS) {
      const r = run(seed);
      expect(r.stats.structuresPlaced).toBeGreaterThan(0);
      for (const p of r.placed) {
        expect(known.has(p.name)).toBe(true);
        const st = getStructure(p.name)!;
        expect(p.region.w).toBe(st.w); // stamped whole, never cropped
        expect(p.region.h).toBe(st.h);
      }
    }
  });

  it('placed structures never overlap', () => {
    for (const seed of SEEDS) {
      const { placed } = run(seed);
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]!.region, b = placed[j]!.region;
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
        }
      }
    }
  });

  it('THE MAZE NEVER TRESPASSES — a room interior is identical with and without it', () => {
    const interiorWalls = (seed: bigint, maze?: { kind: MazeKind; braid: number }): number => {
      const r = run(seed, maze);
      const cells = resolveEmergent(r, seed) as (Cell | null)[];
      let n = 0;
      for (const p of r.placed) {
        for (let y = p.region.y + 1; y < p.region.y + p.region.h - 1; y++) {
          for (let x = p.region.x + 1; x < p.region.x + p.region.w - 1; x++) {
            const c = cells[y * W + x];
            if (!c) continue;
            if (c.wallN !== 'none') n++;
            if (c.wallW !== 'none') n++;
          }
        }
      }
      return n;
    };
    for (const seed of SEEDS) {
      // identical counts ⇒ every wall inside a room is the AUTHOR'S, none is the maze's
      expect(interiorWalls(seed)).toBe(interiorWalls(seed, { kind: 'none', braid: 0 }));
    }
  });

  it('the gates actually fire — a run that accepted everything would prove nothing', () => {
    let refused = 0;
    for (const seed of SEEDS) {
      const s = run(seed).stats;
      refused += s.wallsRejectedUnreachable + s.wallsRejectedConflict + s.structuresRejectedOverlap;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('doors are DISCOVERED — some perimeter walls refuse to seal', () => {
    for (const seed of SEEDS) {
      const s = run(seed).stats;
      expect(s.ringSealed).toBeGreaterThan(0); // most of the ring closes…
      expect(s.doorsKept).toBeGreaterThan(0);  // …and what refuses is the way in
    }
  });
});
