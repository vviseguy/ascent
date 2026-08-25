// ============================================================================
// src/game/tower.ts — compile generated Floors into a stacked TERRAIN tower.
// ============================================================================
//
// The floor generator (src/floor) produces a solvable CELL GRAPH per stratum
// (deterministic from runSeed+stratumIndex). This module COMPILES that graph into
// the sim's AABB Terrain so the game is a real CLIMBABLE tower (GAPS.md C1/C2):
//
// COMPILATION MODEL (simple, deterministic, readable):
//   - Each stratum occupies a vertical band of height FLOOR_HEIGHT, its floor slab
//     at baseY = groundY + stratumIndex*FLOOR_HEIGHT.
//   - Each CELL becomes a solid platform tile (a thin AABB) at the stratum's floor
//     height, sized CELL_SIZE × CELL_SIZE — EXCEPT the EXIT OPENING: the two cells
//     above the stratum-below's stair are omitted, leaving a hole you ascend
//     through (and a designed interior drop back down onto the stair).
//   - EXIT + STAIRS: each stratum (except the top) gets an Anchor-climbable
//     STRAIGHT STAIRCASE on two adjacent exit-row cells (floor.exits — the top row),
//     shaped to drop the KayKit `stairs` tile onto it. STEPS_TOTAL full-height riser
//     treads (each a solid box from the floor up to its top — no floating geometry)
//     march along +Z (toward the exit edge), rising RISE each, topping out FLUSH with
//     the next stratum's surface directly under the ascent hole. Every rise is 0.5 u
//     (<= the auto step-up window) so the Anchor (jump apex ≈ 0.71 u) walks straight
//     up with the existing smooth step-up — no jump needed, no carry needed (carries
//     become the FAST route once real chasms land, H2). Low guard-rail lips wall the
//     two open run sides so a mid-climb shove isn't a trivial ring-out. Strata
//     alternate stair side (west/east end of the exit row) so consecutive stairs/holes
//     never overlap (needs grid width >= 4; the game uses GAME_GRID_SIZE).
//     The straight run replaced an older switchback (matched no off-the-shelf tile).
//   - A WALK edge between two adjacent cells = flush tiles (walk across). A GAP
//     edge = flush for now (real chasms are a separate backlog item, H2).
//     BREAK/BUTTON/WEIGHT and MISSING edges become a low lip wall between tiles
//     (passable per the fallback layer — anyone can hop it — but slower). Lips
//     touching stair/hole cells are skipped so they never obstruct the climb.
//   - PERIMETER WALLS: a FLOOR_HEIGHT-tall wall ring hugs each stratum's exterior
//     footprint; consecutive rings stack into a continuous shell, so no stratum
//     edge is an accidental drop to the kill-plane (the spec's safe-perimeter
//     invariant). Stairs are interior, so the ring needs no openings.
//   - A deep ground slab sits far below everything as the universal floor; the
//     match KILL-PLANE sits between it and the lowest stratum, reserved for
//     INTERIOR designed drops later (H2 chasms), not the tower's outside.
//
// RENDER-BANDING NOTE (view-only, no code here): the renderer assigns each box to
// a stratum band by its TOP Y (renderer.ts nearestBandBase). Stair treads band
// with their LOWER stratum (they rise from it) except the final flush tread and
// the tallest rail segments, whose tops reach the next surface and band upward —
// acceptable. Wall rings (top = next base) also band upward, which renders the
// shell around your current airspace in the see-through next-floor style: a
// deliberate visibility win, not a bug.
//
// KAYKIT STAIR PLACEMENT (view-only): CompiledTower.stairs[i] exposes the straight
// staircase's geometry so the renderer can scale+drop the KayKit `stairs.glb`
// (native 5.0w × 5.1h × 4.0d, ascending its local +Z): originX/Y/Z (raw Q16.16) is
// the run's BASE corner-ish anchor, dirX/dirZ the unit ascent direction in plan,
// width/run/rise (raw) the box to fit the model to, and treadCount/treadRise the
// step cadence. See StairInfo for the exact contract.
//
// GEOMETRY-LEVEL SOLVABILITY: src/game/route-check.ts independently re-proves on
// the compiled AABBs that an Anchor probe can path entry → top (GAPS.md H3);
// src/game/prove.ts runs it across many seeds plus a real input-driven climb.
//
// All output is plain AABBs (raw Q16.16) — the same Terrain the collision layer
// already proves correct. Pure function of (floors, params): deterministic.
// ============================================================================

import { type Fixed, fromInt, fromFloatConst, fromRaw, toRaw, add, mul, sub } from '../sim/fixed/fixed.ts';
import { type AABB, type Terrain, makeBox } from '../sim/collide/terrain.ts';
import { type Floor, type CellType, cellXY, cellId } from '../floor/types.ts';
import { type WallGrid, buildWallGrid, wallMaskFor } from '../floor/wallgrid.ts';
import { floorTiles } from '../floor/floor-tiles.ts';
import { roomRoleIndex } from '../floor/room-roles.ts';
import { PIECE } from '../floor/tile-place.ts';
import { tileUnits, type FixedBox } from './tile-units.ts';
import type { ApprovedAsset } from './approved-assets.ts';

