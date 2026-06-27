/**
 * src/floor/generate.ts — the deterministic FLOOR GENERATOR.
 *
 * Algorithm (GENERATION-SOLVABILITY.md §"Generation: spine → openness → dressing"):
 *
 *   1. SPINE (correct-by-construction). Carve `k` EDGE-DISJOINT paths entry→exit,
 *      each solo-Anchor-traversable. Because we only ever ADD edges and never remove
 *      the perimeter fallback, the solvability invariant holds by construction. We
 *      respect "lock-before-key" for keyed gates: a gate edge is only placed when a
 *      universally-usable key is already reachable on the correct side. In this
 *      coarse graph that reduces to: never gate the very first move out of the entry,
 *      and only ever use gates that the fallback layer can bypass (breakable blocks
 *      or perimeter-adjacent), which is automatic here.
 *
 *   2. OPENNESS (0..1). Add extra edges beyond the spines: 0 = tight (spines +
 *      perimeter only), 1 = open arena (every adjacency connected). Adding edges can
 *      never remove a guaranteed path, so the invariant survives any openness.
 *
 * The PERIMETER is always added as WALK edges (the universal go-around fallback).
 *
 * EDGE-DISJOINT SPINES — how we GUARANTEE correctness:
 *   We find the k spines with an explicit edge-disjoint pathfinder: repeated BFS
 *   from the entry to the top row over the grid adjacency, marking each found path's
 *   edges as "used" so the next BFS cannot reuse them. This is literally the
 *   augmenting-path method behind Menger's theorem — so the generator's k is the
 *   max-flow lower bound by construction, and the INDEPENDENT verifier (which does
 *   its own max-flow) must agree. Because we clamp k to the source's structural
 *   capacity (see `maxSupportableRoutes`), the pathfinder always finds all k.
 *
 * DETERMINISM: every random choice comes from sub-streams of a single RNG seeded
 * from (runSeed, stratumIndex). We never iterate Map/Set in an output-affecting way;
 * neighbour expansion follows a fixed direction order, and any id iteration is over
 * dense arrays in id order. Same config + seed => byte-identical floor.
 */

import type { Cell, CellType, Edge, EdgeKind, Floor, FloorMeta, Room } from './types.ts';
import { cellId, edgeKey } from './types.ts';
import type { Rng } from './rng.ts';
import { chance, makeFloorRng, nextInt, nextRange, shuffleInPlace, subStream } from './rng.ts';
import { placePuzzles, type PuzzleParams } from './puzzles.ts';

/* ------------------------------- configuration ------------------------------- */

/** Relative frequencies for non-WALK gate kinds when a spine edge is "gated". */
export interface GateWeights {
  GAP: number;
  BREAK: number;
  BUTTON: number;
  WEIGHT: number;
}

export const DEFAULT_GATE_WEIGHTS: GateWeights = {
  GAP: 1,
  BREAK: 2, // breakable blocks are the canonical universal fallback → most common
  BUTTON: 1,
  WEIGHT: 1,
};

