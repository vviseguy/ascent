// The bit layout is a CLAIM about a representation nothing has built yet, which is precisely why it
// rotted: `wallType` grew from 6 values to 15 while its slot stayed at 7, and because no code reads
// these constants, nothing anywhere disagreed. A comment cannot hold an invariant. This does.
import { describe, it, expect } from 'vitest';
import {
  BIT_OFFSETS, BIT_SLOTS, BIT_WORD, BITS_PER_WORD, TOTAL_WORDS, FIELD_KEYS, type FieldKey,
} from './cell-field.ts';
import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES, TORCHES } from './cell.ts';

/** How many values each field actually has, read from the live enums — not copied. */
const VALUE_COUNT: Record<FieldKey, number> = {
  floor: FLOOR_MATERIALS.length,
  wallN: SEGS.length,
  wallW: SEGS.length,
  corner: CORNERS.length,
  wallType: WALL_TYPES.length,
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
    for (const table of [BIT_OFFSETS, BIT_SLOTS, BIT_WORD]) {
      expect(Object.keys(table).sort()).toEqual([...FIELD_KEYS].sort());
    }
  });

  it('no two fields overlap, and none runs past the usable end of its word', () => {
    const clashes: string[] = [];
    for (let w = 0; w < TOTAL_WORDS; w++) {
      const inWord = FIELD_KEYS.filter((k) => BIT_WORD[k] === w)
        .sort((a, b) => BIT_OFFSETS[a] - BIT_OFFSETS[b]);
      let next = 0;
      for (const k of inWord) {
        if (BIT_OFFSETS[k] < next) clashes.push(`${k} starts at ${BIT_OFFSETS[k]}, inside the field below it`);
        const end = BIT_OFFSETS[k] + BIT_SLOTS[k];
        // BIT 31 IS OFF LIMITS: JS bitwise coerces to int32, so `1 << 31` is negative while the same
        // bits out of a Uint32Array are positive, and two identical values compare unequal.
        if (end > BITS_PER_WORD) clashes.push(`${k} ends at bit ${end}, past the usable ${BITS_PER_WORD}`);
        next = end;
      }
    }
    expect(clashes).toEqual([]);
  });

  it('leaves real headroom, since the point of a slot is that appending a value is cheap', () => {
    // A field with zero spare is one append away from being the bug this file exists to catch. `torch`
    // is the deliberate exception: it is a flag, and a two-valued flag does not grow.
    const tight = FIELD_KEYS.filter((k) => k !== 'torch' && BIT_SLOTS[k] - VALUE_COUNT[k] < 1);
    expect(tight).toEqual([]);
  });
});