/**
 * World size of one floor cell (meters) = the KayKit floor tile's NATIVE 4u (render scale 1.0,
 * since the renderer scales pieces by cellSize/4). Each cell is one 9-cell wall TILE; its walls are
 * concrete remastered-pack pieces whose collider boxes are the FROZEN box-fit footprints (docs/16
 * §10 Path A), so the mesh and the hitbox are the same placed pieces — render == collision.
 *
 * INVARIANT this must preserve: the STRAIGHT stair's run length along Z
 * (STEPS_TOTAL*TREAD = 12*0.9 = 10.8 u) must fit inside the stair's Z footprint. The run climbs
 * across ceil(10.8/4.0) = 3 cell rows; at GAME_GRID_SIZE there is ample depth, and the VERTICAL
 * stair math (RISE, FLOOR_HEIGHT, STEPS_TOTAL) is untouched — the Anchor climb (prove:game PROOF
 * 7/8) re-confirms it at 4u. Kept on a 0.5 grid (fromFloatConst, exact in Q16.16) so no float
 * divergence leaks into the sim.
 */
export const CELL_SIZE: Fixed = fromFloatConst(4.0);
/**
 * The square grid size (cells per side) the game compiles every stratum at. The ONE
 * source of truth for the floor footprint — scene.ts (buildTower) and the proofs
 * (game/prove.ts, tower.test.ts) all read this so the whole game stays consistent.
 *
 * Tuned 5 -> 8 -> 30 (docs/14 §1: "scale toward ~30×30 cells/stratum"). 30 cells across
 * spans 30*CELL_SIZE = 135 u (~900 cells/stratum, ~14x the box count of the 8×8 floor),
 * giving crews a real dungeon to explore with large open halls + locked-door puzzles.
 *
 * PERF CEILING (measured, Node 22, 5 strata, ~4 bodies — see the build report):
 *  - per-tick sim.advance ≈ 0.94 ms at 30×30 (8.7k terrain boxes) vs 0.17 ms at 8×8.
 *    The collision broadphase is O(bodies × solids); a real crew (~4–8 bodies, AoI-
 *    bounded) stays well under the 16.7 ms/60fps budget. This is the binding runtime cost.
 *  - one-time scene build at 30×30: generate ≈53 ms, verify ≈7 ms, compile ≈135→~30 ms
 *    (after the O(1) edge-map fix), geometry route-check ≈400 ms (O(n²) in box count;
 *    PROOF-time only, never on the hot path). 30×30 is the honest performant ceiling:
 *    the per-tick budget is fine far beyond it, but the O(n²) build-time route-check is
 *    what gets heavy, so we cap the game grid here and keep the prove sweep lean.
 *
 * INVARIANTS preserved at this size (all independently re-proven by game/prove.ts):
 *  - Solvability: the floor generator + independent verifier pass for every gridSize
 *    >= 2 (src/floor/prove.ts fuzzes 2..30), so a wider grid is still guaranteed-
 *    solvable; the compiled-tower Anchor route (PROOF 7/8) re-confirms it on the AABBs.
 *  - Stairs: stairPairCols needs width >= 4 for the two stair pairs to stay disjoint;
 *    at width 30 they are [0,1] and [28,29]. The straight stair's Z run (STEPS_TOTAL*
 *    TREAD = 10.8 u) climbs toward the +Z exit edge across ~3 of the 30 rows, and the
 *    VERTICAL stair math (RISE 0.5, FLOOR_HEIGHT 6) is untouched — per-tread step valid.
 */
export const GAME_GRID_SIZE = 30;
/** Vertical spacing between strata floors (meters). */
/**
 * ONE STOREY. Measured off the art, not chosen: a `wall` is 4.00 tall and every staircase in the kit
 * climbs exactly 4.00 (8 treads of 0.50 — see `tmp/glb-levels.mjs`; the 5.10 on a bounding box is the
 * banister, not the climb). At 6 the decks floated two units apart and no staircase reached the next
 * one, which is what "the floors are separated way too much" was.
 */
export const FLOOR_HEIGHT: Fixed = fromInt(4);
/** Thickness of a platform slab (meters). */
const SLAB: Fixed = fromFloatConst(0.5);

// ---- stair tuning (authoring constants) -------------------------------------
// A STRAIGHT staircase: STEPS_TOTAL full-height riser treads marching along +Z,
// each rising RISE and TREAD deep. RISE <= MAX_STEP_HEIGHT (0.55) so the auto
// step-up climbs every tread without a jump (the Anchor's 0.71 u jump apex clears
// it too); TREAD >= the route-check's minSide (0.8) so EVERY exposed tread top reads
// as a standable node (the BFS chains base→top through them) AND a body can stand on
// each step. STEPS_TOTAL*TREAD = the run length. If FLOOR_HEIGHT / RISE / TREAD
// change, the route-check proof (prove.ts PROOF 7) + the end-to-end climb (PROOF 8)
// fail loudly. All on a 0.5/0.1 grid → exact in Q16.16, no float divergence.
/** Step tread depth along the run (meters) — >= route-check minSide so each reads standable. */
const TREAD: Fixed = fromFloatConst(0.9);
/** Step rise per tread (meters) — must stay <= MAX_STEP_HEIGHT (auto step-up window). */
const RISE: Fixed = fromFloatConst(0.5);
/** Clear stair width across the run (meters) — spans the 2-cell footprint, two bodies fit. */
const STAIR_W: Fixed = fromFloatConst(3.6);
/** Guard-rail thickness (meters). */
const RAIL_T: Fixed = fromFloatConst(0.15);
/** Guard-rail height above the local tread (meters) — a "low lip". */
const RAIL_H: Fixed = fromFloatConst(0.6);

/** Total steps to climb one stratum (FLOOR_HEIGHT / RISE — exact: 6 / 0.5 = 12). */
const STEPS_TOTAL: number = Math.round(toRaw(FLOOR_HEIGHT) / toRaw(RISE));

