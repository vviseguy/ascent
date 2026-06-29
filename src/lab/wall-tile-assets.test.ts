import { describe, it, expect } from 'vitest';
import { tilePlacements, PIECE } from './wall-tile-assets.ts';
import { DIRS, type WallTile, type Dir, type SideSet, type Seg } from '../floor/wall-tile.ts';

const Q = Math.PI / 2;
const none = (): SideSet => ({ N: 'none', E: 'none', S: 'none', W: 'none' });
const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Which world direction a piece's NATIVE body axis points after a Three.js Y-rotation of `yaw`.
 *  Y-rot maps local (x,z) → world (x·cosθ + z·sinθ, −x·sinθ + z·cosθ). */
function bodyDir(native: readonly [number, number], yaw: number): Dir {
  const [x, z] = native;
  const wx = Math.round(x * Math.cos(yaw) + z * Math.sin(yaw));
  const wz = Math.round(-x * Math.sin(yaw) + z * Math.cos(yaw));
  if (wz === -1) return 'N';
  if (wz === 1) return 'S';
  if (wx === 1) return 'E';
  return 'W';
}
const PLUS_X = [1, 0] as const; // wall_half / barrier_half extend +X natively
const MINUS_X = [-1, 0] as const; // wall_half_endcap extends −X natively (the opposite)

/** A one-arm tile: the given direction's inner and/or edge set to `type`, nothing else. */
function arm(d: Dir, type: Seg, where: 'inner' | 'edge' | 'both'): WallTile {
  const e = none(), i = none();
  if (where !== 'edge') i[d] = type;
  if (where !== 'inner') e[d] = type;
  return { floor: { nw: 'none', ne: 'none', sw: 'none', se: 'none' }, edge: e, inner: i, centre: 'none', wallType: 'solid' };
}

/** A clean corner tile: full wall arms (inner + edge) in dirs a & b, nothing else. */
function corner(a: Dir, b: Dir): WallTile {
  const e = none(), i = none();
  for (const d of [a, b]) { e[d] = 'wall'; i[d] = 'wall'; }
  return { floor: { nw: 'none', ne: 'none', sw: 'none', se: 'none' }, edge: e, inner: i, centre: 'none', wallType: 'solid' };
}
const cornerYawOf = (t: WallTile): number => tilePlacements(t).find((p) => p.url === PIECE.corner)!.yaw;

// In this file's convention E=+X, W=−X, N=−Z, S=+Z, wall_corner's native legs are W+S (θ=0).
// Each adjacent arm-pair must rotate the L so its legs land on exactly those two sides — verified
// against the placed mesh's world AABB (a {N,E} corner lands its mass at +X,−Z). Regression guard
// for the N/S-flip bug (cornerYaw had been copied from dungeon.ts's N=+Z convention).
describe('wall-tile-assets — corner yaw lands the L on the arms it was given', () => {
  it('S,W → 0', () => expect(cornerYawOf(corner('S', 'W'))).toBeCloseTo(0));
  it('E,S → +π/2', () => expect(cornerYawOf(corner('E', 'S'))).toBeCloseTo(Q));
  it('N,E → π', () => expect(cornerYawOf(corner('N', 'E'))).toBeCloseTo(Math.PI));
  it('W,N → −π/2', () => expect(cornerYawOf(corner('W', 'N'))).toBeCloseTo(-Q));
});

// Regression guard for the per-arm "wall points INWARD" bug: wall_half_endcap is −X-native (the
// OPPOSITE of wall_half/barrier_half's +X), so a stub oriented with the +X yaw rotated 180° inward.
// A stub/cap must always extend its body OUTWARD (centre → its direction d).
describe('wall-tile-assets — every arm piece extends its body OUTWARD (centre→d)', () => {
  for (const d of DIRS) {
    it(`wall inner stub ${d} (endcap, −X-native) points ${d}`, () => {
      const p = tilePlacements(arm(d, 'wall', 'inner')).find((q) => q.url === PIECE.halfCap)!;
      expect(bodyDir(MINUS_X, p.yaw)).toBe(d);
    });
    it(`wall edge cap ${d} points ${d} AND sits on the ${d} boundary`, () => {
      const p = tilePlacements(arm(d, 'wall', 'edge')).find((q) => q.url === PIECE.halfCap)!;
      expect(bodyDir(MINUS_X, p.yaw)).toBe(d);
      const [dx, dz] = DV[d]; // the offset must be pushed toward d (positive dot with d's unit vector)
      expect(p.x * dx + p.z * dz).toBeGreaterThan(0);
    });
    it(`barrier inner stub ${d} (barrier_half, +X-native) points ${d}`, () => {
      const p = tilePlacements(arm(d, 'barrier', 'inner')).find((q) => q.url === PIECE.barrierHalf)!;
      expect(bodyDir(PLUS_X, p.yaw)).toBe(d);
    });
    it(`full wall arm ${d} (half, +X-native) points ${d}`, () => {
      const p = tilePlacements(arm(d, 'wall', 'both')).find((q) => q.url === PIECE.half)!;
      expect(bodyDir(PLUS_X, p.yaw)).toBe(d);
    });
  }
});
