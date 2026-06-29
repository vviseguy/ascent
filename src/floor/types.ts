/**
 * src/floor/types.ts — the FLOOR data model (plain, serializable graph data).
 *
 * This is the "one data structure" the generator produces and the verifier
 * consumes. It is intentionally a coarse CELL GRID whose adjacent cells are joined
 * by TRAVERSAL EDGES (GENERATION-SOLVABILITY.md §"Generation"). The model is the
 * minimal graph needed to PROVE solvability; authored wall/room geometry is layered
 * on later and is out of scope here (a cell only carries its layout role + room id).
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
 * Coarse ROLE a cell plays in the laid-out floor, so a tileset (e.g. KayKit dungeon)
 * can map onto the grid: open ROOM interiors, CORRIDOR links between them, structural
 * WALL/VOID cells the layout leaves un-roomed, and DOORWAY cells that punch the opening
 * between a room and its corridor. This is a LAYOUT classification — distinct from the
 * traversal `EdgeKind` (which is about how a seam is crossed). It is purely additive:
 * solvability still rides on the edge graph; the cell role only tells the renderer what
 * to dress a cell as.
 *
 *  - ROOM    : interior of a rectangular room → drop a floor tile, walls auto-placed on
 *              edges that face VOID/WALL (see `wallMask` helpers in tower.ts).
 *  - CORRIDOR: a 1-wide connector cell between rooms / to the perimeter → narrow floor.
 *  - DOORWAY : a cell on a room's boundary where a corridor pierces the wall → an opening
 *              (place a doorway/arch tile; no wall on the pierced edge).
 *  - WALL    : a solid, un-roomed structural cell (renders as a wall block / rubble).
 *  - VOID    : empty, outside any room or corridor (no floor tile; pure negative space).
 *
 * EVERY cell still exists in the grid and still has its traversal edges — VOID/WALL cells
 * are just *dressed* as not-walkable-room; the fallback layer (perimeter + breakables)
 * keeps the floor solvable regardless of this cosmetic role. So adding room classification
 * can never make a floor unsolvable.
 */
export type CellType = 'ROOM' | 'CORRIDOR' | 'DOORWAY' | 'WALL' | 'VOID';

/** All cell types, ordered (stable iteration / index mapping). */
export const CELL_TYPES: readonly CellType[] = ['ROOM', 'CORRIDOR', 'DOORWAY', 'WALL', 'VOID'];

/**
 * Where a KEY is obtained on the floor (docs/14 §2). Two deterministic sources:
 *  - LOOSE : the key sits as a Pickup body on the floor → obtainable the moment its
 *            cell is REACHED.
 *  - RUG   : the key is hidden under a movable RUG → obtainable once the rug's cell is
 *            reached AND the player interacts with the rug (which reveals the pickup).
 *            For solvability the two collapse to the same condition: "reachable cell ⇒
 *            obtainable key" (interacting a reachable rug is always possible), so the
 *            verifier treats both identically; the distinction is purely the spawn shape.
 */
export type KeySource = 'LOOSE' | 'RUG';

/** All key sources, ordered (stable iteration). */
export const KEY_SOURCES: readonly KeySource[] = ['LOOSE', 'RUG'];

/**
 * A LOCKED DOOR placed on a traversal edge (docs/14 §2). Passing the edge requires the
 * KEY whose `doorId` matches. The door GATES the edge in BOTH directions until opened.
 * Stored on the Floor (additive); the compiler spawns a solid Door body in the doorway
 * and the verifier models the edge as traversable only when `doorId` is held.
 *
 * Canonical `a < b` like Edge, so a door is matched to its edge unambiguously. A door's
 * edge MUST be a real traversal edge in `Floor.edges` (the placer guarantees this); the
 * verifier looks the edge up to know which two cells the lock separates.
 */
export interface LockedDoor {
  /** Endpoint cell id (smaller). */
  a: number;
  /** Endpoint cell id (larger). */
  b: number;
  /** The lock id (>= 0). The matching key carries the same id. Unique per floor. */
  doorId: number;
}

/**
 * A KEY placed on the floor (docs/14 §2). Opens the door whose `doorId` matches; sits at
 * `cell` and is obtained per `source`. The verifier models it as: once `cell` is in the
 * reachable set, the key `doorId` is acquired (which may unlock a door and open more of
 * the floor — the lock-and-key fixpoint).
 */
export interface KeyItem {
  /** Cell id the key is obtained at. */
  cell: number;
  /** The door id this key opens (>= 0; matches a LockedDoor.doorId). */
  doorId: number;
  /** How the key is obtained (LOOSE pickup vs hidden under a RUG). */
  source: KeySource;
}

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
   * Layout ROLE of this cell (see CellType) — which room/corridor/wall/void slot it
   * fills. OPTIONAL & purely cosmetic-for-routing: the generator now always sets it
   * (rooms-and-corridors pass), but a hand-built / legacy Floor may omit it, in which
   * case consumers should treat the cell as ROOM (the permissive default). Solvability
   * is proven on the edge graph and never reads this field.
   */
  cellType?: CellType;
  /**
   * Index of the ROOM this cell belongs to (into Floor.rooms), or -1 if the cell is a
   * corridor/wall/void not inside a room. Optional for the same back-compat reason as
   * `cellType`. Lets the renderer group a room's cells (one floor mesh, shared theme).
   */
  roomId?: number;
}

/**
 * A laid-out rectangular ROOM in grid coordinates (inclusive bounds). The generator's
 * rooms pass carves these; the renderer can place one floor slab + a wall ring with
 * doorway gaps per room. Purely additive layout data — the traversal graph is what the
 * verifier proves on. Rooms never overlap and always lie inside the grid.
 */
export interface Room {
  /** Stable index into Floor.rooms (also stored on member cells as roomId). */
  id: number;
  /** Inclusive min column. */
  x0: number;
  /** Inclusive min row. */
  y0: number;
  /** Inclusive max column. */
  x1: number;
  /** Inclusive max row. */
  y1: number;
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
  /**
   * The rectangular rooms the layout carved (rooms-and-corridors pass), in stable id
   * order. OPTIONAL & additive: legacy/hand-built floors omit it. Member cells carry
   * `roomId` back-references. The renderer uses these to place room floor slabs + wall
   * rings; the verifier ignores them entirely.
   */
  rooms?: Room[];
  /**
   * LOCKED DOORS placed on traversal edges (docs/14 §2), in stable doorId order.
   * OPTIONAL & additive: a floor with no puzzles omits it. Each gates its edge until the
   * matching KEY is held. The lock-and-key verifier (verify.ts) re-derives solvability
   * from these + `keys` independently of the placer. The compiler spawns a Door body per
   * entry; the base reachability/route-count proofs ignore them (a stricter, separate
   * lock-and-key check models them).
   */
  lockedDoors?: LockedDoor[];
  /**
   * KEYS placed on the floor (docs/14 §2), in stable order. OPTIONAL & additive. Each is
   * obtained once its `cell` is reachable and unlocks its `doorId`. The verifier's
   * lock-and-key fixpoint floods reachability, collects reachable keys, unlocks their
   * doors, and repeats until the exit is reachable (SOLVABLE) or no progress (UNSOLVABLE).
   */
  keys?: KeyItem[];
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
