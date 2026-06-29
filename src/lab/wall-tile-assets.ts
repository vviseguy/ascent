// ============================================================================
// src/lab/wall-tile-assets.ts — the VIEW ADAPTER over the tile placement authority.
// ============================================================================
//
// The placement geometry (which mesh, where, what yaw) lives ONCE, sim-side, in
// src/floor/tile-place.ts (fixed-point, deterministic — the tower reads it for collision). This file
// is the thin VIEW reader: it turns those tile-local FIXED placements into the float `{url,x,y,z,yaw,
// scale}` the renderer/editor feed to Three.js. No placement logic here — just unit conversion, so
// there is no duplicated geometry (docs/16 §10, Path A: one source, the view adapts).

import { tilePlacements as tilePlacementsFixed, PIECE } from '../floor/tile-place.ts';
import type { WallTile } from '../floor/wall-tile.ts';
import { toFloat } from '../sim/fixed/fixed.ts';

export { PIECE };

/** A float mesh placement for the renderer/editor (Three.js world units). */
export interface Placement {
  url: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/** Quarter-turn → radians, matching the authority's CCW turns (0/90/180/270°; 3 → −90° = 270°). */
const TURN_RAD = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** Every mesh a tile renders, as float placements — a pure conversion of the sim authority's output. */
export function tilePlacements(tile: WallTile): Placement[] {
  return tilePlacementsFixed(tile).map((p) => ({
    url: p.url,
    x: toFloat(p.x),
    y: 0,
    z: toFloat(p.z),
    yaw: TURN_RAD[p.turn]!,
    scale: toFloat(p.scale),
  }));
}
