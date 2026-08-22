import { describe, it, expect } from 'vitest';
import { makeGrid, begin, commit, stamp, applyBatch, type CellGrid } from './cell-grid.ts';
import { template, segs, corners, wallTypes, fullField } from './cell-field.ts';
import { nodeId } from './cell-graph.ts';
import {
  gridAt, txAt, edgesOf, cellGraphOf, reachSet, keepsReach, reaches,
  findRoute, pinRouteOpen, routeGuaranteed, openingCertain, wallMask,
  mayBeOpen, mustBeOpen,
} from './cell-reach.ts';

const W = 6, H = 6;
const g0 = (): CellGrid => makeGrid(W, H);
const id = (x: number, y: number): number => nodeId(W, x, y);
const START = id(0, 0), GOAL = id(W - 1, H - 1);

/** Seal the whole x=3 column with a certain wall. */
const sealColumn = (g: CellGrid): void => {
  applyBatch(g, [{ region: { x: 3, y: 0, w: 1, h: H }, stamp: template({ wallW: segs('wall') }) }]);
};

describe('cell-reach — the two modalities', () => {
  it('a full domain MAY be open but is never GUARANTEED', () => {
    const f = fullField();
    expect(mayBeOpen(f.wallN)).toBe(true);
    expect(mustBeOpen(f.wallN)).toBe(false);
  });

  it('MAY is false only when pinned to exactly `wall`; MUST is false as soon as `wall` survives', () => {
    expect(mayBeOpen(segs('wall'))).toBe(false);
    expect(mayBeOpen(segs('none', 'wall'))).toBe(true);
    expect(mustBeOpen(segs('none', 'wall'))).toBe(false);
    expect(mustBeOpen(segs('none', 'barrier'))).toBe(true); // a barrier is surmountable
  });

  it('MUST implies MAY for every representable domain', () => {
    for (let m = 1; m < 16; m++) if (mustBeOpen(m)) expect(mayBeOpen(m)).toBe(true);
  });

  it('`sloped` counts as blocking in BOTH modalities', () => {
    expect(mayBeOpen(segs('sloped'))).toBe(false);
    expect(mustBeOpen(segs('none', 'sloped'))).toBe(false);
    expect(mayBeOpen(segs('none', 'sloped'))).toBe(true); // it could still collapse to none
  });

  it('reads a wall from its OWNER, and off-map as the perimeter shell', () => {
    const g = g0();
    applyBatch(g, [{ region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) }]);
    expect(wallMask(gridAt(g), 2, 2, 'W')).toBe(segs('wall'));
    expect(wallMask(gridAt(g), 1, 2, 'E')).toBe(segs('wall')); // same stored value, other side
    expect(wallMask(gridAt(g), W - 1, 0, 'E')).toBe(segs('wall')); // shell
  });
});

describe('cell-reach — the blank field is maximally connected (the safety base case)', () => {
  it('goal reachable optimistically, and NOT guaranteed', () => {
    const at = gridAt(g0());
    expect(reaches(at, W, H, 'may', START, GOAL)).toBe(true);
    expect(reaches(at, W, H, 'must', START, GOAL)).toBe(false);
  });

  it('every cell is may-reachable on a blank grid', () => {
    expect(reachSet(gridAt(g0()), W, H, 'may', START).filter(Boolean).length).toBe(W * H);
  });
});

