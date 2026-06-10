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
//     SWITCHBACK STAIR on two adjacent exit-row cells (floor.exits — the top row).
//     Two 1.6 u-wide lanes: an outer flight (vs the perimeter wall) of
//     STEPS_PER_FLIGHT treads rising RISE each, a full-width turn landing, then an
//     inner flight back, topping out FLUSH with the next stratum's surface. Every
//     rise is 0.5 u so the Anchor (jump apex ≈ 0.71 u) can hop each step solo —
//     the climb verb exists without ever needing a carry (carries become the FAST
//     route once real chasms land, H2). Guard rails (RAIL_H lips, full-height
//     boxes) wall the open sides so a mid-climb shove isn't a trivial ring-out.
//     Strata alternate stair side (west/east end of the exit row) so consecutive
//     stairs/holes never overlap (needs grid width >= 4; the game uses 5).
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
// GEOMETRY-LEVEL SOLVABILITY: src/game/route-check.ts independently re-proves on
// the compiled AABBs that an Anchor probe can path entry → top (GAPS.md H3);
// src/game/prove.ts runs it across many seeds plus a real input-driven climb.
//
// All output is plain AABBs (raw Q16.16) — the same Terrain the collision layer
// already proves correct. Pure function of (floors, params): deterministic.
// ============================================================================

import { type Fixed, fromInt, fromFloatConst, toRaw, add, mul, sub } from '../sim/fixed/fixed.ts';
import { type AABB, type Terrain, makeBox } from '../sim/collide/terrain.ts';
import { type Floor, cellXY, cellId, edgeKey } from '../floor/types.ts';

/** World size of one floor cell (meters). */
export const CELL_SIZE: Fixed = fromInt(3);
/** Vertical spacing between strata floors (meters). */
export const FLOOR_HEIGHT: Fixed = fromInt(6);
/** Thickness of a platform slab (meters). */
const SLAB: Fixed = fromFloatConst(0.5);
/** Height of the low lip on a BREAK/BUTTON/WEIGHT seam (meters). */
const LIP: Fixed = fromFloatConst(0.6);
/** Perimeter wall thickness (meters) — sits OUTSIDE the cell footprint. */
const WALL_T: Fixed = fromFloatConst(0.4);

// ---- stair tuning (authoring constants) -------------------------------------
// RISE <= 0.5 so the Anchor's 0.71 u jump apex clears each step with margin;
// TREAD >= 0.9 so a body can stand on every step; LANE_W >= 1.6 so two bodies /
// a carry pair fit a lane. The 6+6 switchback fits a 2-cell (6 u) footprint:
// 6 treads * 0.9 + 0.6 landing = 6.0 u exactly. If FLOOR_HEIGHT / CELL_SIZE /
// RISE change, the route-check proof (prove.ts PROOF 7) fails loudly.
/** Step tread depth along the run (meters). */
const TREAD: Fixed = fromFloatConst(0.9);
/** Step rise per tread (meters) — must stay under the Anchor's jump apex. */
const RISE: Fixed = fromFloatConst(0.5);
/** Clear stair lane width (meters) — two bodies / a carry fit. */
const LANE_W: Fixed = fromFloatConst(1.6);
/** Guard-rail thickness (meters). */
const RAIL_T: Fixed = fromFloatConst(0.15);
/** Guard-rail height above the local tread (meters) — a "low lip". */
const RAIL_H: Fixed = fromFloatConst(0.6);
/** Turn-landing depth along the run (meters). */
const LANDING: Fixed = fromFloatConst(0.6);

/** Total steps to climb one stratum (FLOOR_HEIGHT / RISE — exact: 6 / 0.5 = 12). */
const STEPS_TOTAL: number = Math.round(toRaw(FLOOR_HEIGHT) / toRaw(RISE));
/** Steps in the outer (first) flight; the inner flight takes the rest. */
const STEPS_A: number = STEPS_TOTAL >> 1;
const STEPS_B: number = STEPS_TOTAL - STEPS_A;

