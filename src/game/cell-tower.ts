// ============================================================================
// src/game/cell-tower.ts — compile a tower from 2u CELL floors.
// ============================================================================
//
// The 2u substrate has had meshes, an editor and proofs for a while, and the game still drew the 4u
// path, so none of it was visible in play. This is the bridge.
//
// IT DOES NOT REPLACE `compileTower`; it is a second producer of the same IR. The seam both of them
// meet at is `StratumCellGrid.wallPlacements` — a flat list of `WorldPlacement`, which the renderer
// draws and the collision compiler turns into AABBs. Produce that from a 2u grid and render and
// collision follow for free, still matching by construction because they read the same list.
//
// WHAT IS DIFFERENT FROM THE 4u COMPILER, and why:
//
//   CELL SIZE   2.0, not 4.0. Everything world-space scales off `CELL_SIZE_2U`, and a `CellPlacement`
//               offset is in HALF-CELL units (±1 is a cell edge), so it converts by CELL/2 — the same
//               conversion `cell-preview` uses on the render side.
//
//   STAIRS      REAL ones. The 4u compiler synthesises a straight staircase at a fixed column pair,
//               because the 4u floor graph has no notion of an authored stair. Here a flight is a
//               block of `stairs` cells that an author drew, found by `stairFlight`, and its collider
//               is a stack of steps built to the same 8×0.50 rise the mesh has. A floor with no flight
//               has NO WAY UP and says so rather than being papered over with a synthetic one — the
//               generator guarantees a stairwell starts on every storey below the top.
//
//               THE ART'S STAIRCASES ARE 45 DEGREES (4.00 up over a 4.00 run), so their treads are
//               0.5 deep and `ANCHOR_PROBE.minSide` of 0.8 rejects them. `CELL_PROBE` is the same
//               probe told the right tread size; see the note on it.
//
//   METADATA    `roomId`/`roomRole` are -1 and there are no puzzle spawns. Those are 4u `Floor`
//               concepts (rooms, roles, locked doors) with no equivalent here yet; the renderer reads
//               them as "undressed", which is honest. `wallMask` IS produced, from the 2u walls
//               directly — more accurate than the 4u projection it replaces, since the walls are right
//               there rather than inferred from a slot lattice.

import { type Fixed, add, fromInt, fromFloatConst, mul, sub, toRaw } from '../sim/fixed/fixed.ts';
import { type AABB, makeBox } from '../sim/collide/terrain.ts';
import { blocks, type Cell } from '../floor/cell.ts';
import { gridPlacements, stairFlight, type CellPlacement, type StairFlight } from '../floor/cell-place.ts';
import { objIdOf, transformBox, type FixedBox } from './tile-units.ts';
import { getApproved } from './approved-assets.ts';
import {
  FLOOR_HEIGHT, type CellTile, type CompiledTower, type StairInfo, type StratumCellGrid,
  type TowerParams, type WorldPlacement,
} from './tower.ts';

/** Edge length of one 2u cell in world units. Half the 4u tile, which is the whole point. */
export const CELL_SIZE_2U: Fixed = fromInt(2);
/** Thickness of the walkable slab under a cell. */
const SLAB: Fixed = fromFloatConst(0.5);
/** A `CellPlacement` offset of 1 is one HALF-cell, so it converts to world by this. */
const HALF_CELL: Fixed = fromFloatConst(1);
/** Treads in one flight — the meshes are built with eight of 0.50, which is one 4.00 storey. */
const STAIR_STEPS = 8;

/** One storey of a 2u tower: the resolved cells plus where you come in. */
export interface CellFloor {
  cells: readonly (Cell | null)[];
  width: number;
  height: number;
  /** Cell index of the entry, and of the exit if the floor has one. */
  entry: number;
  exit: number;
}

/** World centre of a cell, with the grid centred on the origin the way the 4u one is. */
export function cellCentre2u(w: number, h: number, index: number): { x: Fixed; z: Fixed } {
  const col = index % w, row = Math.floor(index / w);
  return {
    x: mul(sub(fromInt(col), fromInt((w - 1) / 2 | 0)), CELL_SIZE_2U),
    z: mul(sub(fromInt(row), fromInt((h - 1) / 2 | 0)), CELL_SIZE_2U),
  };
}

/** Ground you can stand on. `none` is a hole and `rock` is solid fill; neither is a floor. */
const walkable = (c: Cell | null): boolean => c !== null && c.floor !== 'none' && c.floor !== 'rock';

