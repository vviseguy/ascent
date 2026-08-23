// ============================================================================
// src/floor/cell-defray.ts — take the loose ends off a finished floor.
// ============================================================================
//
// The maze stamps BARRIERS of `step` collinear walls between blocks. A barrier whose end does not
// happen to meet another barrier just stops in mid-air, and on a real floor about THIRTY PERCENT of
// wall segments end that way — short nubs poking into corridors and out of the sides of rooms. It
// reads as fraying, and it is worst exactly where it matters most: around the structures, where a
// corridor should meet a doorway cleanly.
//
// A WALL WITH A FREE END SEPARATES NOTHING. You walk round the open end, so the two sides of it were
// already connected and removing it cannot disconnect anything. That is the whole safety argument, and
// it is why this can run after everything else without re-proving a thing: every guarantee the
// generator established is about what is REACHABLE, and this only ever adds reachability.
//
// IT RUNS ON THE COLLAPSED CELLS, not the domain grid, and that is not a shortcut. The transactional
// grid is monotone by design — `andGate` only narrows — so a wall that has been pinned cannot be
// un-pinned there without breaking the invariant the whole generator rests on. Removing a wall is a
// widening, so it belongs after the collapse, as its own named step.
//
// BOUNDED PASSES, because taking a nub off can leave the wall it hung from with a free end of its own,
// and following that all the way unravels long walls that were doing real work. One pass takes the
// obvious nubs; the default of two takes the nubs those reveal and stops.

import { blocks, isStairFloor, type Cell } from './cell.ts';
import { resolveGrid, type CellGrid } from './cell-grid.ts';

export interface DefrayStats {
  /** Segments removed, per pass. */
  removed: number[];
  /** Segments with a free end still standing when it stopped. */
  remaining: number;
}

const at = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): Cell | null =>
  x < 0 || y < 0 || x >= w || y >= h ? null : cells[y * w + x] ?? null;

/** Is there a wall running EAST from lattice point (x,y)? */
const eastOf = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): boolean => {
  const c = at(cells, w, h, x, y);
  return !!c && blocks(c.wallN);
};
/** Is there a wall running SOUTH from lattice point (x,y)? */
const southOf = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): boolean => {
  const c = at(cells, w, h, x, y);
  return !!c && blocks(c.wallW);
};

/**
 * How many wall segments meet at lattice point (x,y).
 *
 * The grid BORDER counts as an arm. A wall running into the edge of the map is not loose — there is
 * nothing to walk round — and treating it as a nub strips the outside wall off every floor.
 */
export function armsAt(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number): number {
  let n = 0;
  if (eastOf(cells, w, h, x, y)) n++;
  if (eastOf(cells, w, h, x - 1, y)) n++;
  if (southOf(cells, w, h, x, y)) n++;
  if (southOf(cells, w, h, x, y - 1)) n++;
  if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) n += 2; // the map edge anchors it
  return n;
}

/**
 * Does this segment hold up a staircase? Then it stays, however loose it looks.
 *
 * A flight's HEAD WALL is the definition of the flight — `stairFlight` derives which way it climbs
 * from exactly one end being walled — and a head wall is very often a short one with a free end, which
 * is precisely what this file removes. Taking it left a 2x2 of stair cells with nothing to say which
 * way it went, so it drew as ordinary ground and the tower stopped being climbable. Same rule the
 * generator already applies when it decides which perimeter walls may be opened into doorways.
 */
const holdsStair = (
  cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, side: 'N' | 'W',
): boolean => {
  const here = at(cells, w, h, x, y);
  const other = side === 'N' ? at(cells, w, h, x, y - 1) : at(cells, w, h, x - 1, y);
  return (!!here && isStairFloor(here.floor)) || (!!other && isStairFloor(other.floor));
};

/**
 * Remove wall segments that end in mid-air. Mutates `cells` and reports what it took.
 *
 * Both endpoints are examined and a segment goes if EITHER is loose — a segment loose at one end is
 * still a nub, and one loose at both was floating on its own.
 */
export function defray(
  cells: (Cell | null)[], w: number, h: number, passes = 2,
): DefrayStats {
  const removed: number[] = [];
  for (let pass = 0; pass < passes; pass++) {
    // decide against the CURRENT state, then apply — otherwise a segment's fate depends on where in
    // the sweep its neighbour happened to sit, and the result stops being a property of the floor
    const doomed: { x: number; y: number; side: 'N' | 'W' }[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (eastOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'N')
          && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x + 1, y) < 2)) {
          doomed.push({ x, y, side: 'N' });
        }
        if (southOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'W')
          && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x, y + 1) < 2)) {
          doomed.push({ x, y, side: 'W' });
        }
      }
    }
    if (doomed.length === 0) { removed.push(0); break; }
    for (const d of doomed) {
      const c = at(cells, w, h, d.x, d.y);
      if (!c) continue;
      if (d.side === 'N') c.wallN = 'none'; else c.wallW = 'none';
    }
    removed.push(doomed.length);
  }

  let remaining = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (eastOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'N')
        && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x + 1, y) < 2)) remaining++;
      if (southOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'W')
        && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x, y + 1) < 2)) remaining++;
    }
  }
  return { removed, remaining };
}

/**
 * Collapse a generated floor and take its loose ends off — the one call every consumer should use, so
 * the renderer, the collision compiler and the previews are all looking at the same floor.
 *
 * ONE pass by default. Each further pass takes more nubs but opens the floor out, and a floor of wide
 * empty rooms is its own problem; see the note at the top of this file.
 */
export function resolveFloor(grid: CellGrid, passes = 1): (Cell | null)[] {
  const cells = resolveGrid(grid);
  defray(cells, grid.w, grid.h, passes);
  return cells;
}
