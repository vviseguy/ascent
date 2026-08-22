import { describe, it, expect } from 'vitest';
import { makeGrid, applyBatch, begin, commit, type CellGrid } from './cell-grid.ts';
import { template, segs, corners, wallTypes, fullField } from './cell-field.ts';
import { nodeId } from './cell-graph.ts';
import {
  mayBeOpen, mustBeOpen, wallMask, openingCertain, edgesOf, cellGraphOf,
  reachSet, keepsReach, reaches, findRoute, pinRouteOpen, routeGuaranteed,
  gridAt, txAt,
} from './cell-reach.ts';

const W = 6, H = 6;
const g0 = (): CellGrid => makeGrid(W, H);
const id = (x: number, y: number): number => nodeId(W, x, y);
const NW = id(0, 0), SE = id(W - 1, H - 1);

/** A full wall column at x=col — cuts the map in two. */
const sealColumn = (g: CellGrid, col: number): void => {
  applyBatch(g, [{ region: { x: col, y: 0, w: 1, h: H }, stamp: template({ wallW: segs('wall') }) }]);
};

describe('cell-reach — the two modalities', () => {
  it('a full domain MAY be open but is never GUARANTEED', () => {
    const m = fullField().wallN;
    expect(mayBeOpen(m)).toBe(true);
    expect(mustBeOpen(m)).toBe(false);
  });

  it('MAY is false only when pinned to exactly {wall}', () => {
    expect(mayBeOpen(segs('wall'))).toBe(false);
    expect(mayBeOpen(segs('none', 'wall'))).toBe(true);
    expect(mayBeOpen(segs('barrier'))).toBe(true); // surmountable
  });

  it('MUST is false as soon as `wall` survives', () => {
    expect(mustBeOpen(segs('none', 'wall'))).toBe(false);
    expect(mustBeOpen(segs('none', 'barrier'))).toBe(true);
  });

  it('MUST implies MAY for every representable domain', () => {
    for (let m = 1; m < 8; m++) if (mustBeOpen(m)) expect(mayBeOpen(m)).toBe(true);
  });
});

describe('cell-reach — the blank field is maximally connected (the safety base case)', () => {
  it('everything is reachable optimistically, nothing pessimistically', () => {
    const at = gridAt(g0());
    expect(reaches(at, W, H, 'may', NW, SE)).toBe(true);
    expect(reaches(at, W, H, 'must', NW, SE)).toBe(false);
  });

  it('a wall is read from its owner, identically from either side', () => {
    const g = g0();
    applyBatch(g, [{ region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) }]);
    const at = gridAt(g);
    expect(wallMask(at, 2, 2, 'W')).toBe(segs('wall'));
    expect(wallMask(at, 1, 2, 'E')).toBe(segs('wall'));
  });

  it('off the map is the perimeter shell', () => {
    expect(wallMask(gridAt(g0()), W - 1, 0, 'E')).toBe(segs('wall'));
  });
});

describe('cell-reach — NEGATIVE CONTROLS (the checker is not vacuous)', () => {
  it('a sealed column severs optimistic reachability', () => {
    const g = g0();
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(true);
    sealColumn(g, 3);
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(false);
  });

  it('an unreachable goal returns no route rather than a bogus one', () => {
    const g = g0();
    sealColumn(g, 3);
    expect(findRoute(gridAt(g), W, H, 'may', NW, SE)).toBeNull();
  });

  it('a pinned route stops being guaranteed once a wall is forced across it', () => {
    const g = g0();
    const route = findRoute(gridAt(g), W, H, 'may', NW, SE)!;
    const tx = begin(g);
    pinRouteOpen(tx, route);
    expect(commit(tx)).toBe(true);
    expect(routeGuaranteed(gridAt(g), route)).toBe(true);

    const hop = route.find((e) => e.pin)!;
    const bad = begin(g);
    applyBatch(bad.grid, []); // no-op; stage the wall through the tx below
    const t = template(hop.pin!.side === 'N' ? { wallN: segs('wall') } : { wallW: segs('wall') });
    bad.staged.set(hop.pin!.y * W + hop.pin!.x, t);
    expect(routeGuaranteed(txAt(bad), route)).toBe(false);
  });
});

