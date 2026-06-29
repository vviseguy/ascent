import { describe, it, expect } from 'vitest';
import { buildCornerGraph, cornerGraphOf, cornerId, reachableFrom, cornerReachable, armBlocks } from './corner-graph.ts';
import type { WallTile, Seg } from './wall-tile.ts';
import { makeGrid, applyBatch } from './tile-grid.ts';
import { template, segs } from './wall-tile-field.ts';

/** A concrete tile with the given arm cells (everything else `none`, solid, floorless). */
const T = (o: Partial<Record<'eN' | 'eE' | 'eS' | 'eW' | 'iN' | 'iE' | 'iS' | 'iW', Seg>> = {}): WallTile => ({
  floor: { nw: 'none', ne: 'none', sw: 'none', se: 'none' },
  edge: { N: o.eN ?? 'none', E: o.eE ?? 'none', S: o.eS ?? 'none', W: o.eW ?? 'none' },
  inner: { N: o.iN ?? 'none', E: o.iE ?? 'none', S: o.iS ?? 'none', W: o.iW ?? 'none' },
  centre: 'none',
  wallType: 'solid',
});
const OPEN = (): WallTile => T();

describe('corner-graph — armBlocks predicate', () => {
  it('only a full-height wall on BOTH cells seals the arm', () => {
    expect(armBlocks('wall', 'wall')).toBe(true);
    expect(armBlocks('wall', 'none')).toBe(false); // partial → gap near centre
    expect(armBlocks('none', 'wall')).toBe(false); // partial → gap near boundary
    expect(armBlocks('barrier', 'barrier')).toBe(false); // low → surmountable
    expect(armBlocks('none', 'none')).toBe(false);
  });
});

describe('corner-graph — connectivity', () => {
  it('an all-open grid connects every corner', () => {
    const g = buildCornerGraph([OPEN(), OPEN(), OPEN(), OPEN()], 2, 2);
    const seen = reachableFrom(g, cornerId(2, 0, 0));
    expect(seen.every(Boolean)).toBe(true); // all 3×3 = 9 corner nodes reached
    expect(seen).toHaveLength(9);
  });

  it('a vertical wall (full N+S arms) splits one tile into a west pair and an east pair', () => {
    // 1×1 tile, N and S arms full → NW–NE and SE–SW blocked; E and W open.
    const g = buildCornerGraph([T({ eN: 'wall', iN: 'wall', eS: 'wall', iS: 'wall' })], 1, 1);
    const nw = cornerId(1, 0, 0), ne = cornerId(1, 1, 0), se = cornerId(1, 1, 1), sw = cornerId(1, 0, 1);
    expect(cornerReachable(g, nw, sw)).toBe(true); // joined down the W side
    expect(cornerReachable(g, ne, se)).toBe(true); // joined down the E side
    expect(cornerReachable(g, nw, ne)).toBe(false); // the vertical wall separates W from E
    expect(cornerReachable(g, sw, se)).toBe(false);
  });

  it('a partial arm (edge wall, inner none) leaves the connection open', () => {
    const g = buildCornerGraph([T({ eN: 'wall' })], 1, 1); // N arm partial
    expect(cornerReachable(g, cornerId(1, 0, 0), cornerId(1, 1, 0))).toBe(true);
  });
});

describe('corner-graph — two routes per boundary (the flanking-tile pair)', () => {
  // 1×2 grid: T0 (north) over T1 (south). The shared boundary is corner-pair (0,1)–(1,1).
  const P = cornerId(1, 0, 1), Q = cornerId(1, 1, 1); // = nodes 2 and 3
  const linked = (north: WallTile, south: WallTile): boolean =>
    buildCornerGraph([north, south], 1, 2).adj[P]!.includes(Q);

  it('blocking the route through the NORTH tile still connects via the SOUTH tile', () => {
    // T0.S arm full (route through T0 blocked); T1 open (route through T1 open)
    expect(linked(T({ eS: 'wall', iS: 'wall' }), OPEN())).toBe(true);
  });

  it('blocking the SOUTH route still connects via the NORTH tile', () => {
    expect(linked(OPEN(), T({ eN: 'wall', iN: 'wall' }))).toBe(true);
  });

  it('only when BOTH flanking arms are full is the corner-pair directly severed', () => {
    expect(linked(T({ eS: 'wall', iS: 'wall' }), T({ eN: 'wall', iN: 'wall' }))).toBe(false);
  });
});

describe('corner-graph — cornerGraphOf (resolved grid → graph)', () => {
  it('perimeter edge walls (edge only, inner none) do NOT seal the interior', () => {
    // resolveGrid forces the E/S map borders to PERIMETER wall (edge=wall, inner=none) → partial arms,
    // so an otherwise-open grid stays fully connected.
    const grid = makeGrid(2, 2);
    const g = cornerGraphOf(grid);
    expect(reachableFrom(g, cornerId(2, 0, 0)).every(Boolean)).toBe(true);
  });

  it('a full wall on BOTH flanking tiles severs the DIRECT corner-pair (still reachable around)', () => {
    // 2×1 grid; seal the shared boundary fully: the owned edge (tile (1,0).W) + BOTH flanking inners.
    // One stamp is not enough — the edge is shared, but each tile keeps its own inner (the two routes).
    const grid = makeGrid(2, 1);
    expect(
      applyBatch(grid, [
        { region: { x: 0, y: 0, w: 1, h: 1 }, stamp: template({ inner: { E: segs('wall') } }) },
        { region: { x: 1, y: 0, w: 1, h: 1 }, stamp: template({ edge: { W: segs('wall') }, inner: { W: segs('wall') } }) },
      ]).ok,
    ).toBe(true);
    const g = cornerGraphOf(grid);
    const top = cornerId(2, 1, 0), bot = cornerId(2, 1, 1);
    expect(g.adj[top]!.includes(bot)).toBe(false); // no DIRECT route through either flanking tile
    expect(cornerReachable(g, top, bot)).toBe(true); // but still reachable around (top/bottom open)
  });
});
