// ============================================================================
// src/floor/cell.ts — the CELL: one 2u square, and the whole structural model.
// ============================================================================
//
// A cell is 2u — a QUARTER of the 4u tile the meshes are authored at, so a "tile" is now simply a
// 2×2 group of cells and carries no data of its own.
//
// Everything a cell owns is on its own north-west side:
//
//        (x,y)────wallN────(x+1,y)          wallN — the lattice segment (x,y)→(x+1,y)
//          │                  │             wallW — the lattice segment (x,y)→(x,y+1)
//        wallW   floor        │             floor — ONE material for the whole square
//          │                  │             the NW corner POINT (x,y) is owned too
//        (x,y+1)───────────(x+1,y+1)
//
// A cell's SOUTH wall is the south neighbour's `wallN`; its EAST wall is the east neighbour's
// `wallW`. Single ownership, exactly as before — but now it is the ONLY rule in the model, because
// there is nothing left that a cell could disagree with a neighbour about.
//
// WHY THIS REPLACED THE 9-CELL TILE. The old 4u tile split each side into `inner` + `edge` and kept a
// `centre`, so that a coarse cell could express detail finer than itself. That is a sub-grid
// simulated inside a cell — so we now just have the sub-grid, and every irregularity the simulation
// caused disappears with it:
//   • an arm was 2u and could be HALF expressed (inner without edge) — rendering a full wall while
//     reading as passable. A wall is now one cell; present or absent. That bug is unrepresentable.
//   • the CROSS seam (three cells across two tiles describing one wall) — a wall is one owned cell.
//   • the POINT seam (four floor quadrants meeting at a lattice point) — floor is one value per cell.
//   • the `centre` cell — now an ordinary lattice point.
// The mesh library already matches: `wall_half` is exactly a 2u segment and the floor pieces render
// at half scale, so the pieces stop being *halves of* something and become the unit.
//
// OPENINGS live on a POINT, not a cell face. A door mesh is 4u — two collinear wall segments — so an
// opening is centred on the lattice point between them, along one axis. A cell owns the point at its
// NW corner (every point is the NW corner of exactly one cell), so it carries both axes:
//
//     openH ─ the two HORIZONTAL walls either side of the point: wallN of (x-1,y) and wallN of (x,y)
//     openV ─ the two VERTICAL   walls either side of the point: wallW of (x,y-1) and wallW of (x,y)
//
// A 2u doorway needs no opening at all — just leave the wall segment out.
//
// Pure + deterministic: plain enums, no float, no RNG, no Map iteration on an output-affecting path.

/** One wall segment: nothing, a full-height wall, or a low barrier you can get over. */
export type Seg = 'none' | 'wall' | 'barrier';
export const SEGS: readonly Seg[] = ['none', 'wall', 'barrier'];

/** Ground material for a cell. `none` is a PIT — no floor is emitted at all. */
export type FloorMaterial = 'none' | 'stone' | 'dirt' | 'wood';
export const FLOOR_MATERIALS: readonly FloorMaterial[] = ['none', 'stone', 'dirt', 'wood'];

/** What a 4u opening looks like. `solid` means there is no opening here. */
export type WallType = 'solid' | 'door' | 'window' | 'hole' | 'arch' | 'low_gate';
export const WALL_TYPES: readonly WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];

/** The only wall types you can actually walk through. A window is too high, a broken wall is rubble
 *  and a low_gate is barred — those are cosmetic variants of a solid wall, not passages. */
export const OPEN_WALL_TYPES: readonly WallType[] = ['door', 'arch'];
export const isOpenType = (wt: WallType): boolean => OPEN_WALL_TYPES.includes(wt);

/** The four directions, in the fixed order every iteration uses. */
export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

/** Which axis an opening spans. */
export type Axis = 'H' | 'V';
export const AXES: readonly Axis[] = ['H', 'V'];

/** One 2u square. Every field is OWNED by this cell — see the header for what that means. */
export interface Cell {
  floor: FloorMaterial;
  /** The wall along this cell's north edge: the lattice segment (x,y)→(x+1,y). */
  wallN: Seg;
  /** The wall along this cell's west edge: the lattice segment (x,y)→(x,y+1). */
  wallW: Seg;
  /** A 4u opening centred on this cell's NW corner, spanning the two HORIZONTAL walls either side. */
  openH: WallType;
  /** A 4u opening centred on this cell's NW corner, spanning the two VERTICAL walls either side. */
  openV: WallType;
}

/** A plain open cell: stone ground, no walls, no openings. */
export const openCell = (floor: FloorMaterial = 'stone'): Cell => ({
  floor, wallN: 'none', wallW: 'none', openH: 'solid', openV: 'solid',
});

/** Does this wall segment stop a body? Only a full-height wall does — `barrier` is surmountable and
 *  `none` is not there. One value, one test; there is no half-expressed wall to reason about. */
export const blocks = (s: Seg): boolean => s === 'wall';

/** The neighbour whose cell OWNS the wall on side `d` of cell (x,y), and which of its two walls it is.
 *  N and W are the cell's own; S and E belong to the neighbour beyond them. */
export function wallOwner(x: number, y: number, d: Dir): { x: number; y: number; side: 'N' | 'W' } {
  if (d === 'N') return { x, y, side: 'N' };
  if (d === 'W') return { x, y, side: 'W' };
  if (d === 'S') return { x, y: y + 1, side: 'N' };
  return { x: x + 1, y, side: 'W' }; // 'E'
}

/** Step from a cell to its neighbour in direction `d`. */
export const stepped = (x: number, y: number, d: Dir): { x: number; y: number } =>
  d === 'N' ? { x, y: y - 1 } : d === 'S' ? { x, y: y + 1 } : d === 'E' ? { x: x + 1, y } : { x: x - 1, y };

/** The opposite direction — used when a rule has to be stated from the other side of a shared wall. */
export const opposite = (d: Dir): Dir => (d === 'N' ? 'S' : d === 'S' ? 'N' : d === 'E' ? 'W' : 'E');

/**
 * The four cells around the lattice point owned by cell (x,y) — its NW corner — split into the two
 * groups an opening on each axis connects.
 *
 * A HORIZONTAL opening is a hole in the horizontal wall run through the point, so it lets a body
 * cross NORTH↔SOUTH anywhere along its 4u span: every north cell reaches every south cell. A VERTICAL
 * opening does the same across WEST↔EAST.
 *
 * Deliberately NOT "all four join". The perpendicular wall run still meets the point and its end
 * stands in the doorway, so claiming (say) NW↔NE off the back of a horizontal door would be an
 * over-claim — and over-claiming reachability is the one direction a solvability check must never err.
 */
export function openingGroups(x: number, y: number, axis: Axis): { a: { x: number; y: number }[]; b: { x: number; y: number }[] } {
  const nw = { x: x - 1, y: y - 1 }, ne = { x, y: y - 1 };
  const sw = { x: x - 1, y }, se = { x, y };
  return axis === 'H' ? { a: [nw, ne], b: [sw, se] } : { a: [nw, sw], b: [ne, se] };
}

/** The wall segments a point-centred opening spans, as owner references. A horizontal opening covers
 *  the `wallN` of the cells west and east of the point; a vertical one covers the `wallW` of the cells
 *  north and south of it. */
export function openingWalls(x: number, y: number, axis: Axis): { x: number; y: number; side: 'N' | 'W' }[] {
  return axis === 'H'
    ? [{ x: x - 1, y, side: 'N' }, { x, y, side: 'N' }]
    : [{ x, y: y - 1, side: 'W' }, { x, y, side: 'W' }];
}
