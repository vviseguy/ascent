/**
 * src/floor/wallgrid.test.ts — Layer C WallGrid (src/floor/wallgrid.ts).
 *
 * The headline guard is the WALLMASK ORACLE: the per-cell `wallMask` projected from the
 * WallGrid must equal an INDEPENDENT reimplementation of the same passability rule. The
 * renderer's fog BFS + decoration read `wallMask`, so this pins the projection (identical to
 * the pre-WallGrid mask for floor↔floor seams; intentionally different only where a traversal
 * edge keeps a floor↔VOID seam open — the perimeter-fallback fix). The rest assert the
 * slot/post invariants + determinism.
 */

import { describe, it, expect } from 'vitest';
import { generateFloor } from './generate.ts';
import { buildWallGrid, wallMaskFor, classifyJunction, edgeAt, DIR_N, DIR_E, DIR_W, DIR_S, type Side } from './wallgrid.ts';
import { edgeKey, cellXY, type Floor, type EdgeKind } from './types.ts';

/** is (col,row) a walkable FLOOR cell? (cellType defaults to ROOM) — the shared predicate. */
function isFloorOf(floor: Floor): (col: number, row: number) => boolean {
  const W = floor.width, H = floor.height;
  return (col, row) => {
    if (col < 0 || col >= W || row < 0 || row >= H) return false;
    const t = floor.cells[row * W + col]!.cellType ?? 'ROOM';
    return t !== 'VOID' && t !== 'WALL';
  };
}

function edgeKindMap(floor: Floor): Map<number, EdgeKind> {
  const m = new Map<number, EdgeKind>();
  for (const e of floor.edges) m.set(edgeKey(e.a, e.b), e.kind);
  return m;
}

/**
 * ORACLE — an INDEPENDENT reimplementation of the per-cell wallMask rule the WallGrid encodes
 * (parameterized by the unified open-cell set, hole ∪ stair). A side is walled unless the seam
 * is passable: a WALK/GAP edge (a real opening, ANY neighbour type — this is the perimeter-
 * fallback fix) or a forced-open floor neighbour. BREAK/BUTTON/WEIGHT (a LIP) and no-edge
 * seams stay walled (a LIP reads as a wall to fog, as before). The WallGrid projection MUST
 * equal this for every cell. (For floor↔floor seams this is identical to the pre-WallGrid
 * mask; it differs only at floor↔VOID seams that carry a WALK edge.)
 */
function oracleWallMask(
  floor: Floor, c: number, openCells: ReadonlySet<number>, kinds: Map<number, EdgeKind>,
): number {
  const W = floor.width, H = floor.height;
  const type = floor.cells[c]!.cellType ?? 'ROOM';
  const isFloorCell = type !== 'VOID' && type !== 'WALL';
  if (!isFloorCell || openCells.has(c)) return 0;
  const col = c % W, row = Math.floor(c / W);
  // side bit order: 1=+X(east) 2=-X(west) 4=+Z(north) 8=-Z(south)
  const SIDES: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 1], [-1, 0, 2], [0, 1, 4], [0, -1, 8],
  ];
  let m = 0;
  for (const [dx, dy, bit] of SIDES) {
    const nx = col + dx, ny = row + dy;
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) { m |= bit; continue; }
    const nb = ny * W + nx;
    const nType = floor.cells[nb]!.cellType ?? 'ROOM';
    const neighbourIsFloor = nType !== 'VOID' && nType !== 'WALL';
    const kind = kinds.get(edgeKey(c, nb));
    const open = kind === 'WALK' || kind === 'GAP';
    // an edge wins over cell type; a forced-open neighbour must itself be a floor cell.
    if (open || (neighbourIsFloor && openCells.has(nb))) continue;
    m |= bit;
  }
  return m;
}

const SEEDS = [0n, 1n, 7n, 0x5a17ed_1234n, 0xdeadbeefn, 123456789n];
const SIZES = [2, 3, 5, 8, 12, 30];

function gen(seed: bigint, gridSize: number): Floor {
  return generateFloor({ gridSize, openness: 0.35, guaranteedRoutes: 2, seed, stratumIndex: 0 });
}

