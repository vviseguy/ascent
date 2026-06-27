/**
 * src/floor/blueprint.test.ts — Layer ① Blueprint builder (src/floor/blueprint.ts).
 *
 * Pins the square-grid promotion of a Floor: lattice dims/parity, the cell→FLOOR/VOID mapping,
 * the safe outer WALL shell, OPEN lanes on real graph edges, CORNER walls cross-checked against
 * the (tested) WallGrid posts, and full determinism. We deliberately cross-check the LANE/CORNER
 * mappings against `buildWallGrid` directly — the Blueprint is a faithful promotion of it, so any
 * drift between the two is a bug.
 */

import { describe, it, expect } from 'vitest';
import { generateFloor } from './generate.ts';
import { buildBlueprint } from './blueprint.ts';
import { roleAt, cellSquare, sqIndex, classAt, type Blueprint } from './wall-model.ts';
import { buildWallGrid } from './wallgrid.ts';
import { cellXY, type Floor } from './types.ts';

/** A representative spread of seeds × sizes. */
const SEEDS: readonly bigint[] = [0x5a17ed_1234n, 0x5a17ed_5678n, 0xdecafn];
const SIZES: readonly number[] = [5, 8, 12];

function makeFloor(seed: bigint, gridSize: number): Floor {
  return generateFloor({ seed, gridSize, openness: 0.4, guaranteedRoutes: 2 });
}

describe('buildBlueprint', () => {
  it('1. dims: bw=2W+1, bh=2H+1, dense arrays sized bw*bh', () => {
    for (const seed of SEEDS) {
      for (const size of SIZES) {
        const floor = makeFloor(seed, size);
        const W = floor.width, H = floor.height;
        const bp = buildBlueprint(floor);
        expect(bp.bw).toBe(2 * W + 1);
        expect(bp.bh).toBe(2 * H + 1);
        expect(bp.cellW).toBe(W);
        expect(bp.cellH).toBe(H);
        expect(bp.cells.length).toBe(bp.bw * bp.bh);
        expect(bp.roles.length).toBe(bp.bw * bp.bh);
      }
    }
  });

  it('2. roleAt parity is right: CELL odd-odd, CORNER even-even, LANE otherwise', () => {
    const floor = makeFloor(SEEDS[0]!, 8);
    const bp = buildBlueprint(floor);
    for (let row = 0; row < bp.bh; row++) {
      for (let col = 0; col < bp.bw; col++) {
        const role = bp.roles[sqIndex(bp, col, row)]!;
        expect(role).toBe(roleAt(col, row));
        const ce = col % 2 === 0, re = row % 2 === 0;
        if (!ce && !re) expect(role).toBe('CELL');
        else if (ce && re) expect(role).toBe('CORNER');
        else expect(role).toBe('LANE');
      }
    }
  });

  it('3. FLOOR program cell → FLOOR square; VOID/WALL cell → VOID square', () => {
    for (const seed of SEEDS) {
      const floor = makeFloor(seed, 12);
      const W = floor.width;
      const bp = buildBlueprint(floor);
      let sawFloor = false, sawVoidOrWall = false;
      for (const c of floor.cells) {
        const { x, y } = cellXY(W, c.id);
        const sq = cellSquare(x, y);
        const cls = classAt(bp, sq.col, sq.row);
        const t = c.cellType ?? 'ROOM';
        if (t === 'VOID' || t === 'WALL') {
          expect(cls).toBe('VOID');
          sawVoidOrWall = true;
        } else {
          expect(cls).toBe('FLOOR');
          sawFloor = true;
        }
      }
      // Sanity: a real dungeon floor has both walkable cells and un-roomed VOID/WALL cells.
      expect(sawFloor).toBe(true);
      expect(sawVoidOrWall).toBe(true);
    }
  });

  it('4. every OUTER-BOUNDARY lane square is WALL (the safe shell)', () => {
    for (const seed of SEEDS) {
      for (const size of SIZES) {
        const floor = makeFloor(seed, size);
        const W = floor.width, H = floor.height;
        const bp = buildBlueprint(floor);
        // vertical boundary lanes: col ∈ {0, 2W} on odd rows.
        for (let row = 1; row < bp.bh; row += 2) {
          expect(classAt(bp, 0, row)).toBe('WALL');
          expect(classAt(bp, 2 * W, row)).toBe('WALL');
        }
        // horizontal boundary lanes: row ∈ {0, 2H} on odd cols.
        for (let col = 1; col < bp.bw; col += 2) {
          expect(classAt(bp, col, 0)).toBe('WALL');
          expect(classAt(bp, col, 2 * H)).toBe('WALL');
        }
      }
    }
  });

  it('5. a WALK/GAP edge between two FLOOR cells → the lane square between them is OPEN', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const floor = makeFloor(seed, 12);
      const W = floor.width;
      const bp = buildBlueprint(floor);
      const isFloor = (id: number): boolean => {
        const t = floor.cells[id]!.cellType ?? 'ROOM';
        return t !== 'VOID' && t !== 'WALL';
      };
      for (const e of floor.edges) {
        if (e.kind !== 'WALK' && e.kind !== 'GAP') continue;
        if (!isFloor(e.a) || !isFloor(e.b)) continue;
        const A = cellXY(W, e.a), B = cellXY(W, e.b);
        // the lane square sits at the midpoint of the two cell squares.
        const sa = cellSquare(A.x, A.y), sb = cellSquare(B.x, B.y);
        const col = (sa.col + sb.col) / 2;
        const row = (sa.row + sb.row) / 2;
        expect(roleAt(col, row)).toBe('LANE');
        expect(classAt(bp, col, row)).toBe('OPEN');
        checked++;
      }
    }
    // Make sure we actually exercised the assertion (not a vacuous pass).
    expect(checked).toBeGreaterThan(0);
  });

  it('6. determinism: same floor builds identical cells/roles arrays', () => {
    for (const seed of SEEDS) {
      const floor = makeFloor(seed, 8);
      const a = buildBlueprint(floor);
      const b = buildBlueprint(floor);
      expect(a.cells).toEqual(b.cells);
      expect(a.roles).toEqual(b.roles);
    }
  });

  it('7. CORNER squares are WALL iff the WallGrid post kind ≠ NONE', () => {
    for (const seed of SEEDS) {
      for (const size of SIZES) {
        const floor = makeFloor(seed, size);
        const W = floor.width;
        const bp = buildBlueprint(floor);
        const wg = buildWallGrid(floor);
        for (let row = 0; row < bp.bh; row += 2) {
          for (let col = 0; col < bp.bw; col += 2) {
            expect(roleAt(col, row)).toBe('CORNER');
            const post = wg.posts[(col / 2) + (row / 2) * (W + 1)]!;
            const expected = post.kind !== 'NONE' ? 'WALL' : 'VOID';
            expect(classAt(bp, col, row)).toBe(expected);
          }
        }
      }
    }
  });
});
