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
import type { WallTile, TileCore, Seg } from './wall-tile.ts';

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

/** Collapse every cell to a concrete tile CORE in ISOLATION (owned edges only; E/S unresolved; null
 *  where a domain is empty). For the renderer/collision use `resolveGrid` instead — this is the raw
 *  per-cell collapse (lab board / tests). `pick` is the entropy seam, default = canonical. */
export function collapseGrid(
  grid: TileGrid,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (TileCore | null)[] {
  return grid.cells.map((f, i) => {
    const x = i % grid.w;
    const y = Math.floor(i / grid.w);
    return collapse(f, pick ? (cell, opts) => pick(x, y, cell, opts) : undefined);
  });
}

/* ----------------------------- resolved read path ---------------------------- */
// `collapseGrid` collapses each cell in ISOLATION (a tile keeps its own 4 edges). The runtime/render
// path wants the OWNER-resolved view (docs/16 §12 #4): a shared boundary belongs to ONE tile, so two
// neighbours can never disagree. `resolveGrid` is that view — and it materialises ONCE (collapse each
// cell a single time, then fill E/S from the neighbour cores) so consumers read a flat array instead
// of re-resolving per access.

/** The closed map perimeter. The outer ring is always the WALL "safe shell" — an opening there would
 *  breach the dungeon; entries/exits pierce vertically (stairs), never the perimeter. A tile's E/S
 *  with no neighbour (the east/south map border, or a conflicted neighbour) resolves to this. */
const PERIMETER: Seg = 'wall';

/**
 * Collapse the grid AND resolve every shared edge to its single owner: a tile owns its N+W edges; its
 * E is the east neighbour's W, its S the south neighbour's N (a missing/conflicted neighbour → the
 * PERIMETER wall). Each cell collapses ONCE into a core, then E/S are filled from the neighbour cores
 * — so this is the materialise-once read path for tilePlacements / collision / the corner-graph. `pick`
 * is the coordinate-hash entropy seam (seeded `(x,y,cell,options) → index`); default = canonical.
 */
export function resolveGrid(
  grid: TileGrid,
  pick?: (x: number, y: number, cell: string, options: readonly string[]) => number,
): (WallTile | null)[] {
  const cores = grid.cells.map((f, i) =>
    collapse(f, pick ? (cell, opts) => pick(i % grid.w, Math.floor(i / grid.w), cell, opts) : undefined),
  );
  return cores.map((core, i) => {
    if (!core) return null;
    const x = i % grid.w;
    const y = Math.floor(i / grid.w);
    const east = x + 1 < grid.w ? cores[i + 1] : null; // owner of this tile's E edge is the east neighbour's W
    const south = y + 1 < grid.h ? cores[i + grid.w] : null; // …its S edge is the south neighbour's N
    return { ...core, edge: { N: core.edge.N, W: core.edge.W, E: east ? east.edge.W : PERIMETER, S: south ? south.edge.N : PERIMETER } };
  });
}

/** Resolve ONE tile to its full 9-cell view (E/S from the neighbour owners; border/conflict →
 *  PERIMETER). Convenience for one-off access; for a whole grid use `resolveGrid` (collapses once). */
export function tileView(
  grid: TileGrid,
  x: number,
  y: number,
  pick?: (px: number, py: number, cell: string, options: readonly string[]) => number,
): WallTile | null {
  const core = (cx: number, cy: number): TileCore | null =>
    inBounds(grid, cx, cy)
      ? collapse(grid.cells[cellIndex(grid, cx, cy)]!, pick ? (cell, opts) => pick(cx, cy, cell, opts) : undefined)
      : null;
  const self = core(x, y);
  if (!self) return null;
  const east = core(x + 1, y);
  const south = core(x, y + 1);
  return { ...self, edge: { N: self.edge.N, W: self.edge.W, E: east ? east.edge.W : PERIMETER, S: south ? south.edge.N : PERIMETER } };
}