export interface TowerParams {
  /** World Y of the bottom of stratum 0's floor slab (raw Fixed). */
  groundY: Fixed;
  /** Kill-plane Y (raw Fixed) — below the lowest stratum, above the deep ground. */
  killPlaneY: Fixed;
}

/**
 * Proof/view metadata for one emitted stair (raw Fixed coordinates). NOT sim
 * state — the sim only sees the AABBs; this lets proofs drive a body up the
 * stair and lets a future renderer highlight the route.
 */
export interface StairInfo {
  /** Stratum the stair rises FROM (absolute index). */
  stratum: number;
  /** The two exit-row columns the stair occupies (run start col, far col). */
  cols: [number, number];
  /** Run direction along X: +1 = ascending toward +X, -1 = toward -X. */
  dirX: 1 | -1;
  /** X of the stair's OPEN end (where you enter flight A / step off flight B). */
  openX: number;
  /** Z center of the outer lane (flight A, against the perimeter wall). */
  laneAZ: number;
  /** Z center of the inner lane (flight B). */
  laneBZ: number;
  /** X center of the turn landing (the closed end). */
  landingX: number;
  /** Walkable surface Y of the source stratum. */
  baseY: number;
  /** Walkable surface Y the stair tops out at (next stratum's base). */
  topY: number;
}

export interface CompiledTower {
  terrain: Terrain;
  /** World base Y (raw Fixed) of each stratum's walkable surface, by index. */
  stratumBaseY: number[];
  /** World (x,z) center of a given stratum's entry cell (raw Fixed) — spawn hint. */
  entryXZ: { x: number; z: number }[];
  /** One stair per non-top stratum (proof/view metadata, raw Fixed coords). */
  stairs: StairInfo[];
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

/** Does an edge between two adjacent cells exist with a WALK (open) connection? */
function edgeKindBetween(floor: Floor, a: number, b: number): string | null {
  const key = edgeKey(a, b);
  for (const e of floor.edges) {
    if (edgeKey(e.a, e.b) === key) return e.kind;
  }
  return null;
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
  const half = mul(CELL_SIZE, fromFloatConst(0.5));

  for (let s = 0; s < floors.length; s++) {
    const floor = floors[s]!;
    const idx = startIndex + s;
    const baseY = add(params.groundY, mul(FLOOR_HEIGHT, fromInt(idx)));
    stratumBaseY[idx] = toRaw(baseY);

    // --- exit-opening + stair bookkeeping for THIS stratum ---
    // holeCells: exit cells of the stratum BELOW (its stair tops out here) — omit
    // their slab tiles. stairCells: this stratum's own stair footprint. Sets are
    // used for membership tests only (never iterated) — determinism-safe.
    const topRow = floor.height - 1;
    const skipLipCells = new Set<number>();
    const holeCells = new Set<number>();
    if (s >= 1) {
      const [h0, h1] = stairPairCols(idx - 1, floor.width);
      holeCells.add(cellId(floor.width, h0, topRow));
      holeCells.add(cellId(floor.width, h1, topRow));
      skipLipCells.add(cellId(floor.width, h0, topRow));
      skipLipCells.add(cellId(floor.width, h1, topRow));
    }
    const hasStair = s < floors.length - 1;
    if (hasStair) {
      const [c0, c1] = stairPairCols(idx, floor.width);
      skipLipCells.add(cellId(floor.width, c0, topRow));
      skipLipCells.add(cellId(floor.width, c1, topRow));
    }

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

    // seam treatment: between horizontally/vertically adjacent cells, a non-WALK,
    // non-existent edge gets a low lip (you can cross but it's a speed bump); a GAP
    // edge gets nothing (open chasm — flattened for now, see H2). WALK edges are
    // flush. Lips touching stair/hole cells are skipped (never obstruct the climb).
    for (let c = 0; c < floor.cells.length; c++) {
      const { x: cx, y: cy } = cellXY(floor.width, c);
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= floor.width || ny >= floor.height) continue;
        const nb = ny * floor.width + nx;
        if (skipLipCells.has(c) || skipLipCells.has(nb)) continue;
        const kind = edgeKindBetween(floor, c, nb);
        if (kind === 'WALK' || kind === 'GAP') continue; // flush or open chasm
        // no edge OR a break/button/weight gate → a low lip wall on the seam
        const a = cellCenter(floor, c);
        const b = cellCenter(floor, nb);
        const mx = mul(add(a.x, b.x), fromFloatConst(0.5));
        const mz = mul(add(a.z, b.z), fromFloatConst(0.5));
        const t = fromFloatConst(0.2);
        solids.push(makeBox(
          sub(mx, dx ? t : half), baseY, sub(mz, dy ? t : half),
          add(mx, dx ? t : half), add(baseY, LIP), add(mz, dy ? t : half),
        ));
      }
    }

