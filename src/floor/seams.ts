// ============================================================================
// src/floor/seams.ts — SEAMS: the cells in different tiles that are one physical thing.
// ============================================================================
//
// Cutting the world into 4u tiles means some physical features get SPLIT across tiles, and the split
// parts are stored independently. Nothing in the data model says they belong together, so they drift —
// and drift is exactly what reads as "malformed": a wall that stops dead halfway across a boundary, a
// floor that changes material four ways around a single point.
//
// There are exactly two such splits, and this module names both.
//
//   CROSS seam — 2 TILES. The wall line crossing one tile boundary. It is THREE cells:
//
//        tile A            │            tile B
//          ⊙───inner.E───[edge]───inner.W───⊙
//        centre                            centre
//
//     Set all three and the wall runs centre-to-centre: one continuous 4u module, A and B each
//     placing their half-wall, meeting flush at the boundary. Set only A's and you get a HALF wall
//     that stops at the boundary with an end-cap — the stub. (`tile-place.ts` places `wall_half` for a
//     full arm and `wall_half_endcap` for one that doesn't reach, so the difference is visible.)
//     The shared edge cell is single-owned (docs/16 §12 #4), so a seam names it via its owner.
//
//   POINT seam — 4 TILES. The floor at one lattice point. A floor "corner" is really a QUADRANT of its
//     tile (`tile-place.ts:floorPlacements` emits four half-size pieces when the corners differ), so
//     the four quadrants meeting at a point are four independent values for one patch of ground:
//
//        (cx-1,cy-1).se │ (cx,cy-1).sw
//        ───────────────•───────────────      • = the lattice point
//        (cx-1,cy  ).ne │ (cx,cy  ).nw
//
//     Agreeing there is what makes the ground read as continuous instead of a four-way checkerboard.
//
// COHERENCE IS A TENDENCY, NOT A LAW. `cohere` narrows a seam's members to their intersection only
// when that intersection is non-empty. Members that genuinely disagree — an author deliberately
// changing material at a boundary, a wall meeting a doorway — are left exactly as they are. The seam
// pulls things together where they are still free to move, and never overrides a decision.
//
// Pure + deterministic: integer masks, fixed member order, dense-array iteration.

import type { Dir, FloorCorner } from './wall-tile.ts';
import { type Mask, template } from './wall-tile-field.ts';
import { type TileGrid, type Tx, inBounds, stamp } from './tile-grid.ts';
import type { FieldAt } from './tile-reach.ts';

/** Which cell of a tile a seam member refers to. */
export type Part =
  | { kind: 'inner'; dir: Dir }
  /** Owned edges only — N and W. A seam names a shared edge through the tile that OWNS it. */
  | { kind: 'edge'; dir: 'N' | 'W' }
  | { kind: 'floor'; corner: FloorCorner };

/** One cell, addressed by tile + part. */
export interface CellRef {
  x: number;
  y: number;
  part: Part;
}

export const innerRef = (x: number, y: number, dir: Dir): CellRef => ({ x, y, part: { kind: 'inner', dir } });
export const edgeRef = (x: number, y: number, dir: 'N' | 'W'): CellRef => ({ x, y, part: { kind: 'edge', dir } });
export const floorRef = (x: number, y: number, corner: FloorCorner): CellRef => ({ x, y, part: { kind: 'floor', corner } });

/** Read a member's current domain, or null if the tile is out of bounds / conflicted. */
export function readPart(at: FieldAt, r: CellRef): Mask | null {
  const f = at(r.x, r.y);
  if (!f) return null;
  if (r.part.kind === 'inner') return f.inner[r.part.dir];
  if (r.part.kind === 'edge') return f.edge[r.part.dir];
  return f.floor[r.part.corner];
}

/** Stage a narrowing of one member to `m` (an ordinary `andGate`, like every other stamp). */
export function stampPart(tx: Tx, r: CellRef, m: Mask): void {
  const spec: Parameters<typeof template>[0] = {};
  if (r.part.kind === 'inner') spec.inner = { [r.part.dir]: m } as Partial<Record<Dir, Mask>>;
  else if (r.part.kind === 'edge') spec.edge = { [r.part.dir]: m } as Partial<Record<'N' | 'W', Mask>>;
  else spec.floor = { [r.part.corner]: m } as Partial<Record<FloorCorner, Mask>>;
  stamp(tx, { x: r.x, y: r.y, w: 1, h: 1 }, template(spec));
}

/* ------------------------------- the two seams ------------------------------- */