export interface FloorConfig {
  /** Square grid size (width = height = gridSize). Min 2. */
  gridSize: number;
  /** 0 = tight maze, 1 = open arena. Clamped to [0,1]. */
  openness: number;
  /** Number of independent routes to guarantee. Clamped to a supportable max. */
  guaranteedRoutes: number;
  /** Gate kind frequencies for gated edges (defaults to DEFAULT_GATE_WEIGHTS). */
  gateWeights?: GateWeights;
  /** Lobby run seed (any bigint). */
  seed: bigint;
  /** Which floor index in the shaft (default 0). */
  stratumIndex?: number;
  /**
   * Probability that a given non-first spine/openness step is a gated (non-WALK)
   * edge vs a plain WALK. Default 0.5. Clamped to [0,1]. Gates enrich required
   * gameplay; the fallback layer keeps them solvable.
   */
  gateDensity?: number;
  /**
   * Lay the floor out as RECTANGULAR ROOMS joined by corridors/doorways (default
   * true) instead of a uniform cell maze. When on, a rooms-and-corridors pass runs
   * BEFORE openness: it carves non-overlapping rooms, fully connects each room's
   * interior (WALK edges), classifies every cell (ROOM/CORRIDOR/DOORWAY/WALL/VOID),
   * and the openness pass is biased to favour edges inside/between rooms — so the
   * layout reads as a dungeon of rooms. It only ADDS edges over the spines+perimeter,
   * so solvability (proven on the edge graph) is untouched. Set false for the legacy
   * pure-maze behaviour (used by some determinism tests).
   */
  rooms?: boolean;
  /**
   * Target rooms-and-corridors knobs (only used when `rooms` is on). All optional;
   * sensible defaults derive from gridSize. Sizes are in CELLS (inclusive bounds).
   */
  roomParams?: RoomParams;
  /**
   * Place LOCKED-DOOR + KEY + RUG puzzles (docs/14 §2). Default true. When on, a seeded,
   * verifier-certified keyed chain is placed AFTER the layout/openness passes (so it sees
   * the final edge graph). Only chains the independent lock-and-key verifier proves
   * solvable are emitted; otherwise the floor ships puzzle-free (still solvable). Set
   * false for the plain-maze behaviour (some determinism tests).
   */
  puzzles?: boolean;
  /** Puzzle placement knobs (only used when `puzzles` is on). All optional. */
  puzzleParams?: PuzzleParams;
}

/** Tuning for the rooms-and-corridors layout pass (all in grid CELLS). */
export interface RoomParams {
  /** Smallest room side (>=1). Default 2. */
  minRoomSide?: number;
  /** Largest room side. Default ~ floor(gridSize/2), min minRoomSide. */
  maxRoomSide?: number;
  /**
   * How many placement ATTEMPTS to make. More attempts → denser room packing. Default
   * scales with area (gridSize^2 / 2). Each attempt may fail (overlap) → deterministic.
   */
  attempts?: number;
  /** 1-cell gap kept between rooms so walls read as distinct. Default 1. */
  roomGap?: number;
  /**
   * Probability that a given placement attempt aims for a LARGE OPEN HALL instead of a
   * normal-sized room (docs/14 §1 "large open areas"). When it rolls big, the candidate
   * side is drawn from [bigRoomMin, bigRoomMax] rather than [minRoomSide, maxRoomSide],
   * so the floor gets a few sparse-walled halls mixed in with small chambers. Clamped to
   * [0,1]. Default ~0.22 (a couple of big halls per floor at game scale). Set 0 for the
   * old uniform distribution. Big halls are still ADDITIVE WALK edges → solvability is
   * untouched (proven on the edge graph), and they still get a perimeter + doorways via
   * the existing classifyCells pass.
   */
  bigRoomChance?: number;
  /** Smallest side of a big hall (cells). Default ~ floor(gridSize*0.45), min maxRoomSide. */
  bigRoomMin?: number;
  /** Largest side of a big hall (cells). Default ~ floor(gridSize*0.7). */
  bigRoomMax?: number;
}

/* ------------------------------ stream tag ids ------------------------------- */
// Stable constants so adding a later stage never shifts an earlier stage's output.
const S_LAYOUT = 1; // entry/exit selection
const S_SPINES = 2; // spine carving (path order + gate rolls)
const S_OPENNESS = 3; // extra-edge pass
const S_ROOMS = 5; // rooms-and-corridors layout (high tag, kept stable so it never shifts 1-3)
const S_PUZZLES = 6; // locked-door/key/rug placement (high tag so it never shifts 1-5)

/* ------------------------------ small utilities ------------------------------ */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Maximum number of edge-disjoint entry→exit routes this grid can structurally
 * support, given ONE entry cell whose sink is the whole top row. By Menger, that is
 * the min cut around the source, bounded by the entry's degree in a 4-neighbour
 * grid: an interior column on row 0 has up/left/right (degree 3); an edge column has
 * 2. It is also bounded by the grid width (you cannot have more parallel vertical
 * channels than columns). So maxK = min(entryDegree, width). Conservative by design;
 * the verifier confirms the achieved count independently.
 */