/** The three floor-piece urls — SKIPPED in wall placements: the walkable floor is still the
 *  per-cell slab (collision) + the existing per-cell floor mesh (render), so emitting a remastered
 *  floor unit on top would only z-fight and carries no collider anyway (floors are unapproved). The
 *  9-cell tile still DRIVES which cells get walls; only its floor pieces are not lowered here yet. */
const TILE_FLOOR_URLS: ReadonlySet<string> = new Set([PIECE.floorStone, PIECE.floorDirt, PIECE.floorWood]);

/**
 * Lower a floor's 9-cell tiles into the wall IR: one `WorldPlacement` per concrete UNIT (a wall/
 * barrier/pillar piece), carrying its mesh transform + frozen collider boxes + materials (docs/16 §10
 * Path A — the SINGLE wall producer). `floorTiles(floor)` resolves the TileGrid (rooms → templates,
 * corridors → plain floor) with the room rings reconciled against the traversal graph (doorways);
 * `tileUnits(tile)` composes each into placements × frozen footprints. The unit's tile-local (x,z) +
 * box centres are offset by `cellCenter(floor, c)` to world XZ; box Y stays tile-local. Pure +
 * deterministic (Fixed throughout; row-major cell order; no Map/Set iteration on the output path).
 */
function tileWallPlacements(floor: Floor): WorldPlacement[] {
  const out: WorldPlacement[] = [];
  const tiles = floorTiles(floor); // row-major (WallTile|null)[], length width*height
  const y0 = fromInt(0);
  for (let c = 0; c < tiles.length; c++) {
    const tile = tiles[c];
    if (!tile) continue;
    const { x: ccx, z: ccz } = cellCenter(floor, c);
    for (const unit of tileUnits(tile)) {
      if (TILE_FLOOR_URLS.has(unit.url)) continue; // floor piece — kept as the slab + legacy floor mesh
      const boxes: FixedBox[] = unit.boxes.map((b) => ({
        cx: add(ccx, b.cx), cy: b.cy, cz: add(ccz, b.cz),
        hx: b.hx, hy: b.hy, hz: b.hz,
      }));
      out.push({
        x: toRaw(add(ccx, unit.x)), z: toRaw(add(ccz, unit.z)),
        unit: {
          url: unit.url, y: y0, turn: unit.turn, scale: unit.scale, boxes, materials: unit.materials,
          ...(unit.inverted === true ? { inverted: true } : {}),
        },
      });
    }
  }
  return out;
}

export interface TowerParams {
  /** World Y of the bottom of stratum 0's floor slab (raw Fixed). */
  groundY: Fixed;
  /** Kill-plane Y (raw Fixed) — below the lowest stratum, above the deep ground. */
  killPlaneY: Fixed;
}

/**
 * Proof/view metadata for one emitted STRAIGHT staircase (raw Fixed coordinates,
 * Q16.16 — the project convention; convert with fromRaw/toFloat on the render side).
 * NOT sim state — the sim only sees the AABBs; this lets proofs drive a body up the
 * stair and lets the renderer scale+drop the KayKit `stairs.glb` aligned to it.
 *
 * RENDER CONTRACT — to place the model, scale the native KayKit stairs (5.0w × 5.1h
 * × 4.0d, ascending its local +Z from the origin corner) by (width/5.0, rise/5.1,
 * run/4.0), rotate so its local +Z maps to (dirX,dirZ) in plan, and anchor its base
 * corner at (originX, originY, originZ). The run climbs from originZ toward the exit
 * edge; the body emerges through the ascent hole carved in the stratum above.
 */
export interface StairInfo {
  /** Stratum the stair rises FROM (absolute index). */
  stratum: number;
  /** The two exit-row columns the stair occupies (low-Z col, high-Z col are the same row). */
  cols: [number, number];
  /** Plan ascent direction X component (unit; straight stairs run purely in Z so this is 0). */
  dirX: 0;
  /** Plan ascent direction Z component (unit): +1 = ascends toward +Z (the exit edge). */
  dirZ: 1;
  /** World X of the run CENTER (raw) — the stair is symmetric about this across its width. */
  centerX: number;
  /** World Z of the run's LOW (entry) end (raw) — where the climber steps onto tread 0. */
  entryZ: number;
  /** World Z the run TOPS OUT at (raw) — flush under the next stratum's ascent hole. */
  topZ: number;
  /** Stair full width across the run (raw) — the X extent of the tread boxes. */
  width: number;
  /** Run length along Z (raw) = treadCount * treadRise's tread depth = STEPS_TOTAL*TREAD. */
  run: number;
  /** Total rise (raw) = FLOOR_HEIGHT (topY - baseY). */
  rise: number;
  /** Number of treads (= STEPS_TOTAL). */
  treadCount: number;
  /** Rise per tread (raw) = RISE. */
  treadRise: number;
  /** Base corner anchor X (raw) — min X of the tread boxes (centerX - width/2). */
  originX: number;
  /** Base corner anchor Y (raw) — the source stratum's walkable surface (baseY). */
  originY: number;
  /** Base corner anchor Z (raw) — the run's low end (= entryZ). */
  originZ: number;
  /** Walkable surface Y of the source stratum (raw). */
  baseY: number;
  /** Walkable surface Y the stair tops out at — next stratum's base (raw). */
  topY: number;
}

/**
 * One cell of the per-stratum LAYOUT grid the renderer consumes to place tiles (e.g.
 * a KayKit dungeon set). Read-only, deterministic, derived purely from the Floor graph
 * + the same CELL_SIZE the collision boxes use, so a tile dropped at (x,z) lines up
 * exactly with the walkable slab under it. All coords are raw Q16.16 world units (the
 * project convention; convert with fromRaw/toFloat on the render side).
 */
