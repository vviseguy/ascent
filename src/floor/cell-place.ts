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
  type Axis, type Cell, type Dir, type FloorMaterial, type Open, type Seg, type WallType,
} from './cell.ts';

const PACK = 'models/kaykit_dungeon_remastered';
const u = (f: string): string => `${PACK}/${f}.gltf.glb`;
/** A few files in the pack ship as plain `.glb` rather than `.gltf.glb`. Not a mistake to normalise —
 *  the filenames are what they are, and guessing the suffix is how a 404 becomes a red placeholder. */
const u1 = (f: string): string => `${PACK}/${f}.glb`;

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
     `wall_doorway` is the one that LOOKS like an arch: a 2.00 x 2.70 stone aperture. It measures as
     100% solid as shipped, because its door LEAF is a separate node filling the hole — so the view
     layer strips it (`openDoorLeaves`) and the opening is real. `wall_open_scaffold` is also genuinely
     passable and wider (3.40 clear), but it is a TIMBER frame and reads as scaffolding, which turned
     every doorway on the floor into a building site. Kept as `archScaffold` for when that is wanted. */
  /* THE OPENING FAMILY. `#open` marks the url for leaf-stripping and gives it its own cache slot, so
     the same file serves an open arch and (one day) a shut door. */
  archOpen: `${u1('wall_doorway')}#open`,
  doorwayShut: u1('wall_doorway'),   // the same mesh WITH its leaf node — the closed state
  archScaffold: u('wall_open_scaffold'),
  archBlind: u('wall_arched'),
  windowArched: u('wall_archedwindow_open'),
  windowBarred: u('wall_archedwindow_gated'),
  windowClosed: u('wall_window_closed'),
  cracked: u('wall_cracked'),
  scaffold: u('wall_scaffold'),
  wallPillar: u('wall_pillar'),
  /* The stair family, chosen by SENSING — see `STAIR_MESHES` for the measured footprints. */
  stairsNarrow: u('stairs_narrow'),
  stairsBanister: u('stairs'),
  stairsWalled: u('stairs_walled'),
  stairsWide: u('stairs_wide'),
  stairsWallLeft: u('stairs_wall_left'),
  stairsWallRight: u('stairs_wall_right'),
  stairsWood: u('stairs_wood'),
  window: u('wall_window_open'),
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

/**
 * A FLOOR IS ALSO A CEILING, and this is the offset that makes it read as one.
 *
 * The kit has no ceiling mesh, so a ceiling is the underside of the deck above — which is the right
 * model anyway: one piece of geometry, so what you stand on and what you look up at can never
 * disagree about whether the ground is there. Nothing has to be kept in sync because there is only
 * one thing.
 *
 * MEASURED: a floor tile is 0.15 thick with its walking surface at +0.05, so it spans [-0.10, +0.05]
 * about its origin, and a wall is 4.00 tall. Placed flat on the storey line, a deck's underside sat at
 * 3.90 — a tenth of a unit INSIDE the tops of the walls below it, which reads as a lip all the way
 * round the room. Lifting the tile by that tenth puts the underside at 4.00, flush with the wall tops.
 *
 * IT DOES NOT MOVE THE WALKING SURFACE RELATIVE TO ANYTHING THAT MATTERS. Every deck rises by the same
 * amount, so storey-to-storey spacing is untouched and a flight still climbs exactly FLOOR_HEIGHT from
 * one surface to the next. Collision is emitted from the stratum's own baseY and is not derived from
 * this, so the tile moves and the slab does not — deliberately: the slab is the walking surface, and
 * this is a tenth of a unit of trim.
 */
const DECK_LIFT: Fixed = fromFloatConst(0.10);

const FLOOR_URL: Record<Exclude<FloorMaterial, 'none' | 'rock' | 'stairs' | 'stairs_wood'>, string> = {
  stone: PIECE.floorStone, dirt: PIECE.floorDirt, wood: PIECE.floorWood,
};

/** Which 4u module an opening draws. `door` and `arch` share a mesh today. */
/**
 * TYPE -> MESH, one table rather than a chain of conditionals, so adding an asset is a line and not a
 * branch. Every entry was measured (the asset audit); the names in this kit are not reliable.
 *
 * `#open` on the doorway is not decoration — it is a distinct CACHE KEY for the same file. The loader
 * strips the door leaf from any url carrying it (`openDoorLeaves`), which is how one GLB serves both
 * an open arch and a shut door without shipping two copies.
 */
/**
 * WHAT EACH KIND LOOKS LIKE, CLOSED AND OPEN.
 *
 * The pairing is the point. `window`/`window_closed`, `cracked`/`hole`, `scaffold`/`arch_scaffold`,
 * `arch`/`arch_blind` used to be unrelated enum entries that happened to be named as pairs — so the
 * relationship lived in the naming and nothing could ask for "the other state of this". Here it is a
 * column of the table, which is also why a kind with no open form (`gate`, `pillar`) can simply say so
 * by repeating itself rather than by an author knowing not to try.
 *
 * OPEN IS NOT PASSABLE. An open window is a hole at sill 1.30 and an open `cracked` pinches to 0.10 —
 * you see through both and walk through neither. `PASSABLE_KINDS` in `cell.ts` names the three that
 * are floor-rooted and body-wide, all measured (see the asset audit).
 */
const WALLTYPE_URL: Record<WallType, { closed: string; open: string }> = {
  //             CLOSED                     OPEN
  solid:       { closed: PIECE.wall,        open: PIECE.wall },          // no module; the run lays it
  doorway:     { closed: PIECE.doorwayShut, open: PIECE.archOpen },      // leaf in, leaf out
  arch:        { closed: PIECE.archBlind,   open: PIECE.archOpen },      // blind relief, or the aperture
  window:      { closed: PIECE.windowClosed, open: PIECE.window },       // same envelope, infilled
  arch_window: { closed: PIECE.windowBarred, open: PIECE.windowArched }, // same envelope, barred
  scaffold:    { closed: PIECE.scaffold,    open: PIECE.archScaffold },  // trimmed wall, or bare frame
  cracked:     { closed: PIECE.cracked,     open: PIECE.broken },        // damaged, or breached
  gate:        { closed: PIECE.gate,        open: PIECE.gate },          // no open form in the kit
  pillar:      { closed: PIECE.wallPillar,  open: PIECE.wallPillar },    // no open form in the kit
};
export const wallTypeUrl = (wt: WallType, open: Open): string =>
  WALLTYPE_URL[wt][open === 'open' ? 'open' : 'closed'];

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
/* The floor's walking surface sits 0.05 above its placement origin. Kept as a measurement — the
   stairs no longer offset themselves onto it, but the number is what makes 0.05 + 4.00 land on the
   next deck, which is why FLOOR_HEIGHT is what it is. */
