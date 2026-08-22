import { describe, it, expect } from 'vitest';
import { makeGrid, begin, commit, applyBatch, at as cellAt, type TileGrid } from './tile-grid.ts';
import { template, segs, floors } from './wall-tile-field.ts';
import { gridAt, txAt } from './tile-reach.ts';
import { resolveGrid } from './tile-grid.ts';
import { armBlocks } from './corner-graph.ts';
import {
  crossSeam, pointSeam, allCrossSeams, allPointSeams,
  cohere, stampSeam, readPart, seamDisagreements,
} from './seams.ts';

const W = 4, H = 4;
const g0 = (): TileGrid => makeGrid(W, H);

describe('seams — CROSS seam (2 tiles: the wall line over one boundary)', () => {
  it('names three cells in physical order: A.inner → the shared edge → B.inner', () => {
    const g = g0();
    const s = crossSeam(g, 1, 1, 'E')!;
    expect(s).toEqual([
      { x: 1, y: 1, part: { kind: 'inner', dir: 'E' } },
      { x: 2, y: 1, part: { kind: 'edge', dir: 'W' } }, // shared cell, named via its OWNER
      { x: 2, y: 1, part: { kind: 'inner', dir: 'W' } },
    ]);
  });

  it('addresses the shared edge through the tile that owns it (never a second copy)', () => {
    const east = crossSeam(g0(), 1, 1, 'E')!;
    const south = crossSeam(g0(), 1, 1, 'S')!;
    expect(east[1]!.part).toEqual({ kind: 'edge', dir: 'W' }); // owned by the EAST tile
    expect(south[1]!.part).toEqual({ kind: 'edge', dir: 'N' }); // owned by the SOUTH tile
  });

  it('is null at the map border — there is no second tile there', () => {
    const g = g0();
    expect(crossSeam(g, W - 1, 0, 'E')).toBeNull();
    expect(crossSeam(g, 0, H - 1, 'S')).toBeNull();
  });

  it('enumerates each boundary exactly once (E and S only, never double-counted)', () => {
    const all = allCrossSeams(g0());
    expect(all).toHaveLength(W * (H - 1) + H * (W - 1)); // 12 + 12
    const keys = all.map((s) => s.map((r) => `${r.x},${r.y},${JSON.stringify(r.part)}`).join('|'));
    expect(new Set(keys).size).toBe(all.length);
  });
});

describe('seams — POINT seam (4 tiles: the floor quadrants meeting at one lattice point)', () => {
  it('names the four quadrants that touch an interior point', () => {
    expect(pointSeam(g0(), 2, 2)).toEqual([
      { x: 1, y: 1, part: { kind: 'floor', corner: 'se' } },
      { x: 2, y: 1, part: { kind: 'floor', corner: 'sw' } },
      { x: 1, y: 2, part: { kind: 'floor', corner: 'ne' } },
      { x: 2, y: 2, part: { kind: 'floor', corner: 'nw' } },
    ]);
  });

  it('has fewer members at a border, and exactly one at a map corner', () => {
    expect(pointSeam(g0(), 0, 0)).toHaveLength(1);
    expect(pointSeam(g0(), 0, 2)).toHaveLength(2);
    expect(pointSeam(g0(), W, H)).toHaveLength(1);
  });

  it('covers the whole (w+1)×(h+1) lattice', () => {
    expect(allPointSeams(g0())).toHaveLength((W + 1) * (H + 1));
  });
});

