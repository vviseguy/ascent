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
import { blocks, isStairFloor, seesThrough, type Cell, type Dir } from '../floor/cell.ts';
import { gridPlacements, moduleAt, stairFlight, FLOOR_URL, PIECE, type CellPlacement, type StairFlight } from '../floor/cell-place.ts';
import { objIdOf, transformBox, FOOTPRINT_SCALE_NUM, type FixedBox } from './tile-units.ts';
import { getApproved, type ApprovedBox } from './approved-assets.ts';
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

const Z: Fixed = fromInt(0);
const ONE: Fixed = fromInt(1);
/* THE ground mesh table is imported, not restated. This was a second copy with its own hand-written
   key type, and it went stale the moment a material was appended: `grate` existed in the model, in the
   editor and in `cell-place`, and the 4u merge here still believed there were three. A copy of a table
   is a table that can disagree. */

/** Floor meshes render but do not collide — the slab under them already does, and two colliders in
 *  the same place is how a player ends up standing half a unit too high. */
const isGroundPiece = (url: string): boolean => url.includes('floor_') || url.includes('stairs');

/**
 * The 2u grid lowered to the wall IR: one `WorldPlacement` per mesh, carrying its transform, its
 * frozen collider boxes and its material recipe. The SINGLE producer for this substrate, exactly as
 * `tileWallPlacements` is for the 4u one.
 */
/**
 * A MEASURED FALLBACK FOOTPRINT, for a wall mesh nobody has box-fit yet.
 *
 * Collision comes only from `getApproved(...)?.footprint.boxes`, so a mesh with no approval renders
 * with nothing to walk into. That is survivable for ground (the slab collides) and for dressing (a
 * torch should not block), and it is a bug for anything wall-shaped: the piece is visibly there and
 * you pass straight through it. Eleven wall types became drawable before any of them had a footprint.
 *
 * THE DEPTH IS 0.50, NOT THE BOUNDING BOX'S 1.00. Every straight wall in the kit measures 1.00 deep
 * only because its plinth (below y 0.35) and cornice (above y 3.45) flare out; the body a player walks
 * into is 0.50 (z +/- 0.25). Using the bbox would double every wall's thickness at body height.
 *
 * An approval always wins — this is the floor under the feature, not a replacement for box-fitting.
 */
const WALL_FALLBACK: Record<string, { w: number; d: number; h: number; gap?: number }> = {
  // `gap` = a clear aperture through the middle, so the piece collides as two JAMBS rather than a slab.
  // Measured: wall_doorway is 2.00 clear of its 4.00, wall_open_scaffold 3.40 clear.
  wall_doorway: { w: 4, d: 0.5, h: 4, gap: 2.0 },
  wall_doorway_scaffold: { w: 4, d: 0.5, h: 4, gap: 2.0 },
  wall_open_scaffold: { w: 4, d: 0.5, h: 4, gap: 3.4 },
  wall: { w: 4, d: 0.5, h: 4 },
  wall_half: { w: 2, d: 0.5, h: 4 },
  wall_half_endcap: { w: 2, d: 0.5, h: 4 },
  /* NO ENTRY FOR `wall_endcap`, and that is the point. A cap is a 1.07 flourish pushed PAST the end
     of the wall it finishes — the model says the wall stops at the lattice point, and the cap sticks
     out beyond it into the next cell. Giving it collision made the map narrower than the model
     describes: it stands in the MIDDLE of a cell rather than on a seam, so `route-check`'s seam test
     cannot see it, the route walked straight through it, and the Anchor wedged on the third waypoint.
     Collision follows what the walls ASSERT; decoration that overhangs is drawn and not collided. */
  wall_cracked: { w: 4, d: 0.5, h: 4 },
  wall_scaffold: { w: 4, d: 0.5, h: 4 },
  wall_shelves: { w: 4, d: 0.5, h: 4 },
  wall_pillar: { w: 4, d: 0.5, h: 4 },
  wall_window_closed: { w: 4, d: 0.5, h: 4 },
  wall_window_open: { w: 4, d: 0.5, h: 4 },        // a window is see-through, not walk-through
  wall_archedwindow_open: { w: 4, d: 0.5, h: 4 },
  wall_archedwindow_gated: { w: 4, d: 0.5, h: 4 },
  wall_gated: { w: 4, d: 0.5, h: 4 },
  wall_arched: { w: 4, d: 0.5, h: 4 },             // measured SOLID: a blind arch, 0.10 web and no hole
  wall_broken: { w: 4, d: 0.5, h: 4 },             // breach pinches to 0.10 — nothing fits through
  pillar: { w: 1.5, d: 1.5, h: 4 },
  column: { w: 0.7, d: 0.7, h: 1.4 },
  barrier: { w: 4, d: 0.5, h: 1.1 },
  barrier_half: { w: 2, d: 0.5, h: 1.1 },
  barrier_column: { w: 4, d: 0.7, h: 1.4 },
};

