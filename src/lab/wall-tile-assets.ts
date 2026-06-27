// ============================================================================
// src/lab/wall-tile-assets.ts — the ARCHITECTURAL ELEMENT REGISTRY (9-cell model).
// ============================================================================
//
// Maps a WallTile (src/floor/wall-tile.ts) onto REAL KayKit Dungeon Remastered meshes by
// COMPOSING per-arm pieces — adjacent same-type cells visually collapse into longer walls.
// No custom boxes. Orientation reuses the game renderer's proven yaw conventions.
//
// PER ARM (a direction's inner + edge cell):
//   reaches centre AND edge → a half-wall (wall_half / barrier_half) centre→edge (open to join)
//   reaches centre only      → a capped half from centre (wall_half_endcap) — an inner stub
//   reaches edge only        → a capped half at the edge, facing out (the "edge cap")
// CENTRE column (additive): wall → pillar, barrier → barrier_column, none → nothing.
// FULL STRAIGHT LINE + wallType: one spanning opening piece (arch/window/gated/broken).
// FLOOR (per corner): stone→floor_tile_large · dirt→floor_dirt_large · wood→floor_wood_large.
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
/** How far an edge-cap is pushed toward the tile boundary (tile half-extent 2u). Tunable. */
const EDGE = 1.6;

/** Point a +X-extending half toward direction d (from the centre). */
const armYaw = (d: Dir): number => (d === 'E' ? 0 : d === 'N' ? Q : d === 'W' ? Math.PI : -Q);
/** Edge-cap yaw — the proven convention (a cap finishing a wall extending West sits at 0). */
const capYaw = (d: Dir): number => (d === 'W' ? 0 : d === 'S' ? Q : d === 'E' ? Math.PI : -Q);

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

export interface WallPlacement {
  url: string;
  yaw: number;
  x: number;
  z: number;
}

/** Compose the KayKit pieces that realize a tile's structure. */
export function wallPieces(tile: WallTile): WallPlacement[] {
  const out: WallPlacement[] = [];
  const skip = new Set<Dir>();

  // a full straight wall LINE carrying an opening → one spanning piece (skip those arms)
  if (tile.wallType !== 'solid') {
    if (fullWallLine(tile, 'EW')) {
      out.push({ url: wallTypeUrl(tile.wallType), yaw: 0, x: 0, z: 0 });
      skip.add('E').add('W');
    } else if (fullWallLine(tile, 'NS')) {
      out.push({ url: wallTypeUrl(tile.wallType), yaw: Q, x: 0, z: 0 });
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
      // full arm: a half-wall from the centre out to the edge (open, joins neighbour)
      out.push({ url: isB ? PIECE.barrierHalf : PIECE.half, yaw: armYaw(d), x: 0, z: 0 });
    } else if (a.reachesCentre) {
      // inner stub: a capped half from the centre, finishing before the edge
      out.push({ url: isB ? PIECE.barrierHalf : PIECE.halfCap, yaw: armYaw(d), x: 0, z: 0 });
    } else {
      // edge cap: a capped half sitting at the boundary, facing out
      out.push({ url: isB ? PIECE.barrierHalf : PIECE.halfCap, yaw: capYaw(d), x: dx * EDGE, z: dz * EDGE });
    }
  }

  // additive centre column
  if (tile.centre === 'wall') out.push({ url: PIECE.pillar, yaw: 0, x: 0, z: 0 });
  else if (tile.centre === 'barrier') out.push({ url: PIECE.barrierColumn, yaw: 0, x: 0, z: 0 });

  return out;
}

/* --------------------------------- floor ------------------------------------- */

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
