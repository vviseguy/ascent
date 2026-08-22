// The 2u tower compiler: does a generated 2u floor become terrain the sim can actually stand on?
import { describe, it, expect } from 'vitest';
import { fromInt, fromFloatConst, toFloat, toRaw } from '../sim/fixed/fixed.ts';
import { generateEmergent, generateEmergentTower } from '../floor/cell-emergent.ts';
import { resolveGrid } from '../floor/cell-grid.ts';
import { compileCellTower, cellCentre2u, cellWorldPlacements, wallMask2u, CELL_SIZE_2U, type CellFloor } from './cell-tower.ts';
import { FLOOR_HEIGHT } from './tower.ts';
import { summitRoute, CELL_PROBE } from './route-check.ts';
import type { Cell } from '../floor/cell.ts';

const W = 24, H = 20;
const makeFloor = (seed: bigint): CellFloor => {
  const r = generateEmergent({ width: W, height: H, seed });
  return { cells: resolveGrid(r.grid), width: W, height: H, entry: r.entry, exit: r.exit };
};
const PARAMS = { groundY: fromInt(0), killPlaneY: fromInt(-20) };

describe('cell-tower — a 2u floor becomes terrain', () => {
  const floors = [makeFloor(1n), makeFloor(2n), makeFloor(3n)];
  const t = compileCellTower(floors, 0, PARAMS);

  it('stacks the strata one 4.00 storey apart', () => {
    expect(t.stratumBaseY).toHaveLength(3);
    expect(t.stratumBaseY[0]).toBe(0);
    expect(t.stratumBaseY[1]).toBe(toRaw(FLOOR_HEIGHT));
    expect(t.stratumBaseY[2]).toBe(toRaw(FLOOR_HEIGHT) * 2);
  });

  it('emits a layout grid per stratum at the 2u cell size', () => {
    for (let i = 0; i < 3; i++) {
      const g = t.cellGrid![i]!;
      expect(g.width).toBe(W);
      expect(g.height).toBe(H);
      expect(g.cellSize).toBe(toRaw(CELL_SIZE_2U));
      expect(g.cells).toHaveLength(W * H);
      expect(g.wallPlacements.length).toBeGreaterThan(0);
    }
  });

  it('puts solid ground under the entry, so a body spawned there does not fall', () => {
    for (let i = 0; i < 3; i++) {
      const { x, z } = t.entryXZ[i]!;
      const surface = t.stratumBaseY[i]!;
      const under = t.terrain.solids.filter((b) =>
        b.minX <= x && x <= b.maxX && b.minZ <= z && z <= b.maxZ && b.maxY === surface);
      expect(under.length).toBeGreaterThan(0);
    }
  });

  it('takes the SHAFT from the schematic — a cell with no floor IS the hole', () => {
    // The 4u compiler computes holes from its synthetic stair because its floor graph cannot express
    // one. This does not, and must not: inferring a hole would override an author who deliberately
    // floored over something. `hole` is exactly "this cell has no walkable ground".
    for (const g of t.cellGrid!) {
      for (const c of g.cells) expect(c.hole).toBe(c.type === 'VOID' || c.type === 'WALL');
    }
    // and nothing solid is laid at a hole's surface
    const g0 = t.cellGrid![0]!;
    for (const c of g0.cells.filter((x) => x.hole)) {
      const capped = t.terrain.solids.some((b) =>
        b.minX < c.cx && c.cx < b.maxX && b.minZ < c.cz && c.cz < b.maxZ && b.maxY === g0.surfaceY);
      expect(capped).toBe(false);
    }
  });

  it('reports a flight that climbs into a floored-over ceiling', () => {
    // Single-storey structures paint no shaft, so today every flight is sealed. That is the honest
    // state of things and it is COUNTED — the fix is a structure that spans storeys, not a compiler
    // that punches holes behind the author's back.
    const flights = t.cellGrid!.slice(0, -1).reduce((n, g) => n + (g.cells.some((c) => c.stair) ? 1 : 0), 0);
    if (flights > 0) expect(Array.isArray(t.ceilingSealedFlights)).toBe(true);
    for (const s of t.ceilingSealedFlights) expect(s.cells).toBeGreaterThan(0);
  });

  it('reports a storey with NO WAY UP rather than inventing a staircase', () => {
    // whatever the seeds give, the claim has to hold: every non-top storey either contributes a
    // flight or is named. Silence would mean a tower you cannot climb and nothing saying so.
    for (let i = 0; i < floors.length - 1; i++) {
      const hasFlight = t.cellGrid![i]!.cells.some((c) => c.stair);
      expect(hasFlight || t.strataWithoutStairs.includes(i)).toBe(true);
    }
  });
});

