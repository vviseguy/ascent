// Multi-storey generation: can a structure that spans floors actually be PLACED across them?
import { describe, it, expect } from 'vitest';
import { generateEmergent, generateEmergentTower, type StructureSource } from './cell-emergent.ts';
import { resolveGrid } from './cell-grid.ts';
import { pointAt, type CellStructure } from './cell-structures.ts';
import { fullField, floors as floorMask, segs } from './cell-field.ts';
import { stairFlight } from './cell-place.ts';

/**
 * A two-storey stairwell: a 2×2 flight climbing north on the lower level, and the SAME footprint left
 * with no floor on the upper one — the shaft you climb out through. This is the thing the whole
 * multi-storey feature exists for, and no such structure is in the shipped store yet, so the generator
 * is handed it directly.
 */
function stairwell(): CellStructure {
  const w = 2, h = 2, size = (w + 1) * (h + 1);
  const cells = Array.from({ length: size * 2 }, fullField);
  const st: CellStructure = { w, h, levels: 2, cells };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      cells[pointAt(st, 0, px, py)]!.floor = floorMask('stairs');
      cells[pointAt(st, 1, px, py)]!.floor = floorMask('none');   // the shaft
    }
  }
  // the flight's head: a wall across the north end of the lower level, so it has a way to climb
  for (let px = 0; px < w; px++) cells[pointAt(st, 0, px, 0)]!.wallN = segs('wall');
  return st;
}

const only = (s: CellStructure): StructureSource => ({ names: () => ['stairwell'], get: () => s });

describe('generateEmergentTower — structures that span storeys', () => {
  const src = only(stairwell());
  const t = generateEmergentTower({ width: 30, height: 24, seed: 11n, levels: 3, structures: src });

  it('produces one floor per storey', () => {
    expect(t.floors).toHaveLength(3);
    for (const f of t.floors) expect(f.grid.cells.length).toBe(30 * 24);
  });

  it('places the stairwell, and on CONSECUTIVE storeys at the same spot', () => {
    expect(t.stats.structuresPlaced).toBeGreaterThan(0);
    expect(t.stats.structuresSkippedMultiLevel).toBe(0);
    // every placement appears on two adjacent floors with an identical region
    const regions = t.floors.map((f) => f.placed.map((p) => `${p.region.x},${p.region.y}`).sort());
    for (const r of regions[0]!) expect(regions[1]).toContain(r);
  });

  it('the SHAFT is really there: stairs below, no floor directly above', () => {
    const lower = resolveGrid(t.floors[0]!.grid);
    const upper = resolveGrid(t.floors[1]!.grid);
    let checked = 0;
    for (let i = 0; i < lower.length; i++) {
      if (lower[i]?.floor !== 'stairs') continue;
      checked++;
      expect(upper[i]?.floor).toBe('none');
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the flights survive generation as flights — a climbable staircase, not scattered stair cells', () => {
    const lower = resolveGrid(t.floors[0]!.grid);
    let found = 0;
    for (let i = 0; i < lower.length; i++) {
      const f = stairFlight(lower, 30, 24, i % 30, Math.floor(i / 30));
      if (f) { found++; expect(f.bw * f.bh).toBe(4); }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('a structure TALLER than the tower is declined, not truncated', () => {
    const tall = generateEmergentTower({ width: 20, height: 16, seed: 5n, levels: 1, structures: src });
    expect(tall.stats.structuresPlaced).toBe(0);
    expect(tall.stats.structuresSkippedMultiLevel).toBeGreaterThan(0);
  });

  it('is deterministic — the same seed gives the same stack', () => {
    const a = generateEmergentTower({ width: 24, height: 20, seed: 7n, levels: 3, structures: src });
    const b = generateEmergentTower({ width: 24, height: 20, seed: 7n, levels: 3, structures: src });
    expect(JSON.stringify(a.floors.map((f) => f.grid.cells)))
      .toBe(JSON.stringify(b.floors.map((f) => f.grid.cells)));
  });

  it('gives each storey its OWN maze — otherwise every floor is the same floor', () => {
    const a = JSON.stringify(t.floors[0]!.grid.cells);
    const b = JSON.stringify(t.floors[1]!.grid.cells);
    expect(a).not.toBe(b);
  });
});

describe('generateEmergent — still a single floor, unchanged', () => {
  it('is the one-storey case of the tower, and stays deterministic', () => {
    const a = generateEmergent({ width: 24, height: 20, seed: 3n });
    const b = generateEmergent({ width: 24, height: 20, seed: 3n });
    expect(JSON.stringify(a.grid.cells)).toBe(JSON.stringify(b.grid.cells));
    expect(a.entry).toBe(b.entry);
    expect(a.stats.structuresPlaced).toBe(b.stats.structuresPlaced);
  });
});
