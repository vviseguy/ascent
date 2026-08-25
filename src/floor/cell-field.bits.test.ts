// The bit layout is a CLAIM about a representation nothing has built yet, which is precisely why it
// rotted: `wallType` grew from 6 values to 15 while its slot stayed at 7, and because no code reads
// these constants, nothing anywhere disagreed. A comment cannot hold an invariant. This does.
//
// It has since gone the other way — splitting the open/closed pairs out of the type enum brought the
// whole cell back inside ONE word — which is the same claim needing the same guard.
import { describe, it, expect } from 'vitest';
import {
  BIT_OFFSETS, BIT_SLOTS, BIT_WORDS, BITS_PER_WORD, TOTAL_WORDS, FIELD_KEYS, FIELD_SPEC, type FieldKey,
} from './cell-field.ts';

/* How many values each field actually has — READ FROM `FIELD_SPEC`, not copied.
   This was a fourth parallel table restating which enum belongs to which field, in the very test whose
   job is to catch parallel tables drifting apart. It could not have caught itself. */
const VALUE_COUNT: Record<FieldKey, number> =
  Object.fromEntries(FIELD_KEYS.map((k) => [k, FIELD_SPEC[k].values.length])) as Record<FieldKey, number>;

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

  it('no two fields overlap, and none runs past the usable end of ITS word', () => {
    /* PER WORD, since `ceiling` opened a second one. Checking a single running offset across every
       field silently required them all to share word 0, which is the constraint this table exists to
       relax rather than to enforce. */
    const clashes: string[] = [];
    for (let word = 0; word < TOTAL_WORDS; word++) {
      const inWord = FIELD_KEYS.filter((k) => BIT_WORDS[k] === word)
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

  it('declares exactly as many words as its fields actually need', () => {
    /* WAS "still fits in ONE word". It does not any more, and that is the correct outcome rather than
       a regression: `ceiling` is a seventh value-set of its own and word 0 was already at 31 of 31.
       What matters is not the number of words but that the number is DERIVED — the count and the
       layout come from the same table, so they cannot disagree the way the old parallel ones did. */
    const used = Math.max(...FIELD_KEYS.map((k) => BIT_WORDS[k])) + 1;
    expect(TOTAL_WORDS).toBe(used);
    for (let word = 0; word < TOTAL_WORDS; word++) {
      const need = FIELD_KEYS.filter((k) => BIT_WORDS[k] === word)
        .reduce((n, k) => n + VALUE_COUNT[k], 0);
      expect(need).toBeLessThanOrEqual(BITS_PER_WORD);
    }
  });

  it('every slot is sized to its field exactly, and no WORD overflows', () => {
    /* THE CHOICE THIS TEST DEMANDED HAS BEEN MADE, IN THE OPEN. It used to end "the next person to add
       a value has to choose between a re-slot and a second word", and `ceiling` was that person: seven
       more bits against a word already at 31 of 31, with every slot sized exactly to its field, so
       there was no re-slot to be had. Word 1.
       WHAT THAT COSTS, stated rather than discovered later: an earlier two-word layout measured ~1.6x
       slower on whole-field operations. That figure was taken on a PACKED representation, and there is
       no packed representation today — a field is an object of numbers (see cell-field.ts) — so the
       cost is owed, not paid. Anyone building the packed form inherits it.
       The invariant is unchanged in spirit: nothing silently overflows. It is now checked per word
       rather than across all of them, because "fits in one word" was the old answer to this question,
       not the question. */
    for (const k of FIELD_KEYS) {
      expect({ field: k, slots: BIT_SLOTS[k] }).toEqual({ field: k, slots: VALUE_COUNT[k] });
    }
    for (let word = 0; word < TOTAL_WORDS; word++) {
      const used = FIELD_KEYS.filter((k) => BIT_WORDS[k] === word)
        .reduce((n, k) => n + BIT_SLOTS[k], 0);
      expect({ word, used: used <= BITS_PER_WORD }).toEqual({ word, used: true });
    }
  });
});