/** Floor meshes render but do not collide — the slab under them already does, and two colliders in
 *  the same place is how a player ends up standing half a unit too high. */
const isGroundPiece = (url: string): boolean => url.includes('floor_') || url.includes('stairs');

/**
 * The 2u grid lowered to the wall IR: one `WorldPlacement` per mesh, carrying its transform, its
 * frozen collider boxes and its material recipe. The SINGLE producer for this substrate, exactly as
 * `tileWallPlacements` is for the 4u one.
 */
export function cellWorldPlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
): WorldPlacement[] {
  const out: WorldPlacement[] = [];
  for (const { x, y, placements } of gridPlacements(cells, w, h)) {
    const { x: ccx, z: ccz } = cellCentre2u(w, h, y * w + x);
    for (const p of placements) {
      // a cell-local offset is in half-cells; the box transform wants tile-local world units
      const local: CellPlacement = { ...p, x: mul(p.x, HALF_CELL), z: mul(p.z, HALF_CELL) };
      const a = getApproved(objIdOf(p.url));
      const boxes: FixedBox[] = isGroundPiece(p.url)
        ? []
        : (a?.footprint.boxes ?? [])
          .map((b) => transformBox(b, { url: local.url, x: local.x, z: local.z, turn: local.turn, scale: local.scale }))
          .map((b) => ({ ...b, cx: add(ccx, b.cx), cz: add(ccz, b.cz) }));
      out.push({
        x: toRaw(add(ccx, local.x)), z: toRaw(add(ccz, local.z)),
        unit: { url: p.url, y: p.y, turn: p.turn, scale: p.scale, boxes, materials: a?.materials },
      });
    }
  }
  return out;
}

/**
 * The four sides of a cell that face something you cannot walk through — the renderer's fog BFS and
 * decoration read this. Bit order matches the 4u `wallMask`: 1 = N, 2 = E, 4 = S, 8 = W.
 *
 * Read STRAIGHT off the 2u walls rather than projected from a slot lattice, so it agrees with what is
 * actually drawn instead of approximating it.
 */
export function wallMask2u(cells: readonly (Cell | null)[], w: number, h: number, index: number): number {
  const col = index % w, row = Math.floor(index / w);
  const at = (cx: number, cy: number): Cell | null =>
    cx < 0 || cy < 0 || cx >= w || cy >= h ? null : cells[cy * w + cx] ?? null;
  const me = at(col, row);
  if (!me) return 15;
  const south = at(col, row + 1), east = at(col + 1, row);
  let m = 0;
  if (blocks(me.wallN) || !walkable(at(col, row - 1))) m |= 1;
  if ((east && blocks(east.wallW)) || !walkable(east)) m |= 2;
  if ((south && blocks(south.wallN)) || !walkable(south)) m |= 4;
  if (blocks(me.wallW) || !walkable(at(col - 1, row))) m |= 8;
  return m;
}

/**
 * The collider for one authored flight: a stack of STEPS rather than a ramp, matching the mesh's own
 * eight treads of 0.50 so a body's feet land where the art says they should.
 */
function emitFlightSolids(solids: AABB[], f: StairFlight, w: number, h: number, baseY: Fixed): void {
  const rise = mul(FLOOR_HEIGHT, fromFloatConst(1 / STAIR_STEPS));
  const c0 = cellCentre2u(w, h, f.y * w + f.x);
  const half = mul(CELL_SIZE_2U, fromFloatConst(0.5));
  const x0 = sub(c0.x, half), z0 = sub(c0.z, half);
  const x1 = add(x0, mul(CELL_SIZE_2U, fromInt(f.bw)));
  const z1 = add(z0, mul(CELL_SIZE_2U, fromInt(f.bh)));

  const vertical = f.up === 'N' || f.up === 'S';
  const runLo = vertical ? z0 : x0, runHi = vertical ? z1 : x1;
  const step = mul(sub(runHi, runLo), fromFloatConst(1 / STAIR_STEPS));

  for (let k = 0; k < STAIR_STEPS; k++) {
    // step k is one slice of the run, standing (k+1) rises tall; the slices count from whichever end
    // is the BOTTOM, which is the opposite end from `up`
    const fromHigh = f.up === 'N' || f.up === 'W';
    const i = fromHigh ? STAIR_STEPS - 1 - k : k;
    const lo = add(runLo, mul(step, fromInt(i)));
    const hi = add(lo, step);
    const top = add(baseY, mul(rise, fromInt(k + 1)));
    solids.push(vertical ? makeBox(x0, baseY, lo, x1, top, hi) : makeBox(lo, baseY, z0, hi, top, z1));
  }
}