export interface CellTile {
  /** Cell column [0,width) and row [0,height) on the stratum grid. */
  col: number;
  row: number;
  /**
   * Layout role for tile selection: ROOM (open floor) / CORRIDOR (narrow floor) /
   * DOORWAY (opening in a room wall) / WALL (solid block) / VOID (no tile). Mirrors the
   * Floor cell's CellType (defaults to ROOM if the floor predates classification).
   */
  type: CellType;
  /** Room index this cell belongs to (into the stratum's floor.rooms), or -1. */
  roomId: number;
  /** The room's ROLE index (into ROOM_ROLES), or -1 for non-room cells. The renderer dresses the
   *  cell to match this role, so a room's structure (sim) and its objects (render) agree. */
  roomRole: number;
  /** True if this cell's slab tile is OMITTED in collision (the ascent hole). */
  hole: boolean;
  /** True if this cell is part of this stratum's switchback stair footprint. */
  stair: boolean;
  /** World center X of the cell (raw Q16.16). */
  cx: number;
  /** World center Z of the cell (raw Q16.16). */
  cz: number;
  /**
   * Which of the cell's four sides face a non-floor neighbour (a VOID/WALL cell, the
   * grid edge, or a no-edge seam) and therefore want a WALL piece; a DOORWAY/open seam
   * clears the bit. Bit order: 1=+X(east) 2=-X(west) 4=+Z(north) 8=-Z(south). The
   * renderer places a wall segment on each set side and a doorway/arch where it's clear
   * but the cell type is DOORWAY.
   */
  wallMask: number;
  /**
   * WHAT STOPS SIGHT, which is a different question from what stops movement.
   *
   * `wallMask` answers "can I walk this way", so it also sets a bit when the neighbour is not
   * standable — and that is right for movement and wrong for looking. Stand at a balustrade over an
   * open hall and every cell beyond the rail is air: unwalkable, so `wallMask` says walled, so you
   * cannot see across your own room.
   *
   * This one is set only by geometry that actually blocks the eye: a full-height wall. A barrier is
   * waist high and you see over it, an opening you see through, and empty air stops nothing.
   * Absent (the 4u path) means "same as `wallMask`".
   */
  sightMask?: number;
}

/**
 * One wall UNIT placed in the world — the wall IR that BOTH render and collision consume, so they
 * match by construction (no per-target re-derivation). Produced by `tileWallPlacements` (docs/16 §10
 * Path A): one entry per concrete tile piece (a remastered-pack GLB at (x,z) with its FROZEN collider
 * boxes + material recipe). The renderer clones `url` (at turn/scale/y) + applies `materials`;
 * `emitWallsFromSlots` pushes `boxes`. Both read the SAME `unit`, so render == collision holds.
 * Values are TILE-COMPOSED Fixed (no double round-trip through raw): `boxes` are already offset to
 * WORLD XZ by the cell centre, their Y stays tile-local (emit adds baseY; render adds surfaceY).
 */
export interface WorldPlacement {
  /** World X / Z of the unit's mesh anchor (raw Q16.16). */
  x: number;
  z: number;
  /** The concrete tile unit: its mesh placement + collider boxes + material recipe. */
  unit: {
    url: string;
    /** Tile-local vertical offset (Fixed); the floor plane is 0. Render adds sy, collision adds baseY. */
    y: Fixed;
    /** Quarter-turns CCW (0..3) = 0/90/180/270°, the same Y-rotation render + box-fit apply. */
    turn: number;
    /** Uniform scale (Fixed); native 4u cell = 1. */
    scale: Fixed;
    /** Collider boxes, world XZ (cx/cz cell-offset), Y tile-local. Empty if the piece is unapproved. */
    boxes: FixedBox[];
    /** The frozen material recipe the renderer applies (approved-assets), or undefined if unapproved. */
    materials: ApprovedAsset['materials'] | undefined;
    /** Hangs upside down — a half-turn about X. Only ceilings; absent means upright.
     *  A rotation rather than a negative Y scale, so the winding and the normals stay right. */
    inverted?: boolean;
  };
}

/**
 * The full layout grid for ONE stratum — everything the renderer needs to lay tiles:
 * the grid dimensions, the cell world size, the world Y of the walkable surface, and a
 * dense row-major array of per-cell tiles (index = row*width + col, matching the
 * Floor's cellId). Read-only/deterministic.
 */
export interface StratumCellGrid {
  /** Absolute stratum index this grid describes. */
  stratum: number;
  /** Grid columns (x) and rows (z). */
  width: number;
  height: number;
  /** Edge length of one cell in world units (raw Q16.16) — equals CELL_SIZE. */
  cellSize: number;
  /** World Y of this stratum's walkable surface (raw Q16.16) — the slab top. */
  surfaceY: number;
  /** Dense row-major tiles, length width*height, index = row*width + col. */
  cells: CellTile[];
  /**
   * The WALL/EDGE GRID (coordinate-free slot states). Kept ONLY as the source of the per-cell
   * `CellTile.wallMask` (a lossy projection for the renderer's fog BFS + decoration) — the walls
   * themselves now come from the tiles (`wallPlacements`), not this grid. See WallGrid.
   */
  wallGrid: WallGrid;
  /**
   * The wall IR: the floor's 9-cell tiles lowered to concrete units (docs/16 §10 Path A). BOTH render
   * and collision consume THIS (each `WorldPlacement.unit`), so they match by construction. See
   * WorldPlacement.
   */
  wallPlacements: WorldPlacement[];
  /**
   * Does `wallPlacements` already include the GROUND?
   *
   * The 4u compiler leaves floors out and the renderer lays one per cell from the room's role. The 2u
   * one puts them in, because it knows each cell's actual material and can merge four cells into one
   * 4u mesh — so the renderer must not lay its own on top. It was doing exactly that: every floor
   * drawn twice, some eighteen thousand duplicate meshes on a five-storey tower, z-fighting included.
   */
  providesFloors?: boolean;
}