/** How far a flight actually climbs. `FLOOR_HEIGHT` must equal this or the stairs stop reaching. */
export const STAIR_CLIMB: Fixed = fromInt(4);



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

/**
 * IS A 4u MODULE DRAWN AT THIS POINT? — the RENDER question.
 *
 * Any wall type that is not `solid` draws a module: a door, an arch, a window, a cracked panel, a
 * shelf. It needs two collinear walls either side for it to sit in, and real ground under it.
 *
 * This used to BE `openingAt`, and conflating the two is what made eleven of the fifteen wall types
 * invisible. `WALLTYPE_URL` has a row for every type, but its only caller was gated on `isOpenType` —
 * three of them — so an author could paint `cracked` or `window_barred` and get a blank wall. The two
 * questions are genuinely different: whether a module is DRAWN, and whether you can WALK THROUGH it.
 */
export function moduleAt(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number, axis: Axis,
): boolean {
  const c = cellAt(cells, w, h, px, py);
  // `rock` is solid fill, not a place — a doorway in it is not a doorway, and the cell draws nothing
  // at all (see `cellPlacements`), so claiming one here deletes two wall halves and puts back nothing.
  if (!c || c.floor === 'rock' || c.wallType === 'solid') return false;
  const spans = axis === 'H'
    ? [cellAt(cells, w, h, px - 1, py)?.wallN, c.wallN]
    : [cellAt(cells, w, h, px, py - 1)?.wallW, c.wallW];
  return spans.every((s) => s === 'wall');
}

/** The axis a module runs along, or null. Checked in a fixed order so a point that satisfies both
 *  resolves deterministically — and THIS is the function the emitter and every suppression must ask,
 *  so they cannot disagree about which axis got drawn. */
export function moduleAxis(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number,
): Axis | null {
  if (moduleAt(cells, w, h, px, py, 'H')) return 'H';
  if (moduleAt(cells, w, h, px, py, 'V')) return 'V';
  return null;
}

/** Is that module one you can WALK THROUGH? — the GRAPH question. `cell-graph` and `cell-reach` ask
 *  this; the renderer asks `moduleAt`. A window is a module and not an opening. */
export function openingAt(
  cells: readonly (Cell | null)[], w: number, h: number, px: number, py: number, axis: Axis,
): boolean {
  const c = cellAt(cells, w, h, px, py);
  return !!c && isOpenType(c.wallType, c.open) && moduleAt(cells, w, h, px, py, axis);
}

/** The axis a walk-through opening runs along, or null. */
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
  /* THE NAMES ARE THE OTHER WAY ROUND ONCE THEY ARE TURNED THE RIGHT WAY UP, and that is not a typo.
     `MESH_YAW_FIX` gives these two OPPOSITE quarter-turns, because they are mirror images. A mirror
     exchanges left and right, so the side each one's wall ends up on is the opposite of the side its
     filename claims. `_left` supplies the climber's RIGHT-hand wall and `_right` the LEFT.
     Verified by eye, which is the only way this can be checked: `cell-snap.html?assets=stairs`. */
  { url: PIECE.stairsWallRight, mat: 'stairs', run: 2, across: 2, walls: -1 },  // wall on the climber's LEFT
  { url: PIECE.stairsWallLeft, mat: 'stairs', run: 2, across: 2, walls: 1 },    // wall on the climber's RIGHT
  { url: PIECE.stairsBanister, mat: 'stairs', run: 2, across: 2, walls: 0 },    // 5.00 wide, 3.50 tread
] as const satisfies readonly { url: string; mat: FloorMaterial; run: number; across: number; walls: number }[];


/**
 * Stairs rise toward -Z natively, so N is the unturned case. NOT the table walls use — a wall runs
 * along X, so its unturned case is E.
 *
 * MEASURED, not assumed (`tmp/glb-climb4.mjs`). It sat here as a bare assertion next to a handedness
 * note that makes a point of having been measured, which is exactly the kind of asymmetry worth
 * distrusting. Correlating vertex height against each horizontal axis, over tread-height geometry only
 * so the tall side walls cannot vote: every one of the six stair meshes gives a dominant NEGATIVE
 * r(Z,Y) — -0.52 for `stairs`, `stairs_wide` and `stairs_narrow`, -0.24 for the handed pair, -0.11 for
 * `stairs_walled` — with the top tread at low Z in all six. They climb toward -Z.
 *
 * Two traps in checking this, both of which gave a confidently wrong answer first:
 *   - a CENTROID is dragged by the side wall, which is tall and sits on one side. It reported
 *     `stairs_wall_left` climbing WEST, which is just where its wall is.
 *   - treads are BOXES, so vertices exist only at their corners. Slicing the mesh and taking the
 *     highest vertex per slice finds nothing at all in between and reads as flat.
 *
 * The turn index is +90 degrees (`TURN_YAW`/`TURN_RAD` are both [0, PI/2, PI, -PI/2]), so -Z at turn 1
 * points -X = W, which is what this table says. Worth stating because a WALL RUN IS SYMMETRIC UNDER
 * 180 DEGREES: a sign error in the turn convention is invisible on walls and would show up only on an
 * asymmetric piece like a staircase.
 */
const STAIR_TURN = { N: 0, W: 1, S: 2, E: 3 } as const;

