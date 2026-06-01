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
 *   3. DRESSING HOOK. Tag each cell with a coarse chunkType id (no geometry yet).
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

import type { Cell, Edge, EdgeKind, Floor, FloorMeta } from './types.ts';
import { cellId, edgeKey } from './types.ts';
import type { Rng } from './rng.ts';
import { chance, makeFloorRng, nextInt, nextRange, shuffleInPlace, subStream } from './rng.ts';

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
  /** How many distinct chunk-type ids to tag cells with (>=1, default 4). */
  chunkTypeCount?: number;
}

/* ------------------------------ stream tag ids ------------------------------- */
// Stable constants so adding a later stage never shifts an earlier stage's output.
const S_LAYOUT = 1; // entry/exit selection
const S_SPINES = 2; // spine carving (path order + gate rolls)
const S_OPENNESS = 3; // extra-edge pass
const S_DRESS = 4; // chunk tagging

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
  const chunkTypeCount = Math.max(1, Math.floor(config.chunkTypeCount ?? 4));

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
      cells.push({ id: cellId(width, x, y), x, y, chunkType: 0 });
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

  // ---- 3. openness: add extra edges ----
  const opennessRng = subStream(root, S_OPENNESS);
  addOpenness(edges, opennessRng, width, height, openness, gateDensity, gateWeights);

  // ---- 4. dressing hook: tag each cell with a chunk-type id ----
  const dressRng = subStream(root, S_DRESS);
  for (const c of cells) c.chunkType = nextInt(dressRng, chunkTypeCount);

  const meta: FloorMeta = {
    runSeed: config.seed.toString(),
    stratumIndex,
    openness,
    requestedRoutes: requested,
    clamped,
  };

  return { width, height, cells, edges: edges.toList(), entry, exits, guaranteedRoutes: k, meta };
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
): void {
  if (openness <= 0) return;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = cellId(width, x, y);
      if (x + 1 < width) {
        const b = cellId(width, x + 1, y);
        if (!edges.has(a, b) && chance(rng, openness)) {
          const kind: EdgeKind = chance(rng, gateDensity) ? pickGateKind(rng, gateWeights) : 'WALK';
          edges.add(a, b, kind, kindIsBreakable(kind), false, -1);
        }
      }
      if (y + 1 < height) {
        const b = cellId(width, x, y + 1);
        if (!edges.has(a, b) && chance(rng, openness)) {
          const kind: EdgeKind = chance(rng, gateDensity) ? pickGateKind(rng, gateWeights) : 'WALK';
          edges.add(a, b, kind, kindIsBreakable(kind), false, -1);
        }
      }
    }
  }
}

/* ----- re-exports used by tests that assert determinism via this module surface ----- */
export { shuffleInPlace, nextRange };