/** The bare mesh name behind a url, fragment and extension stripped. */
const meshNameOf = (url: string): string =>
  (url.split('/').pop() ?? '').replace(/#.*$/, '').replace(/\.gltf\.glb$/i, '').replace(/\.glb$/i, '');

export function cellWorldPlacements(
  cells: readonly (Cell | null)[], w: number, h: number,
  above?: readonly (Cell | null)[],
): WorldPlacement[] {
  const out: WorldPlacement[] = [];
  let fallbacks = 0;   // pieces collided from the measured table because nothing has box-fit them

  /* GROUND IS DRAWN IN 4u BLOCKS WHERE IT CAN BE.
     A floor mesh is natively 4u and the 2u path draws it at half scale, once per cell — four draws
     where one would do. At the game's size that is 18,000 of 26,000 meshes, and it was the difference
     between a tower that loads and one you wait most of a minute for.
     Only where all four cells of an ALIGNED block share a material: a block spanning two materials, a
     hole or a staircase still draws per cell, so nothing is merged that would change what you see. */
  const merged = new Uint8Array(w * h);
  const groundOf = (cx: number, cy: number): keyof typeof FLOOR_URL | null => {
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    const c = cells[cy * w + cx];
    if (!c || c.floor === 'none' || c.floor === 'rock' || isStairFloor(c.floor)) return null;
    return c.floor;
  };
  for (let by = 0; by + 1 < h; by += 2) {
    for (let bx = 0; bx + 1 < w; bx += 2) {
      const m = groundOf(bx, by);
      if (!m) continue;
      if (groundOf(bx + 1, by) !== m || groundOf(bx, by + 1) !== m || groundOf(bx + 1, by + 1) !== m) continue;
      const c0 = cellCentre2u(w, h, by * w + bx);
      out.push({
        // the block's centre is one world unit south-east of its first cell's centre
        x: toRaw(add(c0.x, HALF_CELL)), z: toRaw(add(c0.z, HALF_CELL)),
        unit: { url: FLOOR_URL[m], y: Z, turn: 0, scale: ONE, boxes: [], materials: getApproved(objIdOf(FLOOR_URL[m]))?.materials },
      });
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) merged[(by + dy) * w + (bx + dx)] = 1;
    }
  }

  for (const { x, y, placements } of gridPlacements(cells, w, h, undefined, above ? { above } : {})) {
    const { x: ccx, z: ccz } = cellCentre2u(w, h, y * w + x);
    for (const p of placements) {
      if (merged[y * w + x] === 1 && isGroundPiece(p.url)) continue; // drawn by its 4u block
      // a cell-local offset is in half-cells; the box transform wants tile-local world units
      const local: CellPlacement = { ...p, x: mul(p.x, HALF_CELL), z: mul(p.z, HALF_CELL) };
      const a = getApproved(objIdOf(p.url));
      const approved = a?.footprint.boxes ?? [];
      const fb = approved.length === 0 ? WALL_FALLBACK[meshNameOf(p.url)] : undefined;
      if (fb) fallbacks++;
      /* The table is in WORLD units, but `transformBox` doubles every footprint (the lab box-fits at
         the pack's 0.5 display scale). Undo that here rather than pre-halving the table, so the
         numbers above stay the ones you can measure off the mesh. */
      const k = FOOTPRINT_SCALE_NUM;
      const jamb = fb?.gap ? (fb.w - fb.gap) / 2 : 0;
      const raw: ApprovedBox[] = approved.length > 0 ? approved
        : !fb ? []
          : jamb > 0
            // two jambs, so you can walk through the middle of a doorway but not through its sides
            ? [-1, 1].map((sgn) => ({
              cx: (sgn * (fb.gap! + jamb) / 2) / k, cy: fb.h / 2 / k, cz: 0,
              hx: (jamb / 2) / k, hy: fb.h / 2 / k, hz: fb.d / 2 / k,
            }))
            : [{
              cx: 0, cy: fb.h / 2 / k, cz: 0,
              hx: fb.w / 2 / k, hy: fb.h / 2 / k, hz: fb.d / 2 / k,
            }];
      const boxes: FixedBox[] = isGroundPiece(p.url)
        ? []
        : raw
          .map((b) => transformBox(b, { url: local.url, x: local.x, z: local.z, turn: local.turn, scale: local.scale }))
          .map((b) => ({ ...b, cx: add(ccx, b.cx), cz: add(ccz, b.cz) }));
      out.push({
        x: toRaw(add(ccx, local.x)), z: toRaw(add(ccz, local.z)),
        unit: {
          url: p.url, y: p.y, turn: p.turn, scale: p.scale, boxes, materials: a?.materials,
          ...(p.inverted === true ? { inverted: true } : {}),
        },
      });
    }
  }
  if (fallbacks > 0) {
    // Not a warning — the fallback is doing its job. But an unapproved wall is an APPROXIMATE wall,
    // and that should be a number someone can see rather than something the build quietly absorbs.
    lastFallbackCount = fallbacks;
  }
  return out;
}

