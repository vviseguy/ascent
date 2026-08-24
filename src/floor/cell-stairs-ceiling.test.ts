// WHICH WAY DOES A CORNER STAIRCASE CLIMB?
//
// A flight climbs toward its walled end, so a block walled on two ADJACENT sides reads two ways and
// the walls alone cannot say which. Four signals break it, WEIGHTED rather than ordered:
//
//   6  the FOOT is reachable    — is there ground to walk in from at the open end?  (graded 0/1/2)
//   2  the CEILING is open      — a flight climbs into a wall, so the storey above is its only exit
//   2  the LANDING is clear     — and something to stand on once you are through the hole
//   1  the head wall is its OWN — a wall running on past the block is one it stands beside
//
// Scored rather than chained so a direction winning two weak signals can still lose to the strong
// one. The foot outweighs ALL THE REST COMBINED on purpose (12 against 6+2+2+1): you can argue about
// which end is the head, you cannot argue about an entrance nobody can reach. That bound is why the
// multiplier is 6 and not a round number — see `score` in cell-place.ts before changing any weight.

import { describe, it, expect } from 'vitest';
import { stairFlight, stairFault, stairFaultText } from './cell-place.ts';
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
  it('THE CEILING DOES NOT CHOOSE THE DIRECTION — it is the same hole whichever way you read it', () => {
    /* THIS TEST USED TO ASSERT THE OPPOSITE, and it was measuring an accident of its own fixture.
       A real stairwell's hole is cut to the shape of the BLOCK, so every reading's head cells sit
       inside it and the answer is the same for all four directions. Measured across the whole authored
       store: 13 flights out of 13 answered identically N/E/S/W. A value that is equal for every option
       cannot order them, so the ceiling was doing nothing but costing four lookups per flight.
       These fixtures could only make it look decisive by punching a hole over ONE end, which is not a
       shape anybody authors. The walls and the floor choose the direction now; the ceiling survives as
       a FAULT for a flight that climbs into solid deck, which is the question it can actually answer. */
    const overNorth = ceilingWithHoleAt([[1, 1], [2, 1]]);
    const overWest = ceilingWithHoleAt([[1, 1], [1, 2]]);
    const whole = ceilingWithHoleAt([[1, 1], [2, 1], [1, 2], [2, 2]]);   // how it is really authored
    const plain = stairFlight(corner(), W, H, 1, 1)?.up;
    expect(stairFlight(corner(), W, H, 1, 1, whole)?.up).toBe(plain);
    expect(stairFlight(corner(), W, H, 1, 1, overNorth)?.up).toBe(plain);
    expect(stairFlight(corner(), W, H, 1, 1, overWest)?.up).toBe(plain);
  });

  it('prefers the head with somewhere to LAND, not just a hole to climb through', () => {
    /* THE OTHER HALF OF THE CEILING QUESTION. `ceilingOpen` asks whether the hole exists; it says
       nothing about what is on the far side of it, so a flight could climb through a perfect hole and
       leave you treading air. Here BOTH readings are open overhead and tie on every other signal — same
       foot, same own-head wall — and the only difference is that north arrives over the void while west
       arrives on floor. West is the flight the author drew. */
    const above = ceilingWithHoleAt([[1, 1], [2, 1], [1, 2]]);  // both heads open
    for (const x of [1, 2]) above[0 * W + x]!.floor = 'none';   // north's landing (1,0),(2,0): void
    expect(stairFlight(corner(), W, H, 1, 1, above)).toMatchObject({ up: 'W' });

    // and mirrored, so this is the landing deciding and not a standing preference for west
    const flipped = ceilingWithHoleAt([[1, 1], [2, 1], [1, 2]]);
    for (const y of [1, 2]) flipped[y * W + 0]!.floor = 'none'; // west's landing (0,1),(0,2): void
    expect(stairFlight(corner(), W, H, 1, 1, flipped)).toMatchObject({ up: 'N' });
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

  it('a WIDER entrance beats a narrower one, but one cell is still a way in', () => {
    /* A DELIBERATE CHANGE OF MODEL. The foot used to be graded by the BEST neighbour, so one walkable
       cell scored exactly as well as two — "a doorway is one cell wide". It is counted now, and the
       count is squared (0 / 1 / 4), because the two are not equally good: a two-cell entrance is a way
       in, a one-cell entrance is a gap you have to line yourself up with.
       One cell still makes the reading VIABLE — it is a way in, just a worse one — so a flight with a
       single walkable neighbour and nothing competing still draws. */
    const cells = corner();
    cells[3 * W + 1]!.floor = 'rock';                   // half of north's entry blocked; west's is full
    expect(stairFlight(cells, W, H, 1, 1)).toMatchObject({ up: 'W' });

    // ...and with west's entry blocked off entirely, north's single cell carries it
    const narrow = corner();
    narrow[3 * W + 1]!.floor = 'rock';
    for (const yy of [1, 2]) narrow[yy * W + 3]!.floor = 'none';   // east of the block: no ground at all
    expect(stairFlight(narrow, W, H, 1, 1)).toMatchObject({ up: 'N' });
  });

  it('the ceiling never OVERRIDES an unambiguous flight — but a sealed head is a FAULT', () => {
    /* north closed, south open, both flanks open: one reading only, whatever is overhead.
       This test used to assert the flight still drew as N. Its intent — that a hole in the wrong place
       cannot drag an unambiguous flight round — still holds and is asserted below. What changed is what
       happens when the head IS sealed: on a FORCED axis the foot and the ceiling were never consulted
       at all, so a flight would quietly climb into the deck above. It reports a fault now instead of
       drawing something that does not work. Reversing is not the alternative: that would put the foot
       where the wall is. */
    const plain: Cell[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = openCell();
        if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs';
        if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
        plain.push(c);
      }
    }
    // a hole over the SOUTH end leaves this flight's own head sealed
    const wrongHole = ceilingWithHoleAt([[1, 2], [2, 2]]);
    expect(stairFlight(plain, W, H, 1, 1, wrongHole)).toBeNull();          // refuses, does not flip
    const fault = stairFault(plain, W, H, 1, 1, wrongHole);
    expect(fault).toMatchObject({ kind: 'sealed-ceiling', up: 'N' });
    expect(stairFaultText(fault!)).toContain('deck above');

    // and it was NEVER dragged round to S — the ceiling does not choose the direction
    expect(stairFlight(plain, W, H, 1, 1, wrongHole)?.up).not.toBe('S');

    // put the hole over its actual head and the same flight draws, unchanged
    const rightHole = ceilingWithHoleAt([[1, 1], [2, 1]]);
    expect(stairFlight(plain, W, H, 1, 1, rightHole)).toMatchObject({ up: 'N' });
  });
});
