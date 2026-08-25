// ============================================================================
// src/floor/cell-field.ts — the CONSTRAINT layer over a cell.
// ============================================================================
//
// A CellField is a cell whose every field holds a DOMAIN — the set of values still allowed there —
// as a small bitmask. A TEMPLATE is just a CellField with multi-option fields. The primitives are the
// same three the 4u model used, because they were never the problem:
//
//   fullField()      every field allows everything — a cell nothing has claimed yet.
//   template({...})  author a partial constraint; unspecified fields allow everything.
//   andGate(a, b)    STAMP one onto the other = intersect domains field-by-field (bitwise &).
//   conflicts(f)     which fields went EMPTY — what an atomic stamp must not trip.
//   collapse(f,pick) pick one value per surviving domain → a concrete Cell (null on conflict).
//
// ABSTAIN vs ASSERT. A full domain means "I have no opinion"; a singleton means "this is decided".
// They are different statements and the difference is load-bearing: leaving a field wide reads to
// every later phase as "help yourself", so anything that means to own a cell must SAY so. (A room's
// interior is air, and the room says it — that is what makes a wall stamped inside a room fail as an
// empty domain rather than needing to be policed.)
//
// Pure + deterministic — integer masks, bitwise ops, no float/RNG/Map-iteration on output. `collapse`'s
// `pick` is the only entropy seam; the default is the canonical lowest surviving option.

import {
  SEGS, FLOOR_MATERIALS, WALL_TYPES, CORNERS, TORCHES, OPENS,
  type Cell, type Seg, type FloorMaterial, type WallType, type Corner, type Torch, type Open,
} from './cell.ts';

/** A domain over one enum, as a bitmask (bit i set = the i-th value is allowed). */
export type Mask = number;

const full = (vals: readonly unknown[]): Mask => (1 << vals.length) - 1;
const bitOf = <T>(vals: readonly T[], v: T): Mask => 1 << vals.indexOf(v);
const maskOf = <T>(vals: readonly T[], allowed: readonly T[]): Mask => allowed.reduce((m, v) => m | bitOf(vals, v), 0);
const valuesOf = <T>(vals: readonly T[], mask: Mask): T[] => vals.filter((_, i) => (mask & (1 << i)) !== 0);

/** Allowed-set helpers for authoring (`segs('none','wall')` = those two, not barrier). */
export const segs = (...allowed: Seg[]): Mask => maskOf(SEGS, allowed);
export const floors = (...allowed: FloorMaterial[]): Mask => maskOf(FLOOR_MATERIALS, allowed);
export const wallTypes = (...allowed: WallType[]): Mask => maskOf(WALL_TYPES, allowed);
export const corners = (...allowed: Corner[]): Mask => maskOf(CORNERS, allowed);
export const torches = (...v: Torch[]): Mask => maskOf(TORCHES, v);
export const opens = (...v: Open[]): Mask => maskOf(OPENS, v);

/** How many values a domain still allows. 0 = conflict, 1 = decided. */
// `>>>`, not `>>`: a signed shift on a value with bit 31 set sign-extends forever.
export const domainSize = (m: Mask): number => { let c = 0; for (let x = m >>> 0; x; x >>>= 1) c += x & 1; return c; };

/** The values a domain still allows, in canonical order. */
export const segValues = (m: Mask): Seg[] => valuesOf(SEGS, m);
export const floorValues = (m: Mask): FloorMaterial[] => valuesOf(FLOOR_MATERIALS, m);
export const wallTypeValues = (m: Mask): WallType[] => valuesOf(WALL_TYPES, m);
export const cornerValues = (m: Mask): Corner[] => valuesOf(CORNERS, m);

/** A cell of domains. Five fields, all owned — there is nothing here a neighbour also stores. */
export interface CellField {
  floor: Mask;
  ceiling: Mask;
  wallN: Mask;
  wallW: Mask;
  corner: Mask;
  wallType: Mask;
  open: Mask;
  torch: Mask;
}