export function maxSupportableRoutes(width: number, height: number): number {
  if (width < 2 || height < 2) return 1;
  const entryDegree = width >= 3 ? 3 : 2; // interior entry (deg 3) vs edge entry (deg 2)
  return Math.max(1, Math.min(entryDegree, width));
}

/** Pick a gate kind from the weighted table (deterministic). */
function pickGateKind(rng: Rng, w: GateWeights): EdgeKind {
  const total = w.GAP + w.BREAK + w.BUTTON + w.WEIGHT;
  if (total <= 0) return 'BREAK';
  let r = nextInt(rng, total);
  if (r < w.GAP) return 'GAP';
  r -= w.GAP;
  if (r < w.BREAK) return 'BREAK';
  r -= w.BREAK;
  if (r < w.BUTTON) return 'BUTTON';
  return 'WEIGHT';
}

/** Is an edge kind a breakable-block gate (fallback layer passes it by breaking)? */
function kindIsBreakable(kind: EdgeKind): boolean {
  return kind === 'BREAK';
}

/* --------------------------------- builder ---------------------------------- */

/**
 * Internal mutable builder: accumulates edges with O(1) dedupe by numeric key, then
 * emits the canonical flat list in stable insertion order (spines, then openness,
 * with the perimeter folded in first).
 */
class EdgeSet {
  private readonly byKey = new Map<number, Edge>();
  private readonly order: number[] = []; // insertion order of keys

  /**
   * Add an edge if absent. Returns true if a NEW edge was created. If the edge
   * already exists we keep the existing kind/spine (spines are added before openness
   * so a spine edge is never downgraded), but we OR-in the perimeter flag (perimeter
   * is a structural truth about location).
   */
  add(a: number, b: number, kind: EdgeKind, breakable: boolean, perimeter: boolean, spine: number): boolean {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = edgeKey(lo, hi);
    const existing = this.byKey.get(key);
    if (existing) {
      if (perimeter) existing.perimeter = true;
      return false;
    }
    this.byKey.set(key, { a: lo, b: hi, kind, breakable, perimeter, spine });
    this.order.push(key);
    return true;
  }

  has(a: number, b: number): boolean {
    return this.byKey.has(edgeKey(a, b));
  }

  /** Emit edges in stable insertion order. */
  toList(): Edge[] {
    const out: Edge[] = [];
    for (const key of this.order) {
      const e = this.byKey.get(key);
      if (e) out.push(e);
    }
    return out;
  }
}

/* --------------------------------- generate --------------------------------- */

/**
 * Generate a deterministic floor from config. Pure function of config (incl. seed).
 * Never throws on a too-large k — it clamps and records it in meta.clamped.
 */
