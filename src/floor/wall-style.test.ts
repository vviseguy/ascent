/**
 * src/floor/wall-style.test.ts — unit tests for the ② STYLE layer.
 *
 * We hand-build tiny `Blueprint` objects (we own the contract) to exercise piece selection in
 * isolation — corners, tees, crosses, caps, pillars, doorways, straight-run axis, variants — plus
 * a determinism check and ONE end-to-end smoke test wired to the real generator + blueprint
 * builder (guarded so it skips if the sibling module isn't present yet).
 */

import { describe, it, expect } from 'vitest';
import { makeStyle } from './wall-style.ts';
import type { Blueprint, Placement, SquareClass } from './wall-model.ts';
import { DIR_E, DIR_W, DIR_N, DIR_S, roleAt, PIECE_KINDS, VARIANTS } from './wall-model.ts';

/* ----------------------------------- blueprint builders ----------------------------------- */

/**
 * Build a Blueprint from a row-major map of classes for a (2W+1)×(2H+1) lattice. `rows` is given
 * TOP-of-array = row 0 for readability; roles are derived from parity via `roleAt`.
 */
function bp(cellW: number, cellH: number, rows: SquareClass[][]): Blueprint {
  const bw = 2 * cellW + 1;
  const bh = 2 * cellH + 1;
  const cells: SquareClass[] = [];
  const roles: Blueprint['roles'] = [];
  for (let row = 0; row < bh; row++) {
    const r = rows[row]!;
    for (let col = 0; col < bw; col++) {
      cells.push(r[col]!);
      roles.push(roleAt(col, row));
    }
  }
  return { bw, bh, cellW, cellH, cells, roles };
}

/** Find the single placement anchored at (col,row), or undefined. */
function at(out: Placement[], col: number, row: number): Placement | undefined {
  return out.find((p) => p.col === col && p.row === row);
}

const style = makeStyle();

/* ----------------------------------- 1-cell ring ----------------------------------- */

describe('1-cell room ringed by walls', () => {
  // bw=bh=3. Cell at (1,1)=FLOOR. The 8-square ring is all WALL.
  const F: SquareClass = 'FLOOR';
  const W: SquareClass = 'WALL';
  const ring = bp(1, 1, [
    [W, W, W],
    [W, F, W],
    [W, W, W],
  ]);
  const out = style.realize(ring, 1n);

  it('classifies the four even-even squares as CORNER pieces', () => {
    for (const [c, r] of [
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2],
    ] as const) {
      const p = at(out, c, r);
      expect(p, `corner @ ${c},${r}`).toBeDefined();
      expect(p!.piece).toBe('CORNER');
    }
  });

  it('the corner dirs point at the two adjoining lanes (perpendicular)', () => {
    // bottom-left (0,0): lanes E=(1,0) and N=(0,1) are walls → DIR_E|DIR_N.
    expect(at(out, 0, 0)!.dirs).toBe(DIR_E | DIR_N);
    // top-right (2,2): lanes W=(1,2) and S=(2,1) → DIR_W|DIR_S.
    expect(at(out, 2, 2)!.dirs).toBe(DIR_W | DIR_S);
  });

  it('classifies the edge LANE squares as STRAIGHT runs with the right axis', () => {
    // horizontal lanes (odd col, even row): (1,0) and (1,2) → axis X.
    expect(at(out, 1, 0)!.piece).toBe('STRAIGHT');
    expect(at(out, 1, 0)!.axis).toBe('X');
    expect(at(out, 1, 2)!.axis).toBe('X');
    // vertical lanes (even col, odd row): (0,1) and (2,1) → axis Z.
    expect(at(out, 0, 1)!.piece).toBe('STRAIGHT');
    expect(at(out, 0, 1)!.axis).toBe('Z');
    expect(at(out, 2, 1)!.axis).toBe('Z');
  });

  it('STRAIGHT runs carry dirs 0 and span 1', () => {
    const s = at(out, 1, 0)!;
    expect(s.dirs).toBe(0);
    expect(s.span).toBe(1);
  });

  it('emits no placement for the FLOOR cell square', () => {
    expect(at(out, 1, 1)).toBeUndefined();
  });
});

/* ----------------------------------- TEE ----------------------------------- */

describe('a T-junction (three wall lanes meeting a corner)', () => {
  // Center corner at (2,2). Lanes E=(3,2), W=(1,2), S=(2,1) are WALL; N=(2,3) is non-wall.
  // bw=bh=5 (W=H=2). The array's first element is lattice row 0 (DIR_N = +Z = higher row index).
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  const grid = bp(2, 2, [
    [V, V, V, V, V], // lattice row 0
    [V, V, W, V, V], // row 1: lane (2,1)=W  (S of corner)
    [V, W, W, W, V], // row 2: lanes (1,2)=W (3,2)=W, corner (2,2)=W
    [V, V, V, V, V], // row 3: (2,3) NOT a wall → no DIR_N
    [V, V, V, V, V], // lattice row 4
  ]);
  const out = style.realize(grid, 7n);

  it('the center corner is a TEE', () => {
    const p = at(out, 2, 2)!;
    expect(p.piece).toBe('TEE');
  });

  it('the TEE dirs are exactly E|W|S', () => {
    expect(at(out, 2, 2)!.dirs).toBe(DIR_E | DIR_W | DIR_S);
  });
});

