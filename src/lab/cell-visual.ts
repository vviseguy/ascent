// ============================================================================
// src/lab/cell-visual.ts — the schematic's visual language.
// ============================================================================
//
// A cell field is a SET of allowed values, and the schematic has to show the SET. Averaging the
// members' colours was the first attempt and it is not good enough: an average is LOSSY. Yellow could
// mean {red, green} or it could mean some third value that happens to be yellow, and you cannot tell.
//
// SO THE CHANNELS ARE THE ALPHABET. Each value owns one of R, G or B, and a domain lights the channels
// of the values it allows. The result is DECODABLE, not merely suggestive:
//
//        red = A          yellow  = A+B          white = A+B+C
//      green = B          magenta = A+C          black = nothing allowed (a conflict)
//       blue = C          cyan    = B+C
//
// You read a mixture back to its members by eye. That only works with at most three values per
// channel-group, which is the real constraint this design is built around — where a field has more
// than three, it is split into a base of three plus PARALLEL channels that ride alongside:
//
//   FLOOR    stone/dirt/wood are the three colours. `stairs` is not a fourth colour — it is a
//            LOW-RISE DIAGONAL over the colour of the material it is made of, so a stone flight is a
//            hatched stone cell. `rock` (filled) is a diagonal the OTHER way, so filled and stairs are
//            independent and can be read at the same time. `none` dims the fill rather than taking a
//            colour, because "there might be no floor" is about absence, not material.
//   WALL     none/wall/barrier/sloped — colour only, no hatch. `none` dashes the line: dashed means
//            "might not be there", which is the same thing absence means everywhere else here.
//   CORNER   solid/column/air — three values, three channels, nothing extra needed.
//   OPENING  six values, so TWO RINGS of three drawn tight around the corner dot: the inner ring is
//            solid/door/window, the outer hole/arch/low_gate. Six independent bits shown in the space
//            of a corner, and a plain `solid` corner draws no ring at all so the board stays quiet.

import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES } from '../floor/cell.ts';
import type { Seg, FloorMaterial, Corner, WallType } from '../floor/cell.ts';
import type { Mask } from '../floor/cell-field.ts';

/* ---------------------------------- channels --------------------------------- */

export type Channel = 0 | 1 | 2; // R, G, B

/** Lit and unlit levels per channel. Not 255/0: pure primaries over a whole room glare, and green reads
 *  far brighter than blue at the same value, so the peaks are balanced by eye while staying far enough
 *  apart that a mixture is unambiguous. */
const LIT = [198, 168, 214];
const DIM = [34, 36, 44];

/**
 * CERTAINTY IS INTENSITY, and this is the correction that makes the whole scheme usable.
 *
 * Additive channels have an unfortunate property on their own: "no opinion" lights EVERY channel, so
 * the most common state on a half-finished board — abstaining — comes out white, and the board screams
 * at you about the fields you have not decided yet. A decided field, the thing you actually want to
 * see, is no louder than the noise.
 *
 * So the hue says WHICH values, and the strength says HOW MANY: one value draws at full, and the more
 * a field still allows the fainter it gets. A decided cell pops; an undecided one recedes to a wash
 * you can still read the hue of when you look for it.
 */
export function certainty(count: number, total: number): number {
  if (count <= 1) return 1;
  if (count >= total) return 0.34;
  return 1 - (0.66 * (count - 1)) / Math.max(1, total - 1);
}

/**
 * THE FLOOR IS PAPER, THE WALLS AND CORNERS ARE INK.
 *
 * Channels are assigned per FIELD, so `wall` and `stone` both own channel 0 — and a red wall drawn on
 * a red floor is invisible. Hue cannot separate the layers because hue is already carrying which
 * values are allowed, so BRIGHTNESS does it: ground is drawn muted, everything that sits on top of it
 * is drawn at full, and walls additionally get a dark casing so they read over any ground at all.
 */
export type Layer = 'ground' | 'ink';
const GROUND_SCALE = 0.46;

export const rgb = (on: readonly boolean[], layer: Layer = 'ink'): string => {
  const k = layer === 'ground' ? GROUND_SCALE : 1;
  return '#' + [0, 1, 2]
    .map((i) => Math.round((on[i] ? LIT[i]! : DIM[i]!) * (on[i] ? k : 1)).toString(16).padStart(2, '0'))
    .join('');
};
/** The dark casing drawn under a wall so its colour never merges with the ground beneath it. */
export const CASING = '#0d1016';

/** The colour of one channel on its own — for legends and brush swatches. */
export const channelColor = (c: Channel): string => rgb([c === 0, c === 1, c === 2]);

const maskHas = <T extends string>(m: Mask, vals: readonly T[], v: T): boolean => {
  const i = vals.indexOf(v);
  return i >= 0 && (m & (1 << i)) !== 0;
};
export const maskValues = <T extends string>(m: Mask, vals: readonly T[]): T[] =>
  vals.filter((_, i) => (m & (1 << i)) !== 0);