/**
 * TWO MESHES IN THIS KIT ARE AUTHORED A QUARTER-TURN OFF, IN OPPOSITE DIRECTIONS.
 *
 * `STAIR_TURN` assumes every flight shares one body orientation, and five of the six do. The two
 * banister-and-wall variants do not: their footprints are 4.00 x 5.00 where every other flight is
 * 5.00 x 4.00 — DEEPER THAN WIDE, which is the whole tell, and it was sitting in this file's own
 * comments for months while the same turn was applied to all six.
 *
 * Found by drawing them: `cell-snap.html?assets=stairs&spin=<name>` puts a mesh at all four
 * quarter-turns beside `stairs`, and exactly one lines up. `stairs_wall_left` needs a further -90 and
 * `stairs_wall_right` a further +90 — opposite ways, because the two are mirror images and a mirror
 * turns a left-handed error into a right-handed one.
 *
 * WHY THE VERTEX MEASUREMENT MISSED IT. `tmp/glb-hand.mjs` counted vertices above the top tread and
 * found 13 at -X for `_left` and 13 at +X for `_right`, concluding "the mesh names mean what they
 * say". They do — but those 13 vertices are a POST AT ONE CORNER (measured centre: x=-2, z=4.02, the
 * foot end), not a wall running the length of the flight. A statistic that agrees with the label is
 * not a confirmation of it. The picture settled in one frame what four measurements could not.
 *
 * A DATA FIX, NOT A CODE FIX, would be better — re-export the two GLBs square with the rest and delete
 * this table. Until someone owns the art, correcting at the placement is the honest version: it is one
 * table, next to the constant it corrects, and it says which meshes are wrong and how.
 */
/**
 * WHERE A STAIR MESH'S FOOTPRINT CENTRE SITS, in its own local frame, in HALF-CELL units.
 *
 * MEASURED across all six (`cell-snap.html?assets=stairs`): every one spans its run from Z 0 to 4 and
 * is centred in X, so its origin is at the middle of one END rather than at the middle of the mesh.
 * Two units along +Z, nothing across. The same for the odd pair, whose extents are Z [-0.5, 4.5] —
 * still centred on 2.
 *
 * It is a VECTOR rather than a scalar "push it up-slope by half the run" because a vector rotates and
 * a rule of thumb does not. The old phrasing was only ever right while every mesh's local -Z was world
 * up-slope; the moment two of them needed turning it put those flights two cells off their blocks.
 */
const MESH_PIVOT: readonly [number, number] = [0, 2];

const MESH_YAW_FIX: Record<string, number> = {
  [PIECE.stairsWallLeft]: 3,
  [PIECE.stairsWallRight]: 1,
};

/** The quarter-turn to actually place `url` at, for a flight climbing `up`. */
const stairTurn = (url: string, up: Dir): number =>
  (STAIR_TURN[up] + (MESH_YAW_FIX[url] ?? 0)) % 4;

/**
 * READ A PLACED FLIGHT BACK: which way does this drawn staircase climb?
 *
 * The inverse of `stairTurn`, and it has to exist as a function rather than as a table anyone can
 * write down, because `turn` ALONE NO LONGER ANSWERS IT — two meshes carry an extra quarter-turn of
 * their own, so the same `turn` means different directions depending on the url. Anything reading a
 * placement back (a test, a debug overlay, a collider cross-check) must go through here or it will
 * silently disagree with the renderer on exactly those two meshes.
 */
export function drawnClimbDir(url: string, turn: number): Dir {
  const raw = (((turn - (MESH_YAW_FIX[url] ?? 0)) % 4) + 4) % 4;
  return (['N', 'W', 'S', 'E'] as const)[raw]!;
}
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

/* ==================================================================================================
   WHICH WAY DOES IT CLIMB?

   Four readings of the same block, scored, best wins. THE INDEX IS WHERE THE FOOT IS: `rank[i]` scores
   "you walk in from side i", so the flight climbs toward the opposite side. Thinking in feet rather
   than heads is what makes the formula read straight — every term is either about the end you enter
   from or the end you climb into, and they are always opposites.

   RING is ordered N,E,S,W so the opposite side is simply (i + 2) % 4.

   The whole judgement is four small integer arrays — walls and floors, on this storey and the one
   above — and five terms over them. It replaced a scheme where the walls acted as a GATE: an axis
   qualified only if exactly one of its ends was fully walled, which meant at most two of the four
   directions were ever candidates and a half-built head wall struck its axis out before anything else
   was weighed. A staircase with unfinished walls and unambiguous floor evidence was made to climb into
   the void, and no amount of reweighting could fix it because the right answer had already been
   discarded. Nothing is discarded now.
   ================================================================================================== */

/** The four sides in a ring, so `opposite(i)` is (i + 2) % 4. Do not reorder. */
const RING = ['N', 'E', 'S', 'W'] as const;
const opposite = (i: number): number => (i + 2) % 4;

/** LAST RESORT, when the terms and the tiebreak have all come out level: prefer a vertical reading.
 *  Arbitrary — but FIXED, and the same arbitrary choice the previous scheme made, so a perfectly
 *  symmetric corner does not silently turn ninety degrees. The editor says when it lands here. */
const TIE_ORDER: readonly Dir[] = ['N', 'S', 'W', 'E'];

/** The block's own cells along one side. */
function sideCells(x: number, y: number, bw: number, bh: number, d: Dir): [number, number][] {
  const out: [number, number][] = [];
  if (d === 'N' || d === 'S') {
    const row = d === 'N' ? y : y + bh - 1;
    for (let i = 0; i < bw; i++) out.push([x + i, row]);
  } else {
    const col = d === 'W' ? x : x + bw - 1;
    for (let j = 0; j < bh; j++) out.push([col, y + j]);
  }
  return out;
}

/** One cell OUT from each of those — where you would be standing. */
const beyondSide = (x: number, y: number, bw: number, bh: number, d: Dir): [number, number][] =>
  sideCells(x, y, bw, bh, d).map(([cx, cy]) => [cx + STEP[d][0], cy + STEP[d][1]] as [number, number]);

/**
 * IS THE EDGE ON SIDE `d` OF (x,y) ACTUALLY SEALED?
 *
 * NOT the same as "is there a wall segment here". Some walls are doors. A `doorway`, `arch` or
 * `scaffold` that is `open` draws as a wall and is walked straight through, so counting segments alone
 * puts a head wall where there is an open door and calls a foot blocked when you can stroll in.
 *
 * The segment lives on the EDGE, the opening lives on a POINT, and a 4u module straddles TWO segments
 * — the one either side of its point (see `moduleAt`). So an edge is un-sealed by a walk-through module
 * at EITHER of its endpoints, on the matching axis: horizontal for a north edge, vertical for a west
 * one.
 *
 * This is the same DRAWN-versus-WALK-THROUGH distinction that `moduleAt` and `openingAt` exist to keep
 * apart, and it had leaked back in here: the scoring asked `blocks()` and got the render answer to a
 * movement question.
 */