describe('cell-reach — ONE edge enumeration (the drift regression)', () => {
  it('anything reachSet calls reachable, findRoute can actually route to', () => {
    for (const build of [g0, () => { const g = g0(); sealColumn(g); return g; }]) {
      const g = build();
      const at = gridAt(g);
      const seen = reachSet(at, W, H, 'may', START);
      for (let n = 0; n < W * H; n++) {
        const route = findRoute(at, W, H, 'may', START, n);
        expect(route !== null).toBe(seen[n] === true); // the two must agree, cell for cell
      }
    }
  });

  it('the graph is built from exactly the edges edgesOf emits', () => {
    const g = g0();
    applyBatch(g, [{ region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) }]);
    const at = gridAt(g);
    const edges = edgesOf(at, W, H, 'may');
    const graph = cellGraphOf(at, W, H, 'may');
    let counted = 0;
    for (const list of graph.adj) counted += list.length;
    const unique = new Set(edges.map((e) => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`));
    expect(counted / 2).toBe(unique.size);
  });

  it('a route is a connected chain from start to goal', () => {
    const route = findRoute(gridAt(g0()), W, H, 'may', START, GOAL)!;
    expect(route.length).toBeGreaterThan(0);
    expect(route[0]!.a).toBe(START);
    expect(route[route.length - 1]!.b).toBe(GOAL);
    for (let i = 1; i < route.length; i++) expect(route[i]!.a).toBe(route[i - 1]!.b);
  });
});

describe('cell-reach — pinning turns ACHIEVABLE into GUARANTEED', () => {
  it('after pinning, the goal is reachable pessimistically', () => {
    const g = g0();
    const route = findRoute(gridAt(g), W, H, 'may', START, GOAL)!;
    expect(reaches(gridAt(g), W, H, 'must', START, GOAL)).toBe(false);

    const tx = begin(g);
    pinRouteOpen(tx, route);
    expect(commit(tx)).toBe(true);

    expect(routeGuaranteed(gridAt(g), route)).toBe(true);
    expect(reaches(gridAt(g), W, H, 'must', START, GOAL)).toBe(true);
  });

  it('NEGATIVE CONTROL: forcing a wall onto a pinned hop breaks the guarantee', () => {
    const g = g0();
    const route = findRoute(gridAt(g), W, H, 'may', START, GOAL)!;
    const tx = begin(g);
    pinRouteOpen(tx, route);
    commit(tx);

    // stage a wall onto a hop the route depends on and judge BEFORE committing —
    // this is exactly the gate the generation loop applies to every proposal
    const hop = route.find((e) => e.pin)!;
    const tx2 = begin(g);
    stamp(tx2, { x: hop.pin!.x, y: hop.pin!.y, w: 1, h: 1 },
      template(hop.pin!.side === 'N' ? { wallN: segs('wall') } : { wallW: segs('wall') }));
    expect(routeGuaranteed(txAt(tx2), route)).toBe(false);
  });
});

describe('cell-reach — openings', () => {
  const withOpening = (): CellGrid => {
    const g = g0();
    sealColumn(g);
    applyBatch(g, [{
      region: { x: 3, y: 3, w: 1, h: 1 },
      stamp: template({ corner: corners('air'), wallType: wallTypes('door') }),
    }]);
    return g;
  };

  it('a CERTAIN opening reconnects a sealed map', () => {
    const sealed = g0(); sealColumn(sealed);
    expect(reaches(gridAt(sealed), W, H, 'may', START, GOAL)).toBe(false);
    expect(reaches(gridAt(withOpening()), W, H, 'may', START, GOAL)).toBe(true);
  });

  it('a MAYBE opening does not count — certain-only, so `may` is never inflated', () => {
    const g = g0(); sealColumn(g);
    applyBatch(g, [{
      region: { x: 3, y: 3, w: 1, h: 1 },
      stamp: template({ corner: corners('air'), wallType: wallTypes('door', 'window') }),
    }]);
    expect(openingCertain(gridAt(g), 3, 3)).toBe(false);
    expect(reaches(gridAt(g), W, H, 'may', START, GOAL)).toBe(false);
  });

  it('a route through an opening stays guaranteed — openings are monotone', () => {
    const g = withOpening();
    const route = findRoute(gridAt(g), W, H, 'may', START, GOAL)!;
    expect(route.some((e) => e.via)).toBe(true);
    expect(routeGuaranteed(gridAt(g), route)).toBe(false); // walls not pinned yet
    const tx = begin(g);
    pinRouteOpen(tx, route);
    commit(tx);
    expect(routeGuaranteed(gridAt(g), route)).toBe(true);
  });
});

describe('cell-reach — keepsReach compares SETS, never counts', () => {
  it('catches a swap that leaves the total identical', () => {
    const before = [true, true, false, false];
    const after = [true, false, true, false]; // same count, different cells
    expect(keepsReach(before, after)).toBe(false);
  });

  it('allows growth', () => {
    expect(keepsReach([true, false], [true, true])).toBe(true);
  });
});