/**
 * `StairInfo` for the route proof — but ONLY for a flight that climbs toward +Z.
 *
 * The type describes a straight stair running purely in Z (`dirX: 0`, `dirZ: 1`), which is all the 4u
 * compiler ever produced because it synthesised them. An authored flight can climb any of four ways,
 * and rather than widen a type the proofs depend on, a flight that does not fit simply contributes no
 * metadata. Its COLLIDERS are emitted either way, so the stair is real and climbable regardless —
 * only the proof's convenience record is missing.
 */
function flightInfo(f: StairFlight, w: number, h: number, idx: number, baseY: Fixed): StairInfo | null {
  if (f.up !== 'S') return null; // +Z is south in this grid; anything else the type cannot describe
  const c0 = cellCentre2u(w, h, f.y * w + f.x);
  const half = mul(CELL_SIZE_2U, fromFloatConst(0.5));
  const x0 = sub(c0.x, half), z0 = sub(c0.z, half);
  const x1 = add(x0, mul(CELL_SIZE_2U, fromInt(f.bw)));
  const z1 = add(z0, mul(CELL_SIZE_2U, fromInt(f.bh)));
  const centerX = mul(add(x0, x1), fromFloatConst(0.5));
  const width = mul(CELL_SIZE_2U, fromInt(f.bw));
  const run = sub(z1, z0);
  return {
    stratum: idx,
    cols: [f.x, f.x + f.bw - 1],
    dirX: 0, dirZ: 1,
    centerX: toRaw(centerX),
    entryZ: toRaw(z0), topZ: toRaw(z1),
    width: toRaw(width), run: toRaw(run),
    rise: toRaw(FLOOR_HEIGHT),
    treadCount: STAIR_STEPS,
    treadRise: toRaw(mul(FLOOR_HEIGHT, fromFloatConst(1 / STAIR_STEPS))),
    originX: toRaw(sub(centerX, mul(width, fromFloatConst(0.5)))),
    originY: toRaw(baseY), originZ: toRaw(z0),
    baseY: toRaw(baseY), topY: toRaw(add(baseY, FLOOR_HEIGHT)),
  };
}

export interface CellTowerResult extends CompiledTower {
  /** Storeys that have no flight, so no way up. Empty once every floor carries a stairwell — which is
   *  what multi-storey structures are for. See the note at the top of this file. */
  strataWithoutStairs: number[];
  /** Flights that climb into a floored-over ceiling. A shaft is AUTHORED (a cell with no floor), so
   *  this is empty exactly when every stairwell's storey above has been drawn open. */
  ceilingSealedFlights: { stratum: number; x: number; y: number; cells: number }[];
}

