import { describe, it, expect } from 'vitest';
import { cellPlacements, gridPlacements, openingAt, stairChoiceAt, openingAxis, stairFault, stairFaultText, stairFlight, torchFacings, wallEnds, PIECE, STAIR_CLIMB, wallTypeUrls } from './cell-place.ts';
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

/**
 * HOW MANY 2u EDGES EACH PIECE COVERS — the quantity the pass order must never change.
 *
 * The tiling is free to choose bigger or smaller pieces (that is the whole of tiers 2 and 3), so any
 * assertion counting PIECES is asserting about the optimiser. What the wall model asserts is a set of
 * EDGES, and that number has to survive every re-tiling. The terminator is 0 on purpose: a nub stands
 * at a point where a wall stops, and covers no edge of its own.
 */
const EDGES: Record<string, number> = {
  wall: 2, wall_corner: 2, wall_half: 1, wall_half_endcap: 1,
  barrier: 2, barrier_corner: 2, barrier_half: 1,
  wall_endcap_short: 0, pillar: 0, column: 0,
};
const bare = (url: string): string => url.split('/').pop()!.replace(/#.*$/, '').replace(/\.(gltf\.)?glb$/, '');
const edgesCovered = (cs: Cell[], w = W, h = H, fx?: { w: number; h: number }): number =>
  gridPlacements(cs, w, h, fx).flatMap((e) => e.placements)
    .reduce((n, p) => n + (EDGES[bare(p.url)] ?? 0), 0);
/** The two pieces that FINISH a wall: a shortened last half, and the terminator for an end that has
 *  no half to give up. Counting them together is the honest way to ask "was this end dealt with". */
const finishes = (u: string[]): number => u.filter((n) => n === 'wall_half_endcap' || n === 'wall_endcap_short').length;

describe('cell-place — one piece per thing the cell owns', () => {
  it('an open cell is just its floor', () => {
    expect(urls(grid(), 1, 1)).toEqual(['floor_tile_large']);
  });

  it('a 2u floor piece renders the 4u mesh at HALF scale', () => {
    const p = cellPlacements(grid(), W, H, 1, 1)[0]!;
    expect(p.scale).toBe(32768); // 0.5 in Q16.16
  });

  it('a lone wall segment is one 2u piece — the FINISHED one', () => {
    /* `wall_half_endcap` spans x[-2,0] with its detail AT the origin, so it is finished at exactly one
       end, and a lone segment is loose at both. The kit ships nothing finished at both ends, so the
       second end takes the terminator instead. The helper used to filter caps out, which is how a cap
       standing inside a doorway went unnoticed; these assertions show everything emitted. */
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'wall'; }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_half_endcap', 'wall_endcap_short']);
  });

  it('a run that stops in mid-air is FINISHED at each loose end, and nowhere else', () => {
    // a lone segment is loose at both ends: one half it can give up, and one it cannot
    const lone = allUrls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'wall'; }));
    expect(finishes(lone)).toBe(2);
    // a full row runs into the lattice edge at both ends, and a bare grid has no border wall to meet
    // there — so those ARE loose, and a 4-edge run has a half to spare at each of them
    const spanning = allUrls(grid((c, x, y) => { if (y === 1) c.wallN = 'wall'; }));
    expect(spanning.filter((u) => u === 'wall_half_endcap')).toHaveLength(2);
    expect(spanning.filter((u) => u === 'wall_endcap_short')).toHaveLength(0);
    /* NEGATIVE CONTROL — a closed ring has no ends at all, and finishing something that is not an end
       is the failure mode every version of this rule has had. */
    const ring = grid((c, x, y) => {
      if ((y === 1 || y === 3) && (x === 1 || x === 2)) c.wallN = 'wall';
      if ((x === 1 || x === 3) && (y === 1 || y === 2)) c.wallW = 'wall';
    });
    expect(wallEnds(ring, W, H)).toEqual([]);
    expect(finishes(allUrls(ring))).toBe(0);
  });

  it('a BEND is a merge over the baseline, so a claimed edge outranks it', () => {
    /* The kit's corner reaches a whole 2u edge down each leg — which is exactly what a bare L is made
       of, and both of its outer points are also LOOSE ENDS. Finishing an end is irreplaceable and a
       mitre is not, so the two-edge L comes out as two finished halves butting at the inner point.
       This is the pass order doing its job, not a missed corner. */
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.wallN = 'wall'; c.wallW = 'wall'; } }), 1, 1))
      .toEqual(['floor_tile_large', 'wall_half_endcap', 'wall_half_endcap']);

    // give each leg one more edge and the mitre is back: the ends now want edges the corner does not
    const longer = allUrls(grid((c, x, y) => {
      if (y === 1 && (x === 1 || x === 2)) c.wallN = 'wall';
      if (x === 1 && (y === 1 || y === 2)) c.wallW = 'wall';
    }));
    expect(longer.filter((u) => u === 'wall_corner')).toHaveLength(1);
    expect(longer.filter((u) => u === 'wall_half_endcap')).toHaveLength(2);
  });

  it('a straight RUN merges into 4u pieces — one mesh per two segments, not one per segment', () => {
    // four segments in a line — the grid is 4 wide, so x 0..3 is a full row of edges
    const cs = grid((c, x, y) => { if (y === 1) c.wallN = 'wall'; });
    const walls = allUrls(cs).filter((u) => u.startsWith('wall'));
    // an edge at each end goes to finishing it; the two left in the middle are one 4u piece
    expect(walls.filter((u) => u === 'wall')).toHaveLength(1);
    expect(walls.filter((u) => u === 'wall_half_endcap')).toHaveLength(2);
    expect(walls.filter((u) => u === 'wall_half')).toHaveLength(0);
  });

  it('an ODD number of free edges leaves a plain 2u piece — the baseline showing through', () => {
    const cs = grid((c, x, y) => { if (y === 1 && x <= 2) c.wallN = 'wall'; });
    const walls = allUrls(cs).filter((u) => u.startsWith('wall'));
    expect(walls.filter((u) => u === 'wall_half_endcap')).toHaveLength(2);
    expect(walls.filter((u) => u === 'wall_half')).toHaveLength(1);
    expect(walls.filter((u) => u === 'wall')).toHaveLength(0);
  });

  it('a barrier run uses the BARRIER family, and never mixes with the wall one', () => {
    const cs = grid((c, x, y) => {
      if (y === 1 && x <= 1) c.wallN = 'barrier';
      if (y === 3 && x <= 1) c.wallN = 'wall';
    });
    const u = allUrls(cs);
    /* The kit ships no barrier cap and a 4.00 wall nub is not a substitute for the end of a 1.10 rail,
       so a barrier run simply ends — and therefore keeps both of its edges for the 4u merge. The wall
       run beside it, identical in length, spends both of its finishing itself. That asymmetry is the
       family table, not an accident. */
    expect(u).toContain('barrier');
    expect(u.filter((n) => n.startsWith('barrier'))).toHaveLength(1);
    expect(u.filter((n) => n === 'wall_half_endcap')).toHaveLength(2);
    expect(u).not.toContain('wall');
  });

  it('a barrier gets the low piece, and a column the pillar', () => {
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'barrier'; }), 1, 1))
      .toContain('barrier_half');
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.corner = 'column'; }), 1, 1))
      .toContain('pillar');
  });

  it('`sloped` stands in as a solid wall until its own mesh exists', () => {
    // the WALL family, so a lone segment gets that family's finished 2u piece like any other
    expect(urls(grid((c, x, y) => { if (x === 1 && y === 1) c.wallN = 'sloped'; }), 1, 1))
      .toContain('wall_half_endcap');
  });

  it('a ROCK cell lays no ground of its own — it is not a place', () => {
    // its WALL is still drawn; walls belong to the grid, not to the cell that happens to be solid
    const out = urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'rock'; c.wallN = 'wall'; } }), 1, 1);
    expect(out.filter((u) => u.includes('floor'))).toEqual([]);
  });

  it('a PIT emits no ground but keeps its walls', () => {
    const out = urls(grid((c, x, y) => { if (x === 1 && y === 1) { c.floor = 'none'; c.wallN = 'wall'; } }), 1, 1);
    expect(out).toEqual(['wall_half_endcap', 'wall_endcap_short']);
  });

  it('a T-JUNCTION IS A NORMAL WALL — no piece of its own, and no end to finish', () => {
    /* Three arms meeting is not an end, so nothing is capped there, and the material reads as plain
       stone — no aperture, no special. `wall_Tsplit` and `wall_crossing` exist in the kit and stay
       unused on purpose: they consume arms the runs through them also want, and getting that wrong
       leaves a GAP in a wall rather than an ugly join. */
    const cs = grid((c, x, y) => {
      if (y === 1) c.wallN = 'wall';                          // a full row
      if (x === 2 && (y === 1 || y === 2)) c.wallW = 'wall';  // a stem hanging south from (2,1)
    });
    expect(wallEnds(cs, W, H).some((e) => e.x === 2 && e.y === 1)).toBe(false);
    expect(new Set(allUrls(cs).filter((n) => n !== 'floor_tile_large')))
      .toEqual(new Set(['wall', 'wall_half', 'wall_half_endcap']));
    // three loose ends in the whole figure — the two row ends and the foot of the stem
    expect(finishes(allUrls(cs))).toBe(3);
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
    expect(urls(cs, 2, 2)).toEqual(['floor_tile_large', 'wall_doorway_open']); // the arch, no wall_half
    expect(urls(cs, 1, 2)).toEqual(['floor_tile_large']);                // the neighbour's half is gone
    // beyond the span: ONE 2u piece, finished at its far end. The near end is not loose — the doorway
    // continues the wall — and a piece pushed in there is the bug `cell-module.test.ts` holds shut.
    expect(urls(cs, 3, 2)).toEqual(['floor_tile_large', 'wall_half_endcap']);
  });

  it('a module whose flanking wall does not continue is TERMINATED, not shortened', () => {
    /* THE CASE WITH NO RUN TO SHORTEN AT ALL, and the reason the nub tier has two answers rather than
       one. Two wall edges with a doorway at the point between them: the module claims BOTH, so each of
       its ends is a wall end whose last piece is 4u of stone with an aperture cut in it. There is no
       half-doorway to fall back to, so the end is terminated on the point instead. */
    const cs = grid((c, x, y) => {
      if (y === 2 && (x === 1 || x === 2)) c.wallN = 'wall';
      if (x === 2 && y === 2) { c.wallType = 'doorway'; c.open = 'open'; }
    });
    const u = allUrls(cs);
    expect(u.filter((n) => n === 'wall_doorway_open')).toHaveLength(1);
    expect(u.filter((n) => n === 'wall_endcap_short')).toHaveLength(2);
    expect(u.filter((n) => n.startsWith('wall_half'))).toHaveLength(0);
    // and the terminators stand OUTSIDE the module, at ±2.0 from its centre — see the aperture suite
    expect(wallEnds(cs, W, H).map((e) => `${e.x},${e.y}:${e.by}`)).toEqual(['1,2:module', '3,2:module']);
  });

  /* THE OTHER HALF OF THE SPLIT, at the point where meshes are actually emitted rather than merely
     tabulated. A shut door has to put a LEAF in its frame — that is the entire difference between the
     two states, and while they shared one url it was a difference nothing downstream could see. */
  it('a CLOSED doorway draws its leaf as well as its frame, at the same spot', () => {
    const cs = grid((c, x, y) => {
      if (y === 2 && (x === 1 || x === 2)) c.wallN = 'wall';
      if (x === 2 && y === 2) { c.wallType = 'doorway'; c.open = 'closed'; }
    });
    /* The cell also carries a terminator for the module's end (the nub tier's job, covered above), so
       assert the MODULE's pieces rather than the cell's whole list — otherwise this test breaks every
       time an unrelated tier changes what else stands here. */
    const shutUrls = urls(cs, 2, 2);
    expect(shutUrls).toContain('wall_doorway_open');
    expect(shutUrls).toContain('wall_door');
    expect(shutUrls.indexOf('wall_door')).toBe(shutUrls.indexOf('wall_doorway_open') + 1); // leaf after frame

    // and the OPEN state is that list minus the leaf — the SAME frame, not a different mesh
    const open = grid((c, x, y) => {
      if (y === 2 && (x === 1 || x === 2)) c.wallN = 'wall';
      if (x === 2 && y === 2) { c.wallType = 'doorway'; c.open = 'open'; }
    });
    const openUrls = urls(open, 2, 2);
    expect(openUrls).toContain('wall_doorway_open');
    expect(openUrls).not.toContain('wall_door');

    // co-located: the parts were cut from one file and keep its origin, so no second transform
    const at = (cs2: Cell[], name: string) => cellPlacements(cs2, W, H, 2, 2).find((p) => p.url.includes(name))!;
    const frame = at(cs, 'wall_doorway_open'), leaf = at(cs, 'wall_door.');
    expect([leaf.x, leaf.z, leaf.turn]).toEqual([frame.x, frame.z, frame.turn]);
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

  it('every wall type maps to at least one mesh, in both states', () => {
    for (const wt of ['solid', 'doorway', 'window', 'cracked', 'arch', 'gate'] as WallType[]) {
      for (const open of ['open', 'closed'] as const) {
        const urls = wallTypeUrls(wt, open);
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) expect(u).toContain(PIECE.wall.split('/')[0]!);
      }
    }
  });

  /* THE BUG THIS SPLIT EXISTS FOR. A shut door and an open one were one url told apart by a `#open`
     fragment, and `objIdOf` strips fragments — so both states landed on ONE id in the approved
     store, one id holds one footprint, and the shut door collided with the open one's hole. Adding
     something must ADD a piece, or the two states are indistinguishable to everything downstream. */
  it('a state that adds something names more pieces than the state without it', () => {
    for (const wt of ['doorway', 'gate'] as WallType[]) {
      const closed = wallTypeUrls(wt, 'closed'), open = wallTypeUrls(wt, 'open');
      expect(closed.length).toBeGreaterThan(open.length);
      for (const u of open) expect(closed).toContain(u);        // the shared part is literally shared
      expect(new Set(closed).size).toBe(closed.length);          // and nothing is drawn twice
    }
  });

  it('no piece is selected by a url fragment — an asset id must survive `objIdOf`', () => {
    for (const u of Object.values(PIECE)) expect(u).not.toContain('#');
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
       quantity that must not change when pieces get bigger — or, since the priority order landed,
       when they get SMALLER because a nub claimed one. See `EDGES` at the top of this file. */
    const walls = (fx?: { w: number; h: number }): number => edgesCovered(cs, sw, sh, fx);

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
    expect(p.z).toBe(-65536);            // (bh-1) - run = -1: the top end, not the middle
    expect(p.y).toBe(0);                 // sits ON the deck — no lift, no nudge, just the pivot
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
    /* COUNT EDGES, NOT PIECES. Adding the flanks changes how the NORTH wall is TILED — the flight now
       draws the corner, so the north run's ends stop being loose and its two edges merge into one 4u
       piece instead of becoming two finished halves. What must not move is how many edges the wall
       layer covers, because the flight is supposed to supply all four of the ones it took. Asserting
       on `wall_half` counts instead made this test fail on a re-tiling that never touched an edge. */
    expect(edgesCovered(block({ flanks: true }), SW, SH)).toBe(edgesCovered(block(), SW, SH));
    /* ...and the flank edges really are claimed by the FLIGHT, which is why the nub tier leaves their
       ends alone. Anything added at a stair mouth is geometry in the one place a body must squeeze
       through, and the stair mesh finishes its own sides anyway. */
    const flanked = block({ flanks: true });
    expect(wallEnds(flanked, SW, SH).filter((e) => e.by === 'flight').length).toBeGreaterThan(0);
    expect(finishes(allUrls(flanked, SW, SH))).toBe(0);
    expect(finishes(allUrls(block(), SW, SH))).toBe(2);   // without them, the north wall IS loose
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
    /* THE FILENAME IS THE OPPOSITE OF THE SIDE IT SERVES, and that is deliberate — see the note on
       `STAIR_MESHES`. These two meshes are mirror images given OPPOSITE corrective quarter-turns, and
       a mirror exchanges left and right, so `_right` is the mesh that ends up walled on the climber's
       LEFT. This test asserted the filename before anyone had looked at the render. */
    expect(l.url).toContain('stairs_wall_right');

    // the mirror image: walls at N and E puts the wall on your RIGHT
    const rightWall = mk((c, x, y) => {
      if (x >= 1 && x <= 2 && (y === 1 || y === 2)) c.floor = 'stairs';
      if (y === 1 && x >= 1 && x <= 2) c.wallN = 'wall';
      if ((y === 1 || y === 2) && x === 3) c.wallW = 'wall';
    });
    const r = stairFlight(rightWall, SW, SH, 1, 1)!;
    expect(r).toMatchObject({ up: 'N', walls: 1 });
    expect(r.url).toContain('stairs_wall_left');   // mirrored name — see above
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

  it('does not invent a head wall OFF THE MAP', () => {
    /* THE ONE THAT GOT AWAY, and it got away because every other fixture here sits at (1,1) with room
       on all sides, so no probe ever left the lattice.

       Put the block against the NORTH EDGE and the "does this wall carry on past the block" question
       has to look at y = -1. `wallOn` answers `wall` off the map — correct for "can I walk out there",
       wrong for this — and the reading whose head wall touches the border was scored as though it were
       a room wall running past. It cost the west reading a point, manufactured a tie with north, and a
       tiebreak then settled by luck what the geometry had already settled outright.

       Here: the north wall spans the full width (a genuine room wall, runs past on both sides); the
       west wall is exactly the block's two segments and stops (the stair's own head). West must win. */
    const atEdge = mk((c, x, y) => {
      if (x >= 3 && x <= 4 && y <= 1) c.floor = 'stairs';
      if (y === 0) c.wallN = 'wall';                        // room wall, full width
      if (x === 3 && y <= 1) c.wallW = 'wall';              // head wall, the block's extent exactly
    });
    expect(stairFlight(atEdge, SW, SH, 3, 0)).toMatchObject({ up: 'W' });

    // and the mirror — head wall on the north border, room wall running the full height on the west
    const mirrored = mk((c, x, y) => {
      if (x >= 3 && x <= 4 && y <= 1) c.floor = 'stairs';
      if (y === 0 && x >= 3 && x <= 4) c.wallN = 'wall';    // head wall, the block's extent exactly
      if (x === 3) c.wallW = 'wall';                        // room wall, full height
    });
    expect(stairFlight(mirrored, SW, SH, 3, 0)).toMatchObject({ up: 'N' });
  });

  it("the FOOT goes where the FLOOR is, not off the end of the structure", () => {
    /* FROM A REAL AUTHORED CASE. A 3x2 structure: a 2x2 stair block in the top-left corner, ordinary
       stone filling the right-hand column, `wallN` across the block's top and `wallW` down its left.
       Both walls are exactly the block's extent. The foot belongs on the RIGHT, on the stone — so it
       climbs WEST.

       North and west are IDENTICAL on every other signal: both head walls are 100% and both are the
       block's own. The ONLY thing between them is where the ground is, and north's foot points at the
       padding row — the strip of lattice past the structure's floor extent, which owns nothing. Read
       that as walkable and north scores an identical 20, the tiebreak cannot separate them either, and
       the fixed order hands it to north: a staircase whose entrance is outside the structure.

       So this test is really about the padding. `entryReachable` is handed the POINT lattice and has no
       idea which of it is real, which is why `forDisplay` pins the unowned slots to `none` before
       anything reads them. Pin them and W wins outright, 20 to an unusable 8. */
    const SW = 3, SH = 2;
    const lw = SW + 1, lh = SH + 1;          // the point lattice, which is what stairFlight is handed
    const cells: Cell[] = [];
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const c = openCell();
        const padding = x >= SW || y >= SH;
        if (padding) c.floor = 'none';       // owns nothing — see `abstainUnowned` / `forDisplay`
        else if (x <= 1 && y <= 1) c.floor = 'stairs';
        else c.floor = 'stone';              // the right-hand column: the way in
        if (!padding && y === 0 && x <= 1) c.wallN = 'wall';
        if (!padding && x === 0 && y <= 1) c.wallW = 'wall';
        cells.push(c);
      }
    }

    expect(stairFlight(cells, lw, lh, 0, 0)).toMatchObject({ up: 'W' });

    // and WHY, so a regression says which criterion moved rather than just flipping a letter
    const why = stairChoiceAt(cells, lw, lh, 0, 0)!;
    const by = (d: string) => why.ranks.find((r) => r.dir === d)!;
    expect(why.chosen).toBe('W');
    expect(by('W')).toMatchObject({ viable: true });
    expect(by('W').terms.ground).toBeGreaterThan(0);
    // north's head wall is just as good — it loses on the foot alone, and must be UNUSABLE not merely worse
    expect(by('N')).toMatchObject({ viable: false });
    expect(by('N').terms.headWall).toBe(by('W').terms.headWall);   // the heads are equally walled
    expect(by('N').terms.ground).toBe(0);                          // it is the GROUND that decides
    expect(by('W').score).toBeGreaterThan(by('N').score);
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

describe('cell-place — NOTHING STANDS IN AN APERTURE', () => {
  /*
   * The bug this exists for: a wall run that stopped because a doorway continued the wall counted its
   * arms with a function that answers "does the RUN LAYER draw this edge", got `null` for the opening,
   * concluded it was ending in mid-air, and planted a full-height endcap inside the doorway. A quarter
   * of every floor's openings had geometry in them.
   *
   * It survived because the assertion helper filtered `wall_endcap` out of every comparison. So this
   * test does not compare URL lists at all — it computes WORLD BOXES from measured mesh extents and
   * asks whether anything overlaps the clear span of an opening. A piece cannot hide from that by
   * being unfamiliar.
   */

  /** Measured off the GLBs (`tmp/glb-bbox.mjs`), in world units, for every piece a wall pass emits.
   *  `from` is the piece's own start along its native +X axis, relative to its pivot. */
  const FOOTPRINT: Record<string, { along: number; from: number }> = {
    wall: { along: 4, from: -2 },              // X[-2, 2]     — centred
    wall_half: { along: 2, from: 0 },          // X[ 0, 2]     — starts at its pivot
    wall_half_endcap: { along: 2, from: -2 },  // X[-2, 0]     — FINISHES at its pivot
    wall_endcap: { along: 1.07, from: 0 },     // X[ 0, 1.067] — the retired protruding stub
    wall_endcap_short: { along: 0.17, from: 0 },  // X[0.000, 0.170] — FLUSH at its pivot, all outside
  };
  const APERTURE = 2.0;   // the clear span of wall_doorway, measured; the module itself is 4u

  /**
   * Every placement, as a world-space interval on its own axis plus the cross-axis it sits on.
   *
   * THE TURN TABLE IS THE EASY THING TO GET BACKWARDS, and it was: `TURN_RAD` is [0, PI/2, PI, -PI/2]
   * about +Y, so +X maps to +X, -Z, -X, +Z for turns 0..3. Turn 1 runs NEGATIVE along Z and turn 3
   * POSITIVE, which is the opposite of what this helper used to say. It never showed, because the one
   * assertion below filters to the horizontal axis and every V-axis row was discarded unread.
   */
  const boxes = (cs: Cell[], w: number, h: number): { name: string; ax: 'H' | 'V'; lo: number; hi: number; cross: number }[] => {
    const out: { name: string; ax: 'H' | 'V'; lo: number; hi: number; cross: number }[] = [];
    for (const { x, y, placements } of gridPlacements(cs, w, h)) {
      for (const p of placements) {
        const name = p.url.split('/').pop()!.replace('.gltf.glb', '').replace('.glb', '').replace('#open', '');
        const fp = FOOTPRINT[name];
        if (!fp) continue;                                   // floors, openings, stairs — not run pieces
        // cell centre is (2x, 2y); placement offsets are in half-cells, so world = centre + offset
        const cx = 2 * x + p.x / 65536, cz = 2 * y + p.z / 65536;
        const along = p.turn % 2 === 0 ? 'H' : 'V';
        const dir = p.turn === 0 || p.turn === 3 ? 1 : -1;    // turns 1/2 face back along the axis
        const base = along === 'H' ? cx : cz;
        const a = base + dir * fp.from, b = a + dir * fp.along;
        out.push({ name, ax: along, lo: Math.min(a, b), hi: Math.max(a, b), cross: along === 'H' ? cz : cx });
      }
    }
    return out;
  };

  /** A horizontal doorway at lattice point (px,py) with wall either side of it. */
  const withDoor = (W: number, H: number, px: number, py: number, extra?: (c: Cell, x: number, y: number) => void): Cell[] => {
    const cs: Cell[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = openCell();
        if (y === py && x >= px - 2 && x <= px + 1) c.wallN = 'wall';
        if (x === px && y === py) { c.wallType = 'arch'; c.open = 'open'; }
        extra?.(c, x, y);
        cs.push(c);
      }
    }
    return cs;
  };

  const intruders = (cs: Cell[], W: number, H: number, px: number, py: number): string[] => {
    // the module is centred on the lattice point, which is the cell's NW corner: world (2px-1, 2py-1)
    const centre = 2 * px - 1, cross = 2 * py - 1;
    const lo = centre - APERTURE / 2, hi = centre + APERTURE / 2;
    return boxes(cs, W, H)
      .filter((b) => b.ax === 'H' && Math.abs(b.cross - cross) < 0.01 && b.hi > lo + 1e-6 && b.lo < hi - 1e-6)
      .map((b) => `${b.name} [${b.lo.toFixed(2)},${b.hi.toFixed(2)}]`);
  };

  it('a wall run that MEETS a doorway does not cap itself into it', () => {
    expect(intruders(withDoor(7, 4, 3, 2), 7, 4, 3, 2)).toEqual([]);
  });

  it('...nor when a perpendicular wall arrives at the same point', () => {
    const cs = withDoor(7, 5, 3, 2, (c, x, y) => { if (x === 3 && (y === 2 || y === 3)) c.wallW = 'wall'; });
    // the perpendicular run's own last piece is a separate design question (see openingGroups); this
    // asserts only that nothing FINISHING a wall is driven into the aperture
    expect(intruders(cs, 7, 5, 3, 2).filter((n) => n.startsWith('wall_half_endcap') || n.startsWith('wall_endcap_short')))
      .toEqual([]);
  });

  it('a module END takes its terminator OUTSIDE the aperture, not in it', () => {
    /* The nub tier's second answer stands ON the point where the wall stops, and the obvious way to
       get it wrong is to stand it on the module's own point instead of at the end of its span. A
       module spans 4u about its point, so its ends are at ±2.0 and its clear span is ±1.0 — the
       terminator has 1.0 of daylight, and this measures it rather than trusting the arithmetic. */
    const cs: Cell[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 7; x++) {
      const c = openCell();
      if (y === 2 && (x === 2 || x === 3)) c.wallN = 'wall';
      if (y === 2 && x === 3) { c.wallType = 'arch'; c.open = 'open'; }
      cs.push(c);
    }
    expect(intruders(cs, 7, 4, 3, 2)).toEqual([]);
    /* ...and the terminators really are there: one at each end of the lone module. The module is
       centred on world x = 5 and spans [3, 7], so each nub sits with its mating face ON an end and
       0.170 of flourish outside it — which is the whole claim about this piece, measured. */
    const nubs = boxes(cs, 7, 4).filter((b) => b.name === 'wall_endcap_short')
      .map((b) => `[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}]`).sort();
    expect(nubs).toEqual(['[2.83, 3.00]', '[7.00, 7.17]']);
    /* AND ASSERT THE INVARIANT, not just the two numbers. The literals above went stale the moment
       the mesh moved, and the version they replaced had the nub reaching 0.03 PAST the module's end
       and into the aperture — the exact thing this test is named for — while still passing, because
       a hard-coded string cannot notice that it describes a violation. `wall_endcap_short` used to
       start at x = -0.030 rather than 0, because `glb-trim` re-origined by the cut plane instead of
       by the geometry that survived the cut. Both ends now land exactly on the module's span. */
    const EPS = 1e-6;
    for (const n of boxes(cs, 7, 4).filter((b) => b.name === 'wall_endcap_short')) {
      // wholly beyond one end of the module's [3, 7] span — never overlapping the module at all
      const beyondNear = n.hi <= 3.0 + EPS, beyondFar = n.lo >= 7.0 - EPS;
      expect(beyondNear || beyondFar).toBe(true);
    }
  });

  it('a genuinely loose end STILL gets its finish — the fix must not remove all of them', () => {
    // NEGATIVE CONTROL. Emitting nothing at all would pass every assertion above and be wrong.
    const lone: Cell[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
      const c = openCell();
      if (y === 2 && (x === 2 || x === 3)) c.wallN = 'wall';   // a stub with both ends in open air
      lone.push(c);
    }
    const laid = gridPlacements(lone, 6, 4).flatMap((e) => e.placements)
      .filter((p) => p.url.includes('wall_half_endcap'));
    expect(laid.length).toBe(2);
    // and NOTHING protrudes past where the model says the wall stops: the run spans world x [3,7]
    const spans = boxes(lone, 6, 4).filter((b) => b.ax === 'H');
    expect(Math.min(...spans.map((b) => b.lo))).toBe(3);
    expect(Math.max(...spans.map((b) => b.hi))).toBe(7);
  });
});