/* ----------------------------------- CROSS ----------------------------------- */

describe('a cross (four wall lanes meeting a corner)', () => {
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  const grid = bp(2, 2, [
    [V, V, V, V, V],
    [V, V, W, V, V], // (2,3) N-lane
    [V, W, W, W, V], // (1,2)(2,2)(3,2)
    [V, V, W, V, V], // (2,1) S-lane
    [V, V, V, V, V],
  ]);
  const out = style.realize(grid, 3n);

  it('the center corner is a CROSS with all four dirs', () => {
    const p = at(out, 2, 2)!;
    expect(p.piece).toBe('CROSS');
    expect(p.dirs).toBe(DIR_E | DIR_W | DIR_N | DIR_S);
  });
});

/* ----------------------------------- CAP ----------------------------------- */

describe('a dead-end (one wall lane on a corner)', () => {
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  // Corner (2,2) with only its E-lane (3,2) a wall.
  const grid = bp(2, 2, [
    [V, V, V, V, V],
    [V, V, V, V, V],
    [V, V, W, W, V], // (2,2)=corner, (3,2)=E-lane
    [V, V, V, V, V],
    [V, V, V, V, V],
  ]);
  const out = style.realize(grid, 9n);

  it('the corner is a CAP pointing east', () => {
    const p = at(out, 2, 2)!;
    expect(p.piece).toBe('CAP');
    expect(p.dirs).toBe(DIR_E);
  });
});

/* ----------------------------------- PILLAR ----------------------------------- */

describe('an isolated wall corner with no lanes', () => {
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  const grid = bp(2, 2, [
    [V, V, V, V, V],
    [V, V, V, V, V],
    [V, V, W, V, V], // only the corner (2,2) is a wall; all four lanes are VOID
    [V, V, V, V, V],
    [V, V, V, V, V],
  ]);
  const out = style.realize(grid, 11n);

  it('the lone corner is a PILLAR with no dirs', () => {
    const p = at(out, 2, 2)!;
    expect(p.piece).toBe('PILLAR');
    expect(p.dirs).toBe(0);
  });
});

/* ----------------------------------- STRAIGHT through a corner ----------------------------------- */

describe('a corner with a collinear pair becomes a STRAIGHT', () => {
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  // Corner (2,2) with E=(3,2) and W=(1,2) walls (collinear) → STRAIGHT axis X passing through.
  const grid = bp(2, 2, [
    [V, V, V, V, V],
    [V, V, V, V, V],
    [V, W, W, W, V],
    [V, V, V, V, V],
    [V, V, V, V, V],
  ]);
  const out = style.realize(grid, 13n);

  it('the corner emits a STRAIGHT (axis X, dirs 0)', () => {
    const p = at(out, 2, 2)!;
    expect(p.piece).toBe('STRAIGHT');
    expect(p.axis).toBe('X');
    expect(p.dirs).toBe(0);
  });

  it('a vertical collinear pair gives axis Z', () => {
    const gridZ = bp(2, 2, [
      [V, V, V, V, V],
      [V, V, W, V, V], // (2,3) N
      [V, V, W, V, V], // (2,2) corner
      [V, V, W, V, V], // (2,1) S
      [V, V, V, V, V],
    ]);
    const o = style.realize(gridZ, 13n);
    const p = at(o, 2, 2)!;
    expect(p.piece).toBe('STRAIGHT');
    expect(p.axis).toBe('Z');
  });
});

/* ----------------------------------- DOORWAY ----------------------------------- */

describe('doorways: OPEN lane that is a gap in a wall line', () => {
  const V: SquareClass = 'VOID';
  const W: SquareClass = 'WALL';
  const O: SquareClass = 'OPEN';
  const F: SquareClass = 'FLOOR';

  it('a horizontal OPEN lane flanked by E/W walls is a DOORWAY (axis X)', () => {
    // A doorway lives on a LANE square (one even coord). Horizontal lane (3,2) [odd col, even row]
    // is OPEN; its E=(4,2) and W=(2,2) corner neighbours are WALL → gap in a horizontal wall line.
    const grid = bp(2, 2, [
      [V, V, V, V, V],
      [V, V, V, V, V],
      [V, V, W, O, W], // row 2: (2,2)=W, (3,2)=O lane, (4,2)=W
      [V, V, V, V, V],
      [V, V, V, V, V],
    ]);
    const out = style.realize(grid, 5n);
    const p = at(out, 3, 2)!;
    expect(p.piece).toBe('DOORWAY');
    expect(p.axis).toBe('X');
    expect(p.doorId).toBe(-1);
    expect(p.variant).toBe('PLAIN');
  });

  it('a vertical OPEN lane flanked by N/S walls is a DOORWAY (axis Z)', () => {
    // Vertical lane (2,3) [even col, odd row] is OPEN; N=(2,4) and S=(2,2) corners are WALL.
    const grid = bp(2, 2, [
      [V, V, V, V, V],
      [V, V, V, V, V],
      [V, V, W, V, V], // row 2: (2,2)=W  (S of lane)
      [V, V, O, V, V], // row 3: (2,3)=O lane
      [V, V, W, V, V], // row 4: (2,4)=W  (N of lane)
    ]);
    const out = style.realize(grid, 5n);
    const p = at(out, 2, 3)!;
    expect(p.piece).toBe('DOORWAY');
    expect(p.axis).toBe('Z');
  });

  it('an OPEN lane inside a room (no flanking walls) emits nothing', () => {
    // Horizontal lane (3,2) OPEN with non-wall on its collinear sides → not a gap → no placement.
    const grid = bp(2, 2, [
      [V, V, V, V, V],
      [V, V, V, V, V],
      [V, V, F, O, F], // (2,2)=F, (3,2)=O lane, (4,2)=F
      [V, V, V, V, V],
      [V, V, V, V, V],
    ]);
    const out = style.realize(grid, 5n);
    expect(at(out, 3, 2)).toBeUndefined();
  });
});

