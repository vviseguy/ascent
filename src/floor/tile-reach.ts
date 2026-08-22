// ============================================================================
// src/floor/tile-reach.ts — reachability over DOMAINS (the emergent generator's engine).
// ============================================================================
//
// `corner-graph.ts` answers "is this floor traversable?" for CONCRETE tiles. A generator that
// narrows a field of possibilities needs the same question asked of a tile that is still a SET of
// values, and a set has two honest answers:
//
//   MAY be open   ∃ a surviving combination that is not a wall   → "this route is still ACHIEVABLE"
//   MUST be open  ∀ surviving combinations are not a wall        → "this route is already GUARANTEED"
//
// Those two modalities are the whole engine:
//   • propose a placement → stage it → if a committed route stops being GUARANTEED, roll back;
//   • if the goal stops being ACHIEVABLE even optimistically, the placement already killed the
//     floor — roll back.
// Both hold ⇒ commit. Because `andGate` only ever REMOVES options, the two converge monotonically:
// MAY only shrinks, MUST only grows, and the floor is finished when the route is guaranteed.
//
// THE SAFETY ARGUMENT (why nothing needs to be reserved up front): a blank grid is `fullField()`
// everywhere, so every arm MAY be open — the blank field is maximally connected. Stamps only narrow.
// So if every commit is gated on "the pinned route is still guaranteed", the floor is completable at
// EVERY moment, by induction from the blank base case. Connectivity is never added, only defended.
//
// Pure + deterministic — masks are integers, BFS runs over dense arrays with ascending adjacency, and
// the only Set/Map use is during construction (sorted before it can affect output).

import { type Dir, DIRS } from './wall-tile.ts';
import { type TileField, type Mask, segs, hasConflict, template } from './wall-tile-field.ts';
import { type TileGrid, cellIndex, inBounds, type Tx, stamp } from './tile-grid.ts';
import {
  type CornerGraph,
  buildCornerGraphFrom,
  cornerId,
  reachableFromSet,
} from './corner-graph.ts';

/** The `wall` bit, derived from the public helper so a reordering of SEGS can't silently break us. */
const WALL: Mask = segs('wall');
/** Everything a segment may be EXCEPT a full-height wall — the value-set a pinned-open arm is narrowed to. */
const NOT_WALL: Mask = segs('none', 'barrier');
/** The closed map perimeter: a missing neighbour's shared edge cell is the wall shell (matches
 *  `tile-grid.ts`'s PERIMETER constant, in domain form). */
const PERIMETER: Mask = WALL;

/** Which question is being asked of a domain. */
export type Polarity =
  /** optimistic — "could this still be open?" Used to ask whether a goal is still ACHIEVABLE. */
  | 'may'
  /** pessimistic — "is this open no matter how it collapses?" Used to ask whether a route is GUARANTEED. */
  | 'must';

/* ------------------------------- the arm predicates ------------------------------- */
// A concrete arm blocks iff BOTH its cells are a full-height wall (corner-graph.ts:armBlocks) —
// a partial arm leaves a gap, and a low `barrier` is surmountable. Lifted to domains:

/** ∃ a surviving (edge,inner) pair that does not block. False only when BOTH domains are exactly {wall}. */
export const armMayBeOpen = (edge: Mask, inner: Mask): boolean => !(edge === WALL && inner === WALL);

/** ∀ surviving (edge,inner) pairs do not block. False as soon as `wall` survives in BOTH domains. */
export const armMustBeOpen = (edge: Mask, inner: Mask): boolean => !((edge & WALL) !== 0 && (inner & WALL) !== 0);

/** The predicate for a polarity. */
export const armOpen = (p: Polarity): ((edge: Mask, inner: Mask) => boolean) =>
  p === 'may' ? armMayBeOpen : armMustBeOpen;

/* ------------------------------- the resolved field view ------------------------------- */

/** Read a cell, or null when out of bounds / already conflicted (an empty domain has no legal value). */
export type FieldAt = (x: number, y: number) => TileField | null;

/** A grid's cells, as a `FieldAt`. */
export const gridAt = (g: TileGrid): FieldAt => (x, y) => {
  if (!inBounds(g, x, y)) return null;
  const f = g.cells[cellIndex(g, x, y)]!;
  return hasConflict(f) ? null : f;
};

