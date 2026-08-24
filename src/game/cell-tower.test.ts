// The 2u tower compiler: does a generated 2u floor become terrain the sim can actually stand on?
import { describe, it, expect } from 'vitest';
import { fromInt, fromFloatConst, toFloat, toRaw } from '../sim/fixed/fixed.ts';
import { generateEmergent, generateEmergentTower } from '../floor/cell-emergent.ts';
import { resolveGrid } from '../floor/cell-grid.ts';
import { compileCellTower, cellCentre2u, cellWorldPlacements, wallMask2u, CELL_SIZE_2U, type CellFloor } from './cell-tower.ts';
import { FLOOR_HEIGHT } from './tower.ts';
import { DIR_E, DIR_W, DIR_N, DIR_S } from '../floor/wallgrid.ts';
import { openCell } from '../floor/cell.ts';
import { summitRoute, CELL_PROBE } from './route-check.ts';
import type { Cell } from '../floor/cell.ts';
import type { AABB } from '../sim/collide/terrain.ts';

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
      floor: 'stone', wallN: 'wall', wallW: 'wall', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no',
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
    const open = (): Cell => ({ floor: 'stone', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no' });
    const cells: (Cell | null)[] = Array.from({ length: 9 }, open);
    // a middle cell surrounded by floor with no walls faces nothing
    expect(wallMask2u(cells, 3, 3, 4)).toBe(0);
    /* THIS TEST USED TO ENCODE THE WRONG ORDER, which is why it never caught the drift: it asserted
       north set bit 1 and east set bit 2, but the canonical language (`wallgrid.ts`) is 1 = +X east,
       2 = -X west, 4 = +Z south, 8 = -Z north. It agreed with the code and both disagreed with every
       consumer. */
    cells[4]!.wallN = 'wall';                       // the middle cell's NORTH face
    expect(wallMask2u(cells, 3, 3, 4) & DIR_S).toBe(DIR_S);   // wallgrid names -Z "south"
    cells[5]!.wallW = 'wall';                       // the cell to its EAST, west side = its east face
    expect(wallMask2u(cells, 3, 3, 4) & DIR_E).toBe(DIR_E);
    // a corner cell faces the edge of the world on two sides — west and north for cell 0
    // cell 0 is the NW corner: the world ends to its west (-X) and to its north (-Z)
    expect(wallMask2u(cells, 3, 3, 0) & DIR_W).toBe(DIR_W);
    expect(wallMask2u(cells, 3, 3, 0) & DIR_S).toBe(DIR_S);   // -Z, which wallgrid calls "south"
    expect(wallMask2u(cells, 3, 3, 0) & DIR_E).toBe(0);       // ...but not to its east
  });

  it('ground pieces render but do not collide — the slab under them already does', () => {
    const cells: (Cell | null)[] = Array.from({ length: 4 }, () => ({
      floor: 'stone', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no',
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

/** `wallgrid.ts` names +Z "north"; this file uses grid words, so alias to avoid a second mix-up. */
const DIR_S_CANON = DIR_N, DIR_N_CANON = DIR_S;

describe('wallMask2u speaks the canonical bit language', () => {
  /* The comment on `wallMask2u` used to CLAIM it matched `wallgrid`'s order while only bit 4 did, so
     the fog flood consulted the wrong wall on three of four directions. A claim in prose cannot fail;
     this can. One wall at a time, each asserted against the direction it actually faces. */
  const W = 3, H = 3;
  const grid = (mut: (c: Cell, x: number, y: number) => void): (Cell | null)[] => {
    const out: (Cell | null)[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
    return out;
  };
  const centre = 1 * W + 1;

  it.each([
    ['east  (+X)', DIR_E, (c: Cell, x: number, y: number) => { if (x === 2 && y === 1) c.wallW = 'wall'; }],
    ['west  (-X)', DIR_W, (c: Cell, x: number, y: number) => { if (x === 1 && y === 1) c.wallW = 'wall'; }],
    ['south (+Z)', DIR_S_CANON, (c: Cell, x: number, y: number) => { if (x === 1 && y === 2) c.wallN = 'wall'; }],
    ['north (-Z)', DIR_N_CANON, (c: Cell, x: number, y: number) => { if (x === 1 && y === 1) c.wallN = 'wall'; }],
  ])('a wall on the %s side sets exactly that bit', (_label, bit, mut) => {
    expect(wallMask2u(grid(mut), W, H, centre)).toBe(bit);
  });

  it('an open cell in open ground has no bits set at all', () => {
    expect(wallMask2u(grid(() => {}), W, H, centre)).toBe(0);
  });
});

describe('cell-tower — the collider and the mesh describe the SAME staircase', () => {
  /* A corner flight whose direction the STOREY ABOVE decides.
     2x2 of stairs at (1,1), walled north and west, with ground on both open sides — so the walls and
     the floor alone are symmetric and cannot choose. What breaks the tie is where the hole is, and
     that lives one storey up. */
  const flight = (): Cell[] => {
    const out: Cell[] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const c = openCell();
        c.floor = 'stone';
        if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs';
        if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
        if ((y === 1 || y === 2) && x === 1) c.wallW = 'wall';
        out.push(c);
      }
    }
    return out;
  };
  /** A deck that is void EXCEPT where it gives the flight somewhere to land — floor one cell past a
   *  head, which is what `above` contributes to the score now that the hole no longer steers. */
  const deckLandingAt = (landing: readonly [number, number][]): Cell[] => {
    const out: Cell[] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const c = openCell();
        c.floor = landing.some(([hx, hy]) => hx === x && hy === y) ? 'stone' : 'none';
        out.push(c);
      }
    }
    return out;
  };

  /** Which way the DRAWN mesh climbs, read back from its quarter-turn. Stairs rise toward -Z
   *  natively (measured — see `STAIR_TURN`), so turn t rotates that by t x 90 degrees. */
  const drawnDir = (turn: number): string => (['N', 'W', 'S', 'E'] as const)[((turn % 4) + 4) % 4]!;

  /** Which way the COLLIDER climbs: find the tallest step, and see which end of the block it sits at. */
  function collidedDir(solids: readonly { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }[],
    baseY: number): string {
    const steps = solids.filter((b) => Math.abs(b.minY - baseY) < 1e-6 && b.maxY > baseY + 0.1);
    expect(steps.length).toBeGreaterThan(0);
    const top = steps.reduce((a, b) => (b.maxY > a.maxY ? b : a));
    const cx = (top.minX + top.maxX) / 2, cz = (top.minZ + top.maxZ) / 2;
    const mid = steps.reduce((a, b) => a + (b.minX + b.maxX) / 2, 0) / steps.length;
    const midZ = steps.reduce((a, b) => a + (b.minZ + b.maxZ) / 2, 0) / steps.length;
    // the taller end is the HEAD; whichever axis it is displaced along is the climb axis
    return Math.abs(cz - midZ) >= Math.abs(cx - mid)
      ? (cz < midZ ? 'N' : 'S')
      : (cx < mid ? 'W' : 'E');
  }

  for (const [label, landing, want] of [
    ['a landing NORTH of it', [[1, 0], [2, 0]], 'N'],
    ['a landing WEST of it', [[0, 1], [0, 2]], 'W'],
  ] as [string, [number, number][], string][]) {
    it(`agree when the storey above decides it — ${label}`, () => {
      const floors: CellFloor[] = [
        { cells: flight(), width: 5, height: 5, entry: 0, exit: 24 },
        { cells: deckLandingAt(landing), width: 5, height: 5, entry: 0, exit: 24 },
      ];
      const t = compileCellTower(floors, 0, PARAMS);

      // what got DRAWN
      const stair = t.cellGrid![0]!.wallPlacements.filter((p) => /stairs/.test(p.unit.url));
      expect(stair.length).toBe(1);
      const drawn = drawnDir(stair[0]!.unit.turn);

      // what got COLLIDED — the step stack on stratum 0
      /** AABB stores RAW Fixed, not `Fixed` — Q16.16, so a raw unit is 1/65536 of a metre. */
      const F = (n: number): number => n / 65536;
      const base = toFloat(PARAMS.groundY);
      const inBlock = t.terrain.solids.filter((b: AABB) => {
        const cx = (F(b.minX) + F(b.maxX)) / 2, cz = (F(b.minZ) + F(b.maxZ)) / 2;
        return Math.abs(cx) <= 2.01 && Math.abs(cz) <= 2.01;
      }).map((b: AABB) => ({
        minX: F(b.minX), maxX: F(b.maxX), minY: F(b.minY),
        maxY: F(b.maxY), minZ: F(b.minZ), maxZ: F(b.maxZ),
      }));
      const collided = collidedDir(inBlock, base);

      /* THE POINT. These came from two calls to `stairFlight` — one for the mesh, one for the
         collider — and the collider's used to omit the storey above. Different arguments, different
         answer, and the two answers are the staircase you SEE and the steps you can STAND on. It could
         be drawn climbing west and collided climbing north. */
      expect(drawn).toBe(want);
      expect(collided).toBe(drawn);
    });
  }
});