/** The wall-edge slot between two ADJACENT cells a,b (a→b decides the side). */
function slotBetween(g: ReturnType<typeof buildWallGrid>, floor: Floor, a: number, b: number) {
  const { x: ac, y: ar } = cellXY(floor.width, a);
  const { x: bc, y: br } = cellXY(floor.width, b);
  let side: Side;
  if (bc === ac + 1 && br === ar) side = 'east';
  else if (bc === ac - 1 && br === ar) side = 'west';
  else if (br === ar + 1 && bc === ac) side = 'north';
  else side = 'south';
  return edgeAt(g, side, ac, ar);
}

describe('WallGrid → wallMask projection matches the independent passability oracle', () => {
  it('matches the oracle for every cell, with NO open cells', () => {
    for (const seed of SEEDS) {
      for (const size of SIZES) {
        const floor = gen(seed, size);
        const kinds = edgeKindMap(floor);
        const isFloor = isFloorOf(floor);
        const g = buildWallGrid(floor);
        const empty: ReadonlySet<number> = new Set();
        for (let c = 0; c < floor.cells.length; c++) {
          const { x: col, y: row } = cellXY(floor.width, c);
          expect(wallMaskFor(g, col, row, isFloor, empty)).toBe(oracleWallMask(floor, c, empty, kinds));
        }
      }
    }
  });

  it('matches the oracle with a synthetic forced-open set (hole/stair stand-in)', () => {
    for (const seed of SEEDS) {
      for (const size of SIZES) {
        const floor = gen(seed, size);
        const kinds = edgeKindMap(floor);
        const isFloor = isFloorOf(floor);
        // a deterministic stand-in for hole ∪ stair footprints.
        const open = new Set<number>();
        for (let c = 0; c < floor.cells.length; c++) if (c % 5 === 0) open.add(c);
        const g = buildWallGrid(floor, { openCells: open });
        for (let c = 0; c < floor.cells.length; c++) {
          const { x: col, y: row } = cellXY(floor.width, c);
          expect(wallMaskFor(g, col, row, isFloor, open)).toBe(oracleWallMask(floor, c, open, kinds));
        }
      }
    }
  });
});

describe('WallGrid slot invariants', () => {
  it('the outer boundary is SOLID on every side (the safe shell)', () => {
    const floor = gen(0x5a17ed_1234n, 8);
    const g = buildWallGrid(floor);
    const W = floor.width, H = floor.height;
    for (let row = 0; row < H; row++) {
      expect(g.vEdges[0 + row * (W + 1)]).toBe('SOLID');     // west boundary
      expect(g.vEdges[W + row * (W + 1)]).toBe('SOLID');     // east boundary
    }
    for (let col = 0; col < W; col++) {
      expect(g.hEdges[col + 0 * W]).toBe('SOLID');           // south boundary
      expect(g.hEdges[col + H * W]).toBe('SOLID');           // north boundary
    }
  });

  it('a WALK/GAP edge between two FLOOR cells is OPEN or DOORWAY (never a wall)', () => {
    for (const seed of SEEDS) {
      const floor = gen(seed, 12);
      const isFloor = isFloorOf(floor);
      const g = buildWallGrid(floor);
      for (const e of floor.edges) {
        if (e.kind !== 'WALK' && e.kind !== 'GAP') continue;
        const { x: ac, y: ar } = cellXY(floor.width, e.a);
        const { x: bc, y: br } = cellXY(floor.width, e.b);
        if (!isFloor(ac, ar) || !isFloor(bc, br)) continue; // only seams between two floor cells
        const s = slotBetween(g, floor, e.a, e.b);
        expect(s === 'OPEN' || s === 'DOORWAY').toBe(true);
      }
    }
  });

  it('a BREAK/BUTTON/WEIGHT edge between two FLOOR cells is a LIP', () => {
    for (const seed of SEEDS) {
      const floor = gen(seed, 12);
      const isFloor = isFloorOf(floor);
      const g = buildWallGrid(floor);
      for (const e of floor.edges) {
        if (e.kind === 'WALK' || e.kind === 'GAP') continue;
        const { x: ac, y: ar } = cellXY(floor.width, e.a);
        const { x: bc, y: br } = cellXY(floor.width, e.b);
        if (!isFloor(ac, ar) || !isFloor(bc, br)) continue;
        expect(slotBetween(g, floor, e.a, e.b)).toBe('LIP');
      }
    }
  });

  it('is deterministic (same floor → identical arrays)', () => {
    const floor = gen(0xdeadbeefn, 12);
    const a = buildWallGrid(floor);
    const b = buildWallGrid(floor);
    expect(a.vEdges).toEqual(b.vEdges);
    expect(a.hEdges).toEqual(b.hEdges);
    expect(a.posts).toEqual(b.posts);
  });

  it('every slot array has the right length', () => {
    const floor = gen(11n, 7);
    const g = buildWallGrid(floor);
    const W = floor.width, H = floor.height;
    expect(g.vEdges.length).toBe((W + 1) * H);
    expect(g.hEdges.length).toBe(W * (H + 1));
    expect(g.posts.length).toBe((W + 1) * (H + 1));
  });
});

