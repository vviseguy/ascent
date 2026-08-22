import { describe, it, expect } from 'vitest';
import { cellPlacements, gridPlacements, openingAt, openingAxis, stairFlight, PIECE, wallTypeUrl } from './cell-place.ts';
import { openCell, type Cell, type WallType } from './cell.ts';

const W = 4, H = 4;
const grid = (mut: (c: Cell, x: number, y: number) => void = () => {}): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
  return out;
};
const urls = (cs: Cell[], x: number, y: number): string[] =>
  cellPlacements(cs, W, H, x, y).map((p) => p.url.split('/').pop()!.replace('.gltf.glb', ''));

describe('cell-place — one piece per thing the cell owns', () => {
  it('an open cell is just its floor', () => {
    expect(urls(grid(), 1, 1)).toEqual(['floor_tile_large']);
  });

  it('a 2u floor piece renders the 4u mesh at HALF scale', () => {
    const p = cellPlacements(grid(), W, H, 1, 1)[0]!;
    expect(p.scale).toBe(32768); // 0.5 in Q16.16
  });

  it('each owned wall adds exactly one 2u piece', () => {
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'wall'; }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_half']);
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.wallN = 'wall'; c.wallW = 'wall'; } }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_half', 'wall_half']);
  });

  it('the two owned walls point along different axes', () => {
    const ps = cellPlacements(grid((c, x, y) => { if (x === 1 && y === 1) { c.wallN = 'wall'; c.wallW = 'wall'; } }), W, H, 1, 1)
      .filter((p) => p.url.includes('wall_half'));
    expect(new Set(ps.map((p) => p.turn)).size).toBe(2);
  });

  it('a barrier gets the low piece, and a column the pillar', () => {
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'barrier'; }), 1, 1))
      .toContain('barrier_half');
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.corner = 'column'; }), 1, 1))
      .toContain('pillar');
  });

  it('`sloped` stands in as a solid wall until its own mesh exists', () => {
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'sloped'; }), 1, 1))
      .toContain('wall_half');
  });

  it('a ROCK cell emits nothing at all — it is not a place', () => {
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'rock'; c.wallN = 'wall'; } }), 1, 1))
      .toEqual([]);
  });

  it('a PIT emits no ground but keeps its walls', () => {
    const out = urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'none'; c.wallN = 'wall'; } }), 1, 1);
    expect(out).toEqual(['wall_half']);
  });
});

describe('cell-place — a 4u opening replaces the two segments it spans', () => {
  /** A horizontal wall run along y=2, with the point (2,2) opened. */
  const withOpening = (wt: WallType): Cell[] =>
    grid((c, x, y) => {
      if (y === 2) c.wallN = 'wall';
      if (x === 2 && y === 2) { c.corner = 'air'; c.wallType = wt; }
    });

  it('is live only for a walk-through type on an `air` corner with wall either side', () => {
    expect(openingAt(withOpening('door'), W, H, 2, 2, 'H')).toBe(true);
    expect(openingAt(withOpening('window'), W, H, 2, 2, 'H')).toBe(false); // not walk-through
    const solidCorner = grid((c, x, y) => { if (y === 2) c.wallN = 'wall'; if (x === 2 && y === 2) c.wallType = 'door'; });
    expect(openingAt(solidCorner, W, H, 2, 2, 'H')).toBe(false);           // corner is not air
  });

  it('draws ONE arch and suppresses BOTH wall halves — including the neighbour\'s', () => {
    const cs = withOpening('door');
    expect(urls(cs, 2, 2)).toEqual(['floor_tile_large', 'wall_arched']); // the arch, no wall_half
    expect(urls(cs, 1, 2)).toEqual(['floor_tile_large']);                // the neighbour's half is gone
    expect(urls(cs, 3, 2)).toEqual(['floor_tile_large', 'wall_half']);   // beyond the span, unaffected
  });

  it('the axis is derived from which run actually exists', () => {
    expect(openingAxis(withOpening('door'), W, H, 2, 2)).toBe('H');
    const vertical = grid((c, x, y) => {
      if (x === 2) c.wallW = 'wall';
      if (x === 2 && y === 2) { c.corner = 'air'; c.wallType = 'arch'; }
    });
    expect(openingAxis(vertical, W, H, 2, 2)).toBe('V');
    expect(openingAxis(grid(), W, H, 2, 2)).toBeNull();
  });

  it('every wall type maps to a mesh', () => {
    for (const wt of ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'] as WallType[]) {
      expect(wallTypeUrl(wt)).toContain(PIECE.wall.split('/')[0]!);
    }
  });
});