export function compileCellTower(
  floors: readonly CellFloor[],
  startIndex: number,
  params: TowerParams,
): CellTowerResult {
  const solids: AABB[] = [];
  const stratumBaseY: number[] = [];
  const entryXZ: { x: number; z: number }[] = [];
  const stairs: StairInfo[] = [];
  const cellGrid: StratumCellGrid[] = [];
  const strataWithoutStairs: number[] = [];
  const ceilingSealedFlights: CellTowerResult['ceilingSealedFlights'] = [];
  const half = mul(CELL_SIZE_2U, fromFloatConst(0.5));

  for (let s = 0; s < floors.length; s++) {
    const f = floors[s]!;
    const idx = startIndex + s;
    const baseY = add(params.groundY, mul(FLOOR_HEIGHT, fromInt(idx)));
    stratumBaseY[idx] = toRaw(baseY);

    const flights: StairFlight[] = [];
    for (let i = 0; i < f.cells.length; i++) {
      const fl = stairFlight(f.cells, f.width, f.height, i % f.width, Math.floor(i / f.width));
      if (fl) flights.push(fl);
    }

    /* THE SHAFT IS AUTHORED, NOT INFERRED. A cell with no floor is a hole, and a hole above a flight
       is the shaft you climb through — so the schematic says where shafts are, exactly as it says
       where walls are. The 4u compiler has to compute `holeCells` from its synthetic stair because
       its floor graph cannot express a hole; this one does not, and inferring them here would
       override an author who deliberately floored over something.

       The consequence is honest rather than convenient: until a structure spans storeys and paints
       its own shaft, a flight climbs into a ceiling. `ceilingSealedFlights` below reports exactly
       that instead of quietly punching a hole to hide it. */

    // a slab under every walkable cell, minus the shafts
    const cells: CellTile[] = [];
    for (let i = 0; i < f.cells.length; i++) {
      const c = f.cells[i] ?? null;
      const { x, z } = cellCentre2u(f.width, f.height, i);
      const hole = !walkable(c);              // no floor here — the author said so
      if (!hole) {
        solids.push(makeBox(sub(x, half), sub(baseY, SLAB), sub(z, half), add(x, half), baseY, add(z, half)));
      }
      cells.push({
        col: i % f.width, row: Math.floor(i / f.width),
        type: c === null || c.floor === 'none' ? 'VOID' : c.floor === 'rock' ? 'WALL' : 'ROOM',
        roomId: -1, roomRole: -1,
        hole,
        stair: flights.some((fl) => {
          const cx = i % f.width, cy = Math.floor(i / f.width);
          return cx >= fl.x && cx < fl.x + fl.bw && cy >= fl.y && cy < fl.y + fl.bh;
        }),
        cx: toRaw(x), cz: toRaw(z),
        wallMask: wallMask2u(f.cells, f.width, f.height, i),
      });
    }

    const wallPlacements = cellWorldPlacements(f.cells, f.width, f.height);
    const grid: StratumCellGrid = {
      stratum: idx, width: f.width, height: f.height,
      cellSize: toRaw(CELL_SIZE_2U), surfaceY: toRaw(baseY),
      cells,
      // the slot lattice has no meaning here — `wallMask` is read straight off the 2u walls above,
      // which is what it was ever used for
      wallGrid: { width: f.width, height: f.height, vEdges: [], hEdges: [], posts: [] } as unknown as StratumCellGrid['wallGrid'],
      wallPlacements,
    };
    cellGrid[idx] = grid;

    for (const wp of wallPlacements) {
      for (const b of wp.unit.boxes) {
        solids.push(makeBox(
          sub(b.cx, b.hx), add(baseY, sub(b.cy, b.hy)), sub(b.cz, b.hz),
          add(b.cx, b.hx), add(baseY, add(b.cy, b.hy)), add(b.cz, b.hz),
        ));
      }
    }

    // every flight is a real collider; the proof record is a bonus where the shape allows it
    for (const fl of flights) emitFlightSolids(solids, fl, f.width, f.height, baseY);
    /* A flight whose ceiling is floored over goes nowhere. Counted per stratum so "the tower is not
       climbable" is a number you can read rather than something you discover by walking into it. */
    if (s + 1 < floors.length) {
      const above = floors[s + 1]!;
      for (const fl of flights) {
        let sealed = 0;
        for (let j = 0; j < fl.bh; j++) {
          for (let k = 0; k < fl.bw; k++) {
            if (walkable(above.cells[(fl.y + j) * above.width + (fl.x + k)] ?? null)) sealed++;
          }
        }
        if (sealed > 0) ceilingSealedFlights.push({ stratum: idx, x: fl.x, y: fl.y, cells: sealed });
      }
    }

    const isTop = s === floors.length - 1;
    if (!isTop) {
      if (flights.length === 0) strataWithoutStairs.push(idx);
      for (const fl of flights) {
        const info = flightInfo(fl, f.width, f.height, idx, baseY);
        if (info) { stairs.push(info); break; }
      }
    }

    const ec = cellCentre2u(f.width, f.height, f.entry);
    entryXZ[idx] = { x: toRaw(ec.x), z: toRaw(ec.z) };
  }

  // the deep ground, wide enough to span the footprint
  const gridW = floors[0]?.width ?? 60;
  const span = add(mul(CELL_SIZE_2U, fromInt(gridW)), fromInt(20));
  const deep = sub(params.killPlaneY, fromInt(4));
  solids.push(makeBox(sub(fromInt(0), span), sub(deep, fromInt(2)), sub(fromInt(0), span), span, deep, span));

  return {
    terrain: { groundY: toRaw(deep), solids },
    stratumBaseY, entryXZ, stairs, cellGrid, puzzleSpawns: [],
    strataWithoutStairs, ceilingSealedFlights,
  };
}
