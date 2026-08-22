import { describe, it, expect } from 'vitest';
import { tileUnits, transformBox, objIdOf } from './tile-units.ts';
import type { WallTile, Seg } from '../floor/wall-tile.ts';
import type { TilePlacement } from '../floor/tile-place.ts';
import { fromInt, fromFloatConst, toFloat } from '../sim/fixed/fixed.ts';

/** A resolved tile with the given arm cells (everything else none, solid, floorless). */
const T = (o: Partial<Record<'eN' | 'eE' | 'eS' | 'eW' | 'iN' | 'iE' | 'iS' | 'iW', Seg>> & { floor?: 'none' | 'stone' } = {}): WallTile => {
  const f = o.floor ?? 'none';
  return {
    floor: { nw: f, ne: f, sw: f, se: f },
    edge: { N: o.eN ?? 'none', E: o.eE ?? 'none', S: o.eS ?? 'none', W: o.eW ?? 'none' },
    inner: { N: o.iN ?? 'none', E: o.iE ?? 'none', S: o.iS ?? 'none', W: o.iW ?? 'none' },
    centre: 'none',
    wallType: 'solid',
  };
};

describe('tile-units — objIdOf bridge', () => {
  it('maps a piece url to its approved-assets key', () => {
    expect(objIdOf('models/kaykit_dungeon_remastered/wall_half.gltf.glb')).toBe('kk-dungeon_remastered-wall_half');
    expect(objIdOf('models/kaykit_dungeon_remastered/pillar.gltf.glb')).toBe('kk-dungeon_remastered-pillar');
  });
});

describe('tile-units — transformBox (quarter-turn AABB transform)', () => {
  const box = { cx: 1, cy: 0.5, cz: 0, hx: 0.5, hy: 1, hz: 0.2 };
  const placed = (turn: number, x = 0, z = 0): TilePlacement => ({ url: 'x', x: fromInt(x), z: fromInt(z), turn, scale: fromInt(1) });
  // fixed-point (Q16.16) → compare with tolerance (0.2 quantises to ~0.19999).
  const expectBox = (b: ReturnType<typeof transformBox>, e: { cx: number; cz: number; hx: number; hz: number }) => {
    expect(toFloat(b.cx)).toBeCloseTo(e.cx, 3);
    expect(toFloat(b.cz)).toBeCloseTo(e.cz, 3);
    expect(toFloat(b.hx)).toBeCloseTo(e.hx, 3);
    expect(toFloat(b.hz)).toBeCloseTo(e.hz, 3);
  };

  // NB: footprints are lab-½-scale, so transformBox doubles them (FOOTPRINT_SCALE = 2) to match the
  // natively-rendered mesh — every expected value below is the input box × 2 (× the placement scale).
  it('turn 0 is identity (footprint doubled to native)', () => {
    expectBox(transformBox(box, placed(0)), { cx: 2, cz: 0, hx: 1, hz: 0.4 });
  });
  it('turn 1 (90° CCW) maps (x,z)→(z,−x) and swaps the x/z half-extents', () => {
    expectBox(transformBox(box, placed(1)), { cx: 0, cz: -2, hx: 0.4, hz: 1 });
  });
  it('turn 2 (180°) negates the centre, keeps extents', () => {
    expectBox(transformBox(box, placed(2)), { cx: -2, cz: 0, hx: 1, hz: 0.4 });
  });
  it('the offset is added after rotate+scale (offset is native, not doubled)', () => {
    const b = transformBox(box, placed(0, 2, -3));
    expect(toFloat(b.cx)).toBe(4); // 1×2 + 2
    expect(toFloat(b.cz)).toBe(-3); // 0×2 + -3
  });
  it('the placement scale multiplies on top of the footprint correction', () => {
    const b = transformBox(box, { url: 'x', x: fromInt(0), z: fromInt(0), turn: 0, scale: fromFloatConst(0.5) });
    expect(toFloat(b.cx)).toBe(1); // 1 × (0.5 × 2)
    expect(toFloat(b.hx)).toBe(0.5); // 0.5 × 1
  });
});

describe('tile-units — tileUnits (compose against the approved store)', () => {
  it('an approved wall piece yields a unit with its url, key, boxes, and materials', () => {
    // a full S arm → one wall_half (approved with box-fit at ed 0.4 + materials)
    const units = tileUnits(T({ eS: 'wall', iS: 'wall' }));
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.url).toContain('wall_half');
    expect(u.objId).toBe('kk-dungeon_remastered-wall_half');
    expect(u.boxes.length).toBeGreaterThan(0); // frozen footprint present
    expect(u.materials).toBeDefined(); // frozen recipe present
  });

  it('an UNapproved piece (floor slab) still renders but carries no collider boxes', () => {
    const units = tileUnits(T({ floor: 'stone' }));
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.url).toContain('floor_tile_large');
    expect(u.boxes).toEqual([]); // floors aren't box-fit (slabs)
    expect(u.materials).toBeUndefined();
  });
});
