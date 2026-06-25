/**
 * src/floor/verify.ts — the INDEPENDENT VERIFIER (the anti-laziness centerpiece).
 *
 * This module knows NOTHING about how a floor was generated. It takes a finished
 * `Floor` (plain data) and PROVES solvability from first principles, using graph
 * algorithms that share no code path with the generator. The generator and this
 * verifier compute route-count by DIFFERENT methods and must agree — that
 * disagreement-detection is the whole value of an independent proof
 * (GENERATION-SOLVABILITY.md §"The VERIFIER").
 *
 * THE FALLBACK-LAYER GRAPH (the one graph this verifier reasons about):
 *   The spec guarantees solvability not by keeping main routes simple but by a
 *   universal worst-case fallback that always exists (GENERATION-SOLVABILITY.md
 *   §"The FALLBACK LAYER"):
 *     (a) every breakable block is EVENTUALLY passable (anyone can break through),
 *     (b) players can ALWAYS walk the perimeter.
 *   So the fallback layer = the traversal graph with every breakable block treated
 *   as passable + the perimeter route included. In THIS coarse model, every edge is
 *   ultimately passable in the fallback layer:
 *     - WALK            → free.
 *     - BREAK           → passable by breaking (breakable).
 *     - GAP/BUTTON/WEIGHT → these are timed/fancy gates on the FAST routes, but the
 *       fallback guarantee says you can always (slowly) break through or walk the
 *       edge. Per the invariant "every block is EVENTUALLY breakable", the worst
 *       case for any gate is "break the wall next to it / go around", so for a
 *       STATIC reachability proof every traversal edge is a fallback-passable
 *       connection. The perimeter is explicitly always-walkable.
 *
 *   Therefore the fallback layer treats ALL traversal edges as undirected passable
 *   connections. This is exactly the spec's "pure static graph reachability" check —
 *   no temporal reasoning — which makes catastrophic unsolvability structurally
 *   impossible regardless of how timed gates are tuned.
 *
 *   (We keep the per-edge `breakable`/`kind` data so a STRICTER future verifier
 *   could distinguish "fast route only" vs "fallback"; `reachability` below exposes
 *   an option to restrict to strictly-free edges for that stricter analysis, but the
 *   default — and the solvability guarantee — uses the full fallback layer.)
 *
 * DETERMINISM: pure, integer/graph only. No floats affect results. We iterate cells
 * and edges in id/insertion order (never Map/Set iteration) so results are stable.
 */

import type { Edge, Floor, KeyItem, LockedDoor } from './types.ts';
import { edgeKey } from './types.ts';

/* ------------------------------- adjacency build ----------------------------- */

/**
 * Build an undirected adjacency list (cellId → neighbour cellIds) over the FALLBACK
 * LAYER. By default every traversal edge is included (fallback-passable). If
 * `strictFreeOnly` is set, only WALK edges and perimeter edges are included — this
 * models the pessimistic "no gate can ever be crossed" layer, used by stricter
 * analyses/tests; it is NOT the solvability layer.
 *
 * Neighbour lists are sorted ascending for deterministic traversal order.
 */
function buildAdjacency(floor: Floor, strictFreeOnly: boolean): number[][] {
  const n = floor.width * floor.height;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of floor.edges) {
    if (strictFreeOnly && e.kind !== 'WALK' && !e.perimeter) continue;
    // a and b are valid cell ids by construction; guard anyway for safety.
    if (e.a < 0 || e.a >= n || e.b < 0 || e.b >= n) continue;
    (adj[e.a] as number[]).push(e.b);
    (adj[e.b] as number[]).push(e.a);
  }
  for (const list of adj) list.sort((p, q) => p - q);
  return adj;
}

/* --------------------------------- reachability ------------------------------ */

export interface ReachabilityResult {
  /** True iff at least one exit is reachable from entry via the fallback layer. */
  reachable: boolean;
  /** Exit cell ids that ARE reachable (sorted asc). */
  reachedExits: number[];
  /** Total number of cells reachable from entry (diagnostic). */
  reachedCount: number;
  /** The entry cell id (echoed for clarity). */
  entry: number;
}

/**
 * Flood-fill (BFS) from entry over the fallback layer; assert ≥1 exit reachable.
 * This is the core "is this floor solvable at all?" proof. Returns a clear result
 * object rather than throwing, so callers (tests, the runtime safety net) can decide
 * what to do.
 *
 * `strictFreeOnly` (default false) restricts to WALK/perimeter edges — a pessimistic
 * lower bound, NOT the solvability layer. Solvability is judged on the full fallback
 * layer (strictFreeOnly=false).
 */
