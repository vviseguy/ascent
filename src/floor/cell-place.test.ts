import { describe, it, expect } from 'vitest';
import { cellPlacements, gridPlacements, openingAt, openingAxis, stairRun, PIECE, wallTypeUrl } from './cell-place.ts';
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

describe('cell-place — stair runs', () => {
  const SW = 5, SH = 3;
  const mk = (mut: (c: Cell, x: number, y: number) => void): Cell[] => {
    const out: Cell[] = [];
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
    return out;
  };
  const drew = (cs: Cell[], x: number, y: number): string[] =>
    cellPlacements(cs, SW, SH, x, y).map((p) => p.url.split('/').pop()!.replace('.gltf.glb', ''));

  /** `[open] stairs | stairs [wall]` — the flight climbs toward the closed end. */
  const run = (wallSide: 'E' | 'W' | 'none'): Cell[] => mk((c, x, y) => {
    if (y === 1 && (x === 1 || x === 2)) c.floor = 'stairs';
    if (wallSide === 'E' && y === 1 && x === 3) c.wallW = 'wall';
    if (wallSide === 'W' && y === 1 && x === 1) c.wallW = 'wall';
  });

  it('climbs toward the walled end, whichever end that is', () => {
    expect(stairRun(run('E'), SW, SH, 1, 1)).toEqual({ axis: 'H', up: 'E' });
    expect(stairRun(run('W'), SW, SH, 1, 1)).toEqual({ axis: 'H', up: 'W' });
  });

  it('one flight per run: the lower-coordinate cell owns it, the partner draws nothing', () => {
    const cs = run('E');
    expect(drew(cs, 1, 1)).toEqual(['stairs_narrow']);
    expect(drew(cs, 2, 1)).toEqual([]);
  });

  it('uses stairs_narrow — 4×4, exactly the two-cell run (plain `stairs` is 5 wide and would overhang)', () => {
    expect(cellPlacements(run('E'), SW, SH, 1, 1)[0]!.url).toContain('stairs_narrow');
  });

  it('AMBIGUOUS runs draw ordinary ground rather than guessing a direction', () => {
    expect(stairRun(run('none'), SW, SH, 1, 1)).toBeNull();     // open at both ends
    expect(drew(run('none'), 1, 1)).toEqual(['floor_tile_large']);
    const closedBoth = mk((c, x, y) => {
      if (y === 1 && (x === 1 || x === 2)) c.floor = 'stairs';
      if (y === 1 && (x === 1 || x === 3)) c.wallW = 'wall';
    });
    expect(stairRun(closedBoth, SW, SH, 1, 1)).toBeNull();
  });

  it('a lone `stairs` cell is not a flight', () => {
    const lone = mk((c, x, y) => { if (x === 1 && y === 1) c.floor = 'stairs'; });
    expect(stairRun(lone, SW, SH, 1, 1)).toBeNull();
    expect(drew(lone, 1, 1)).toEqual(['floor_tile_large']);
  });

  it('runs on either axis', () => {
    const vert = mk((c, x, y) => {
      if (x === 2 && (y === 0 || y === 1)) c.floor = 'stairs';
      if (x === 2 && y === 2) c.wallN = 'wall';
    });
    expect(stairRun(vert, SW, SH, 2, 0)).toEqual({ axis: 'V', up: 'S' });
  });
});
