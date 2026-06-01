/**
 * src/floor/verify.test.ts — the verifier as an INDEPENDENT proof.
 *
 * Includes hand-built floors (positive + NEGATIVE) so we know the verifier actually
 * detects unsolvable / under-routed floors, and the headline FUZZ/SMOKE test that
 * generates floors across the whole knob space and asserts they all verify.
 */

import { describe, it, expect } from 'vitest';
import { generateFloor, type FloorConfig } from './generate.ts';
import { reachability, countRoutes, verifyFloor } from './verify.ts';
import { cellId, type Floor, type Edge } from './types.ts';

/* ---- tiny hand-built floor helpers (verifier must work on ANY Floor data) ---- */

function blankFloor(width: number, height: number, edges: Edge[], k: number): Floor {
  const cells = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) cells.push({ id: cellId(width, x, y), x, y, chunkType: 0 });
  const exits: number[] = [];
  for (let x = 0; x < width; x++) exits.push(cellId(width, x, height - 1));
  return {
    width,
    height,
    cells,
    edges,
    entry: cellId(width, 0, 0),
    exits,
    guaranteedRoutes: k,
    meta: { runSeed: '0', stratumIndex: 0, openness: 0, requestedRoutes: k, clamped: false },
  };
}

function walk(a: number, b: number, spine = 0): Edge {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { a: lo, b: hi, kind: 'WALK', breakable: false, perimeter: false, spine };
}

describe('verifier on hand-built floors', () => {
  it('detects an UNSOLVABLE floor (no edges at all)', () => {
    const f = blankFloor(3, 3, [], 1);
    const r = verifyFloor(f);
    expect(r.reachability.reachable).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.failures.some((s) => s.includes('UNREACHABLE'))).toBe(true);
  });

  it('detects a floor that is reachable but UNDER-ROUTED (claims more than exist)', () => {
    // Single chain 0-1(top via a 2x2): one path only, but claim k=2.
    const w = 2;
    const edges = [walk(cellId(w, 0, 0), cellId(w, 0, 1))]; // single vertical edge
    const f = blankFloor(w, 2, edges, 2);
    const r = verifyFloor(f);
    expect(r.reachability.reachable).toBe(true);
    expect(r.routeCount.routes).toBe(1);
    expect(r.routeCount.meetsClaim).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.failures.some((s) => s.includes('INSUFFICIENT_ROUTES'))).toBe(true);
  });

  it('confirms a solvable floor with exactly the claimed routes', () => {
    // 2x2 with two disjoint paths from entry(0,0) to top row:
    //  path A: (0,0)-(0,1)             [left col up]
    //  path B: (0,0)-(1,0)-(1,1)       [right along bottom, then up]
    const w = 2;
    const A = cellId(w, 0, 0);
    const edges = [
      walk(A, cellId(w, 0, 1)),
      walk(A, cellId(w, 1, 0)),
      walk(cellId(w, 1, 0), cellId(w, 1, 1)),
    ];
    const f = blankFloor(w, 2, edges, 2);
    const r = verifyFloor(f);
    expect(r.reachability.reachable).toBe(true);
    expect(r.routeCount.routes).toBe(2);
    expect(r.ok).toBe(true);
  });

  it('reachability(strictFreeOnly) ignores gated edges except perimeter', () => {
    const w = 2;
    const A = cellId(w, 0, 0);
    // only a BREAK edge connects up, no perimeter: strict layer cannot pass it.
    const breakEdge: Edge = { a: Math.min(A, cellId(w, 0, 1)), b: Math.max(A, cellId(w, 0, 1)), kind: 'BREAK', breakable: true, perimeter: false, spine: 0 };
    const f = blankFloor(w, 2, [breakEdge], 1);
    expect(reachability(f, false).reachable).toBe(true); // fallback layer passes BREAK
    expect(reachability(f, true).reachable).toBe(false); // strict free-only does not
  });

  it('countRoutes matches Menger on a known 3-disjoint-path graph', () => {
    // width 3, height 2, entry (1,0) interior, three disjoint paths up:
    //  up via col1; left via (0,0)->(0,1); right via (2,0)->(2,1)
    const w = 3;
    const E = cellId(w, 1, 0);
    const f = blankFloor(w, 2, [
      walk(E, cellId(w, 1, 1)),
      walk(E, cellId(w, 0, 0)),
      walk(cellId(w, 0, 0), cellId(w, 0, 1)),
      walk(E, cellId(w, 2, 0)),
      walk(cellId(w, 2, 0), cellId(w, 2, 1)),
    ], 3);
    // entry for blankFloor is (0,0); override to interior for this case:
    f.entry = E;
    expect(countRoutes(f).routes).toBe(3);
  });
});

/* ----------------------------- the headline fuzz ----------------------------- */

describe('SMOKE/FUZZ: verifier finds all generated floors solvable & routed', () => {
  it('passes across the knob space (gridSize × openness × k × gateDensity × seeds)', () => {
    const gridSizes = [2, 3, 4, 5, 6, 8, 12];
    const opennessLevels = [0, 0.25, 0.5, 0.75, 1];
    const ks = [1, 2, 3, 4];
    const gateDensities = [0, 0.5, 1];
    const seedsPerCombo = 4;

    let total = 0;
    let seedCounter = 0n;
    const failures: string[] = [];

    for (const gridSize of gridSizes) {
      for (const openness of opennessLevels) {
        for (const k of ks) {
          for (const gateDensity of gateDensities) {
            for (let s = 0; s < seedsPerCombo; s++) {
              const seed = (seedCounter * 0x9e3779b97f4a7c15n + 0x1234567n) & 0xffffffffffffffffn;
              seedCounter += 1n;
              const stratumIndex = Number(seedCounter % 89n);
              const config: FloorConfig = { gridSize, openness, guaranteedRoutes: k, gateDensity, seed, stratumIndex };
              const floor = generateFloor(config);
              const r = verifyFloor(floor);
              total++;
              if (!r.ok) {
                failures.push(
                  `FAIL seed=${seed}n idx=${stratumIndex} grid=${gridSize} openness=${openness} k=${k} gate=${gateDensity} :: ${r.failures.join('; ')}`,
                );
              }
            }
          }
        }
      }
    }

    if (failures.length > 0) {
      // Surface the exact reproducing config(s).
      throw new Error(`${failures.length}/${total} floors failed:\n${failures.slice(0, 10).join('\n')}`);
    }
    expect(total).toBeGreaterThan(1000);
  });
});