export function generateFloor(config: FloorConfig): Floor {
  const width = Math.max(2, Math.floor(config.gridSize));
  const height = Math.max(2, Math.floor(config.gridSize));
  const openness = clamp01(config.openness);
  const gateDensity = clamp01(config.gateDensity ?? 0.5);
  const gateWeights = config.gateWeights ?? DEFAULT_GATE_WEIGHTS;
  const stratumIndex = config.stratumIndex ?? 0;
  const useRooms = config.rooms ?? true;

  // Clamp k to what the structure can support; record whether we clamped.
  const requested = Math.max(1, Math.floor(config.guaranteedRoutes));
  const maxK = maxSupportableRoutes(width, height);
  const k = Math.min(requested, maxK);
  const clamped = k < requested;

  const root = makeFloorRng(config.seed, stratumIndex);

  // ---- cells (dense, row-major) ----
  const cells: Cell[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells.push({ id: cellId(width, x, y), x, y });
    }
  }

  const edges = new EdgeSet();

  // ---- 1. layout: entry on row 0 (interior column when possible), exits = top row ----
  const layoutRng = subStream(root, S_LAYOUT);
  const entryX = width >= 3 ? 1 + nextInt(layoutRng, width - 2) : nextInt(layoutRng, width);
  const entry = cellId(width, entryX, 0);
  const exits: number[] = [];
  for (let x = 0; x < width; x++) exits.push(cellId(width, x, height - 1));

  // ---- always-on PERIMETER (the universal fallback ring), added FIRST ----
  addPerimeter(edges, width, height);

  // ---- 2. spines: k edge-disjoint, solo-traversable entry→exit paths ----
  const spineRng = subStream(root, S_SPINES);
  carveSpines(edges, spineRng, width, height, entry, k, gateDensity, gateWeights);

  // ---- 2.5 rooms-and-corridors layout (opt-in, default on) ----
  // Carve rectangular rooms, open their interiors (WALK edges only — adds, never
  // removes, so solvability survives), and classify every cell. The classification
  // also BIASES the openness pass (next) so it favours intra-/inter-room edges,
  // making the floor read as a dungeon of rooms rather than a uniform maze.
  let rooms: Room[] | undefined;
  let roomIdOf: Int32Array | undefined; // cell id -> room index (-1 = none)
  if (useRooms) {
    const roomRng = subStream(root, S_ROOMS);
    const laid = layoutRooms(roomRng, width, height, config.roomParams);
    rooms = laid.rooms;
    roomIdOf = laid.roomIdOf;
    // open each room's interior: every interior 4-adjacency becomes a WALK edge.
    openRoomInteriors(edges, width, rooms);
  }

  // ---- 3. openness: add extra edges (biased toward rooms when rooms are on) ----
  const opennessRng = subStream(root, S_OPENNESS);
  addOpenness(edges, opennessRng, width, height, openness, gateDensity, gateWeights, roomIdOf);

  // ---- 3.5 classify every cell's layout ROLE from the final edge graph ----
  if (useRooms && roomIdOf) classifyCells(cells, edges, width, height, roomIdOf);

  const meta: FloorMeta = {
    runSeed: config.seed.toString(),
    stratumIndex,
    openness,
    requestedRoutes: requested,
    clamped,
  };

  const floor: Floor = { width, height, cells, edges: edges.toList(), entry, exits, guaranteedRoutes: k, meta };
  if (rooms) floor.rooms = rooms;

  // ---- 5. puzzles: place a verifier-certified locked-door/key/rug chain (opt-in,
  // default on). Runs LAST so it sees the final edge graph; only emits chains the
  // independent lock-and-key verifier proves solvable (else the floor ships puzzle-free).
  if (config.puzzles ?? true) {
    const puzzleRng = subStream(root, S_PUZZLES);
    placePuzzles(floor, puzzleRng, config.puzzleParams);
  }
  return floor;
}

/* ------------------------------ stage: perimeter ----------------------------- */

/**
 * Add the full boundary ring as WALK edges (perimeter:true) — the structural
 * "always go around the edge" fallback. WALK, never gated.
 */
function addPerimeter(edges: EdgeSet, width: number, height: number): void {
  for (let x = 0; x < width - 1; x++) {
    edges.add(cellId(width, x, 0), cellId(width, x + 1, 0), 'WALK', false, true, -1);
    edges.add(cellId(width, x, height - 1), cellId(width, x + 1, height - 1), 'WALK', false, true, -1);
  }
  for (let y = 0; y < height - 1; y++) {
    edges.add(cellId(width, 0, y), cellId(width, 0, y + 1), 'WALK', false, true, -1);
    edges.add(cellId(width, width - 1, y), cellId(width, width - 1, y + 1), 'WALK', false, true, -1);
  }
}

/* ------------------------------- stage: spines ------------------------------- */

