import { describe, it, expect } from 'vitest';
import { listStructures, getStructure, levelsOf, stride, STORED_VALUE_SETS } from './cell-structures.ts';
import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES } from './cell.ts';
import { collapse, domainSize, fullField } from './cell-field.ts';

describe('cell-structures — the store matches the model it was written against', () => {
  it('the value sets have not changed since the masks were generated', () => {
    // If this fails, an enum gained a value and every stored mask now means something slightly
    // different — a floor mask of 15 meant "any material" with four of them and means "any except
    // rock" with five. Re-run the migration; do not edit the numbers here.
    expect(STORED_VALUE_SETS).toEqual({
      seg: SEGS.length,
      floor: FLOOR_MATERIALS.length,
      corner: CORNERS.length,
      wallType: WALL_TYPES.length,
    });
  });

  it('every stored mask is a legal subset of its value set', () => {
    const full = fullField();
    for (const n of listStructures()) {
      for (const f of getStructure(n)!.cells) {
        expect(f.floor & ~full.floor).toBe(0);
        expect(f.wallN & ~full.wallN).toBe(0);
        expect(f.wallW & ~full.wallW).toBe(0);
        expect(f.corner & ~full.corner).toBe(0);
        expect(f.wallType & ~full.wallType).toBe(0);
      }
    }
  });

  it('every structure stores the POINT lattice — (w+1)×(h+1) entries PER STOREY', () => {
    for (const n of listStructures()) {
      const s = getStructure(n)!;
      expect(s.cells).toHaveLength(stride(s) * (s.h + 1) * levelsOf(s));
    }
  });

  it('every cell of every structure can still collapse', () => {
    for (const n of listStructures()) {
      for (const f of getStructure(n)!.cells) expect(collapse(f)).not.toBeNull();
    }
  });

  it('structures carry real authored content, not just abstentions', () => {
    for (const n of listStructures()) {
      const decided = getStructure(n)!.cells
        .filter((f) => domainSize(f.wallN) === 1 || domainSize(f.wallW) === 1).length;
      expect(decided).toBeGreaterThan(0);
    }
  });
});
