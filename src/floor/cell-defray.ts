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
import { segs } from './cell-field.ts';
import { getStructure } from './cell-structures.ts';
import { orientStructure, type Orientation } from './cell-orient.ts';

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

/** A segment somebody MEANT — never fraying, however loose it looks. */
export type KeepWall = (x: number, y: number, side: 'N' | 'W') => boolean;

/** Where a structure was put, and how it was turned. Structurally typed so this file does not have to
 *  import the generator — only the shape it produces. */
export interface PlacedLike {
  name: string;
  orientation: Orientation;
  region: { x: number; y: number };
}

const NONE_SEG = segs('none');

/**
 * PROTECT WHAT AN AUTHOR DREW.
 *
 * This is the third exemption in this file and they are all the same shape: something that looks loose
 * but is not fraying. The map border was the first, a staircase's head wall the second, and an
 * authored wall is the third — and the most important, because the note at the top of this file says
 * the fraying "is worst exactly where it matters most: around the structures", and the cure was
 * removing the structures' own walls along with the nubs. Measured before this: of 974 walls the
 * structures asserted, 181 were gone by the time the floor rendered, and `odd wall section` — a piece
 * that is nothing BUT a wall — lost 42% of itself.
 *
 * A segment counts as authored when the structure's stored domain EXCLUDES `none`: the author said
 * something is certainly there. A perimeter wall the generator deliberately widened to {none, wall} so
 * SEAL could cut a door through it is NOT protected, which is right — that one is meant to be openable,
 * and if SEAL closed it the closure asserts it again anyway.
 *
 * LEVELS ARE UNIONED. A placement does not record which storey of a multi-level structure it is, so a
 * segment is protected if ANY level asserts it. That over-protects slightly, and deliberately in this
 * direction: the failure it prevents is losing authored geometry, and the failure it risks is keeping
 * one nub that a different storey would have shed.
 */
export function structureWalls(placed: readonly PlacedLike[]): KeepWall {
  const keep = new Set<number>();
  for (const p of placed) {
    const base = getStructure(p.name);
    if (!base) continue;
    const st = orientStructure(base, p.orientation);
    const sw = st.w + 1, sh = st.h + 1, size = sw * sh;
    const levels = Math.max(1, Math.floor(st.cells.length / size));
    for (let lv = 0; lv < levels; lv++) {
      for (let ly = 0; ly < sh; ly++) {
        for (let lx = 0; lx < sw; lx++) {
          const f = st.cells[lv * size + ly * sw + lx];
          if (!f) continue;
          const gx = p.region.x + lx, gy = p.region.y + ly;
          // the padding column owns no east-running edge; the padding row no south-running one
          if (lx < st.w && (f.wallN & NONE_SEG) === 0) keep.add((gy * 4096 + gx) * 2);
          if (ly < st.h && (f.wallW & NONE_SEG) === 0) keep.add((gy * 4096 + gx) * 2 + 1);
        }
      }
    }
  }
  return (x, y, side) => keep.has((y * 4096 + x) * 2 + (side === 'N' ? 0 : 1));
}

const KEEP_NOTHING: KeepWall = () => false;

/**
 * Remove wall segments that end in mid-air. Mutates `cells` and reports what it took.
 *
 * Both endpoints are examined and a segment goes if EITHER is loose — a segment loose at one end is
 * still a nub, and one loose at both was floating on its own.
 */
export function defray(
  cells: (Cell | null)[], w: number, h: number, passes = 2, keep: KeepWall = KEEP_NOTHING,
): DefrayStats {
  const removed: number[] = [];
  for (let pass = 0; pass < passes; pass++) {
    // decide against the CURRENT state, then apply — otherwise a segment's fate depends on where in
    // the sweep its neighbour happened to sit, and the result stops being a property of the floor
    const doomed: { x: number; y: number; side: 'N' | 'W' }[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (eastOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'N') && !keep(x, y, 'N')
          && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x + 1, y) < 2)) {
          doomed.push({ x, y, side: 'N' });
        }
        if (southOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'W') && !keep(x, y, 'W')
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
      if (eastOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'N') && !keep(x, y, 'N')
        && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x + 1, y) < 2)) remaining++;
      if (southOf(cells, w, h, x, y) && !holdsStair(cells, w, h, x, y, 'W') && !keep(x, y, 'W')
        && (armsAt(cells, w, h, x, y) < 2 || armsAt(cells, w, h, x, y + 1) < 2)) remaining++;
    }
  }
  return { removed, remaining };
}

/**
 * Collapse a generated floor and take its loose ends off — the one call every consumer should use, so
 * the renderer, the collision compiler and the previews are all looking at the same floor.
 *
 * TAKES THE FLOOR, NOT THE GRID, on purpose. De-fraying needs to know which walls an author drew, and
 * a bare grid cannot say — every domain is a singleton by the time it is settled. Passing the floor
 * makes that an enforced contract rather than a convention a call site can forget: there is no way to
 * ask for a resolved floor without also handing over what was placed on it.
 *
 * ONE pass by default. Each further pass takes more nubs but opens the floor out, and a floor of wide
 * empty rooms is its own problem; see the note at the top of this file.
 */
export function resolveFloor(
  floor: { grid: CellGrid; placed: readonly PlacedLike[] }, passes = 1,
): (Cell | null)[] {
  const cells = resolveGrid(floor.grid);
  defray(cells, floor.grid.w, floor.grid.h, passes, structureWalls(floor.placed));
  return cells;
}
