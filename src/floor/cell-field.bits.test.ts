// The bit layout is a CLAIM about a representation nothing has built yet, which is precisely why it
// rotted: `wallType` grew from 6 values to 15 while its slot stayed at 7, and because no code reads
// these constants, nothing anywhere disagreed. A comment cannot hold an invariant. This does.
//
// It has since gone the other way — splitting the open/closed pairs out of the type enum brought the
// whole cell back inside ONE word — which is the same claim needing the same guard.
import { describe, it, expect } from 'vitest';
import {
  BIT_OFFSETS, BIT_SLOTS, BITS_PER_WORD, TOTAL_WORDS, FIELD_KEYS, type FieldKey,
} from './cell-field.ts';
import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES, TORCHES, OPENS } from './cell.ts';

/** How many values each field actually has, read from the live enums — not copied. */
const VALUE_COUNT: Record<FieldKey, number> = {
  floor: FLOOR_MATERIALS.length,
  wallN: SEGS.length,
  wallW: SEGS.length,
  corner: CORNERS.length,
  wallType: WALL_TYPES.length,
  open: OPENS.length,
  torch: TORCHES.length,
};

describe('the bit layout still describes the model it claims to', () => {
  it('every field fits in the slot it was given', () => {
    const over = FIELD_KEYS
      .filter((k) => VALUE_COUNT[k] > BIT_SLOTS[k])
      .map((k) => `${k}: ${VALUE_COUNT[k]} values in ${BIT_SLOTS[k]} slots`);
    expect(over).toEqual([]);
  });

  it('every field is declared exactly once, in every table', () => {
    for (const table of [BIT_OFFSETS, BIT_SLOTS]) {
      expect(Object.keys(table).sort()).toEqual([...FIELD_KEYS].sort());
    }
  });

  it('no two fields overlap, and none runs past the usable end of the word', () => {
    const clashes: string[] = [];
    const ordered = [...FIELD_KEYS].sort((a, b) => BIT_OFFSETS[a] - BIT_OFFSETS[b]);
    let next = 0;
    for (const k of ordered) {
      if (BIT_OFFSETS[k] < next) clashes.push(`${k} starts at ${BIT_OFFSETS[k]}, inside the field below it`);
      const end = BIT_OFFSETS[k] + BIT_SLOTS[k];
      // BIT 31 IS OFF LIMITS: JS bitwise coerces to int32, so `1 << 31` is negative while the same
      // bits out of a Uint32Array are positive, and two identical values compare unequal.
      if (end > BITS_PER_WORD) clashes.push(`${k} ends at bit ${end}, past the usable ${BITS_PER_WORD}`);
      next = end;
    }
    expect(clashes).toEqual([]);
  });

  it('still fits in ONE word — the whole point of splitting the pair states out', () => {
    const need = FIELD_KEYS.reduce((n, k) => n + VALUE_COUNT[k], 0);
    expect(TOTAL_WORDS).toBe(1);
    expect(need).toBeLessThanOrEqual(BITS_PER_WORD);
  });

  it('the whole cell fits the word, with every slot sized to its field exactly', () => {
    /* THERE IS NO HEADROOM, and that is the deliberate state rather than an oversight.
       Splitting the open/closed pairs out of the wall types brought the cell back inside one word at
       exactly 31 bits, and the earlier layout bought its spare slots by spilling into a second word —
       which measured ~1.6x slower on whole-field operations. Zero spare is the price of one word.
       So the invariant is no longer "every field has room to grow"; it is "nothing silently
       overflows". Appending any value now fails this, which is the point: the next person to add one
       has to choose between a re-slot and a second word, in the open. */
    for (const k of FIELD_KEYS) {
      expect({ field: k, slots: BIT_SLOTS[k] }).toEqual({ field: k, slots: VALUE_COUNT[k] });
    }
    const used = FIELD_KEYS.reduce((n, k) => n + BIT_SLOTS[k], 0);
    expect(used).toBeLessThanOrEqual(BITS_PER_WORD);
  });
});
