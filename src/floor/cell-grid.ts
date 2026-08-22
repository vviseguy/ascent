// ============================================================================
// src/floor/cell-grid.ts — a GRID of CellFields with database-style transactions.
// ============================================================================
//
// The map is a grid of CellFields, every cell starting at `fullField` — nothing decided anywhere.
// Generation stamps templates onto it in BATCHES that commit or roll back ATOMICALLY:
//
//   begin(grid)              start a transaction (nothing applied yet)
//   stamp(tx, region, t)     stage an AND-gate of a template over a region
//   txConflicts(tx)          which staged cells went empty — the guard a commit must pass
//   commit(tx)               apply ALL staged changes iff conflict-free → true; else nothing → false
//   rollback(tx)             discard the staged changes
//
// So "place a room" = stamp it into a tx and commit: it lands whole or not at all, and a refused
// placement leaves the map byte-identical. Pure: stamps build a staged overlay, the grid mutates only
// on a clean commit, iteration is index-sorted, so output is deterministic.
//
// NO OWNER RESOLUTION STEP. The 4u model needed one — a shared boundary lived in two tiles' data and
// had to be reconciled before anyone could read a whole tile. Here every field is owned by exactly one
// cell, so `resolve` is just a collapse. A reader that wants a cell's four walls looks the two
// neighbours up (`wallAt`); nothing is stored twice, so nothing can disagree.

import {
  blocks, wallOwner,
  type Cell, type Dir, type Seg,
} from './cell.ts';
import {
  andGate, cloneField, collapse, conflicts as cellConflicts, fullField,
  type CellField, type FieldKey, type Pick,
} from './cell-field.ts';

export interface CellGrid {
  readonly w: number;
  readonly h: number;
  /** row-major, length w*h. */
  cells: CellField[];
}

export interface Region { x: number; y: number; w: number; h: number }

export const cellIndex = (g: CellGrid, x: number, y: number): number => y * g.w + x;
export const inBounds = (g: CellGrid, x: number, y: number): boolean => x >= 0 && y >= 0 && x < g.w && y < g.h;

/** A fresh map — every cell allows everything. */
export function makeGrid(w: number, h: number): CellGrid {
  return { w, h, cells: Array.from({ length: w * h }, fullField) };
}

/** The field at (x,y), or undefined out of bounds. */
export const at = (g: CellGrid, x: number, y: number): CellField | undefined =>
  inBounds(g, x, y) ? g.cells[cellIndex(g, x, y)] : undefined;

/* --------------------------------- transactions -------------------------------- */

export interface Tx {
  readonly grid: CellGrid;
  /** cellIndex → the staged (post-stamp) field. */
  readonly staged: Map<number, CellField>;
}

export const begin = (grid: CellGrid): Tx => ({ grid, staged: new Map() });

const currentOf = (tx: Tx, i: number): CellField => tx.staged.get(i) ?? tx.grid.cells[i]!;

/** One template for a whole region, or a positional function for a patterned one. */
export type Stamp = CellField | ((lx: number, ly: number, region: Region) => CellField);

/** Stage an AND-gate of `s` over `region`. Out-of-bounds cells are skipped. */
export function stamp(tx: Tx, region: Region, s: Stamp): void {
  for (let ly = 0; ly < region.h; ly++) {
    for (let lx = 0; lx < region.w; lx++) {
      const x = region.x + lx, y = region.y + ly;
      if (!inBounds(tx.grid, x, y)) continue;
      const i = cellIndex(tx.grid, x, y);
      tx.staged.set(i, andGate(currentOf(tx, i), typeof s === 'function' ? s(lx, ly, region) : s));
    }
  }
}

/** Staged indices in sorted order — deterministic, never raw Map order. */
const stagedSorted = (tx: Tx): number[] => [...tx.staged.keys()].sort((a, b) => a - b);

/** Which staged cells went EMPTY — the conflicts that block the commit. */
export function txConflicts(tx: Tx): { x: number; y: number; fields: FieldKey[] }[] {
  const out: { x: number; y: number; fields: FieldKey[] }[] = [];
  for (const i of stagedSorted(tx)) {
    const c = cellConflicts(tx.staged.get(i)!);
    if (c.length) out.push({ x: i % tx.grid.w, y: Math.floor(i / tx.grid.w), fields: c });
  }
  return out;
}

/** Apply ALL staged changes iff conflict-free (atomic). Returns whether it committed. */
export function commit(tx: Tx): boolean {
  if (txConflicts(tx).length > 0) return false;
  for (const i of stagedSorted(tx)) tx.grid.cells[i] = tx.staged.get(i)!;
  tx.staged.clear();
  return true;
}

/** Discard the staged changes — the grid is untouched. */
export const rollback = (tx: Tx): void => { tx.staged.clear(); };

/** Try several stamps as ONE atomic batch. */
export function applyBatch(
  grid: CellGrid,
  stamps: { region: Region; stamp: Stamp }[],
): { ok: boolean; conflicts: ReturnType<typeof txConflicts> } {
  const tx = begin(grid);
  for (const s of stamps) stamp(tx, s.region, s.stamp);
  const c = txConflicts(tx);
  return { ok: commit(tx), conflicts: c };
}

/* --------------------------------- reading ------------------------------------- */

/** Collapse every cell → concrete Cells (null where a domain is empty). */
export const resolveGrid = (g: CellGrid, pick?: (x: number, y: number) => Pick): (Cell | null)[] =>
  g.cells.map((f, i) => collapse(f, pick ? pick(i % g.w, Math.floor(i / g.w)) : undefined));

/** Deep copy — for staging an experiment without a transaction. */
export const cloneGrid = (g: CellGrid): CellGrid => ({ w: g.w, h: g.h, cells: g.cells.map(cloneField) });

/**
 * The wall on side `d` of cell (x,y), read from whichever cell OWNS it. Off the map resolves to the
 * PERIMETER shell: the outer ring is always wall, because entries and exits pierce a floor
 * vertically (stairs), never through its rim.
 */
export function wallAt(cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: Dir): Seg {
  const o = wallOwner(x, y, d);
  if (o.x < 0 || o.y < 0 || o.x >= w || o.y >= h) return 'wall';
  const c = cells[o.y * w + o.x];
  return c ? c[o.side === 'N' ? 'wallN' : 'wallW'] : 'wall';
}

/** Can a body step from cell (x,y) to its neighbour in direction `d`? */
export const canStep = (cells: readonly (Cell | null)[], w: number, h: number, x: number, y: number, d: Dir): boolean =>
  !blocks(wallAt(cells, w, h, x, y, d));
