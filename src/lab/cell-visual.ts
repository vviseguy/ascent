// ============================================================================
// src/lab/cell-visual.ts — the schematic's visual language.
// ============================================================================
//
// A cell field is a SET of allowed values, and the schematic has to show the SET, not a winner. The
// old rule ("more than one value → flat grey") threw away exactly the information the editor exists to
// convey: {stone, dirt} and {stone, dirt, wood, rock} looked identical, and so did every ambiguous
// wall on the board.
//
// TWO CHANNELS, because colour alone cannot carry it:
//
//   COLOUR is ADDITIVE — every allowed value contributes its own colour and they mix. One value reads
//   as itself; a pair reads as a blend of the two; the full domain averages out to neutral grey, which
//   is the right look for "no opinion". The mix is done in LINEAR light, not on the sRGB bytes: mixing
//   #e8e3da with #333a44 as bytes gives a muddy sludge, because sRGB is a curve and averaging along it
//   is not averaging light.
//
//   PATTERN is per-VALUE — a hatch that belongs to one value and is drawn whenever that value is in
//   the domain. Sloped gets diagonals, rock a dense cross-hatch, stairs its treads. These are the ones
//   that are rare and easy to miss, and a hatch survives being mixed into a colour when a hue does not.
//
// So a wall that might be sloped is tan-ish AND carries diagonals; a wall that definitely is, is fully
// tan and carries them at full strength. Glanceable, and no value can hide inside a mixture.

import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES } from '../floor/cell.ts';
import type { Seg, FloorMaterial, Corner, WallType } from '../floor/cell.ts';
import type { Mask } from '../floor/cell-field.ts';

/* ---------------------------------- palette ---------------------------------- */

/**
 * THE SCHEMATIC IS SYMBOLIC, THE 3D IS LITERAL. These are not the colours the material has — they are
 * chosen so that MIXTURES stay legible, which means spreading them around the hue wheel rather than
 * making each one look like the thing it is.
 *
 * A naturalistic set is the obvious mistake here and it was the first thing tried: stone grey, dirt
 * brown, wood tan, rock dark brown, stairs sandstone — every one a warm neutral, so any mix of them
 * came out the same mud, and a domain of {stone, dirt} was indistinguishable from {wood, rock}. Since
 * the whole reason to mix is to show WHICH values are in play, the palette has to make hue carry it.
 * The 3D pane already shows what the material actually looks like.
 */
export const SEG_COLOR: Record<Seg, string> = {
  none: '#2a3038', wall: '#ece7de', barrier: '#5fa8e0', sloped: '#e0a24a',
};
export const FLOOR_COLOR: Record<FloorMaterial, string> = {
  none: '#1a1f2e',        // void — near black
  stone: '#8892a0',       // neutral blue-grey
  dirt: '#b07840',        // orange
  wood: '#c9a63e',        // yellow
  rock: '#454b52',        // dark slate — solid fill, deliberately close to `none` in value
  stairs: '#57b6c9',      // cyan
  stairs_wood: '#a87fd0', // violet
};
export const CORNER_COLOR: Record<Corner, string> = {
  solid: '#8a939d', column: '#e8e3da', air: '#5ad98b',
};
export const WALLTYPE_COLOR: Record<WallType, string> = {
  solid: '#6b727c', door: '#d9c05a', window: '#7fc8d9', hole: '#5ad98b',
  arch: '#c9a0d9', low_gate: '#d98f5a',
};
export const CONFLICT = '#e0524a';

/* ------------------------------ additive mixing ------------------------------ */

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToLinear = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
};
const linearToHex = (rgb: [number, number, number]): string =>
  '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');

/** The colours of every value the domain allows, mixed in linear light. Empty domain reads as a
 *  conflict; one value reads as itself exactly. */
export function mixMask<T extends string>(m: Mask, vals: readonly T[], table: Record<T, string>): string {
  if (m === 0) return CONFLICT;
  const on = vals.filter((_, i) => (m & (1 << i)) !== 0);
  if (on.length === 0) return CONFLICT;
  if (on.length === 1) return table[on[0]!];
  const sum: [number, number, number] = [0, 0, 0];
  for (const v of on) { const c = hexToLinear(table[v]); sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; }
  return linearToHex([sum[0] / on.length, sum[1] / on.length, sum[2] / on.length]);
}

