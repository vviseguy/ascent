import { describe, it, expect } from 'vitest';
import { buildCornerGraph, cornerId, cornerReachable, reachableFrom } from './corner-graph.ts';
import { tileOpening, type WallTile, type WallType } from './wall-tile.ts';
import { tilePlacements } from './tile-place.ts';
import { makeGrid, applyBatch } from './tile-grid.ts';
import { template, segs, wallTypes, floors } from './wall-tile-field.ts';
import { gridAt, tileOpeningCertain } from './tile-reach.ts';

const W = 3, H = 3;
/** 3×3 of plain floor; the MIDDLE ROW carries a full E–W wall line, so the north half is cut off
 *  from the south half. The centre tile gets `wt` — the only thing that can reconnect them. */
const grid3 = (wt: WallType): WallTile[] => {
  const out: WallTile[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const onLine = y === 1;
    out.push({
      floor: { nw: 'stone', ne: 'stone', sw: 'stone', se: 'stone' },
      inner: { N: 'none', S: 'none', E: onLine ? 'wall' : 'none', W: onLine ? 'wall' : 'none' },
      edge: { N: 'none', S: 'none', E: onLine ? 'wall' : 'none', W: onLine ? 'wall' : 'none' },
      centre: 'none',
      wallType: onLine && x === 1 ? wt : 'solid',
    });
  }
  return out;
};
const crossesTheWall = (wt: WallType): boolean => {
  const g = buildCornerGraph(grid3(wt), W, H);
  return reachableFrom(g, cornerId(W, 0, 0))[cornerId(W, 0, 3)] === true;
};

describe('openings — only a true door or arch is a hole you can walk through', () => {
  it.each<[WallType, boolean]>([
    ['solid', false],
    ['door', true],
    ['arch', true],
    ['window', false],   // too high to climb
    ['hole', false],     // a broken wall is rubble, not a passage
    ['low_gate', false], // barred
  ])('%s → crosses the wall: %s', (wt, want) => {
    expect(crossesTheWall(wt)).toBe(want);
  });
});

describe('openings — the graph agrees with what is DRAWN', () => {
  it('a tile only counts as open when it actually renders a spanning opening piece', () => {
    for (const wt of ['door', 'arch'] as WallType[]) {
      const t = grid3(wt)[1 * W + 1]!;
      const drawn = tilePlacements(t).some((p) => /arch|broken|window|gate/.test(p.url));
      expect(tileOpening(t)).toBe(true);
      expect(drawn).toBe(true); // render and graph agree, cell for cell
    }
  });

  it('a door with NO full wall line is inert — nothing is drawn, nothing is connected', () => {
    const t: WallTile = {
      floor: { nw: 'stone', ne: 'stone', sw: 'stone', se: 'stone' },
      inner: { N: 'wall', E: 'wall', S: 'none', W: 'none' }, // an L, not a straight line
      edge: { N: 'wall', E: 'wall', S: 'none', W: 'none' },
      centre: 'none',
      wallType: 'door',
    };
    expect(tileOpening(t)).toBe(false);
    expect(tilePlacements(t).some((p) => p.url.includes('arch'))).toBe(false);
  });
});

describe('openings — an open centre joins ALL FOUR corners, not just the spanning axis', () => {
  it('reconnects across a PERPENDICULAR arm, via the centre', () => {
    // the centre tile has the E–W door AND a walled N arm splitting its north half.
    // NE→SW is only possible by slipping around the arm's inner end through the doorway.
    const tiles = grid3('door');
    const mid = tiles[1 * W + 1]!;
    mid.inner.N = 'wall';
    mid.edge.N = 'wall';
    const g = buildCornerGraph(tiles, W, H);
    expect(cornerReachable(g, cornerId(W, 2, 1), cornerId(W, 1, 2))).toBe(true);
  });

  it('all four corners of an open tile land in one component', () => {
    const g = buildCornerGraph(grid3('arch'), W, H);
    const [nw, ne, se, sw] = [cornerId(W, 1, 1), cornerId(W, 2, 1), cornerId(W, 2, 2), cornerId(W, 1, 2)];
    for (const a of [nw, ne, se, sw]) for (const b of [nw, ne, se, sw]) {
      expect(cornerReachable(g, a, b)).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: with `solid` those same corners are NOT all connected', () => {
    const g = buildCornerGraph(grid3('solid'), W, H);
    expect(cornerReachable(g, cornerId(W, 1, 1), cornerId(W, 1, 2))).toBe(false);
  });
});

describe('openings — the DOMAIN read is certain-only (never inflates reachability)', () => {
  const wallLine = template({
    inner: { E: segs('wall'), W: segs('wall') },
    edge: { W: segs('wall') },
    floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') },
  });

  it('a PINNED door on a certain wall line counts', () => {
    const g = makeGrid(W, H);
    applyBatch(g, [
      { region: { x: 0, y: 1, w: W, h: 1 }, stamp: wallLine },
      { region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ wallType: wallTypes('door') }) },
    ]);
    expect(tileOpeningCertain(gridAt(g), 1, 1)).toBe(true);
  });

  it('a MAYBE door does not count — the domain could still collapse to something solid', () => {
    const g = makeGrid(W, H);
    applyBatch(g, [
      { region: { x: 0, y: 1, w: W, h: 1 }, stamp: wallLine },
      { region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ wallType: wallTypes('door', 'window') }) },
    ]);
    expect(tileOpeningCertain(gridAt(g), 1, 1)).toBe(false);
  });

  it('a pinned door on an UNCERTAIN wall line does not count either', () => {
    const g = makeGrid(W, H);
    applyBatch(g, [{ region: { x: 1, y: 1, w: 1, h: 1 }, stamp: template({ wallType: wallTypes('door') }) }]);
    expect(tileOpeningCertain(gridAt(g), 1, 1)).toBe(false); // arms still free
  });
});
