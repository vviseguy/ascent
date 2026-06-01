/**
 * src/floor/types.ts — the FLOOR data model (plain, serializable graph data).
 *
 * This is the "one data structure" the generator produces and the verifier
 * consumes. It is intentionally a coarse CELL GRID whose adjacent cells are joined
 * by TRAVERSAL EDGES (GENERATION-SOLVABILITY.md §"Generation"). The model is the
 * minimal graph needed to PROVE solvability; authored chunk geometry is layered on
 * later and is out of scope here (we only tag each cell with a chunk-type hook).
 *
 * DESIGN PRINCIPLES
 *  - Plain data only: no classes-with-behavior, no methods. Everything is a struct
 *    of numbers/strings/arrays so a floor is trivially serializable, structurally
 *    cloneable for a worker boundary, and easy to hash. Behavior (build / verify)
 *    lives in separate modules that take a Floor as input.
 *  - Stable IDs: cells are identified by a deterministic integer index derived from
 *    grid coordinates (`cellId = y * width + x`). Edges are stored in a flat list
 *    with stable insertion order. We NEVER rely on Map/Set iteration order for any
 *    output-affecting decision (CONVENTIONS); where we iterate we sort ids first.
 *
 * COORDINATE CONVENTION
 *  - The grid is `width` (x, columns) by `height` (y, rows). y grows "up" toward the
 *    exit band; the ENTRY cell sits on row 0 (bottom band) and EXIT cell(s) on row
 *    `height-1` (top band). This matches the shaft's +Y = up = progress axis.
 */

/**
 * How a traversal edge between two adjacent cells is crossed. These mirror the
 * spec's edge tags (GENERATION-SOLVABILITY.md §"Generation"):
 *  - WALK   : free walk-through, no gate. Always passable by anyone.
 *  - GAP    : a jump/gap that must be crossed (Runner faster; everyone can via
 *             fallback). A timed/fancy gate from the fallback-layer's perspective.
 *  - BREAK  : a breakable block stands in the way (anyone can break it eventually;
 *             Breaker instant). The FALLBACK LAYER treats this as passable.
 *  - BUTTON : a button/held-door gate (held by weight). Treated as passable in the
 *             fallback layer (you can always hold a button with your own weight, or
 *             go around / break through).
 *  - WEIGHT : a weight-sensitive gate (e.g. weighted plate). Same fallback logic.
 *
 * IMPORTANT for the verifier: only WALK is "unconditionally free". GAP / BUTTON /
 * WEIGHT are timed/fancy gates that the spec permits on main routes; BREAK is a
 * breakable block. The fallback-layer graph treats breakable blocks as passable
 * and always includes the perimeter, which is what guarantees solvability
 * regardless of how the timed gates are tuned (GENERATION-SOLVABILITY.md
 * §"The FALLBACK LAYER").
 */
export type EdgeKind = 'WALK' | 'GAP' | 'BREAK' | 'BUTTON' | 'WEIGHT';

/** All edge kinds, ordered (stable iteration where a list is needed). */
export const EDGE_KINDS: readonly EdgeKind[] = ['WALK', 'GAP', 'BREAK', 'BUTTON', 'WEIGHT'];

/**
 * A traversal edge between two adjacent cells. Undirected for traversal purposes
 * (you can cross a floor edge either way in the fallback layer), stored once with
 * `a < b` by cellId for a canonical, dedupe-friendly representation.
 */