export const maskValues = <T extends string>(m: Mask, vals: readonly T[]): T[] =>
  vals.filter((_, i) => (m & (1 << i)) !== 0);

/* --------------------------------- patterns ---------------------------------- */

/**
 * A hatch id per value, or null for the values that need none. Only the ones that are rare or easy to
 * confuse get one — hatching everything is the same as hatching nothing.
 */
export const FLOOR_HATCH: Partial<Record<FloorMaterial, string>> = {
  rock: 'h-rock', stairs: 'h-tread', stairs_wood: 'h-tread', wood: 'h-plank', dirt: 'h-grit',
};
export const SEG_HATCH: Partial<Record<Seg, string>> = { sloped: 'h-slope', barrier: 'h-bar' };

/** Every pattern the schematic can reference, as one `<defs>` block. Sized to the cell so a hatch
 *  reads at a glance rather than turning into moiré. */
export function patternDefs(unit: number): string {
  const s = Math.max(6, Math.round(unit / 5));
  return `<defs>
    <pattern id="h-slope" width="${s}" height="${s}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="${s}" stroke="#00000070" stroke-width="2.5"/>
    </pattern>
    <pattern id="h-bar" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
      <circle cx="${s / 2}" cy="${s / 2}" r="1.5" fill="#00000060"/>
    </pattern>
    <pattern id="h-rock" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
      <path d="M0,0 l${s},${s} M${s},0 l-${s},${s}" stroke="#00000075" stroke-width="1.6"/>
    </pattern>
    <pattern id="h-tread" width="${s * 2}" height="${Math.round(s / 1.6)}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${s * 2}" y2="0" stroke="#00000080" stroke-width="2"/>
    </pattern>
    <pattern id="h-plank" width="${s * 2}" height="${s}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${s * 2}" y2="0" stroke="#00000038" stroke-width="1.4"/>
      <line x1="${s}" y1="0" x2="${s}" y2="${s}" stroke="#00000038" stroke-width="1.4"/>
    </pattern>
    <pattern id="h-grit" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
      <circle cx="${s * 0.3}" cy="${s * 0.35}" r="1" fill="#00000055"/>
      <circle cx="${s * 0.75}" cy="${s * 0.7}" r="1" fill="#00000055"/>
    </pattern>
  </defs>`;
}

/**
 * The hatches to lay over one field, with the opacity each should get. A value that is CERTAIN hatches
 * at full strength; one of several possibilities hatches faintly, so "might be rock" and "is rock" are
 * different at a glance rather than only on inspection.
 */
export function hatchesFor<T extends string>(
  m: Mask, vals: readonly T[], table: Partial<Record<T, string>>,
): { id: string; opacity: number }[] {
  const on = maskValues(m, vals);
  const out: { id: string; opacity: number }[] = [];
  const seen = new Set<string>();
  for (const v of on) {
    const id = table[v];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, opacity: on.length === 1 ? 1 : 0.45 });
    if (out.length === 2) break; // two is legible; three is noise
  }
  return out;
}

/* ---------------------------------- legend ----------------------------------- */

export interface LegendRow { label: string; color: string; hatch?: string | undefined }

/** Every value the schematic can show, with the swatch it draws — so the key on screen is generated
 *  from the same tables the grid uses and cannot drift out of date. */
export function legend(): { title: string; rows: LegendRow[] }[] {
  return [
    { title: 'floor', rows: FLOOR_MATERIALS.map((v) => ({ label: v, color: FLOOR_COLOR[v], hatch: FLOOR_HATCH[v] })) },
    { title: 'wall', rows: SEGS.map((v) => ({ label: v, color: SEG_COLOR[v], hatch: SEG_HATCH[v] })) },
    { title: 'corner', rows: CORNERS.map((v) => ({ label: v, color: CORNER_COLOR[v] })) },
    { title: 'opening', rows: WALL_TYPES.map((v) => ({ label: v, color: WALLTYPE_COLOR[v] })) },
  ];
}
