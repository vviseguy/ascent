// ============================================================================
// src/floor/cell-structures.ts — the authored structures, on the 2u cell grid.
// ============================================================================
//
// Hand-painted patches of map — a room, a hallway, a junction — authored in the tile editor and saved
// to a git-tracked store so the GENERATOR can place them deterministically. These are the ONLY rooms
// the emergent generator places; there is no procedural room shape.
//
// Stored as FIELDS (domains), not collapsed cells, so a half-painted structure keeps its freedom and
// the generator collapses it with its own seeded pick. Anything the author did not paint abstains,
// which is what lets a structure sit in a maze without dictating its surroundings.
//
// Produced by `structure-migrate.ts` from the 4u store, verified cell-for-cell against the old
// resolver (`structure-migrate.test.ts`). The `from` field records the original tile dimensions.

import data from './cell-structures.json' with { type: 'json' };
import type { CellField } from './cell-field.ts';
import { makeGrid, type CellGrid } from './cell-grid.ts';

/**
 * THE STORED GRID IS THE LATTICE OF POINTS, not the grid of cells.
 *
 * `w` × `h` is the FLOOR extent — what you would call the size of the room. The `cells` array is
 * (w+1) × (h+1), because each entry describes what happens at one lattice POINT:
 *
 *   wallN     the horizontal edge running EAST from this point
 *   wallW     the vertical edge running SOUTH from this point
 *   corner    the junction AT this point
 *   floor     the ground of the cell to this point's south-east (meaningless on the last row/column)
 *
 * The padding is what makes a structure SYMMETRIC: it owns all four of its border walls instead of
 * only N and W. Without it, rotating pushes the north and west walls onto sides no cell can own and
 * they simply vanish — four quarter-turns stopped being the identity, which is how this was found.
 */
export interface CellStructure {
  /** FLOOR extent. The `cells` array is (w+1)×(h+1) — see above. */
  w: number;
  h: number;
  /** (w+1)*(h+1) fields, indexed by POINT: `cells[py * (w+1) + px]`. */
  cells: CellField[];
  /** Provenance: the 4u dimensions this was converted from. */
  from?: string;
}

/** Row stride of the stored point lattice. */
export const stride = (s: { w: number }): number => s.w + 1;

const store = data as unknown as { version: number; structures: Record<string, CellStructure> };

export const STRUCTURE_VERSION = store.version;
/** Names in a FIXED order — sorted, so any iteration over structures is deterministic. */
export const listStructures = (): string[] => Object.keys(store.structures).sort();
export const getStructure = (name: string): CellStructure | undefined => store.structures[name];

/** A structure as a standalone grid, ready to resolve or preview. */
export function structureGrid(name: string): CellGrid | undefined {
  const s = getStructure(name);
  if (!s) return undefined;
  const g = makeGrid(s.w + 1, s.h + 1); // the point lattice, not the floor extent
  g.cells = s.cells.map((f) => ({ ...f }));
  return g;
}
