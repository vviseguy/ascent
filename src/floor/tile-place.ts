// ============================================================================
// src/floor/tile-place.ts — THE placement authority for the 9-cell tile.
// ============================================================================
//
// Given a RESOLVED WallTile, this is the ONE function that says which KayKit meshes realize it and
// where — floor first, then walls + centre column. It is the single source BOTH the view and the sim
// read (docs/16 §10, Path A):
//   • the renderer/editor adapt these to float meshes (a trivial toFloat — see src/lab/wall-tile-assets.ts);
//   • the tower offsets each by the cell centre and composes the piece's box-fit footprint for collision.
//
// So it lives on the SIM side (deterministic): transforms are TILE-LOCAL fixed-point (`Fixed` from
// src/sim/fixed; centre = 0) and yaws are quarter-turns (integers 0..3 = 0/90/180/270° CCW). No floats
// at runtime — only the `fromFloatConst` constants (compile-time), exactly the sanctioned pattern.
//
// Mesh-orientation facts (empirically verified, see git history): wall_half extends +X natively →
// armTurn; wall_half_endcap extends −X (the opposite) → endcapTurn (= armTurn + 2 quarter-turns);
// wall_corner natively joins W+S. Convention here: E=+X, W=−X, N=−Z, S=+Z.

import { type Fixed, fromInt, fromFloatConst, mul, neg } from '../sim/fixed/fixed.ts';
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
} from './wall-tile.ts';

const PACK = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${PACK}/${f}.gltf.glb`;

/** The KayKit piece registry — the only place mesh urls are named. */
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

/** One mesh to place, TILE-LOCAL. `turn` = quarter-turns CCW (0..3). `x`/`z` fixed offsets from the
 *  tile centre; `scale` fixed (1 = native 4u). y is always 0 (the floor plane). */
export interface TilePlacement {
  url: string;
  x: Fixed;
  z: Fixed;
  turn: number;
  scale: Fixed;
}

/* ------------------------------- fixed constants ----------------------------- */

const Z = fromInt(0);
const ONE = fromInt(1);
const EDGE = fromFloatConst(1.6); // how far an edge-cap is pushed toward the tile boundary (tunable)
const HALF = fromFloatConst(0.5); // a floor quarter renders at half scale

/** Offset of magnitude `mag` in integer direction `n` (−1/0/+1). */
const off = (mag: Fixed, n: number): Fixed => (n === 0 ? Z : n > 0 ? mag : neg(mag));

/* --------------------------------- yaw (turns) ------------------------------- */

/** Point a +X-extending half toward d (from the centre). */
const armTurn: Record<Dir, number> = { E: 0, N: 1, W: 2, S: 3 };
/** wall_half_endcap is −X-native (opposite wall_half) → +2 quarter-turns from armTurn. */
const endcapTurn: Record<Dir, number> = { W: 0, S: 1, E: 2, N: 3 };
/** Mitered-corner turn: wall_corner's native legs sit on W+S (turn 0). */
function cornerTurn(ds: Dir[]): number {
  const s = new Set(ds);
  if (s.has('S') && s.has('W')) return 0;
  if (s.has('E') && s.has('S')) return 1;
  if (s.has('N') && s.has('E')) return 2;
  return 3; // W, N
}

const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const CORNER_POS: Record<FloorCorner, readonly [number, number]> = { nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] };

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none'>, string> = { stone: PIECE.floorStone, dirt: PIECE.floorDirt, wood: PIECE.floorWood };
const wallTypeUrl = (wt: WallType): string =>
  wt === 'door' || wt === 'arch' ? PIECE.arch : wt === 'window' ? PIECE.window : wt === 'low_gate' ? PIECE.gate : wt === 'hole' ? PIECE.broken : PIECE.wall;

const at = (url: string, turn = 0, x: Fixed = Z, z: Fixed = Z, scale: Fixed = ONE): TilePlacement => ({ url, x, z, turn, scale });

/* --------------------------------- pieces ------------------------------------ */

function centreColumn(tile: WallTile): TilePlacement[] {
  if (tile.centre === 'wall') return [at(PIECE.pillar)];
  if (tile.centre === 'barrier') return [at(PIECE.barrierColumn)];
  return [];
}

/** The wall/barrier/column pieces realizing a tile's structure. */
function wallPlacements(tile: WallTile): TilePlacement[] {
  const out: TilePlacement[] = [];

  // a FULL corner (exactly two adjacent full-wall arms, nothing else) → one MITERED piece + centre column.
  const fulls = DIRS.filter((d) => { const a = armOf(tile, d); return a.reachesCentre && a.reachesEdge; });
  const extra = DIRS.filter((d) => !fulls.includes(d) && (tile.inner[d] !== 'none' || tile.edge[d] !== 'none'));
  if (tile.wallType === 'solid' && fulls.length === 2 && extra.length === 0) {
    const [a, b] = fulls as [Dir, Dir];
    const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
    if (!opposite) {
      const barrier = armOf(tile, a).type === 'barrier';
      return [at(barrier ? PIECE.barrierCorner : PIECE.corner, cornerTurn([a, b])), ...centreColumn(tile)];
    }
  }

  // a full straight wall LINE carrying an opening → one spanning piece (skip those arms)
  const skip = new Set<Dir>();
  if (tile.wallType !== 'solid') {
    if (fullWallLine(tile, 'EW')) {
      out.push(at(wallTypeUrl(tile.wallType), 0)); // EW run → turn 0
      skip.add('E').add('W');
    } else if (fullWallLine(tile, 'NS')) {
      out.push(at(wallTypeUrl(tile.wallType), 1)); // NS run → turn 1 (90°)
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
      out.push(at(isB ? PIECE.barrierHalf : PIECE.half, armTurn[d])); // full arm, centre→edge
    } else if (a.reachesCentre) {
      // inner stub (body centre→d): wall_half_endcap is −X-native → endcapTurn; barrier_half is +X → armTurn
      out.push(isB ? at(PIECE.barrierHalf, armTurn[d]) : at(PIECE.halfCap, endcapTurn[d]));
    } else {
      // edge cap pushed to the boundary; wall cap is −X-native → endcapTurn, barrier is +X → armTurn
      out.push(
        isB
          ? at(PIECE.barrierHalf, armTurn[d], off(EDGE, dx), off(EDGE, dz))
          : at(PIECE.halfCap, endcapTurn[d], off(EDGE, dx), off(EDGE, dz)),
      );
    }
  }

  return [...out, ...centreColumn(tile)];
}

/** The floor tile(s): one full tile when uniform, else a quarter per non-`none` corner. */
function floorPlacements(tile: WallTile): TilePlacement[] {
  const f = tile.floor;
  const uni = uniformFloor(f);
  if (uni) return [at(FLOOR_URL[uni])];
  const out: TilePlacement[] = [];
  for (const c of FLOOR_CORNERS) {
    const m = f[c];
    if (m === 'none') continue;
    const [x, z] = CORNER_POS[c];
    out.push(at(FLOOR_URL[m], 0, off(ONE, x), off(ONE, z), HALF));
  }
  return out;
}

/** THE single placement function — every mesh this tile renders/collides (floor first, then walls). */
export function tilePlacements(tile: WallTile): TilePlacement[] {
  return [...floorPlacements(tile), ...wallPlacements(tile)];
}
