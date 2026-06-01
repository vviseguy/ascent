/**
 * src/floor/generate.test.ts — generator determinism, structure, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { generateFloor, maxSupportableRoutes, DEFAULT_GATE_WEIGHTS, type FloorConfig } from './generate.ts';
import { cellXY } from './types.ts';

function cfg(over: Partial<FloorConfig> = {}): FloorConfig {
  return {
    gridSize: 8,
    openness: 0.3,
    guaranteedRoutes: 2,
    seed: 0xdeadbeefn,
    stratumIndex: 0,
    ...over,
  };
}

describe('generator determinism', () => {
  it('same config+seed => byte-identical floor (deep equal)', () => {
    const a = generateFloor(cfg());
    const b = generateFloor(cfg());
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('different seed => different floor', () => {
    const a = generateFloor(cfg({ seed: 1n }));
    const b = generateFloor(cfg({ seed: 2n }));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('different stratumIndex => different floor', () => {
    const a = generateFloor(cfg({ stratumIndex: 0 }));
    const b = generateFloor(cfg({ stratumIndex: 1 }));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('adding openness does not shift the spine carve (stage decoupling)', () => {
    // Spines come from S_SPINES; openness from S_OPENNESS. The spine edges (spine>=0)
    // should be identical regardless of the openness knob.
    const tight = generateFloor(cfg({ openness: 0 }));
    const loose = generateFloor(cfg({ openness: 0.9 }));
    const spineEdges = (f: ReturnType<typeof generateFloor>) =>
      f.edges.filter((e) => e.spine >= 0).map((e) => `${e.a}-${e.b}:${e.kind}:${e.spine}`);
    expect(spineEdges(tight)).toEqual(spineEdges(loose));
  });
});

describe('generator structure', () => {
  it('produces a dense cell grid with consistent ids/coords', () => {
    const f = generateFloor(cfg({ gridSize: 6 }));
    expect(f.cells.length).toBe(36);
    f.cells.forEach((c, i) => {
      expect(c.id).toBe(i);
      const { x, y } = cellXY(f.width, c.id);
      expect(c.x).toBe(x);
      expect(c.y).toBe(y);
    });
  });

  it('entry is on the bottom row, exits are the top row', () => {
    const f = generateFloor(cfg({ gridSize: 7 }));
    expect(Math.floor(f.entry / f.width)).toBe(0);
    for (const ex of f.exits) expect(Math.floor(ex / f.width)).toBe(f.height - 1);
    expect(f.exits.length).toBe(f.width);
  });

  it('canonical edges (a<b), no duplicates', () => {
    const f = generateFloor(cfg({ gridSize: 10, openness: 1 }));
    const seen = new Set<string>();
    for (const e of f.edges) {
      expect(e.a).toBeLessThan(e.b);
      const key = `${e.a}-${e.b}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('perimeter is fully present and all WALK', () => {
    const f = generateFloor(cfg({ gridSize: 5, openness: 0 }));
    const perim = f.edges.filter((e) => e.perimeter);
    // a w x h boundary ring has 2*(w-1) + 2*(h-1) edges
    const expected = 2 * (f.width - 1) + 2 * (f.height - 1);
    expect(perim.length).toBe(expected);
    for (const e of perim) expect(e.kind).toBe('WALK');
  });

  it('openness 0 => only spines + perimeter; openness 1 => (near) complete grid', () => {
    const tight = generateFloor(cfg({ gridSize: 8, openness: 0 }));
    const open = generateFloor(cfg({ gridSize: 8, openness: 1 }));
    // complete 4-neighbour grid edge count = w*(h-1) + h*(w-1)
    const complete = 8 * 7 + 8 * 7;
    expect(open.edges.length).toBe(complete);
    expect(tight.edges.length).toBeLessThan(open.edges.length);
  });

  it('cells are tagged with chunk types in [0, chunkTypeCount)', () => {
    const f = generateFloor(cfg({ gridSize: 6, chunkTypeCount: 3 }));
    for (const c of f.cells) {
      expect(c.chunkType).toBeGreaterThanOrEqual(0);
      expect(c.chunkType).toBeLessThan(3);
    }
  });
});

describe('k clamping (documented behavior: clamp + report, never silent fail)', () => {
  it('maxSupportableRoutes caps by entry degree and width', () => {
    expect(maxSupportableRoutes(2, 2)).toBe(2); // edge entry, width 2 => 2
    expect(maxSupportableRoutes(3, 3)).toBe(3); // interior entry deg 3
    expect(maxSupportableRoutes(10, 10)).toBe(3); // capped by entry degree 3
    expect(maxSupportableRoutes(1, 5)).toBe(1); // degenerate width
  });

  it('requesting k beyond support clamps and sets meta.clamped', () => {
    const f = generateFloor(cfg({ gridSize: 10, guaranteedRoutes: 4 }));
    expect(f.meta.requestedRoutes).toBe(4);
    expect(f.guaranteedRoutes).toBe(3); // clamped to entry degree
    expect(f.meta.clamped).toBe(true);
  });

  it('requesting a supportable k does not clamp', () => {
    const f = generateFloor(cfg({ gridSize: 10, guaranteedRoutes: 2 }));
    expect(f.guaranteedRoutes).toBe(2);
    expect(f.meta.clamped).toBe(false);
  });
});

describe('grid minimums & extremes', () => {
  it('gridSize below 2 is bumped to 2 (no crash)', () => {
    const f = generateFloor(cfg({ gridSize: 1 }));
    expect(f.width).toBe(2);
    expect(f.height).toBe(2);
  });

  it('openness outside [0,1] is clamped', () => {
    const lo = generateFloor(cfg({ openness: -5 }));
    const hi = generateFloor(cfg({ openness: 5 }));
    expect(lo.meta.openness).toBe(0);
    expect(hi.meta.openness).toBe(1);
  });

  it('custom gate weights are accepted', () => {
    const f = generateFloor(cfg({ gridSize: 8, openness: 0.5, gateWeights: { ...DEFAULT_GATE_WEIGHTS, BREAK: 10 } }));
    expect(f.edges.length).toBeGreaterThan(0);
  });
});
