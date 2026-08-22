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
  SEGS, FLOOR_MATERIALS, WALL_TYPES, CORNERS,
  type Cell, type Seg, type FloorMaterial, type WallType, type Corner,
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

/** How many values a domain still allows. 0 = conflict, 1 = decided. */
export const domainSize = (m: Mask): number => { let c = 0; for (let x = m; x; x >>= 1) c += x & 1; return c; };

/** The values a domain still allows, in canonical order. */
export const segValues = (m: Mask): Seg[] => valuesOf(SEGS, m);
export const floorValues = (m: Mask): FloorMaterial[] => valuesOf(FLOOR_MATERIALS, m);
export const wallTypeValues = (m: Mask): WallType[] => valuesOf(WALL_TYPES, m);
export const cornerValues = (m: Mask): Corner[] => valuesOf(CORNERS, m);

/** A cell of domains. Five fields, all owned — there is nothing here a neighbour also stores. */
export interface CellField {
  floor: Mask;
  wallN: Mask;
  wallW: Mask;
  corner: Mask;
  wallType: Mask;
}

export const FIELD_KEYS = ['floor', 'wallN', 'wallW', 'corner', 'wallType'] as const;

/**
 * THE BIT LAYOUT. A domain is a bitmask over its values, so a field of N values costs N bits — 19 in
 * total, which sits in one int32 with 12 to spare for growing the floor and wallType vocabularies.
 *
 *   bits  0–3   floor     (4 values)
 *   bits  4–6   wallN     (3)
 *   bits  7–9   wallW     (3)
 *   bits 10–12  corner    (3)
 *   bits 13–18  wallType  (6)
 *
 * ONE representation, not two. A "resolved" cell is simply a field whose every domain is a singleton;
 * there is no separate packed array. Measured: Int32Array ties or beats Uint16Array for this access
 * pattern even at 100x our cell count (JS bitwise coerces to int32 anyway, so a narrower load just
 * pays a zero-extend). A second representation would buy nothing and add a second thing that can
 * disagree with the first — which is exactly the class of bug that cost us an evening.
 */
export const BIT_OFFSETS: Record<FieldKey, number> = { floor: 0, wallN: 4, wallW: 7, corner: 10, wallType: 13 };
export const BIT_WIDTHS: Record<FieldKey, number> = { floor: 4, wallN: 3, wallW: 3, corner: 3, wallType: 6 };
export const TOTAL_BITS = 19;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** Every field allows everything — a cell nothing has claimed. */
export const fullField = (): CellField => ({
  floor: full(FLOOR_MATERIALS),
  wallN: full(SEGS),
  wallW: full(SEGS),
  corner: full(CORNERS),
  wallType: full(WALL_TYPES),
});

/** A concrete cell as singleton domains. */
export const fromCell = (c: Cell): CellField => ({
  floor: bitOf(FLOOR_MATERIALS, c.floor),
  wallN: bitOf(SEGS, c.wallN),
  wallW: bitOf(SEGS, c.wallW),
  corner: bitOf(CORNERS, c.corner),
  wallType: bitOf(WALL_TYPES, c.wallType),
});

export const cloneField = (f: CellField): CellField => ({ ...f });

/** Author a partial constraint. Anything left out ABSTAINS (stays fully open) — say what you mean. */
export function template(spec: Partial<Record<FieldKey, Mask>>): CellField {
  const f = fullField();
  for (const k of FIELD_KEYS) if (spec[k] !== undefined) f[k] = spec[k]!;
  return f;
}

/** AND-gate: intersect two fields — this IS stamping one onto the other. */
export const andGate = (a: CellField, b: CellField): CellField => ({
  floor: a.floor & b.floor,
  wallN: a.wallN & b.wallN,
  wallW: a.wallW & b.wallW,
  corner: a.corner & b.corner,
  wallType: a.wallType & b.wallType,
});

/** Which fields have gone EMPTY — no legal value remains. */
export const conflicts = (f: CellField): FieldKey[] => FIELD_KEYS.filter((k) => f[k] === 0);
export const hasConflict = (f: CellField): boolean => FIELD_KEYS.some((k) => f[k] === 0);

/** Is every field still fully unconstrained — a cell nothing has spoken about? */
export const isOpen = (f: CellField): boolean => {
  const o = fullField();
  return FIELD_KEYS.every((k) => f[k] === o[k]);
};

/** How a collapse chooses among surviving options. Returns an index into `options`. */
export type Pick = (field: FieldKey, options: readonly string[]) => number;

/**
 * Collapse every domain to one value → a concrete Cell, or null if any field is empty. `pick` is the
 * ONLY entropy seam; without it the canonical lowest surviving option wins, which makes the output a
 * pure function of the field.
 */
export function collapse(f: CellField, pick?: Pick): Cell | null {
  if (hasConflict(f)) return null;
  const choose = <T extends string>(key: FieldKey, vals: readonly T[], mask: Mask): T => {
    const opts = valuesOf(vals, mask);
    const i = pick ? ((pick(key, opts) % opts.length) + opts.length) % opts.length : 0;
    return opts[i]!;
  };
  return {
    floor: choose('floor', FLOOR_MATERIALS, f.floor),
    wallN: choose('wallN', SEGS, f.wallN),
    wallW: choose('wallW', SEGS, f.wallW),
    corner: choose('corner', CORNERS, f.corner),
    wallType: choose('wallType', WALL_TYPES, f.wallType),
  };
}
