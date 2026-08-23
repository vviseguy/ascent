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

describe('a run that meets a module does not cap itself into it', () => {
  /* Asserting on the SPANS meant re-deriving each mesh's authored origin — `wall` is centred at
     x[-2,2] while `wall_half` runs x[0,2] and `wall_endcap` x[0,1.07] — which is its own source of
     error. The bug is exact and needs no arithmetic: a cap is emitted AT the lattice point of a
     module, facing into it. Ask that directly. */
  const capPoints = (cs: Cell[], w = W, h = H): string[] => {
    const bad: string[] = [];
    for (const { x, y, placements } of gridPlacements(cs, w, h)) {
      for (const p of placements) {
        if (!p.url.includes('wall_endcap')) continue;
        // a cap is pushed at its run's end point; the emitting cell's NW corner is that point when the
        // offset is the cell-local corner, and the far end when it is offset along the run
        const px = x + (toFloat(p.x) > -0.5 ? 1 : 0), py = y + (toFloat(p.z) > -0.5 ? 1 : 0);
        if (moduleAxis(cs, w, h, px, py)) bad.push(`cap at (${px},${py}) where a module is drawn`);
      }
    }
    return bad;
  };

  it('no endcap lands on a point where a module is drawn', () => {
    expect(capPoints(run('doorway'))).toEqual([]);
  });

  it('...for every module type, not only the walk-through ones', () => {
    const bad = WALL_TYPES.filter((t) => t !== 'solid').flatMap((wt) => capPoints(run(wt)));
    expect(bad).toEqual([]);
  });

  it('a genuinely loose end still gets its cap — the fix must not delete them all', () => {
    // NEGATIVE CONTROL. Suppressing every cap would pass the two tests above and be wrong.
    const lone: Cell[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = openCell();
      if (y === 1 && (x === 1 || x === 2)) c.wallN = 'wall';   // a stub ending in open air
      lone.push(c);
    }
    expect(names(lone).filter((n) => n === 'wall_endcap').length).toBeGreaterThan(0);
  });
});