/** A TRANSACTION's cells — staged value if the cell was touched, else the grid's. Lets a placement be
 *  evaluated for reachability BEFORE it is committed, which is the whole point of the loop. */
export const txAt = (tx: Tx): FieldAt => (x, y) => {
  if (!inBounds(tx.grid, x, y)) return null;
  const i = cellIndex(tx.grid, x, y);
  const f = tx.staged.get(i) ?? tx.grid.cells[i]!;
  return hasConflict(f) ? null : f;
};

/**
 * The DOMAIN form of the owner-resolved arm (docs/16 §12 #4): a tile owns its N+W edge cells and
 * READS its E+S from the neighbour (`edge.E of A` *is* `edge.W of B`), so two tiles can never disagree
 * about a shared boundary. A missing/conflicted neighbour resolves to the perimeter shell.
 */
export function armMasks(at: FieldAt, x: number, y: number, d: Dir): { edge: Mask; inner: Mask } | null {
  const self = at(x, y);
  if (!self) return null;
  const inner = self.inner[d];
  if (d === 'N') return { edge: self.edge.N, inner };
  if (d === 'W') return { edge: self.edge.W, inner };
  if (d === 'E') return { edge: at(x + 1, y)?.edge.W ?? PERIMETER, inner };
  return { edge: at(x, y + 1)?.edge.N ?? PERIMETER, inner }; // 'S'
}

/** Is tile (x,y)'s `d` arm open, under this polarity? A cell we can't read contributes no passage. */
export function armPassable(at: FieldAt, x: number, y: number, d: Dir, p: Polarity): boolean {
  const m = armMasks(at, x, y, d);
  return m ? armOpen(p)(m.edge, m.inner) : false;
}

/* ------------------------------- the graph ------------------------------- */

/** The corner-graph of a field under one polarity — same builder, same topology, domain predicate. */
export function domainCornerGraph(at: FieldAt, w: number, h: number, p: Polarity): CornerGraph {
  return buildCornerGraphFrom(w, h, (x, y, d) => armPassable(at, x, y, d, p));
}

/** One arm as a graph edge: the corner pair it links, and the tile+direction that owns it (so a route
 *  can be PINNED by narrowing exactly the cells it depends on). */
export interface ArmEdge {
  a: number;
  b: number;
  x: number;
  y: number;
  dir: Dir;
}

/** The two corner ids an arm links. */
export function armCorners(w: number, x: number, y: number, d: Dir): [number, number] {
  const nw = cornerId(w, x, y);
  const ne = cornerId(w, x + 1, y);
  const se = cornerId(w, x + 1, y + 1);
  const sw = cornerId(w, x, y + 1);
  if (d === 'N') return [nw, ne];
  if (d === 'E') return [ne, se];
  if (d === 'S') return [se, sw];
  return [sw, nw]; // 'W'
}

/**
 * A route from `start` to `goal` over the corners, as the ARMS it crosses — BFS, so it is the
 * shortest such route, and deterministic (neighbours enumerated in a fixed tile/direction order,
 * queue is a dense array). Returns null when the goal is unreachable under this polarity.
 *
 * Note there are up to TWO arms per corner-pair (one through each flanking tile); the first one
 * discovered in the fixed order wins, which is all a route needs — pinning one flank is enough to
 * guarantee the pair (`buildCornerGraphFrom` links if EITHER flank is open).
 */
