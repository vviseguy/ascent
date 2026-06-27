// ============================================================================
// src/lab/wall-tile-assets.ts — the ARCHITECTURAL ELEMENT REGISTRY.
// ============================================================================
//
// THE list of architectural elements + how to TRIGGER each, mapping a resolved WallTile
// (src/floor/wall-tile.ts) onto REAL KayKit "Dungeon Remastered" meshes. No custom boxes.
// Yaw formulas are the proven ones the game renderer (src/render/dungeon.ts) already uses.
//
// TRIGGER TABLE (resolver case → KayKit asset → orientation)
// ┌─────────────┬───────────────────────────┬──────────────────────────────────────────────┐
// │ case        │ asset (dungeon_remastered)│ yaw                                            │
// ├─────────────┼───────────────────────────┼──────────────────────────────────────────────┤
// │ straight    │ wall  (or wallType asset) │ EW axis → 0 ; NS axis → π/2                     │
// │  + door     │ wall_arched               │  ″                                             │
// │  + arch     │ wall_arched               │  ″                                             │
// │  + window   │ wall_archedwindow_open    │  ″                                             │
// │  + low_gate │ wall_gated                │  ″                                             │
// │  + hole     │ wall_broken               │  ″                                             │
// │ corner      │ wall_corner (with column) │ {W,N}→0 {N,E}→π/2 {E,S}→π {S,W}→−π/2            │
// │ bend        │ wall_corner_small (no col)│ same yaw; triggered by a SINGLE-axis centre     │
// │ tee         │ wall_Tsplit               │ open S→0  W→π/2  N→π  E→−π/2                    │
// │ cross       │ wall_crossing             │ 0                                              │
// │ cap         │ wall_endcap               │ W→0  S→π/2  E→π  N→−π/2                         │
// │ caps        │ wall_endcap × N           │ capYaw per arm                                 │
// │ column      │ pillar                    │ 0                                              │
// │ post        │ barrier_column            │ 0                                              │
// │ barrier ↑   │ barrier / barrier_corner  │ same yaws as the wall equivalents              │
// │ custom/mix  │ pillar|barrier_column +   │ centre piece + per-arm pieces: an arm that MEETS │
// │             │   wall_half / wall_endcap │ a centre = half, else an END-CAP                │
// └─────────────┴───────────────────────────┴──────────────────────────────────────────────┘
// FLOOR (per corner): stone→floor_tile_large · dirt→floor_dirt_large · wood→floor_wood_large.
//   uniform (all corners equal) → one full tile; mixed → one tile per non-`none` corner.
//
// GAPS (no single KayKit asset): a BARRIER tee/cross (pack ships no barrier_Tsplit/crossing) →
//   composed from barrier_column + barrier_half arms; per-corner floor has no quarter assets →
//   quarter-scaled full tiles. Both flagged here, not silently approximated.
// ============================================================================

import {
  resolveWallTile,
  uniformFloor,
  FLOOR_CORNERS,
  type WallTile,
  type Dir,
  type WallType,
  type FloorMaterial,
  type FloorCorner,
} from '../floor/wall-tile.ts';