export interface Edge {
  /** Endpoint cell id (always the smaller id). */
  a: number;
  /** Endpoint cell id (always the larger id). */
  b: number;
  /** How this edge is crossed (see EdgeKind). */
  kind: EdgeKind;
  /**
   * Whether the blocker on this edge is breakable. For BREAK edges this is true by
   * construction. The spec's invariant is "every block is EVENTUALLY breakable",
   * so in practice all non-WALK gates are at least bypassable; this flag lets the
   * verifier's fallback layer know the edge is passable-by-breaking even if some
   * future content marks a gate as NOT-the-block-itself. WALK edges are not
   * "breakable" (nothing to break) but are trivially passable.
   */
  breakable: boolean;
  /**
   * True if this edge lies on the floor PERIMETER. The perimeter is always walkable
   * (the universal go-around-the-edge fallback). The verifier guarantees these are
   * in the fallback layer regardless of `kind`.
   */
  perimeter: boolean;
  /**
   * Which guaranteed spine (route index, 0..k-1) carved this edge, or -1 if the
   * edge was added by the openness pass / perimeter. Purely informational (helps
   * debugging + lets the generator self-count); the INDEPENDENT verifier ignores
   * it and recomputes route count from scratch via max-flow.
   */
  spine: number;
}

/**
 * Per-cell data. A cell is a coarse room-chunk slot. Behaviorless struct.
 */
export interface Cell {
  /** Stable id = y * width + x. */
  id: number;
  /** Grid column [0, width). */
  x: number;
  /** Grid row [0, height); 0 = entry band, height-1 = exit band. */
  y: number;
  /**
   * Authored-chunk hook: a coarse chunk-type id used later by dressing to pick
   * furniture matching this cell's edge tags. Generation only TAGS it; no geometry
   * is produced here. Stable small integer; meaning defined by the dressing layer.
   */
  chunkType: number;
}

/**
 * The finished FLOOR. Pure data. Both the generator (producer) and the verifier
 * (consumer) speak only this type — the verifier knows nothing else about how the
 * floor was built, which is the whole point of an independent proof.
 */
export interface Floor {
  /** Grid width (columns, x). */
  width: number;
  /** Grid height (rows, y). */
  height: number;
  /**
   * All cells, indexed by id (cells[id].id === id). Dense array of length
   * width*height in row-major (y-major) order. Plain array, not a Map, so iteration
   * order is the deterministic id order.
   */
  cells: Cell[];
  /**
   * All traversal edges, flat list in stable insertion order (spines first, then
   * openness additions, then perimeter). Undirected, canonical a<b.
   */
  edges: Edge[];
  /** The single entry cell id (bottom band). */
  entry: number;
  /**
   * The exit (up-route) cell ids (top band). One or more. Reaching ANY of these
   * from `entry` via the fallback layer = solvable.
   */
  exits: number[];
  /**
   * The number of independent routes the GENERATOR claims to have guaranteed
   * (after any clamping — see generate.ts). The verifier recomputes this number
   * independently via max-flow and must agree (flow >= this value). Stored so the
   * proof can cross-check the two methods.
   */
  guaranteedRoutes: number;
  /**
   * Echo of the config seed/index for reproducibility & debugging. Not used by the
   * verifier's logic, but printed in any failure repro.
   */
  meta: FloorMeta;
}

/** Reproducibility metadata carried on the floor (for repro printing). */
export interface FloorMeta {
  runSeed: string; // bigint serialized as decimal string (serializable boundary)
  stratumIndex: number;
  openness: number;
  requestedRoutes: number; // what the caller asked for (pre-clamp)
  clamped: boolean; // true if requestedRoutes was reduced to fit the grid
}

/* ----------------------------- coordinate helpers ----------------------------- */

/** Compute the stable cell id for grid coordinates. */
export function cellId(width: number, x: number, y: number): number {
  return y * width + x;
}

/** Decode a cell id back to {x, y}. */
export function cellXY(width: number, id: number): { x: number; y: number } {
  return { x: id % width, y: Math.floor(id / width) };
}

/**
 * Canonical undirected edge key as a single safe integer: min*BIG + max. Used for
 * O(1) dedupe in a numeric-keyed set/map without depending on string formatting.
 * BIG must exceed any cellId; width*height <= a few thousand, so 1e7 is ample and
 * stays well inside Number.MAX_SAFE_INTEGER.
 */
const EDGE_KEY_BASE = 10_000_000;
export function edgeKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * EDGE_KEY_BASE + hi;
}
