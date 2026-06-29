import { describe, it, expect } from 'vitest';
import { tileColliders } from './tile-collide.ts';
import type { WallTile, Seg } from './wall-tile.ts';

/** A resolved tile with the given arm cells (everything else `none`, solid, floorless). */
const T = (o: Partial<Record<'eN' | 'eE' | 'eS' | 'eW' | 'iN' | 'iE' | 'iS' | 'iW' | 'c', Seg>> = {}): WallTile => ({
  floor: { nw: 'none', ne: 'none', sw: 'none', se: 'none' },
  edge: { N: o.eN ?? 'none', E: o.eE ?? 'none', S: o.eS ?? 'none', W: o.eW ?? 'none' },
  inner: { N: o.iN ?? 'none', E: o.iE ?? 'none', S: o.iS ?? 'none', W: o.iW ?? 'none' },
  centre: o.c ?? 'none',
  wallType: 'solid',
});

describe('tile-collide — a box per non-none cell', () => {
  it('an open tile has no colliders', () => {
    expect(tileColliders(T())).toEqual([]);
  });

  it('a fully-walled tile (8 arms + centre) yields 9 boxes', () => {
    const all: Seg = 'wall';
    const t = T({ eN: all, eE: all, eS: all, eW: all, iN: all, iE: all, iS: all, iW: all, c: all });
    expect(tileColliders(t)).toHaveLength(9);
  });

  it('a partial arm (edge wall, inner none) emits ONLY the outer box → an inner gap (passable)', () => {
    const boxes = tileColliders(T({ eN: 'wall' }));
    expect(boxes).toHaveLength(1);
    // the N edge box sits at the boundary (z near -2), not spanning to the centre
    expect(boxes[0]!.z0).toBe(-2);
    expect(boxes[0]!.z1).toBe(-1);
  });

  it('a full arm (edge + inner) emits two adjacent boxes spanning boundary→centre', () => {
    const boxes = tileColliders(T({ eN: 'wall', iN: 'wall' }));
    expect(boxes).toHaveLength(2);
    const zs = boxes.map((b) => [b.z0, b.z1]).sort((a, b) => a[0]! - b[0]!);
    expect(zs).toEqual([[-2, -1], [-1, 0]]); // outer then inner, contiguous
  });

  it('a barrier is LOW; a wall is full-height', () => {
    expect(tileColliders(T({ eE: 'barrier' }))[0]!.low).toBe(true);
    expect(tileColliders(T({ eE: 'wall' }))[0]!.low).toBe(false);
  });

  it('the centre column emits a box around the origin', () => {
    const boxes = tileColliders(T({ c: 'wall' }));
    expect(boxes).toHaveLength(1);
    const b = boxes[0]!;
    expect(b.x0 < 0 && b.x1 > 0 && b.z0 < 0 && b.z1 > 0).toBe(true);
  });

  it('arms land on the correct axis (E/W along X, N/S along Z)', () => {
    const e = tileColliders(T({ eE: 'wall' }))[0]!;
    expect(e.x0).toBe(1); // E edge sits at +X boundary
    expect(e.x1).toBe(2);
    const w = tileColliders(T({ eW: 'wall' }))[0]!;
    expect(w.x0).toBe(-2);
    expect(w.x1).toBe(-1);
  });
});