    // --- the stair up to the next stratum ---
    if (hasStair) stairs.push(emitStair(solids, floor, idx, baseY, half));

    // --- perimeter wall ring (full band height; rings stack into a shell) ---
    emitWallRing(solids, floor, baseY, half);

    const ec = cellCenter(floor, floor.entry);
    entryXZ[idx] = { x: toRaw(ec.x), z: toRaw(ec.z) };
  }

  // deep ground slab far below (universal floor) — wide enough to span the tower.
  const span = fromInt(60);
  const deep = sub(params.killPlaneY, fromInt(4));
  solids.push(makeBox(sub(fromInt(0), span), sub(deep, fromInt(2)), sub(fromInt(0), span), span, deep, span));

  // groundY for the Terrain is the DEEP floor (so motion's ground clamp matches it
  // and bodies in a seam fall past the kill-plane). Strata slabs are solids above it.
  return { terrain: { groundY: toRaw(deep), solids }, stratumBaseY, entryXZ, stairs };
}

/**
 * Emit one switchback stair on stratum `idx`'s exit-row pair, rising from `baseY`
 * to baseY+FLOOR_HEIGHT. ~20 boxes: STEPS_A outer treads, a turn landing, STEPS_B
 * inner treads (all full-height from the floor — sturdy, no floating geometry),
 * plus guard rails. The outer lane runs against the perimeter wall (one side
 * guarded for free); the inner flight gets rails on both open sides EXCEPT the
 * two treads nearest the landing on the lane boundary — that opening is the
 * turn itself (see the rail comment below).
 */