function edgeSealed(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: Dir,
): boolean {
  const o = d === 'N' ? { x, y, side: 'N' as const }
    : d === 'W' ? { x, y, side: 'W' as const }
      : d === 'S' ? { x, y: y + 1, side: 'N' as const }
        : { x: x + 1, y, side: 'W' as const };
  if (!blocks(wallOn(cells, w, h, x, y, d))) return false;   // nothing there in the first place
  const axis: Axis = o.side === 'N' ? 'H' : 'V';
  const throughA = openingAt(cells, w, h, o.x, o.y, axis);
  const throughB = o.side === 'N'
    ? openingAt(cells, w, h, o.x + 1, o.y, axis)
    : openingAt(cells, w, h, o.x, o.y + 1, axis);
  return !(throughA || throughB);
}

/** Per side: how many of that side's cells are SEALED against you. 0..bw (or bh). */
const wallsPerSide = (
  cells: readonly (Cell | null)[] | undefined, w: number, h: number,
  x: number, y: number, bw: number, bh: number,
): number[] => RING.map((d) => cells
  ? sideCells(x, y, bw, bh, d).filter(([cx, cy]) => edgeSealed(cells, w, h, cx, cy, d)).length
  : 0);

/** Somewhere to stand. `none` is a pit and `rock` is solid, so neither is ground. */
const standable = (c: Cell | null): boolean => !!c && c.floor !== 'none' && c.floor !== 'rock';

/** Per side: how many cells just beyond it you could stand on. */
const floorsPerSide = (
  cells: readonly (Cell | null)[] | undefined, w: number, h: number,
  x: number, y: number, bw: number, bh: number,
): number[] => RING.map((d) => cells
  ? beyondSide(x, y, bw, bh, d).filter(([cx, cy]) => standable(cellAt(cells, w, h, cx, cy))).length
  : 0);

function ceilingOpen(
  above: readonly (Cell | null)[] | undefined, w: number, h: number,
  x: number, y: number, bw: number, bh: number, d: Dir,
): boolean {
  if (!above) return false;
  const at = (cx: number, cy: number): Cell | null =>
    cx < 0 || cy < 0 || cx >= w || cy >= h ? null : above[cy * w + cx] ?? null;
  // the cells at the `d` end of the block — where you arrive
  const cells: [number, number][] = [];
  if (d === 'N' || d === 'S') {
    const row = d === 'N' ? y : y + bh - 1;
    for (let i = 0; i < bw; i++) cells.push([x + i, row]);
  } else {
    const col = d === 'W' ? x : x + bw - 1;
    for (let j = 0; j < bh; j++) cells.push([col, y + j]);
  }
  // EVERY head cell must be open: a hole over half the flight is a hole you can fall down, not an exit
  return cells.every(([cx, cy]) => at(cx, cy)?.floor === 'none');
}

/* ---- THE FIVE TERMS ------------------------------------------------------------------------------
   Two shapes of evidence, and the difference is deliberate.

   PRESENCE IS SQUARED. A side half-covered is not half as good as one fully covered: an entrance two
   cells wide is a way in, one cell wide is a gap you might fall through, and none at all is a wall.
   Squaring the 0/1/2 count spreads them 0 / 1 / 4 so a full side decisively outweighs a partial one.

   ABSENCE IS A FLAG. "Nothing is in the way" has no degrees worth grading — one wall segment across
   your path stops you as surely as two — so those terms are simply 0 or 1.

   Weights are meant to be tuned; the shape is what matters. HEAD WALL and GROUND are the two that
   define a staircase (something to climb into, somewhere to come from), so they carry the most. */
const W_FOOT_OPEN = 2;    // the side you enter from is unwalled
const W_HEAD_WALL = 3;    // the side you climb into IS walled
const W_CLEAR_ABOVE = 2;  // upstairs, that side is unwalled too, so arriving is not blocked
const W_GROUND = 3;       // floor just beyond the foot, to walk in from
const W_LANDING = 2;      // floor upstairs just beyond the head, to step out onto

const strength = (n: number): number => n * n;
const absent = (n: number): number => (n === 0 ? 1 : 0);

export interface DirRank {
  /** Where you climb TO. */
  dir: Dir;
  /** Where you walk in FROM — the opposite side, and the one the score is indexed by. */
  foot: Dir;
  score: number;
  /** Fit to draw at all: something to climb into, and somewhere to come from. See `rankAll`. */
  viable: boolean;
  /** Tiebreak only, never scored: does the head wall stop at the block, or run past it? */
  ownHead: boolean;
  /** Every term, for the readout. */
  terms: { footOpen: number; headWall: number; clearAbove: number; ground: number; landing: number };
}

/**
 * DOES THE HEAD WALL STOP AT THE BLOCK, or run on past it?
 *
 * NOT A TERM — a tiebreak, and the distinction matters. The five terms describe GEOMETRY. This is a
 * guess about a HUMAN HABIT: someone building a stairwell draws a short wall exactly behind the
 * stairs, while a wall running the length of the room is the room's own. Weaker evidence, so it never
 * outvotes a fact — it only orders readings the geometry has already declared identical, which beats
 * ordering them by an arbitrary compass order.
 *
 *      ITS OWN HEAD WALL            A WALL IT MERELY STANDS BESIDE
 *      (stops at the block)         (runs on past, both ways)
 *
 *           =====                   =====================
 *            S S                            S S
 *            S S                            S S
 *
 * OFF THE MAP IS NOT A WALL. `wallOn` reports the void beyond the lattice as `wall` — right for
 * `sideClosed` (you cannot walk off the world), wrong here: beyond the edge there is nothing for a
 * wall to run on into. A head stub starting on the border used to read as "runs past".
 */
function headWallRunsPast(
  cells: readonly (Cell | null)[], w: number, h: number,
  x: number, y: number, bw: number, bh: number, d: Dir,
): boolean {
  const [ax, ay, bx, by] = d === 'N' ? [x - 1, y, x + bw, y]
    : d === 'S' ? [x - 1, y + bh - 1, x + bw, y + bh - 1]
      : d === 'W' ? [x, y - 1, x, y + bh]
        : [x + bw - 1, y - 1, x + bw - 1, y + bh];
  const onMap = (px: number, py: number): boolean => px >= 0 && py >= 0 && px < w && py < h;
  const runsOn = (px: number, py: number): boolean =>
    onMap(px, py) && blocks(wallOn(cells, w, h, px, py, d));
  return runsOn(ax, ay) || runsOn(bx, by);
}