export function reachability(floor: Floor, strictFreeOnly = false): ReachabilityResult {
  const adj = buildAdjacency(floor, strictFreeOnly);
  const n = adj.length;
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  let head = 0;

  const start = floor.entry;
  if (start >= 0 && start < n) {
    seen[start] = 1;
    queue.push(start);
  }
  while (head < queue.length) {
    const cur = queue[head++] as number;
    for (const nb of adj[cur] as number[]) {
      if (!seen[nb]) {
        seen[nb] = 1;
        queue.push(nb);
      }
    }
  }

  // Determine reachable exits (iterate the sorted exits list → deterministic).
  const reachedExits: number[] = [];
  for (const ex of floor.exits) {
    if (ex >= 0 && ex < n && seen[ex]) reachedExits.push(ex);
  }
  reachedExits.sort((p, q) => p - q);

  let reachedCount = 0;
  for (let i = 0; i < n; i++) if (seen[i]) reachedCount++;

  return {
    reachable: reachedExits.length > 0,
    reachedExits,
    reachedCount,
    entry: start,
  };
}

/* ------------------------------ max-flow route count ------------------------- */

/**
 * Count INDEPENDENT (edge-disjoint) routes entry→exits via max-flow with
 * unit-capacity edges. By Menger's theorem the maximum number of edge-disjoint
 * paths between two vertices equals the min cut, which equals the max flow when
 * every edge has capacity 1. We add a SUPER-SINK connected from every exit with
 * unit-capacity arcs so "any exit counts" and routes are disjoint up to the cut.
 *
 * WHY this differs from the generator's count: the generator carves k spines and
 * trusts geometry; this verifier ignores all that and measures the actual min-cut of
 * the finished graph. If they ever disagree, the proof has caught a bug.
 *
 * Algorithm: Edmonds–Karp (BFS-augmenting-path max-flow) on a residual graph built
 * from the UNDIRECTED fallback layer. Each undirected traversal edge {a,b} becomes a
 * pair of directed arcs a→b and b→a, EACH with capacity 1, sharing residual via the
 * standard reverse-edge bookkeeping. Edge-disjointness for undirected graphs is the
 * standard reduction: model each undirected edge as two opposite unit arcs; the
 * resulting max-flow equals the number of edge-disjoint undirected paths.
 *
 * Determinism: BFS uses a plain array queue and integer ids; neighbour exploration
 * follows insertion order of the arc list, which is derived from floor.edges
 * insertion order → fully deterministic. No floats.
 */
export interface RouteCountResult {
  /** Number of edge-disjoint entry→exit routes (max-flow value). */
  routes: number;
  /** The k the generator claimed; routes>=claimed must hold for a valid floor. */
  claimed: number;
  /** Convenience: routes >= claimed. */
  meetsClaim: boolean;
}

/** A directed residual arc. */
interface Arc {
  to: number;
  cap: number;
  /** Index of the paired reverse arc in the destination's arc list. */
  rev: number;
}

export function countRoutes(floor: Floor): RouteCountResult {
  const n = floor.width * floor.height;
  const SINK = n; // super-sink node id
  const numNodes = n + 1;

  const graph: Arc[][] = Array.from({ length: numNodes }, () => []);

  const addArc = (from: number, to: number, cap: number): void => {
    const a: Arc = { to, cap, rev: (graph[to] as Arc[]).length };
    const b: Arc = { to: from, cap: 0, rev: (graph[from] as Arc[]).length };
    (graph[from] as Arc[]).push(a);
    (graph[to] as Arc[]).push(b);
  };

  // Undirected traversal edge {u,v} → two opposite unit arcs (standard undirected
  // edge-disjoint-paths reduction). We add u→v(cap1) with reverse v→u(cap0) AND
  // v→u(cap1) with reverse u→v(cap0). Net effect: one unit of flow may cross the
  // edge in either direction, exactly once — matching edge-disjoint undirected paths.
  for (const e of floor.edges as Edge[]) {
    if (e.a < 0 || e.a >= n || e.b < 0 || e.b >= n) continue;
    addArc(e.a, e.b, 1);
    addArc(e.b, e.a, 1);
  }

  // Every exit → SINK with unit capacity, so total flow = number of disjoint routes
  // that reach ANY exit (the exits collectively act as one super-sink, but each
  // exit can carry at most one of the disjoint routes through its own arc; that is
  // the correct model since reaching a distinct exit is one route).
  // Iterate sorted unique exits for determinism.
  const uniqueExits = Array.from(new Set(floor.exits)).sort((p, q) => p - q);
  for (const ex of uniqueExits) {
    if (ex >= 0 && ex < n) addArc(ex, SINK, 1);
  }

  const SOURCE = floor.entry;
  if (SOURCE < 0 || SOURCE >= n) {
    return { routes: 0, claimed: floor.guaranteedRoutes, meetsClaim: floor.guaranteedRoutes <= 0 };
  }

  // Edmonds–Karp: repeatedly BFS for an augmenting path of residual capacity.
  let flow = 0;
  for (;;) {
    // BFS to find shortest augmenting path; record the arc used to reach each node.
    const parentNode = new Int32Array(numNodes).fill(-1);
    const parentArc = new Int32Array(numNodes).fill(-1);
    parentNode[SOURCE] = SOURCE;
    const queue: number[] = [SOURCE];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++] as number;
      if (u === SINK) break;
      const arcs = graph[u] as Arc[];
      for (let i = 0; i < arcs.length; i++) {
        const arc = arcs[i] as Arc;
        if (arc.cap > 0 && parentNode[arc.to] === -1) {
          parentNode[arc.to] = u;
          parentArc[arc.to] = i;
          queue.push(arc.to);
        }
      }
    }
    if (parentNode[SINK] === -1) break; // no augmenting path → done

    // All unit capacities ⇒ each augmenting path pushes exactly 1 unit. Walk back
    // from SINK to SOURCE, decrement forward arcs, increment reverse arcs.
    let v = SINK;
    while (v !== SOURCE) {
      const u = parentNode[v] as number;
      const ai = parentArc[v] as number;
      const arc = (graph[u] as Arc[])[ai] as Arc;
      arc.cap -= 1;
      ((graph[arc.to] as Arc[])[arc.rev] as Arc).cap += 1;
      v = u;
    }
    flow += 1;
  }

  return {
    routes: flow,
    claimed: floor.guaranteedRoutes,
    meetsClaim: flow >= floor.guaranteedRoutes,
  };
}

