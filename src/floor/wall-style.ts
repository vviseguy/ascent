/**
 * src/floor/wall-style.ts — the ② STYLE layer.
 *
 *      ⓪ PROGRAM ─▶ ① BLUEPRINT ─▶ ② STYLE ─▶ Placement[] ─▶ ③ { render, collision }
 *                                  ^^^^^^^^^ this file
 *
 * A swappable Strategy that turns a structural `Blueprint` (where walls MUST / MAY / MUST-NOT be)
 * into a flat, coordinate-free list of `Placement[]` — one PIECE + VARIANT per wall square, plus
 * DOORWAY placements for the real gaps in a wall line. This is the ONLY layer where aesthetics
 * live: the piece SHAPE is auto-tiled from the square's wall-neighbours (pure structure), and the
 * VARIANT is chosen from a seeded integer hash (the only entropy source).
 *
 * DETERMINISM (CLAUDE.md): pure + deterministic. We walk squares in ascending lattice index, the
 * output order is therefore fixed, no `Math.random`, no Map/Set iteration. Same (blueprint, seed)
 * ⇒ byte-identical `Placement[]`.
 */

import type { Blueprint, Placement, PieceKind, SquareClass, Variant } from './wall-model.ts';
import { DIR_E, DIR_W, DIR_N, DIR_S, classAt, roleAt, sqIndex } from './wall-model.ts';

/* ----------------------------------- the Strategy ----------------------------------- */

/** A swappable wall-realisation strategy: blueprint + seed ⇒ flat placement list. */
export interface WallStyle {
  realize(bp: Blueprint, seed: bigint): Placement[];
}

/**
 * Pick a named style. For now there is only the DefaultStyle (realises every WALL and
 * WALL_POSSIBLE square, doorways for wall gaps, PLAIN/BROKEN variants). Later styles
 * (e.g. "ruined", "gated") slot in behind the same interface keyed by `id`.
 */
export function makeStyle(_id?: string): WallStyle {
  return new DefaultStyle();
}

/* ----------------------------------- helpers ----------------------------------- */

/** Does this class count as "a wall is here" for junction classification? */
function isWallClass(c: SquareClass): boolean {
  return c === 'WALL' || c === 'WALL_POSSIBLE';
}

/** popcount of a 4-bit direction mask. */
function popcount4(m: number): number {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
}

/**
 * Deterministic integer hash of (seed, col, row) → unsigned 32-bit. xorshift/imul mix; no floats,
 * no Math.random. Used ONLY for variant selection, so aesthetics are reproducible from the seed.
 */