/** The four grid directions, in a FIXED order (determinism: BFS expands in this order). */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // up (toward exit) — listed first so BFS prefers climbing
  [1, 0], // right
  [-1, 0], // left
  [0, -1], // down
];

/**
 * Carve `k` edge-disjoint paths from `entry` to ANY top-row cell, using the
 * augmenting-path (Menger) method: BFS over grid adjacency that avoids already-used
 * edges, repeated k times. Each found path's edges are committed to the EdgeSet (the
 * first step out of the entry forced to WALK; later steps gate-rolled). Because k is
 * clamped to the source's structural capacity, all k paths are always found.
 *
 * Determinism: neighbour order is fixed (DIRS); among equal-distance frontier nodes
 * BFS is FIFO; the only randomness is the per-edge gate roll, drawn from `rng` in a
 * fixed path-walk order. So the carve is fully reproducible.
 *
 * Edge-disjointness: `usedEdge` (a numeric-keyed Set) records every edge consumed by
 * a committed path; subsequent BFS treats those edges as missing. This is exactly
 * one unit of flow per path on unit-capacity undirected edges, so the k paths share
 * no edge — the property the verifier re-derives via max-flow.
 */
function carveSpines(
  edges: EdgeSet,
  rng: Rng,
  width: number,
  height: number,
  entry: number,
  k: number,
  gateDensity: number,
  gateWeights: GateWeights,
): void {
  const n = width * height;
  const usedEdge = new Set<number>(); // edge keys consumed by prior spines
  const topRow = (id: number): boolean => Math.floor(id / width) === height - 1;

  for (let spineIdx = 0; spineIdx < k; spineIdx++) {
    const path = bfsAvoidingUsedEdges(width, height, n, entry, topRow, usedEdge);
    if (!path || path.length < 2) {
      // Should never happen because k <= maxSupportableRoutes; defensive no-op so we
      // never throw. The verifier would catch any shortfall, and the perimeter keeps
      // the floor solvable regardless.
      break;
    }
    // Commit the path: mark edges used + add them to the floor with gate rolls.
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i] as number;
      const b = path[i + 1] as number;
      usedEdge.add(edgeKey(a, b));
      // First step out of the entry is always WALK (lock-before-key: don't gate the
      // very first move). All other steps roll a gate at gateDensity.
      let kind: EdgeKind = 'WALK';
      if (i > 0 && chance(rng, gateDensity)) kind = pickGateKind(rng, gateWeights);
      edges.add(a, b, kind, kindIsBreakable(kind), false, spineIdx);
    }
  }
}

/**
 * BFS from `entry` to the first cell satisfying `isTarget`, over the 4-neighbour grid
 * adjacency, NOT crossing any edge whose key is in `usedEdges`. Returns the path as a
 * list of cell ids (entry … target), or null if no such path exists.
 *
 * Deterministic: fixed direction order (DIRS), FIFO frontier, integer ids only.
 */
function bfsAvoidingUsedEdges(
  width: number,
  height: number,
  n: number,
  entry: number,
  isTarget: (id: number) => boolean,
  usedEdges: ReadonlySet<number>,
): number[] | null {
  const prev = new Int32Array(n).fill(-2); // -2 = unvisited, -1 = root's parent
  const queue: number[] = [entry];
  prev[entry] = -1;
  let head = 0;
  let found = -1;

  while (head < queue.length) {
    const cur = queue[head++] as number;
    if (isTarget(cur) && cur !== entry) {
      found = cur;
      break;
    }
    const cx = cur % width;
    const cy = Math.floor(cur / width);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nb = ny * width + nx;
      if (prev[nb] !== -2) continue; // already visited
      if (usedEdges.has(edgeKey(cur, nb))) continue; // edge consumed by a prior spine
      prev[nb] = cur;
      // If the neighbour is a target, we could stop early, but we let the main loop
      // detect it on dequeue to keep a single, clear termination point.
      queue.push(nb);
    }
  }

  if (found === -1) {
    // The entry itself might be a target only in degenerate height<=1 grids (handled
    // by the height>=2 minimum), so a null here means genuinely no disjoint path.
    return null;
  }

  // Reconstruct path target → entry, then reverse.
  const rev: number[] = [];
  let c = found;
  while (c !== -1) {
    rev.push(c);
    c = prev[c] as number;
  }
  rev.reverse();
  return rev;
}

