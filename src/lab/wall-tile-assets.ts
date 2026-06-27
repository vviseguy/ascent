// ============================================================================
// src/lab/wall-tile-assets.ts — the ARCHITECTURAL ELEMENT REGISTRY (9-cell model).
// ============================================================================
//
// THE single placement authority: `tilePlacements(tile)` turns a WallTile
// (src/floor/wall-tile.ts) into a flat list of REAL KayKit Dungeon Remastered mesh
// placements — floor + walls + centre column, each `{url, x, y, z, yaw, scale}`. The
// renderer/collision just builds each url and applies the transform; no placement maths
// anywhere else. No custom boxes. Orientation reuses the game renderer's proven yaws.
//
// COMPOSITION (per arm = a direction's inner + edge cell):
//   reaches centre AND edge → a half-wall (wall_half / barrier_half) centre→edge
//   reaches centre only      → a capped half from centre (wall_half_endcap) — an inner stub
//   reaches edge only        → a capped half at the edge, facing out (the edge cap)
//   a clean FULL corner (2 adjacent full arms, nothing else) → ONE mitered wall_corner
//   a full straight LINE + wallType → one spanning opening piece (arch/window/gated/broken)
// CENTRE column is ADDITIVE: wall → pillar, barrier → barrier_column.
// FLOOR (per corner): uniform → one full tile; mixed → a quarter per non-none corner.
//
// NOTE: arm yaw/offset constants (armYaw / EDGE) are tuned against the live view.
// ============================================================================

import {
  armOf,
  DIRS,
  fullWallLine,
  uniformFloor,
  FLOOR_CORNERS,
  type WallTile,
  type Dir,
  type WallType,
  type FloorMaterial,
  type FloorCorner,
} from '../floor/wall-tile.ts';

