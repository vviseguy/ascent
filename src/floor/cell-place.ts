// ============================================================================
// src/floor/cell-place.ts — THE placement authority for a 2u cell.
// ============================================================================
//
// Given a RESOLVED grid, this is the one function that says which KayKit meshes realize it and where.
// It is the single source BOTH the view and the sim read: the editor and renderer adapt these to
// float meshes, and the collider composes each piece's frozen box-fit footprint from the SAME list —
// so `render == collision` holds by construction rather than by being re-proven.
//
// THE MESHES ALREADY FIT. `wall_half` is natively a 2u run and the floor pieces are 4u squares, so at
// 2u a wall segment is exactly one `wall_half` at scale 1 and a floor cell is one floor piece at half
// scale. In the 4u model these were *halves of* something; here they are the unit. Wall HEIGHT is
// unaffected — it never had anything to do with cell size.
//
// WHY THIS READS THE GRID AND NOT ONE CELL. A cell owns its north and west edges and its NW corner,
// but a 4u opening spans TWO collinear edges, and the second one belongs to a neighbour. So placing an
// archway means suppressing a piece another cell would otherwise emit. That needs the neighbourhood —
// it is still a pure, deterministic function of the resolved grid, just not of a lone cell.
//
// Sim-side and deterministic: transforms are CELL-LOCAL fixed-point (centre = 0, half-extent 1) and
// yaws are quarter-turns. No floats at runtime beyond the compile-time `fromFloatConst` constants.

import { type Fixed, fromInt, fromFloatConst, neg } from '../sim/fixed/fixed.ts';
import {
  isOpenType, type Axis, type Cell, type FloorMaterial, type Seg, type WallType,
} from './cell.ts';