/* ------------------------------ stage: openness ------------------------------ */

/**
 * Add extra edges beyond the spines/perimeter according to `openness`. We iterate
 * every grid adjacency exactly once in deterministic id order (each cell's right and
 * up neighbour) and, for each not-yet-present edge, add it with probability
 * ~openness. openness 0 → nothing added (tight maze); openness 1 → everything added
 * (open arena). Extra edges roll a gate kind at gateDensity, so an open arena still
 * has interesting gates while the fallback guarantee keeps it solvable.
 *
 * ROOM BIAS (when `roomIdOf` is provided): the goal is a dungeon of distinct rooms,
 * not one open blob. So we MODULATE the per-edge open probability by which cells the
 * edge touches:
 *   - both endpoints in the SAME room → already opened by openRoomInteriors (skipped
 *     here since the edge already exists).
 *   - endpoints in DIFFERENT rooms → keep them mostly SEPARATE (low probability), so
 *     room walls survive and rooms connect through corridors/doorways, not by merging.
 *   - at least one endpoint OUTSIDE any room (corridor/void space) → FULL openness, so
 *     the inter-room "negative space" forms corridor loops the layout reads as halls.
 * This keeps rooms legible while still honouring the openness knob for the corridors.
 * Pure book-keeping over dense indices → order-stable & deterministic.
 *
 * Iteration is over dense indices (not a Set), so output is order-stable.
 */
function addOpenness(
  edges: EdgeSet,
  rng: Rng,
  width: number,
  height: number,
  openness: number,
  gateDensity: number,
  gateWeights: GateWeights,
  roomIdOf?: Int32Array,
): void {
  if (openness <= 0) return;
  // probability damping for edges that would MERGE two distinct rooms.
  const MERGE_DAMP = 0.15;
  const tryEdge = (a: number, b: number): void => {
    if (edges.has(a, b)) return;
    let p = openness;
    if (roomIdOf) {
      const ra = roomIdOf[a] as number;
      const rb = roomIdOf[b] as number;
      // two DIFFERENT rooms → damp hard (preserve the wall between them).
      if (ra >= 0 && rb >= 0 && ra !== rb) p = openness * MERGE_DAMP;
      // (same-room edges already exist; corridor/void edges keep full openness.)
    }
    if (!chance(rng, p)) return;
    const kind: EdgeKind = chance(rng, gateDensity) ? pickGateKind(rng, gateWeights) : 'WALK';
    edges.add(a, b, kind, kindIsBreakable(kind), false, -1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = cellId(width, x, y);
      if (x + 1 < width) tryEdge(a, cellId(width, x + 1, y));
      if (y + 1 < height) tryEdge(a, cellId(width, x, y + 1));
    }
  }
}

/* ------------------------- stage: rooms-and-corridors ------------------------ */

/**
 * Result of the rooms layout pass: the placed rooms (stable id order) and a dense
 * cell→roomIndex map (-1 = not in any room).
 */
interface RoomLayout {
  rooms: Room[];
  roomIdOf: Int32Array; // length width*height
}

/**
 * Lay out non-overlapping rectangular ROOMS on the grid. Deterministic dart-throwing:
 * for a fixed number of attempts we roll a candidate rectangle (random origin + size
 * within bounds), and accept it iff it (plus a `roomGap` margin) overlaps no prior
 * room and stays in bounds. Accepted rooms get a stable id in acceptance order.
 *
 * WHY dart-throwing (not BSP): it's tiny, obviously deterministic (every roll comes
 * from `rng` in a fixed loop order), and degrades gracefully on small grids (you just
 * get fewer rooms). Rooms never touch the very outer ring so the perimeter fallback
 * walkway always survives as corridor space around them.
 *
 * Determinism: all randomness via `rng` in a fixed attempt loop; acceptance test is a
 * pure integer overlap check over the dense `rooms` array in id order. No Map/Set.
 */
