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
  FLOOR_MATERIALS, blocks, isOpenType,
  type Axis, type Cell, type Dir, type FloorMaterial, type Seg, type WallType,
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
  /* The stair family, chosen by SENSING — see `STAIR_MESHES` for the measured footprints. */
  stairs: u('stairs_narrow'),
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
  turn: number;
  scale: Fixed;
}

const Z = fromInt(0);
const ONE = fromInt(1);
const NEG_ONE = neg(ONE);
const HALF = fromFloatConst(0.5); // a 4u floor piece rendered as a 2u cell

/** Point a +X-extending piece toward a direction. Matches the 4u convention exactly. */
const TURN = { E: 0, N: 1, W: 2, S: 3 } as const;

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none' | 'rock' | 'stairs'>, string> = {
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
 * THE HANDED VARIANTS ARE CURRENTLY UNREACHABLE, on purpose rather than by oversight. Walling exactly
 * one flank always leaves BOTH axes with one closed end, so the climb direction stops being decidable
 * and `stairFlight` refuses (see its test). They stay in the table so the fix is a one-line change if
 * the encoding ever grows a tiebreak; until then a one-flank staircase draws the bare mesh and the
 * cell's own wall beside it, which looks the same.
 */
const STAIR_MESHES = [
  //  url                          run  across  walls   wood        measured w x d (world units)
  { url: PIECE.stairsWood, run: 3, across: 2, walls: 0, wood: true },        // 3.30 x 6.00
  { url: PIECE.stairsWide, run: 2, across: 3, walls: 0, wood: false },       // 7.00 x 4.00 = 6u + 0.5
  { url: PIECE.stairsWalled, run: 2, across: 2, walls: 2, wood: false },     // 5.00 x 4.00 = 4u + 0.5
  { url: PIECE.stairsWallLeft, run: 2, across: 2, walls: -1, wood: false },  // 4.00 x 5.00, wall at -X
  { url: PIECE.stairsWallRight, run: 2, across: 2, walls: 1, wood: false },  // 4.00 x 5.00, wall at +X
  { url: PIECE.stairs, run: 2, across: 2, walls: 0, wood: false },           // 4.00 x 4.00, bare
] as const;

/** Stairs rise toward -Z natively, so N is the unturned case. NOT the table walls use — a wall runs
 *  along X, so its unturned case is E. */
const STAIR_TURN = { N: 0, W: 1, S: 2, E: 3 } as const;
/** Unit step per direction, for pushing the pivot back up-slope. */
const STEP: Record<Dir, readonly [number, number]> = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
/** Standing at the foot looking up, which grid direction is on your LEFT. Verified against the meshes:
 *  `stairs_wall_left` carries its wall at -X, which is west when the climb is north. */
const LEFT_OF: Record<Dir, Dir> = { N: 'W', W: 'S', S: 'E', E: 'N' };
const RIGHT_OF: Record<Dir, Dir> = { W: 'N', S: 'W', E: 'S', N: 'E' };

