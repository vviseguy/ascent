import { describe, it, expect } from 'vitest';
import { tilePlacements, PIECE, type TilePlacement } from './tile-place.ts';
import type { WallTile, Seg, FloorMaterial } from './wall-tile.ts';
import { toFloat } from '../sim/fixed/fixed.ts';

/** Build a resolved tile from arm/centre/floor/wallType options. */
const T = (o: Partial<{
  eN: Seg; eE: Seg; eS: Seg; eW: Seg; iN: Seg; iE: Seg; iS: Seg; iW: Seg;
  c: Seg; wt: WallTile['wallType']; f: FloorMaterial; fnw: FloorMaterial;
}> = {}): WallTile => ({
  floor: { nw: o.fnw ?? o.f ?? 'none', ne: o.f ?? 'none', sw: o.f ?? 'none', se: o.f ?? 'none' },
  edge: { N: o.eN ?? 'none', E: o.eE ?? 'none', S: o.eS ?? 'none', W: o.eW ?? 'none' },
  inner: { N: o.iN ?? 'none', E: o.iE ?? 'none', S: o.iS ?? 'none', W: o.iW ?? 'none' },
  centre: o.c ?? 'none',
  wallType: o.wt ?? 'solid',
});
const find = (ps: TilePlacement[], url: string): TilePlacement => ps.find((p) => p.url === url)!;

describe('tile-place — pieces, turns, offsets (fixed-point authority)', () => {
  it('a full wall arm → wall_half at the arm turn, centred', () => {
    const p = find(tilePlacements(T({ iS: 'wall', eS: 'wall' })), PIECE.half);
    expect(p.turn).toBe(3); // armTurn.S
    expect(toFloat(p.x)).toBeCloseTo(0, 5);
    expect(toFloat(p.z)).toBeCloseTo(0, 5);
    expect(toFloat(p.scale)).toBeCloseTo(1, 5);
  });

  it('an inner stub → wall_half_endcap at the endcap turn (−X-native, points outward)', () => {
    const p = find(tilePlacements(T({ iN: 'wall' })), PIECE.halfCap);
    expect(p.turn).toBe(3); // endcapTurn.N
  });

  it('an edge cap is pushed to the boundary (±EDGE) on the right axis', () => {
    const p = find(tilePlacements(T({ eE: 'wall' })), PIECE.halfCap);
    expect(p.turn).toBe(2); // endcapTurn.E
    expect(toFloat(p.x)).toBeCloseTo(1.6, 3); // +EDGE east
    expect(toFloat(p.z)).toBeCloseTo(0, 5);
  });

  it('a barrier arm → barrier_half at armTurn (+X-native)', () => {
    const p = find(tilePlacements(T({ iE: 'barrier', eE: 'barrier' })), PIECE.barrierHalf);
    expect(p.turn).toBe(0); // armTurn.E
  });

  it('a clean {S,W} corner → one mitered wall_corner at turn 0, nothing else', () => {
    const ps = tilePlacements(T({ iS: 'wall', eS: 'wall', iW: 'wall', eW: 'wall' }));
    expect(ps).toHaveLength(1);
    expect(ps[0]!.url).toBe(PIECE.corner);
    expect(ps[0]!.turn).toBe(0);
  });

  it('a full EW line with a door → one arch spanning piece at turn 0', () => {
    const ps = tilePlacements(T({ iE: 'wall', eE: 'wall', iW: 'wall', eW: 'wall', wt: 'door' }));
    expect(ps).toHaveLength(1);
    expect(ps[0]!.url).toBe(PIECE.arch);
    expect(ps[0]!.turn).toBe(0);
  });

  it('a uniform floor → one full floor tile (scale 1, centred)', () => {
    const p = find(tilePlacements(T({ f: 'stone' })), PIECE.floorStone);
    expect(toFloat(p.scale)).toBeCloseTo(1, 5);
    expect(toFloat(p.x)).toBeCloseTo(0, 5);
  });

  it('a single-corner floor → a half-scale quarter at that corner', () => {
    const p = find(tilePlacements(T({ fnw: 'stone' })), PIECE.floorStone);
    expect(toFloat(p.scale)).toBeCloseTo(0.5, 5);
    expect(toFloat(p.x)).toBeCloseTo(-1, 5); // nw → −X
    expect(toFloat(p.z)).toBeCloseTo(-1, 5); // nw → −Z (north)
  });

  it('a centre column → a pillar', () => {
    expect(find(tilePlacements(T({ c: 'wall' })), PIECE.pillar).turn).toBe(0);
  });
});
