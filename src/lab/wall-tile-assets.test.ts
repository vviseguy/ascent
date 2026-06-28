import { describe, it, expect } from 'vitest';
import { tilePlacements, PIECE } from './wall-tile-assets.ts';
import type { WallTile, Dir, SideSet } from '../floor/wall-tile.ts';

const Q = Math.PI / 2;
const none = (): SideSet => ({ N: 'none', E: 'none', S: 'none', W: 'none' });

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