function emitStair(
  solids: AABB[],
  floor: Floor,
  idx: number,
  baseY: Fixed,
  half: Fixed,
): StairInfo {
  const [c0, c1] = stairPairCols(idx, floor.width);
  const topRow = floor.height - 1;
  const westPair = c0 === 0; // run toward the west wall, open end on the east side
  const dir: 1 | -1 = westPair ? -1 : 1;
  // open end = the pair's inboard-column edge facing the grid center
  const openCol = westPair ? c1 : c0;
  const openCenter = cellCenter(floor, cellId(floor.width, openCol, topRow));
  const openX = westPair ? add(openCenter.x, half) : sub(openCenter.x, half);
  // x at distance u (>= 0) from the open end, along the run
  const uX = (u: Fixed): Fixed => (dir > 0 ? add(openX, u) : sub(openX, u));

  // lanes hang off the exit row's OUTER boundary (max z — the perimeter side)
  const zOuter = add(openCenter.z, half);
  const zA0 = sub(zOuter, LANE_W); // outer lane: [zA0, zOuter]
  const zM0 = sub(zA0, RAIL_T); // mid rail: [zM0, zA0]
  const zB0 = sub(zM0, LANE_W); // inner lane: [zB0, zM0]
  const zR0 = sub(zB0, RAIL_T); // inboard rail: [zR0, zB0]

  // rise k steps above the base; the FINAL step lands exactly on FLOOR_HEIGHT
  const riseAt = (k: number): Fixed =>
    k >= STEPS_TOTAL ? add(baseY, FLOOR_HEIGHT) : add(baseY, mul(fromInt(k), RISE));
  const uAt = (steps: number): Fixed => mul(fromInt(steps), TREAD);

  // flight A (outer lane): treads i = 0..STEPS_A-1, ascending away from the open end
  for (let i = 0; i < STEPS_A; i++) {
    solids.push(makeBox(uX(uAt(i)), baseY, zA0, uX(uAt(i + 1)), riseAt(i + 1), zOuter));
  }
  // turn landing (both lanes wide, at flight A's top height)
  const landU0 = uAt(STEPS_A);
  const landU1 = add(landU0, LANDING);
  solids.push(makeBox(uX(landU0), baseY, zB0, uX(landU1), riseAt(STEPS_A), zOuter));
  // flight B (inner lane): treads j = 0..STEPS_B-1, ascending back toward the open end
  for (let j = 0; j < STEPS_B; j++) {
    solids.push(makeBox(
      uX(sub(landU0, uAt(j + 1))), baseY, zB0,
      uX(sub(landU0, uAt(j))), riseAt(STEPS_A + 1 + j), zM0,
    ));
  }

  // guard rails: full-height boxes 0.6 above the covered treads, in 2-step
  // segments. (Flight A needs none: perimeter wall outside, flight B's solid
  // mass inside.) The INBOARD side of flight B + the landing is railed along its
  // whole length; the BETWEEN-LANES side skips the two treads nearest the
  // landing — that gap IS the turn: you hop from flight A's top tread (or the
  // landing) sideways onto flight B's first tread (a 0.5 u rise). A rail there
  // would pinch the turn corridor below a body diameter (radius 0.55 + rail/wall
  // inflation), which the end-to-end climb proof caught on the first cut.
  for (let k0 = 0; k0 < STEPS_B; k0 += 2) {
    const jHi = Math.min(k0 + 1, STEPS_B - 1);
    const u0 = uX(sub(landU0, uAt(jHi + 1)));
    const u1 = uX(sub(landU0, uAt(k0)));
    const railTop = add(riseAt(STEPS_A + 1 + jHi), RAIL_H);
    if (k0 >= 2) solids.push(makeBox(u0, baseY, zM0, u1, railTop, zA0)); // between lanes
    solids.push(makeBox(u0, baseY, zR0, u1, railTop, zB0)); // inboard side
  }
  // landing inboard rail
  solids.push(makeBox(uX(landU0), baseY, zR0, uX(landU1), add(riseAt(STEPS_A), RAIL_H), zB0));

  const c08 = fromFloatConst(0.8);
  const c03 = fromFloatConst(0.3);
  return {
    stratum: idx,
    cols: westPair ? [c1, c0] : [c0, c1], // [open-end col, far col]
    dirX: dir,
    openX: toRaw(openX),
    laneAZ: toRaw(sub(zOuter, c08)),
    laneBZ: toRaw(sub(zM0, c08)),
    landingX: toRaw(uX(add(landU0, c03))),
    baseY: toRaw(baseY),
    topY: toRaw(add(baseY, FLOOR_HEIGHT)),
  };
}

/**
 * Emit the perimeter wall ring for one stratum: four FLOOR_HEIGHT-tall boxes just
 * OUTSIDE the cell footprint (no playable area lost). Consecutive strata's rings
 * stack flush (top of ring N = base of ring N+1), forming a gap-free shell.
 */
function emitWallRing(solids: AABB[], floor: Floor, baseY: Fixed, half: Fixed): void {
  const lo = cellCenter(floor, 0); // cell (0, 0)
  const hi = cellCenter(floor, floor.cells.length - 1); // cell (W-1, H-1)
  const minX = sub(lo.x, half);
  const maxX = add(hi.x, half);
  const minZ = sub(lo.z, half);
  const maxZ = add(hi.z, half);
  const top = add(baseY, FLOOR_HEIGHT);
  const oMinX = sub(minX, WALL_T);
  const oMaxX = add(maxX, WALL_T);
  const oMinZ = sub(minZ, WALL_T);
  const oMaxZ = add(maxZ, WALL_T);
  solids.push(makeBox(oMinX, baseY, oMinZ, minX, top, oMaxZ)); // west
  solids.push(makeBox(maxX, baseY, oMinZ, oMaxX, top, oMaxZ)); // east
  solids.push(makeBox(minX, baseY, oMinZ, maxX, top, minZ)); // south
  solids.push(makeBox(minX, baseY, maxZ, maxX, top, oMaxZ)); // north
}