const isStairs = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): boolean =>
  cellAt(cells, w, h, x, y)?.floor === 'stairs';

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
export function stairFlight(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): StairFlight | null {
  if (!isStairs(cells, w, h, x, y)) return null;
  if (isStairs(cells, w, h, x - 1, y) || isStairs(cells, w, h, x, y - 1)) return null; // not the origin

  let bw = 1; while (isStairs(cells, w, h, x + bw, y)) bw++;
  let bh = 1; while (isStairs(cells, w, h, x, y + bh)) bh++;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) if (!isStairs(cells, w, h, x + i, y + j)) return null; // ragged, not a flight
  }

  const closed = {
    N: sideClosed(cells, w, h, x, y, bw, bh, 'N'),
    S: sideClosed(cells, w, h, x, y, bw, bh, 'S'),
    W: sideClosed(cells, w, h, x, y, bw, bh, 'W'),
    E: sideClosed(cells, w, h, x, y, bw, bh, 'E'),
  };
  const vertical = closed.N !== closed.S;
  const horizontal = closed.W !== closed.E;
  if (vertical === horizontal) return null; // neither axis decides, or both do — do not guess

  const up: Dir = vertical ? (closed.N ? 'N' : 'S') : (closed.W ? 'W' : 'E');
  const width = vertical ? bw : bh;
  const run = vertical ? bh : bw;

  const left = LEFT_OF[up], right = RIGHT_OF[up];
  const walls: -1 | 0 | 1 | 2 =
    closed[left] && closed[right] ? 2 : closed[left] ? -1 : closed[right] ? 1 : 0;

  // MATERIAL is sensed from the ground the flight connects to — a staircase in a wooden room is a
  // wooden staircase. Nothing extra is stored for it.
  const wood = neighbourFloor(cells, w, h, x, y, bw, bh) === 'wood';

  /* The first mesh that FITS. Run length is a hard requirement — a 4u flight in a 6u hole leaves a step
     missing — while width, walls and material are preferences, so an unusual block degrades to a plainer
     mesh instead of vanishing. A block no mesh can span reports nothing and draws ordinary ground, the
     same under-claiming rule the ambiguous cases use. */
  const fits = STAIR_MESHES.filter((m) => m.run === run);
  const best = fits.find((m) => m.wood === wood && m.across === width && m.walls === walls)
    ?? fits.find((m) => m.wood === wood && m.across === width)
    ?? fits.find((m) => m.across === width)
    ?? fits.find((m) => m.wood === wood)
    ?? fits[0];
  if (!best) return null;

  return { x, y, bw, bh, up, width, run, walls: best.walls, url: best.url };
}

/** The most common walkable material immediately around the block, for sensing the flight's material. */
function neighbourFloor(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, bw: number, bh: number,
): FloorMaterial | null {
  const tally = new Map<FloorMaterial, number>();
  const look = (cx: number, cy: number): void => {
    const c = cellAt(cells, w, h, cx, cy);
    if (!c || c.floor === 'stairs' || c.floor === 'none' || c.floor === 'rock') return;
    tally.set(c.floor, (tally.get(c.floor) ?? 0) + 1);
  };
  for (let i = -1; i <= bw; i++) { look(x + i, y - 1); look(x + i, y + bh); }
  for (let j = -1; j <= bh; j++) { look(x - 1, y + j); look(x + bw, y + j); }
  let best: FloorMaterial | null = null, n = 0;
  for (const m of FLOOR_MATERIALS) { // fixed order, so ties resolve deterministically
    const c = tally.get(m) ?? 0;
    if (c > n) { n = c; best = m; }
  }
  return best;
}

/** Is this cell inside a flight owned by another cell? Such a cell contributes no ground of its own. */
function insideFlight(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): StairFlight | null {
  if (!isStairs(cells, w, h, x, y)) return null;
  for (let oy = y; oy >= 0 && isStairs(cells, w, h, x, oy); oy--) {
    for (let ox = x; ox >= 0 && isStairs(cells, w, h, ox, oy); ox--) {
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
    out.push(at(
      flight.url, STAIR_TURN[flight.up],
      fromInt(flight.bw - 1 + sx * flight.run), fromInt(flight.bh - 1 + sz * flight.run),
    ));
  } else if (c.floor === 'stairs') {
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
  const coveredH = axis === 'H' || openingAt(cells, w, h, x + 1, y, 'H');
  const coveredV = axis === 'V' || openingAt(cells, w, h, x, y + 1, 'V');
  if (!coveredH && x < fw && !flightCoversWall(cells, w, h, x, y, 'N')) {
    const p = wallPiece(c.wallN);
    if (p) out.push(at(p, TURN.E, CX, CZ));
  }
  if (!coveredV && y < fh && !flightCoversWall(cells, w, h, x, y, 'W')) {
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
