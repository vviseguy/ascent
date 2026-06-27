// ============================================================================
// src/floor/tile-grid.ts — a GRID of TileFields with database-style transactions.
// ============================================================================
//
// The map is a grid of TileFields (every cell a domain; starts all-`fullField`). Generation
// stamps templates onto it — but in BATCHES that commit or roll back ATOMICALLY, like a DB:
//
//   begin(grid)              start a transaction (nothing applied yet).
//   stamp(tx, region, t)     stage an AND-gate of a template over a region (rooms, corridors…).
//   txConflicts(tx)          which staged cells went empty (the NOR guard, grid-scale).
//   commit(tx)               apply ALL staged changes iff conflict-free → true; else nothing → false.
//   rollback(tx)             discard the staged changes.
//
// So "write multiple rooms at once" = stamp each room into one tx, then commit: all land or none
// do. A failed placement leaves the map exactly as it was. Pure: stamps build a staged overlay
// (via andGate, which is pure); the grid is mutated only on a clean commit; iteration is
// index-sorted, never Map-order, so output is deterministic.

import { type TileField, fullField, andGate, conflicts as cellConflicts, collapse } from './wall-tile-field.ts';
import type { WallTile } from './wall-tile.ts';

export interface TileGrid {
  readonly w: number;
  readonly h: number;
  /** row-major, length w*h. */
  cells: TileField[];
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const cellIndex = (g: TileGrid, x: number, y: number): number => y * g.w + x;
export const inBounds = (g: TileGrid, x: number, y: number): boolean => x >= 0 && y >= 0 && x < g.w && y < g.h;

/** A fresh map — every cell allows everything. */
export function makeGrid(w: number, h: number): TileGrid {
  const cells: TileField[] = [];
  for (let i = 0; i < w * h; i++) cells.push(fullField());
  return { w, h, cells };
}

export function at(g: TileGrid, x: number, y: number): TileField {
  return g.cells[cellIndex(g, x, y)]!;
}

/* -------------------------------- transactions ------------------------------- */

/** A proposed set of changes — a staged overlay over the grid, applied only on commit. */
export interface Tx {
  readonly grid: TileGrid;
  /** cellIndex → the staged (post-stamp) field. */
  readonly staged: Map<number, TileField>;
}

export function begin(grid: TileGrid): Tx {
  return { grid, staged: new Map() };
}

/** The current value of a cell within the transaction (staged if touched, else the grid's). */
const currentOf = (tx: Tx, i: number): TileField => tx.staged.get(i) ?? tx.grid.cells[i]!;

/** A stamp is one template for the whole region, or a positional function (for patterned rooms). */
export type Stamp = TileField | ((lx: number, ly: number, region: Region) => TileField);

/** Stage an AND-gate of `s` over `region` (out-of-bounds cells are skipped). */
export function stamp(tx: Tx, region: Region, s: Stamp): void {
  for (let ly = 0; ly < region.h; ly++) {
    for (let lx = 0; lx < region.w; lx++) {
      const x = region.x + lx;
      const y = region.y + ly;
      if (!inBounds(tx.grid, x, y)) continue;
      const i = cellIndex(tx.grid, x, y);
      const tmpl = typeof s === 'function' ? s(lx, ly, region) : s;
      tx.staged.set(i, andGate(currentOf(tx, i), tmpl));
    }
  }
}

/** Staged-cell indices in sorted order (deterministic; never raw Map order). */
const stagedSorted = (tx: Tx): number[] => [...tx.staged.keys()].sort((a, b) => a - b);

/** Which staged cells went EMPTY — the conflicts that would block the commit. */
export function txConflicts(tx: Tx): { x: number; y: number; cells: string[] }[] {
  const out: { x: number; y: number; cells: string[] }[] = [];
  for (const i of stagedSorted(tx)) {
    const c = cellConflicts(tx.staged.get(i)!);
    if (c.length) out.push({ x: i % tx.grid.w, y: Math.floor(i / tx.grid.w), cells: c });
  }
  return out;
}

/** Apply ALL staged changes iff conflict-free (atomic). Returns whether it committed. */
export function commit(tx: Tx): boolean {
  if (txConflicts(tx).length > 0) return false; // atomic: a single conflict aborts the whole batch
  for (const i of stagedSorted(tx)) tx.grid.cells[i] = tx.staged.get(i)!;
  tx.staged.clear();
  return true;
}

/** Discard the staged changes — the grid is untouched. */
export function rollback(tx: Tx): void {
  tx.staged.clear();
}

/* --------------------------------- convenience ------------------------------- */

/** Try to write several stamps as ONE atomic batch. Returns whether it landed + any conflicts. */
export function applyBatch(
  grid: TileGrid,
  stamps: { region: Region; stamp: Stamp }[],
): { ok: boolean; conflicts: { x: number; y: number; cells: string[] }[] } {
  const tx = begin(grid);
  for (const s of stamps) stamp(tx, s.region, s.stamp);
  const conflicts = txConflicts(tx);
  const ok = commit(tx); // commit is itself atomic; this is just the ergonomic wrapper
  return { ok, conflicts };
}

/** Collapse every cell to a concrete tile (null where a domain is empty). `pick` is the entropy
 *  seam — a seeded `(x,y,cell,options) → index` for real generation; default = canonical. */
export function collapseGrid(
  grid: TileGrid,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (WallTile | null)[] {
  return grid.cells.map((f, i) => {
    const x = i % grid.w;
    const y = Math.floor(i / grid.w);
    return collapse(f, pick ? (cell, opts) => pick(x, y, cell, opts) : undefined);
  });
}
