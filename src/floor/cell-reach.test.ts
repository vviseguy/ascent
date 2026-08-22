import { describe, it, expect } from 'vitest';
import { makeGrid, begin, commit, stamp, rollback, applyBatch, type CellGrid } from './cell-grid.ts';
import { template, segs, corners, wallTypes, fullField } from './cell-field.ts';
import { nodeId } from './cell-graph.ts';
import {
  gridAt, txAt, edgesOf, cellGraphOf, reachSet, keepsReach, reaches,
  findRoute, pinRouteOpen, routeGuaranteed, openingCertain, wallMask, stillConnected,
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

describe('cell-reach — the fast reachSet agrees with the edge enumeration exactly', () => {
  /** The slow, obviously-correct version: materialise the graph from `edgesOf` and BFS that. */
  const viaGraph = (g: CellGrid, p: 'may' | 'must', start: number): boolean[] => {
    const graph = cellGraphOf(gridAt(g), W, H, p);
    const seen = new Array<boolean>(W * H).fill(false);
    const q = [start];
    seen[start] = true;
    for (let i = 0; i < q.length; i++) for (const m of graph.adj[q[i]!]!) if (!seen[m]) { seen[m] = true; q.push(m); }
    return seen;
  };

  it('PROPERTY: identical results on blank, sealed, opened and heavily-walled fields', () => {
    const cases: (() => CellGrid)[] = [
      g0,
      () => { const g = g0(); sealColumn(g); return g; },
      () => {
        const g = g0(); sealColumn(g);
        applyBatch(g, [{ region: { x: 3, y: 3, w: 1, h: 1 }, stamp: template({ corner: corners('air'), wallType: wallTypes('door') }) }]);
        return g;
      },
      () => {
        const g = g0();
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if ((x * 7 + y * 13) % 3 === 0) applyBatch(g, [{ region: { x, y, w: 1, h: 1 }, stamp: template({ wallN: segs('wall') }) }]);
          if ((x * 5 + y * 11) % 4 === 0) applyBatch(g, [{ region: { x, y, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) }]);
        }
        return g;
      },
    ];
    for (const build of cases) {
      const g = build();
      for (const p of ['may', 'must'] as const) {
        for (const start of [START, GOAL, id(2, 4)]) {
          expect(reachSet(gridAt(g), W, H, p, start)).toEqual(viaGraph(g, p, start));
        }
      }
    }
  });
});

describe('cell-reach — the cheap gate is SAFE, and stricter than recomputing the reachable set', () => {
  it('PROPERTY: stillConnected ⟹ no cell was lost, and the two agree wherever the entry reaches', () => {
    let checked = 0, disconnecting = 0, stricter = 0;
    for (let trial = 0; trial < 60; trial++) {
      // a pseudo-random field, deterministic in `trial`
      const g = g0();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if ((x * 7 + y * 13 + trial * 3) % 5 === 0) {
          applyBatch(g, [{ region: { x, y, w: 1, h: 1 }, stamp: template({ wallN: segs('wall') }) }]);
        }
        if ((x * 5 + y * 11 + trial * 7) % 5 === 0) {
          applyBatch(g, [{ region: { x, y, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) }]);
        }
      }
      const before = reachSet(gridAt(g), W, H, 'may', START);

      // try walling one more wall, everywhere it is still possible
      for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) {
        for (const side of ['N', 'W'] as const) {
          const tx = begin(g);
          stamp(tx, { x, y, w: 1, h: 1 }, template(side === 'N' ? { wallN: segs('wall') } : { wallW: segs('wall') }));
          const at = txAt(tx);
          if (!at(x, y)) { rollback(tx); continue; }

          const here = id(x, y);
          const other = side === 'N' ? id(x, y - 1) : id(x - 1, y);
          const cheap = stillConnected(at, W, H, 'may', here, other);
          const full = keepsReach(before, reachSet(at, W, H, 'may', START));

          // SAFETY: the cheap gate never accepts a wall that loses a cell
          if (cheap) expect({ x, y, side, full }).toEqual({ x, y, side, full: true });
          // where the entry reaches BOTH endpoints the two agree exactly. Not "either": if only one
          // is reachable then the edge between them cannot have been open, so walling is a no-op
          // (full = true) while the pair is genuinely disconnected (cheap = false).
          if (before[here] && before[other]) expect({ x, y, side, cheap }).toEqual({ x, y, side, cheap: full });
          else if (!cheap && full) stricter++; // they differ only across an already-severed pair

          checked++;
          if (!cheap) disconnecting++;
          rollback(tx);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(disconnecting).toBeGreaterThan(0); // the cases where it says NO are real, not vacuous
    expect(stricter).toBeGreaterThan(0);      // and the strictness is real too, not a theory
  });
});