/**
 * All four readings, best first.
 *
 * VIABILITY IS SEPARATE FROM SCORE, and keeping them apart is the point. Score RANKS; viability says
 * whether the winner is fit to draw at all. Fold them together and there is always a winner however
 * bad the field — four poor readings still produce a confident staircase, which is how a flight ended
 * up facing a wall with its entrance in the void.
 *
 * THE HOLE IN THE CEILING IS NOT HERE, and deliberately. It is the only way off the top of a flight,
 * which makes it sound like the strongest signal of all — but it is the same value for every direction.
 * A stairwell's hole is cut to the shape of the BLOCK, so every reading's head cells sit inside it:
 * measured across the whole authored store, 13 flights out of 13 answered identically in all four
 * directions. A constant added to all four options cannot order them. It survives where it does mean
 * something — as a FAULT, below, for a flight that climbs into a solid deck — and nowhere else.
 */
function rankAll(
  cells: readonly (Cell | null)[], above: readonly (Cell | null)[] | undefined,
  w: number, h: number, x: number, y: number, bw: number, bh: number,
): DirRank[] {
  const wallsHere = wallsPerSide(cells, w, h, x, y, bw, bh);
  const wallsAbove = wallsPerSide(above, w, h, x, y, bw, bh);
  const floorsHere = floorsPerSide(cells, w, h, x, y, bw, bh);
  const floorsAbove = floorsPerSide(above, w, h, x, y, bw, bh);

  const ranks = RING.map((footDir, i): DirRank => {
    const head = opposite(i);
    const terms = {
      footOpen: absent(wallsHere[i]!) * W_FOOT_OPEN,
      headWall: strength(wallsHere[head]!) * W_HEAD_WALL,
      clearAbove: absent(wallsAbove[head]!) * W_CLEAR_ABOVE,
      ground: strength(floorsHere[i]!) * W_GROUND,
      landing: strength(floorsAbove[head]!) * W_LANDING,
    };
    const dir = RING[head]!;
    return {
      dir, foot: footDir,
      score: terms.footOpen + terms.headWall + terms.clearAbove + terms.ground + terms.landing,
      // a wall to climb into, and ground to come from. Neither is a preference.
      viable: wallsHere[head]! > 0 && floorsHere[i]! > 0,
      ownHead: !headWallRunsPast(cells, w, h, x, y, bw, bh, dir),
      terms,
    };
  });

  return ranks.slice().sort((a, b) => (b.viable ? 1 : 0) - (a.viable ? 1 : 0)
    || b.score - a.score                                  // the five terms decide
    || (b.ownHead ? 1 : 0) - (a.ownHead ? 1 : 0)          // identical? then whose wall is it
    || TIE_ORDER.indexOf(a.dir) - TIE_ORDER.indexOf(b.dir));  // still level? fixed, never random
}

export interface StairChoice {
  /** all four, best first */
  ranks: DirRank[];
  chosen: Dir | null;
  /** the winner and runner-up scored the same */
  tie: boolean;
}

let lastChoice: StairChoice | null = null;

/** The reasoning behind the flight at (x,y), or null if there is none there. Call right after
 *  `stairFlight` on the same cell. */
export function stairChoiceAt(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
  above?: readonly (Cell | null)[],
): StairChoice | null {
  lastChoice = null;
  flightGeometry(cells, w, h, x, y, above);
  return lastChoice;
}

/** One line an author can read. The LOSERS are the interesting part when a flight faces somewhere
 *  unexpected, so all four are printed with every term. */
