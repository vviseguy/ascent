import { describe, it, expect } from 'vitest';
import { makeGrid, begin, stamp, commit, applyBatch, type TileGrid } from './tile-grid.ts';
import { template, segs, fullField } from './wall-tile-field.ts';
import { cornerId } from './corner-graph.ts';
import { generateEmergent } from './emergent.ts';
import {
  reachSet,
  keepsReach,
  armMayBeOpen,
  armMustBeOpen,
  armMasks,
  armPassable,
  gridAt,
  txAt,
  findRoute,
  reaches,
  pinRouteOpen,
  routeGuaranteed,
} from './tile-reach.ts';

const W = 4, H = 4;
const NW = cornerId(W, 0, 0);
const SE = cornerId(W, W, H);

const blank = (): TileGrid => makeGrid(W, H);

/** Seal every horizontal crossing at the cx=1 seam: block the N and S arms of tile column x=0.
 *  (A corner pair (1,y)↔(2,y)… is served by the N arm of the tile below-left and the S arm of the one
 *  above-left, so blocking both arms down a whole column severs the seam for every row.) */
const sealColumn = (g: TileGrid, col: number): void => {
  applyBatch(g, [{
    region: { x: col, y: 0, w: 1, h: H },
    stamp: template({ edge: { N: segs('wall') }, inner: { N: segs('wall'), S: segs('wall') } }),
  }]);
};

describe('tile-reach — the two modalities', () => {
  it('a FULL domain may be open but is never guaranteed', () => {
    const f = fullField();
    expect(armMayBeOpen(f.edge.N, f.inner.N)).toBe(true);
    expect(armMustBeOpen(f.edge.N, f.inner.N)).toBe(false);
  });

  it('MAY is false only when both cells are pinned to exactly {wall}', () => {
    const wall = segs('wall');
    expect(armMayBeOpen(wall, wall)).toBe(false);
    expect(armMayBeOpen(wall, segs('none', 'wall'))).toBe(true); // inner could still be none
    expect(armMayBeOpen(segs('none', 'wall'), wall)).toBe(true);
    expect(armMayBeOpen(segs('barrier'), segs('barrier'))).toBe(true); // a barrier is surmountable
  });

  it('MUST is false as soon as `wall` survives in BOTH domains', () => {
    expect(armMustBeOpen(segs('none', 'wall'), segs('none', 'wall'))).toBe(false);
    expect(armMustBeOpen(segs('none', 'wall'), segs('none', 'barrier'))).toBe(true);
    expect(armMustBeOpen(segs('none'), segs('wall'))).toBe(true); // edge can't be a wall → no block
  });

  it('MUST implies MAY, for every representable pair of domains', () => {
    for (let e = 1; e < 8; e++) {
      for (let i = 1; i < 8; i++) {
        if (armMustBeOpen(e, i)) expect(armMayBeOpen(e, i)).toBe(true);
      }
    }
  });
});

describe('tile-reach — the blank field is maximally connected (the safety base case)', () => {
  it('every arm MAY be open on a blank grid', () => {
    const at = gridAt(blank());
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        expect(armPassable(at, x, y, 'N', 'may')).toBe(true);
        expect(armPassable(at, x, y, 'E', 'may')).toBe(true);
      }
    }
  });

  it('corner to opposite corner is reachable optimistically, and NOT guaranteed', () => {
    const at = gridAt(blank());
    expect(reaches(at, W, H, 'may', NW, SE)).toBe(true);
    expect(reaches(at, W, H, 'must', NW, SE)).toBe(false);
  });

  it('the map perimeter is the wall shell — a border tile reads its outer edge as {wall}', () => {
    const at = gridAt(blank());
    // tile (W-1, y) has no east neighbour, so its E edge resolves to the perimeter constant
    const m = armMasks(at, W - 1, 0, 'E');
    expect(m).not.toBeNull();
    expect(m!.edge).toBe(segs('wall'));
    // still MAY be open, because the tile's own inner cell is unconstrained
    expect(armMayBeOpen(m!.edge, m!.inner)).toBe(true);
  });
});

describe('tile-reach — owner resolution (a shared edge cell is read, never duplicated)', () => {
  it("tile A's E arm reads its EAST neighbour's owned W edge", () => {
    const g = blank();
    applyBatch(g, [{ region: { x: 1, y: 0, w: 1, h: 1 }, stamp: template({ edge: { W: segs('wall') } }) }]);
    const at = gridAt(g);
    expect(armMasks(at, 0, 0, 'E')!.edge).toBe(segs('wall')); // A(0,0).E === B(1,0).W
    expect(armMasks(at, 1, 0, 'W')!.edge).toBe(segs('wall'));
  });

  it("tile A's S arm reads its SOUTH neighbour's owned N edge", () => {
    const g = blank();
    applyBatch(g, [{ region: { x: 0, y: 1, w: 1, h: 1 }, stamp: template({ edge: { N: segs('wall') } }) }]);
    const at = gridAt(g);
    expect(armMasks(at, 0, 0, 'S')!.edge).toBe(segs('wall'));
  });
});