/* ----------------------------------- variants / BROKEN ----------------------------------- */

describe('WALL_POSSIBLE variant mix', () => {
  const V: SquareClass = 'VOID';
  const P: SquareClass = 'WALL_POSSIBLE';

  it('a row of WALL_POSSIBLE lanes yields at least one BROKEN and at least one PLAIN', () => {
    // A long horizontal run of WALL_POSSIBLE LANE squares: build W=8,H=1 with row 0 (a LANE row,
    // even row) full of WALL_POSSIBLE so we get many lane squares hashed independently.
    const W8 = 8;
    const bw = 2 * W8 + 1;
    const rows: SquareClass[][] = [];
    for (let r = 0; r < 3; r++) {
      const row: SquareClass[] = [];
      for (let c = 0; c < bw; c++) row.push(r === 0 ? P : V);
      rows.push(row);
    }
    const grid = bp(W8, 1, rows);
    const out = style.realize(grid, 42n);
    // Collect variants of the LANE squares (odd col on row 0).
    const variants = out.filter((p) => p.row === 0 && p.col % 2 === 1).map((p) => p.variant);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants).toContain('BROKEN');
    expect(variants).toContain('PLAIN');
  });

  it('all emitted variants are members of VARIANTS and pieces of PIECE_KINDS', () => {
    const W8 = 8;
    const bw = 2 * W8 + 1;
    const rows: SquareClass[][] = [];
    for (let r = 0; r < 3; r++) {
      const row: SquareClass[] = [];
      for (let c = 0; c < bw; c++) row.push(r === 0 ? P : V);
      rows.push(row);
    }
    const out = style.realize(bp(W8, 1, rows), 42n);
    for (const p of out) {
      expect(VARIANTS).toContain(p.variant);
      expect(PIECE_KINDS).toContain(p.piece);
    }
  });
});

/* ----------------------------------- determinism ----------------------------------- */

describe('determinism', () => {
  const F: SquareClass = 'FLOOR';
  const W: SquareClass = 'WALL';
  const ring = bp(1, 1, [
    [W, W, W],
    [W, F, W],
    [W, W, W],
  ]);

  it('same (blueprint, seed) ⇒ deep-equal Placement[]', () => {
    const a = style.realize(ring, 99n);
    const b = style.realize(ring, 99n);
    expect(a).toEqual(b);
  });

  it('a fresh style instance produces the same output', () => {
    const a = makeStyle().realize(ring, 99n);
    const b = makeStyle().realize(ring, 99n);
    expect(a).toEqual(b);
  });

  it('different seeds may differ but stay structurally valid', () => {
    const a = style.realize(ring, 1n);
    const b = style.realize(ring, 2n);
    // Same number of pieces (structure is seed-independent), pieces identical, only variants vary.
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.piece).toBe(b[i]!.piece);
    }
  });
});

/* ----------------------------------- end-to-end smoke ----------------------------------- */

describe('end-to-end smoke (real generator + blueprint builder)', () => {
  it('realises a non-empty, valid Placement[] for a generated floor', async () => {
    let buildBlueprint: ((floor: unknown, opts?: unknown) => Blueprint) | undefined;
    let generateFloor: ((cfg: unknown) => unknown) | undefined;
    try {
      ({ buildBlueprint } = (await import('./blueprint.ts')) as {
        buildBlueprint: (floor: unknown, opts?: unknown) => Blueprint;
      });
      ({ generateFloor } = (await import('./generate.ts')) as {
        generateFloor: (cfg: unknown) => unknown;
      });
    } catch {
      // Sibling module not present yet — skip this one test; hand-built tests above still cover us.
      return;
    }
    if (!buildBlueprint || !generateFloor) return;

    const floor = generateFloor({ gridSize: 6, openness: 0.4, guaranteedRoutes: 2, seed: 1234n });
    const blueprint = buildBlueprint(floor);
    const out = makeStyle().realize(blueprint, 1234n);

    expect(out.length).toBeGreaterThan(0);
    for (const p of out) {
      expect(PIECE_KINDS).toContain(p.piece);
      expect(VARIANTS).toContain(p.variant);
    }
  });
});