export interface CompiledTower {
  terrain: Terrain;
  /** World base Y (raw Fixed) of each stratum's walkable surface, by index. */
  stratumBaseY: number[];
  /** World (x,z) center of a given stratum's entry cell (raw Fixed) — spawn hint. */
  entryXZ: { x: number; z: number }[];
  /** One stair per non-top stratum (proof/view metadata, raw Fixed coords). */
  stairs: StairInfo[];
  /**
   * OPTIONAL per-stratum LAYOUT GRID for the renderer to place dungeon tiles. Indexed
   * by absolute stratum index (cellGrid[idx]). Additive: existing consumers that only
   * read terrain/stratumBaseY/entryXZ/stairs are unaffected. Always populated by
   * compileTower (so it is effectively always present), but typed optional so older
   * call sites / serialized towers without it still type-check.
   */
  cellGrid?: StratumCellGrid[];
  /**
   * OPTIONAL puzzle-body spawn list (docs/14 §2): the world positions + ids for every
   * locked DOOR, KEY, and RUG the floor generator placed, across all strata. scene.ts
   * spawns a sim body per entry (a solid Door plug / a Key Pickup / a movable Rug). The
   * doorId binds keys to their doors. Additive: a puzzle-free tower has an empty list.
   */
  puzzleSpawns?: PuzzleSpawn[];
}

/**
 * One puzzle body to spawn in the compiled tower (docs/14 §2). World coords are raw
 * Q16.16. The kind selects the body shape/flags scene.ts gives it:
 *  - 'door' : a solid locked-door plug filling a doorway seam (doorId = its lock id).
 *  - 'key'  : a loose Key Pickup body (doorId = the door it opens).
 *  - 'rug'  : a movable Rug body whose hidden key opens `doorId` when revealed.
 */
export interface PuzzleSpawn {
  kind: 'door' | 'key' | 'rug';
  /** Absolute stratum index this body lives on. */
  stratum: number;
  /** World X / Y / Z (raw Q16.16). Y is the body CENTER (rests on / sits in the slab). */
  x: number;
  y: number;
  z: number;
  /** The lock id: a Door requires it, a Key/Rug provides it. */
  doorId: number;
}

/** Center world (x,z) of a floor cell (raw Fixed). Floors are centered on origin. */
function cellCenter(floor: Floor, cell: number): { x: Fixed; z: Fixed } {
  const { x, y } = cellXY(floor.width, cell);
  const cs = CELL_SIZE;
  // center the grid on x; z runs "into" the screen with the row index
  const ox = mul(sub(fromInt(x), fromInt((floor.width - 1) / 2 | 0)), cs);
  const oz = mul(sub(fromInt(y), fromInt((floor.height - 1) / 2 | 0)), cs);
  return { x: ox, z: oz };
}


/**
 * The two adjacent EXIT-ROW columns a stratum's stair occupies. All top-row cells
 * are exits (floor.exits, by generator construction), so any adjacent pair is a
 * valid exit choice; we ALTERNATE ends by stratum parity so consecutive strata's
 * stairs and ceiling holes are disjoint (a stair must never sit over the hole its
 * own ceiling carved — true for width >= 4; the game compiles width 5).
 * Deterministic: same stratum index + width → same pair.
 */
export function stairPairCols(stratumIndex: number, width: number): [number, number] {
  if (width < 2) return [0, 0];
  return stratumIndex % 2 === 0 ? [0, 1] : [width - 2, width - 1];
}

/**
 * The straight stair tops out ONE row IN from the exit (top) row, NOT at the +Z
 * perimeter edge. WHY: a stair that topped out flush against the perimeter wall would
 * emerge into a dead corner — the only stratum-above floor a climber could step onto is
 * the next-stratum slab over the EXIT row (+Z of the top tread), so we reserve that row
 * as the EMERGENCE landing (kept solid in the stratum above) and run the treads through
 * the rows just inside it. The ascent hole (carved in the stratum above) is exactly the
 * run footprint, so the upper treads have headroom; the reserved exit-row slab beyond
 * the top tread is the flush floor the climber strides onto. Deterministic constant.
 */
const STAIR_TOP_ROW_INSET = 1;

/**
 * How many GRID ROWS the straight staircase's Z run occupies. The run is
 * STEPS_TOTAL*TREAD long and ascends in +Z, so it covers ceil(run / CELL_SIZE) rows.
 * Pure integer math on raw Q16.16 (no float) → deterministic & engine-stable.
 */
export function stairRunRows(): number {
  const runRaw = STEPS_TOTAL * toRaw(TREAD);
  const cellRaw = toRaw(CELL_SIZE);
  return Math.max(1, Math.ceil(runRaw / cellRaw));
}

/** The grid row the stair's TOP tread sits in (one in from the exit row). */
function stairTopRow(height: number): number {
  return Math.max(0, height - 1 - STAIR_TOP_ROW_INSET);
}

/**
 * The cell ids the straight staircase's run sits on: its two columns (stairPairCols)
 * across `stairRunRows()` rows ending at stairTopRow (one in from the exit row), going
 * toward -Z. These cells get their seam-lips skipped (so the climb is never obstructed),
 * are flagged `stair` in the renderer's cellGrid, and define the ascent HOLE carved in
 * the stratum above (so the upper treads have headroom). The EXIT row beyond the top
 * tread stays solid as the emergence landing. Membership-test only set (never iterated
 * for output) — determinism-safe.
 */
