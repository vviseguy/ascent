// ============================================================================
// src/floor/tile-collide.ts — collision footprint of a 9-cell tile.
// ============================================================================
//
// The sim-side half of the tile placement authority (docs/16 §10, Path A): given a RESOLVED WallTile,
// emit the axis-aligned collision boxes a body bumps into. Tile-local 4u space — x,z ∈ [-2, +2], the
// tile centre at (0,0); N = −Z, S = +Z, E = +X, W = −X (this file's convention). The tower lowers
// these to world fixed-point AABBs at the seam (extruding `low` → LIP, else → full wall height), so
// nothing here is fixed-point yet — it's pure, deterministic plain-number geometry.
//
// One box per NON-`none` cell — exactly the cells `tilePlacements` renders a mesh for, and exactly the
// cells the corner-graph reads (`armBlocks`): so a body collides wherever a wall is drawn, and a
// partial-arm GAP (one cell open) is simply a MISSING box → passable, matching the graph. That is the
// `graph == collision == render` invariant, all three off the same 9 cells.

import type { WallTile, Seg, Dir } from './wall-tile.ts';

/** A tile-local collision box: a 2D footprint (x,z) + a height class. `low` = a barrier/LIP (a
 *  surmountable bump); else a full-height wall. The tower extrudes this to a world AABB. */
export interface TileBox {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  low: boolean;
}

const HALF = 2; // tile half-extent (4u tile)
const WT = 0.3; // wall half-thickness (tile-local); the tower scales to the real collider width

/** The footprint of a direction's arm, split into its OUTER cell (the edge, at the boundary) and its
 *  INNER cell (toward the centre). Each is a thin box along the arm axis. */
const ARM: Record<Dir, { edge: [number, number, number, number]; inner: [number, number, number, number] }> = {
  // N (−Z): a vertical bar at x≈0, edge near z=−2, inner toward centre.
  N: { edge: [-WT, -HALF, WT, -1], inner: [-WT, -1, WT, 0] },
  S: { edge: [-WT, 1, WT, HALF], inner: [-WT, 0, WT, 1] },
  E: { edge: [1, -WT, HALF, WT], inner: [0, -WT, 1, WT] },
  W: { edge: [-HALF, -WT, -1, WT], inner: [-1, -WT, 0, WT] },
};
const CENTRE: [number, number, number, number] = [-WT, -WT, WT, WT];

const box = (f: [number, number, number, number], seg: Seg): TileBox => ({ x0: f[0], z0: f[1], x1: f[2], z1: f[3], low: seg === 'barrier' });

/**
 * The collision boxes of a RESOLVED tile, tile-local. A box per non-`none` edge/inner cell (the wall
 * pieces) plus the centre column. `none` cells emit nothing — a partial arm therefore leaves a gap,
 * the same gap the corner-graph treats as passable. Deterministic; iterates DIRS in fixed order.
 */
export function tileColliders(tile: WallTile): TileBox[] {
  const out: TileBox[] = [];
  for (const d of ['N', 'E', 'S', 'W'] as const) {
    if (tile.edge[d] !== 'none') out.push(box(ARM[d].edge, tile.edge[d]));
    if (tile.inner[d] !== 'none') out.push(box(ARM[d].inner, tile.inner[d]));
  }
  if (tile.centre !== 'none') out.push(box(CENTRE, tile.centre));
  return out;
}
