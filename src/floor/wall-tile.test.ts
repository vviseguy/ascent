import { describe, it, expect } from 'vitest';
import {
  armOf,
  label,
  uniformFloor,
  fullWallLine,
  validate,
  DIRS,
  type WallTile,
  type Seg,
  type CornerFloors,
  type FloorMaterial,
} from './wall-tile.ts';

const F = (m: FloorMaterial = 'stone'): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const side = (N: Seg, E: Seg, S: Seg, W: Seg) => ({ N, E, S, W });

/** Build a tile with sane defaults; override only the fields a case cares about. */
const T = (p: Partial<WallTile>): WallTile => ({
  floor: F('stone'),
  edge: side('none', 'none', 'none', 'none'),
  inner: side('none', 'none', 'none', 'none'),
  centre: 'none',
  wallType: 'solid',
  ...p,
});

describe('wall-tile 9-cell — derived label', () => {
  it('empty: nothing → empty', () => {
    expect(label(T({}))).toBe('empty');
  });
  it('straight: opposite inner walls', () => {
    expect(label(T({ inner: side('none', 'wall', 'none', 'wall'), edge: side('none', 'wall', 'none', 'wall') }))).toBe('straight');
  });
  it('bend: adjacent inner walls + NO centre column', () => {
    expect(label(T({ inner: side('wall', 'wall', 'none', 'none'), centre: 'none' }))).toBe('bend');
  });
  it('corner: adjacent inner walls + a centre column', () => {
    expect(label(T({ inner: side('wall', 'wall', 'none', 'none'), centre: 'wall' }))).toBe('corner');
  });
  it('tee / cross', () => {
    expect(label(T({ inner: side('none', 'wall', 'wall', 'wall') }))).toBe('tee');
    expect(label(T({ inner: side('wall', 'wall', 'wall', 'wall') }))).toBe('cross');
  });
  it('cap: a single inner wall', () => {
    expect(label(T({ inner: side('wall', 'none', 'none', 'none') }))).toBe('cap');
  });
  it('column / post: a centre column, no inner', () => {
    expect(label(T({ centre: 'wall' }))).toBe('column');
    expect(label(T({ centre: 'barrier' }))).toBe('post');
  });
  it('edge-caps: edges only, no inner, no centre', () => {
    expect(label(T({ edge: side('wall', 'wall', 'none', 'none') }))).toBe('edge-caps');
  });
});

describe('wall-tile 9-cell — armOf', () => {
  it('full arm: inner + edge both set → reaches centre AND edge', () => {
    const a = armOf(T({ inner: side('none', 'wall', 'none', 'none'), edge: side('none', 'wall', 'none', 'none') }), 'E');
    expect(a).toEqual({ dir: 'E', type: 'wall', reachesCentre: true, reachesEdge: true });
  });
  it('inner stub: inner only → reaches centre, not edge', () => {
    const a = armOf(T({ inner: side('wall', 'none', 'none', 'none') }), 'N');
    expect(a).toMatchObject({ type: 'wall', reachesCentre: true, reachesEdge: false });
  });
  it('edge cap: edge only → reaches edge, not centre', () => {
    const a = armOf(T({ edge: side('none', 'wall', 'none', 'none') }), 'E');
    expect(a).toMatchObject({ type: 'wall', reachesCentre: false, reachesEdge: true });
  });
  it('mixed inner/edge type → the INNER (centre side) wins', () => {
    const a = armOf(T({ inner: side('none', 'wall', 'none', 'none'), edge: side('none', 'barrier', 'none', 'none') }), 'E');
    expect(a.type).toBe('wall');
  });
  it('none → no arm', () => {
    expect(armOf(T({}), 'N').type).toBeNull();
  });
});

describe('wall-tile 9-cell — floor + wallType', () => {
  it('uniformFloor: all equal non-none → that material; mixed/hole → null', () => {
    expect(uniformFloor(F('stone'))).toBe('stone');
    expect(uniformFloor(F('none'))).toBeNull();
    expect(uniformFloor({ nw: 'stone', ne: 'stone', sw: 'dirt', se: 'dirt' })).toBeNull();
  });
  it('fullWallLine: a straight EW line is full only when both inner+edge on E and W are wall', () => {
    expect(fullWallLine(T({ inner: side('none', 'wall', 'none', 'wall'), edge: side('none', 'wall', 'none', 'wall') }), 'EW')).toBe(true);
    expect(fullWallLine(T({ inner: side('none', 'wall', 'none', 'wall') }), 'EW')).toBe(false); // edges missing
  });
  it('validate: wallType opening needs a full straight line', () => {
    const straightDoor = T({ inner: side('none', 'wall', 'none', 'wall'), edge: side('none', 'wall', 'none', 'wall'), wallType: 'door' });
    expect(validate(straightDoor)).toEqual([]);
    const floatingDoor = T({ wallType: 'door' });
    expect(validate(floatingDoor).map((i) => i.code)).toContain('wallType-without-line');
  });
});

describe('wall-tile 9-cell — totality', () => {
  it('armOf + label never throw over every (inner,edge,centre) combo', () => {
    const segs: Seg[] = ['none', 'wall', 'barrier'];
    let count = 0;
    for (const iN of segs)
      for (const eN of segs)
        for (const c of ['none', 'wall', 'barrier'] as const) {
          const tile = T({ inner: side(iN, 'none', 'none', 'none'), edge: side(eN, 'none', 'none', 'none'), centre: c });
          for (const d of DIRS) expect(() => armOf(tile, d)).not.toThrow();
          expect(typeof label(tile)).toBe('string');
          count++;
        }
    expect(count).toBe(27);
  });
});