describe('cell-tower — the geometry lines up', () => {
  it('centres the grid on the origin, two world units per cell', () => {
    expect(toFloat(cellCentre2u(4, 4, 0).x)).toBe(-2);   // (0 - 1) * 2
    expect(toFloat(cellCentre2u(4, 4, 5).x)).toBe(0);    // col 1
    expect(toFloat(cellCentre2u(4, 4, 5).z)).toBe(0);    // row 1
  });

  it('a placement lands INSIDE the cell that owns it', () => {
    const cells: (Cell | null)[] = Array.from({ length: 9 }, () => ({
      floor: 'stone', wallN: 'wall', wallW: 'wall', corner: 'solid', wallType: 'solid',
    } as Cell));
    const out = cellWorldPlacements(cells, 3, 3);
    const half = toFloat(CELL_SIZE_2U) / 2;
    for (const p of out) {
      // every piece sits within half a cell of SOME cell centre (walls sit on the boundary)
      const near = cells.some((_, i) => {
        const c = cellCentre2u(3, 3, i);
        return Math.abs(toFloat(fromInt(0)) + p.x / 65536 - toFloat(c.x)) <= half + 0.01
          && Math.abs(p.z / 65536 - toFloat(c.z)) <= half + 0.01;
      });
      expect(near).toBe(true);
    }
  });

  it('reads the wall mask straight off the 2u walls', () => {
    const open = (): Cell => ({ floor: 'stone', wallN: 'none', wallW: 'none', corner: 'air', wallType: 'solid' });
    const cells: (Cell | null)[] = Array.from({ length: 9 }, open);
    // a middle cell surrounded by floor with no walls faces nothing
    expect(wallMask2u(cells, 3, 3, 4)).toBe(0);
    // put a wall on its north side
    cells[4]!.wallN = 'wall';
    expect(wallMask2u(cells, 3, 3, 4) & 1).toBe(1);
    // and one on the cell to its EAST's west side — that is the middle cell's east face
    cells[5]!.wallW = 'wall';
    expect(wallMask2u(cells, 3, 3, 4) & 2).toBe(2);
    // a corner cell faces the edge of the world on two sides
    expect(wallMask2u(cells, 3, 3, 0) & 8).toBe(8);
    expect(wallMask2u(cells, 3, 3, 0) & 1).toBe(1);
  });

  it('ground pieces render but do not collide — the slab under them already does', () => {
    const cells: (Cell | null)[] = Array.from({ length: 4 }, () => ({
      floor: 'stone', wallN: 'none', wallW: 'none', corner: 'air', wallType: 'solid',
    } as Cell));
    for (const p of cellWorldPlacements(cells, 2, 2)) {
      if (p.unit.url.includes('floor_')) expect(p.unit.boxes).toEqual([]);
    }
  });
});


describe('cell-tower — the tower is CLIMBABLE, not merely built', () => {
  /* The whole chain, end to end: a two-storey stairwell placed across floors paints its own shaft,
     the compiler turns the flight into steps, and an independent route check walks entry -> top over
     the compiled AABBs. Every link has to hold or this fails. */
  const W = 40, H = 40, N = 4;
  const seeds = [0x5a17ed_1234n, 1000n, 8919n];

  it.each(seeds.map((s) => [String(s), s] as const))(
    'seed %s: every storey has a way up, every shaft is open, and the summit is reachable',
    (_label, seed) => {
      const stack = generateEmergentTower({ width: W, height: H, seed, levels: N });
      const floors: CellFloor[] = stack.floors.map((f) => ({
        cells: resolveGrid(f.grid), width: W, height: H, entry: f.entry, exit: f.exit,
      }));
      const t = compileCellTower(floors, 0, PARAMS);

      expect(stack.stats.storeysWithoutStairwell).toBe(0);
      expect(t.strataWithoutStairs).toEqual([]);
      expect(t.ceilingSealedFlights).toEqual([]);

      const r = summitRoute(t, CELL_PROBE);
      expect(r.ok, `${r.reason} (${r.reached}/${r.nodes} nodes)`).toBe(true);
    },
  );

  it('the route check is not vacuous — flooring the shafts breaks it', () => {
    const stack = generateEmergentTower({ width: W, height: H, seed: 1000n, levels: N });
    const floors: CellFloor[] = stack.floors.map((f) => ({
      cells: resolveGrid(f.grid), width: W, height: H, entry: f.entry, exit: f.exit,
    }));
    // fill every hole back in: now each flight climbs into a ceiling and nothing can get up
    for (const f of floors) {
      for (const c of f.cells) if (c && c.floor === 'none') c.floor = 'stone';
    }
    const sealed = compileCellTower(floors, 0, PARAMS);
    expect(sealed.ceilingSealedFlights.length).toBeGreaterThan(0);
    expect(summitRoute(sealed, CELL_PROBE).ok).toBe(false);
  });
});

void fromFloatConst;