export function stairChoiceText(c: StairChoice): string {
  const one = (r: DirRank): string =>
    `${r.dir}${r.dir === c.chosen ? '*' : ''} ${r.score}`
    + ` (foot ${r.foot}: open ${r.terms.footOpen}, head wall ${r.terms.headWall},`
    + ` clear above ${r.terms.clearAbove}, ground ${r.terms.ground}, landing ${r.terms.landing}`
    + `${r.viable ? '' : ' — UNUSABLE'})`;
  return c.ranks.map(one).join('  |  ')
    + (c.tie ? '  — tied on all five, ordered by whose head wall it is' : '');
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
  above?: readonly (Cell | null)[],
): { ok: Geometry } | { fault: StairFault } | null {
  const mat = stairMat(cells, w, h, x, y);
  if (mat === null) return null;
  if (isStairs(cells, w, h, x - 1, y, mat) || isStairs(cells, w, h, x, y - 1, mat)) return null; // not the origin

  let bw = 1; while (isStairs(cells, w, h, x + bw, y, mat)) bw++;
  let bh = 1; while (isStairs(cells, w, h, x, y + bh, mat)) bh++;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) if (!isStairs(cells, w, h, x + i, y + j, mat)) return { fault: { kind: 'ragged', mat } };
  }

  /* RANK ALL FOUR DIRECTIONS. No axis gate, no forced/contested split.

     What stood here: `closed[d]` was computed all-or-nothing, then `vAxis = closed.N XOR closed.S`
     and the same for W/E decided which AXES were even allowed to compete. At most two directions
     were ever candidates, and WITHIN an axis the walls alone picked N-or-S with no other signal
     consulted. If exactly one axis survived, the walls settled it outright and the foot, ceiling and
     landing were computed only for the readout and then thrown away.

     That gate is what put a staircase into the void: a head wall covering half the block failed the
     all-or-nothing test, its axis was struck out before scoring, and the surviving axis won by being
     the only one left — while the axis with the actual floor evidence held a twelve-point advantage
     nothing ever counted.

     Now every direction is scored on every criterion and the best one wins. The walls stopped being
     a filter and became evidence, which is all they ever were. */
  const ranks = rankAll(cells, above, w, h, x, y, bw, bh);
  const best = ranks[0]!;
  const runnerUp = ranks[1];
  lastChoice = {
    ranks,
    chosen: best.viable ? best.dir : null,
    tie: !!runnerUp && runnerUp.viable === best.viable && runnerUp.score === best.score,
  };

  /* NOTHING FIT TO DRAW. Not "the walls were ambiguous" any more — every reading was examined and
     none of them is a staircase: no wall to climb into, or no way in, or nowhere to come from. The
     readout carries the whole table, so the author can see which criterion each direction failed
     rather than being told the block is undecidable. */
  if (!best.viable) return { fault: { kind: 'undecidable', mat, bw, bh } };

  const up: Dir = best.dir;
  const vertical = up === 'N' || up === 'S';
  const width = vertical ? bw : bh;
  const run = vertical ? bh : bw;
  const left = LEFT_OF[up], right = RIGHT_OF[up];
  /* THE HANDED MESH still asks the all-or-nothing question, and correctly: a flank is a wall to run
     the balustrade against only if it covers the whole flight. Half a flank is not half a mesh. */
  const flank = (d: Dir): boolean => sideClosed(cells, w, h, x, y, bw, bh, d);
  const walls: -1 | 0 | 1 | 2 =
    flank(left) && flank(right) ? 2 : flank(left) ? -1 : flank(right) ? 1 : 0;

  /* RUN AND WIDTH ARE BOTH HARD. Run length was already — a 4u mesh in a 6u hole leaves a step
     missing — but width was only a preference, and a block wider than any mesh fell through to
     `fits[0]`. That drew a 7.00 mesh over an 8u block and left 1.00 x 4.00 of deck simply absent,
     because the block's other cells abstain from drawing ground of their own (`insideFlight`).
     Failing here instead sends the whole block to per-cell stone: visible, walkable, and
     `stairFaultText` tells the author which sizes exist. */
  /* A SEALED CEILING is worth refusing over, but ONLY WHEN THE WALLS LEFT NO CHOICE.

     `hole` is scored rather than required on purpose: a single-storey structure has no ceiling to
     speak of, and requiring one would make every ground-floor staircase a fault. So the refusal is
     narrow — when exactly one direction has a head wall at all, the geometry dictated the answer and
     nothing weighed the ceiling, and a flight climbing into solid deck should say so rather than draw.

     WHEN TWO OR MORE DIRECTIONS HAVE A HEAD WALL, THE RANKING ALREADY WEIGHED THE HOLE and picked the
     best available reading. Faulting there would reject cases it deliberately resolved — including a
     staircase whose only usable entrance happens to sit under solid deck, which is a real authoring
     situation and currently ships. Drawing the best available reading and reporting `hole n` in the
     table is the honest answer; refusing to draw is not.

     This is the restriction the old code expressed as "only on a FORCED axis". Restating it in the new
     vocabulary cost three tests when it was briefly dropped: the test is HEAD WALLS, not viability,
     because viability also folds in the foot — and the foot is exactly what the ranking is supposed to
     be allowed to trade against the ceiling. */
  const withHeadWall = ranks.filter((r) => r.terms.headWall > 0).length;
  if (withHeadWall <= 1 && above && !ceilingOpen(above, w, h, x, y, bw, bh, up)) {
    return { fault: { kind: 'sealed-ceiling', mat, up } };
  }

  if (!STAIR_MESHES.some((m) => m.mat === mat && m.run === run && m.across === width)) {
    return { fault: { kind: 'no-mesh', mat, run, width } };
  }
  return { ok: { mat, bw, bh, up, width, run, walls } };
}