describe('cell-place — the grid walk', () => {
  it('is row-major and skips cells with nothing to draw', () => {
    const cs = grid((c) => { c.floor = 'rock'; });
    expect(gridPlacements(cs, W, H)).toEqual([]);
    const one = grid((c, x, y) => { if (!(x === 0 && y === 0)) c.floor = 'rock'; });
    expect(gridPlacements(one, W, H).map((e) => `${e.x},${e.y}`)).toEqual(['0,0']);
  });

  it('is deterministic', () => {
    const cs = grid((c, x, y) => { if ((x + y) % 2 === 0) c.wallN = 'wall'; });
    expect(JSON.stringify(gridPlacements(cs, W, H))).toBe(JSON.stringify(gridPlacements(cs, W, H)));
  });
});

describe('cell-place — a structure has no ground under its padding', () => {
  it('a w×h structure lays exactly w*h floor tiles, not (w+1)*(h+1)', () => {
    // the stored grid is the POINT lattice: its last row/column carry the south and east border
    // walls and have no cell to their south-east, so they must not put ground down
    const SW = 3, SH = 4;                    // floor extent
    const sw = SW + 1, sh = SH + 1;          // stored extent
    const cs: Cell[] = Array.from({ length: sw * sh }, () => openCell());
    const withPad = gridPlacements(cs, sw, sh, { w: SW, h: SH })
      .flatMap((e) => e.placements).filter((p) => p.url.includes('floor')).length;
    expect(withPad).toBe(SW * SH);
    // and a GENERATOR floor, where every cell is real, passes nothing and gets one each
    const plain = gridPlacements(cs, sw, sh)
      .flatMap((e) => e.placements).filter((p) => p.url.includes('floor')).length;
    expect(plain).toBe(sw * sh);
  });
});

describe('cell-place — the padding carries borders, not a phantom extra layer', () => {
  it('drops only the edges that point OUT of the structure, and keeps the real borders', () => {
    const SW = 2, SH = 2;                        // floor extent
    const sw = SW + 1, sh = SH + 1;              // stored point lattice
    const cs: Cell[] = Array.from({ length: sw * sh }, () => {
      const c = openCell();
      c.wallN = 'wall';
      c.wallW = 'wall';
      return c;
    });
    const walls = (fx?: { w: number; h: number }): number =>
      gridPlacements(cs, sw, sh, fx).flatMap((e) => e.placements)
        .filter((p) => p.url.includes('wall_half')).length;

    // every point has both walls set, so without a floor extent every one is drawn
    expect(walls()).toBe(sw * sh * 2);
    // with it: wallN survives where x < SW (so 2 columns x 3 rows), wallW where y < SH (3 x 2).
    // The south border (wallN at y === SH) and east border (wallW at x === SW) are KEPT — they are
    // real edges of the structure, which is the whole reason for the padding.
    expect(walls({ w: SW, h: SH })).toBe(SW * sh + sw * SH);
  });
});

