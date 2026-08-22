// ============================================================================
// src/floor/structures.ts — SAVED tile structures (lab → generator).
// ============================================================================
//
// A "structure" is a hand-authored patch of the 9-cell tile board (a room, a hallway, a junction)
// built in the Tile Paint Editor (src/lab/tile-editor.ts) and SAVED to the git-tracked store so the
// GAME can load it deterministically:
//
//   lab: paint a grid of TileFields  →  "Save to server"  →  structures.json  →  game
//
// The JSON is written by the Vite dev middleware (`/__lab/structures`, see vite.config.ts); this is
// the typed read side. Each structure stores the editor's TileFIELDS (domains, not yet collapsed) so
// it round-trips back into the editor AND lets the game collapse with its OWN seeded `pick` — the
// derive/seed the author previewed with are kept only as metadata. `structureTiles` RESOLVES to the
// concrete WallTiles the renderer/collision place via tilePlacements — resolved, so shared edges are
// owned once (docs/16 §12 #4) rather than each tile describing its boundary independently.

import type { TileField } from './wall-tile-field.ts';
import { resolveGrid, type TileGrid } from './tile-grid.ts';
import type { WallTile } from './wall-tile.ts';
import data from './structures.json' with { type: 'json' };

/** One saved structure: a w×h grid of tile DOMAINS, plus the author's preview settings (metadata). */
export interface SavedStructure {
  w: number;
  h: number;
  cells: TileField[];
  /** The ambiguity-derive mode the author previewed with ('none' | 'wall' | 'barrier' | 'random'). */
  derive?: string;
  seed?: number;
  /** ISO timestamp, stamped by the dev middleware. */
  savedAt?: string;
}

export interface StructureStore {
  version: number;
  structures: Record<string, SavedStructure>;
}

const store = data as StructureStore;

/** Every saved structure, keyed by name. */
export const STRUCTURES: StructureStore = store;
export const listStructures = (): string[] => Object.keys(store.structures);
export const getStructure = (name: string): SavedStructure | undefined => store.structures[name];

/**
 * Resolve a saved structure to concrete tiles (row-major, length w*h; null where a cell conflicts).
 * Shared edges are owner-resolved (§12 #4) via `resolveGrid`, so the tiles are exactly what the
 * renderer/collision place. `pick` is the entropy seam — a seeded coordinate-hash
 * `(x,y,cell,options) → index` for deterministic generation; default is the canonical lowest option.
 * Returns undefined if the name is unknown.
 */
export function structureTiles(
  name: string,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (WallTile | null)[] | undefined {
  const s = store.structures[name];
  if (!s) return undefined;
  const grid: TileGrid = { w: s.w, h: s.h, cells: s.cells };
  return resolveGrid(grid, pick);
}