/** How many pieces the LAST `cellWorldPlacements` call collided from the fallback table. */
export let lastFallbackCount = 0;


/**
 * The four sides of a cell that face something you cannot walk through — the renderer's fog BFS and
 * decoration read this.
 *
 * BIT ORDER IS THE CANONICAL ONE (`floor/wallgrid.ts`): 1 = +X east, 2 = -X west, 4 = +Z south,
 * 8 = -Z north. It did not used to be. The comment here claimed it matched and it did not — only bit 4
 * agreed, so the fog flood was gated by the NORTH wall when moving east, the EAST wall moving west and
 * the WEST wall moving north. It leaked through solid walls and left cells permanently unrevealed
 * (measured: 67 cells and 9 wall pieces across 4 towers x 5 storeys). A comment asserting agreement is
 * exactly what let it drift; `cell-tower.test.ts` asserts it now.
 *
 * Read STRAIGHT off the 2u walls rather than projected from a slot lattice, so it agrees with what is
 * actually drawn instead of approximating it.
 */
/**
 * WHAT STOPS SIGHT at this cell — see `CellTile.sightMask` for why this is not `wallMask`.
 *
 * Only a full-height wall blocks. Deliberately NOT here:
 *   - the walkability term, so looking out over a balcony or a shaft sees what is beyond;
 *   - barriers, which are waist high (`blocks` already says so);
 *   - openings, which you can see through even though the segments either side are walls.
 *
 * Bits match `wallMask`: 1=+X 2=-X 4=+Z 8=-Z.
 */
