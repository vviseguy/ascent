// ============================================================================
// src/game/structures.ts — SAVED tile structures (lab → game).
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
// derive/seed the author previewed with are kept only as metadata. `structureTiles` collapses to the
// concrete WallTiles the renderer/collision place via tilePlacements.

import { collapse, type TileField } from '../floor/wall-tile-field.ts';
import type { WallTile } from '../floor/wall-tile.ts';
import data from './structures.json';

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
 * Collapse a saved structure to concrete tiles (row-major, length w*h; null where a cell conflicts).
 * `pick` is the entropy seam — pass a seeded `(cell, options) → index` for deterministic generation;
 * default is the canonical lowest option. Returns undefined if the name is unknown.
 */
export function structureTiles(name: string, pick?: (cell: string, options: readonly string[]) => number): (WallTile | null)[] | undefined {
  const s = store.structures[name];
  return s?.cells.map((c) => collapse(c, pick));
}
