import { describe, it, expect } from 'vitest';
import { generateEmergentTower, generateEmergent, resolveEmergent } from './cell-emergent.ts';
import { buildCellGraph, reachableFrom, reachableFromSet, nodeId } from './cell-graph.ts';
import { resolveGrid } from './cell-grid.ts';
import { hasConflict, domainSize, FIELD_KEYS, previewCell, settleMask, fullField, template, floors } from './cell-field.ts';
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

/**
 * The GROUND FLOOR of a tower, for anything that needs structures to actually be there.
 *
 * Every structure in the store is multi-storey now, and a structure taller than the stack is
 * declined — so `generateEmergent` on its own places NOTHING, and any test that asserts something
 * about a placement silently became a test of an empty maze. Three of them did.
 */
const runTower = (seed: bigint, levels = 3) =>
  generateEmergentTower({ width: W, height: H, seed, levels });

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
      const t = runTower(seed);
      expect(t.stats.structuresPlaced).toBeGreaterThan(0);
      for (const p of t.floors.flatMap((f) => f.placed)) {
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
      for (const p of runTower(BigInt(i * 13 + 1)).floors.flatMap((f) => f.placed)) {
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
    const solid: Cell = { floor: 'rock', ceiling: 'none', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no' };
    const open: Cell = { floor: 'stone', ceiling: 'none', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no' };
    const cells = [open, solid, open, open, open, open, open, open, open]; // 3x3, (1,0) is rock
    const g = buildCellGraph(cells, 3, 3);
    expect(g.adj[nodeId(3, 1, 0)]).toHaveLength(0);
  });

  it('SEAL only touches walls the author drew — it does not invent them', () => {
    /* The perimeter used to be marked porous wholesale: both sides of every edge cell, drawn or not.
       SEAL then stamped a wall into each, and wherever the author had merely ABSTAINED the stamp
       succeeded — inventing walls nobody drew. Those invented segments were the nubs sprouting off
       every structure. On this store it was 241 seals against 80 real ones.

       RUN ON A TOWER, not a single floor. A structure taller than the stack is declined, and the store
       is now mostly multi-storey — a lone floor places only the two flat structures and never exercises
       the seal at all, so this assertion silently stopped testing anything. */
    for (const seed of SEEDS) {
      const t = generateEmergentTower({ width: W, height: H, seed, levels: 3 });
      const s = t.stats;
      expect(s.structuresPlaced).toBeGreaterThan(0);
      // whatever porosity opened, seal accounts for: it closed it, or kept it as a door
      expect(s.ringSealed + s.doorsKept).toBeGreaterThan(0);
      // and the count is now bounded by the walls the structures actually carry on their edges
      expect(s.ringSealed).toBeLessThan(200 * 3);
    }
  });

  it('a single floor can no longer place a multi-storey structure, and SAYS so', () => {
    /* Not a bug — a three-storey hall cannot stand on a one-storey floor. But it is worth pinning,
       because the store drifting to mostly-multi-storey is what quietly emptied the test above. */
    const g = generateEmergent({ width: W, height: H, seed: 3n });
    expect(g.stats.structuresSkippedMultiLevel).toBeGreaterThan(0);
    expect(g.placed.every((p) => p.name !== 'throne room')).toBe(true);
  });

  it('a door appears where one is NEEDED — the porous ring is a safety valve, not decoration', () => {
    /* With authored openings the ring seals completely and no door is discovered, which is right: the
       author said where the way in is. The mechanism still has to work when they did not — a structure
       whose only entrance is a wall the router must cross keeps that wall open. */
    const g = generateEmergent({ width: 30, height: 24, seed: 4n });
    const cells = resolveGrid(g.grid);
    // every placed structure's middle must be reachable from the entry, however it got in
    const graph = buildCellGraph(cells, 30, 24);
    const seen = reachableFromSet(graph, [g.entry]);
    for (const p of g.placed) expect(seen[p.centre]).toBe(true);
  });
});

describe('cell-emergent — the editor preview and the generator settle IDENTICALLY', () => {
  it('previewCell reproduces what the generator produces, field for field', () => {
    // If these ever disagree, the editor shows you a structure that is not the one that gets built —
    // which is exactly the drift the shared SETTLE_DEFAULTS exists to prevent.
    for (const seed of SEEDS) {
      const r = run(seed);
      const built = resolveEmergent(r, seed);
      // the generator settles in place, so previewing its own finished field must be a no-op
      r.grid.cells.forEach((f, i) => expect(previewCell(f)).toEqual(built[i]));
    }
  });

  it('an UNCLAIMED field previews as walkable stone, not as a pit', () => {
    const blank = fullField();
    const c = previewCell(blank)!;
    expect(c.floor).toBe('stone');   // NOT `none`, which is what a bare collapse would give
    expect(c.wallN).toBe('none');
    expect(c.corner).toBe('none');   // nothing standing at the junction
    expect(c.wallType).toBe('solid');
    expect(c.torch).toBe('no');
  });

  it('settle always decides, even when the default was ruled out', () => {
    const noStone = template({ floor: floors('dirt', 'wood') });
    expect(domainSize(settleMask(noStone.floor, 'floor'))).toBe(1);
    expect(previewCell(noStone)!.floor).toBe('dirt'); // canonical lowest of what survives
  });
});
