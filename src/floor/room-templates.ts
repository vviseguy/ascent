// ============================================================================
// src/floor/room-templates.ts — a starter LIBRARY of room templates.
// ============================================================================
//
// Each template is a positional `Stamp` (lx,ly → a tile) for tile-grid.ts: stamp it over a
// region and it forces that region into the room shape (singleton domains, so overlaps with
// another room CONFLICT and roll back). They differ by what the 9-cell model can express today —
// floor material, the wall ring, interior walls/columns/bars, and wall openings (door/arch/hole).
// Object content (actual shelves, thrones, …) is the later placement-machine layer; here the
// rooms are distinguished structurally.

import {
  DIRS,
  type WallTile,
  type Seg,
  type Centre,
  type WallType,
  type FloorMaterial,
  type SideSet,
  type CornerFloors,
  type Dir,
} from './wall-tile.ts';
import { fromTile } from './wall-tile-field.ts';
import type { Stamp } from './tile-grid.ts';

const allF = (m: FloorMaterial): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const empty = (): SideSet => ({ N: 'none', E: 'none', S: 'none', W: 'none' });

interface Spec {
  floor?: FloorMaterial;
  /** a full wall/barrier arm (edge+inner) in each given direction. */
  arms?: Partial<Record<Dir, Seg>>;
  centre?: Centre;
  wallType?: WallType;
}
function tile(s: Spec): WallTile {
  const e = empty();
  const n = empty();
  if (s.arms) for (const d of DIRS) { const v = s.arms[d]; if (v && v !== 'none') { e[d] = v; n[d] = v; } }
  return { floor: allF(s.floor ?? 'stone'), edge: e, inner: n, centre: s.centre ?? 'none', wallType: s.wallType ?? 'solid' };
}

/** The wall-ring arms (mitered corners + straight runs) for a perimeter position. */
function ring(lx: number, ly: number, w: number, h: number): Partial<Record<Dir, Seg>> {
  const W0 = lx === 0, E0 = lx === w - 1, N0 = ly === 0, S0 = ly === h - 1;
  if (N0 && W0) return { E: 'wall', S: 'wall' };
  if (N0 && E0) return { S: 'wall', W: 'wall' };
  if (S0 && W0) return { N: 'wall', E: 'wall' };
  if (S0 && E0) return { N: 'wall', W: 'wall' };
  if (N0 || S0) return { E: 'wall', W: 'wall' };
  if (W0 || E0) return { N: 'wall', S: 'wall' };
  return {};
}
const onPerimeter = (lx: number, ly: number, w: number, h: number): boolean => lx === 0 || ly === 0 || lx === w - 1 || ly === h - 1;
const mid = (n: number): number => Math.floor(n / 2);

/* --------------------------------- the rooms --------------------------------- */

/** A plain room: floor + a wall ring. */
export const basicRoom = (w: number, h: number, floor: FloorMaterial = 'stone'): Stamp =>
  (lx, ly) => fromTile(tile({ floor, arms: ring(lx, ly, w, h) }));

/** A corridor: continuous walls along the two LONG sides, open ends, floor passage. */
export const hallway = (w: number, h: number): Stamp => (lx, ly) => {
  const horizontal = w >= h;
  const arms: Partial<Record<Dir, Seg>> = {};
  if (horizontal) {
    if (ly === 0 || ly === h - 1) { arms.E = 'wall'; arms.W = 'wall'; } // N & S walls run E–W
  } else if (lx === 0 || lx === w - 1) {
    arms.N = 'wall'; arms.S = 'wall'; // E & W walls run N–S
  }
  return fromTile(tile({ floor: 'stone', arms }));
};

/** A library: wood floor, wall ring with a south door, interior shelf-row dividers. */
export const library = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    const door = ly === h - 1 && lx === mid(w);
    return fromTile(tile({ floor: 'wood', arms: ring(lx, ly, w, h), ...(door ? { wallType: 'door' } : {}) }));
  }
  const shelf = lx % 2 === 0; // aisle dividers on alternating interior columns (N–S walls)
  return fromTile(tile({ floor: 'wood', arms: shelf ? { N: 'wall', S: 'wall' } : {} }));
};

/** A throne room: stone floor, wall ring with a south door + a north arch, flanking colonnades. */
export const throneRoom = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    const door = ly === h - 1 && lx === mid(w);
    const arch = ly === 0 && lx === mid(w);
    const wallType: WallType | undefined = door ? 'door' : arch ? 'arch' : undefined;
    return fromTile(tile({ floor: 'stone', arms: ring(lx, ly, w, h), ...(wallType ? { wallType } : {}) }));
  }
  const column = (lx === 1 || lx === w - 2) && ly % 2 === 0; // colonnades down the side aisles
  return fromTile(tile({ floor: 'stone', centre: column ? 'wall' : 'none' }));
};

/** A dungeon: dirt floor, wall ring with broken sections, cell dividers with barred gates. */
export const dungeon = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    const broken = (ly === 0 || ly === h - 1) && lx % 3 === 1; // a knocked-through gap
    return fromTile(tile({ floor: 'dirt', arms: ring(lx, ly, w, h), ...(broken ? { wallType: 'hole' } : {}) }));
  }
  if (lx % 2 === 1) {
    const bar = ly % 3 === 1; // a barred gate in the cell divider
    return fromTile(tile({ floor: 'dirt', arms: { N: bar ? 'barrier' : 'wall', S: bar ? 'barrier' : 'wall' } }));
  }
  return fromTile(tile({ floor: 'dirt' }));
};

/** Named registry + a sensible default size for each, for previews / pickers. */
export const ROOMS: Record<string, { make: (w: number, h: number) => Stamp; size: [number, number] }> = {
  'basic room': { make: (w, h) => basicRoom(w, h), size: [5, 4] },
  hallway: { make: hallway, size: [9, 3] },
  library: { make: library, size: [7, 5] },
  'throne room': { make: throneRoom, size: [7, 5] },
  dungeon: { make: dungeon, size: [7, 5] },
};
