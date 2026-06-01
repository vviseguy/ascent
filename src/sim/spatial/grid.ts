// ============================================================================
// src/sim/spatial/grid.ts — uniform spatial hash grid (the default SpatialIndex).
// ============================================================================
//
// A uniform grid over the ground plane (x,z). Chosen over a quadtree for the first
// implementation because (ENGINE-ARCHITECTURE.md "OPEN TRADEOFF"):
//   - It is simpler and MORE obviously deterministic: cell index is pure integer
//     arithmetic on a body's position; there is no tree balancing or subdivision
//     order to get wrong.
//   - For our AoI-bounded entity counts (tens of bodies near one Anchor) on
//     bounded floors, a flat grid is fast and allocation-light.
//   - It is rebuilt every tick from scratch (derived state), so there is no
//     incremental-update complexity.
// If profiling on high-openness "open arena" floors ever shows the grid struggling
// with clustered density, the SpatialIndex interface lets us swap in a quadtree
// without touching any consumer.
//
// DETERMINISM:
//   - Cell coordinates come from integer floor-division of the raw Q16.16 position
//     by a raw cell size — exact integer math, identical on every engine.
//   - Bodies are inserted in ascending id order; each cell's id list is therefore
//     already ascending, so range queries that concatenate cells then the caller
//     can keep ascending order with a final merge/sort-free scan. We DO a final
//     sort on query output to be safe against multi-cell concatenation order, using
//     numeric ascending compare (stable + deterministic).
//   - The pair walk visits cells in a fixed (cy-major, cx-minor) order and within
//     a cell visits ascending-id pairs.
// ============================================================================

import { type WorldState, BodyFlag } from '../world/state.ts';
import { ONE_RAW, idivFloor, type Fixed, toRaw, fromFloatConst } from '../fixed/fixed.ts';
import type { SpatialIndex } from './index.ts';

/** Default cell size in meters; converted to a raw Q16.16 once. */
const DEFAULT_CELL_M = 2;

/** Encode signed cell coords into one integer key (offset to stay non-negative). */
const CELL_OFFSET = 1 << 15; // supports cell coords in [-32768, 32767]
const CELL_STRIDE = 1 << 16;
function cellKey(cx: number, cz: number): number {
  return (cx + CELL_OFFSET) * CELL_STRIDE + (cz + CELL_OFFSET);
}

export class GridIndex implements SpatialIndex {
  /** Raw Q16.16 cell size. */
  private readonly cellRaw: number;
  /** cellKey → ascending list of body ids. Rebuilt each tick. */
  private cells = new Map<number, number[]>();
  /** Parallel snapshot of positions for the bodies we indexed (by id), for queries. */
  private px = new Int32Array(0);
  private pz = new Int32Array(0);
  private radius = new Int32Array(0);
  private alive = new Uint8Array(0);
  /** Sorted list of occupied cell keys (deterministic pair-walk order). */
  private occupied: number[] = [];
  private count = 0;

  constructor(cellSize: Fixed = fromFloatConst(DEFAULT_CELL_M)) {
    this.cellRaw = toRaw(cellSize);
  }

  private cx(rawX: number): number {
    return idivFloor(rawX, this.cellRaw);
  }

  rebuild(w: WorldState): void {
    this.cells.clear();
    this.occupied.length = 0;
    this.count = w.count;
    if (this.px.length < w.count) {
      this.px = new Int32Array(w.count);
      this.pz = new Int32Array(w.count);
      this.radius = new Int32Array(w.count);
      this.alive = new Uint8Array(w.count);
    }
    for (let i = 0; i < w.count; i++) {
      const isAlive = (w.flags[i]! & BodyFlag.Alive) !== 0;
      this.alive[i] = isAlive ? 1 : 0;
      if (!isAlive) continue;
      this.px[i] = w.px[i]!;
      this.pz[i] = w.pz[i]!;
      this.radius[i] = w.radius[i]!;
      const key = cellKey(this.cx(w.px[i]!), this.cx(w.pz[i]!));
      let list = this.cells.get(key);
      if (!list) {
        list = [];
        this.cells.set(key, list);
      }
      list.push(i); // ascending id by construction (we sweep i ascending)
    }
    // Deterministic occupied-cell order for the pair walk.
    this.occupied = Array.from(this.cells.keys()).sort((a, b) => a - b);
  }

  queryRadius(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    const minCx = this.cx(x - r);
    const maxCx = this.cx(x + r);
    const minCz = this.cx(z - r);
    const maxCz = this.cx(z + r);
    const r2 = mulRaw(r, r);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) {
          const dx = this.px[id]! - x;
          const dz = this.pz[id]! - z;
          if (mulRaw(dx, dx) + mulRaw(dz, dz) <= r2) out.push(id);
        }
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const minCx = this.cx(minX);
    const maxCx = this.cx(maxX);
    const minCz = this.cx(minZ);
    const maxCz = this.cx(maxZ);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const id of list) {
          const x = this.px[id]!;
          const z = this.pz[id]!;
          if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) out.push(id);
        }
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  eachCandidatePair(cb: (a: number, b: number) => void): void {
    // For each occupied cell (ascending key), test pairs within the cell and pairs
    // with the forward neighbour cells (E, N, NE, NW) so each unordered pair across
    // a cell boundary is visited exactly once. We then ensure a<b before calling cb.
    for (const key of this.occupied) {
      const list = this.cells.get(key)!;
      // within-cell pairs (ascending i<j → ascending ids since list is ascending)
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) cb(list[i]!, list[j]!);
      }
      // decode key back to coords for neighbour lookups
      const cx = Math.floor(key / CELL_STRIDE) - CELL_OFFSET;
      const cz = (key % CELL_STRIDE) - CELL_OFFSET;
      // forward neighbours only (avoid double-visiting boundary pairs)
      const NEIGH: ReadonlyArray<readonly [number, number]> = [
        [1, 0], // E
        [0, 1], // N
        [1, 1], // NE
        [-1, 1], // NW
      ];
      for (const [dx, dz] of NEIGH) {
        const other = this.cells.get(cellKey(cx + dx, cz + dz));
        if (!other) continue;
        for (const a of list) for (const b of other) emitOrdered(a, b, cb);
      }
    }
  }
}

/** Emit a pair with a<b regardless of source order (deterministic dedupe of order). */
function emitOrdered(a: number, b: number, cb: (a: number, b: number) => void): void {
  if (a < b) cb(a, b);
  else if (b < a) cb(b, a);
}

/**
 * Multiply two RAW Q16.16 values and return a RAW Q16.16 result, used for squared
 * distances in the index. Mirrors fixed.mul's decomposition to stay < 2^53. We keep
 * a local copy (rather than importing mul + wrapping in Fixed) to avoid churn of
 * branding on the hot query path; the math is identical.
 */
function mulRaw(a: number, b: number): number {
  const ah = Math.floor(a / ONE_RAW);
  const al = a - ah * ONE_RAW;
  return ah * b + idivFloor(al * b, ONE_RAW);
}
