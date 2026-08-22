import { describe, it, expect } from 'vitest';
import { generateEmergent, resolveEmergent } from './cell-emergent.ts';
import { buildCellGraph, reachableFrom, nodeId } from './cell-graph.ts';
import { hasConflict, domainSize, FIELD_KEYS } from './cell-field.ts';
import { listStructures, getStructure } from './cell-structures.ts';
import { planMaze, mazeEdges, MAZE_KINDS, type MazeKind } from './cell-maze.ts';
import { makeGrid } from './cell-grid.ts';
import { orientedSize, ORIENTATIONS } from './cell-orient.ts';
import { makeRng } from './rng.ts';
import type { Cell } from './cell.ts';

const W = 30, H = 24;
const SEEDS = [3n, 23n, 101n];
const run = (seed: bigint, maze?: { kind: MazeKind; braid: number; step?: number }) =>
  generateEmergent({ width: W, height: H, seed, ...(maze ? { maze } : {}) });

describe('cell-maze — the edge set is the walls themselves', () => {
  it('lists every shared wall exactly once', () => {
    const g = makeGrid(6, 5);
    // interior walls: (w-1)*h vertical + w*(h-1) horizontal
    expect(mazeEdges(g)).toHaveLength((6 - 1) * 5 + 6 * (5 - 1));   // step 1 = one wall each
    const keys = mazeEdges(g).map((e) => e.pins.map((q) => `${q.x},${q.y},${q.side}`).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a tree strategy proposes FEWER walls than considering every one', () => {
    const g = makeGrid(10, 10);
    const all = planMaze(g, makeRng(1n), { kind: 'kruskal', braid: 0 }).order.length;
    const tree = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 }).order.length;
    expect(tree).toBeLessThan(all);
    expect(tree).toBeGreaterThan(0); // a rootless carve would silently propose everything
  });

  it('braid opens DEAD ENDS rather than dropping walls at random', () => {
    const g = makeGrid(16, 16);
    const none = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0 });
    const some = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0.5 });
    const all = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 1 });
    // more braid ⇒ strictly fewer walls, because each opened dead end spares one
    expect(some.order.length).toBeLessThan(none.order.length);
    expect(all.order.length).toBeLessThan(some.order.length);
    expect(none.note).toContain('no braid');
    expect(all.note).toContain('dead ends opened');
    // and it is bounded by the number of dead ends, NOT by a fraction of every wall — the whole point,
    // since dropping walls at random is what merged parallel corridors into open halls
    expect(none.order.length - all.order.length).toBeLessThan(none.order.length * 0.5);
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
        // stamped WHOLE, never cropped: the region is the stored POINT lattice (floor extent + 1),
        // with the axes swapped by an odd quarter-turn
        const st = getStructure(p.name)!;
        const { w: ow, h: oh } = orientedSize(st.w, st.h, p.orientation);
        expect(p.region.w).toBe(ow + 1);
        expect(p.region.h).toBe(oh + 1);
      }
    }
  });

  it('all eight orientations really get used', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const p of run(BigInt(i * 13 + 1)).placed) {
        seen.add(`${p.orientation.turn}${p.orientation.flip ? 'F' : ''}`);
      }
    }
    expect(seen.size).toBe(ORIENTATIONS.length); // a catalog of N places as 8N
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

  it('corridors are 2 cells — 4u — wide, the width the meshes were authored for', () => {
    const g = makeGrid(12, 12);
    const oneWide = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0, step: 1 });
    const twoWide = planMaze(g, makeRng(1n), { kind: 'backtracker', braid: 0, step: 2 });
    expect(oneWide.order.every((e) => e.pins.length === 1)).toBe(true);
    expect(twoWide.order.every((e) => e.pins.length === 2)).toBe(true);
    // a barrier's two walls are collinear and adjacent — one continuous 4u run, never an L
    for (const e of twoWide.order) {
      const [a, b] = e.pins as [{ x: number; y: number; side: string }, { x: number; y: number; side: string }];
      expect(a.side).toBe(b.side);
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
    }
  });

  it('FILL: what the maze seals off becomes solid rock, not unreachable room', () => {
    // the strong gate seals nothing off, so the fallback has nothing to do…
    expect(run(23n).stats.cellsFilled).toBe(0);
    // …and the weak one strands plenty, which is exactly what it is for
    const weak = run(23n, { kind: 'scatter', braid: 0 });
    expect(weak.stats.cellsFilled).toBeGreaterThan(0);
    const cells = resolveEmergent(weak, 23n) as (Cell | null)[];
    const seen = reachableFrom(buildCellGraph(cells, W, H), weak.entry);
    // every filled cell is unreachable, and no reachable cell was filled
    let rock = 0;
    cells.forEach((c, i) => {
      if (!c || c.floor !== 'rock') return;
      rock++;
      expect(seen[i]).toBe(false);
    });
    expect(rock).toBe(weak.stats.cellsFilled);
  });

  it('a rock cell is not a place — it contributes no edges even with no walls around it', () => {
    const solid: Cell = { floor: 'rock', wallN: 'none', wallW: 'none', corner: 'solid', wallType: 'solid' };
    const open: Cell = { floor: 'stone', wallN: 'none', wallW: 'none', corner: 'solid', wallType: 'solid' };
    const cells = [open, solid, open, open, open, open, open, open, open]; // 3x3, (1,0) is rock
    const g = buildCellGraph(cells, 3, 3);
    expect(g.adj[nodeId(3, 1, 0)]).toHaveLength(0);
  });

  it('doors are DISCOVERED — some perimeter walls refuse to seal', () => {
    for (const seed of SEEDS) {
      const s = run(seed).stats;
      expect(s.ringSealed).toBeGreaterThan(0); // most of the ring closes…
      expect(s.doorsKept).toBeGreaterThan(0);  // …and what refuses is the way in
    }
  });
});
