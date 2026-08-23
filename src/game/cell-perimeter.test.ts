// THE TOWER HAS AN EDGE.
//
// `cell-reach` has always treated off-map as `PERIMETER = wall` — its safe shell — so the graph
// believed every floor was enclosed while the geometry let you walk straight off into the kill plane.
// The ring that fixes it went in untested, and it has two halves that fail in different ways: the
// COLLISION (four long boxes per storey) and the MESH (per-4u pieces, deliberately carrying no boxes
// of their own). A test that only counted meshes would pass on a tower you can still walk out of.
//
// The floor's extent is DERIVED from the compiled ground, never assumed. Writing this test with the
// grid assumed centred on the origin failed on three counts and none of them were the ring's fault:
// it actually spans x[-23,25], z[-19,21].

import { describe, it, expect } from 'vitest';
import { fromInt, toFloat, fromRaw } from '../sim/fixed/fixed.ts';
import { generateEmergentTower } from '../floor/cell-emergent.ts';
import { resolveFloor } from '../floor/cell-defray.ts';
import { compileCellTower } from './cell-tower.ts';

const W = 24, H = 20;
const F = (raw: number): number => toFloat(fromRaw(raw));

function tower(seed: bigint, levels = 3) {
  const stack = generateEmergentTower({ width: W, height: H, seed, levels });
  const floors = stack.floors.map((f) => ({
    cells: resolveFloor(f), width: W, height: H, entry: f.entry, exit: f.exit,
  }));
  return compileCellTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) });
}

const t = tower(1n);
const solids = t.terrain.solids;
const base0 = F(t.stratumBaseY[0]!);

/** Where the walkable deck actually is, read off the ground slabs of stratum 0. */
const deck = solids.filter((s) => Math.abs(F(s.maxY) - base0) < 0.01 && F(s.maxY) - F(s.minY) < 1);
const minX = Math.min(...deck.map((s) => F(s.minX)));
const maxX = Math.max(...deck.map((s) => F(s.maxX)));
const minZ = Math.min(...deck.map((s) => F(s.minZ)));
const maxZ = Math.max(...deck.map((s) => F(s.maxZ)));

/** Is there something to walk into at (x,z), knee height above storey `lv`? */
const blocked = (x: number, z: number, y: number): boolean =>
  solids.some((s) => F(s.minX) <= x && x <= F(s.maxX)
    && F(s.minZ) <= z && z <= F(s.maxZ)
    && F(s.minY) <= y && y <= F(s.maxY));

describe('the map has a wall around it', () => {
  it('found a deck to fence', () => {
    expect(deck.length).toBeGreaterThan(100);
    expect(maxX - minX).toBeGreaterThan(2 * W - 4);
    expect(maxZ - minZ).toBeGreaterThan(2 * H - 4);
  });

  it('encloses every side at body height', () => {
    // sampled along each edge — a ring with one gap is the failure mode, and one probe would miss it
    const y = base0 + 1;
    for (let x = minX + 1; x < maxX; x += 2) {
      expect({ side: 'N', x, hit: blocked(x, minZ, y) }).toEqual({ side: 'N', x, hit: true });
      expect({ side: 'S', x, hit: blocked(x, maxZ, y) }).toEqual({ side: 'S', x, hit: true });
    }
    for (let z = minZ + 1; z < maxZ; z += 2) {
      expect({ side: 'W', z, hit: blocked(minX, z, y) }).toEqual({ side: 'W', z, hit: true });
      expect({ side: 'E', z, hit: blocked(maxX, z, y) }).toEqual({ side: 'E', z, hit: true });
    }
  });

  it('closes the corners — where two sides meet is the easiest place to leave', () => {
    const y = base0 + 1;
    for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]] as const) {
      expect({ x, z, hit: blocked(x, z, y) }).toEqual({ x, z, hit: true });
    }
  });

  it('is not vacuous — the middle of the floor is not solid', () => {
    // without this the enclosure test would pass just as well on a solid block of stone
    let open = 0;
    for (let x = minX + 5; x < maxX - 5; x += 4) {
      for (let z = minZ + 5; z < maxZ - 5; z += 4) if (!blocked(x, z, base0 + 1)) open++;
    }
    expect(open).toBeGreaterThan(0);
  });

  it('rings EVERY storey — a missing ring higher up is a longer drop', () => {
    // a ring box spans nearly the whole floor on one axis; four of them per storey
    const rings = solids.filter((s) => (F(s.maxX) - F(s.minX)) > (maxX - minX) - 2
      || (F(s.maxZ) - F(s.minZ)) > (maxZ - minZ) - 2);
    const perStorey = t.stratumBaseY.map((b) => {
      const y = F(b) + 1;
      return rings.filter((s) => F(s.minY) <= y && y <= F(s.maxY)).length;
    });
    expect(perStorey).toEqual(t.stratumBaseY.map(() => 4));
  });

  it('the ring MESH carries no colliders — collision is the four boxes', () => {
    // deliberate: a box per ring piece would be ~120 redundant boxes a storey for the broadphase to
    // test. Pinned so nobody "fixes" it by giving them footprints.
    const ring = (t.cellGrid ?? []).flatMap((g) => g.wallPlacements)
      .filter((p) => p.unit.boxes.length === 0 && p.unit.url.includes('wall.'));
    expect(ring.length).toBeGreaterThan(0);
  });
});