export function sightMask2u(cells: readonly (Cell | null)[], w: number, h: number, index: number): number {
  const col = index % w, row = Math.floor(index / w);
  const at = (cx: number, cy: number): Cell | null =>
    cx < 0 || cy < 0 || cx >= w || cy >= h ? null : cells[cy * w + cx] ?? null;
  const me = at(col, row);
  if (!me) return 0;                     // off the map stops nothing; the caller bounds the trace
  const south = at(col, row + 1), east = at(col + 1, row);

  /* A module is centred on a POINT and covers the two collinear edges either side of it, so an edge is
     seen through if a see-through module sits at either of its endpoints. Same geometry `cell-place`
     uses to decide which wall segments a module replaces — but gated on `seesThrough`, not on
     passability: a closed door stops the eye and a portcullis does not, and neither of those is the
     same as whether you can walk through. */
  const clear = (px: number, py: number, axis: 'H' | 'V'): boolean => {
    const c = at(px, py);
    return !!c && seesThrough(c.wallType, c.open) && moduleAt(cells, w, h, px, py, axis);
  };
  const seeThroughH = (px: number, py: number): boolean => clear(px, py, 'H') || clear(px + 1, py, 'H');
  const seeThroughV = (px: number, py: number): boolean => clear(px, py, 'V') || clear(px, py + 1, 'V');

  let m = 0;
  if (east && blocks(east.wallW) && !seeThroughV(col + 1, row)) m |= 1;   // +X  east
  if (blocks(me.wallW) && !seeThroughV(col, row)) m |= 2;                 // -X  west
  if (south && blocks(south.wallN) && !seeThroughH(col, row + 1)) m |= 4; // +Z  south
  if (blocks(me.wallN) && !seeThroughH(col, row)) m |= 8;                 // -Z  north
  return m;
}

export function wallMask2u(cells: readonly (Cell | null)[], w: number, h: number, index: number): number {
  const col = index % w, row = Math.floor(index / w);
  const at = (cx: number, cy: number): Cell | null =>
    cx < 0 || cy < 0 || cx >= w || cy >= h ? null : cells[cy * w + cx] ?? null;
  const me = at(col, row);
  if (!me) return 15;
  const south = at(col, row + 1), east = at(col + 1, row);
  let m = 0;
  if ((east && blocks(east.wallW)) || !walkable(east)) m |= 1;          // +X  east
  if (blocks(me.wallW) || !walkable(at(col - 1, row))) m |= 2;          // -X  west
  if ((south && blocks(south.wallN)) || !walkable(south)) m |= 4;       // +Z  south
  if (blocks(me.wallN) || !walkable(at(col, row - 1))) m |= 8;          // -Z  north
  return m;
}

/**
 * THE SIDES A STAIR MESH CARRIES, measured off the GLBs (`tmp/glb-rails.mjs`).
 *
 * A staircase is not just treads. Every variant in the kit carries something down at least one flank —
 * a full wall on the handed pair, banisters on the open ones, solid sides on the walled one — and NONE
 * of it collided. `emitFlightSolids` laid eight tread boxes and stopped, so a body could walk sideways
 * straight through a 5.10-tall wall it could see, and off the edge of every banistered flight.
 *
 * Worse than an ordinary missing collider, because a walled flight's sides are deliberately NOT drawn
 * by the cells either — the mesh carries them, which is what `walls` is for and what the "a walled
 * flight carries its own sides" test pins. So nothing anywhere put a solid there.
 *
 *   stairs / stairs_wide / stairs_wood   rails BOTH flanks, 0.75 wide, up to 5.10
 *   stairs_wall_left / _right            a WALL on ONE flank, 0.90 wide, up to 5.10; other flank OPEN
 *   stairs_walled                        solid sides BOTH flanks, 1.00 wide, tread height only
 *
 * `walls` already says which flanks the mesh dresses, so it is the only input: the open flank of a
 * handed mesh is genuinely open — you step off it onto the landing — and must stay that way.
 */
const SIDE_THICKNESS = fromFloatConst(0.75);

/** Which flanks of a flight carry something solid, from the mesh it resolved to. */
function dressedFlanks(walls: StairFlight['walls']): { left: boolean; right: boolean } {
  // -1 = wall on the left only, 1 = right only; 2 = solid both; 0 = banisters, which are still solid
  return walls === -1 ? { left: true, right: false }
    : walls === 1 ? { left: false, right: true }
      : { left: true, right: true };
}

