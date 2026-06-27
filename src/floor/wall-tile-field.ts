// ============================================================================
// src/floor/wall-tile-field.ts — the CONSTRAINT layer over the 9-cell tile.
// ============================================================================
//
// A TileField is a tile whose every cell holds a DOMAIN — the *set* of values still allowed
// there — represented as a small **bitmask**. A TEMPLATE is just a TileField with multi-option
// cells (e.g. `edge.N ∈ {none, wall}`, not barrier). The generation primitives:
//
//   fullField()        every cell allows everything — the map's initial state.
//   fromTile(t)        a concrete tile as singleton domains.
//   template({...})    author a template; unspecified cells allow everything.
//   andGate(map, t)    STAMP a template onto the map = intersect domains cell-by-cell (bitwise &).
//   conflicts(f)       which cells went EMPTY — the "nor gate" the AND-stamp must not trip.
//   collapse(f, pick)  pick one value per surviving domain → a concrete WallTile (null on conflict).
//
// Pure + deterministic — masks are integers, ops are bitwise, no float/RNG/Map-iteration on
// output. `collapse`'s `pick` is the only entropy seam; default is the canonical lowest option.

import {
  DIRS,
  FLOOR_CORNERS,
  type WallTile,
  type Seg,
  type Centre,
  type WallType,
  type FloorMaterial,
  type Dir,
  type FloorCorner,
  type SideSet,
} from './wall-tile.ts';

/** A domain over some enum, as a bitmask (bit i set = the i-th value is allowed). */
export type Mask = number;

// the bit ORDER for each enum (index = bit position) — stable; do not reorder.
const SEGS: readonly Seg[] = ['none', 'wall', 'barrier'];
const CENTRES: readonly Centre[] = ['none', 'wall', 'barrier'];
const WALLTYPES: readonly WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];
const FLOORS: readonly FloorMaterial[] = ['none', 'stone', 'dirt', 'wood'];

const full = (vals: readonly unknown[]): Mask => (1 << vals.length) - 1;
const bitOf = <T>(vals: readonly T[], v: T): Mask => 1 << vals.indexOf(v);
const maskOf = <T>(vals: readonly T[], allowed: readonly T[]): Mask => allowed.reduce((m, v) => m | bitOf(vals, v), 0);
const valuesOf = <T>(vals: readonly T[], mask: Mask): T[] => vals.filter((_, i) => (mask & (1 << i)) !== 0);

/** A tile of domains. A concrete tile = all singletons; a template = some multi-option. */
export interface TileField {
  floor: Record<FloorCorner, Mask>;
  edge: Record<Dir, Mask>;
  inner: Record<Dir, Mask>;
  centre: Mask;
  wallType: Mask;
}

const sideAll = (): Record<Dir, Mask> => ({ N: full(SEGS), E: full(SEGS), S: full(SEGS), W: full(SEGS) });

/** The "anything" field — every cell allows everything. The map's initial state before stamping. */
export function fullField(): TileField {
  return {
    floor: { nw: full(FLOORS), ne: full(FLOORS), sw: full(FLOORS), se: full(FLOORS) },
    edge: sideAll(),
    inner: sideAll(),
    centre: full(CENTRES),
    wallType: full(WALLTYPES),
  };
}

/** A concrete tile as singleton domains. */
export function fromTile(t: WallTile): TileField {
  const side = (s: SideSet): Record<Dir, Mask> => ({ N: bitOf(SEGS, s.N), E: bitOf(SEGS, s.E), S: bitOf(SEGS, s.S), W: bitOf(SEGS, s.W) });
  return {
    floor: { nw: bitOf(FLOORS, t.floor.nw), ne: bitOf(FLOORS, t.floor.ne), sw: bitOf(FLOORS, t.floor.sw), se: bitOf(FLOORS, t.floor.se) },
    edge: side(t.edge),
    inner: side(t.inner),
    centre: bitOf(CENTRES, t.centre),
    wallType: bitOf(WALLTYPES, t.wallType),
  };
}

/* ------------------------------- template helpers ---------------------------- */

