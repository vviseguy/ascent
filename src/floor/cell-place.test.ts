import { describe, it, expect } from 'vitest';
import { cellPlacements, gridPlacements, openingAt, openingAxis, stairFault, stairFaultText, stairFlight, torchFacings, PIECE, STAIR_CLIMB, wallTypeUrl } from './cell-place.ts';
import { FLOOR_HEIGHT } from '../game/tower.ts';
import { openCell, type Cell, type WallType } from './cell.ts';

const W = 4, H = 4;
const grid = (mut: (c: Cell, x: number, y: number) => void = () => {}): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
  return out;
};
/** What cell (x,y) draws, walls included. Walls come from the GRID pass — they are laid in whole
 *  pieces that can span cells — so this goes through `gridPlacements`, which is the producer both the
 *  renderer and the collision compiler read. */
const urls = (cs: Cell[], x: number, y: number): string[] =>
  (gridPlacements(cs, W, H).find((e) => e.x === x && e.y === y)?.placements ?? [])
    .map((p) => p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, ''));
/* THE FILTER THAT USED TO BE HERE dropped `wall_endcap` from every assertion, on the grounds that caps
   are dressing. It also made the suite structurally unable to see a cap planted inside a doorway — the
   test named "draws ONE arch and suppresses BOTH wall halves" passed for weeks with a full-height stub
   standing in the aperture. An assertion helper that hides a piece hides its bugs too. */
/** Every piece on the whole grid — for asserting about walls, which no longer belong to one cell. */
const allUrls = (cs: Cell[], w = W, h = H): string[] =>
  gridPlacements(cs, w, h).flatMap((e) => e.placements)
    .map((p) => p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, ''));

describe('cell-place — one piece per thing the cell owns', () => {
  it('an open cell is just its floor', () => {
    expect(urls(grid(), 1, 1)).toEqual(['floor_tile_large']);
  });

  it('a 2u floor piece renders the 4u mesh at HALF scale', () => {
    const p = cellPlacements(grid(), W, H, 1, 1)[0]!;
    expect(p.scale).toBe(32768); // 0.5 in Q16.16
  });

  it('a lone wall segment is one 2u piece', () => {
    // ...plus a cap at each of its two loose ends. The helper used to filter caps out, which is how a
    // cap standing inside a doorway went unnoticed; these assertions now show everything emitted.
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'wall'; }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_half', 'wall_endcap', 'wall_endcap']);
  });

  it('a run that stops in mid-air is CAPPED at each loose end', () => {
    // a lone segment is loose at both ends
    const lone = allUrls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'wall'; }));
    expect(lone.filter((u) => u === 'wall_endcap')).toHaveLength(2);
    // a full row runs into the map edge at both ends — nothing to cap
    const spanning = allUrls(grid((c, x, y) => { if (y === 1) c.wallN = 'wall'; }));
    expect(spanning.filter((u) => u === 'wall_endcap')).toHaveLength(2); // a bare grid has no border wall to meet
  });

  it('TWO PERPENDICULAR segments become one mitered corner, not two slabs at right angles', () => {
    // the kit's corner reaches a whole 2u edge down each leg, which is exactly what meets here
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.wallN = 'wall'; c.wallW = 'wall'; } }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_corner']);
  });

  it('a straight RUN becomes 4u pieces — one mesh per two segments, not one per segment', () => {
    // four segments in a line — the grid is 4 wide, so x 0..3 is a full row of edges
    const cs = grid((c, x, y) => { if (y === 1) c.wallN = 'wall'; });
    const walls = allUrls(cs).filter((u) => u.startsWith('wall'));
    expect(walls.filter((u) => u === 'wall')).toHaveLength(2);
    expect(walls.filter((u) => u === 'wall_half')).toHaveLength(0);
  });

  it('an ODD run finishes with a 2u piece', () => {
    const cs = grid((c, x, y) => { if (y === 1 && x <= 2) c.wallN = 'wall'; });
    const walls = allUrls(cs).filter((u) => u.startsWith('wall'));
    expect(walls.filter((u) => u === 'wall')).toHaveLength(1);
    expect(walls.filter((u) => u === 'wall_half')).toHaveLength(1);
  });

  it('a barrier run uses the BARRIER family, and never mixes with the wall one', () => {
    const cs = grid((c, x, y) => {
      if (y === 1 && x <= 1) c.wallN = 'barrier';
      if (y === 3 && x <= 1) c.wallN = 'wall';
    });
    const u = allUrls(cs);
    expect(u).toContain('barrier');   // the 4u barrier, not two halves
    expect(u).toContain('wall');
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

  it('a ROCK cell lays no ground of its own — it is not a place', () => {
    // its WALL is still drawn; walls belong to the grid, not to the cell that happens to be solid
    const out = urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'rock'; c.wallN = 'wall'; } }), 1, 1);
    expect(out.filter((u) => u.includes('floor'))).toEqual([]);
  });

  it('a PIT emits no ground but keeps its walls', () => {
    const out = urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'none'; c.wallN = 'wall'; } }), 1, 1);
    expect(out).toEqual(['wall_half', 'wall_endcap', 'wall_endcap']);
  });
});