function stairFootprintCells(stratumIndex: number, width: number, height: number): Set<number> {
  const [c0, c1] = stairPairCols(stratumIndex, width);
  const topRow = stairTopRow(height);
  const rows = Math.min(height, stairRunRows());
  const out = new Set<number>();
  for (let r = 0; r < rows; r++) {
    const row = topRow - r;
    if (row < 0) break;
    out.add(cellId(width, c0, row));
    out.add(cellId(width, c1, row));
  }
  return out;
}

/**
 * Compile a window of strata into one Terrain. `floors[i]` is the floor for stratum
 * `startIndex + i`. Deterministic pure function. Assumes all floors in the window
 * share one grid size (the generator is always invoked with a single gridSize), so
 * a hole carved in stratum N+1's slab lands exactly over stratum N's stair.
 */
export function compileTower(
  floors: readonly Floor[],
  startIndex: number,
  params: TowerParams,
): CompiledTower {
  const solids: AABB[] = [];
  const stratumBaseY: number[] = [];
  const entryXZ: { x: number; z: number }[] = [];
  const stairs: StairInfo[] = [];
  const cellGrid: StratumCellGrid[] = [];
  const puzzleSpawns: PuzzleSpawn[] = [];
  const half = mul(CELL_SIZE, fromFloatConst(0.5));

  for (let s = 0; s < floors.length; s++) {
    const floor = floors[s]!;
    const idx = startIndex + s;
    const baseY = add(params.groundY, mul(FLOOR_HEIGHT, fromInt(idx)));
    stratumBaseY[idx] = toRaw(baseY);

    // --- exit-opening + stair bookkeeping for THIS stratum ---
    // holeCells: the FULL run footprint of the stratum BELOW's straight stair — omit
    // those slab tiles so the climber ascends an OPEN stairwell shaft (the lower treads
    // would otherwise be pinched under this stratum's slab ceiling) and there is a
    // designed drop back down. stairCells: THIS stratum's own straight-stair run
    // footprint (2 cols × stairRunRows). skipLipCells: the union, so seam-lips never
    // obstruct the climb. Strata alternate stair columns, so a hole over the stratum-
    // below stair never overlaps THIS stratum's stair (width >= 4). Sets are
    // membership-test only (never iterated for output) — determinism-safe.
    const holeCells = s >= 1
      ? stairFootprintCells(idx - 1, floor.width, floor.height)
      : new Set<number>();
    const hasStair = s < floors.length - 1;
    const stairCells = hasStair
      ? stairFootprintCells(idx, floor.width, floor.height)
      : new Set<number>();
    // --- the LAYOUT grid + Layer-C wall/edge slots for THIS stratum (built FIRST: it is now
    //     the single source of truth the collision below AND the renderer both consume) ---
    const grid = buildCellGrid(floor, idx, baseY, holeCells, stairCells);
    cellGrid[idx] = grid;

    // a solid slab tile under every cell (the walkable floor of this stratum),
    // EXCEPT the exit opening above the stratum-below's stair.
    for (let c = 0; c < floor.cells.length; c++) {
      if (holeCells.has(c)) continue; // the ascent hole (and a designed drop)
      const { x, z } = cellCenter(floor, c);
      solids.push(makeBox(
        sub(x, half), sub(baseY, SLAB), sub(z, half),
        add(x, half), baseY, add(z, half),
      ));
    }

    // --- WALL colliders from the tile units (collision == the rendered mesh, docs/16 §10 Path A):
    //     each unit's frozen box-fit footprint becomes an AABB, seated on this stratum's baseY. The
    //     map border resolves to the PERIMETER wall (the resolver's safe shell), and doorways were
    //     reconciled open against the traversal graph so the climb is never obstructed. ---
    emitWallsFromSlots(solids, grid, baseY);

    // --- the stair up to the next stratum ---
    if (hasStair) stairs.push(emitStair(solids, floor, idx, baseY, half));

    const ec = cellCenter(floor, floor.entry);
    entryXZ[idx] = { x: toRaw(ec.x), z: toRaw(ec.z) };

    // --- puzzle bodies (locked doors / keys / rugs) for scene.ts to spawn ---
    emitPuzzleSpawns(puzzleSpawns, floor, idx, baseY);
  }

  // deep ground slab far below (universal floor) — wide enough to span the tower. Scale
  // with the grid footprint (grid*CELL_SIZE) so a wide stratum still sits fully over it;
  // the old fixed ±60u no longer covered the 30×30 floor (135u across).
  const gridW = floors[0]?.width ?? GAME_GRID_SIZE;
  const span = add(mul(CELL_SIZE, fromInt(gridW)), fromInt(20)); // floor span + margin
  const deep = sub(params.killPlaneY, fromInt(4));
  solids.push(makeBox(sub(fromInt(0), span), sub(deep, fromInt(2)), sub(fromInt(0), span), span, deep, span));

  // groundY for the Terrain is the DEEP floor (so motion's ground clamp matches it
  // and bodies in a seam fall past the kill-plane). Strata slabs are solids above it.
  return { terrain: { groundY: toRaw(deep), solids }, stratumBaseY, entryXZ, stairs, cellGrid, puzzleSpawns };
}

