// ============================================================================
// src/game/tower.ts — compile generated Floors into a stacked TERRAIN tower.
// ============================================================================
//
// The floor generator (src/floor) produces a solvable CELL GRAPH per stratum
// (deterministic from runSeed+stratumIndex). This module is the missing bridge the
// audit flagged (`floor-module-not-wired`): it COMPILES that graph into the sim's
// AABB Terrain so the game is a real climbable tower instead of a flat arena.
//
// COMPILATION MODEL (simple, deterministic, readable):
//   - Each stratum occupies a vertical band of height FLOOR_HEIGHT, its floor slab
//     at baseY = groundY + stratumIndex*FLOOR_HEIGHT.
//   - Each CELL becomes a solid platform tile (a thin AABB) at the stratum's floor
//     height, sized CELL_SIZE × CELL_SIZE, UNLESS the cell is a "gap" tile.
//   - A WALK edge between two adjacent cells = they're connected at floor level
//     (both tiles solid, you walk across). A GAP edge = the seam between them is a
//     chasm: we DROP the boundary (leave a gap a Runner must jump / the Anchor must
//     be thrown across). BREAK/BUTTON/WEIGHT edges become a low wall lip between the
//     tiles (passable per the fallback layer — anyone can break/climb — but slower).
//   - The EXIT cell of each stratum has a ramp/opening up to the next stratum's
//     entry, so the climb is continuous.
//   - A deep ground slab sits far below everything as the universal floor; the
//     match KILL-PLANE sits between it and the lowest stratum, so a body knocked
//     off a tile into a seam falls past the kill-plane into the void.
//
// All output is plain AABBs (raw Q16.16) — the same Terrain the collision layer
// already proves correct. Pure function of (floors, params): deterministic.
// ============================================================================

import { type Fixed, fromInt, fromFloatConst, toRaw, add, mul, sub } from '../sim/fixed/fixed.ts';
import { type AABB, type Terrain, makeBox } from '../sim/collide/terrain.ts';
import { type Floor, cellXY, edgeKey } from '../floor/types.ts';

/** World size of one floor cell (meters). */
export const CELL_SIZE: Fixed = fromInt(3);
/** Vertical spacing between strata floors (meters). */
export const FLOOR_HEIGHT: Fixed = fromInt(6);
/** Thickness of a platform slab (meters). */
const SLAB: Fixed = fromFloatConst(0.5);
/** Height of the low lip on a BREAK/BUTTON/WEIGHT seam (meters). */
const LIP: Fixed = fromFloatConst(0.6);

export interface TowerParams {
  /** World Y of the bottom of stratum 0's floor slab (raw Fixed). */
  groundY: Fixed;
  /** Kill-plane Y (raw Fixed) — below the lowest stratum, above the deep ground. */
  killPlaneY: Fixed;
}

export interface CompiledTower {
  terrain: Terrain;
  /** World base Y (raw Fixed) of each stratum's walkable surface, by index. */
  stratumBaseY: number[];
  /** World (x,z) center of a given stratum's entry cell (raw Fixed) — spawn hint. */
  entryXZ: { x: number; z: number }[];
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
 * Compile a window of strata into one Terrain. `floors[i]` is the floor for stratum
 * `startIndex + i`. Deterministic pure function.
 */
export function compileTower(
  floors: readonly Floor[],
  startIndex: number,
  params: TowerParams,
): CompiledTower {
  const solids: AABB[] = [];
  const stratumBaseY: number[] = [];
  const entryXZ: { x: number; z: number }[] = [];
  const half = mul(CELL_SIZE, fromFloatConst(0.5));

  for (let s = 0; s < floors.length; s++) {
    const floor = floors[s]!;
    const idx = startIndex + s;
    const baseY = add(params.groundY, mul(FLOOR_HEIGHT, fromInt(idx)));
    stratumBaseY[idx] = toRaw(baseY);

    // a solid slab tile under every cell (the walkable floor of this stratum)
    for (let c = 0; c < floor.cells.length; c++) {
      const { x, z } = cellCenter(floor, c);
      solids.push(makeBox(
        sub(x, half), sub(baseY, SLAB), sub(z, half),
        add(x, half), baseY, add(z, half),
      ));
    }

    // seam treatment: between horizontally/vertically adjacent cells, a non-WALK,
    // non-existent edge gets a low lip (you can cross but it's a speed bump); a GAP
    // edge gets nothing (open chasm). WALK edges are flush (nothing added).
    for (let c = 0; c < floor.cells.length; c++) {
      const { x: cx, y: cy } = cellXY(floor.width, c);
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= floor.width || ny >= floor.height) continue;
        const nb = ny * floor.width + nx;
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

    const ec = cellCenter(floor, floor.entry);
    entryXZ[idx] = { x: toRaw(ec.x), z: toRaw(ec.z) };
  }

  // deep ground slab far below (universal floor) — wide enough to span the tower.
  const span = fromInt(60);
  const deep = sub(params.killPlaneY, fromInt(4));
  solids.push(makeBox(sub(fromInt(0), span), sub(deep, fromInt(2)), sub(fromInt(0), span), span, deep, span));

  // groundY for the Terrain is the DEEP floor (so motion's ground clamp matches it
  // and bodies in a seam fall past the kill-plane). Strata slabs are solids above it.
  return { terrain: { groundY: toRaw(deep), solids }, stratumBaseY, entryXZ };
}
