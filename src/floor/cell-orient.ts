// ============================================================================
// src/floor/cell-orient.ts — rotate and flip a structure.
// ============================================================================
//
// Eight orientations per authored structure (4 quarter-turns × mirrored or not), so a catalog of N
// pieces places as 8N without anyone drawing more.
//
// THIS IS NOT A PERMUTATION OF CELLS. A structure's fields describe things that live on the LATTICE,
// not inside a cell — `wallN` is the edge running east from a POINT, `wallW` the edge running south
// from it, `corner` the junction AT it. Only `floor` belongs to a cell. Rotating turns an east-running
// edge into a south-running one and carries a corner to a different point, so a per-cell field swap
// would put walls on the wrong axis and drop corners.
//
// SYMMETRY IS WHAT MAKES IT LOSSLESS. A structure is stored on the POINT lattice — (w+1)×(h+1) entries
// for a w×h floor — so it owns all four of its border walls. Store only w×h and a rotation pushes the
// north and west walls onto sides no entry can own and they vanish: four quarter-turns stopped being
// the identity, and border corners disappeared outright. That is exactly how this was found.
//
// Pure + deterministic: integer coordinate arithmetic only.

import { fullField, type CellField } from './cell-field.ts';
import { abstainUnowned, levelSize, levelsOf, stride, type CellStructure } from './cell-structures.ts';

/** Quarter-turns clockwise. */
export type Turn = 0 | 1 | 2 | 3;

export interface Orientation {
  turn: Turn;
  /** Mirror across the vertical axis, applied BEFORE the turn. */
  flip: boolean;
}

/** All eight, in a fixed order — index it, never iterate a Set. */
export const ORIENTATIONS: readonly Orientation[] = [
  { turn: 0, flip: false }, { turn: 1, flip: false }, { turn: 2, flip: false }, { turn: 3, flip: false },
  { turn: 0, flip: true }, { turn: 1, flip: true }, { turn: 2, flip: true }, { turn: 3, flip: true },
];

/** The FLOOR extent after orienting: an odd number of quarter-turns swaps the axes. */
export const orientedSize = (w: number, h: number, o: Orientation): { w: number; h: number } =>
  o.turn % 2 === 1 ? { w: h, h: w } : { w, h };

/**
 * Map a lattice POINT of a w×h structure. Points run [0..w]×[0..h] — one more than the floor cells in
 * each axis — and that lattice IS the stored grid.
 */
export function mapPoint(px: number, py: number, w: number, h: number, o: Orientation): { x: number; y: number } {
  let x = o.flip ? w - px : px;
  let y = py;
  let cw = w, ch = h;
  for (let t = 0; t < o.turn; t++) {
    const nx = ch - y, ny = x; // 90° clockwise about the lattice
    x = nx; y = ny;
    const swap = cw; cw = ch; ch = swap;
  }
  return { x, y };
}

/** Map a floor CELL. A cell is the square south-east of its point, so a flip or turn has to account
 *  for that extent — which is why this is not the same formula as `mapPoint`. */
export function mapCell(cx: number, cy: number, w: number, h: number, o: Orientation): { x: number; y: number } {
  let x = o.flip ? w - 1 - cx : cx;
  let y = cy;
  let cw = w, ch = h;
  for (let t = 0; t < o.turn; t++) {
    const nx = ch - 1 - y, ny = x;
    x = nx; y = ny;
    const swap = cw; cw = ch; ch = swap;
  }
  return { x, y };
}

/** Where an edge lands: which point owns it, and which axis it now runs along. `null` if it falls
 *  outside the destination lattice. */
function homeEdge(
  a: { x: number; y: number }, b: { x: number; y: number }, sw: number, sh: number,
): { x: number; y: number; side: 'N' | 'W' } | null {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  if (x < 0 || y < 0 || x >= sw || y >= sh) return null;
  // an edge is owned by its lower-coordinate endpoint; horizontal ⇒ wallN, vertical ⇒ wallW
  return { x, y, side: a.y === b.y ? 'N' : 'W' };
}

/**
 * The structure, turned and/or mirrored. Every edge and corner is re-homed to the point that owns it
 * after the transform, so the result is well-formed by construction rather than by bookkeeping.
 */
export function orientStructure(raw: CellStructure, o: Orientation): CellStructure {
  const st: CellStructure = { ...raw, cells: abstainUnowned(raw.cells, raw.w, raw.h) };
  const { w: nw, h: nh } = orientedSize(st.w, st.h, o);
  const srcStride = stride(st), dstStride = nw + 1;
  // Turning and mirroring happen about the VERTICAL axis, so no level ever mixes with another — each
  // is transformed on its own and they keep their order.
  const n = levelsOf(st), srcLevel = levelSize(st), dstLevel = dstStride * (nh + 1);
  const cells: CellField[] = Array.from({ length: dstLevel * n }, fullField);

  for (let lv = 0; lv < n; lv++) {
  for (let py = 0; py <= st.h; py++) {
    for (let px = 0; px <= st.w; px++) {
      const f = st.cells[lv * srcLevel + py * srcStride + px]!;

      // EDGES — transform both endpoints, then re-home. wallN runs east, wallW runs south.
      const runs: [number, [number, number]][] = [
        [f.wallN, [px + 1, py]],
        [f.wallW, [px, py + 1]],
      ];
      const from = mapPoint(px, py, st.w, st.h, o);
      for (const [mask, [qx, qy]] of runs) {
        if (qx > st.w || qy > st.h) continue; // no such edge on the source lattice
        const to = mapPoint(qx, qy, st.w, st.h, o);
        const home = homeEdge(from, to, nw + 1, nh + 1);
        if (!home) continue;
        const dest = cells[lv * dstLevel + home.y * dstStride + home.x]!;
        if (home.side === 'N') dest.wallN = mask; else dest.wallW = mask;
      }

      // CORNER, WALLTYPE, OPEN, TORCH — properties of the POINT, so they travel with it.
      // Miss one and `orient(identity)` stops being the identity, which is how this is caught.
      if (from.x >= 0 && from.x <= nw && from.y >= 0 && from.y <= nh) {
        const dest = cells[lv * dstLevel + from.y * dstStride + from.x]!;
        dest.corner = f.corner;
        dest.wallType = f.wallType;
        dest.open = f.open;
        dest.torch = f.torch;
      }
    }
  }

  // FLOOR — the one field that belongs to a CELL
  for (let cy = 0; cy < st.h; cy++) {
    for (let cx = 0; cx < st.w; cx++) {
      const c = mapCell(cx, cy, st.w, st.h, o);
      cells[lv * dstLevel + c.y * dstStride + c.x]!.floor = st.cells[lv * srcLevel + cy * srcStride + cx]!.floor;
    }
  }
  }

  /* Unowned slots were never written above, so they are still `fullField` — which is exactly the
     storage form. Normalising the INPUT too is what makes identity a strict no-op regardless of how
     the source was saved. */
  return {
    w: nw, h: nh,
    ...(n > 1 ? { levels: n } : {}),
    cells: abstainUnowned(cells, nw, nh),
    ...(st.from !== undefined ? { from: st.from } : {}),
  };
}