export function stairFlight(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
  above?: readonly (Cell | null)[],
): StairFlight | null {
  const g = flightGeometry(cells, w, h, x, y, above);
  if (!g || !('ok' in g)) return null;
  const { mat, bw, bh, up, width, run, walls } = g.ok;

  /* The first mesh that FITS. MATERIAL and RUN LENGTH are hard requirements — a stone flight is not a
     wooden one, and a 4u mesh in a 6u hole leaves a step missing — while width and walls are
     preferences, so an unusual block degrades to a plainer mesh instead of vanishing. */
  const fits = STAIR_MESHES.filter((m) => m.mat === mat && m.run === run && m.across === width);
  // walls stay a PREFERENCE — a flight with no matching walled variant is still the right size, so it
  // degrades to a plainer mesh of the same footprint rather than vanishing
  const best = fits.find((m) => m.walls === walls) ?? fits[0];
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
  | { kind: 'no-mesh'; mat: FloorMaterial; run: number; width: number }
  /** Its entrance faces void, solid rock or off the map — nobody can walk on to it. */
  | { kind: 'no-entry'; mat: FloorMaterial; up: Dir }
  /** It climbs into the deck of the storey above instead of a hole through it. */
  | { kind: 'sealed-ceiling'; mat: FloorMaterial; up: Dir };

export function stairFault(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
  above?: readonly (Cell | null)[],
): StairFault | null {
  const g = flightGeometry(cells, w, h, x, y, above);
  return g && 'fault' in g ? g.fault : null;
}

/** Human-readable, for the editor's readout. */
export function stairFaultText(f: StairFault): string {
  if (f.kind === 'ragged') return 'not a rectangle — a flight has to be a solid block of stair cells';
  if (f.kind === 'undecidable') {
    return 'cannot tell which way it climbs — one END must be walled and the opposite one open, '
      + 'so there is a top to climb toward and a bottom to walk in at';
  }
  if (f.kind === 'no-entry') {
    return `its entrance faces ${f.up === 'N' ? 'south' : f.up === 'S' ? 'north' : f.up === 'W' ? 'east' : 'west'} `
      + 'and there is no ground there — nobody can walk on to it';
  }
  if (f.kind === 'sealed-ceiling') {
    return `it climbs ${f.up} into the deck above instead of a hole through it — open the ceiling over `
      + 'the flight, or move a wall so it climbs the other way';
  }
  const forMat = STAIR_MESHES.filter((m) => m.mat === f.mat);
  const runs: number[] = [...new Set<number>(forMat.map((m) => m.run))].sort();
  const widths: number[] = [...new Set<number>(forMat.filter((m) => m.run === f.run).map((m) => m.across))].sort();
  if (!runs.includes(f.run)) return `no ${f.mat} flight is ${f.run} cells long — it must be ${runs.join(' or ')}`;
  return `no ${f.mat} flight ${f.run} long is ${f.width} across — it must be ${widths.join(' or ')}`;
}

/** Is this cell inside a flight owned by another cell? Such a cell contributes no ground of its own. */
function insideFlight(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
  above?: readonly (Cell | null)[],
): StairFlight | null {
  const mat = stairMat(cells, w, h, x, y);
  if (mat === null) return null;
  for (let oy = y; oy >= 0 && isStairs(cells, w, h, x, oy, mat); oy--) {
    for (let ox = x; ox >= 0 && isStairs(cells, w, h, ox, oy, mat); ox--) {
      const f = stairFlight(cells, w, h, ox, oy, above);
      if (f && x >= f.x && x < f.x + f.bw && y >= f.y && y < f.y + f.bh) return f;
    }
  }
  return null;
}

/** Does a WALLED flight already draw the wall on side `d` of (x,y)? Its mesh carries its own sides, so
 *  emitting the cell wall too would double them. */
function flightCoversWall(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: 'N' | 'W',
  above?: readonly (Cell | null)[],
): boolean {
  for (const [cx, cy] of [[x, y], [x - 1, y], [x, y - 1]] as [number, number][]) {
    const f = insideFlight(cells, w, h, cx, cy, above);
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
/**
 * A TORCH HANGS ON A SURFACE, NOT AT A POINT — and getting that wrong is invisible in the numbers and
 * obvious the moment you look. `torch_mounted` projects 0.62 from its own origin, so placed at the
 * lattice point it sits INSIDE whatever it is mounted on: on a 1.50-wide pillar only a grey speck of
 * it emerged from the stone. It has to be pushed out to the face.
 *
 * Measured AT TORCH HEIGHT (`tmp/width-at.mjs`), not from a bounding box — which is the second half of
 * the same mistake. A pillar's box is 0.75 across because of the flare at its base; at 2.1 it is 0.55,
 * and mounting to the box left the bracket floating a fifth of a unit off the stone. A wall's body is
 * 0.25 but its brick detail stands proud to 0.33.
 *
 *   pillar 0.55 at y 2.1   |   wall 0.33 at y 2.1   |   balcony post 0.35 at y 0.95
 */
const MOUNT_OUT = { column: fromFloatConst(0.55), balcony: fromFloatConst(0.35), none: fromFloatConst(0.33) };
/** Head height on a 4.00 wall — but a balcony post is only 1.40 tall, and a torch at head height
 *  above one floats in the air with nothing under it. */
const TORCH_Y = fromFloatConst(2.1);
const TORCH_Y_LOW = fromFloatConst(0.95);
/** Fixed order, so which way a torch faces is a property of the map and not of the loop. */
const TORCH_ORDER: readonly Dir[] = ['S', 'E', 'N', 'W'];

/**
 * WHICH WAY A TORCH FACES, sensed rather than stored — the same rule the opening axis and the stair
 * direction follow, and for the same reason: a fact the walls already carry should not be written down
 * a second time where it can disagree with them.
 *
 * A torch needs something to hang on and somewhere to shine. It mounts on whatever is standing at the
 * point — a pillar, or one of the walls meeting there — and faces a cardinal direction that is NOT a
 * wall and NOT solid rock, so it lights a space someone can actually stand in.
 *
 * A FREE-STANDING COLUMN CARRIES UP TO FOUR, one per open side, because every side of it is a face
 * someone can walk past. A point in a wall carries ONE: both sides of the same wall would read as a
 * mistake rather than as two torches. With nothing to mount on, or nowhere to face, there are none.
 */
export function torchFacings(
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): Dir[] {
  const c = cellAt(cells, w, h, x, y);
  if (!c) return [];

  /** The wall running `d` from this point, if any. */
  const arm = (d: Dir): Seg => {
    if (d === 'E') return cellAt(cells, w, h, x, y)?.wallN ?? 'none';
    if (d === 'W') return cellAt(cells, w, h, x - 1, y)?.wallN ?? 'none';
    if (d === 'S') return cellAt(cells, w, h, x, y)?.wallW ?? 'none';
    return cellAt(cells, w, h, x, y - 1)?.wallW ?? 'none';
  };
  const onColumn = c.corner !== 'none';
  if (!onColumn && !TORCH_ORDER.some((d) => blocks(arm(d)))) return []; // nothing to hang it on

  /** Ground you can stand on — `none` is a hole and `rock` is solid fill. */
  const open = (cx: number, cy: number): boolean => {
    const n = cellAt(cells, w, h, cx, cy);
    return !!n && n.floor !== 'none' && n.floor !== 'rock';
  };
  const out: Dir[] = [];
  for (const d of TORCH_ORDER) {
    if (blocks(arm(d))) continue;                      // it would be inside the wall
    // the two cells either side of that direction; one of them being real ground is enough
    const pair: [number, number][] = d === 'E' ? [[x, y - 1], [x, y]]
      : d === 'W' ? [[x - 1, y - 1], [x - 1, y]]
        : d === 'S' ? [[x - 1, y], [x, y]]
          : [[x - 1, y - 1], [x, y - 1]];
    if (!pair.some(([cx, cy]) => open(cx, cy))) continue;
    out.push(d);
    // A COLUMN is free-standing and can carry one on every open side — up to four. A wall point is
    // a face, so it takes ONE: a bracket on each side of the same wall reads as a mistake, not as
    // two torches.
    if (!onColumn) break;
  }
  return out;
}

/** The first facing, or null. Kept because most callers only ask whether there IS one. */
export const torchFacing = (
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number,
): Dir | null => torchFacings(cells, w, h, x, y)[0] ?? null;

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
  above?: readonly (Cell | null)[],
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
  const flight = stairFlight(cells, w, h, x, y, above);
  if (flight && inFloor) {
    /* The block centre, relative to the origin cell centre, in cell-local (= world) units — then pushed
       UP-SLOPE by half the run, because the mesh pivots on its top end rather than its middle.
       NOTHING ELSE. There was a 0.05 lift onto the deck's walking surface and a 0.12 nudge downhill to
       clear wall trim; both are gone. The PIVOT correction stays — it is not a tweak, it is what puts
       the mesh on its own block at all. */
    /* CENTRE THE MESH ON ITS BLOCK — by its own footprint, not by a rule about where it pivots.
       This used to push the mesh half a run UP-SLOPE, on the reasoning that "a flight pivots on its
       top end". That is not what these meshes do. MEASURED, every one of them: the footprint centre
       sits at local (0, +2) — centred across, two units along +Z — so the origin is at the middle of
       one edge, not at the top of the run. The up-slope push happened to give the right answer only
       while local -Z was world up-slope, and stopped the moment `MESH_YAW_FIX` turned two of them.
       The general rule has no special case: put the origin where the footprint centre lands on the
       block centre, which means stepping BACK along the rotated pivot vector.
       Rotating +90 about Y maps (x,z) -> (z,-x). */
    let [px, pz] = MESH_PIVOT;
    for (let k = 0, t = stairTurn(flight.url, flight.up); k < t; k++) [px, pz] = [pz, -px];
    out.push(at(
      flight.url, stairTurn(flight.url, flight.up),
      fromInt(flight.bw - 1 - px), fromInt(flight.bh - 1 - pz),
    ));
  } else if (isStairFloor(c.floor)) {
    if (!insideFlight(cells, w, h, x, y, above) && inFloor) {
      out.push(at(PIECE.floorStone, 0, Z, Z, HALF, DECK_LIFT));
    }
  } else if (c.floor !== 'none' && inFloor) {
    out.push(at(FLOOR_URL[c.floor], 0, Z, Z, HALF, DECK_LIFT));
  }

  // the NW corner point of this cell, in cell-local coordinates
  const CX = NEG_ONE, CZ = NEG_ONE;

  // MODULE — a 4u piece centred on the corner, spanning the two collinear segments either side. It
  // REPLACES both of them, including the one the neighbour owns (see the header). Any non-`solid`
  // type draws one, not only the walk-through ones — see `moduleAt`.
  const axis = moduleAxis(cells, w, h, x, y);
  if (axis) out.push(at(wallTypeUrl(c.wallType, c.open), axis === 'H' ? TURN.E : TURN.S, CX, CZ));

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
    const outBy = MOUNT_OUT[c.corner];
    const high = c.corner === 'balcony' ? TORCH_Y_LOW : TORCH_Y;
    for (const d of torchFacings(cells, w, h, x, y)) {
      const [sx, sz] = STEP[d];
      out.push(at(
        PIECE.torchMounted, TORCH_TURN[d],
        add(CX, mul(fromInt(sx), outBy)), add(CZ, mul(fromInt(sz), outBy)), ONE, high,
      ));
    }
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
  above?: readonly (Cell | null)[],
): Map<number, CellPlacement[]> {
  const fw = floorExtent?.w ?? w, fh = floorExtent?.h ?? h;
  const out = new Map<number, CellPlacement[]>();
  const push = (cx: number, cy: number, p: CellPlacement): void => {
    const k = cy * w + cx;
    const list = out.get(k);
    if (list) list.push(p); else out.set(k, [p]);
  };

  /**
   * WHO DRAWS THIS EDGE — and the distinction is load-bearing.
   *
   * This used to return `WallFamily | null`, and `null` meant three different things: there is no wall
   * here, a module covers it, or a stair flight carries it. `armsAt` needs the FIRST of those and got
   * all three, so a run that stopped because a doorway continued the wall read as a run stopping in
   * mid-air — and planted an endcap inside the aperture. A full-height 1.07 stub in a 2.00 doorway,
   * on a quarter of every floor's openings, and invisible to the tests because the assertion helper
   * filtered `wall_endcap` out.
   *
   * `none` means the MODEL has no wall here. Everything else means there is one, drawn by someone.
   */
  type EdgeDraw =
    | { by: 'none' }
    | { by: 'run'; fam: WallFamily }
    | { by: 'module' }
    | { by: 'flight' };
  const NO_EDGE: EdgeDraw = { by: 'none' };

  const edgeDraw = (px: number, py: number, dir: 'E' | 'S'): EdgeDraw => {
    const c = cellAt(cells, w, h, px, py);
    if (!c) return NO_EDGE;
    if (dir === 'E') {
      if (px >= fw) return NO_EDGE;                                   // no such edge on this lattice
      const fam = familyOf(c.wallN);
      if (!fam) return NO_EDGE;                                       // no wall in the model
      if (moduleAxis(cells, w, h, px, py) === 'H') return { by: 'module' };
      if (moduleAt(cells, w, h, px + 1, py, 'H')) return { by: 'module' };
      if (flightCoversWall(cells, w, h, px, py, 'N', above)) return { by: 'flight' };
      return { by: 'run', fam };
    }
    if (py >= fh) return NO_EDGE;
    const fam = familyOf(c.wallW);
    if (!fam) return NO_EDGE;
    if (moduleAxis(cells, w, h, px, py) === 'V') return { by: 'module' };
    if (moduleAt(cells, w, h, px, py + 1, 'V')) return { by: 'module' };
    if (flightCoversWall(cells, w, h, px, py, 'W', above)) return { by: 'flight' };
    return { by: 'run', fam };
  };

  /** The family of an edge THIS PASS lays, or null. Run-laying and corner mitering are unchanged. */
  const edge = (px: number, py: number, dir: 'E' | 'S'): WallFamily | null => {
    const d = edgeDraw(px, py, dir);
    return d.by === 'run' ? d.fam : null;
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
  /**
   * How many wall segments meet at a lattice point — a run that ends where nothing else does is loose
   * and gets a cap rather than a sheared-off face.
   *
   * ASKS THE MODEL, NOT THIS PASS. A wall that continues as a doorway is still a wall meeting here;
   * counting only what the run layer lays makes every doorway look like the end of the world and caps
   * the run into it.
   */
  const armsAt = (px: number, py: number): number => {
    let n = 0;
    if (edgeDraw(px, py, 'E').by !== 'none') n++;
    if (px > 0 && edgeDraw(px - 1, py, 'E').by !== 'none') n++;
    if (edgeDraw(px, py, 'S').by !== 'none') n++;
    if (py > 0 && edgeDraw(px, py - 1, 'S').by !== 'none') n++;
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
export interface GridOptions {
  /**
   * The storey ABOVE, when there is one. Used for ONE thing: breaking a tie between two possible stair
   * directions. A flight climbs into a wall, so the ceiling is its only way out — of two readings of
   * the same walls, the one arriving under a hole is right and the one arriving under solid deck is
   * not. Nothing else consults it, and omitting it costs only that tiebreak.
   */
  above?: readonly (Cell | null)[];
}

export function gridPlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
  floorExtent?: { w: number; h: number },
  opts: GridOptions = {},
): { x: number; y: number; placements: CellPlacement[] }[] {
  const walls = wallEdgePlacements(cells, w, h, floorExtent, opts.above);
  const out: { x: number; y: number; placements: CellPlacement[] }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const placements = cellPlacements(cells, w, h, x, y, floorExtent, opts.above);
      const wp = walls.get(y * w + x);
      if (wp) placements.push(...wp);
      if (placements.length) out.push({ x, y, placements });
    }
  }
  return out;
}