export const FIELD_KEYS = ['floor', 'ceiling', 'wallN', 'wallW', 'corner', 'wallType', 'open', 'torch'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/**
 * ONE ROW PER FIELD — its values, its bit slot, and what it settles to when nobody claimed it.
 *
 * This used to be THREE parallel `Record<FieldKey, …>` tables plus the value set restated inline in
 * four functions, and the only thing keeping them in step was that somebody remembered. It did not
 * hold: `wallType` grew from 6 values to 15 while its slot stayed at 7, so the bit layout described a
 * packing that would have truncated more than half of it. Nothing read those constants, so the drift
 * was inert rather than corrupting — which is exactly why it survived. Parallel tables that must
 * agree, and that nothing forces to agree, are a bug with a delay on it.
 *
 * `values` is the canonical ORDER as well as the set: bit i means `values[i]`, so reordering an enum
 * silently rewrites every mask ever stored. Append, never insert.
 */
export const FIELD_SPEC = {
  /* WORD 1 HOLDS THE TWO SURFACES. `floor` used to live at the bottom of word 0, and adding an eighth
     material took it from 7 slots to 8 against a word that was already at 31 of 31. Rather than shave
     someone else, both cell-owned fields moved together into word 1, which had only the lid in it:
     they share a value set, they are edited as a pair, and putting them side by side means the next
     material costs one bit in a word with room instead of a reshuffle of everything. */
  floor: { values: FLOOR_MATERIALS, word: 1, bit: 8, slot: 8, settles: 'stone' },
  ceiling: { values: FLOOR_MATERIALS, word: 1, bit: 0, slot: 8, settles: 'none' },
  wallN: { values: SEGS, word: 0, bit: 0, slot: 4, settles: 'none' },
  wallW: { values: SEGS, word: 0, bit: 4, slot: 4, settles: 'none' },
  corner: { values: CORNERS, word: 0, bit: 8, slot: 3, settles: 'none' },
  wallType: { values: WALL_TYPES, word: 0, bit: 11, slot: 9, settles: 'solid' },
  open: { values: OPENS, word: 0, bit: 20, slot: 2, settles: 'closed' },
  torch: { values: TORCHES, word: 0, bit: 22, slot: 2, settles: 'no' },
} as const satisfies Record<FieldKey, { values: readonly string[]; word: number; bit: number; slot: number; settles: string }>;

/** Which word each field lives in. Derived — see `FIELD_SPEC`. */
export const BIT_WORDS: Record<FieldKey, number> =
  Object.fromEntries(FIELD_KEYS.map((k) => [k, FIELD_SPEC[k].word])) as Record<FieldKey, number>;

/**
 * THE BIT LAYOUT — for a packed representation, with room left over ON PURPOSE.
 *
 * A domain is a bitmask over its values, so a field of N values needs N bits. Each field gets a SLOT
 * WIDER THAN IT USES, so appending a value costs one bit inside that field's slot and shifts nothing
 * else. Without the padding, giving `floor` another material would move every field above it and
 * invalidate anything already packed.
 *
 * IT NO LONGER FITS IN ONE WORD, and pretending otherwise is how this table went quietly wrong:
 * `wallType` grew from 6 values to 15 while its slot stayed at 7, so the declared layout described a
 * packing that would have silently truncated more than half of it. Nothing reads these constants — the
 * live `CellField` is an object of numbers — so it was inert rather than corrupting, which is exactly
 * why nothing caught it. `cell-field.test.ts` now asserts the invariant instead of trusting the
 * comment.
 *
 *   WORD 0                                   WORD 1
 *   bits  0–7    floor    8 slots,  7 used   bits 0–19  wallType  20 slots, 15 used
 *   bits  8–12   wallN    5 slots,  4 used
 *   bits 13–17   wallW    5 slots,  4 used
 *   bits 18–21   corner   4 slots,  3 used
 *   bits 22–23   torch    2 slots,  2 used
 *                ─────────────────────────
 *                24 bits used, 7 spare       20 bits used, 11 spare
 *
 * `wallType` gets a word to itself because it is the field that actually grows: it is the catalogue of
 * what an author can put in a wall, and the kit has more assets in it than we have exposed.
 *
 * WHY BIT 31 IS OFF LIMITS even in a Uint32Array. The storage would hold it fine, but JavaScript's
 * bitwise operators coerce to INT32 — so `1 << 31` is negative while the same bits read back out of a
 * Uint32Array are positive, and `a === b` is then false for two values with identical bits. Signed
 * shifts sign-extend forever, too (see `domainSize`). It is usable with `>>> 0` discipline everywhere,
 * and there is no reason to pay that vigilance for a bit we do not need.
 *
 * ONE representation, not two. A "resolved" cell is simply a field whose every domain is a singleton;
 * there is no separate packed array. Measured: Int32Array ties or beats Uint16Array for this access
 * pattern even at 100x our cell count (JS bitwise coerces to int32 anyway, so a narrower load just
 * pays a zero-extend). A second representation would buy nothing and add a second thing that can
 * disagree with the first — which is exactly the class of bug that cost us an evening.
 */
/* DERIVED from `FIELD_SPEC`, not restated beside it. Kept as exports because the layout test and any
   future packed representation want them by name, but there is now exactly one place to edit. */
export const BIT_OFFSETS: Record<FieldKey, number> =
  Object.fromEntries(FIELD_KEYS.map((k) => [k, FIELD_SPEC[k].bit])) as Record<FieldKey, number>;
export const BIT_SLOTS: Record<FieldKey, number> =
  Object.fromEntries(FIELD_KEYS.map((k) => [k, FIELD_SPEC[k].slot])) as Record<FieldKey, number>;
/** Usable bits per word — 31, not 32; see the note on bit 31 above. */
export const BITS_PER_WORD = 31;
export const TOTAL_WORDS = Math.max(...FIELD_KEYS.map((k) => FIELD_SPEC[k].word)) + 1;
/** Every field allows everything — a cell nothing has claimed. */
export const fullField = (): CellField =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, full(FIELD_SPEC[k].values)])) as unknown as CellField;