describe('tile-reach — NEGATIVE CONTROLS (proves the checker is not vacuous)', () => {
  it('a sealed column severs optimistic reachability across it', () => {
    const g = blank();
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(true); // before
    sealColumn(g, 0);
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(false); // after — the wall really blocks
  });

  it('a route that has been pinned open STOPS being guaranteed once a wall is forced across it', () => {
    const g = blank();
    const route = findRoute(gridAt(g), W, H, 'may', NW, SE)!;
    const tx = begin(g);
    pinRouteOpen(tx, route);
    expect(commit(tx)).toBe(true);
    expect(routeGuaranteed(gridAt(g), route)).toBe(true);

    // force a wall onto a cell the route depends on → the domain empties → the arm stops being passable
    const e = route[0]!;
    const bad = begin(g);
    const inner: Record<string, number> = {};
    inner[e.dir] = segs('wall');
    stamp(bad, { x: e.x, y: e.y, w: 1, h: 1 }, template({ inner: inner as never }));
    expect(routeGuaranteed(txAt(bad), route)).toBe(false); // the gate that must fire a rollback
  });

  it('an unreachable goal returns no route rather than a bogus one', () => {
    const g = blank();
    sealColumn(g, 0);
    expect(findRoute(gridAt(g), W, H, 'may', NW, SE)).toBeNull();
  });
});

describe('tile-reach — pinning turns ACHIEVABLE into GUARANTEED', () => {
  it('after pinning, the goal is reachable pessimistically and every arm is guaranteed', () => {
    const g = blank();
    const route = findRoute(gridAt(g), W, H, 'may', NW, SE);
    expect(route).not.toBeNull();
    expect(reaches(gridAt(g), W, H, 'must', NW, SE)).toBe(false); // nothing guaranteed yet

    const tx = begin(g);
    pinRouteOpen(tx, route!);
    expect(commit(tx)).toBe(true);

    expect(routeGuaranteed(gridAt(g), route!)).toBe(true);
    expect(reaches(gridAt(g), W, H, 'must', NW, SE)).toBe(true); // now it is
  });

  it('pinning touches ONLY tile-private inner cells — no shared edge is narrowed', () => {
    const g = blank();
    const route = findRoute(gridAt(g), W, H, 'may', NW, SE)!;
    const before = g.cells.map((c) => ({ N: c.edge.N, W: c.edge.W }));
    const tx = begin(g);
    pinRouteOpen(tx, route);
    commit(tx);
    g.cells.forEach((c, i) => {
      expect(c.edge.N).toBe(before[i]!.N);
      expect(c.edge.W).toBe(before[i]!.W);
    });
  });
});

describe('tile-reach — monotonicity (why the loop is safe)', () => {
  it('narrowing can only SHRINK may-reachability and only GROW must-reachability', () => {
    const g = blank();
    const mayBefore = reaches(gridAt(g), W, H, 'may', NW, SE);
    const mustBefore = reaches(gridAt(g), W, H, 'must', NW, SE);

    const route = findRoute(gridAt(g), W, H, 'may', NW, SE)!;
    const tx = begin(g);
    pinRouteOpen(tx, route);
    commit(tx);

    const mayAfter = reaches(gridAt(g), W, H, 'may', NW, SE);
    const mustAfter = reaches(gridAt(g), W, H, 'must', NW, SE);
    expect(mayBefore && !mayAfter).toBe(false); // may never gained
    expect(!mustBefore && mustAfter).toBe(true); // must gained, as pinning intends
  });
});

describe('tile-reach — determinism', () => {
  it('the same field yields the byte-identical route twice', () => {
    const a = findRoute(gridAt(blank()), W, H, 'may', NW, SE);
    const b = findRoute(gridAt(blank()), W, H, 'may', NW, SE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a route is a connected chain from start to goal', () => {
    const route = findRoute(gridAt(blank()), W, H, 'may', NW, SE)!;
    expect(route.length).toBeGreaterThan(0);
    expect(route[0]!.a).toBe(NW);
    expect(route[route.length - 1]!.b).toBe(SE);
    for (let i = 1; i < route.length; i++) expect(route[i]!.a).toBe(route[i - 1]!.b);
  });
});

describe('tile-reach — the two graphs must admit the SAME edges', () => {
  // THE REGRESSION. `reachSet` goes through domainCornerGraph; `findRoute` builds its own adjacency.
  // When openings were taught to one and not the other, reachability reported a target as reachable
  // and the router then found no path to it — which surfaced as "invariant broken", not as the graph
  // mismatch it actually was. Any future edge kind has to be added to both, and this catches it.
  it('anything reachSet calls reachable, findRoute can actually route to', () => {
    for (const seed of [3n, 23n, 101n]) {
      const r = generateEmergent({ width: 12, height: 10, seed });
      const at = gridAt(r.grid);
      const reach = reachSet(at, 12, 10, 'may', r.entryCorner);
      for (let n = 0; n < reach.length; n++) {
        if (!reach[n]) continue;
        expect(findRoute(at, 12, 10, 'may', r.entryCorner, n), `no route to corner ${n}`).not.toBeNull();
      }
    }
  });

  it('keepsReach allows growth and forbids loss', () => {
    expect(keepsReach([true, false], [true, true])).toBe(true); // gained one — fine
    expect(keepsReach([true, true], [true, false])).toBe(false); // lost one — not fine
    expect(keepsReach([true, true], [true, true])).toBe(true);
  });
});