/**
 * The CROSS seam east or south of tile (x,y) — the three cells of the wall line crossing that
 * boundary, in physical order (A's inner half, the shared edge, B's inner half).
 *
 * Only E and S are enumerated: the seam west of a tile IS the seam east of its west neighbour, so
 * taking both directions from every tile would double-count. Returns null at the map border, where
 * there is no second tile and the boundary is the perimeter shell.
 */
export function crossSeam(g: TileGrid, x: number, y: number, d: 'E' | 'S'): CellRef[] | null {
  const nx = d === 'E' ? x + 1 : x;
  const ny = d === 'S' ? y + 1 : y;
  if (!inBounds(g, x, y) || !inBounds(g, nx, ny)) return null;
  return d === 'E'
    ? [innerRef(x, y, 'E'), edgeRef(nx, ny, 'W'), innerRef(nx, ny, 'W')]
    : [innerRef(x, y, 'S'), edgeRef(nx, ny, 'N'), innerRef(nx, ny, 'N')];
}

/** Every cross seam on the grid, in a fixed (row-major, E-then-S) order. */
export function allCrossSeams(g: TileGrid): CellRef[][] {
  const out: CellRef[][] = [];
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      for (const d of ['E', 'S'] as const) {
        const s = crossSeam(g, x, y, d);
        if (s) out.push(s);
      }
    }
  }
  return out;
}

/**
 * The POINT seam at lattice point (cx, cy) — the floor quadrants of the (up to four) tiles meeting
 * there, in a fixed NW/NE/SW/SE order. Fewer than four members at a map border, which is correct:
 * there is simply less ground touching that point.
 */
export function pointSeam(g: TileGrid, cx: number, cy: number): CellRef[] {
  const cand: [number, number, FloorCorner][] = [
    [cx - 1, cy - 1, 'se'],
    [cx, cy - 1, 'sw'],
    [cx - 1, cy, 'ne'],
    [cx, cy, 'nw'],
  ];
  return cand.filter(([tx, ty]) => inBounds(g, tx, ty)).map(([tx, ty, c]) => floorRef(tx, ty, c));
}

/** Every point seam on the grid, row-major over the (w+1)×(h+1) lattice. */
export function allPointSeams(g: TileGrid): CellRef[][] {
  const out: CellRef[][] = [];
  for (let cy = 0; cy <= g.h; cy++) for (let cx = 0; cx <= g.w; cx++) out.push(pointSeam(g, cx, cy));
  return out;
}

/* ------------------------------- operations ------------------------------- */

/**
 * Pull a seam's members toward agreement: narrow each to the intersection of all of them — but ONLY
 * if that intersection is non-empty. An empty intersection means the members have genuinely been
 * decided differently, and that is the author's call, not ours; the seam is left untouched.
 *
 * Returns whether it cohered. Staged in the caller's transaction.
 */
export function cohere(tx: Tx, at: FieldAt, refs: readonly CellRef[]): boolean {
  if (refs.length < 2) return false;
  let both = -1;
  for (const r of refs) {
    const m = readPart(at, r);
    if (m === null) return false;
    both &= m;
  }
  if (both === 0) return false; // genuine disagreement — leave it alone
  for (const r of refs) stampPart(tx, r, both);
  return true;
}

/** Stage the whole seam at one value — the coherent way to place a wall, as opposed to setting one
 *  tile's arm and leaving its partner to settle to nothing (which is what produces stubs). */
export function stampSeam(tx: Tx, refs: readonly CellRef[], m: Mask): void {
  for (const r of refs) stampPart(tx, r, m);
}

/** Seams whose members can no longer agree — the split-across-tiles features that have drifted apart.
 *  A diagnostic, not an error: some disagreement is intentional (a doorway in a wall run, a material
 *  change at a room boundary). Useful as a test signal and for the editor to surface. */
export function seamDisagreements(g: TileGrid, at: FieldAt): { kind: 'cross' | 'point'; refs: CellRef[] }[] {
  const out: { kind: 'cross' | 'point'; refs: CellRef[] }[] = [];
  const check = (kind: 'cross' | 'point', refs: CellRef[]): void => {
    if (refs.length < 2) return;
    let both = -1;
    for (const r of refs) {
      const m = readPart(at, r);
      if (m === null) return;
      both &= m;
    }
    if (both === 0) out.push({ kind, refs });
  };
  for (const s of allCrossSeams(g)) check('cross', s);
  for (const s of allPointSeams(g)) check('point', s);
  return out;
}
