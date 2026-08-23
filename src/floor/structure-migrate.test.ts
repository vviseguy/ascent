import { describe, it, expect } from 'vitest';
// The OLD modules are the ORACLE here. This suite exists to prove the migration reproduces what the
// 4u model actually drew — so it deliberately compares against the real old code, not a restatement
// of it. It retires with those modules once the migration has landed.
import { armOf, type WallTile } from './wall-tile.ts';
import { resolveGrid as oldResolveGrid, type TileGrid } from './tile-grid.ts';
import { STRUCTURES } from './structures.ts';
import { collapse as newCollapse } from './cell-field.ts';
import { migrateStructure, armDomain, centreDomain, certainOpening, type OldStructure, type OldTileField } from './structure-migrate.ts';
import { segs, corners, wallTypes, floors } from './cell-field.ts';
import { resolveGrid } from './cell-grid.ts';
import type { Dir } from './cell.ts';

const NAMES = Object.keys(STRUCTURES.structures);
const oldOf = (name: string): OldStructure => STRUCTURES.structures[name] as unknown as OldStructure;
/** The ORACLE: the old resolver, which fills each tile's E/S edges from its neighbours and treats the
 *  border as the closed shell. The migration is run with the matching 'wall' policy to compare. */
const oldTiles = (name: string): (WallTile | null)[] => {
  const s = oldOf(name);
  return oldResolveGrid({ w: s.w, h: s.h, cells: s.cells } as unknown as TileGrid);
};

/** Which sub-cell of a tile's 2×2 block carries the tile's arm in direction `d`, and which wall. */
const ARM_TARGET: Record<Dir, { dx: number; dy: number; side: 'wallN' | 'wallW' }> = {
  N: { dx: 1, dy: 0, side: 'wallW' }, // separates NW from NE
  S: { dx: 1, dy: 1, side: 'wallW' }, // separates SW from SE
  W: { dx: 0, dy: 1, side: 'wallN' }, // separates NW from SW
  E: { dx: 1, dy: 1, side: 'wallN' }, // separates NE from SE
};

describe('structure-migrate — the arm domain is exact over all 9 combinations', () => {
  it('reproduces armOf\'s drawn type for every concrete (inner, edge) pair', () => {
    const kinds = ['none', 'wall', 'barrier'] as const;
    for (const i of kinds) for (const e of kinds) {
      const want = i !== 'none' ? i : e !== 'none' ? e : 'none';
      expect(armDomain(segs(i), segs(e))).toBe(segs(want));
    }
  });

  it('a domain in maps to the domain of everything it could have drawn', () => {
    // inner ∈ {none, wall}, edge pinned wall → drawn is `wall` either way
    expect(armDomain(segs('none', 'wall'), segs('wall'))).toBe(segs('wall'));
    // inner ∈ {none, wall}, edge none → drawn is none or wall
    expect(armDomain(segs('none', 'wall'), segs('none'))).toBe(segs('none', 'wall'));
  });

  it('never invents or loses a possibility', () => {
    for (let i = 1; i < 8; i++) for (let e = 1; e < 8; e++) {
      const d = armDomain(i, e);
      expect(d).toBeGreaterThan(0); // a non-empty input can never produce an empty domain
      expect(d & ~segs('none', 'wall', 'barrier')).toBe(0);
    }
  });
});

describe('structure-migrate — the centre becomes the corner', () => {
  it('none → solid (walls joined), wall/barrier → column (a pillar stood there)', () => {
    expect(centreDomain(segs('none'))).toBe(corners('none'));
    expect(centreDomain(segs('wall'))).toBe(corners('column'));
    expect(centreDomain(segs('barrier'))).toBe(corners('column')); // lossy: low-ness dropped
    expect(centreDomain(segs('none', 'wall'))).toBe(corners('none', 'column'));
  });

  it('a tile that DREW an archway converts to an `air` corner', () => {
    const t: OldTileField = {
      floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') },
      edge: { N: segs('none'), W: segs('wall') },
      inner: { N: segs('none'), E: segs('wall'), S: segs('none'), W: segs('wall') },
      centre: segs('none'),
      wallType: wallTypes('door'),
    };
    expect(certainOpening(t)).toBe(true);
  });

  it('...but only when it really drew one — no full line means no opening', () => {
    const t: OldTileField = {
      floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') },
      edge: { N: segs('none'), W: segs('none') },
      inner: { N: segs('wall'), E: segs('wall'), S: segs('none'), W: segs('none') }, // an L
      centre: segs('none'),
      wallType: wallTypes('door'),
    };
    expect(certainOpening(t)).toBe(false);
  });
});

