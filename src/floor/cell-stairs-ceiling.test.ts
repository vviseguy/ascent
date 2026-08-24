// WHICH WAY DOES A CORNER STAIRCASE CLIMB?
//
// A flight climbs toward its walled end, so a block walled on two ADJACENT sides reads two ways and
// the walls alone cannot say which. Three signals break it, WEIGHTED rather than ordered:
//
//   4  the FOOT is reachable   — is there ground to walk in from at the open end?
//   2  the CEILING is open     — a flight climbs into a wall, so the storey above is its only exit
//   1  the head wall is its OWN — a wall running on past the block is one it stands beside
//
// Scored rather than chained so a direction winning two weak signals can still lose to the strong
// one. The foot outweighs the rest on purpose: you can argue about which end is the head, you cannot
// argue about an entrance nobody can reach.

import { describe, it, expect } from 'vitest';
import { stairFlight } from './cell-place.ts';
import { openCell, type Cell } from './cell.ts';

const W = 6, H = 6;

/** A 2x2 stone flight at (1,1) walled on the NORTH and the WEST — the ambiguous corner. */
function corner(): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = openCell();
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';      // north closed
      if ((y === 1 || y === 2) && x === 1) c.wallW = 'wall';  // west closed
      out.push(c);
    }
  }
  return out;
}

/** A storey of solid deck, with a hole punched over the given cells. */
function ceilingWithHoleAt(holes: readonly [number, number][]): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = openCell();
      if (holes.some(([hx, hy]) => hx === x && hy === y)) c.floor = 'none';
      out.push(c);
    }
  }
  return out;
}

describe('a corner staircase climbs toward the hole in the ceiling', () => {
  it('climbs NORTH when the hole is over its north end', () => {
    // the north head cells of the block are (1,1) and (2,1)
    const above = ceilingWithHoleAt([[1, 1], [2, 1]]);
    expect(stairFlight(corner(), W, H, 1, 1, above)).toMatchObject({ up: 'N' });
  });

  it('climbs WEST when the hole is over its west end instead', () => {
    // the west head cells are (1,1) and (1,2) — same walls, same block, opposite reading
    const above = ceilingWithHoleAt([[1, 1], [1, 2]]);
    expect(stairFlight(corner(), W, H, 1, 1, above)).toMatchObject({ up: 'W' });
  });

  it('needs the WHOLE head open — half a hole is somewhere to fall, not an exit', () => {
    // only one of the two north head cells is open, so north does not win on the ceiling
    const half = ceilingWithHoleAt([[1, 1]]);
    // ...and neither does west, whose head is (1,1)+(1,2) and also only half open. With the ceiling
    // silent it falls through to the older rule rather than picking at random.
    const both = stairFlight(corner(), W, H, 1, 1, half);
    const none = stairFlight(corner(), W, H, 1, 1);
    expect(both?.up).toBe(none?.up);
  });

  it('falls back to the old rule with no storey above at all', () => {
    // a single-level structure has nothing to be blocked BY, and must still resolve
    const f = stairFlight(corner(), W, H, 1, 1);
    expect(f).not.toBeNull();
    expect(['N', 'W']).toContain(f!.up);
  });

  it('a solid ceiling over BOTH ends does not flip a coin — it defers, deterministically', () => {
    const solid = ceilingWithHoleAt([]);
    expect(stairFlight(corner(), W, H, 1, 1, solid)?.up).toBe(stairFlight(corner(), W, H, 1, 1)?.up);
  });

  it('the FOOT outweighs the ceiling — an entrance nobody can reach loses', () => {
    /* North is made attractive by the ceiling (a hole over its head) and impossible at the foot: the
       cells south of the block, where you would walk in from, are solid rock. West stays walkable.
       The reading you can actually use must win. */
    const cells = corner();
    for (const x of [1, 2]) cells[3 * W + x]!.floor = 'rock';   // south of the block — north's foot
    const above = ceilingWithHoleAt([[1, 1], [2, 1]]);          // ...and the ceiling favours north
    expect(stairFlight(cells, W, H, 1, 1, above)).toMatchObject({ up: 'W' });
  });

  it('a foot facing VOID is as unusable as one facing rock', () => {
    const cells = corner();
    for (const x of [1, 2]) cells[3 * W + x]!.floor = 'none';
    expect(stairFlight(cells, W, H, 1, 1)).toMatchObject({ up: 'W' });
  });

  it('ONE walkable neighbour at the foot is enough — a doorway is one cell wide', () => {
    const cells = corner();
    cells[3 * W + 1]!.floor = 'rock';                            // block half of north's entry
    // north's foot is still reachable through (2,3), so the ceiling gets to decide as before
    const above = ceilingWithHoleAt([[1, 1], [2, 1]]);
    expect(stairFlight(cells, W, H, 1, 1, above)).toMatchObject({ up: 'N' });
  });

  it('the ceiling only breaks TIES — it never overrides an unambiguous flight', () => {
    // north closed, south open, and BOTH flanks open: one reading only, whatever is overhead
    const plain: Cell[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = openCell();
        if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs';
        if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
        plain.push(c);
      }
    }
    // a hole over the SOUTH end must not drag the flight round
    const above = ceilingWithHoleAt([[1, 2], [2, 2]]);
    expect(stairFlight(plain, W, H, 1, 1, above)).toMatchObject({ up: 'N' });
  });
});