export function findRoute(at: FieldAt, w: number, h: number, p: Polarity, start: number, goal: number): ArmEdge[] | null {
  if (start === goal) return [];
  const nodeCount = (w + 1) * (h + 1);
  if (start < 0 || start >= nodeCount || goal < 0 || goal >= nodeCount) return null;

  // adjacency as arms, built once in a fixed order so BFS is reproducible
  const arms: ArmEdge[][] = Array.from({ length: nodeCount }, () => []);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (const d of DIRS) {
        if (!armPassable(at, x, y, d, p)) continue;
        const [a, b] = armCorners(w, x, y, d);
        arms[a]!.push({ a, b, x, y, dir: d });
        arms[b]!.push({ a: b, b: a, x, y, dir: d });
      }
    }
  }

  const cameFrom = new Array<ArmEdge | null>(nodeCount).fill(null);
  const seen = new Array<boolean>(nodeCount).fill(false);
  seen[start] = true;
  const queue: number[] = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi]!;
    if (n === goal) break;
    for (const e of arms[n]!) {
      if (seen[e.b]) continue;
      seen[e.b] = true;
      cameFrom[e.b] = e;
      queue.push(e.b);
    }
  }
  if (!seen[goal]) return null;

  const path: ArmEdge[] = [];
  for (let n = goal; n !== start; ) {
    const e = cameFrom[n];
    if (!e) return null; // unreachable in practice; keeps the loop total
    path.push(e);
    n = e.a;
  }
  return path.reverse();
}

/** Is `goal` reachable from `start` under this polarity? */
export function reaches(at: FieldAt, w: number, h: number, p: Polarity, start: number, goal: number): boolean {
  return reachesAll(at, w, h, p, start, [goal]);
}

/** Are ALL `goals` reachable from `start`? One graph build and one BFS answers every goal at once —
 *  which matters, because this is the gate on the generator's inner loop (once per proposal, not once
 *  per proposal per goal). */
export function reachesAll(at: FieldAt, w: number, h: number, p: Polarity, start: number, goals: readonly number[]): boolean {
  if (goals.length === 0) return true;
  const g = domainCornerGraph(at, w, h, p);
  const seen = reachableFromSet(g, [start]);
  return goals.every((t) => seen[t] === true);
}

/* ------------------------------- pinning ------------------------------- */

/**
 * PIN a route open: narrow each arm it crosses so `wall` can no longer survive on it, turning
 * `armMayBeOpen` into `armMustBeOpen`.
 *
 * WHICH of the arm's two cells to narrow is not a free choice. An arm is passable when EITHER cell can
 * be non-wall, so a route may be using an arm whose INNER is already pinned hard to `wall` and whose
 * EDGE is what leaves the gap. Narrowing the inner there empties the domain and takes the whole
 * transaction down. So: narrow the inner when it still has a non-wall option (preferred — it is
 * tile-private and cannot surprise a neighbour), otherwise narrow the edge.
 *
 * Edge ownership applies (docs/16 §12 #4): a tile owns its N/W edge cells, so an E/S edge is written as
 * the NEIGHBOUR's W/N. At the map border there is no neighbour and the edge is the perimeter `wall`,
 * which is precisely the case `armMayBeOpen` already excluded, so it cannot be reached here.
 *
 * Staged through the caller's transaction, so pinning is itself atomic and rollback-able, and it is a
 * plain `andGate` like every other stamp — no privileged write path into the grid.
 */
export function pinRouteOpen(tx: Tx, route: readonly ArmEdge[]): void {
  const at = txAt(tx);
  const put = (x: number, y: number, f: Parameters<typeof template>[0]): void =>
    stamp(tx, { x, y, w: 1, h: 1 }, template(f));
  for (const e of route) {
    const m = armMasks(at, e.x, e.y, e.dir);
    if (!m) continue;
    if ((m.inner & NOT_WALL) !== 0) {
      const inner: Partial<Record<Dir, Mask>> = {};
      inner[e.dir] = NOT_WALL;
      put(e.x, e.y, { inner });
    } else if ((m.edge & NOT_WALL) !== 0) {
      // the inner is already a hard wall — this arm is passable only through its EDGE cell
      if (e.dir === 'N') put(e.x, e.y, { edge: { N: NOT_WALL } });
      else if (e.dir === 'W') put(e.x, e.y, { edge: { W: NOT_WALL } });
      else if (e.dir === 'E') put(e.x + 1, e.y, { edge: { W: NOT_WALL } });
      else put(e.x, e.y + 1, { edge: { N: NOT_WALL } });
    }
  }
}

/** Does every arm of `route` still read as GUARANTEED open in this view? The gate a proposed placement
 *  must survive: a committed route may never stop being guaranteed. */
export function routeGuaranteed(at: FieldAt, route: readonly ArmEdge[]): boolean {
  return route.every((e) => armPassable(at, e.x, e.y, e.dir, 'must'));
}
