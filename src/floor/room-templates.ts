// ============================================================================
// src/floor/room-templates.ts — a starter LIBRARY of room templates.
// ============================================================================
//
// Each template is a positional `Stamp` (lx,ly → a TileField) for tile-grid.ts. Stamp it over a
// region and it constrains that region into the room shape.
//
// CONSTRAIN ONLY WHAT'S INSIDE THE ROOM. A room pins down its floor and its OWN walls and nothing
// else:
//   - FLOOR is per-corner, and only the corners that fall INSIDE the walls are claimed — a wall
//     tile keeps floor on its interior side and leaves the outside corners open (floor stops at the
//     wall, not at the tile edge).
//   - WALLS: only the room's own arms are pinned (a wall + its run-continuity edge). Every other
//     cell stays OPEN. In particular a boundary wall does NOT force itself to be a corner — if a
//     corridor or room connects from outside, that corner is free to become a tee or a cross. The
//     room only cares that it is enclosed, not how its walls join the outside.
// Everything left open shows as a blue marker in the board view.
//
// Every enclosed room gets an ENTRY — a doorway in the south wall — except the hallway, whose ends
// are open by construction. Rooms differ STRUCTURALLY; object content (shelves, beds, thrones) is
// the later placement-machine layer.

import { DIRS, type Seg, type Centre, type WallType, type FloorMaterial, type Dir, type FloorCorner, type OwnedEdge } from './wall-tile.ts';
import { template, segs, centres, floors, wallTypes, type Mask, type TileField } from './wall-tile-field.ts';
import type { Stamp } from './tile-grid.ts';

interface CellSpec {
  floor: FloorMaterial;
  /** Directions sealed by a perimeter wall: the two floor corners beyond each are OUTSIDE → left open. */
  outside?: Dir[];
  /** The room's OWN wall/barrier arms (inner + run-edge); every other cell stays open. */
  arms?: Partial<Record<Dir, Seg>>;
  centre?: Centre;
  wallType?: WallType;
}
function cell(s: CellSpec): TileField {
  const out = s.outside ?? [];
  const inside = (a: Dir, b: Dir): boolean => !out.includes(a) && !out.includes(b);
  const fm = floors(s.floor);
  const floor: Partial<Record<FloorCorner, Mask>> = {};
  if (inside('N', 'W')) floor.nw = fm;
  if (inside('N', 'E')) floor.ne = fm;
  if (inside('S', 'W')) floor.sw = fm;
  if (inside('S', 'E')) floor.se = fm;

  // only the room's OWN arms are constrained (wall + its run edge); the rest stays open so the
  // wall can join the outside however it needs to (corner / tee / cross — the room doesn't care).
  // Edges are single-owned (§12 #4): a tile authors only its N/W edge; an E/S arm sets just the inner
  // here — the matching edge is the neighbour's W/N, which the resolver fills (perimeter at the border).
  const edge: Partial<Record<OwnedEdge, Mask>> = {};
  const inner: Partial<Record<Dir, Mask>> = {};
  for (const d of DIRS) {
    const a = s.arms?.[d];
    if (a && a !== 'none') {
      inner[d] = segs(a);
      if (d === 'N' || d === 'W') edge[d] = segs(a);
    }
  }
  return template({
    floor,
    edge,
    inner,
    ...(s.centre ? { centre: centres(s.centre) } : {}),
    ...(s.wallType ? { wallType: wallTypes(s.wallType) } : {}),
  });
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
/** The room-edge directions a tile sits on — its outside, for floor trimming. */
function edgeDirs(lx: number, ly: number, w: number, h: number): Dir[] {
  const o: Dir[] = [];
  if (ly === 0) o.push('N');
  if (ly === h - 1) o.push('S');
  if (lx === 0) o.push('W');
  if (lx === w - 1) o.push('E');
  return o;
}
const onPerimeter = (lx: number, ly: number, w: number, h: number): boolean => lx === 0 || ly === 0 || lx === w - 1 || ly === h - 1;
const mid = (n: number): number => Math.floor(n / 2);
const isEntry = (lx: number, ly: number, w: number, h: number): boolean => ly === h - 1 && lx === mid(w);

/* --------------------------------- the rooms --------------------------------- */

/** A plain room: floor + a wall ring + a south doorway. */
export const basicRoom = (w: number, h: number, floor: FloorMaterial = 'stone'): Stamp =>
  (lx, ly) => cell({ floor, outside: edgeDirs(lx, ly, w, h), arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });

/** A corridor: continuous walls along the two LONG sides, open ends, floor passage. */
export const hallway = (w: number, h: number): Stamp => (lx, ly) => {
  const horizontal = w >= h;
  const arms: Partial<Record<Dir, Seg>> = {};
  const outside: Dir[] = [];
  if (horizontal) {
    if (ly === 0) { arms.E = 'wall'; arms.W = 'wall'; outside.push('N'); }
    if (ly === h - 1) { arms.E = 'wall'; arms.W = 'wall'; outside.push('S'); }
  } else {
    if (lx === 0) { arms.N = 'wall'; arms.S = 'wall'; outside.push('W'); }
    if (lx === w - 1) { arms.N = 'wall'; arms.S = 'wall'; outside.push('E'); }
  }
  return cell({ floor: 'stone', outside, arms });
};

/** A library: wood floor, wall ring + south door, interior shelf-row dividers. */
export const library = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    return cell({ floor: 'wood', outside: edgeDirs(lx, ly, w, h), arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
  }
  const shelf = lx % 2 === 0; // aisle dividers on alternating interior columns (N–S walls)
  return cell({ floor: 'wood', arms: shelf ? { N: 'wall', S: 'wall' } : {} });
};

/** A throne room: large, stone floor, south door + north arch, TWO flanking rows of pillars. */
export const throneRoom = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    const door = isEntry(lx, ly, w, h);
    const arch = ly === 0 && lx === mid(w);
    const wallType: WallType | undefined = door ? 'door' : arch ? 'arch' : undefined;
    return cell({ floor: 'stone', outside: edgeDirs(lx, ly, w, h), arms: ring(lx, ly, w, h), ...(wallType ? { wallType } : {}) });
  }
  const pillarRow = (lx === 2 || lx === w - 3) && ly % 2 === 0; // two colonnades flanking the aisle
  return cell({ floor: 'stone', ...(pillarRow ? { centre: 'wall' } : {}) });
};

