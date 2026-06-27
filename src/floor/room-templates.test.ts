import { describe, it, expect } from 'vitest';
import { ROOMS, library, hallway, throneRoom } from './room-templates.ts';
import { makeGrid, applyBatch, collapseGrid, at } from './tile-grid.ts';
import { collapse, type TileField } from './wall-tile-field.ts';
import { label } from './wall-tile.ts';

const labelAt = (g: ReturnType<typeof makeGrid>, x: number, y: number): string => label(collapse(at(g, x, y) as TileField)!);

describe('room-templates — every room stamps cleanly + collapses to a full grid', () => {
  for (const [name, { make, size }] of Object.entries(ROOMS)) {
    it(`${name} (${size[0]}×${size[1]}): no internal conflict, all cells collapse`, () => {
      const [w, h] = size;
      const g = makeGrid(w, h);
      const r = applyBatch(g, [{ region: { x: 0, y: 0, w, h }, stamp: make(w, h) }]);
      expect(r.ok).toBe(true);
      expect(r.conflicts).toEqual([]);
      expect(collapseGrid(g).every((t) => t !== null)).toBe(true);
    });
  }
});

describe('room-templates — structural signatures', () => {
  it('a room corner collapses to a mitered corner (NW = a turn)', () => {
    const g = makeGrid(5, 4);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 5, h: 4 }, stamp: ROOMS['basic room']!.make(5, 4) }]);
    expect(labelAt(g, 0, 0)).toBe('bend'); // NW corner = column-less corner
    expect(labelAt(g, 2, 2)).toBe('empty'); // interior = open floor
  });

  it('throne room places freestanding columns inside', () => {
    const g = makeGrid(7, 5);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 7, h: 5 }, stamp: throneRoom(7, 5) }]);
    expect(labelAt(g, 1, 2)).toBe('column'); // a side-aisle pillar
  });

  it('hallway has open ends (the passage row is empty at the mouth)', () => {
    const g = makeGrid(9, 3);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 9, h: 3 }, stamp: hallway(9, 3) }]);
    expect(labelAt(g, 0, 1)).toBe('empty'); // west mouth of the corridor = open
    expect(labelAt(g, 4, 0)).toBe('straight'); // the long wall = a straight run
  });

  it('library uses a wood floor; dungeon a dirt floor', () => {
    const g1 = makeGrid(7, 5);
    applyBatch(g1, [{ region: { x: 0, y: 0, w: 7, h: 5 }, stamp: library(7, 5) }]);
    expect(collapse(at(g1, 3, 2) as TileField)!.floor.nw).toBe('wood');
    const g2 = makeGrid(7, 5);
    applyBatch(g2, [{ region: { x: 0, y: 0, w: 7, h: 5 }, stamp: ROOMS['dungeon']!.make(7, 5) }]);
    expect(collapse(at(g2, 3, 2) as TileField)!.floor.nw).toBe('dirt');
  });
});
