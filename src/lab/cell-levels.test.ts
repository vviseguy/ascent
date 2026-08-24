// Storey arithmetic. The interesting assertion in this file is not "does it move the right cells" —
// it is "are the two storeys INDEPENDENT afterwards". A shallow copy passes every content check and
// then leaks: paint one floor and the other changes under you, and the symptom looks like a rendering
// fault rather than an aliasing one.

import { describe, it, expect } from 'vitest';
import { fullField, segs, floors, type CellField } from '../floor/cell-field.ts';
import { clearLevelAt, duplicateLevelAt, levelCount, putLevel, sliceLevel, swapLevels } from './cell-levels.ts';

const SIZE = 4;   // a 1x1 structure's point lattice — small enough to read, real enough to be the shape

/** Three storeys, each uniformly marked so a mix-up is obvious. */
const stack = (): CellField[] => {
  const out: CellField[] = [];
  for (const mark of [segs('wall'), segs('barrier'), segs('sloped')]) {
    for (let i = 0; i < SIZE; i++) out.push({ ...fullField(), wallN: mark });
  }
  return out;
};
const marks = (cells: readonly CellField[]): number[] =>
  Array.from({ length: levelCount(cells, SIZE) }, (_, i) => cells[i * SIZE]!.wallN);

describe('cell-levels — moving a whole storey', () => {
  it('counts storeys off the flat array', () => {
    expect(levelCount(stack(), SIZE)).toBe(3);
    expect(levelCount([], SIZE)).toBe(0);
  });

  it('duplicates a storey directly above itself', () => {
    const out = duplicateLevelAt(stack(), SIZE, 0);
    expect(levelCount(out, SIZE)).toBe(4);
    expect(marks(out)).toEqual([segs('wall'), segs('wall'), segs('barrier'), segs('sloped')]);
  });

  it('replaces one storey and leaves the others alone', () => {
    const out = putLevel(stack(), SIZE, 1, sliceLevel(stack(), SIZE, 2));
    expect(marks(out)).toEqual([segs('wall'), segs('sloped'), segs('sloped')]);
  });

  it('swaps two storeys', () => {
    expect(marks(swapLevels(stack(), SIZE, 0, 2)))
      .toEqual([segs('sloped'), segs('barrier'), segs('wall')]);
    // swapping with itself is a no-op, not a corruption
    expect(marks(swapLevels(stack(), SIZE, 1, 1))).toEqual(marks(stack()));
  });

  it('clears one storey without disturbing its neighbours', () => {
    const out = clearLevelAt(stack(), SIZE, 1, fullField);
    expect(marks(out)).toEqual([segs('wall'), fullField().wallN, segs('sloped')]);
  });
});

describe('cell-levels — THE COPIES ARE INDEPENDENT', () => {
  it('a duplicated storey does not share fields with its source', () => {
    const out = duplicateLevelAt(stack(), SIZE, 0);
    // paint the copy; the original must not move
    out[SIZE]!.floor = floors('wood');
    expect(out[0]!.floor).not.toBe(floors('wood'));
    // ...and the other way round
    out[0]!.wallW = segs('barrier');
    expect(out[SIZE]!.wallW).not.toBe(segs('barrier'));
  });

  it('a storey filled FROM another does not share fields with it', () => {
    const out = putLevel(stack(), SIZE, 0, sliceLevel(stack(), SIZE, 2));
    out[0]!.floor = floors('dirt');
    expect(out[2 * SIZE]!.floor).not.toBe(floors('dirt'));
  });

  it('a swap leaves neither storey aliased to the other', () => {
    const out = swapLevels(stack(), SIZE, 0, 1);
    out[0]!.floor = floors('wood');
    expect(out[SIZE]!.floor).not.toBe(floors('wood'));
  });

  it('the SOURCE array is never mutated — every operation returns a new stack', () => {
    const src = stack();
    const before = JSON.stringify(src);
    duplicateLevelAt(src, SIZE, 0);
    swapLevels(src, SIZE, 0, 2);
    putLevel(src, SIZE, 1, sliceLevel(src, SIZE, 0));
    clearLevelAt(src, SIZE, 0, fullField);
    expect(JSON.stringify(src)).toBe(before);
  });
});