/** Allowed-set helpers for authoring a template (`segs('none','wall')` = those two, not barrier). */
export const segs = (...allowed: Seg[]): Mask => maskOf(SEGS, allowed);
export const centres = (...allowed: Centre[]): Mask => maskOf(CENTRES, allowed);
export const wallTypes = (...allowed: WallType[]): Mask => maskOf(WALLTYPES, allowed);
export const floors = (...allowed: FloorMaterial[]): Mask => maskOf(FLOORS, allowed);

export interface TemplateSpec {
  floor?: Partial<Record<FloorCorner, Mask>>;
  edge?: Partial<Record<Dir, Mask>>;
  inner?: Partial<Record<Dir, Mask>>;
  centre?: Mask;
  wallType?: Mask;
}

/** Build a template from partial per-cell option sets; unspecified cells allow everything. */
export function template(spec: TemplateSpec): TileField {
  const f = fullField();
  if (spec.floor) for (const c of FLOOR_CORNERS) if (spec.floor[c] !== undefined) f.floor[c] = spec.floor[c]!;
  if (spec.edge) for (const d of DIRS) if (spec.edge[d] !== undefined) f.edge[d] = spec.edge[d]!;
  if (spec.inner) for (const d of DIRS) if (spec.inner[d] !== undefined) f.inner[d] = spec.inner[d]!;
  if (spec.centre !== undefined) f.centre = spec.centre;
  if (spec.wallType !== undefined) f.wallType = spec.wallType;
  return f;
}

/* --------------------------------- operations -------------------------------- */

/** AND-gate: intersect two fields cell-by-cell — STAMP a template onto the map. */
export function andGate(a: TileField, b: TileField): TileField {
  const sand = (x: Record<Dir, Mask>, y: Record<Dir, Mask>): Record<Dir, Mask> => ({ N: x.N & y.N, E: x.E & y.E, S: x.S & y.S, W: x.W & y.W });
  return {
    floor: { nw: a.floor.nw & b.floor.nw, ne: a.floor.ne & b.floor.ne, sw: a.floor.sw & b.floor.sw, se: a.floor.se & b.floor.se },
    edge: sand(a.edge, b.edge),
    inner: sand(a.inner, b.inner),
    centre: a.centre & b.centre,
    wallType: a.wallType & b.wallType,
  };
}

/** Which cells (if any) have an EMPTY domain — the conflict the "nor gate" guards against. */
export function conflicts(f: TileField): string[] {
  const out: string[] = [];
  for (const c of FLOOR_CORNERS) if (f.floor[c] === 0) out.push(`floor.${c}`);
  for (const d of DIRS) {
    if (f.edge[d] === 0) out.push(`edge.${d}`);
    if (f.inner[d] === 0) out.push(`inner.${d}`);
  }
  if (f.centre === 0) out.push('centre');
  if (f.wallType === 0) out.push('wallType');
  return out;
}

export const hasConflict = (f: TileField): boolean => conflicts(f).length > 0;

/**
 * Collapse a field to a concrete tile by choosing one value per cell. `pick(cell, n)` selects an
 * index in `[0,n)` among the allowed values (default 0 = the canonical lowest option); swap in a
 * seeded coordinate hash for real generation. Returns null if any cell is empty (a conflict).
 */
export function collapse(f: TileField, pick?: (cell: string, options: number) => number): WallTile | null {
  if (hasConflict(f)) return null;
  const choose = <T>(cell: string, vals: readonly T[], mask: Mask): T => {
    const opts = valuesOf(vals, mask);
    const i = pick ? ((pick(cell, opts.length) % opts.length) + opts.length) % opts.length : 0;
    return opts[i]!;
  };
  const side = (which: 'edge' | 'inner', s: Record<Dir, Mask>): SideSet => ({
    N: choose(`${which}.N`, SEGS, s.N),
    E: choose(`${which}.E`, SEGS, s.E),
    S: choose(`${which}.S`, SEGS, s.S),
    W: choose(`${which}.W`, SEGS, s.W),
  });
  return {
    floor: {
      nw: choose('floor.nw', FLOORS, f.floor.nw),
      ne: choose('floor.ne', FLOORS, f.floor.ne),
      sw: choose('floor.sw', FLOORS, f.floor.sw),
      se: choose('floor.se', FLOORS, f.floor.se),
    },
    edge: side('edge', f.edge),
    inner: side('inner', f.inner),
    centre: choose('centre', CENTRES, f.centre),
    wallType: choose('wallType', WALLTYPES, f.wallType),
  };
}
