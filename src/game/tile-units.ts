// ============================================================================
// src/game/tile-units.ts — compose a 9-cell tile into concrete IR units (docs/16 §10, Path A / 4a).
// ============================================================================
//
// The bridge between the placement authority (src/floor/tile-place.ts — which mesh, where, what turn)
// and the box-fit/texturing authority (src/game/approved-assets.json — each piece's frozen collider
// boxes + material recipe). For each placed piece we look up its approved entry and TRANSFORM its
// footprint by the placement → tile-local collider boxes; the mesh url + transform + materials ride
// along. The result is the polymorphic `TileUnit` the tower lowers per cell:
//   • collision pushes `unit.boxes` (offset by the cell centre);
//   • the renderer clones `unit.url` at the transform and applies `unit.materials`.
// So `graph == collision == render` (all off the same placed pieces) and texturing is consumed as the
// authoritative source it is — symmetric with boxing.
//
// Fixed-point + deterministic: the placement is already Fixed; the frozen footprint floats convert at
// THIS seam (`fromFloatConst` — the values are frozen JSON, so the conversion is reproducible). A
// quarter-turn keeps an AABB axis-aligned, so rotation is an axis swap/negate — no trig.

import { type Fixed, fromFloatConst, add, mul, neg } from '../sim/fixed/fixed.ts';
import type { WallTile } from '../floor/wall-tile.ts';
import { tilePlacements, type TilePlacement } from '../floor/tile-place.ts';
import { getApproved, type ApprovedBox, type ApprovedAsset } from './approved-assets.ts';

/** A collider box in TILE-LOCAL fixed-point (centre + half-extents). The tower offsets by the cell
 *  centre to get world AABBs. */
export interface FixedBox {
  cx: Fixed;
  cy: Fixed;
  cz: Fixed;
  hx: Fixed;
  hy: Fixed;
  hz: Fixed;
}

/** One concrete unit: a mesh placement + its (transformed) collider boxes + its material recipe. */
export interface TileUnit {
  url: string;
  x: Fixed;
  z: Fixed;
  turn: number;
  scale: Fixed;
  /** The approved-assets key (also the render-side materials lookup). */
  objId: string;
  /** Collider boxes, tile-local, placement applied. Empty if the piece isn't approved yet. */
  boxes: FixedBox[];
  /** The frozen material recipe the renderer applies, or undefined if unapproved. */
  materials: ApprovedAsset['materials'] | undefined;
}

/** A tile piece's mesh url → its approved-assets object id (idOf: `kk-<pack>-<slug>`). Tile pieces are
 *  all the remastered dungeon pack, so the pack segment is fixed. */
export function objIdOf(url: string): string {
  const file = (url.split('/').pop() ?? '').replace(/\.gltf\.glb$/i, '').replace(/\.glb$/i, '');
  return `kk-dungeon_remastered-${file}`;
}

const F = fromFloatConst; // frozen-JSON float → Fixed at the seam (deterministic for frozen data)

// Approved footprints were box-fit in the LAB, where the object is scaled by the pack's display scale
// (0.5 for dungeon_remastered — `world-object.ts` wraps the mesh in an `inner` group at 0.5 and box-fit
// voxelises root-local, INCLUDING that scale). The game renders the GLB at NATIVE (cs/NATIVE_CELL = 1),
// so a footprint is HALF-size and must be doubled to match the rendered mesh. (= 1 / pack-scale 0.5.)
const FOOTPRINT_SCALE = fromFloatConst(2);

/** Rotate a tile-local (x,z) by `turn` quarter-turns CCW about +Y — the same Three.js Y-rotation the
 *  renderer applies, so collider and mesh agree. (x,z) → 0:(x,z) 1:(z,−x) 2:(−x,−z) 3:(−z,x). */
function rot(x: Fixed, z: Fixed, turn: number): readonly [Fixed, Fixed] {
  switch (((turn % 4) + 4) % 4) {
    case 1: return [z, neg(x)];
    case 2: return [neg(x), neg(z)];
    case 3: return [neg(z), x];
    default: return [x, z];
  }
}

/** Transform an approved footprint box (object-local float metres) by a placement → tile-local Fixed:
 *  rotate the centre by the quarter-turn, scale, then offset by (p.x, p.z). Half-extents swap on a
 *  90°/270° turn (an AABB stays axis-aligned under quarter rotation). */
export function transformBox(b: ApprovedBox, p: TilePlacement): FixedBox {
  const s = mul(p.scale, FOOTPRINT_SCALE); // placement scale × the lab→native footprint correction
  const [rcx, rcz] = rot(F(b.cx), F(b.cz), p.turn);
  const swap = ((p.turn % 2) + 2) % 2 === 1;
  const hx = swap ? F(b.hz) : F(b.hx);
  const hz = swap ? F(b.hx) : F(b.hz);
  return {
    cx: add(mul(rcx, s), p.x), // footprint centre scaled (rotate→scale), then the tile-local offset
    cy: mul(F(b.cy), s),
    cz: add(mul(rcz, s), p.z),
    hx: mul(hx, s),
    hy: mul(F(b.hy), s),
    hz: mul(hz, s),
  };
}

/**
 * Compose a RESOLVED tile into its concrete IR units. Each placed piece (floor first, then walls)
 * becomes a unit carrying its mesh transform, its placement-transformed collider boxes, and its frozen
 * materials. A piece with no approved entry yet contributes a unit with `boxes: []` + `materials:
 * undefined` (it still renders via the url; collision just has nothing for it until it's approved).
 */
export function tileUnits(tile: WallTile): TileUnit[] {
  return tilePlacements(tile).map((p) => {
    const objId = objIdOf(p.url);
    const a = getApproved(objId);
    const boxes = (a?.footprint.boxes ?? []).map((b) => transformBox(b, p));
    return { url: p.url, x: p.x, z: p.z, turn: p.turn, scale: p.scale, objId, boxes, materials: a?.materials };
  });
}
