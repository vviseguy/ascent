// ============================================================================
// src/floor/room-roles.ts — assign each room a ROLE; map roles → template + dressing theme.
// ============================================================================
//
// The spine of template placement (docs/16 §5, the "Program layer"): a room is placed WITH a role
// that drives BOTH its structural template (sim-side, here) AND its object dressing (the renderer
// reads the same role off `CellTile.roomRole`), so a room's structure and its contents always agree —
// a library reads in wood with bookshelves, a treasure vault in stone with chests, and so on.
//
// Deterministic: a role is a seeded hash of (runSeed, roomId) — integer-only (mixSeeds), no float /
// no RNG-stream draw / no Map iteration — so every peer derives the identical role for a room.
//
// SOLVABILITY NOTE: today every role lowers to a plain ring in the role's floor material (interiors
// stay fully walkable), so tiling can never make a floor unsolvable — the richness is carried by
// role-matched OBJECTS (render-side, collision-free). Interior-wall templates (aisles, cells, pillar
// colonnades) are the next increment and need the door-reconciler to also carve a guaranteed path
// through the room before they can land — deferred on purpose.

import { mixSeeds } from './rng.ts';
import { basicRoom } from './room-templates.ts';
import type { Stamp } from './tile-grid.ts';
import type { FloorMaterial } from './wall-tile.ts';

/** The authored room roles. Index order is the stable contract the renderer's dressing switch reads. */
export const ROOM_ROLES = ['hall', 'library', 'dining', 'bedroom', 'storage', 'armory', 'treasure', 'shrine'] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

/** Deterministic role INDEX (0..ROOM_ROLES.length-1) for a room — a seeded hash of (runSeed, roomId).
 *  `roomId*2+1` keeps adjacent ids from hashing to neighbouring buckets. */
export function roomRoleIndex(roomId: number, runSeed: bigint): number {
  const h = mixSeeds(runSeed, BigInt((roomId >>> 0) * 2 + 1));
  const n = BigInt(ROOM_ROLES.length);
  return Number(((h % n) + n) % n);
}

/** The role a room plays. */
export function roomRole(roomId: number, runSeed: bigint): RoomRole {
  return ROOM_ROLES[roomRoleIndex(roomId, runSeed)]!;
}

/** The floor material a role reads in (stone / wood / dirt). */
export function roleFloor(role: RoomRole): Exclude<FloorMaterial, 'none'> {
  switch (role) {
    case 'library':
    case 'bedroom':
      return 'wood';
    case 'storage':
    case 'armory':
    case 'shrine':
      return 'dirt';
    default: // hall, dining, treasure
      return 'stone';
  }
}

/** The structural template for a room of this role. SOLVABILITY-SAFE: a plain wall ring in the role's
 *  floor material, interior left walkable (the door-reconciler opens the ring where the floor graph
 *  connects). Interior structure per role is the next increment (see the module header). */
export function roomStamp(role: RoomRole, w: number, h: number): Stamp {
  return basicRoom(w, h, roleFloor(role));
}