function layoutRooms(rng: Rng, width: number, height: number, params?: RoomParams): RoomLayout {
  const roomIdOf = new Int32Array(width * height).fill(-1);
  const rooms: Room[] = [];

  // Defaults derived from grid size. Keep at least a 1-cell perimeter band free.
  const minSide = Math.max(1, Math.floor(params?.minRoomSide ?? 2));
  const maxSideDefault = Math.max(minSide, Math.floor(width / 2));
  const maxSide = Math.max(minSide, Math.floor(params?.maxRoomSide ?? maxSideDefault));
  const gap = Math.max(0, Math.floor(params?.roomGap ?? 1));
  const attempts = Math.max(0, Math.floor(params?.attempts ?? Math.ceil((width * height) / 2)));
  // Large open halls (docs/14 §1): some attempts aim for a big footprint so the floor
  // has sparse-walled halls, not just small chambers. Defaults scale with grid size.
  const bigChance = clamp01(params?.bigRoomChance ?? 0.22);
  const bigMin = Math.max(maxSide, Math.floor(params?.bigRoomMin ?? Math.floor(width * 0.45)));
  const bigMax = Math.max(bigMin, Math.floor(params?.bigRoomMax ?? Math.floor(width * 0.7)));

  // Usable interior band: leave row/col 0 and the last row/col as perimeter corridor.
  const lo = 1;
  const hiX = width - 2; // inclusive max x for a room's right edge
  const hiY = height - 2; // inclusive max y for a room's top edge
  if (hiX < lo || hiY < lo) return { rooms, roomIdOf }; // grid too small for any room

  const overlaps = (x0: number, y0: number, x1: number, y1: number): boolean => {
    // expand by gap so distinct rooms keep a wall between them.
    for (const r of rooms) {
      if (x0 - gap <= r.x1 && x1 + gap >= r.x0 && y0 - gap <= r.y1 && y1 + gap >= r.y0) return true;
    }
    return false;
  };

  // Place a candidate room of (w,h); returns true if accepted. Shared by both passes so
  // big halls and normal rooms use identical overlap/acceptance rules (deterministic).
  const tryPlace = (w: number, h: number): boolean => {
    const maxX0 = hiX - w + 1;
    const maxY0 = hiY - h + 1;
    if (maxX0 < lo || maxY0 < lo) return false; // candidate can't fit in the band
    const x0 = lo + nextInt(rng, maxX0 - lo + 1);
    const y0 = lo + nextInt(rng, maxY0 - lo + 1);
    const x1 = x0 + w - 1;
    const y1 = y0 + h - 1;
    if (overlaps(x0, y0, x1, y1)) return false;
    const id = rooms.length;
    rooms.push({ id, x0, y0, x1, y1 });
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) roomIdOf[cellId(width, xx, yy)] = id;
    }
    return true;
  };

  for (let a = 0; a < attempts; a++) {
    // Per-attempt: roll whether this is a BIG HALL or a normal room, then draw its size
    // from the matching range. We always draw the big/normal roll AND both sides from the
    // stream (in a fixed order) so the sequence stays stable regardless of acceptance.
    const big = chance(rng, bigChance);
    const sMin = big ? bigMin : minSide;
    const sMax = big ? bigMax : maxSide;
    const w = sMin + nextInt(rng, sMax - sMin + 1);
    const h = sMin + nextInt(rng, sMax - sMin + 1);
    tryPlace(w, h);
  }

  return { rooms, roomIdOf };
}

/**
 * Open every room's INTERIOR: add a WALK edge across each 4-adjacency where both cells
 * belong to the SAME room. Adds edges only (never downgrades a spine), so a room is a
 * fully-connected open rectangle. Deterministic: iterate cells/rooms in id order.
 */