const DIR = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${DIR}/${f}.gltf.glb`;

/** The KayKit asset for every element this registry triggers (Dungeon Remastered). */
export const PIECE = {
  wall: u('wall'),
  corner: u('wall_corner'),
  cornerSmall: u('wall_corner_small'), // a corner BEND with no column
  tee: u('wall_Tsplit'),
  cross: u('wall_crossing'),
  cap: u('wall_endcap'),
  arch: u('wall_arched'),
  window: u('wall_archedwindow_open'),
  gate: u('wall_gated'),
  broken: u('wall_broken'),
  pillar: u('pillar'),
  barrier: u('barrier'),
  barrierCorner: u('barrier_corner'),
  barrierColumn: u('barrier_column'),
  barrierHalf: u('barrier_half'),
  wallHalf: u('wall_half'),
  floorStone: u('floor_tile_large'),
  floorDirt: u('floor_dirt_large'),
  floorWood: u('floor_wood_large'),
} as const;

const Q = Math.PI / 2;

const present = (t: WallTile): Dir[] => (['N', 'E', 'S', 'W'] as Dir[]).filter((d) => t[d] !== 'none');

/** wall_corner native joins W+N at yaw 0. */
function cornerYaw(ds: Dir[]): number {
  const s = new Set(ds);
  if (s.has('W') && s.has('N')) return 0;
  if (s.has('N') && s.has('E')) return Q;
  if (s.has('E') && s.has('S')) return Math.PI;
  return -Q; // S,W
}

/** wall_Tsplit native opens to the South; yaw to put the OPEN side (the missing dir) there. */
function teeYaw(ds: Dir[]): number {
  const s = new Set(ds);
  const open = (['N', 'E', 'S', 'W'] as Dir[]).find((d) => !s.has(d));
  if (open === 'S') return 0;
  if (open === 'W') return Q;
  if (open === 'N') return Math.PI;
  return -Q; // open E
}

/** wall_endcap native caps a wall extending West. */
function capYaw(d: Dir): number {
  if (d === 'W') return 0;
  if (d === 'S') return Q;
  if (d === 'E') return Math.PI;
  return -Q; // N
}

/** A straight wall's yaw: along E–W → 0, along N–S → π/2. */
const straightYaw = (ds: Dir[]): number => (ds.includes('E') || ds.includes('W') ? 0 : Q);

/** The wall asset for a single-axis WALL centre's opening kind. */
function wallTypeUrl(wt: WallType): string {
  switch (wt) {
    case 'door':
    case 'arch':
      return PIECE.arch;
    case 'window':
      return PIECE.window;
    case 'low_gate':
      return PIECE.gate;
    case 'hole':
      return PIECE.broken;
    case 'solid':
    default:
      return PIECE.wall;
  }
}

export interface WallPlacement {
  url: string;
  yaw: number;
}

/** The KayKit wall/barrier piece(s) that realize a tile's structure. All centred on the tile. */
export function wallPieces(tile: WallTile): WallPlacement[] {
  const a = resolveWallTile(tile);
  const ds = present(tile);
  const barrier = (tile.centre !== 'none' ? tile.centreType : tile[ds[0] ?? 'N']) === 'barrier';
  const at = (url: string, yaw = 0): WallPlacement => ({ url, yaw });

  switch (a.case) {
    case 'empty':
      return [];
    case 'column':
      return [at(PIECE.pillar)];
    case 'post':
      return [at(PIECE.barrierColumn)];
    case 'cap':
      return [at(barrier ? PIECE.barrierHalf : PIECE.cap, capYaw(ds[0]!))];
    case 'caps':
      return ds.map((d) => at(barrier ? PIECE.barrierHalf : PIECE.cap, capYaw(d)));
    case 'straight':
      return [at(barrier ? PIECE.barrier : wallTypeUrl(tile.wallType), straightYaw(ds))];
    case 'corner':
      return [at(barrier ? PIECE.barrierCorner : PIECE.corner, cornerYaw(ds))];
    case 'bend':
      return [at(barrier ? PIECE.barrierCorner : PIECE.cornerSmall, cornerYaw(ds))]; // no column
    case 'tee':
      return barrier ? composeArms(tile) : [at(PIECE.tee, teeYaw(ds))]; // no barrier_Tsplit asset
    case 'cross':
      return barrier ? composeArms(tile) : [at(PIECE.cross, 0)]; // no barrier_crossing asset
    case 'custom':
      return composeArms(tile);
  }
}

/** Compose a mixed/gap case from a centre piece + per-arm pieces (orientation approximate).
 *  An arm that MEETS a matching centre is an open `half`; an arm with no centre to meet (the
 *  resolver marks it `cap`) is an END-CAP, not a half. */
function composeArms(tile: WallTile): WallPlacement[] {
  const out: WallPlacement[] = [];
  const a = resolveWallTile(tile);
  if (tile.centre === 'both') out.push({ url: tile.centreType === 'barrier' ? PIECE.barrierColumn : PIECE.pillar, yaw: 0 });
  for (const d of present(tile)) {
    const capped = a.arms[d].terminal === 'cap'; // no centre on this axis → an end-cap
    const url =
      tile[d] === 'barrier'
        ? PIECE.barrierHalf // (the pack ships no barrier end-cap; half is the closest)
        : capped
          ? PIECE.cap
          : PIECE.wallHalf;
    out.push({ url, yaw: capYaw(d) });
  }
  return out;
}

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none'>, string> = {
  stone: PIECE.floorStone,
  dirt: PIECE.floorDirt,
  wood: PIECE.floorWood,
};

export interface FloorPlacement {
  url: string;
  /** `'full'` = one tile over the whole square; otherwise a quarter at that corner. */
  corner: FloorCorner | 'full';
}

/** The floor tile(s): one full tile when uniform, else one quarter per non-`none` corner. */
export function floorPieces(tile: WallTile): FloorPlacement[] {
  const f = tile.floor;
  const uni = uniformFloor(f);
  if (uni) return [{ url: FLOOR_URL[uni], corner: 'full' }];
  const out: FloorPlacement[] = [];
  for (const c of FLOOR_CORNERS) {
    const m = f[c];
    if (m !== 'none') out.push({ url: FLOOR_URL[m], corner: c });
  }
  return out;
}