describe('cell-reach — pinning turns ACHIEVABLE into GUARANTEED', () => {
  it('after pinning, the goal is reachable pessimistically', () => {
    const g = g0();
    expect(reaches(gridAt(g), W, H, 'must', NW, SE)).toBe(false);
    const route = findRoute(gridAt(g), W, H, 'may', NW, SE)!;
    const tx = begin(g);
    pinRouteOpen(tx, route);
    expect(commit(tx)).toBe(true);
    expect(routeGuaranteed(gridAt(g), route)).toBe(true);
    expect(reaches(gridAt(g), W, H, 'must', NW, SE)).toBe(true);
  });

  it('a route is a connected chain from start to goal', () => {
    const route = findRoute(gridAt(g0()), W, H, 'may', NW, SE)!;
    expect(route[0]!.a).toBe(NW);
    expect(route[route.length - 1]!.b).toBe(SE);
    for (let i = 1; i < route.length; i++) expect(route[i]!.a).toBe(route[i - 1]!.b);
  });
});

describe('cell-reach — openings are CERTAIN-only', () => {
  const withCorner = (cornerMask: number, typeMask: number): CellGrid => {
    const g = g0();
    applyBatch(g, [
      { region: { x: 3, y: 0, w: 1, h: H }, stamp: template({ wallW: segs('wall') }) },
      { region: { x: 3, y: 3, w: 1, h: 1 }, stamp: template({ corner: cornerMask, wallType: typeMask }) },
    ]);
    return g;
  };

  it('a pinned air corner with a pinned door counts, and reconnects the halves', () => {
    const g = withCorner(corners('air'), wallTypes('door'));
    expect(openingCertain(gridAt(g), 3, 3)).toBe(true);
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(true);
  });

  it('a MAYBE door does not count — it could still collapse to something solid', () => {
    const g = withCorner(corners('air'), wallTypes('door', 'window'));
    expect(openingCertain(gridAt(g), 3, 3)).toBe(false);
    expect(reaches(gridAt(g), W, H, 'may', NW, SE)).toBe(false); // under-claims, on purpose
  });

  it('a MAYBE air corner does not count either', () => {
    const g = withCorner(corners('air', 'solid'), wallTypes('door'));
    expect(openingCertain(gridAt(g), 3, 3)).toBe(false);
  });

  it('a solid corner with a door is not an opening', () => {
    expect(openingCertain(gridAt(withCorner(corners('solid'), wallTypes('door'))), 3, 3)).toBe(false);
  });
});

describe('cell-reach — ONE enumeration: the graph and the router cannot disagree', () => {
  // THE REGRESSION. In the 4u model these were built separately, one learned about openings and the
  // other did not, and the mismatch surfaced as a phantom "invariant broken". Both now come from
  // `edgesOf`, and this asserts the property that failure violated.
  const scrambled = (seed: number): CellGrid => {
    const g = g0();
    const stamps = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (x * 7 + y * 13 + seed * 31) % 6;
      if (k === 0) stamps.push({ region: { x, y, w: 1, h: 1 }, stamp: template({ wallN: segs('wall') }) });
      else if (k === 1) stamps.push({ region: { x, y, w: 1, h: 1 }, stamp: template({ wallW: segs('wall') }) });
      else if (k === 2) stamps.push({ region: { x, y, w: 1, h: 1 }, stamp: template({ corner: corners('air'), wallType: wallTypes('arch') }) });
    }
    for (const s of stamps) applyBatch(g, [s]);
    return g;
  };

  it('anything reachSet calls reachable, findRoute can route to — over many scrambled fields', () => {
    for (let seed = 0; seed < 12; seed++) {
      const at = gridAt(scrambled(seed));
      for (const p of ['may', 'must'] as const) {
        const reach = reachSet(at, W, H, p, NW);
        for (let n = 0; n < W * H; n++) {
          if (!reach[n]) continue;
          expect(findRoute(at, W, H, p, NW, n), `seed ${seed} ${p} → cell ${n}`).not.toBeNull();
        }
      }
    }
  });

  it('the graph is exactly the edge list — no edge from anywhere else', () => {
    const at = gridAt(scrambled(3));
    const g = cellGraphOf(at, W, H, 'may');
    const fromEdges = new Set<string>();
    for (const e of edgesOf(at, W, H, 'may')) { fromEdges.add(`${e.a}-${e.b}`); fromEdges.add(`${e.b}-${e.a}`); }
    let count = 0;
    g.adj.forEach((list, n) => list.forEach((m) => { count++; expect(fromEdges.has(`${n}-${m}`)).toBe(true); }));
    expect(count).toBeGreaterThan(0);
  });
});

describe('cell-reach — keepsReach permits growth, forbids loss', () => {
  it('growth is fine, loss is not', () => {
    expect(keepsReach([true, false], [true, true])).toBe(true);
    expect(keepsReach([true, true], [true, false])).toBe(false);
  });
});

describe('cell-reach — determinism', () => {
  it('the same field yields the identical route twice', () => {
    const a = findRoute(gridAt(g0()), W, H, 'may', NW, SE);
    const b = findRoute(gridAt(g0()), W, H, 'may', NW, SE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
