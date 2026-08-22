import { describe, it, expect } from 'vitest';
import { generateEmergent, resolveEmergent, verifyEmergent, type EmergentConfig } from './emergent.ts';
import { buildCornerGraph, reachableFromSet } from './corner-graph.ts';
import { gridAt, reaches, routeGuaranteed } from './tile-reach.ts';
import { domainSize } from './wall-tile-field.ts';
import { DIRS } from './wall-tile.ts';

const cfg = (o: Partial<EmergentConfig> = {}): EmergentConfig => ({
  width: 12, height: 10, seed: 7n, ...o,
});

/** Reachability on the COLLAPSED tiles — the end-to-end truth, independent of the field's own view. */
const resolvedReach = (c: EmergentConfig): { reach: boolean[]; entry: number; exit: number; targets: number[] } => {
  const r = generateEmergent(c);
  const tiles = resolveEmergent(r, c.seed);
  const g = buildCornerGraph(tiles, c.width, c.height);
  return { reach: reachableFromSet(g, [r.entryCorner]), entry: r.entryCorner, exit: r.exitCorner, targets: r.targets };
};

describe('emergent — determinism', () => {
  it('same config + seed ⇒ byte-identical field', () => {
    const a = generateEmergent(cfg());
    const b = generateEmergent(cfg());
    expect(JSON.stringify(a.grid)).toBe(JSON.stringify(b.grid));
    expect(JSON.stringify(a.rooms)).toBe(JSON.stringify(b.rooms));
    expect(JSON.stringify(a.route)).toBe(JSON.stringify(b.route));
  });

  it('different seeds ⇒ different floors', () => {
    const a = generateEmergent(cfg({ seed: 1n }));
    const b = generateEmergent(cfg({ seed: 2n }));
    expect(JSON.stringify(a.grid)).not.toBe(JSON.stringify(b.grid));
  });

  it('the collapse pick cannot change the outcome — settling leaves every domain a singleton', () => {
    const r = generateEmergent(cfg());
    for (const c of r.grid.cells) {
      for (const d of DIRS) expect(domainSize(c.inner[d])).toBe(1);
      expect(domainSize(c.edge.N)).toBe(1);
      expect(domainSize(c.edge.W)).toBe(1);
    }
  });
});

describe('emergent — THE invariant: every target stays reachable', () => {
  const knobs: EmergentConfig[] = [];
  for (const seed of [1n, 2n, 3n, 5n, 8n, 13n]) {
    for (const [w, h] of [[8, 8], [12, 10], [16, 14]] as const) {
      knobs.push(cfg({ width: w, height: h, seed }));
    }
  }

  it('holds across the knob space, on the FIELD (pessimistic reachability)', () => {
    for (const c of knobs) {
      const r = generateEmergent(c);
      expect(routeGuaranteed(gridAt(r.grid), r.route)).toBe(true);
      for (const t of r.targets) {
        expect(reaches(gridAt(r.grid), c.width, c.height, 'must', r.entryCorner, t)).toBe(true);
      }
      expect(verifyEmergent(r)).toBe(true);
    }
  });

  it('holds across the knob space, on the COLLAPSED tiles (the end-to-end truth)', () => {
    for (const c of knobs) {
      const { reach, exit, targets } = resolvedReach(c);
      expect(reach[exit]).toBe(true);
      for (const t of targets) expect(reach[t]).toBe(true);
    }
  });

  it('never emits a conflicted (null) tile', () => {
    for (const c of knobs) {
      const r = generateEmergent(c);
      expect(resolveEmergent(r, c.seed).filter((t) => t === null)).toHaveLength(0);
    }
  });
});

describe('emergent — NON-VACUITY: the gates actually fire', () => {
  it('some proposals ARE rejected — a run that accepted everything would prove nothing', () => {
    // aggregate over seeds: the reachability gate is rare by design (one surviving path is enough),
    // so assert it fires somewhere in the space rather than on every single floor.
    let unreachableRejections = 0;
    let claimRejections = 0;
    for (const seed of [1n, 2n, 3n, 5n, 8n, 13n, 21n, 34n]) {
      const s = generateEmergent(cfg({ seed, width: 14, height: 12 })).stats;
      unreachableRejections += s.wallsRejectedUnreachable + s.roomsRejectedUnreachable;
      claimRejections += s.wallsRejectedClaimed + s.roomsRejectedConflict;
    }
    expect(unreachableRejections).toBeGreaterThan(0); // the reachability gate refused real proposals
    expect(claimRejections).toBeGreaterThan(0); // the authority gate refused real proposals
  });

  it('the maze is real — a meaningful share of arms end up walled', () => {
    const r = generateEmergent(cfg({ width: 14, height: 12 }));
    expect(r.stats.wallsPlaced).toBeGreaterThan(50);
  });

  it('rooms actually get doors rather than being sealed boxes', () => {
    const r = generateEmergent(cfg({ width: 16, height: 14 }));
    expect(r.rooms.length).toBeGreaterThan(0);
    expect(r.stats.doorsKept).toBeGreaterThan(0);
    expect(r.stats.ringSealed).toBeGreaterThan(0); // and the rest of the ring really is wall
  });
});

describe('emergent — claims (authority)', () => {
  it('placed rooms never overlap', () => {
    for (const seed of [1n, 2n, 3n, 5n, 8n]) {
      const { rooms } = generateEmergent(cfg({ seed, width: 16, height: 14 }));
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i]!, b = rooms[j]!;
          const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(disjoint).toBe(true);
        }
      }
    }
  });
});