/** Light the channels of whichever listed values the domain allows. */
function channels<T extends string>(m: Mask, vals: readonly T[], map: Partial<Record<T, Channel>>): boolean[] {
  const on = [false, false, false];
  for (const v of maskValues(m, vals)) {
    const c = map[v];
    if (c !== undefined) on[c] = true;
  }
  return on;
}

/* ----------------------------------- floor ----------------------------------- */

/** The three material channels. Stair materials light the channel of what they are MADE of, so a stone
 *  flight is a stone-coloured cell wearing the stair hatch. */
export const FLOOR_CHANNEL: Partial<Record<FloorMaterial, Channel>> = {
  stone: 0, dirt: 1, wood: 2, stairs: 0, stairs_wood: 2,
};
const STAIRY: readonly FloorMaterial[] = ['stairs', 'stairs_wood'];

export interface FloorInk {
  /** Channel mix of the materials in play. */
  fill: string;
  /** How strongly to draw it — see `certainty`. */
  strength: number;
  /** `none` is allowed — the ground might not be there at all. */
  maybeVoid: boolean;
  /** `none` is the ONLY thing allowed: draw no ground. */
  certainlyVoid: boolean;
  /** Hatches riding alongside the colour, each with the strength of its certainty. */
  hatches: { id: string; opacity: number }[];
  /** Nothing is allowed at all. */
  conflict: boolean;
}

export function floorInk(m: Mask): FloorInk {
  if (m === 0) return { fill: rgb([false, false, false]), strength: 1, maybeVoid: false, certainlyVoid: false, hatches: [], conflict: true };
  const vals = maskValues(m, FLOOR_MATERIALS);
  const maybeVoid = vals.includes('none');
  const certainlyVoid = vals.length === 1 && maybeVoid;
  const hatches: { id: string; opacity: number }[] = [];
  // the two PARALLEL channels — opposite diagonals, so both can be read at once
  const stairs = vals.filter((v) => STAIRY.includes(v));
  if (stairs.length) hatches.push({ id: 'h-stair', opacity: stairs.length === vals.length ? 0.95 : 0.45 });
  if (vals.includes('rock')) hatches.push({ id: 'h-fill', opacity: vals.length === 1 ? 0.95 : 0.45 });
  return {
    fill: rgb(channels(m, FLOOR_MATERIALS, FLOOR_CHANNEL), 'ground'),
    strength: certainty(vals.length, FLOOR_MATERIALS.length),
    maybeVoid, certainlyVoid, hatches, conflict: false,
  };
}

/* ------------------------------------ wall ----------------------------------- */

/** Colour only — no hatch. Three real states plus `none`, which is absence rather than a colour. */
export const SEG_CHANNEL: Partial<Record<Seg, Channel>> = { wall: 0, barrier: 1, sloped: 2 };

export interface SegInk { stroke: string; strength: number; maybeGone: boolean; certainlyGone: boolean; conflict: boolean }

export function segInk(m: Mask): SegInk {
  if (m === 0) return { stroke: rgb([false, false, false]), strength: 1, maybeGone: false, certainlyGone: false, conflict: true };
  const vals = maskValues(m, SEGS);
  const maybeGone = vals.includes('none');
  return {
    stroke: rgb(channels(m, SEGS, SEG_CHANNEL)),
    strength: certainty(vals.length, SEGS.length),
    maybeGone,
    certainlyGone: vals.length === 1 && maybeGone,
    conflict: false,
  };
}

/* ----------------------------------- corner ---------------------------------- */

export const CORNER_CHANNEL: Partial<Record<Corner, Channel>> = { solid: 0, column: 1, air: 2 };
export const cornerInk = (m: Mask): string =>
  m === 0 ? rgb([false, false, false]) : rgb(channels(m, CORNERS, CORNER_CHANNEL));
export const cornerStrength = (m: Mask): number => certainty(maskValues(m, CORNERS).length, CORNERS.length);

/* ---------------------------------- opening ---------------------------------- */

/** SIX values do not fit three channels, so they are split across two rings drawn tight around the
 *  corner — the corner's own boundary, in effect. Inner is the ordinary three, outer the rarer three. */
export const OPENING_RING: readonly (readonly WallType[])[] = [
  ['solid', 'door', 'window'],
  ['hole', 'arch', 'low_gate'],
];

/** `null` for a ring with nothing in it, so a plain solid corner draws no rings at all. */
export function openingRings(m: Mask): (string | null)[] {
  return OPENING_RING.map((ring) => {
    const on = ring.map((v) => maskHas(m, WALL_TYPES, v));
    return on.some(Boolean) ? rgb(on) : null;
  });
}
/**
 * Is this opening not worth drawing? Two cases, and the second is the one that matters:
 *
 *   - plain `solid` — the default, and marking every ordinary corner is marking nothing;
 *   - ABSTAINING — every type still allowed, which is "I have no opinion", and a ring is a CLAIM.
 *     Without this every untouched corner on the board wore two full rings, so the loudest marks
 *     were the ones with the least to say.
 */
