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

import { cellId, edgeKey, type Floor } from './types.ts';
import { makeGrid, applyBatch, resolveGrid, type TileGrid, type Region, type Stamp } from './tile-grid.ts';
import { template, floors, type TileField } from './wall-tile-field.ts';
import { basicRoom } from './room-templates.ts';
import { DIRS, type WallTile, type Dir } from './wall-tile.ts';

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

/** Direction offsets (matching tile-place: N=−Z, S=+Z, E=+X, W=−X) for neighbour lookup. */
const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Open a doorway for a passage in direction `d`. The room wall is INSET — it runs through the
 *  perimeter cell's centre PERPENDICULAR to the room edge (an east wall is a N–S arm pair; a north
 *  wall is an E–W pair) — so to let a body cross in direction `d` we clear the arms ACROSS `d`: the
 *  N+S pair for an E/W passage, the E+W pair for an N/S passage. Clearing only the blocking pair keeps
 *  a corner cell's OTHER wall (e.g. a void-facing side) intact — no over-opening. Floor corners are
 *  left untouched (the slab carries the floor). */
function openAcross(tile: WallTile, d: Dir): void {
  const pair: readonly [Dir, Dir] = d === 'E' || d === 'W' ? ['N', 'S'] : ['E', 'W'];
  for (const a of pair) { tile.edge[a] = 'none'; tile.inner[a] = 'none'; }
}

/**
 * DOOR RECONCILIATION (docs/16 §10, the gating piece of 4b→4c): make the room wall-rings agree with
 * the Floor's traversal graph, so tile levels are COMPLETABLE rather than closed boxes. A room cell
 * walls itself on every side by default (`basicRoom`'s ring); wherever `floor.edges` has a real passage
 * crossing OUT of the room (to a corridor or a different room), that boundary must be an opening. We
 * punch the opening on the room side (the corridor side has no wall); a room↔room boundary is opened
 * from both rooms because each cell is visited in turn. This replaces `basicRoom`'s fixed south door
 * with edge-driven doorways that land where the graph actually connects.
 *
 * Result: the tile geometry's open space matches the very edge graph `verify.ts` proves solvable on, so
 * a solvable floor stays solvable once tiled (the 4c corner-graph gate confirms it independently).
 *
 * Deterministic: row-major cells × fixed DIRS order; an edge SET for O(1) passage lookup (membership
 * only — never iterated for output). No float / RNG / Map-iteration on the output path.
 */
function reconcileDoors(floor: Floor, tiles: (WallTile | null)[]): void {
  const W = floor.width;
  const passages = new Set<number>();
  for (const e of floor.edges) passages.add(edgeKey(e.a, e.b));
  for (let c = 0; c < tiles.length; c++) {
    const tile = tiles[c];
    if (!tile) continue;
    const rid = floor.cells[c]?.roomId ?? -1;
    if (rid < 0) continue; // only ROOM cells carry the ring walls to open; corridors are bare floor
    tile.wallType = 'solid'; // edge-driven openings replace basicRoom's fixed south door
    const cx = c % W, cy = (c / W) | 0;
    for (const d of DIRS) {
      const [dx, dz] = DV[d];
      const nx = cx + dx, ny = cy + dz;
      if (nx < 0 || nx >= W || ny < 0 || ny >= floor.height) continue;
      const n = cellId(W, nx, ny);
      if ((floor.cells[n]?.roomId ?? -1) === rid) continue; // same-room interior — keep dividers
      if (!passages.has(edgeKey(c, n))) continue; // no passage here → keep the enclosing wall
      openAcross(tile, d); // a real passage crosses this side → clear the wall that blocks it
    }
  }
}

/**
 * The resolved concrete tiles for a floor (row-major, length width*height; null where a cell
 * conflicts), with the room wall-rings RECONCILED against the Floor's traversal graph so doorways land
 * where the floor actually connects (completable levels). `pick` is the coordinate-hash entropy seam.
 */
export function floorTiles(
  floor: Floor,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (WallTile | null)[] {
  const tiles = resolveGrid(floorToTileGrid(floor), pick);
  reconcileDoors(floor, tiles);
  return tiles;
}
