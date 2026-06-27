import { describe, it, expect } from 'vitest';
import {
  fullField,
  fromTile,
  template,
  andGate,
  conflicts,
  hasConflict,
  collapse,
  segs,
  centres,
  type TileField,
} from './wall-tile-field.ts';
import { armOf, type WallTile, type Seg, type CornerFloors, type FloorMaterial } from './wall-tile.ts';

const F = (m: FloorMaterial = 'stone'): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const side = (N: Seg, E: Seg, S: Seg, W: Seg) => ({ N, E, S, W });
const T = (p: Partial<WallTile>): WallTile => ({
  floor: F('stone'),
  edge: side('none', 'none', 'none', 'none'),
  inner: side('none', 'none', 'none', 'none'),
  centre: 'none',
  wallType: 'solid',
  ...p,
});

describe('wall-tile-field — domains + round-trip', () => {
  it('a concrete tile collapses back to itself (fromTile → collapse is identity)', () => {
    const t = T({ edge: side('wall', 'barrier', 'none', 'wall'), inner: side('wall', 'none', 'none', 'wall'), centre: 'wall', wallType: 'door', floor: { nw: 'stone', ne: 'dirt', sw: 'wood', se: 'none' } });
    expect(collapse(fromTile(t))).toEqual(t);
  });

  it('fullField is conflict-free and collapses to the canonical (all-first-option) tile', () => {
    const f = fullField();
    expect(hasConflict(f)).toBe(false);
    const t = collapse(f)!;
    expect(t.edge.N).toBe('none'); // 'none' is the first SEG bit
    expect(t.centre).toBe('none');
    expect(t.wallType).toBe('solid');
    expect(t.floor.nw).toBe('none');
  });
});

describe('wall-tile-field — templates + AND-gate (stamping)', () => {
  it("a template can say edge.N ∈ {none, wall} — not the railing", () => {
    const tmpl = template({ edge: { N: segs('none', 'wall') } });
    // AND-gate onto an open map: edge.N keeps {none,wall}; barrier is excluded.
    const map = andGate(fullField(), tmpl);
    expect(collapse(map)!.edge.N).toBe('none'); // canonical pick from {none,wall}
    // and a tile that WAS barrier there now conflicts with the template
    const wasBarrier = andGate(fromTile(T({ edge: side('barrier', 'none', 'none', 'none') })), tmpl);
    expect(conflicts(wasBarrier)).toContain('edge.N');
    expect(collapse(wasBarrier)).toBeNull();
  });

  it('AND-gate is intersection: stamping two templates narrows to the overlap', () => {
    const a = template({ centre: centres('none', 'wall') });
    const b = template({ centre: centres('wall', 'barrier') });
    const both = andGate(andGate(fullField(), a), b);
    expect(collapse(both)!.centre).toBe('wall'); // {none,wall} ∩ {wall,barrier} = {wall}
  });

  it('AND-gate is monotone — domains only shrink, never grow', () => {
    const tmpl = template({ inner: { E: segs('wall') } });
    const narrowed = andGate(fullField(), tmpl);
    expect(narrowed.inner.E).toBe(fromTile(T({ inner: side('none', 'wall', 'none', 'none') })).inner.E);
  });
});

describe('wall-tile-field — conflict (the NOR guard)', () => {
  it('stamping incompatible templates → an empty domain → conflict → collapse null', () => {
    const onlyWall = template({ edge: { E: segs('wall') } });
    const onlyNone = template({ edge: { E: segs('none') } });
    const clash = andGate(andGate(fullField(), onlyWall), onlyNone);
    expect(hasConflict(clash)).toBe(true);
    expect(conflicts(clash)).toEqual(['edge.E']);
    expect(collapse(clash)).toBeNull();
  });

  it('a compatible stamp stays conflict-free', () => {
    const stamp = template({ edge: { N: segs('none', 'wall') }, inner: { N: segs('wall') }, centre: centres('none') });
    const ok = andGate(fullField(), stamp);
    expect(hasConflict(ok)).toBe(false);
  });
});

describe('wall-tile-field — collapse is deterministic + seeded-pickable', () => {
  it('a seeded pick chooses different valid options but stays in-domain', () => {
    const f = andGate(fullField(), template({ edge: { N: segs('none', 'wall', 'barrier') } }));
    const pickLast = (_cell: string, opts: readonly string[]) => opts.length - 1;
    const t = collapse(f, pickLast)!;
    expect(t.edge.N).toBe('barrier'); // last option of {none,wall,barrier}
    // and the collapsed tile is a valid WallTile the resolver can read
    expect(armOf(t, 'N').type).toBe('barrier');
  });
});