/** A dungeon: dirt floor, wall ring + south door, prison CELLS divided by GRATE walls (locked). */
export const dungeon = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    return cell({ floor: 'dirt', outside: edgeDirs(lx, ly, w, h), arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
  }
  if (lx % 2 === 1) {
    // GRATE wall between cells — barred, see-through (wall_gated); the gate IS the cell's locked door
    return cell({ floor: 'dirt', arms: { N: 'wall', S: 'wall' }, wallType: 'low_gate' });
  }
  return cell({ floor: 'dirt' });
};

/** A bedroom: small, wood floor, wall ring + south door, a low partition forming a bed nook. */
export const bedroom = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    return cell({ floor: 'wood', outside: edgeDirs(lx, ly, w, h), arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
  }
  // a short partition wall one tile in from the NW corner → a sleeping nook
  const nook = ly === 1 && lx >= 1 && lx <= Math.max(1, mid(w) - 1);
  return cell({ floor: 'wood', arms: nook ? { E: 'wall', W: 'wall' } : {} });
};

/** Named registry + a sensible default size for each, for previews / pickers. */
export const ROOMS: Record<string, { make: (w: number, h: number) => Stamp; size: [number, number] }> = {
  'basic room': { make: (w, h) => basicRoom(w, h), size: [5, 4] },
  hallway: { make: hallway, size: [9, 3] },
  library: { make: library, size: [7, 5] },
  'throne room': { make: throneRoom, size: [9, 7] },
  dungeon: { make: dungeon, size: [9, 6] },
  bedroom: { make: bedroom, size: [6, 5] },
};