describe('cell-place — stair flights are BLOCKS, and everything about them is sensed', () => {
  const SW = 6, SH = 6;
  const mk = (mut: (c: Cell, x: number, y: number) => void): Cell[] => {
    const out: Cell[] = [];
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
    return out;
  };
  const drew = (cs: Cell[], x: number, y: number): string[] =>
    cellPlacements(cs, SW, SH, x, y).map((p) => p.url.split('/').pop()!.replace('.gltf.glb', ''));
  /** Only the GROUND a cell lays — its own walls are a separate question from whose flight it is in. */
  const ground = (cs: Cell[], x: number, y: number): string[] =>
    drew(cs, x, y).filter((u) => u.includes('floor') || u.includes('stairs'));

  /** A 2x2 block at (1,1) with the NORTH end closed, so it climbs north. */
  const block = (opts: { flanks?: boolean; wide?: boolean; wood?: boolean } = {}): Cell[] => {
    const bw = opts.wide ? 3 : 2;
    return mk((c, x, y) => {
      const inBlock = x >= 1 && x < 1 + bw && (y === 1 || y === 2);
      if (inBlock) c.floor = 'stairs';
      if (opts.wood && !inBlock) c.floor = 'wood';
      if (y === 1 && x >= 1 && x < 1 + bw) c.wallN = 'wall';        // the north end is closed
      if (opts.flanks && (y === 1 || y === 2) && (x === 1 || x === 1 + bw)) c.wallW = 'wall';
    });
  };

  it('a 2x2 block is ONE flight, owned by its lowest-coordinate cell', () => {
    const cs = block();
    const f = stairFlight(cs, SW, SH, 1, 1);
    expect(f).toMatchObject({ x: 1, y: 1, bw: 2, bh: 2, up: 'N', width: 2 });
    // the other three cells of the block own no flight and lay no GROUND of their own — though they
    // still draw their own walls, which belong to the cell and not to the flight
    for (const [x, y] of [[2, 1], [1, 2], [2, 2]] as [number, number][]) {
      expect(stairFlight(cs, SW, SH, x, y)).toBeNull();
      expect(ground(cs, x, y)).toEqual([]);
    }
    expect(ground(cs, 1, 1)).toEqual(['stairs_narrow']);
  });

  it('lands the mesh ON the block, allowing for a pivot that sits at the TOP of the flight', () => {
    // The mesh spans local z in [0, 4] and rises toward -Z, so its origin is its top end. Placing it at
    // the block's centre would hang it half a block downhill; it belongs half a run UP-SLOPE of centre.
    const p = cellPlacements(block(), SW, SH, 1, 1)[0]!;
    expect(p.turn).toBe(0);      // a north climb is the mesh's native orientation
    expect(p.x).toBe(65536);     // (bw-1) = 1 east: centred across the 2-cell width
    expect(p.z).toBe(-65536);    // (bh-1) - run = 1 - 2 = -1: the top end, not the middle
    // which puts the 4u-deep mesh over exactly the two cells of the block: [-1, 3]
  });

  it('SENSES walls either side and switches to the walled mesh', () => {
    expect(stairFlight(block(), SW, SH, 1, 1)!.url).toContain('stairs_narrow');
    const walled = stairFlight(block({ flanks: true }), SW, SH, 1, 1)!;
    expect(walled.walls).toBe(2);
    expect(walled.url).toContain('stairs_walled');
  });

  it('a walled flight carries its own sides, so those walls are not drawn twice', () => {
    const cs = block({ flanks: true });
    const halves = (g: Cell[]): number => gridPlacements(g, SW, SH).flatMap((e) => e.placements)
      .filter((p) => p.url.includes('wall_half')).length;
    // four wall segments were added either side of the flight, and the mesh supplies all four
    expect(halves(cs)).toBe(halves(block()));
  });

  it('SENSES a three-cell width and switches to the wide mesh', () => {
    const f = stairFlight(block({ wide: true }), SW, SH, 1, 1)!;
    expect(f.width).toBe(3);
    expect(f.url).toContain('stairs_wide');
  });

  it('SENSES the surrounding ground and switches to the wooden mesh', () => {
    // the wooden flight is 6u deep, so it only fits a block that runs THREE cells
    const woodBlock = mk((c, x, y) => {
      const inBlock = x >= 1 && x <= 2 && y >= 1 && y <= 3;
      c.floor = inBlock ? 'stairs' : 'wood';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    const f = stairFlight(woodBlock, SW, SH, 1, 1)!;
    expect(f.run).toBe(3);
    expect(f.url).toContain('stairs_wood');
  });

  it('will not stretch a 4u mesh over a 6u hole — an unspannable block draws ordinary ground', () => {
    const tooLong = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 3) c.floor = 'stairs';   // 3 long, but stone around it
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    // the only 3-run mesh is the wooden one, so a stone block of that length degrades to it rather
    // than leaving a step missing
    expect(stairFlight(tooLong, SW, SH, 1, 1)!.url).toContain('stairs_wood');

    const noMesh = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 4) c.floor = 'stairs';   // 4 long — nothing spans it
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFlight(noMesh, SW, SH, 1, 1)).toBeNull();
    expect(ground(noMesh, 1, 1)).toEqual(['floor_tile_large']);
  });

  /* A SQUARE block walled on two ADJACENT sides is undecidable, and this pins that rather than
     papering over it. Walls at N and W: read as a north climb it is left-walled; read as a west climb
     it is right-walled. Both are legitimate, so the sensor reports nothing — the same refusal to guess
     that the cross-junction opening makes. It is also why `stairs_wall_left`/`_right` are unreachable
     today; see the note on STAIR_MESHES. */
  it('a square block walled on two ADJACENT sides is undecidable, and says so', () => {
    const corner = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';        // north closed, south open
      if ((y === 1 || y === 2) && x === 1) c.wallW = 'wall';    // west closed, east open
    });
    expect(stairFlight(corner, SW, SH, 1, 1)).toBeNull();
    expect(ground(corner, 1, 1)).toEqual(['floor_tile_large']);
  });

  it('AMBIGUOUS blocks draw ordinary ground rather than guessing', () => {
    const openBoth = mk((c, x, y) => { if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs'; });
    expect(stairFlight(openBoth, SW, SH, 1, 1)).toBeNull();
    expect(ground(openBoth, 1, 1)).toEqual(['floor_tile_large']);
  });

  it('a RAGGED patch is not a flight', () => {
    const ragged = mk((c, x, y) => {
      if ((x === 1 && y === 1) || (x === 2 && y === 1) || (x === 1 && y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFlight(ragged, SW, SH, 1, 1)).toBeNull();
  });

  it('climbs on either axis', () => {
    const eastward = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs';
      if ((y === 1 || y === 2) && x === 3) c.wallW = 'wall';   // the EAST end is closed
    });
    expect(stairFlight(eastward, SW, SH, 1, 1)).toMatchObject({ up: 'E', width: 2 });
  });
});