describe('cell-place — a 4u opening replaces the two segments it spans', () => {
  /** A horizontal wall run along y=2, with the point (2,2) opened. */
  /** A wall run with one module in it, OPEN — passability needs the kind and the state to agree. */
  const withOpening = (wt: WallType): Cell[] =>
    grid((c, x, y) => {
      if (y === 2) c.wallN = 'wall';
      if (x === 2 && y === 2) { c.corner = 'none'; c.wallType = wt; c.open = 'open'; }
    });

  it('is live for a WALK-THROUGH type with wall either side — the corner has no say', () => {
    // an opening needs two things and only two: a type you can walk through, and a wall run either
    // side for it to replace. What stands at the point is a separate question.
    const openTypes: WallType[] = ['doorway', 'arch'];
    for (const t of openTypes) {
      for (const corner of ['none', 'column', 'balcony'] as const) {
        const cs = grid((c, x, y) => {
          if (x === 1 && y === 1) { c.wallType = t; c.open = 'open'; c.corner = corner; c.wallN = 'wall'; }
          if (x === 0 && y === 1) c.wallN = 'wall';
        });
        expect(openingAt(cs, W, H, 1, 1, 'H')).toBe(true);
      }
    }
    // a solid type is never an opening
    const shut = grid((c, x, y) => {
      if (x === 1 && y === 1) { c.wallType = 'solid'; c.wallN = 'wall'; }
      if (x === 0 && y === 1) c.wallN = 'wall';
    });
    expect(openingAt(shut, W, H, 1, 1, 'H')).toBe(false);
  });

  it('draws ONE arch and suppresses BOTH wall halves — including the neighbour\'s', () => {
    const cs = withOpening('doorway');
    expect(urls(cs, 2, 2)).toEqual(['floor_tile_large', 'wall_doorway']); // the arch, no wall_half
    expect(urls(cs, 1, 2)).toEqual(['floor_tile_large']);                // the neighbour's half is gone
    // beyond the span: a half, and ONE cap at its far end. The near end is not loose — the doorway
    // continues the wall — and a cap there is the bug `cell-module.test.ts` exists to hold shut.
    expect(urls(cs, 3, 2)).toEqual(['floor_tile_large', 'wall_half', 'wall_endcap']);
  });

  it('the axis is derived from which run actually exists', () => {
    expect(openingAxis(withOpening('doorway'), W, H, 2, 2)).toBe('H');
    const vertical = grid((c, x, y) => {
      if (x === 2) c.wallW = 'wall';
      if (x === 2 && y === 2) { c.corner = 'none'; c.wallType = 'arch'; c.open = 'open'; }
    });
    expect(openingAxis(vertical, W, H, 2, 2)).toBe('V');
    expect(openingAxis(grid(), W, H, 2, 2)).toBeNull();
  });

  it('every wall type maps to a mesh', () => {
    for (const wt of ['solid', 'doorway', 'window', 'cracked', 'arch', 'gate'] as WallType[]) {
      expect(wallTypeUrl(wt, 'open')).toContain(PIECE.wall.split('/')[0]!);
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
    /* Count EDGES covered, not pieces: the grid pass lays whole runs, so a 4u piece is two edges and
       a mitered corner is two. What the padding rule is about is which edges EXIST, and that is the
       quantity that must not change when pieces get bigger. */
    const EDGES: Record<string, number> = { wall: 2, wall_corner: 2, wall_half: 1, barrier: 2, barrier_corner: 2, barrier_half: 1 };
    const walls = (fx?: { w: number; h: number }): number =>
      gridPlacements(cs, sw, sh, fx).flatMap((e) => e.placements)
        .reduce((n, p) => n + (EDGES[p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, '')] ?? 0), 0);

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
    (gridPlacements(cs, SW, SH).find((e) => e.x === x && e.y === y)?.placements ?? [])
      .map((p) => p.url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, ''));
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
    expect(ground(cs, 1, 1)).toEqual(['stairs']);
  });

  it('lands the mesh ON the block, allowing for a pivot that sits at the TOP of the flight', () => {
    // The mesh spans local z in [0, 4] and rises toward -Z, so its origin is its top end. Placing it at
    // the block's centre would hang it half a block downhill; it belongs half a run UP-SLOPE of centre.
    const p = cellPlacements(block(), SW, SH, 1, 1)[0]!;
    expect(p.turn).toBe(0);              // a north climb is the mesh's native orientation
    expect(p.x).toBe(65536);             // (bw-1) = 1 east: centred across the 2-cell width
    expect(p.z).toBe(-65536 + 7864);     // the top end (-1), pushed 0.12 DOWNHILL to clear the wall trim
    expect(p.y).toBe(3277);              // lifted to the deck's walking surface, 0.05
    // which puts the 4u-deep mesh over the two cells of the block, flush with the floor either end
  });

  it('climbs exactly one storey, so a flight actually reaches the next deck', () => {
    // 0.05 (this deck's surface) + 4.00 (the climb) = 4.05 = the next deck's surface. Drift these apart
    // and stairs stop connecting floors — which is what a FLOOR_HEIGHT of 6 was doing.
    expect(FLOOR_HEIGHT).toBe(STAIR_CLIMB);
  });

  it('SENSES walls either side and switches to the walled mesh', () => {
    expect(stairFlight(block(), SW, SH, 1, 1)!.url).toContain('/stairs.');
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

  it('takes its MATERIAL from the cells, not from the room around it', () => {
    // A wooden flight is a shallower stair: 6u deep, so it needs THREE cells where stone needs two.
    // That is why the material is authored — it changes the footprint, so it cannot be a late dressing.
    const woodBlock = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 3) c.floor = 'stairs_wood';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    const f = stairFlight(woodBlock, SW, SH, 1, 1)!;
    expect(f.run).toBe(3);
    expect(f.url).toContain('stairs_wood');

    // and a stone flight in a wooden ROOM stays stone — the surroundings have no say
    const stoneInWood = mk((c, x, y) => {
      const inBlock = x >= 1 && x <= 2 && (y === 1 || y === 2);
      c.floor = inBlock ? 'stairs' : 'wood';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFlight(stoneInWood, SW, SH, 1, 1)!.url).toContain('/stairs.');
  });

  it('will not stretch a mesh to a length it does not have', () => {
    // three cells of STONE stairs: the stone family is 2 long and the only 3-long mesh is wooden, so
    // there is nothing to draw. It reports nothing rather than fitting the wrong mesh or the wrong wood.
    const tooLong = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 3) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFlight(tooLong, SW, SH, 1, 1)).toBeNull();
    expect(ground(tooLong, 1, 1)).toEqual(['floor_tile_large']);

    // and two cells of WOOD is likewise unspannable
    const tooShort = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs_wood';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFlight(tooShort, SW, SH, 1, 1)).toBeNull();
  });

  it('two MATERIALS touching are two flights, not one ragged block', () => {
    const mixed = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (x >= 1 && x <= 2 && (y === 3 || y === 4)) c.floor = 'stairs_wood';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    // the stone block is 2 long and complete; the wood below it is a separate, unspannable block
    expect(stairFlight(mixed, SW, SH, 1, 1)).toMatchObject({ run: 2, bh: 2 });
    expect(stairFlight(mixed, SW, SH, 1, 3)).toBeNull();
  });

  it('SAYS WHY a stair block is not a flight, because the failure is otherwise silent', () => {
    const ragged = mk((c, x, y) => {
      if ((x === 1 && y === 1) || (x === 2 && y === 1) || (x === 1 && y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFault(ragged, SW, SH, 1, 1)).toMatchObject({ kind: 'ragged' });
    expect(stairFaultText(stairFault(ragged, SW, SH, 1, 1)!)).toContain('rectangle');

    const noEnds = mk((c, x, y) => { if (x >= 1 && x <= 2 && y >= 1 && y <= 2) c.floor = 'stairs'; });
    expect(stairFault(noEnds, SW, SH, 1, 1)).toMatchObject({ kind: 'undecidable' });
    expect(stairFaultText(stairFault(noEnds, SW, SH, 1, 1)!)).toContain('which way it climbs');

    const tooLong = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 3) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
    });
    expect(stairFault(tooLong, SW, SH, 1, 1)).toMatchObject({ kind: 'no-mesh', run: 3 });
    expect(stairFaultText(stairFault(tooLong, SW, SH, 1, 1)!)).toContain('3 cells long');

    // a block that IS a flight has no fault to report
    expect(stairFault(block(), SW, SH, 1, 1)).toBeNull();
    // and a cell that owns nothing reports nothing either way
    expect(stairFault(block(), SW, SH, 0, 0)).toBeNull();
  });

  /* A staircase in a CORNER has two adjacent walls, and both readings of it are a climb. The tiebreak
     is which wall is the stair's own head: a head wall stops at the block, a wall it merely stands
     against runs on past it. */
  it('SENSES which flank is walled and picks the handed mesh', () => {
    // walls at N and W. Read as a north climb, west is on your LEFT.
    const leftWall = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
      if ((y === 1 || y === 2) && x === 1) c.wallW = 'wall';
    });
    const l = stairFlight(leftWall, SW, SH, 1, 1)!;
    expect(l).toMatchObject({ up: 'N', walls: -1 });
    expect(l.url).toContain('stairs_wall_left');

    // the mirror image: walls at N and E puts the wall on your RIGHT
    const rightWall = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
      if ((y === 1 || y === 2) && x === 3) c.wallW = 'wall';
    });
    const r = stairFlight(rightWall, SW, SH, 1, 1)!;
    expect(r).toMatchObject({ up: 'N', walls: 1 });
    expect(r.url).toContain('stairs_wall_right');
  });

  it('climbs toward its OWN head wall, not along the room wall it stands beside', () => {
    /* Both axes have exactly one closed end, so the closed ends alone cannot decide. The west wall
       runs the full height of the room and carries on past the block; the north wall stops at the
       block. The short one is the stair's head, so it climbs NORTH with the room wall on its left —
       reading it the other way would have it climbing along the wall it is standing against. */
    const againstRoomWall = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';     // the stair's own head — stops at the block
      if (x === 1) c.wallW = 'wall';                          // a room wall — runs the whole height
    });
    expect(stairFlight(againstRoomWall, SW, SH, 1, 1)).toMatchObject({ up: 'N', walls: -1 });

    // and with the roles swapped, it climbs WEST instead
    const other = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1) c.wallN = 'wall';                          // a room wall — runs the whole width
      if ((y === 1 || y === 2) && x === 1) c.wallW = 'wall';  // the stair's own head
    });
    expect(stairFlight(other, SW, SH, 1, 1)).toMatchObject({ up: 'W' });
  });

  it('still refuses when NEITHER axis has a closed end — there is nothing to go on', () => {
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

describe('cell-place — a torch is hung by SENSING, never by storage', () => {
  const TW = 6, TH = 6;
  const mk = (mut: (c: Cell, x: number, y: number) => void): Cell[] => {
    const out: Cell[] = [];
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { const c = openCell(); mut(c, x, y); out.push(c); }
    return out;
  };

  it('a FREE-STANDING COLUMN carries one on every side — four of them', () => {
    const cs = mk((c, x, y) => { if (x === 2 && y === 2) { c.corner = 'column'; c.torch = 'yes'; } });
    expect(torchFacings(cs, TW, TH, 2, 2).sort()).toEqual(['E', 'N', 'S', 'W']);
    const drawn = cellPlacements(cs, TW, TH, 2, 2).filter((p) => p.url.includes('torch'));
    expect(drawn).toHaveLength(4);
    expect(new Set(drawn.map((p) => p.turn)).size).toBe(4); // each one faces a different way
  });

  it('a column against a wall only lights the sides it can be seen from', () => {
    const cs = mk((c, x, y) => {
      if (x === 2 && y === 2) { c.corner = 'column'; c.torch = 'yes'; }
      if (y === 2 && x === 2) c.wallN = 'wall';   // the arm running EAST
      if (y === 2 && x === 1) c.wallN = 'wall';   // the arm running WEST
    });
    expect(torchFacings(cs, TW, TH, 2, 2).sort()).toEqual(['N', 'S']);
  });

  it('a point in a WALL takes exactly one — two faces of the same wall reads as a mistake', () => {
    const cs = mk((c, x, y) => {
      if (y === 2 && (x === 1 || x === 2)) c.wallN = 'wall';
      if (x === 2 && y === 2) c.torch = 'yes';
    });
    expect(torchFacings(cs, TW, TH, 2, 2)).toHaveLength(1);
  });

  it('nothing to hang it on, or nowhere worth lighting, and there is no torch', () => {
    const bare = mk((c, x, y) => { if (x === 2 && y === 2) c.torch = 'yes'; });
    expect(torchFacings(bare, TW, TH, 2, 2)).toEqual([]);          // open floor: nothing to mount on

    const walledIn = mk((c, x, y) => {
      if (x === 2 && y === 2) { c.corner = 'column'; c.torch = 'yes'; }
      for (const [cx, cy] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) {
        if (x === cx && y === cy) c.floor = 'rock';                 // solid fill all round it
      }
    });
    expect(torchFacings(walledIn, TW, TH, 2, 2)).toEqual([]);
  });
});
