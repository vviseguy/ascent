// The line-of-sight walk, on a grid of numbers — no renderer, no scene, no GPU.
import { describe, it, expect } from 'vitest';
import { traceSight } from './dungeon.ts';

/** wallMask bits: 1 = +X, 2 = -X, 4 = +Z, 8 = -Z. */
const OPEN = () => false;

describe('traceSight — what the player can see', () => {
  it('reaches every cell in an open field', () => {
    const R = 12;
    const missed: string[] = [];
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        if ((dc === 0 && dr === 0) || dc * dc + dr * dr > R * R) continue;
        if (!traceSight(0, 0, dc, dr, OPEN)) missed.push(`(${dc},${dr})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('a wall stops sight in the direction it faces, and only that direction', () => {
    const eastWall = (c: number, r: number, bit: number): boolean => c === 0 && r === 0 && bit === 1;
    expect(traceSight(0, 0, 5, 0, eastWall)).toBe(false);   // through it
    expect(traceSight(0, 0, 0, 5, eastWall)).toBe(true);    // past it
    expect(traceSight(0, 0, -5, 0, eastWall)).toBe(true);   // behind it
  });

  it('cannot slip diagonally between two walls meeting at a corner', () => {
    /* The classic grid-sight bug: a naive Bresenham takes a diagonal step and squeezes through the
       hairline where two walls meet, letting you see round a solid corner. Advancing one axis at a
       time is what prevents it. */
    const corner = (c: number, r: number, bit: number): boolean =>
      (c === 0 && r === 0 && bit === 1) || (c === 0 && r === 0 && bit === 4);
    expect(traceSight(0, 0, 3, 3, corner)).toBe(false);
  });

  it('is symmetric enough to be believable: an open line works from either end', () => {
    for (const [c, r] of [[7, 3], [-4, 9], [5, -5]] as [number, number][]) {
      expect(traceSight(0, 0, c, r, OPEN)).toBe(true);
      expect(traceSight(c, r, 0, 0, OPEN)).toBe(true);
    }
  });

  it('sees ACROSS a void — the whole reason holes stopped being black boxes', () => {
    // a void records wallMask 0, so it blocks nothing; sight carries over the hole to what is beyond
    const voidAt3 = (c: number, _r: number, _bit: number): boolean => c === 99;  // nothing blocks
    expect(traceSight(0, 0, 6, 0, voidAt3)).toBe(true);
  });
});