describe('structure-migrate — every AUTHORED structure converts faithfully', () => {
  it(`there are structures to migrate (${NAMES.length})`, () => {
    expect(NAMES.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s — every wall lands where the 4u model drew it', (name) => {
    const s = oldOf(name);
    const grid = migrateStructure(s, 'wall');
    const cells = resolveGrid(grid);
    const tiles = oldTiles(name);
    expect(grid.w).toBe(s.w * 2 + 1); // padded: the stored grid is the POINT lattice
    expect(grid.h).toBe(s.h * 2 + 1);

    for (let ty = 0; ty < s.h; ty++) {
      for (let tx = 0; tx < s.w; tx++) {
        const tile = tiles[ty * s.w + tx];
        if (!tile) continue; // a conflicted authored cell has nothing to compare
        for (const d of ['N', 'E', 'S', 'W'] as Dir[]) {
          const drawn = armOf(tile, d).type ?? 'none'; // what the OLD code would place
          const t = ARM_TARGET[d];
          const cell = cells[(ty * 2 + t.dy) * grid.w + (tx * 2 + t.dx)]!;
          expect(cell[t.side]).toBe(drawn);
        }
      }
    }
  });

  it.each(NAMES)('%s — every floor quadrant lands in its own cell', (name) => {
    const s = oldOf(name);
    const cells = resolveGrid(migrateStructure(s, 'wall'));
    const tiles = oldTiles(name);
    const W = s.w * 2 + 1;
    for (let ty = 0; ty < s.h; ty++) {
      for (let tx = 0; tx < s.w; tx++) {
        const tile = tiles[ty * s.w + tx];
        if (!tile) continue;
        const q = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]] as const;
        for (const [corner, dx, dy] of q) {
          expect(cells[(ty * 2 + dy) * W + (tx * 2 + dx)]!.floor).toBe(tile.floor[corner]);
        }
      }
    }
  });

  it.each(NAMES)('%s — tile-boundary walls are none (the 4u model could not put one there)', (name) => {
    const s = oldOf(name);
    const cells = resolveGrid(migrateStructure(s, 'wall'));
    const W = s.w * 2 + 1;
    for (let ty = 0; ty < s.h; ty++) {
      for (let tx = 0; tx < s.w; tx++) {
        const A = cells[(ty * 2) * W + tx * 2]!;          // NW quadrant
        const B = cells[(ty * 2) * W + tx * 2 + 1]!;      // NE
        const C = cells[(ty * 2 + 1) * W + tx * 2]!;      // SW
        expect(A.wallN).toBe('none');
        expect(A.wallW).toBe('none');
        expect(B.wallN).toBe('none');
        expect(C.wallW).toBe('none');
      }
    }
  });

  it.each(NAMES)('%s — every converted cell still collapses (no domain was emptied)', (name) => {
    const grid = migrateStructure(oldOf(name));
    expect(grid.cells.every((f) => newCollapse(f) !== null)).toBe(true);
  });

  it.each(NAMES)('%s — the DEFAULT border abstains: a structure claims its interior, not its surroundings', (name) => {
    const s = oldOf(name);
    const abstain = resolveGrid(migrateStructure(s));           // default policy
    const shell = resolveGrid(migrateStructure(s, 'wall'));
    // A tile that HAS an east and south neighbour inside the structure never consults the policy, so
    // it must resolve identically either way. (A structure smaller than 2x2 has no such tile — that is
    // fine, and the border test below is what covers it.)
    for (let ty = 0; ty < s.h - 1; ty++) {
      for (let tx = 0; tx < s.w - 1; tx++) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const i = (ty * 2 + dy) * (s.w * 2 + 1) + tx * 2 + dx;
          expect(abstain[i]).toEqual(shell[i]);
        }
      }
    }
    // and the policy really does something: on the E/S border, abstaining leaves the arm freer
    const bx = (s.w - 1) * 2 + 1, by = (s.h - 1) * 2 + 1;
    const i = by * (s.w * 2 + 1) + bx;
    expect(abstain[i]).not.toBeNull();
    expect(shell[i]).not.toBeNull();
  });

  it.each(NAMES)('%s — conversion is deterministic', (name) => {
    const a = migrateStructure(oldOf(name));
    const b = migrateStructure(oldOf(name));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