/** A concrete cell as singleton domains. */
export const fromCell = (c: Cell): CellField =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, bitOf(FIELD_SPEC[k].values, c[k])])) as unknown as CellField;

export const cloneField = (f: CellField): CellField => ({ ...f });

/** Author a partial constraint. Anything left out ABSTAINS (stays fully open) — say what you mean. */
export function template(spec: Partial<Record<FieldKey, Mask>>): CellField {
  const f = fullField();
  for (const k of FIELD_KEYS) if (spec[k] !== undefined) f[k] = spec[k]!;
  return f;
}

/** AND-gate: intersect two fields — this IS stamping one onto the other. */
export const andGate = (a: CellField, b: CellField): CellField =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, a[k] & b[k]])) as unknown as CellField;

/** Which fields have gone EMPTY — no legal value remains. */
export const conflicts = (f: CellField): FieldKey[] => FIELD_KEYS.filter((k) => f[k] === 0);
export const hasConflict = (f: CellField): boolean => FIELD_KEYS.some((k) => f[k] === 0);

/** Is every field still fully unconstrained — a cell nothing has spoken about? */
export const isOpen = (f: CellField): boolean => {
  const o = fullField();
  return FIELD_KEYS.every((k) => f[k] === o[k]);
};

/**
 * THE SETTLE DEFAULTS — what an undecided field becomes when nobody claimed it.
 *
 * Open walls, stone ground, a solid junction, no opening. Exported and shared, because the GENERATOR
 * settles with these and the EDITOR previews with them: if the two drifted, the editor would show you
 * a structure that is not the one the generator builds. (It did, before this existed — a blank grid
 * previewed as an all-pit floor, because a bare `collapse` takes the canonical lowest option and the
 * lowest floor material happens to be `none`.)
 */
export const SETTLE_DEFAULTS: Record<FieldKey, Mask> =
  Object.fromEntries(FIELD_KEYS.map((k) => [k, bitOf(FIELD_SPEC[k].values, FIELD_SPEC[k].settles)])) as Record<FieldKey, Mask>;

/** Narrow one field to its settle default, or — if the default was ruled out — to the canonical
 *  lowest surviving option. ALWAYS returns a singleton, which is what "fully determined" requires. */
export const settleMask = (m: Mask, key: FieldKey): Mask => {
  if (m === 0) return 0;
  const pref = m & SETTLE_DEFAULTS[key];
  return pref !== 0 ? pref : (m & -m);
};

/** The whole field, settled. */
export const settleField = (f: CellField): CellField =>
  Object.fromEntries(FIELD_KEYS.map((k) => [k, settleMask(f[k], k)])) as unknown as CellField;

/** What the generator will actually build from this field. Use this for any PREVIEW — a bare
 *  `collapse` shows the canonical-lowest option, which is not what ships. */
export const previewCell = (f: CellField): Cell | null => collapse(settleField(f));

/** How a collapse chooses among surviving options. Returns an index into `options`. */
export type Pick = (field: FieldKey, options: readonly string[]) => number;

/**
 * Collapse every domain to one value → a concrete Cell, or null if any field is empty. `pick` is the
 * ONLY entropy seam; without it the canonical lowest surviving option wins, which makes the output a
 * pure function of the field.
 */
/* COLLAPSE STAYS WRITTEN OUT, and that is a decision rather than an oversight.
   Everything above is a per-key operation on NUMBERS, where a loop loses nothing. This is the seam
   where a field becomes a typed `Cell`, and it is the only place the per-field types are actually
   worth anything: written as a loop it yields `Record<FieldKey, string>` and needs a cast, which
   would let `floor` hold a `Seg` with nothing to say so. Two lines of tedium a year is a fair price
   for the one boundary that checks. */
export function collapse(f: CellField, pick?: Pick): Cell | null {
  if (hasConflict(f)) return null;
  const choose = <T extends string>(key: FieldKey, vals: readonly T[], mask: Mask): T => {
    const opts = valuesOf(vals, mask);
    const i = pick ? ((pick(key, opts) % opts.length) + opts.length) % opts.length : 0;
    return opts[i]!;
  };
  return {
    floor: choose('floor', FLOOR_MATERIALS, f.floor),
    ceiling: choose('ceiling', FLOOR_MATERIALS, f.ceiling),
    wallN: choose('wallN', SEGS, f.wallN),
    wallW: choose('wallW', SEGS, f.wallW),
    corner: choose('corner', CORNERS, f.corner),
    wallType: choose('wallType', WALL_TYPES, f.wallType),
    open: choose('open', OPENS, f.open),
    torch: choose('torch', TORCHES, f.torch),
  };
}
