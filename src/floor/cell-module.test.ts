// The two failures the schematic could not show and the suite could not fail on.
//
// The first was invisible because the wall types had a table with no reader: `WALLTYPE_URL` listed all
// fifteen while the only caller was gated on `isOpenType`, so eleven of them drew a blank wall. The
// second was invisible because `cell-place.test.ts`'s helper FILTERS `wall_endcap` out of the urls it
// asserts on — the test named "draws ONE arch and suppresses BOTH wall halves" passed while a
// full-height stub stood in the doorway. Both tests here assert on GEOMETRY, not on filtered names.
import { describe, it, expect } from 'vitest';
import { gridPlacements, moduleAt, moduleAxis, openingAt, wallTypeUrl } from './cell-place.ts';
import { openCell, WALL_TYPES, OPENS, PASSABLE_KINDS, type Cell, type WallType, type Open } from './cell.ts';
import { toFloat } from '../sim/fixed/fixed.ts';

const W = 5, H = 3;
/** A three-edge wall run along row 1, with `wt` at the middle lattice point. */
const run = (wt: WallType, floor: 'stone' | 'rock' = 'stone', open: Open = 'closed'): Cell[] => {
  const cs: Cell[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = openCell();
    if (y === 1 && x <= 3) c.wallN = 'wall';
    if (y === 1 && x === 2) { c.wallType = wt; c.floor = floor; c.open = open; }
    cs.push(c);
  }
  return cs;
};
const names = (cs: Cell[]): string[] =>
  gridPlacements(cs, W, H).flatMap((e) => e.placements)
    .map((p) => p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, ''));

describe('every wall type an author can paint actually draws its own mesh', () => {
  const kinds = WALL_TYPES.filter((t) => t !== 'solid');
  it.each(kinds.flatMap((wt) => OPENS.map((o) => [wt, o] as const)))(
    '%s (%s) draws its own mesh, not a blank wall', (wt, o) => {
      const want = wallTypeUrl(wt, o).split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, '');
      expect(names(run(wt, 'stone', o))).toContain(want);
    });

  it('`solid` draws no module — it is the run system\'s job, and a module would double it', () => {
    expect(moduleAxis(run('solid'), W, H, 2, 1)).toBeNull();
  });

  it('a module is DRAWN for any variant, but only some are WALK-THROUGH', () => {
    // the distinction that conflating the two destroyed
    // OPEN IS NOT PASSABLE: an open window is a hole at sill height, an open crack pinches to 0.10
    for (const wt of ['window', 'cracked', 'arch_window'] as const) {
      expect(moduleAt(run(wt, 'stone', 'open'), W, H, 2, 1, 'H')).toBe(true);
      expect(openingAt(run(wt, 'stone', 'open'), W, H, 2, 1, 'H')).toBe(false);
    }
    for (const wt of PASSABLE_KINDS) {
      expect(openingAt(run(wt, 'stone', 'open'), W, H, 2, 1, 'H')).toBe(true);
      expect(openingAt(run(wt, 'stone', 'closed'), W, H, 2, 1, 'H')).toBe(false);
    }
  });

  it('ROCK cannot host a module — it would delete two wall halves and put back nothing', () => {
    // `cellPlacements` bails on rock before it would draw one, so suppression must agree
    expect(moduleAt(run('doorway', 'rock', 'open'), W, H, 2, 1, 'H')).toBe(false);
    const drawn = names(run('doorway', 'rock', 'open'));
    expect(drawn.filter((n) => n.startsWith('wall')).length).toBeGreaterThan(0); // the run survives
  });
});

describe('a run that meets a module does not finish itself into it', () => {
  /* Asserting on the SPANS meant re-deriving each mesh's authored origin — `wall` is centred at
     x[-2,2] while `wall_half` runs x[0,2] and `wall_half_endcap` x[-2,0] — which is its own source of
     error. The bug is exact and needs no arithmetic: a finishing piece is emitted AT the lattice point
     where a wall stops, so ask whether any of them stands on a point a module is drawn at.

     THE PIECES CHANGED WHEN THE PRIORITY ORDER LANDED, and this suite had to change with them or go
     quiet. It used to look for `wall_endcap`, which the wall passes no longer emit at all — so all
     three assertions would have passed vacuously while the mechanism they guard was rewritten
     underneath them. A test that can only fail on a retired piece is not a test. */
  const FINISHERS = ['wall_half_endcap', 'wall_endcap_short'];
  const finishPoints = (cs: Cell[], w = W, h = H): string[] => {
    const bad: string[] = [];
    for (const { x, y, placements } of gridPlacements(cs, w, h)) {
      for (const p of placements) {
        const n = p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, '');
        if (!FINISHERS.includes(n)) continue;
        /* Both pieces pivot ON the point they finish — `wall_half_endcap` because its finished face
           is at its origin, `wall_endcap_short` because its MATING face is — so the pivot IS the
           lattice point: the emitting cell's NW corner when the offset is the cell-local corner, and
           the far corner when it is offset a whole edge along. */
        const px = x + (toFloat(p.x) > -0.5 ? 1 : 0), py = y + (toFloat(p.z) > -0.5 ? 1 : 0);
        if (moduleAxis(cs, w, h, px, py)) bad.push(`${n} at (${px},${py}) where a module is drawn`);
      }
    }
    return bad;
  };

  it('nothing that finishes a wall lands on a point where a module is drawn', () => {
    expect(finishPoints(run('doorway'))).toEqual([]);
  });

  it('...for every module type, not only the walk-through ones', () => {
    const bad = WALL_TYPES.filter((t) => t !== 'solid').flatMap((wt) => finishPoints(run(wt)));
    expect(bad).toEqual([]);
  });

  it('...and the fixture really does put a module next to a run, or the two above prove nothing', () => {
    // the `run` helper is 3 edges with the middle POINT opened, so the module claims two of them and
    // one run edge is left on each side — which is the shape the bug needed
    expect(moduleAxis(run('doorway'), W, H, 2, 1)).toBe('H');
    expect(names(run('doorway')).filter((n) => FINISHERS.includes(n)).length).toBeGreaterThan(0);
  });

  it('a genuinely loose end still gets its finish — the fix must not delete them all', () => {
    // NEGATIVE CONTROL. Suppressing every finish would pass the tests above and be wrong.
    const lone: Cell[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = openCell();
      if (y === 1 && (x === 1 || x === 2)) c.wallN = 'wall';   // a stub ending in open air
      lone.push(c);
    }
    expect(names(lone).filter((n) => n === 'wall_half_endcap').length).toBe(2);
  });
});