/**
 * The collider for one authored flight: a stack of STEPS rather than a ramp, matching the mesh's own
 * eight treads of 0.50 so a body's feet land where the art says they should — PLUS whatever the mesh
 * carries down its flanks (see `dressedFlanks`).
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

  /* THE FLANKS. Full storey height rather than the rail's own profile: a banister follows the slope,
     so matching it exactly would mean another eight boxes per side for a barrier nobody can vault
     anyway. One box a side, floor to ceiling, is the same answer to "can I walk off the edge" for a
     tenth of the broadphase cost.
     Placed INSIDE the block, not on its outer face: the mesh overhangs its cells by up to half a unit
     (`stairs` is 5.00 across a 4.00 block) and a collider that followed the art out there would poke
     into the neighbouring cell and block a corridor that looks clear. */
  const { left, right } = dressedFlanks(f.walls);
  const climbLeft = LEFT_OF_DIR[f.up], climbRight = RIGHT_OF_DIR[f.up];
  const ceilY = add(baseY, FLOOR_HEIGHT);
  for (const [on, side] of [[left, climbLeft], [right, climbRight]] as [boolean, Dir][]) {
    if (!on) continue;
    // the strip hugging that flank, along the whole run
    if (side === 'W') solids.push(makeBox(x0, baseY, z0, add(x0, SIDE_THICKNESS), ceilY, z1));
    else if (side === 'E') solids.push(makeBox(sub(x1, SIDE_THICKNESS), baseY, z0, x1, ceilY, z1));
    else if (side === 'N') solids.push(makeBox(x0, baseY, z0, x1, ceilY, add(z0, SIDE_THICKNESS)));
    else solids.push(makeBox(x0, baseY, sub(z1, SIDE_THICKNESS), x1, ceilY, z1));
  }
}

/** Standing at the foot looking up, which grid direction is on each hand. Mirrors `cell-place.ts`. */
const LEFT_OF_DIR: Record<Dir, Dir> = { N: 'W', W: 'S', S: 'E', E: 'N' };
const RIGHT_OF_DIR: Record<Dir, Dir> = { W: 'N', S: 'W', E: 'S', N: 'E' };

/**
 * THE OUTER WALL. Every storey is ringed, and without it the tower has no edge: you walk off the last
 * cell into a drop to the kill plane, which reads as the map having failed rather than as a boundary.
 * The 4u compiler has had this since the beginning ("a FLOOR_HEIGHT-tall wall ring hugs each stratum's
 * exterior"); the 2u one never grew one.
 *
 * COLLISION IS FOUR LONG BOXES, not one per cell. A ring of 2u segments would be ~120 boxes a storey
 * for the same shape a rectangle describes exactly, and the broadphase pays for every one.
 *
 * The MESH ring is per-4u-piece because that is the size the art comes in — those are drawn, not
 * collided, so they cost draw calls rather than physics.
 */
