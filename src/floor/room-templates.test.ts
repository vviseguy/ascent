import { describe, it, expect } from 'vitest';
import { ROOMS, basicRoom, library, hallway, throneRoom } from './room-templates.ts';
import { makeGrid, applyBatch, collapseGrid, at } from './tile-grid.ts';
import { collapse, segs, isOpen, type TileField } from './wall-tile-field.ts';
import { label } from './wall-tile.ts';

const fieldAt = (g: ReturnType<typeof makeGrid>, x: number, y: number): TileField => at(g, x, y) as TileField;
const tileAt = (g: ReturnType<typeof makeGrid>, x: number, y: number) => collapse(fieldAt(g, x, y))!;
const labelAt = (g: ReturnType<typeof makeGrid>, x: number, y: number): string => label(tileAt(g, x, y));
const stamp = (name: string, w: number, h: number) => {
  const g = makeGrid(w, h);
  applyBatch(g, [{ region: { x: 0, y: 0, w, h }, stamp: ROOMS[name]!.make(w, h) }]);
  return g;
};

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

describe('room-templates — constrain only the inside', () => {
  it('the outward boundary edge of a wall tile is left OPEN (anything can connect)', () => {
    const g = makeGrid(5, 4);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 5, h: 4 }, stamp: basicRoom(5, 4) }]);
    const west = fieldAt(g, 0, 1); // a west-wall tile (N–S run)
    expect(west.edge.W).toBe(segs('none', 'wall', 'barrier')); // outward edge unconstrained
    expect(west.inner.N).toBe(segs('wall')); // ...but the wall itself IS pinned
    expect(west.inner.S).toBe(segs('wall'));
  });

  it('a cell outside the stamped region stays fully open (ground only in the room)', () => {
    const g = makeGrid(7, 6); // bigger than the room
    applyBatch(g, [{ region: { x: 1, y: 1, w: 5, h: 4 }, stamp: basicRoom(5, 4) }]);
    expect(isOpen(fieldAt(g, 0, 0))).toBe(true); // a corner outside the room = untouched / open
    expect(isOpen(fieldAt(g, 3, 3))).toBe(false); // inside the room = constrained
  });
});

describe('room-templates — entries + structural signatures', () => {
  it('every enclosed room has a south doorway', () => {
    for (const name of ['basic room', 'library', 'throne room', 'dungeon', 'bedroom']) {
      const [w, h] = ROOMS[name]!.size;
      const g = stamp(name, w, h);
      expect(tileAt(g, Math.floor(w / 2), h - 1).wallType).toBe('door');
    }
  });

  it('a room corner collapses to a mitered corner; interior is open floor', () => {
    const g = stamp('basic room', 5, 4);
    expect(labelAt(g, 0, 0)).toBe('bend');
    expect(labelAt(g, 2, 2)).toBe('empty');
  });

  it('throne room has TWO rows of freestanding pillars', () => {
    const g = makeGrid(9, 7);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 9, h: 7 }, stamp: throneRoom(9, 7) }]);
    expect(labelAt(g, 2, 2)).toBe('column'); // west colonnade
    expect(labelAt(g, 6, 2)).toBe('column'); // east colonnade
    expect(labelAt(g, 4, 2)).toBe('empty'); // the central aisle stays clear
  });

  it('dungeon divides into cells with barred (grate) walls', () => {
    const g = stamp('dungeon', 9, 6);
    expect(tileAt(g, 1, 2).wallType).toBe('low_gate'); // a grate divider
    expect(tileAt(g, 1, 2).floor.nw).toBe('dirt');
  });

  it('hallway has open ends; the long wall is a straight run', () => {
    const g = makeGrid(9, 3);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 9, h: 3 }, stamp: hallway(9, 3) }]);
    expect(labelAt(g, 0, 1)).toBe('empty'); // west mouth = open
    expect(labelAt(g, 4, 0)).toBe('straight');
  });

  it('library uses a wood floor', () => {
    const g = makeGrid(7, 5);
    applyBatch(g, [{ region: { x: 0, y: 0, w: 7, h: 5 }, stamp: library(7, 5) }]);
    expect(tileAt(g, 3, 2).floor.nw).toBe('wood');
  });
});