/**
 * Build the read-only LAYOUT grid for one stratum: the floor cells + the wall IR (the floor's 9-cell
 * tiles lowered to concrete units). Pure function of the Floor graph + CELL_SIZE, so a wall placed at
 * (x,z) lands exactly on the slab the sim collides against.
 *
 *   - `wallGrid`       : the slot lattice (src/floor/wallgrid.ts), derived once from the floor + the
 *                        climb's open cells (hole ∪ stair seams stay OPEN). Kept ONLY for the
 *                        `wallMask` projection below (the fog BFS); the walls come from the tiles.
 *   - `wallMask`       : per cell, a lossy projection of the slots, kept for the renderer's fog
 *                        BFS + decoration.
 *   - `wallPlacements` : the floor's tiles lowered to concrete units (`tileWallPlacements`) — the
 *                        SINGLE wall producer both the renderer and the collision compiler consume
 *                        (render == collision by construction; docs/16 §10 Path A).
 */
function buildCellGrid(
  floor: Floor,
  idx: number,
  baseY: Fixed,
  holeCells: ReadonlySet<number>,
  stairCells: ReadonlySet<number>,
): StratumCellGrid {
  const surfaceY = toRaw(baseY);
  const W = floor.width;
  const H = floor.height;

  // the climb's footprints must read as OPEN on every interior seam (no walls block the
  // stairwell / ascent hole) — exactly the old skip-lip-on-stair/hole rule, unified.
  const openCells = new Set<number>([...holeCells, ...stairCells]);
  const wallGrid = buildWallGrid(floor, { openCells });

  // cellType (defaulting ROOM for legacy floors) → walkable FLOOR cell? (for wallMask projection)
  const isFloor = (col: number, row: number): boolean => {
    if (col < 0 || col >= W || row < 0 || row >= H) return false;
    const t = floor.cells[cellId(W, col, row)]!.cellType ?? 'ROOM';
    return t !== 'VOID' && t !== 'WALL';
  };

  const cells: CellTile[] = [];
  for (let c = 0; c < floor.cells.length; c++) {
    const fc = floor.cells[c]!;
    const { x: cx, z: cz } = cellCenter(floor, c);
    const type: CellType = fc.cellType ?? 'ROOM';
    const rid = fc.roomId ?? -1;
    cells.push({
      col: fc.x,
      row: fc.y,
      type,
      roomId: rid,
      roomRole: rid >= 0 ? roomRoleIndex(rid, BigInt(floor.meta.runSeed)) : -1,
      hole: holeCells.has(c),
      stair: stairCells.has(c),
      cx: toRaw(cx),
      cz: toRaw(cz),
      wallMask: wallMaskFor(wallGrid, fc.x, fc.y, isFloor, openCells),
    });
  }

  // --- the wall IR: the floor's 9-cell tiles lowered to concrete units (docs/16 §10 Path A — the
  //     SINGLE producer). BOTH render and collision read each `WorldPlacement.unit`, so they match by
  //     construction. Doorways were reconciled against the traversal graph inside `floorTiles`. ---
  const wallPlacements: WorldPlacement[] = tileWallPlacements(floor);

  return {
    stratum: idx,
    width: W,
    height: H,
    cellSize: toRaw(CELL_SIZE),
    surfaceY,
    cells,
    wallGrid,
    wallPlacements,
  };
}

/**
 * Emit one STRAIGHT staircase on stratum `idx`'s exit-row pair, rising from `baseY`
 * to baseY+FLOOR_HEIGHT along +Z. STEPS_TOTAL full-height RISER treads (each a solid
 * box from the floor up to its top — sturdy, no floating geometry) march from the
 * interior toward the +Z exit edge, topping out FLUSH under the 2-cell ascent hole.
 * Plus two low guard-rail lips on the run's open X sides (a mid-climb shove is not a
 * trivial ring-out, but the lip is short enough to hop back over).
 *
 * GEOMETRY (mirrors the proven climb in collide/prove.ts PROOF 5c, oriented in +Z):
 * tread k (k = 0..STEPS_TOTAL-1) is a box spanning the run from its riser at
 * entryZ + k*TREAD all the way to the top edge (topZ), at height baseY → riseAt(k+1).
 * Each higher tread is taller and overlays the lower ones, so tread k's EXPOSED top is
 * the strip [entryZ + k*TREAD, entryZ + (k+1)*TREAD] (depth TREAD = 0.9 >= the
 * route-check minSide, so every tread reads as a standable node) at height riseAt(k+1).
 * The auto step-up (MAX_STEP_HEIGHT 0.55 >= RISE 0.5) walks a body straight up — the
 * Anchor never needs to jump. The top tread is flush with the next stratum's surface.
 */
