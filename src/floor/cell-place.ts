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

import { type Fixed, add, fromInt, fromFloatConst, mul, neg } from '../sim/fixed/fixed.ts';
import {
  blocks, isOpenType, isStairFloor,
  type Axis, type Cell, type Dir, type FloorMaterial, type Seg, type WallType,
} from './cell.ts';

const PACK = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${PACK}/${f}.gltf.glb`;

/** The KayKit piece registry — the only place mesh urls are named. */
export const PIECE = {
  half: u('wall_half'),
  corner: u('wall_corner'),
  endcap: u('wall_endcap'),
  barrier: u('barrier'),
  barrierCorner: u('barrier_corner'),
  halfCap: u('wall_half_endcap'),
  pillar: u('pillar'),
  balcony: u('column'),          // 0.70 x 1.40 — a short post, rail height rather than full wall
  torchMounted: u('torch_mounted'),  // 0.55 x 1.06 x 0.62, projecting +Z from whatever it is on
  barrierHalf: u('barrier_half'),
  barrierColumn: u('barrier_column'),
  /* `arch` is NOT `wall_arched`. Measured (see the asset audit): that mesh's arch is cut 0.20 deep
     into BOTH faces and leaves a 0.10-thick sealing web — 0 of 4800 rays pass through it. It is a
     BLIND arch: it looks like a deep opening from either side and is solid. Using it for a type the
     graph calls walk-through is render disagreeing with sim, which is the one thing this pipeline is
     built not to do.
     `wall_open_scaffold` is the only 4u piece that is genuinely passable as loaded — a post-and-lintel
     frame with 3.40 clear. `wall_doorway` has a real 2.00 x 2.70 arched aperture too, but its door
     LEAF ships as a separate node (620 of 1068 triangles) and has to be hidden at load; until that
     exists, the open frame is the honest mesh for an opening you can walk through. */
  arch: u('wall_open_scaffold'),
  archBlind: u('wall_arched'),   // the decorative one — solid, for a wall that only looks arched
  /* The stair family, chosen by SENSING — see `STAIR_MESHES` for the measured footprints. */
  stairsNarrow: u('stairs_narrow'),
  stairsBanister: u('stairs'),
  stairsWalled: u('stairs_walled'),
  stairsWide: u('stairs_wide'),
  stairsWallLeft: u('stairs_wall_left'),
  stairsWallRight: u('stairs_wall_right'),
  stairsWood: u('stairs_wood'),
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
  /** Height above the cell's floor plane, in WORLD units — not half-cells like x/z. A slab is a slab;
   *  its thickness does not change when the cell size does. Zero for everything that sits on the deck. */
  y: Fixed;
  turn: number;
  scale: Fixed;
}

const Z = fromInt(0);
const ONE = fromInt(1);
const NEG_ONE = neg(ONE);
const HALF = fromFloatConst(0.5); // a 4u floor piece rendered as a 2u cell

/** Point a +X-extending piece toward a direction. Matches the 4u convention exactly. */
const TURN = { E: 0, N: 1, W: 2, S: 3 } as const;

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none' | 'rock' | 'stairs' | 'stairs_wood'>, string> = {
  stone: PIECE.floorStone, dirt: PIECE.floorDirt, wood: PIECE.floorWood,
};

/** Which 4u module an opening draws. `door` and `arch` share a mesh today. */
export const wallTypeUrl = (wt: WallType): string =>
  wt === 'door' || wt === 'arch' ? PIECE.arch
    : wt === 'window' ? PIECE.window
      : wt === 'low_gate' ? PIECE.gate
        : wt === 'hole' ? PIECE.broken
          : PIECE.wall;

const at = (url: string, turn = 0, x: Fixed = Z, z: Fixed = Z, scale: Fixed = ONE, y: Fixed = Z): CellPlacement =>
  ({ url, x, y, z, turn, scale });

/**
 * THE KIT IS BUILT AROUND A 4.00 STOREY, and these are measured, not guessed (`tmp/glb-levels.mjs`
 * reports the area of upward-facing faces at each height, which is the only way to find a stair's last
 * TREAD — its bounding box top is the banister):
 *
 *   wall              4.00 tall
 *   every staircase   climbs exactly 4.00, in 8 treads of 0.50   (bbox says 5.10; that is the newel post)
 *   floor_tile_large  0.15 thick, walking surface at +0.05
 *
 * So a flight lifted by the floor's surface height starts flush with the deck it leaves AND ends flush
 * with the deck it reaches, because 0.05 + 4.00 = the next storey's surface. That is not a coincidence
 * to be tuned — it is the kit's own grid, and `FLOOR_HEIGHT` should equal it.
 */
const FLOOR_SURFACE = fromFloatConst(0.05);
/** How far a flight actually climbs. `FLOOR_HEIGHT` must equal this or the stairs stop reaching. */
export const STAIR_CLIMB: Fixed = fromInt(4);
/** Pushed DOWNHILL by this much so the flight clears the trim that protrudes from the wall at its head.
 *  Small on purpose: any more and the gap at the top reads as a missing tread. */
const STAIR_OUT = fromFloatConst(0.12);

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

/** The wall on side `d` of (x,y), read from whichever cell owns it; off the map is the perimeter. */
function wallOn(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: Dir): Seg {
  const o = d === 'N' ? { x, y, side: 'N' as const }
    : d === 'W' ? { x, y, side: 'W' as const }
      : d === 'S' ? { x, y: y + 1, side: 'N' as const }
        : { x: x + 1, y, side: 'W' as const };
  const c = cellAt(cells, w, h, o.x, o.y);
  return c ? c[o.side === 'N' ? 'wallN' : 'wallW'] : 'wall';
}

/** Is there a live 4u opening at point (px,py) on `axis`? An `air` corner with a walk-through type,
 *  and the two collinear segments either side really being walls for it to sit in. */
export function openingAt(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number, axis: Axis,
): boolean {
  const c = cellAt(cells, w, h, px, py);
  // the wall TYPE decides passability now; the corner only says what is standing there
  if (!c || !isOpenType(c.wallType)) return false;
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

/* ----------------------------------- stairs ----------------------------------- */

/**
 * A stair FLIGHT is a rectangular block of `stairs` cells. The base flight is 2x2 — 4u x 4u, exactly
 * `stairs_narrow`'s footprint — and everything about which mesh to use is SENSED, never stored:
 *
 *     [ open ] stairs stairs [ wall ]      the climb runs toward the closed end
 *       walls either side?                 -> a walled flight
 *       three cells across?                -> a wide flight
 *       wooden ground around it?           -> a wooden flight
 *
 * Nothing here is a second copy of something the walls already say, which is the same rule the
 * opening axis follows. An AMBIGUOUS flight — no end closed, or both axes equally closed — draws
 * ordinary ground rather than guessing, as everywhere else in this file.
 *
 * The overhang is not an accident: `stairs_walled` is 5.00 wide against a 4u block because it carries
 * its own side walls, and a wall is 1.00 thick centred on the cell boundary — so 4 + 0.5 + 0.5 lands
 * exactly. That is why a walled flight also SUPPRESSES the flanking wall segments; drawing both would
 * double them.
 */
export interface StairFlight {
  /** Block origin (its lowest-coordinate cell) and size in CELLS. */
  x: number;
  y: number;
  bw: number;
  bh: number;
  /** Which way it climbs — toward the closed end. */
  up: Dir;
  /** Cells across, perpendicular to the climb. */
  width: number;
  /** Cells the flight runs FOR, along the climb. */
  run: number;
  /** Which flanks are walled: -1 left only, 1 right only, 2 both, 0 neither. */
  walls: -1 | 0 | 1 | 2;
  /** The mesh this resolves to. */
  url: string;
}

/**
 * The measured stair catalog. Two facts here are NOT derivable from a bounding box, so they were read
 * out of the vertex data (`tmp/glb-slope.mjs`) rather than assumed:
 *
 *   1. EVERY stair mesh rises toward -Z, so the whole family shares one turn table.
 *   2. THE PIVOT IS NOT THE CENTRE. Their Z spans [0, run] rather than [-run/2, +run/2] — the origin
 *      sits at the TOP of the flight and the body hangs downhill from it. Centring one on its block
 *      puts it half a block out, which is exactly the bug this table exists to prevent.
 *
 * `run` and `across` are in CELLS, so a mesh is only offered for a block it actually spans. `across` 2
 * is 4u, and a 5.00-wide mesh there means 4u of stair plus 0.5 of wall each side — which lands on the
 * cell boundary exactly, because a wall is 1.00 thick and centred on it.
 *
 * Widths are measured at the TREAD, not the bounding box, because the two differ: `stairs` is 5.00
 * across but only 3.50 of it is walkable — the rest is banister, and it lands exactly in the boundary
 * zone where a wall would be. That is why the banistered flight is right when the flanks are OPEN and
 * the walled one when they are not: both are 5.00 over a 4u block, and in both cases the extra half
 * unit either side is doing a job.
 *
 * NOT EVERY MESH IN THE KIT IS REACHABLE, and the two reasons are worth stating rather than leaving
 * as a puzzle:
 *   `stairs_narrow` — the exact-4.00 variant, 2.50 of tread. Nothing selects it because a block with
 *     open flanks has room for the roomier banistered flight, and one without gets the walled mesh.
 *     Kept in PIECE for a tight placement the model cannot currently express.
 *   `stairs_wood_decorated` — a dressing of `stairs_wood`, and cosmetic variants are a view-layer
 *     choice (view-seeded by cell hash), not something the sim should pick.
 */
const STAIR_MESHES = [
  //  url                      mat      run  across  walls          measured w x d (world units)
  { url: PIECE.stairsWood, mat: 'stairs_wood', run: 3, across: 2, walls: 0 },   // 3.30 x 6.00
  { url: PIECE.stairsWide, mat: 'stairs', run: 2, across: 3, walls: 0 },        // 7.00 x 4.00 = 6u + 0.5
  { url: PIECE.stairsWalled, mat: 'stairs', run: 2, across: 2, walls: 2 },      // 5.00 x 4.00 = 4u + 0.5
  { url: PIECE.stairsWallLeft, mat: 'stairs', run: 2, across: 2, walls: -1 },   // 4.00 x 5.00, wall at -X
  { url: PIECE.stairsWallRight, mat: 'stairs', run: 2, across: 2, walls: 1 },   // 4.00 x 5.00, wall at +X
  { url: PIECE.stairsBanister, mat: 'stairs', run: 2, across: 2, walls: 0 },    // 5.00 wide, 3.50 tread
] as const satisfies readonly { url: string; mat: FloorMaterial; run: number; across: number; walls: number }[];


/** Stairs rise toward -Z natively, so N is the unturned case. NOT the table walls use — a wall runs
 *  along X, so its unturned case is E. */
const STAIR_TURN = { N: 0, W: 1, S: 2, E: 3 } as const;
/** Unit step per direction, for pushing the pivot back up-slope. */
const STEP: Record<Dir, readonly [number, number]> = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
/**
 * Standing at the foot looking up, which grid direction is on your LEFT.
 *
 * MEASURED, not reasoned about (`tmp/glb-hand.mjs`): everything above a flight's top tread is rail or
 * wall, so counting those vertices either side of centre says which side carries the wall.
 * `stairs_wall_left` has 13 at -X and none at +X; `_right` is the mirror; `stairs` has 13 on BOTH,
 * which is what makes it the banistered one. Facing north (-Z) with +Y up, right is +X — so -X is the
 * climber's left and the mesh names mean what they say.
 *
 * Worth the measurement: read off a render, this looks backwards, because a flight's own
 * diagonal-topped side reads as a wall from most angles.
 */
const LEFT_OF: Record<Dir, Dir> = { N: 'W', W: 'S', S: 'E', E: 'N' };
const RIGHT_OF: Record<Dir, Dir> = { W: 'N', S: 'W', E: 'S', N: 'E' };

/** The stair material at (x,y), or null if it is not a stair cell. A flight is ONE material all the
 *  way through — two materials touching are two flights, because they are different depths. */
const stairMat = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): FloorMaterial | null => {
  const f = cellAt(cells, w, h, x, y)?.floor;
  return f !== undefined && isStairFloor(f) ? f : null;
};
const isStairs = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, mat: FloorMaterial): boolean =>
  stairMat(cells, w, h, x, y) === mat;

/** Is EVERY cell along one side of the block walled on that side? A flight's end is only "closed" if
 *  the whole width is, otherwise you could walk around it. */
function sideClosed(
  cells: readonly (Cell | null)[], w: number, h: number,
  x: number, y: number, bw: number, bh: number, d: Dir,
): boolean {
  if (d === 'N' || d === 'S') {
    const row = d === 'N' ? y : y + bh - 1;
    for (let i = 0; i < bw; i++) if (!blocks(wallOn(cells, w, h, x + i, row, d))) return false;
    return true;
  }
  const col = d === 'W' ? x : x + bw - 1;
  for (let i = 0; i < bh; i++) if (!blocks(wallOn(cells, w, h, col, y + i, d))) return false;
  return true;
}

/** The flight whose ORIGIN is (x,y), or null. The origin is the block's lowest-coordinate cell, so
 *  exactly one cell of a flight ever reports it and the mesh is emitted once. */
/**
 * Does the wall closing side `d` CONTINUE past the block, or stop at it?
 *
 * This is what breaks the tie when a staircase stands in a corner. A wall the stair merely stands
 * against — a room wall — runs on beyond the block; the stair's OWN head wall stops where the stair
 * does. So when both axes look equally closed, the one whose wall stops is the head, and the one whose
 * wall carries on is a flank. It reads the same way a person does: you climb toward the little wall at
 * the top, not along the long wall you happen to be beside.
 */
function endContinues(
  cells: readonly (Cell | null)[], w: number, h: number,
  x: number, y: number, bw: number, bh: number, d: Dir,
): boolean {
  // one cell past each end of the run that wall occupies, on the same side
  const [ax, ay, bx, by] = d === 'N' ? [x - 1, y, x + bw, y]
    : d === 'S' ? [x - 1, y + bh - 1, x + bw, y + bh - 1]
      : d === 'W' ? [x, y - 1, x, y + bh]
        : [x + bw - 1, y - 1, x + bw - 1, y + bh];
  return blocks(wallOn(cells, w, h, ax, ay, d)) || blocks(wallOn(cells, w, h, bx, by, d));
}

/** Everything both the placer and the diagnostic need, worked out ONCE so they cannot disagree. */
interface Geometry {
  mat: FloorMaterial;
  bw: number; bh: number;
  up: Dir; width: number; run: number;
  walls: -1 | 0 | 1 | 2;
}

function flightGeometry(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): { ok: Geometry } | { fault: StairFault } | null {
  const mat = stairMat(cells, w, h, x, y);
  if (mat === null) return null;
  if (isStairs(cells, w, h, x - 1, y, mat) || isStairs(cells, w, h, x, y - 1, mat)) return null; // not the origin

  let bw = 1; while (isStairs(cells, w, h, x + bw, y, mat)) bw++;
  let bh = 1; while (isStairs(cells, w, h, x, y + bh, mat)) bh++;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) if (!isStairs(cells, w, h, x + i, y + j, mat)) return { fault: { kind: 'ragged', mat } };
  }

  const closed = {
    N: sideClosed(cells, w, h, x, y, bw, bh, 'N'),
    S: sideClosed(cells, w, h, x, y, bw, bh, 'S'),
    W: sideClosed(cells, w, h, x, y, bw, bh, 'W'),
    E: sideClosed(cells, w, h, x, y, bw, bh, 'E'),
  };
  const vAxis = closed.N !== closed.S;
  const hAxis = closed.W !== closed.E;
  if (!vAxis && !hAxis) return { fault: { kind: 'undecidable', mat, bw, bh } }; // nothing to go on

  let vertical: boolean;
  if (vAxis !== hAxis) {
    vertical = vAxis;
  } else {
    /* BOTH axes look like a climb, which is what a staircase in a corner looks like. Prefer the one
       whose head wall STOPS at the block — that is the stair's own head rather than a wall it stands
       beside. Corner of a room, where both walls run on: nothing distinguishes them, so take the
       vertical reading and let the editor report it, which closes the loop for the author. */
    const vOwn = !endContinues(cells, w, h, x, y, bw, bh, closed.N ? 'N' : 'S');
    const hOwn = !endContinues(cells, w, h, x, y, bw, bh, closed.W ? 'W' : 'E');
    vertical = vOwn === hOwn ? true : vOwn;
  }

  const up: Dir = vertical ? (closed.N ? 'N' : 'S') : (closed.W ? 'W' : 'E');
  const width = vertical ? bw : bh;
  const run = vertical ? bh : bw;
  const left = LEFT_OF[up], right = RIGHT_OF[up];
  const walls: -1 | 0 | 1 | 2 =
    closed[left] && closed[right] ? 2 : closed[left] ? -1 : closed[right] ? 1 : 0;

  if (!STAIR_MESHES.some((m) => m.mat === mat && m.run === run)) {
    return { fault: { kind: 'no-mesh', mat, run, width } };
  }
  return { ok: { mat, bw, bh, up, width, run, walls } };
}

export function stairFlight(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): StairFlight | null {
  const g = flightGeometry(cells, w, h, x, y);
  if (!g || !('ok' in g)) return null;
  const { mat, bw, bh, up, width, run, walls } = g.ok;

  /* The first mesh that FITS. MATERIAL and RUN LENGTH are hard requirements — a stone flight is not a
     wooden one, and a 4u mesh in a 6u hole leaves a step missing — while width and walls are
     preferences, so an unusual block degrades to a plainer mesh instead of vanishing. */
  const fits = STAIR_MESHES.filter((m) => m.mat === mat && m.run === run);
  const best = fits.find((m) => m.across === width && m.walls === walls)
    ?? fits.find((m) => m.across === width)
    ?? fits[0];
  if (!best) return null;

  return { x, y, bw, bh, up, width, run, walls: best.walls, url: best.url };
}

/**
 * Why a block of stair cells did NOT become a flight. `stairFlight` answers yes-or-no because that is
 * all placement needs; an author needs the reason, because the failure is silent — the cells just draw
 * as ordinary ground and nothing says the staircase you painted is not a staircase.
 *
 * Returns null when the block IS a flight, or when (x,y) does not own one.
 */
export type StairFault =
  | { kind: 'ragged'; mat: FloorMaterial }
  | { kind: 'undecidable'; mat: FloorMaterial; bw: number; bh: number }
  | { kind: 'no-mesh'; mat: FloorMaterial; run: number; width: number };

export function stairFault(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): StairFault | null {
  const g = flightGeometry(cells, w, h, x, y);
  return g && 'fault' in g ? g.fault : null;
}

/** Human-readable, for the editor's readout. */
export function stairFaultText(f: StairFault): string {
  if (f.kind === 'ragged') return 'not a rectangle — a flight has to be a solid block of stair cells';
  if (f.kind === 'undecidable') {
    return 'cannot tell which way it climbs — one END must be walled and the opposite one open, '
      + 'so there is a top to climb toward and a bottom to walk in at';
  }
  const want = [...new Set(STAIR_MESHES.filter((m) => m.mat === f.mat).map((m) => m.run))].sort();
  return `no ${f.mat} flight is ${f.run} cells long — it must be ${want.join(' or ')}`;
}

/** Is this cell inside a flight owned by another cell? Such a cell contributes no ground of its own. */
function insideFlight(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): StairFlight | null {
  const mat = stairMat(cells, w, h, x, y);
  if (mat === null) return null;
  for (let oy = y; oy >= 0 && isStairs(cells, w, h, x, oy, mat); oy--) {
    for (let ox = x; ox >= 0 && isStairs(cells, w, h, ox, oy, mat); ox--) {
      const f = stairFlight(cells, w, h, ox, oy);
      if (f && x >= f.x && x < f.x + f.bw && y >= f.y && y < f.y + f.bh) return f;
    }
  }
  return null;
}

/** Does a WALLED flight already draw the wall on side `d` of (x,y)? Its mesh carries its own sides, so
 *  emitting the cell wall too would double them. */
function flightCoversWall(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: 'N' | 'W'): boolean {
  for (const [cx, cy] of [[x, y], [x - 1, y], [x, y - 1]] as [number, number][]) {
    const f = insideFlight(cells, w, h, cx, cy);
    if (f === null || f.walls === 0) continue;
    // ONLY the side the chosen mesh actually carries — a one-sided variant must not silently delete
    // the wall on the side it does not draw
    const sides: Dir[] = f.walls === 2 ? [LEFT_OF[f.up], RIGHT_OF[f.up]]
      : f.walls === -1 ? [LEFT_OF[f.up]] : [RIGHT_OF[f.up]];
    for (const side of sides) {
      if (side === 'W' && d === 'W' && x === f.x && y >= f.y && y < f.y + f.bh) return true;
      if (side === 'E' && d === 'W' && x === f.x + f.bw && y >= f.y && y < f.y + f.bh) return true;
      if (side === 'N' && d === 'N' && y === f.y && x >= f.x && x < f.x + f.bw) return true;
      if (side === 'S' && d === 'N' && y === f.y + f.bh && x >= f.x && x < f.x + f.bw) return true;
    }
  }
  return false;
}

/* ----------------------------------- torches ----------------------------------- */

/** `torch_mounted` projects +Z from the surface it is on, so +Z is the way it faces. */
const TORCH_TURN: Record<Dir, number> = { S: 0, E: 1, N: 2, W: 3 };
/** Head height on a 4.00 wall. */
const TORCH_Y = fromFloatConst(2.1);
/** Fixed order, so which way a torch faces is a property of the map and not of the loop. */
const TORCH_ORDER: readonly Dir[] = ['S', 'E', 'N', 'W'];

/**
 * WHICH WAY A TORCH FACES, sensed rather than stored — the same rule the opening axis and the stair
 * direction follow, and for the same reason: a fact the walls already carry should not be written down
 * a second time where it can disagree with them.
 *
 * A torch needs something to hang on and somewhere to shine. It mounts on whatever is standing at the
 * point — a pillar, or one of the walls meeting there — and faces a cardinal direction that is NOT a
 * wall and NOT solid rock, so it lights a space someone can actually stand in. With nothing to mount
 * on, or nowhere to face, there is no torch: `null`.
 */
export function torchFacing(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): Dir | null {
  const c = cellAt(cells, w, h, x, y);
  if (!c) return null;

  /** The wall running `d` from this point, if any. */
  const arm = (d: Dir): Seg => {
    if (d === 'E') return cellAt(cells, w, h, x, y)?.wallN ?? 'none';
    if (d === 'W') return cellAt(cells, w, h, x - 1, y)?.wallN ?? 'none';
    if (d === 'S') return cellAt(cells, w, h, x, y)?.wallW ?? 'none';
    return cellAt(cells, w, h, x, y - 1)?.wallW ?? 'none';
  };
  const standing = c.corner !== 'none' || TORCH_ORDER.some((d) => blocks(arm(d)));
  if (!standing) return null; // nothing here to hang it on

  /** Ground you can stand on — `none` is a hole and `rock` is solid fill. */
  const open = (cx: number, cy: number): boolean => {
    const n = cellAt(cells, w, h, cx, cy);
    return !!n && n.floor !== 'none' && n.floor !== 'rock';
  };
  for (const d of TORCH_ORDER) {
    if (blocks(arm(d))) continue;                      // it would be inside the wall
    // the two cells either side of that direction; one of them being real ground is enough
    const pair: [number, number][] = d === 'E' ? [[x, y - 1], [x, y]]
      : d === 'W' ? [[x - 1, y - 1], [x - 1, y]]
        : d === 'S' ? [[x - 1, y], [x, y]]
          : [[x - 1, y - 1], [x, y - 1]];
    if (pair.some(([cx, cy]) => open(cx, cy))) return d;
  }
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
  const inFloor = x < fw && y < fh;

  /* STAIRS replace the ground of a whole BLOCK with one flight, drawn by the block's origin and
     centred on it. A cell inside someone else's flight draws nothing; a `stairs` cell that is not part
     of any flight (ragged, or with no end closed) falls back to ordinary ground. */
  const flight = stairFlight(cells, w, h, x, y);
  if (flight && inFloor) {
    /* The block centre, relative to the origin cell centre, in cell-local (= world) units — then pushed
       UP-SLOPE by half the run, because the mesh pivots on its top end rather than its middle. */
    const [sx, sz] = STEP[flight.up];
    // LIFTED to the deck's walking surface and pushed a little DOWNHILL — see FLOOR_SURFACE/STAIR_OUT.
    const cx = add(fromInt(flight.bw - 1 + sx * flight.run), mul(fromInt(-sx), STAIR_OUT));
    const cz = add(fromInt(flight.bh - 1 + sz * flight.run), mul(fromInt(-sz), STAIR_OUT));
    out.push(at(flight.url, STAIR_TURN[flight.up], cx, cz, ONE, FLOOR_SURFACE));
  } else if (isStairFloor(c.floor)) {
    if (!insideFlight(cells, w, h, x, y) && inFloor) out.push(at(PIECE.floorStone, 0, Z, Z, HALF));
  } else if (c.floor !== 'none' && inFloor) {
    out.push(at(FLOOR_URL[c.floor], 0, Z, Z, HALF));
  }

  // the NW corner point of this cell, in cell-local coordinates
  const CX = NEG_ONE, CZ = NEG_ONE;

  // OPENING — a 4u module centred on the corner, spanning the two collinear segments either side.
  // It REPLACES both of them, including the one the neighbour owns (see the header).
  const axis = openingAxis(cells, w, h, x, y);
  if (axis) out.push(at(wallTypeUrl(c.wallType), axis === 'H' ? TURN.E : TURN.S, CX, CZ));

  // WALLS — this cell owns the edge running east (wallN) and the edge running south (wallW) from its
  // corner. Each is skipped when an opening already covers it: the one centred here, or the one
  // centred at the far end of the run.
  /* An edge only EXISTS if it lies inside the structure. `wallN` runs east from this point, so it
     needs a point one to the east (px < fw); `wallW` runs south, so it needs one below (py < fh).
     The last column's `wallN` and the last row's `wallW` point out of the structure entirely and are
     not part of it — drawing them added a phantom layer of wall around every piece. Note the two
     conditions are INDEPENDENT: the south border is `wallN` at py === fh, which is real. */
  /* WALLS ARE NOT HERE. A wall segment is 2u, but the meshes that make walls look like walls are
     bigger than that — a 4u straight, a mitered corner — and neither fits inside one cell. So they are
     laid over the WHOLE GRID by `wallEdgePlacements`, which `gridPlacements` composes with this. See
     the note there. */

  /* CORNER — what STANDS at the junction, and nothing more. `none` is the ordinary case where wall
     runs simply meet and there is nothing to draw. A `column` is the full-height pillar; a `balcony`
     is the short post you can see over. */
  if (c.corner === 'column') {
    const lowOnly = c.wallN === 'barrier' && c.wallW === 'barrier';
    out.push(at(lowOnly ? PIECE.barrierColumn : PIECE.pillar, 0, CX, CZ));
  } else if (c.corner === 'balcony') {
    out.push(at(PIECE.balcony, 0, CX, CZ));
  }

  // TORCH — hung on whatever stands here, facing somewhere worth lighting. See `torchFacing`.
  if (c.torch === 'yes') {
    const d = torchFacing(cells, w, h, x, y);
    if (d) out.push(at(PIECE.torchMounted, TORCH_TURN[d], CX, CZ, ONE, TORCH_Y));
  }

  return out;
}

/** Every placement on the grid, in a fixed row-major order, each tagged with the cell it belongs to
 *  so a consumer can offset it to world space. */
/* ---------------------------------- wall runs ---------------------------------- */

/**
 * WALLS ARE LAID OVER THE WHOLE GRID, not cell by cell.
 *
 * A wall segment is one 2u edge, and emitting a `wall_half` for each is correct but says nothing about
 * what the wall IS. A corridor wall six cells long came out as six separate slabs butted end to end,
 * and a corner came out as two of them overlapping at right angles — which is both more meshes than
 * necessary and not what a wall looks like.
 *
 * The kit already has the right pieces, and they are already the right size: they were authored for
 * the 4u tile, where each arm reaches 2.0 from the tile centre, which is EXACTLY one 2u edge. So
 * `wall` spans two edges end to end, and `wall_corner` joins two perpendicular ones. Both families —
 * wall and barrier — carry the same three shapes, so the rule is one rule.
 *
 * Two passes, greedy, in a fixed order so the result is deterministic:
 *   1. CORNERS. A lattice point with exactly two incident edges, perpendicular, same family, becomes
 *      one mitered piece and both edges are spent.
 *   2. RUNS. Whatever is left is walked in maximal straight lines and tiled with 4u pieces, with a 2u
 *      one for an odd last edge.
 *
 * Junctions of three or four arms are deliberately left to butt: `wall_Tsplit` and `wall_crossing`
 * exist and would fit, but they consume arms that the runs through them also want, and getting that
 * wrong leaves a gap in a wall rather than an ugly join. Straights and corners are where nearly all
 * the pieces are.
 */
type WallFamily = 'wall' | 'barrier';
const FAMILY: Record<WallFamily, { full: string; half: string; corner: string; cap: string | null }> = {
  // `cap` is the SHORT stub the kit ends a wall with — a run that just stops mid-air looks sheared off
  // otherwise. The barrier family has no cap of its own, so a barrier run simply ends.
  wall: { full: PIECE.wall, half: PIECE.half, corner: PIECE.corner, cap: PIECE.endcap },
  barrier: { full: PIECE.barrier, half: PIECE.barrierHalf, corner: PIECE.barrierCorner, cap: null },
};
/** `sloped` has no mesh of its own and stands in as wall, exactly as `wallPiece` has it. */
const familyOf = (seg: Seg): WallFamily | null =>
  seg === 'barrier' ? 'barrier' : seg === 'wall' || seg === 'sloped' ? 'wall' : null;

/** `wall_corner`'s legs sit on W+S at turn 0; each further quarter-turn rotates the pair. */
const CORNER_TURN: Record<string, number> = { WS: 0, SE: 1, EN: 2, NW: 3 };

/**
 * Every wall edge the grid actually draws, laid out as whole pieces. Returned keyed by the cell each
 * piece is attributed to, so `gridPlacements` can fold it in — a piece may reach beyond that cell,
 * which is the whole point.
 */
export function wallEdgePlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
  floorExtent?: { w: number; h: number },
): Map<number, CellPlacement[]> {
  const fw = floorExtent?.w ?? w, fh = floorExtent?.h ?? h;
  const out = new Map<number, CellPlacement[]>();
  const push = (cx: number, cy: number, p: CellPlacement): void => {
    const k = cy * w + cx;
    const list = out.get(k);
    if (list) list.push(p); else out.set(k, [p]);
  };

  /** The family of the edge running `dir` from lattice point (px,py), or null if nothing is drawn. */
  const edge = (px: number, py: number, dir: 'E' | 'S'): WallFamily | null => {
    const c = cellAt(cells, w, h, px, py);
    if (!c) return null;
    if (dir === 'E') {
      if (px >= fw) return null;                                     // no such edge on this lattice
      if (openingAxis(cells, w, h, px, py) === 'H') return null;      // an opening spans it
      if (openingAt(cells, w, h, px + 1, py, 'H')) return null;
      if (flightCoversWall(cells, w, h, px, py, 'N')) return null;    // a walled flight draws it
      return familyOf(c.wallN);
    }
    if (py >= fh) return null;
    if (openingAxis(cells, w, h, px, py) === 'V') return null;
    if (openingAt(cells, w, h, px, py + 1, 'V')) return null;
    if (flightCoversWall(cells, w, h, px, py, 'W')) return null;
    return familyOf(c.wallW);
  };

  // spent[k] marks an edge already covered by a piece; E and S are tracked separately
  const spentE = new Uint8Array(w * h), spentS = new Uint8Array(w * h);
  const isSpent = (px: number, py: number, dir: 'E' | 'S'): boolean =>
    (dir === 'E' ? spentE : spentS)[py * w + px] === 1;
  const spend = (px: number, py: number, dir: 'E' | 'S'): void => {
    (dir === 'E' ? spentE : spentS)[py * w + px] = 1;
  };

  /* ---- 1. CORNERS ---- */
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // the four arms meeting at this point, each one whole edge long
      const arms: { d: string; px: number; py: number; dir: 'E' | 'S'; fam: WallFamily }[] = [];
      const add = (d: string, ax: number, ay: number, dir: 'E' | 'S'): void => {
        if (ax < 0 || ay < 0) return;
        const f = edge(ax, ay, dir);
        if (f && !isSpent(ax, ay, dir)) arms.push({ d, px: ax, py: ay, dir, fam: f });
      };
      add('E', px, py, 'E');
      add('W', px - 1, py, 'E');
      add('S', px, py, 'S');
      add('N', px, py - 1, 'S');
      if (arms.length !== 2) continue;
      const [a, b] = arms as [typeof arms[0], typeof arms[0]];
      if (a.fam !== b.fam) continue;
      const key = (a.d + b.d) in CORNER_TURN ? a.d + b.d : b.d + a.d;
      const turn = CORNER_TURN[key];
      if (turn === undefined) continue;         // opposite arms: a straight, not a corner
      push(px, py, at(FAMILY[a.fam].corner, turn, NEG_ONE, NEG_ONE));
      spend(a.px, a.py, a.dir);
      spend(b.px, b.py, b.dir);
    }
  }

  /* ---- 2. RUNS ---- */
  /** How many wall segments meet at a lattice point — a run that ends where nothing else does is
   *  loose, and gets a cap rather than a sheared-off face. */
  const armsAt = (px: number, py: number): number => {
    let n = 0;
    if (edge(px, py, 'E')) n++;
    if (px > 0 && edge(px - 1, py, 'E')) n++;
    if (edge(px, py, 'S')) n++;
    if (py > 0 && edge(px, py - 1, 'S')) n++;
    return n;
  };

  const layRun = (sx: number, sy: number, dir: 'E' | 'S', fam: WallFamily, len: number): void => {
    const stepX = dir === 'E' ? 1 : 0, stepY = dir === 'E' ? 0 : 1;
    const turn = dir === 'E' ? TURN.E : TURN.S;
    const ox = NEG_ONE, oz = NEG_ONE;
    let i = 0;
    while (i < len) {
      const px = sx + stepX * i, py = sy + stepY * i;
      // offsets are cell-local half-cell units, and one edge is TWO of them
      if (len - i >= 2) {
        // a 4u piece is CENTRED, so it sits one edge along from the point it starts at
        const mid = fromInt(2);
        push(px, py, at(FAMILY[fam].full, turn,
          dir === 'E' ? add(ox, mid) : ox, dir === 'E' ? oz : add(oz, mid)));
        i += 2;
      } else {
        push(px, py, at(FAMILY[fam].half, turn, ox, oz));
        i += 1;
      }
    }

    /* CAPS on a loose end. `wall_endcap` is a short +X-native stub, so the low end takes it facing
       back along the run and the high end takes it facing forward — a nub on the outside of the last
       piece, not a replacement for it.
       A run that ends AT A COLUMN needs none: the column is already the end of the wall, and a cap
       tucked inside it is a nub buried in a pillar. */
    const cap = FAMILY[fam].cap;
    if (!cap) return;
    const endsInColumn = (px: number, py: number): boolean =>
      cellAt(cells, w, h, px, py)?.corner === 'column';
    const ex = sx + stepX * len, ey = sy + stepY * len;
    if (armsAt(sx, sy) === 1 && !endsInColumn(sx, sy)) {
      push(sx, sy, at(cap, dir === 'E' ? TURN.W : TURN.N, ox, oz));
    }
    if (armsAt(ex, ey) === 1 && !endsInColumn(ex, ey)) {
      const along = fromInt(2 * len);
      push(sx, sy, at(cap, turn, dir === 'E' ? add(ox, along) : ox, dir === 'E' ? oz : add(oz, along)));
    }
  };

  for (const dir of ['E', 'S'] as const) {
    const outer = dir === 'E' ? h : w;
    const inner = dir === 'E' ? w : h;
    for (let o = 0; o < outer; o++) {
      let i = 0;
      while (i < inner) {
        const px = dir === 'E' ? i : o, py = dir === 'E' ? o : i;
        const fam = edge(px, py, dir);
        if (!fam || isSpent(px, py, dir)) { i++; continue; }
        // how far does this run of the SAME family go before it stops or hits a spent edge?
        let len = 0;
        while (i + len < inner) {
          const qx = dir === 'E' ? i + len : o, qy = dir === 'E' ? o : i + len;
          if (edge(qx, qy, dir) !== fam || isSpent(qx, qy, dir)) break;
          len++;
        }
        layRun(px, py, dir, fam, len);
        for (let k = 0; k < len; k++) {
          spend(dir === 'E' ? i + k : o, dir === 'E' ? o : i + k, dir);
        }
        i += len;
      }
    }
  }
  return out;
}

/**
 * The whole grid: what each cell owns, plus the walls laid across it. This is THE producer — the
 * renderer and the collision compiler both read it, so they agree by construction.
 */
export function gridPlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
  floorExtent?: { w: number; h: number },
): { x: number; y: number; placements: CellPlacement[] }[] {
  const walls = wallEdgePlacements(cells, w, h, floorExtent);
  const out: { x: number; y: number; placements: CellPlacement[] }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const placements = cellPlacements(cells, w, h, x, y, floorExtent);
      const wp = walls.get(y * w + x);
      if (wp) placements.push(...wp);
      if (placements.length) out.push({ x, y, placements });
    }
  }
  return out;
}