/* --------------------------------- full verify ------------------------------- */

export interface VerifyResult {
  ok: boolean;
  reachability: ReachabilityResult;
  routeCount: RouteCountResult;
  /** Lock-and-key solvability (always present; trivial when the floor has no puzzles). */
  lockKey: LockKeyResult;
  /** Human-readable failure reasons (empty when ok). */
  failures: string[];
}

/**
 * Full independent verification of a floor:
 *   1. reachability: ≥1 exit reachable from entry via the fallback layer (ignores locks).
 *   2. countRoutes: edge-disjoint route count ≥ the generator's claimed k.
 *   3. lock-and-key: with locked doors as HARD gates, the keys can be acquired in
 *      dependency order to reach an exit (docs/14 §3). For a puzzle-free floor this is
 *      equivalent to (1); for a keyed floor it is the binding solvability proof.
 * Returns a structured result; `ok` is true only if all hold.
 */
export function verifyFloor(floor: Floor): VerifyResult {
  const reach = reachability(floor, false);
  const routes = countRoutes(floor);
  const lockKey = lockKeyReachable(floor);
  const failures: string[] = [];
  if (!reach.reachable) {
    failures.push(
      `UNREACHABLE: no exit reachable from entry ${floor.entry} (reached ${reach.reachedCount}/${floor.width * floor.height} cells)`,
    );
  }
  if (!routes.meetsClaim) {
    failures.push(
      `INSUFFICIENT_ROUTES: found ${routes.routes} edge-disjoint routes, generator claimed ${routes.claimed}`,
    );
  }
  if (!lockKey.solvable) {
    failures.push(
      `LOCKED_OUT: lock-and-key fixpoint cannot reach an exit (reached ${lockKey.reachedCount} cells, acquired keys [${lockKey.keysAcquired.join(',')}])`,
    );
  }
  return { ok: failures.length === 0, reachability: reach, routeCount: routes, lockKey, failures };
}

/* ----------------------- lock-and-key reachability (docs/14 §3) --------------- */
//
// THE PUZZLE-SOLVABILITY PROOF. The base verifier above proves connectivity ignoring
// puzzle gates. This one adds STATE: locked doors are HARD gates (not bypassable by the
// fallback layer — a designed lock is not a breakable block), so the floor is solvable
// only if the player can ACQUIRE the keys in dependency order. We model the floor as a
// state machine and run a fixpoint:
//
//   state = (reachable-cell-set, keys-held)
//   1. from entry, flood every edge that is OPEN (not gated by a still-locked door),
//      growing the reachable set.
//   2. collect every key whose cell is now reachable → add its doorId to keys-held.
//   3. unlocking those doors opens new edges → GOTO 1.
//   repeat until a full pass adds nothing. SOLVABLE iff an exit is reachable at the
//   fixpoint; UNSOLVABLE otherwise (no progress and no exit).
//
// This is BFS-over-reachability-with-keys. It is INDEPENDENT of the placer: it re-derives
// everything from the compiled edges + the placed doors/keys, sharing no "trust me" state.
// Pure integer/graph; no floats, no Map iteration on output paths (we key door lookups by
// the numeric edgeKey, used for membership only, and iterate cells/keys/doors in id order).

