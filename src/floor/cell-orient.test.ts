import { describe, it, expect } from 'vitest';
import { orientStructure, orientedSize, ORIENTATIONS, mapCell, mapPoint, type Orientation } from './cell-orient.ts';
import { listStructures, getStructure, type CellStructure } from './cell-structures.ts';
import { collapse, segs, floors, corners, wallTypes, template, fullField } from './cell-field.ts';
import { buildCellGraph, reachableFromSet } from './cell-graph.ts';
import type { Cell } from './cell.ts';

const NAMES = listStructures();
const st = (n: string): CellStructure => getStructure(n)!;

/** How many walls a structure actually carries — the quantity a re-homing bug destroys. */
const wallCount = (s: CellStructure): number => {
  let n = 0;
  for (const f of s.cells) {
    if ((f.wallN & segs('none')) === 0 || f.wallN !== fullField().wallN) n += f.wallN !== segs('none') ? 1 : 0;
    if (f.wallW !== segs('none')) n += 1;
  }
  return n;
};
/** Precise version: count fields that CANNOT be `none`, i.e. a wall is definitely there. */
const definiteWalls = (s: CellStructure): number => {
  let n = 0;
  for (const f of s.cells) {
    if ((f.wallN & segs('none')) === 0) n++;
    if ((f.wallW & segs('none')) === 0) n++;
  }
  return n;
};

/** The multiset of connected-component sizes — invariant under any rotation or mirror. */
const componentSizes = (s: CellStructure): number[] => {
  /* Over the FLOOR EXTENT — the w×h real cells. Two ways to get this wrong, and the original managed
     the first: `cells` is the (w+1)-wide POINT LATTICE, so reading it at stride `w` walks diagonally
     through the array and reports a connectivity no structure has. It survived on the big structures
     by luck and fell over on the first 3×3 one.
     Re-striding alone is not enough either. The padding row and column are BORDERS, not places, and
     they sit at max-x/max-y no matter how the structure is turned — so a lattice-wide component count
     is not orientation-invariant even when the orienter is perfect. The extent has to be sliced out. */
  const lw = s.w + 1;
  const cells: (Cell | null)[] = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) cells.push(collapse(s.cells[y * lw + x]!));
  const g = buildCellGraph(cells, s.w, s.h);
  const seen = new Array<boolean>(s.w * s.h).fill(false);
  const sizes: number[] = [];
  for (let i = 0; i < s.w * s.h; i++) {
    if (seen[i]) continue;
    const comp = reachableFromSet(g, [i]);
    let n = 0;
    comp.forEach((v, j) => { if (v) { seen[j] = true; n++; } });
    sizes.push(n);
  }
  return sizes.sort((a, b) => a - b);
};

describe('cell-orient — the coordinate maps', () => {
  it('the identity orientation changes nothing', () => {
    for (const n of NAMES) {
      expect(JSON.stringify(orientStructure(st(n), { turn: 0, flip: false }))).toBe(JSON.stringify(st(n)));
    }
  });

  it('an odd number of quarter-turns swaps the dimensions', () => {
    expect(orientedSize(3, 7, { turn: 0, flip: false })).toEqual({ w: 3, h: 7 });
    expect(orientedSize(3, 7, { turn: 1, flip: false })).toEqual({ w: 7, h: 3 });
    expect(orientedSize(3, 7, { turn: 2, flip: false })).toEqual({ w: 3, h: 7 });
    expect(orientedSize(3, 7, { turn: 3, flip: true })).toEqual({ w: 7, h: 3 });
  });

  it('cells map bijectively — no two land on the same square', () => {
    for (const o of ORIENTATIONS) {
      const seen = new Set<string>();
      for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
        const c = mapCell(x, y, 3, 5, o);
        expect(seen.has(`${c.x},${c.y}`)).toBe(false);
        seen.add(`${c.x},${c.y}`);
      }
      expect(seen.size).toBe(15);
    }
  });

  it('points map bijectively too, over the one-larger lattice', () => {
    for (const o of ORIENTATIONS) {
      const seen = new Set<string>();
      for (let y = 0; y <= 5; y++) for (let x = 0; x <= 3; x++) {
        const p = mapPoint(x, y, 3, 5, o);
        seen.add(`${p.x},${p.y}`);
      }
      expect(seen.size).toBe(4 * 6);
    }
  });
});

describe('cell-orient — round trips', () => {
  it('four quarter-turns is the identity', () => {
    for (const n of NAMES) {
      let s = st(n);
      for (let i = 0; i < 4; i++) s = orientStructure(s, { turn: 1, flip: false });
      expect(JSON.stringify(s)).toBe(JSON.stringify(st(n)));
    }
  });

  it('flipping twice is the identity', () => {
    for (const n of NAMES) {
      const once = orientStructure(st(n), { turn: 0, flip: true });
      expect(JSON.stringify(orientStructure(once, { turn: 0, flip: true }))).toBe(JSON.stringify(st(n)));
    }
  });
});

describe('cell-orient — NOTHING IS LOST', () => {
  it.each(NAMES)('%s — every orientation keeps the same number of definite walls', (n) => {
    const want = definiteWalls(st(n));
    for (const o of ORIENTATIONS) {
      expect({ o, walls: definiteWalls(orientStructure(st(n), o)) }).toEqual({ o, walls: want });
    }
    void wallCount;
  });

  it.each(NAMES)('%s — every orientation preserves the connectivity structure', (n) => {
    const want = JSON.stringify(componentSizes(st(n)));
    for (const o of ORIENTATIONS) {
      expect(JSON.stringify(componentSizes(orientStructure(st(n), o)))).toBe(want);
    }
  });

  it.each(NAMES)('%s — every oriented cell still collapses', (n) => {
    for (const o of ORIENTATIONS) {
      expect(orientStructure(st(n), o).cells.every((f) => collapse(f) !== null)).toBe(true);
    }
  });
});

describe('cell-orient — a wall really does change axis', () => {
  /** A 2×2-floor structure: stored as the 3×3 POINT lattice. `at` names a point. */
  const fixture = (at: [number, number], f: ReturnType<typeof template>): CellStructure => {
    const cells = Array.from({ length: 9 }, fullField);
    cells[at[1] * 3 + at[0]] = f;
    return { w: 2, h: 2, cells };
  };

  it('a north wall becomes a west wall under a quarter-turn', () => {
    // one wall: the edge running EAST from point (0,1) — horizontal
    const s = fixture([0, 1], template({ wallN: segs('wall') }));
    const turned = orientStructure(s, { turn: 1, flip: false });
    const vertical = turned.cells.filter((f) => f.wallW === segs('wall')).length;
    const horizontal = turned.cells.filter((f) => f.wallN === segs('wall')).length;
    expect(vertical).toBe(1);   // it is now a vertical segment
    expect(horizontal).toBe(0);
  });

  it('a corner travels with its POINT, not its cell index', () => {
    const s = fixture([1, 1], template({ corner: corners('none'), wallType: wallTypes('door') }));
    for (const o of ORIENTATIONS) {
      const t = orientStructure(s, o);
      expect(t.cells.filter((f) => f.corner === corners('none')).length).toBe(1);
      expect(t.cells.filter((f) => f.wallType === wallTypes('door')).length).toBe(1);
    }
  });

  it('floor travels with its cell', () => {
    const s = fixture([0, 0], template({ floor: floors('wood') }));
    for (const o of ORIENTATIONS) {
      expect(orientStructure(s, o).cells.filter((f) => f.floor === floors('wood')).length).toBe(1);
    }
  });
});
