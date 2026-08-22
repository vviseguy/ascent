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

export interface CellStructure {
  w: number;
  h: number;
  cells: CellField[];
  /** Provenance: the 4u dimensions this was converted from. */
  from?: string;
}

const store = data as unknown as { version: number; structures: Record<string, CellStructure> };

export const STRUCTURE_VERSION = store.version;
/** Names in a FIXED order — sorted, so any iteration over structures is deterministic. */
export const listStructures = (): string[] => Object.keys(store.structures).sort();
export const getStructure = (name: string): CellStructure | undefined => store.structures[name];

/** A structure as a standalone grid, ready to resolve or preview. */
export function structureGrid(name: string): CellGrid | undefined {
  const s = getStructure(name);
  if (!s) return undefined;
  const g = makeGrid(s.w, s.h);
  g.cells = s.cells.map((f) => ({ ...f }));
  return g;
}