/** Result of the lock-and-key solvability proof. */
export interface LockKeyResult {
  /** True iff an exit is reachable once keys are acquired in dependency order. */
  solvable: boolean;
  /** Exit cell ids reachable at the fixpoint (sorted asc). */
  reachedExits: number[];
  /** doorIds the player can acquire keys for + open (sorted asc) — diagnostic. */
  keysAcquired: number[];
  /** Total reachable cells at the fixpoint (diagnostic). */
  reachedCount: number;
  /** Number of fixpoint iterations run (diagnostic). */
  iterations: number;
}

/**
 * Build the per-edge door map: numeric edgeKey → doorId for every locked door. Used for
 * O(1) "is this edge gated, and by which door?" lookups. Membership/lookup only (never
 * iterated for output), so it introduces no determinism hazard.
 */
function buildDoorMap(doors: readonly LockedDoor[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const d of doors) m.set(edgeKey(d.a, d.b), d.doorId);
  return m;
}

/**
 * Lock-and-key solvability of a floor (docs/14 §3). Floors with no doors/keys are judged
 * solvable iff an exit is plainly reachable (degenerates to base reachability over all
 * traversal edges). With doors, a locked edge is impassable until its key is held; keys
 * are acquired when their cell is reached; the fixpoint repeats until the exit is reached
 * or no progress is made.
 *
 * NOTE on the traversal graph: like the base fallback layer, every NON-locked traversal
 * edge is treated as passable (WALK/BREAK/GAP/etc. are all eventually crossable). LOCKED
 * edges are the only hard gates — that is the whole point of the puzzle layer.
 */
export function lockKeyReachable(floor: Floor): LockKeyResult {
  const n = floor.width * floor.height;
  const doors = floor.lockedDoors ?? [];
  const keys: readonly KeyItem[] = floor.keys ?? [];
  const doorOfEdge = buildDoorMap(doors);

  // adjacency with each neighbour tagged by the door gating that seam (-1 = ungated).
  // neighbour lists sorted ascending (deterministic traversal order).
  const adj: { to: number; door: number }[][] = Array.from({ length: n }, () => []);
  for (const e of floor.edges as Edge[]) {
    if (e.a < 0 || e.a >= n || e.b < 0 || e.b >= n) continue;
    const door = doorOfEdge.get(edgeKey(e.a, e.b)) ?? -1;
    (adj[e.a] as { to: number; door: number }[]).push({ to: e.b, door });
    (adj[e.b] as { to: number; door: number }[]).push({ to: e.a, door });
  }
  for (const list of adj) list.sort((p, q) => p.to - q.to);

  // keys grouped by cell (a cell may hide multiple keys), iterated in floor.keys order.
  const heldKeys = new Set<number>(); // doorIds whose key is acquired
  const reached = new Uint8Array(n); // 1 = cell reached
  const start = floor.entry;

  let iterations = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    iterations++;

    // 1. flood reachability from entry over currently-passable edges (BFS).
    //    Recompute from scratch each pass so newly-unlocked doors are honoured.
    reached.fill(0);
    if (start >= 0 && start < n) {
      reached[start] = 1;
      const queue: number[] = [start];
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++] as number;
        for (const nb of adj[cur] as { to: number; door: number }[]) {
          if (reached[nb.to]) continue;
          // gated edge: only passable if we hold the door's key.
          if (nb.door >= 0 && !heldKeys.has(nb.door)) continue;
          reached[nb.to] = 1;
          queue.push(nb.to);
        }
      }
    }

    // 2. collect every key whose cell is now reachable (iterate keys in stable order).
    for (const key of keys) {
      if (key.cell >= 0 && key.cell < n && reached[key.cell] && !heldKeys.has(key.doorId)) {
        heldKeys.add(key.doorId);
        progressed = true; // a new key may unlock more next pass
      }
    }
    // loop again if we acquired a new key (it may open a door → more reachability).
  }

  const reachedExits: number[] = [];
  for (const ex of floor.exits) if (ex >= 0 && ex < n && reached[ex]) reachedExits.push(ex);
  reachedExits.sort((p, q) => p - q);

  const keysAcquired = Array.from(heldKeys).sort((p, q) => p - q);
  let reachedCount = 0;
  for (let i = 0; i < n; i++) if (reached[i]) reachedCount++;

  return {
    solvable: reachedExits.length > 0,
    reachedExits,
    keysAcquired,
    reachedCount,
    iterations,
  };
}
