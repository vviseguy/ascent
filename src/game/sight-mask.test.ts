// SIGHT and MOVEMENT are different questions, and `wallMask` only ever answered the second one.
import { describe, it, expect } from 'vitest';
import { wallMask2u, sightMask2u } from './cell-tower.ts';
import { openCell, type Cell } from '../floor/cell.ts';

const W = 4, H = 4;
const grid = (mut: (c: Cell, x: number, y: number) => void): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
  return out;
};
const NORTH = 8, WEST = 2;

describe('sightMask2u — what stops the EYE, not the feet', () => {
  it('a BALUSTRADE over open air blocks movement but not sight', () => {
    /* The reported bug: standing at a rail overlooking a hall, everything beyond was black. Every
       cell out there is air — unwalkable — and `wallMask` sets a bit for "you cannot go this way",
       so the sight trace stopped at your own railing. */
    const cells = grid((c, x, y) => {
      if (y === 0) c.floor = 'none';                 // open air to the north: the hall below
      if (y === 1) c.wallN = 'barrier';              // a waist-high rail along its edge
    });
    const i = 1 * W + 1;                             // a cell just inside the rail
    expect(wallMask2u(cells, W, H, i) & NORTH).toBeTruthy();    // cannot WALK off the balcony
    expect(sightMask2u(cells, W, H, i) & NORTH).toBeFalsy();    // but you can SEE across it
  });

  it('a barrier alone never stops sight — it is waist high', () => {
    const cells = grid((c, _x, y) => { if (y === 1) c.wallN = 'barrier'; });
    expect(sightMask2u(cells, W, H, 1 * W + 1) & NORTH).toBeFalsy();
  });

  it('a full-height wall stops both', () => {
    const cells = grid((c, _x, y) => { if (y === 1) c.wallN = 'wall'; });
    const i = 1 * W + 1;
    expect(wallMask2u(cells, W, H, i) & NORTH).toBeTruthy();
    expect(sightMask2u(cells, W, H, i) & NORTH).toBeTruthy();
  });

  it('you see THROUGH an opening, though the segments either side are walls', () => {
    const cells = grid((c, x, y) => {
      if (y === 1 && x >= 0 && x <= 2) c.wallN = 'wall';
      if (y === 1 && x === 1) { c.wallType = 'arch'; c.open = 'open'; }   // an arch at that point
    });
    // the edge east of the arch's point is covered by it, so sight passes
    expect(sightMask2u(cells, W, H, 1 * W + 1) & NORTH).toBeFalsy();
  });

  it('empty air on its own stops nothing at all', () => {
    const cells = grid((c, _x, y) => { if (y === 0) c.floor = 'none'; });
    expect(sightMask2u(cells, W, H, 1 * W + 1)).toBe(0);
  });
});
