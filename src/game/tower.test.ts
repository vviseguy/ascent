/**
 * src/game/tower.test.ts — compileTower's enlarged footprint + the read-only
 * per-stratum LAYOUT GRID (cellGrid) the renderer consumes to place dungeon tiles.
 *
 * The collision behaviour is proven exhaustively by src/game/prove.ts (PROOF 7/8);
 * these tests guard the SIZE bump and the new cellGrid accessor shape so the renderer
 * can rely on it.
 */

import { describe, it, expect } from 'vitest';
import { generateFloor } from '../floor/generate.ts';
import { compileTower, CELL_SIZE, stairRunRows } from './tower.ts';
import { fromInt, toFloat, fromRaw } from '../sim/fixed/fixed.ts';

// raw Q16.16 int -> float meters (cellGrid coords are raw Fixed by convention)
const RAW = (raw: number): number => toFloat(fromRaw(raw));

function tower(seed: bigint, numStrata = 5, gridSize = 5) {
  const floors = [];
  for (let s = 0; s < numStrata; s++) {
    floors.push(generateFloor({ gridSize, openness: 0.35, guaranteedRoutes: 2, seed, stratumIndex: s }));
  }
  return compileTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) });
}

describe('tower footprint is clearly larger than the original', () => {
  it('CELL_SIZE makes a 5x5 grid >= ~22 units across (>= 2.2x the original 15u)', () => {
    const cs = toFloat(CELL_SIZE);
    expect(cs).toBeGreaterThanOrEqual(4.5 - 1e-6);
    const across = cs * 5; // game's 5-wide grid
    expect(across).toBeGreaterThanOrEqual(22); // target ~22-24u
    // area ratio vs original 15x15
    expect((across * across) / (15 * 15)).toBeGreaterThanOrEqual(2.2);
  });
});

describe('cellGrid layout accessor (renderer tile placement)', () => {
  it('exposes one StratumCellGrid per stratum with a dense row-major cells array', () => {
    const t = tower(0x5a17ed_1234n, 5);
    expect(t.cellGrid).toBeDefined();
    expect(t.cellGrid!.length).toBe(5);
    for (let idx = 0; idx < 5; idx++) {
      const g = t.cellGrid![idx]!;
      expect(g.stratum).toBe(idx);
      expect(g.width).toBe(5);
      expect(g.height).toBe(5);
      expect(g.cells.length).toBe(25);
      expect(RAW(g.cellSize)).toBeCloseTo(4.5, 6);
      // surfaceY equals the stratum's walkable base
      expect(g.surfaceY).toBe(t.stratumBaseY[idx]);
      // row-major index == row*width + col, and matches the cell's own col/row
      g.cells.forEach((c, i) => {
        expect(i).toBe(c.row * g.width + c.col);
      });
    }
  });

  it('cell world centers line up with CELL_SIZE-spaced, origin-centered grid', () => {
    const t = tower(11n, 3);
    const g = t.cellGrid![0]!;
    const cs = RAW(g.cellSize);
    const offX = ((g.width - 1) / 2) | 0;
    const offZ = ((g.height - 1) / 2) | 0;
    for (const c of g.cells) {
      expect(RAW(c.cx)).toBeCloseTo((c.col - offX) * cs, 5);
      expect(RAW(c.cz)).toBeCloseTo((c.row - offZ) * cs, 5);
    }
  });

  it('every cell carries a valid CellType and roomId', () => {
    const t = tower(11n, 3, 10);
    const valid = new Set(['ROOM', 'CORRIDOR', 'DOORWAY', 'WALL', 'VOID']);
    for (const c of t.cellGrid![0]!.cells) {
      expect(valid.has(c.type)).toBe(true);
      expect(typeof c.roomId).toBe('number');
      expect(typeof c.wallMask).toBe('number');
      expect(c.wallMask).toBeGreaterThanOrEqual(0);
      expect(c.wallMask).toBeLessThanOrEqual(15);
    }
  });

  it('marks the ascent hole and stair footprints, and never walls their seams', () => {
    const t = tower(0x5a17ed_1234n, 5);
    // the straight stair runs across 2 columns × stairRunRows() rows; the ascent hole
    // (carved in the stratum above) and the stair footprint are both that many cells.
    const footprint = 2 * stairRunRows();
    // stratum 1+ have an ascent hole (over the stratum-below stair run)
    const holes = t.cellGrid![1]!.cells.filter((c) => c.hole);
    expect(holes.length).toBe(footprint);
    for (const h of holes) expect(h.wallMask).toBe(0); // a hole has no walls (open shaft)
    // every non-top stratum has a stair footprint (2 cols × run rows)
    const stairCells = t.cellGrid![0]!.cells.filter((c) => c.stair);
    expect(stairCells.length).toBe(footprint);
    for (const s of stairCells) expect(s.wallMask).toBe(0);
  });

  it('is deterministic: same seed => identical cellGrid', () => {
    const a = tower(42n, 4);
    const b = tower(42n, 4);
    expect(JSON.stringify(a.cellGrid)).toEqual(JSON.stringify(b.cellGrid));
  });

  it('varies by seed: different seeds => different cell-type layouts', () => {
    const a = tower(1n, 3, 10).cellGrid![0]!.cells.map((c) => c.type).join('');
    const b = tower(2n, 3, 10).cellGrid![0]!.cells.map((c) => c.type).join('');
    expect(a).not.toEqual(b);
  });

  it('backward compat: terrain/stratumBaseY/entryXZ/stairs still present', () => {
    const t = tower(7n, 5);
    expect(t.terrain.solids.length).toBeGreaterThan(0);
    expect(t.stratumBaseY.length).toBe(5);
    expect(t.entryXZ.length).toBe(5);
    expect(t.stairs.length).toBe(4);
  });
});