describe('seams — cohere pulls members together WITHOUT overriding a decision', () => {
  it('narrows every member to the intersection when one is available', () => {
    const g = g0();
    // one tile decides its floor quadrant is wood; the other three at that point are still free
    applyBatch(g, [{ region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ floor: { se: floors('wood') } }) }]);
    const seam = pointSeam(g, 2, 2);
    const tx = begin(g);
    expect(cohere(tx, txAt(tx), seam)).toBe(true);
    expect(commit(tx)).toBe(true);
    for (const r of seam) expect(readPart(gridAt(g), r)).toBe(floors('wood')); // all four now agree
  });

  it('leaves a GENUINE disagreement alone — an empty intersection is the author’s call', () => {
    const g = g0();
    applyBatch(g, [
      { region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ floor: { se: floors('wood') } }) },
      { region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ floor: { nw: floors('stone') } }) },
    ]);
    const before = g.cells.map((c) => ({ ...c.floor }));
    const tx = begin(g);
    expect(cohere(tx, txAt(tx), pointSeam(g, 2, 2))).toBe(false); // wood ∩ stone = empty
    expect(commit(tx)).toBe(true);
    g.cells.forEach((c, i) => expect(c.floor).toEqual(before[i])); // untouched
  });

  it('is idempotent — cohering an already-coherent seam changes nothing', () => {
    const g = g0();
    const tx1 = begin(g);
    cohere(tx1, txAt(tx1), pointSeam(g, 2, 2));
    commit(tx1);
    const snapshot = JSON.stringify(g.cells);
    const tx2 = begin(g);
    cohere(tx2, txAt(tx2), pointSeam(g, 2, 2));
    commit(tx2);
    expect(JSON.stringify(g.cells)).toBe(snapshot);
  });
});

describe('seams — stamping the whole CROSS seam is what stops wall stubs', () => {
  it('a seam-stamped wall reaches BOTH tile centres; a one-sided arm does not', () => {
    const wall = segs('wall');

    // seam-stamped: A's inner, the shared edge, and B's inner all wall
    const good = g0();
    const tx = begin(good);
    stampSeam(tx, crossSeam(good, 1, 1, 'E')!, wall);
    expect(commit(tx)).toBe(true);
    const gt = resolveGrid(good);
    const a = gt[1 * W + 1]!, b = gt[1 * W + 2]!;
    expect(a.inner.E).toBe('wall');
    expect(a.edge.E).toBe('wall');
    expect(b.inner.W).toBe('wall'); // the partner half — this is the bit a one-sided stamp misses
    expect(armBlocks(a.edge.E, a.inner.E)).toBe(true);
    expect(armBlocks(b.edge.W, b.inner.W)).toBe(true);

    // one-sided: only A's arm
    const stub = g0();
    applyBatch(stub, [{ region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ inner: { E: wall } }) }]);
    const st = resolveGrid(stub);
    expect(st[1 * W + 1]!.inner.E).toBe('wall');
    expect(st[1 * W + 2]!.inner.W).toBe('none'); // partner settles to nothing → the wall ends mid-air
  });
});

describe('seams — seamDisagreements is a real detector (negative control)', () => {
  it('finds nothing on a blank grid', () => {
    const g = g0();
    expect(seamDisagreements(g, gridAt(g))).toHaveLength(0);
  });

  it('finds a planted point-seam disagreement, and reports it as `point`', () => {
    const g = g0();
    applyBatch(g, [
      { region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ floor: { se: floors('wood') } }) },
      { region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ floor: { nw: floors('dirt') } }) },
    ]);
    const d = seamDisagreements(g, gridAt(g));
    expect(d.length).toBeGreaterThan(0);
    expect(d.some((x) => x.kind === 'point')).toBe(true);
  });

  it('finds a planted cross-seam disagreement, and reports it as `cross`', () => {
    const g = g0();
    applyBatch(g, [
      { region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ inner: { E: segs('wall') } }) },
      { region: { x: 2, y: 1, w: 1, h: 1 }, stamp: template({ inner: { W: segs('none') } }) },
    ]);
    const d = seamDisagreements(g, gridAt(g));
    expect(d.some((x) => x.kind === 'cross')).toBe(true);
  });
});

describe('seams — the grid accessor round-trips', () => {
  it('readPart reads back what stampPart wrote, for all three part kinds', () => {
    const g = g0();
    const tx = begin(g);
    stampSeam(tx, [{ x: 0, y: 0, part: { kind: 'inner', dir: 'N' } }], segs('barrier'));
    stampSeam(tx, [{ x: 0, y: 0, part: { kind: 'edge', dir: 'W' } }], segs('wall'));
    stampSeam(tx, [{ x: 0, y: 0, part: { kind: 'floor', corner: 'nw' } }], floors('dirt'));
    commit(tx);
    const f = cellAt(g, 0, 0)!;
    expect(f.inner.N).toBe(segs('barrier'));
    expect(f.edge.W).toBe(segs('wall'));
    expect(f.floor.nw).toBe(floors('dirt'));
  });
});
