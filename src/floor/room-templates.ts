// ============================================================================
// src/floor/room-templates.ts — a starter LIBRARY of room templates.
// ============================================================================
//
// Each template is a positional `Stamp` (lx,ly → a TileField) for tile-grid.ts. Stamp it over a
// region and it constrains that region into the room shape.
//
// CONSTRAIN ONLY THE INSIDE. A room pins down what makes it a room — its floor, its interior
// layout, and the wall RING (each wall's inner cell + the run-continuity edges between adjacent
// wall tiles) — and leaves every cell with NO wall OPEN. In particular the OUTWARD-facing boundary
// edges stay open, so anything (a corridor, another room, a door) can connect to the room from
// outside without a conflict. (Contrast `fromTile`, which would force all 9 cells to singletons and
// over-claim the shared boundary.) The blue cells in the board view are exactly these open ones.
//
// Every room also gets an ENTRY — a doorway in the south wall (`wallType: 'door'`), except the
// hallway, whose ends are open by construction.
//
// Rooms differ STRUCTURALLY (floor material, wall ring, interior walls/columns/bars, wall openings).
// Object content (actual shelves, beds, thrones) is the later placement-machine layer.

import { DIRS, type Seg, type Centre, type WallType, type FloorMaterial, type Dir } from './wall-tile.ts';
import { template, segs, centres, floors, wallTypes, type Mask, type TileField } from './wall-tile-field.ts';
import type { Stamp } from './tile-grid.ts';

interface CellSpec {
  floor: FloorMaterial;
  /** a full wall/barrier arm (inner + run-edge) in each given direction. */
  arms?: Partial<Record<Dir, Seg>>;
  centre?: Centre;
  wallType?: WallType;
}
/**
 * A room cell as a TEMPLATE. Constrains: floor (all corners), centre, every inner cell (wall where
 * an arm is, none otherwise), and the EDGE only along a wall run (for continuity). Edges with no arm
 * are LEFT OPEN — the outward boundary + interior connections stay free for neighbours to attach.
 */
function cell(s: CellSpec): TileField {
  const edge: Partial<Record<Dir, Mask>> = {};
  const inner: Partial<Record<Dir, Mask>> = {};
  for (const d of DIRS) {
    const a = s.arms?.[d];
    const seg: Seg = a && a !== 'none' ? a : 'none';
    inner[d] = segs(seg); // inner ALWAYS constrained: wall/barrier where an arm, none otherwise
    if (seg !== 'none') edge[d] = segs(seg); // edge constrained ONLY along the run; else left open
  }
  const fm = floors(s.floor);
  return template({
    floor: { nw: fm, ne: fm, sw: fm, se: fm },
    edge,
    inner,
    centre: centres(s.centre ?? 'none'),
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
const onPerimeter = (lx: number, ly: number, w: number, h: number): boolean => lx === 0 || ly === 0 || lx === w - 1 || ly === h - 1;
const mid = (n: number): number => Math.floor(n / 2);
/** The single south-wall doorway every enclosed room gets as its entry. */
const isEntry = (lx: number, ly: number, w: number, h: number): boolean => ly === h - 1 && lx === mid(w);

/* --------------------------------- the rooms --------------------------------- */

/** A plain room: floor + a wall ring + a south doorway. */
export const basicRoom = (w: number, h: number, floor: FloorMaterial = 'stone'): Stamp =>
  (lx, ly) => cell({ floor, arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });

/** A corridor: continuous walls along the two LONG sides, open ends, floor passage. */
export const hallway = (w: number, h: number): Stamp => (lx, ly) => {
  const horizontal = w >= h;
  const arms: Partial<Record<Dir, Seg>> = {};
  if (horizontal) {
    if (ly === 0 || ly === h - 1) { arms.E = 'wall'; arms.W = 'wall'; } // N & S walls run E–W
  } else if (lx === 0 || lx === w - 1) {
    arms.N = 'wall'; arms.S = 'wall'; // E & W walls run N–S
  }
  return cell({ floor: 'stone', arms });
};

/** A library: wood floor, wall ring + south door, interior shelf-row dividers. */
export const library = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    return cell({ floor: 'wood', arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
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
    return cell({ floor: 'stone', arms: ring(lx, ly, w, h), ...(wallType ? { wallType } : {}) });
  }
  const pillarRow = (lx === 2 || lx === w - 3) && ly % 2 === 0; // two colonnades flanking the aisle
  return cell({ floor: 'stone', centre: pillarRow ? 'wall' : 'none' });
};

/** A dungeon: dirt floor, wall ring + south door, prison CELLS divided by GRATE walls (locked). */
export const dungeon = (w: number, h: number): Stamp => (lx, ly) => {
  if (onPerimeter(lx, ly, w, h)) {
    return cell({ floor: 'dirt', arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
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
    return cell({ floor: 'wood', arms: ring(lx, ly, w, h), ...(isEntry(lx, ly, w, h) ? { wallType: 'door' } : {}) });
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