export const openingIsPlain = (m: Mask): boolean => {
  const v = maskValues(m, WALL_TYPES);
  if (v.length >= WALL_TYPES.length) return true;
  return v.length === 1 && v[0] === 'solid';
};

/* --------------------------------- patterns ---------------------------------- */

/**
 * The two diagonals, deliberately opposite so they never read as one texture. `h-stair` is shallow —
 * a low-rise diagonal, the way a stair is drawn on a plan — and `h-fill` is the other way and denser,
 * because solid fill should feel heavier than a walkable flight.
 */
export function patternDefs(unit: number): string {
  const s = Math.max(7, Math.round(unit / 4));
  return `<defs>
    <pattern id="h-stair" width="${s * 2}" height="${s}" patternUnits="userSpaceOnUse"
             patternTransform="rotate(-20)">
      <line x1="0" y1="0" x2="${s * 2}" y2="0" stroke="#000000aa" stroke-width="2.4"/>
    </pattern>
    <pattern id="h-fill" width="${Math.round(s / 1.5)}" height="${Math.round(s / 1.5)}"
             patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${s}" stroke="#000000b0" stroke-width="2.6"/>
    </pattern>
  </defs>`;
}

/* -------------------------- one resolved value at a time ---------------------- */
// The ghost of the storey below draws COLLAPSED cells, not domains, so it needs the colour of a single
// value. Same tables, so a ghost and a live cell of the same material are the same colour.

export const floorValueColor = (v: FloorMaterial): string => {
  const c = FLOOR_CHANNEL[v];
  return c === undefined ? rgb([false, false, false], 'ground') : rgb([c === 0, c === 1, c === 2], 'ground');
};
export const floorValueHatch = (v: FloorMaterial): string | null =>
  STAIRY.includes(v) ? 'h-stair' : v === 'rock' ? 'h-fill' : null;
export const segValueColor = (v: Seg): string => {
  const c = SEG_CHANNEL[v];
  return c === undefined ? rgb([false, false, false]) : channelColor(c);
};

/* --------------------------------- swatches ---------------------------------- */
// Per-VALUE colour tables, built from the channel maps so a brush chip, a legend row and a painted
// cell of the same value can never disagree. `none` has no channel and shows as the unlit ground.

const swatchTable = <T extends string>(
  vals: readonly T[], map: Partial<Record<T, Channel>>, layer: Layer = 'ink',
): Record<T, string> =>
  Object.fromEntries(vals.map((v) => {
    const c = map[v];
    return [v, c === undefined ? rgb([false, false, false], layer) : rgb([c === 0, c === 1, c === 2], layer)];
  })) as Record<T, string>;

export const SEG_SWATCH = swatchTable(SEGS, SEG_CHANNEL);
export const FLOOR_SWATCH = swatchTable(FLOOR_MATERIALS, FLOOR_CHANNEL, 'ground');
export const CORNER_SWATCH = swatchTable(CORNERS, CORNER_CHANNEL);
/** An opening's colour is its position WITHIN its ring; the ring it sits on carries the rest. */
export const WALLTYPE_SWATCH: Record<WallType, string> = Object.fromEntries(
  OPENING_RING.flatMap((ring) => ring.map((v, j) => [v, channelColor(j as Channel)])),
) as Record<WallType, string>;

/* ---------------------------------- legend ----------------------------------- */

export interface LegendRow { label: string; color: string; hatch?: string | undefined; note?: string | undefined }

export function legend(): { title: string; note: string; rows: LegendRow[] }[] {
  const ch = (c: Channel | undefined): string => (c === undefined ? rgb([false, false, false]) : channelColor(c));
  return [
    {
      title: 'floor',
      note: 'stone + dirt = yellow, all three = white. Stairs and fill are diagonals that ride ON the material colour.',
      rows: [
        ...(['stone', 'dirt', 'wood'] as const).map((v) => ({ label: v, color: FLOOR_SWATCH[v] })),
        { label: 'stairs', color: FLOOR_SWATCH.stairs, hatch: 'h-stair', note: 'coloured by material' },
        { label: 'filled (rock)', color: FLOOR_SWATCH.rock, hatch: 'h-fill' },
        { label: 'none', color: FLOOR_SWATCH.none, note: 'dims the fill' },
      ],
    },
    {
      title: 'wall',
      note: 'colour only. A dashed line means `none` is allowed — it might not be there.',
      rows: [
        ...(['wall', 'barrier', 'sloped'] as const).map((v) => ({ label: v, color: ch(SEG_CHANNEL[v]) })),
        { label: 'none', color: rgb([false, false, false]) },
      ],
    },
    {
      title: 'corner',
      note: '',
      rows: CORNERS.map((v) => ({ label: v, color: ch(CORNER_CHANNEL[v]) })),
    },
    {
      title: 'opening',
      note: 'two rings around the corner: inner solid/door/window, outer hole/arch/low_gate.',
      rows: OPENING_RING.flatMap((ring, i) =>
        ring.map((v, j) => ({ label: `${v}`, color: channelColor(j as Channel), note: i === 0 ? 'inner' : 'outer' }))),
    },
  ];
}