function h(seed: bigint, col: number, row: number): number {
  // Fold the 64-ish-bit seed into 32 bits, then avalanche with the coords.
  let x = (Number(seed & 0xffffffffn) ^ Number((seed >> 32n) & 0xffffffffn)) >>> 0;
  x = (x ^ (col + 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (row + 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}

/* ----------------------------------- DefaultStyle ----------------------------------- */

/**
 * The Phase-1 default styler. Realises EVERY wall square (WALL and WALL_POSSIBLE) as a piece, and
 * every wall-gap OPEN lane as a DOORWAY. Variants: WALL_POSSIBLE squares are BROKEN ~30% of the
 * time (seeded), everything else PLAIN.
 */
class DefaultStyle implements WallStyle {
  realize(bp: Blueprint, seed: bigint): Placement[] {
    const out: Placement[] = [];

    // Ascending lattice index → deterministic output order (row-major).
    for (let row = 0; row < bp.bh; row++) {
      for (let col = 0; col < bp.bw; col++) {
        const cls = bp.cells[sqIndex(bp, col, row)]!;
        const role = roleAt(col, row);

        if (isWallClass(cls)) {
          if (role === 'CORNER') {
            out.push(this.junction(bp, seed, col, row, cls));
          } else if (role === 'LANE') {
            out.push(this.laneStraight(seed, col, row, cls));
          }
          // role === 'CELL' that is somehow a wall: a CELL square is a floor interior; we do not
          // emit a piece for it (walls own LANE/CORNER squares only).
        } else if (cls === 'OPEN' && role === 'LANE') {
          // A doorway is an OPEN lane that is a GAP IN A WALL LINE: its two COLLINEAR neighbours
          // (along the lane's wall axis) are both wall. OPEN lanes inside a room → nothing.
          const door = this.doorwayIfGap(bp, col, row);
          if (door !== null) out.push(door);
        }
      }
    }

    return out;
  }

  /**
   * A CORNER square (even,even): classify the junction from its 4 distance-1 LANE neighbours and
   * emit the matching piece. n = number of wall sides.
   */
  private junction(bp: Blueprint, seed: bigint, col: number, row: number, cls: SquareClass): Placement {
    let dirs = 0;
    if (isWallClass(classAt(bp, col + 1, row))) dirs |= DIR_E;
    if (isWallClass(classAt(bp, col - 1, row))) dirs |= DIR_W;
    if (isWallClass(classAt(bp, col, row + 1))) dirs |= DIR_N;
    if (isWallClass(classAt(bp, col, row - 1))) dirs |= DIR_S;

    const n = popcount4(dirs);
    const variant = this.wallVariant(seed, col, row, cls);

    if (n === 0) {
      // No adjoining wall lanes → a free-standing column.
      return { piece: 'PILLAR', variant, col, row, span: 1, axis: 'X', dirs, doorId: -1 };
    }
    if (n === 1) {
      return { piece: 'CAP', variant, col, row, span: 1, axis: 'X', dirs, doorId: -1 };
    }
    if (n === 2) {
      const ew = (dirs & DIR_E) !== 0 && (dirs & DIR_W) !== 0;
      const ns = (dirs & DIR_N) !== 0 && (dirs & DIR_S) !== 0;
      if (ew || ns) {
        // Collinear pair → a straight run passes THROUGH this corner. Emit a STRAIGHT (axis along
        // the run, dirs cleared to 0 since it is a run segment, not a junction).
        return { piece: 'STRAIGHT', variant, col, row, span: 1, axis: ew ? 'X' : 'Z', dirs: 0, doorId: -1 };
      }
      // Perpendicular pair → an L corner.
      return { piece: 'CORNER', variant, col, row, span: 1, axis: 'X', dirs, doorId: -1 };
    }
    if (n === 3) {
      return { piece: 'TEE', variant, col, row, span: 1, axis: 'X', dirs, doorId: -1 };
    }
    // n === 4
    return { piece: 'CROSS', variant, col, row, span: 1, axis: 'X', dirs, doorId: -1 };
  }

  /**
   * A LANE wall square: a STRAIGHT run segment. axis = 'X' for a horizontal lane (odd col, even
   * row → wall runs east/west), 'Z' for a vertical lane (even col, odd row → runs north/south).
   *
   * TODO (Phase 2 — "full where it fits"): collinear STRAIGHT span-1 LANE pieces could be MERGED
   * into span-2 full-4u wall pieces where two pair up. Phase 1 keeps every straight square as its
   * own span-1 piece; merging is intentionally NOT implemented here.
   */
  private laneStraight(seed: bigint, col: number, row: number, cls: SquareClass): Placement {
    const horizontal = col % 2 === 1; // odd col, even row → horizontal lane
    const variant = this.wallVariant(seed, col, row, cls);
    return { piece: 'STRAIGHT', variant, col, row, span: 1, axis: horizontal ? 'X' : 'Z', dirs: 0, doorId: -1 };
  }

  /**
   * If the OPEN LANE at (col,row) is a gap in a wall line, return its DOORWAY placement; else null.
   * Horizontal lane (odd col) is a doorway when its E & W neighbours are both wall; vertical lane
   * (even col) when its N & S neighbours are both wall.
   */
  private doorwayIfGap(bp: Blueprint, col: number, row: number): Placement | null {
    const horizontal = col % 2 === 1; // odd col, even row → horizontal lane (axis X)
    let gap: boolean;
    if (horizontal) {
      gap = isWallClass(classAt(bp, col + 1, row)) && isWallClass(classAt(bp, col - 1, row));
    } else {
      gap = isWallClass(classAt(bp, col, row + 1)) && isWallClass(classAt(bp, col, row - 1));
    }
    if (!gap) return null;
    // DOORWAY variant is PLAIN for DefaultStyle (a later style may pick ARCHED/GATED). doorId -1:
    // the projection layer attaches the real LockedDoor id later.
    return { piece: 'DOORWAY', variant: 'PLAIN', col, row, span: 1, axis: horizontal ? 'X' : 'Z', dirs: 0, doorId: -1 };
  }

  /**
   * The variant for a WALL/WALL_POSSIBLE wall square: WALL_POSSIBLE → BROKEN ~30% (seeded), else
   * PLAIN. WALL squares are always PLAIN in DefaultStyle.
   */
  private wallVariant(seed: bigint, col: number, row: number, cls: SquareClass): Variant {
    if (cls === 'WALL_POSSIBLE' && h(seed, col, row) % 100 < 30) return 'BROKEN';
    return 'PLAIN';
  }
}

/** Re-export the piece kind union for convenience (consumers often want both). */
export type { PieceKind };