function emitPerimeter(
  solids: AABB[], out: WorldPlacement[], w: number, h: number, baseY: Fixed,
): void {
  const top = add(baseY, FLOOR_HEIGHT);
  // the floor's outer edge: cell centres run from cellCentre2u(0) to (w-1), each cell 2u across
  const c0 = cellCentre2u(w, h, 0);
  const cN = cellCentre2u(w, h, w * h - 1);
  const half = fromInt(1);                       // half a 2u cell
  const x0 = sub(c0.x, half), x1 = add(cN.x, half);
  const z0 = sub(c0.z, half), z1 = add(cN.z, half);
  const t = fromFloatConst(0.25);                // the wall body is 0.50 thick; see WALL_FALLBACK

  // four boxes, each spanning the FULL side so the corners are covered twice rather than left open
  solids.push(makeBox(sub(x0, t), baseY, sub(z0, t), add(x1, t), top, add(z0, t)));   // north
  solids.push(makeBox(sub(x0, t), baseY, sub(z1, t), add(x1, t), top, add(z1, t)));   // south
  solids.push(makeBox(sub(x0, t), baseY, sub(z0, t), add(x0, t), top, add(z1, t)));   // west
  solids.push(makeBox(sub(x1, t), baseY, sub(z0, t), add(x1, t), top, add(z1, t)));   // east

  /* The visible ring. `wall` is 4u and native along X, so a side takes ceil(span / 4) of them, each
     centred on its own 4u slice — the last one may overhang the corner, which is what makes the
     corners look closed instead of showing a seam. */
  const piece = PIECE.wall;
  const spanX = 2 * w, spanZ = 2 * h;
  const nX = Math.ceil(spanX / 4), nZ = Math.ceil(spanZ / 4);
  const place = (x: Fixed, z: Fixed, turn: number): void => {
    // collision is the four boxes above, so the mesh carries none — otherwise every ring piece would
    // add a redundant box the broadphase has to test
    out.push({
      x: toRaw(x), z: toRaw(z),
      unit: { url: piece, y: Z, turn, scale: ONE, boxes: [], materials: getApproved(objIdOf(piece))?.materials },
    });
  };
  for (let i = 0; i < nX; i++) {
    const cx = add(x0, fromFloatConst(Math.min(i * 4 + 2, spanX - 2)));
    place(cx, z0, 0);          // native +X run, on the north edge
    place(cx, z1, 0);
  }
  for (let i = 0; i < nZ; i++) {
    const cz = add(z0, fromFloatConst(Math.min(i * 4 + 2, spanZ - 2)));
    place(x0, cz, 1);          // turned a quarter to run along Z
    place(x1, cz, 1);
  }
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
  const stairs: StairInfo[] = []; // always empty here — see the note by `strataWithoutStairs`
  const cellGrid: StratumCellGrid[] = [];
  const strataWithoutStairs: number[] = [];
  const ceilingSealedFlights: CellTowerResult['ceilingSealedFlights'] = [];
  const half = mul(CELL_SIZE_2U, fromFloatConst(0.5));

  for (let s = 0; s < floors.length; s++) {
    const f = floors[s]!;
    const idx = startIndex + s;
    const baseY = add(params.groundY, mul(FLOOR_HEIGHT, fromInt(idx)));
    stratumBaseY[idx] = toRaw(baseY);

    /* THE SAME FLIGHT THE RENDERER DRAWS. `stairFlight` decides a direction partly from the storey
       ABOVE — a flight climbs into a wall, so where the hole is settles a corner — and this loop used
       to call it without one while `cellWorldPlacements` below was handed `floors[idx + 1]?.cells`.
       Two callers of one function with different arguments get different answers, and these two
       answers are the COLLIDER and the MESH. A flight could be drawn climbing west and collided
       climbing north: the treads you can see and the steps you can stand on pointing different ways.
       Everything downstream of this array inherits it — the per-cell `stair` flag, the sealed-ceiling
       report, and `emitFlightSolids`. One source of truth, decided once, with everything known. */
    const ceiling = floors[idx + 1]?.cells;
    const flights: StairFlight[] = [];
    for (let i = 0; i < f.cells.length; i++) {
      const fl = stairFlight(f.cells, f.width, f.height, i % f.width, Math.floor(i / f.width), ceiling);
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
        sightMask: sightMask2u(f.cells, f.width, f.height, i),
      });
    }

    // the storey above, so a flight in a corner climbs toward the hole rather than the deck — the SAME
    // `ceiling` the flights above were decided with, so the mesh and the collider cannot diverge
    const wallPlacements = cellWorldPlacements(f.cells, f.width, f.height, ceiling);
    emitPerimeter(solids, wallPlacements, f.width, f.height, baseY);
    const grid: StratumCellGrid = {
      stratum: idx, width: f.width, height: f.height,
      cellSize: toRaw(CELL_SIZE_2U), surfaceY: toRaw(baseY),
      cells,
      providesFloors: true,   // this compiler lays the ground itself; see the field's note
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

    /* NO `StairInfo`, deliberately. It describes a SYNTHETIC straight staircase — the one the 4u
       compiler invents — and the renderer draws a scaled, unrotated stair model from it
       (`dungeon.ts:placeStairsExact`, which assumes local +Z ascends). This tower's staircases are
       real authored meshes already in `wallPlacements`, so handing over a StairInfo makes the renderer
       draw a SECOND staircase on top of the first, facing whichever way its own assumption points.
       That is exactly the "stairs render backwards but the hitbox is right" symptom: the hitbox came
       from the real flight, the wrong-looking mesh from this. */
    const isTop = s === floors.length - 1;
    if (!isTop && flights.length === 0) strataWithoutStairs.push(idx);

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