function emitStair(
  solids: AABB[],
  floor: Floor,
  idx: number,
  baseY: Fixed,
  half: Fixed,
): StairInfo {
  const [c0, c1] = stairPairCols(idx, floor.width);
  const topRow = stairTopRow(floor.height); // tops out one row IN from the exit edge
  // the stair is centered in X on the 2-cell column pair, running purely in +Z.
  const cellC0 = cellCenter(floor, cellId(floor.width, c0, topRow));
  const cellC1 = cellCenter(floor, cellId(floor.width, c1, topRow));
  const centerX = mul(add(cellC0.x, cellC1.x), fromFloatConst(0.5));
  const halfW = mul(STAIR_W, fromFloatConst(0.5));
  const minX = sub(centerX, halfW);
  const maxX = add(centerX, halfW);

  // run along +Z: tops out flush at the top tread row's +Z edge (under the hole, with
  // the reserved EXIT-row slab just beyond as the emergence landing); extends RUN =
  // STEPS_TOTAL*TREAD toward -Z (into the floor) from there.
  const topZ = add(cellC0.z, half); // the top-tread row's outer (+Z) boundary
  const runLen = mul(fromInt(STEPS_TOTAL), TREAD);
  const entryZ = sub(topZ, runLen); // the run's low (entry) end

  // height of tread k's TOP above the world (the FINAL tread lands exactly on FLOOR_HEIGHT)
  const riseAt = (k: number): Fixed =>
    k >= STEPS_TOTAL ? add(baseY, FLOOR_HEIGHT) : add(baseY, mul(fromInt(k), RISE));
  // z of the riser face for tread k (k treads' worth of depth up from the entry end)
  const zAt = (k: number): Fixed => add(entryZ, mul(fromInt(k), TREAD));

  // STEPS_TOTAL riser treads: tread k spans [zAt(k), topZ] across the full width, at
  // height baseY → riseAt(k+1). Higher (taller) treads overlay lower ones; tread k's
  // exposed top is the [zAt(k), zAt(k+1)] strip — TREAD deep, standable.
  for (let k = 0; k < STEPS_TOTAL; k++) {
    solids.push(makeBox(minX, baseY, zAt(k), maxX, riseAt(k + 1), topZ));
  }

  // two low guard-rail lips along the run's open X sides (RAIL_H above the local
  // tread). They follow the stair's rising profile in 2-step segments so the lip
  // top stays ~RAIL_H over the tread beside it. Short enough to hop, tall enough to
  // catch a slide. The +Z (top) end is open to the next floor through the hole.
  for (let k0 = 0; k0 < STEPS_TOTAL; k0 += 2) {
    const kHi = Math.min(k0 + 1, STEPS_TOTAL - 1);
    const z0 = zAt(k0);
    const z1 = zAt(kHi + 1);
    const railTop = add(riseAt(kHi + 1), RAIL_H);
    solids.push(makeBox(sub(minX, RAIL_T), baseY, z0, minX, railTop, z1)); // -X rail
    solids.push(makeBox(maxX, baseY, z0, add(maxX, RAIL_T), railTop, z1)); // +X rail
  }

  return {
    stratum: idx,
    cols: [c0, c1],
    dirX: 0,
    dirZ: 1,
    centerX: toRaw(centerX),
    entryZ: toRaw(entryZ),
    topZ: toRaw(topZ),
    width: toRaw(STAIR_W),
    run: toRaw(runLen),
    rise: toRaw(FLOOR_HEIGHT),
    treadCount: STEPS_TOTAL,
    treadRise: toRaw(RISE),
    originX: toRaw(minX),
    originY: toRaw(baseY),
    originZ: toRaw(entryZ),
    baseY: toRaw(baseY),
    topY: toRaw(add(baseY, FLOOR_HEIGHT)),
  };
}

/**
 * Emit one stratum's WALL collision AABBs from the wall IR (grid.wallPlacements) — the SAME tile units
 * the renderer draws, so collision == masonry by construction (docs/16 §10 Path A). Each unit carries
 * its FROZEN box-fit footprint already transformed to world XZ (cell-offset) with tile-local Y; we add
 * `baseY` to seat each box on this stratum. A unit with no approved footprint contributes no box (it
 * still renders). All coords raw Q16.16 → exact, deterministic; no Map/Set iteration on the output.
 */
function emitWallsFromSlots(solids: AABB[], grid: StratumCellGrid, baseY: Fixed): void {
  for (const wp of grid.wallPlacements) {
    for (const b of wp.unit.boxes) {
      solids.push(makeBox(
        sub(b.cx, b.hx), add(baseY, sub(b.cy, b.hy)), sub(b.cz, b.hz),
        add(b.cx, b.hx), add(baseY, add(b.cy, b.hy)), add(b.cz, b.hz),
      ));
    }
  }
}

/**
 * Convert a stratum's placed PUZZLE data (floor.lockedDoors / floor.keys) into world
 * spawn entries for scene.ts (docs/14 §2). Pure + deterministic — reads the floor graph
 * and the same CELL_SIZE the slabs use, so a spawned body lines up with its cell.
 *  - DOOR: at the MIDPOINT of its edge's two cell centers (the seam it gates), centered
 *    just above the slab so the body plugs the doorway.
 *  - KEY : at its cell center, resting a little above the slab (a pickup the player grabs).
 *  - RUG : at its cell center, on the slab (a movable prop hiding the key).
 * Y is the body CENTER; scene.ts uses the body's halfHeight to seat it. Iterates the
 * stable lockedDoors/keys arrays in order (no Map/Set iteration) → deterministic.
 */
function emitPuzzleSpawns(out: PuzzleSpawn[], floor: Floor, idx: number, baseY: Fixed): void {
  const doors = floor.lockedDoors ?? [];
  const keys = floor.keys ?? [];
  // door body half-height (a low plug filling the doorway gap) + key/rug seat offsets.
  const DOOR_HALF = fromFloatConst(1.0); // ~waist-high plug; tall enough to block, hashed via the body
  const ITEM_SEAT = fromFloatConst(0.4); // key/rug rest a touch above the slab
  for (const d of doors) {
    const ca = cellCenter(floor, d.a);
    const cb = cellCenter(floor, d.b);
    const mx = mul(add(ca.x, cb.x), fromFloatConst(0.5));
    const mz = mul(add(ca.z, cb.z), fromFloatConst(0.5));
    out.push({
      kind: 'door', stratum: idx,
      x: toRaw(mx), y: toRaw(add(baseY, DOOR_HALF)), z: toRaw(mz),
      doorId: d.doorId,
    });
  }
  for (const key of keys) {
    const c = cellCenter(floor, key.cell);
    out.push({
      kind: key.source === 'RUG' ? 'rug' : 'key', stratum: idx,
      x: toRaw(c.x), y: toRaw(add(baseY, ITEM_SEAT)), z: toRaw(c.z),
      doorId: key.doorId,
    });
  }
}