const PACK = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${PACK}/${f}.gltf.glb`;

/** The KayKit piece registry — the only place mesh urls are named. */
export const PIECE = {
  half: u('wall_half'),
  halfCap: u('wall_half_endcap'),
  pillar: u('pillar'),
  barrierHalf: u('barrier_half'),
  barrierColumn: u('barrier_column'),
  arch: u('wall_arched'),
  window: u('wall_archedwindow_open'),
  gate: u('wall_gated'),
  broken: u('wall_broken'),
  wall: u('wall'),
  floorStone: u('floor_tile_large'),
  floorDirt: u('floor_dirt_large'),
  floorWood: u('floor_wood_large'),
} as const;

/** One mesh to place, CELL-LOCAL. `turn` = quarter-turns CCW; `x`/`z` are offsets from the cell
 *  centre in a 2u cell (so ±1 is an edge); `scale` 1 = the mesh's native size. */
export interface CellPlacement {
  url: string;
  x: Fixed;
  z: Fixed;
  turn: number;
  scale: Fixed;
}

const Z = fromInt(0);
const ONE = fromInt(1);
const NEG_ONE = neg(ONE);
const HALF = fromFloatConst(0.5); // a 4u floor piece rendered as a 2u cell

/** Point a +X-extending piece toward a direction. Matches the 4u convention exactly. */
const TURN = { E: 0, N: 1, W: 2, S: 3 } as const;

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none' | 'rock'>, string> = {
  stone: PIECE.floorStone, dirt: PIECE.floorDirt, wood: PIECE.floorWood,
};

/** Which 4u module an opening draws. `door` and `arch` share a mesh today. */
export const wallTypeUrl = (wt: WallType): string =>
  wt === 'door' || wt === 'arch' ? PIECE.arch
    : wt === 'window' ? PIECE.window
      : wt === 'low_gate' ? PIECE.gate
        : wt === 'hole' ? PIECE.broken
          : PIECE.wall;

const at = (url: string, turn = 0, x: Fixed = Z, z: Fixed = Z, scale: Fixed = ONE): CellPlacement =>
  ({ url, x, z, turn, scale });

/** The mesh for one wall segment. `sloped` HAS NO ASSET YET — it stands in as a solid wall, which is
 *  right for collision (it blocks) and wrong for looks. Replace the moment the ramp mesh exists. */
function wallPiece(seg: Seg): string | null {
  if (seg === 'none') return null;
  if (seg === 'barrier') return PIECE.barrierHalf;
  return PIECE.half; // wall, and sloped until its own mesh lands
}

/* ------------------------------- reading the grid ------------------------------- */

const cellAt = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): Cell | null =>
  x < 0 || y < 0 || x >= w || y >= h ? null : cells[y * w + x] ?? null;

/** Is there a live 4u opening at point (px,py) on `axis`? An `air` corner with a walk-through type,
 *  and the two collinear segments either side really being walls for it to sit in. */
export function openingAt(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number, axis: Axis,
): boolean {
  const c = cellAt(cells, w, h, px, py);
  if (!c || c.corner !== 'air' || !isOpenType(c.wallType)) return false;
  const spans = axis === 'H'
    ? [cellAt(cells, w, h, px - 1, py)?.wallN, c.wallN]
    : [cellAt(cells, w, h, px, py - 1)?.wallW, c.wallW];
  return spans.every((s) => s === 'wall');
}

/** The axis an opening at this point runs along, or null when it is not a live opening. Checked in a
 *  fixed order so a point that somehow satisfies both resolves deterministically. */
export function openingAxis(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number,
): Axis | null {
  if (openingAt(cells, w, h, px, py, 'H')) return 'H';
  if (openingAt(cells, w, h, px, py, 'V')) return 'V';
  return null;
}

/* --------------------------------- placement --------------------------------- */

/**
 * Every mesh cell (x,y) is responsible for: its floor, the two wall segments it owns, whatever stands
 * at its NW corner, and any 4u opening centred there.
 *
 * A `rock` cell emits NOTHING — it is solid fill, not a place, so there is no ground to stand on and
 * no walls to see. A `none` floor emits no ground either, but that is a PIT: the walls around it stay.
 */
export function cellPlacements(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
  floorExtent?: { w: number; h: number },
): CellPlacement[] {
  const c = cellAt(cells, w, h, x, y);
  if (!c || c.floor === 'rock') return [];
  const out: CellPlacement[] = [];

  /* FLOOR — the 2u square this cell covers.
     `floorExtent` matters for a STRUCTURE, whose stored grid is the POINT lattice: its last row and
     column exist only to carry the south and east border walls, and have no cell to their south-east
     to put ground under. Without this a 12x18 structure rendered 13x19 floor tiles — one spurious row
     and column, because those padding entries abstain and settle to stone like anything else.
     A generator floor passes nothing: every cell there is real. */
  const fw = floorExtent?.w ?? w, fh = floorExtent?.h ?? h;
  if (c.floor !== 'none' && x < fw && y < fh) out.push(at(FLOOR_URL[c.floor], 0, Z, Z, HALF));

  // the NW corner point of this cell, in cell-local coordinates
  const CX = NEG_ONE, CZ = NEG_ONE;

  // OPENING — a 4u module centred on the corner, spanning the two collinear segments either side.
  // It REPLACES both of them, including the one the neighbour owns (see the header).
  const axis = openingAxis(cells, w, h, x, y);
  if (axis) out.push(at(wallTypeUrl(c.wallType), axis === 'H' ? TURN.E : TURN.S, CX, CZ));

  // WALLS — this cell owns the edge running east (wallN) and the edge running south (wallW) from its
  // corner. Each is skipped when an opening already covers it: the one centred here, or the one
  // centred at the far end of the run.
  const coveredH = axis === 'H' || openingAt(cells, w, h, x + 1, y, 'H');
  const coveredV = axis === 'V' || openingAt(cells, w, h, x, y + 1, 'V');
  if (!coveredH) {
    const p = wallPiece(c.wallN);
    if (p) out.push(at(p, TURN.E, CX, CZ));
  }
  if (!coveredV) {
    const p = wallPiece(c.wallW);
    if (p) out.push(at(p, TURN.S, CX, CZ));
  }

  // CORNER — a pillar stands at the junction. `air` is a hole and draws nothing; `solid` is the
  // ordinary case where the wall runs simply meet.
  if (c.corner === 'column') {
    const lowOnly = c.wallN === 'barrier' && c.wallW === 'barrier';
    out.push(at(lowOnly ? PIECE.barrierColumn : PIECE.pillar, 0, CX, CZ));
  }

  return out;
}

/** Every placement on the grid, in a fixed row-major order, each tagged with the cell it belongs to
 *  so a consumer can offset it to world space. */
export function gridPlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
  floorExtent?: { w: number; h: number },
): { x: number; y: number; placements: CellPlacement[] }[] {
  const out: { x: number; y: number; placements: CellPlacement[] }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const placements = cellPlacements(cells, w, h, x, y, floorExtent);
      if (placements.length) out.push({ x, y, placements });
    }
  }
  return out;
}