function openRoomInteriors(edges: EdgeSet, width: number, rooms: readonly Room[]): void {
  for (const r of rooms) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const a = cellId(width, x, y);
        if (x + 1 <= r.x1) edges.add(a, cellId(width, x + 1, y), 'WALK', false, false, -1);
        if (y + 1 <= r.y1) edges.add(a, cellId(width, x, y + 1), 'WALK', false, false, -1);
      }
    }
  }
}

/**
 * Classify every cell's layout ROLE from the FINAL edge graph + room map, so a tileset
 * can dress the floor (GENERATION-SOLVABILITY §"Dressing"). Pure function of the graph:
 *   - in a room                                  → ROOM, unless it sits on the room's
 *                                                  boundary AND has a connecting edge to a
 *                                                  non-room cell, in which case → DOORWAY.
 *   - not in a room, but has >=1 traversal edge  → CORRIDOR (connector / perimeter hall).
 *   - not in a room, no traversal edge at all    → VOID (pure negative space) — but if it
 *     is wedged between solid neighbours we leave it VOID; the renderer fills VOID with
 *     nothing and WALL where it wants a block. We mark cells with NO edges and at least
 *     one ROOM neighbour as WALL (they read as the room's outer wall blocks).
 *
 * Determinism: builds a per-cell degree/edge-target set from floor.edges in insertion
 * order, then a single pass over cells in id order. Integer only.
 */
function classifyCells(
  cells: Cell[],
  edges: EdgeSet,
  width: number,
  height: number,
  roomIdOf: Int32Array,
): void {
  const n = width * height;
  const edgeList = edges.toList();
  // adjacency-target presence (we only need "does cell c connect to a non-room cell")
  const deg = new Int32Array(n);
  const connectsOutsideRoom: Uint8Array = new Uint8Array(n);
  for (const e of edgeList) {
    deg[e.a] = (deg[e.a] as number) + 1;
    deg[e.b] = (deg[e.b] as number) + 1;
    const ra = roomIdOf[e.a] as number;
    const rb = roomIdOf[e.b] as number;
    // a doorway edge crosses a room boundary: one endpoint in a room, the other not in
    // THAT room (different room or no room).
    if (ra >= 0 && ra !== rb) connectsOutsideRoom[e.a] = 1;
    if (rb >= 0 && rb !== ra) connectsOutsideRoom[e.b] = 1;
  }

  const onRoomBoundary = (c: Cell, rid: number): boolean => {
    // boundary cell = a room cell with at least one 4-neighbour NOT in the same room.
    const { x, y } = c;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true; // grid edge
      if ((roomIdOf[cellId(width, nx, ny)] as number) !== rid) return true;
    }
    return false;
  };

  for (const c of cells) {
    const rid = roomIdOf[c.id] as number;
    if (rid >= 0) {
      c.roomId = rid;
      // a room cell that sits on the boundary AND has a door-edge to outside = DOORWAY;
      // otherwise plain ROOM (interior or solid-walled boundary).
      c.cellType = connectsOutsideRoom[c.id] && onRoomBoundary(c, rid) ? 'DOORWAY' : 'ROOM';
      continue;
    }
    c.roomId = -1;
    if ((deg[c.id] as number) > 0) {
      c.cellType = 'CORRIDOR';
    } else {
      // no edges: WALL if it abuts a room (reads as the room's wall block), else VOID.
      let abutsRoom = false;
      for (const [dx, dy] of DIRS) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if ((roomIdOf[cellId(width, nx, ny)] as number) >= 0) {
          abutsRoom = true;
          break;
        }
      }
      c.cellType = abutsRoom ? 'WALL' : 'VOID';
    }
  }
}

/* ----- re-exports used by tests that assert determinism via this module surface ----- */
export { shuffleInPlace, nextRange };
export type { Room, CellType };