const PACK = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${PACK}/${f}.gltf.glb`;

export const PIECE = {
  wall: u('wall'),
  half: u('wall_half'),
  halfCap: u('wall_half_endcap'),
  corner: u('wall_corner'), // a full MITERED corner (clean bend, reaches both edges)
  barrierCorner: u('barrier_corner'),
  arch: u('wall_arched'),
  window: u('wall_archedwindow_open'),
  gate: u('wall_gated'),
  broken: u('wall_broken'),
  pillar: u('pillar'),
  barrier: u('barrier'),
  barrierHalf: u('barrier_half'),
  barrierColumn: u('barrier_column'),
  floorStone: u('floor_tile_large'),
  floorDirt: u('floor_dirt_large'),
  floorWood: u('floor_wood_large'),
} as const;

const Q = Math.PI / 2;
const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
/** corner → (x,z) centre of that floor quarter. */
const CORNER_POS: Record<FloorCorner, readonly [number, number]> = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] };
/** How far an edge-cap is pushed toward the tile boundary (tile half-extent 2u). Tunable. */
const EDGE = 1.6;

/** Point a +X-extending half toward direction d (from the centre). */
const armYaw = (d: Dir): number => (d === 'E' ? 0 : d === 'N' ? Q : d === 'W' ? Math.PI : -Q);
/** Edge-cap yaw — the proven convention (a cap finishing a wall extending West sits at 0). */
const capYaw = (d: Dir): number => (d === 'W' ? 0 : d === 'S' ? Q : d === 'E' ? Math.PI : -Q);
/** Mitered-corner yaw — wall_corner native joins W+N at 0. */
function cornerYaw(ds: Dir[]): number {
  const s = new Set(ds);
  if (s.has('W') && s.has('N')) return 0;
  if (s.has('N') && s.has('E')) return Q;
  if (s.has('E') && s.has('S')) return Math.PI;
  return -Q; // S,W
}

const wallTypeUrl = (wt: WallType): string =>
  wt === 'door' || wt === 'arch'
    ? PIECE.arch
    : wt === 'window'
      ? PIECE.window
      : wt === 'low_gate'
        ? PIECE.gate
        : wt === 'hole'
          ? PIECE.broken
          : PIECE.wall;

/** One mesh to place: a url + a full transform. The only thing the renderer/collision consumes. */
export interface Placement {
  url: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const at = (url: string, yaw = 0, x = 0, z = 0, scale = 1): Placement => ({ url, x, y: 0, z, yaw, scale });

/** The centre column, if any. */
function centreColumn(tile: WallTile): Placement[] {
  if (tile.centre === 'wall') return [at(PIECE.pillar)];
  if (tile.centre === 'barrier') return [at(PIECE.barrierColumn)];
  return [];
}

/** The wall/barrier/column pieces realizing a tile's structure. */
function wallPlacements(tile: WallTile): Placement[] {
  const out: Placement[] = [];

  // a FULL corner (exactly two adjacent full-wall arms, nothing else) → one MITERED piece +
  // the additive centre column. (bend = clean corner; corner = clean corner + pillar.)
  const fulls = DIRS.filter((d) => { const a = armOf(tile, d); return a.reachesCentre && a.reachesEdge; });
  const extra = DIRS.filter((d) => !fulls.includes(d) && (tile.inner[d] !== 'none' || tile.edge[d] !== 'none'));
  if (tile.wallType === 'solid' && fulls.length === 2 && extra.length === 0) {
    const [a, b] = fulls as [Dir, Dir];
    const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
    if (!opposite) {
      const barrier = armOf(tile, a).type === 'barrier';
      return [at(barrier ? PIECE.barrierCorner : PIECE.corner, cornerYaw([a, b])), ...centreColumn(tile)];
    }
  }

  // a full straight wall LINE carrying an opening → one spanning piece (skip those arms)
  const skip = new Set<Dir>();
  if (tile.wallType !== 'solid') {
    if (fullWallLine(tile, 'EW')) {
      out.push(at(wallTypeUrl(tile.wallType), 0));
      skip.add('E').add('W');
    } else if (fullWallLine(tile, 'NS')) {
      out.push(at(wallTypeUrl(tile.wallType), Q));
      skip.add('N').add('S');
    }
  }

  for (const d of DIRS) {
    if (skip.has(d)) continue;
    const a = armOf(tile, d);
    if (!a.type) continue;
    const isB = a.type === 'barrier';
    const [dx, dz] = DV[d];
    if (a.reachesCentre && a.reachesEdge) {
      out.push(at(isB ? PIECE.barrierHalf : PIECE.half, armYaw(d))); // full arm, centre→edge
    } else if (a.reachesCentre) {
      out.push(at(isB ? PIECE.barrierHalf : PIECE.halfCap, armYaw(d))); // inner stub
    } else {
      out.push(at(isB ? PIECE.barrierHalf : PIECE.halfCap, capYaw(d), dx * EDGE, dz * EDGE)); // edge cap
    }
  }

  return [...out, ...centreColumn(tile)];
}

/* --------------------------------- floor ------------------------------------- */

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none'>, string> = {
  stone: PIECE.floorStone,
  dirt: PIECE.floorDirt,
  wood: PIECE.floorWood,
};

/** The floor tile(s): one full tile when uniform, else a quarter per non-`none` corner. */
function floorPlacements(tile: WallTile): Placement[] {
  const f = tile.floor;
  const uni = uniformFloor(f);
  if (uni) return [at(FLOOR_URL[uni])];
  const out: Placement[] = [];
  for (const c of FLOOR_CORNERS) {
    const m = f[c];
    if (m === 'none') continue;
    const [x, z] = CORNER_POS[c];
    out.push(at(FLOOR_URL[m], 0, x, z, 0.5));
  }
  return out;
}

/* --------------------------------- the API ----------------------------------- */

/** THE single placement function — every mesh this tile renders (floor first, then walls). */
export function tilePlacements(tile: WallTile): Placement[] {
  return [...floorPlacements(tile), ...wallPlacements(tile)];
}
