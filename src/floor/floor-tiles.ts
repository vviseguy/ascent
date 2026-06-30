// ============================================================================
// src/floor/floor-tiles.ts — Floor → 9-cell TileGrid (docs/16 §10, Path A / the TileStyle seam).
// ============================================================================
//
// The bridge from the coarse Floor graph (generate.ts) to the tile substrate: one TILE per floor
// cell. Rooms stamp their room-template over their rectangle (floor + wall ring); corridors/doorways
// get a plain floor; walls/void stay blank. The grid is then owner-resolved (resolveGrid) into the
// concrete `WallTile[]` the renderer/collision consume — each cell composed into IR units by
// `src/game/tile-units.ts` and placed by the tower at the cell centre.
//
// Deterministic (sim): atomic `applyBatch` (sorted iteration), seeded `pick`, no float/RNG. This is a
// FIRST mapping — rooms-as-basicRoom + corridor floors; richer per-room roles + doorway reconciliation
// against `floor.doors` are the iterative next layer (verified in-game), not this seam's concern.

import type { Floor } from './types.ts';
import { makeGrid, applyBatch, resolveGrid, type TileGrid, type Region, type Stamp } from './tile-grid.ts';
import { template, floors, type TileField } from './wall-tile-field.ts';
import { basicRoom } from './room-templates.ts';
import type { WallTile } from './wall-tile.ts';

/** A plain walkable floor tile (stone, no walls) — for corridors and doorways. */
const FLOOR_TILE: TileField = template({
  floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') },
});

/**
 * Build a w×h TileGrid (one tile per floor cell) by stamping the floor's rooms + corridors. Atomic:
 * rooms constrain only their interior (boundary open) and corridors are distinct cells, so the whole
 * batch commits together. WALL/VOID cells are left blank (floorless).
 */
export function floorToTileGrid(floor: Floor): TileGrid {
  const grid = makeGrid(floor.width, floor.height);
  const stamps: { region: Region; stamp: Stamp }[] = [];

  // each room → its template over its (inclusive) rectangle
  for (const room of floor.rooms ?? []) {
    const w = room.x1 - room.x0 + 1;
    const h = room.y1 - room.y0 + 1;
    if (w > 0 && h > 0) stamps.push({ region: { x: room.x0, y: room.y0, w, h }, stamp: basicRoom(w, h) });
  }
  // corridors + doorways → a plain walkable floor (single-cell stamps)
  for (const c of floor.cells) {
    if (c.cellType === 'CORRIDOR' || c.cellType === 'DOORWAY') {
      stamps.push({ region: { x: c.x, y: c.y, w: 1, h: 1 }, stamp: FLOOR_TILE });
    }
  }
  applyBatch(grid, stamps);
  return grid;
}

/**
 * The resolved concrete tiles for a floor (row-major, length width*height; null where a cell
 * conflicts). `pick` is the coordinate-hash entropy seam for deterministic generation.
 */
export function floorTiles(
  floor: Floor,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (WallTile | null)[] {
  return resolveGrid(floorToTileGrid(floor), pick);
}