describe('classifyJunction — posts named from their incident wall slots', () => {
  // a 2×2 wall grid with everything OPEN; set the four edges incident to the centre post (1,1)
  // and read the classification. Incident slots of post (1,1) on a W=2 grid:
  //   N = vEdges[1 + 1*3], S = vEdges[1 + 0*3], E = hEdges[1 + 1*2], W = hEdges[0 + 1*2].
  function centrePost(set: { N?: boolean; S?: boolean; E?: boolean; W?: boolean }): ReturnType<typeof classifyJunction> {
    const W = 2, H = 2;
    const g = {
      width: W, height: H,
      vEdges: new Array((W + 1) * H).fill('OPEN') as ('OPEN' | 'SOLID')[],
      hEdges: new Array(W * (H + 1)).fill('OPEN') as ('OPEN' | 'SOLID')[],
      posts: [],
    } as unknown as Parameters<typeof classifyJunction>[0];
    if (set.N) g.vEdges[1 + 1 * 3] = 'SOLID';
    if (set.S) g.vEdges[1 + 0 * 3] = 'SOLID';
    if (set.E) g.hEdges[1 + 1 * 2] = 'SOLID';
    if (set.W) g.hEdges[0 + 1 * 2] = 'SOLID';
    return classifyJunction(g, 1, 1);
  }

  it('0 walls = NONE, 1 = CAP', () => {
    expect(centrePost({}).kind).toBe('NONE');
    expect(centrePost({ N: true }).kind).toBe('CAP');
  });
  it('2 collinear = STRAIGHT, 2 perpendicular = CORNER', () => {
    expect(centrePost({ N: true, S: true }).kind).toBe('STRAIGHT');
    expect(centrePost({ E: true, W: true }).kind).toBe('STRAIGHT');
    expect(centrePost({ N: true, E: true }).kind).toBe('CORNER');
    expect(centrePost({ S: true, W: true }).kind).toBe('CORNER');
  });
  it('3 walls = TEE, 4 = CROSS', () => {
    expect(centrePost({ N: true, E: true, W: true }).kind).toBe('TEE');
    expect(centrePost({ N: true, S: true, E: true, W: true }).kind).toBe('CROSS');
  });
  it('dirs bitmask names the wall directions (E=1 W=2 N=4 S=8)', () => {
    expect(centrePost({ N: true, E: true }).dirs).toBe(DIR_N | DIR_E);
    expect(centrePost({ N: true, E: true, W: true, S: true }).dirs).toBe(DIR_N | DIR_E | DIR_W | DIR_S);
  });

  it("every post on a real floor classifies consistently with its dir count", () => {
    const floor = gen(7n, 8);
    const g = buildWallGrid(floor);
    const W = floor.width, H = floor.height;
    const popcount = (d: number) => (d & 1) + ((d >> 1) & 1) + ((d >> 2) & 1) + ((d >> 3) & 1);
    for (let prow = 0; prow <= H; prow++) {
      for (let pcol = 0; pcol <= W; pcol++) {
        const j = g.posts[pcol + prow * (W + 1)]!;
        const n = popcount(j.dirs);
        if (j.kind === 'NONE') expect(n).toBe(0);
        else if (j.kind === 'CAP') expect(n).toBe(1);
        else if (j.kind === 'STRAIGHT' || j.kind === 'CORNER') expect(n).toBe(2);
        else if (j.kind === 'TEE') expect(n).toBe(3);
        else expect(n).toBe(4); // CROSS
      }
    }
  });
});
