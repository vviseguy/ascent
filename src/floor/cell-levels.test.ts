// Multi-storey structures: the level model, and what the generator does with one.
import { describe, it, expect } from 'vitest';
import { abstainUnowned, levelSize, levelsOf, pointAt, type CellStructure } from './cell-structures.ts';
import { orientStructure, ORIENTATIONS } from './cell-orient.ts';
import { fullField, floors, segs, collapse } from './cell-field.ts';
import { generateEmergent } from './cell-emergent.ts';

/** A 3x2 structure of `n` storeys: ground is stone, every storey above it is an open shaft. */
function stack(n: number): CellStructure {
  const w = 3, h = 2, size = (w + 1) * (h + 1);
  const cells = Array.from({ length: size * n }, fullField);
  const st: CellStructure = { w, h, levels: n, cells };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      cells[pointAt(st, 0, px, py)]!.floor = floors('stone');
      for (let lv = 1; lv < n; lv++) cells[pointAt(st, lv, px, py)]!.floor = floors('none');
    }
  }
  // one wall on the ground floor, so there is something orientation can lose
  cells[pointAt(st, 0, 1, 0)]!.wallN = segs('wall');
  return st;
}

describe('multi-storey structures — the level model', () => {
  it('levels are inferred as one when absent, so older structures still read', () => {
    expect(levelsOf({ })).toBe(1);
    expect(levelsOf({ levels: 3 })).toBe(3);
    expect(levelSize({ w: 3, h: 2 })).toBe(12);
  });

  it('indexes a point on the right storey', () => {
    const st = stack(3);
    expect(pointAt(st, 0, 0, 0)).toBe(0);
    expect(pointAt(st, 1, 0, 0)).toBe(12);
    expect(pointAt(st, 2, 2, 1)).toBe(24 + 1 * 4 + 2);
    expect(st.cells.length).toBe(12 * 3);
  });

  it('the padding rule applies to EVERY storey, not just the first', () => {
    const st = stack(2);
    // dirty the padding on both levels
    for (const lv of [0, 1]) st.cells[pointAt(st, lv, 3, 2)]!.floor = floors('stone');
    const out = abstainUnowned(st.cells, st.w, st.h);
    const full = fullField().floor;
    expect(out[pointAt(st, 0, 3, 2)]!.floor).toBe(full);
    expect(out[pointAt(st, 1, 3, 2)]!.floor).toBe(full);
  });
});

describe('multi-storey structures — orientation', () => {
  it('keeps the storey count and the array length', () => {
    for (const o of ORIENTATIONS) {
      const t = orientStructure(stack(3), o);
      expect(levelsOf(t)).toBe(3);
      expect(t.cells.length).toBe((t.w + 1) * (t.h + 1) * 3);
    }
  });

  it('is a strict no-op under the identity, all storeys included', () => {
    const st = stack(3);
    expect(JSON.stringify(orientStructure(st, { turn: 0, flip: false }))).toBe(JSON.stringify(st));
  });

  it('turns each storey INDEPENDENTLY — no level bleeds into another', () => {
    // ground is stone, upper storeys are open. Whatever the orientation, that has to stay true:
    // a rotation that mixed levels would put ground on the shaft floor or a hole in the deck.
    for (const o of ORIENTATIONS) {
      const t = orientStructure(stack(3), o);
      for (let py = 0; py < t.h; py++) {
        for (let px = 0; px < t.w; px++) {
          expect(collapse(t.cells[pointAt(t, 0, px, py)]!)?.floor).toBe('stone');
          expect(collapse(t.cells[pointAt(t, 1, px, py)]!)?.floor).toBe('none');
          expect(collapse(t.cells[pointAt(t, 2, px, py)]!)?.floor).toBe('none');
        }
      }
    }
  });

  it('four quarter-turns is still the identity with storeys', () => {
    let t = stack(2);
    for (let i = 0; i < 4; i++) t = orientStructure(t, { turn: 1, flip: false });
    expect(JSON.stringify(t)).toBe(JSON.stringify(stack(2)));
  });
});

describe('multi-storey structures — the generator declines them, and says so', () => {
  it('places nothing multi-storey and counts what it skipped', () => {
    // Nothing in the store is multi-storey yet, so this pins the CONTRACT rather than a count: the
    // stat exists and placement never silently flattens a structure to its ground floor.
    const r = generateEmergent({ width: 24, height: 20, seed: 7n });
    expect(r.stats).toHaveProperty('structuresSkippedMultiLevel');
    expect(r.stats.structuresPlaced + r.stats.structuresSkippedMultiLevel).toBeGreaterThan(0);
  });
});
