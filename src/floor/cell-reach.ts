// ============================================================================
// src/floor/cell-reach.ts — reachability over DOMAINS. The generator's engine.
// ============================================================================
//
// `cell-graph.ts` answers "is this floor traversable?" for CONCRETE cells. A generator that narrows a
// field of possibilities needs the same question asked of a cell that is still a SET, and a set has
// two honest answers:
//
//   MAY be open   ∃ a surviving value that is not a wall   → "this route is still ACHIEVABLE"
//   MUST be open  ∀ surviving values are not a wall        → "this route is already GUARANTEED"
//
// Those two are the whole loop: stage a placement, roll it back if a committed route stops being
// GUARANTEED or the goal stops being ACHIEVABLE, commit when both hold. Because `andGate` only ever
// REMOVES options, MAY only shrinks and MUST only grows, so they converge.
//
// THE SAFETY ARGUMENT: a blank grid is `fullField()` everywhere, so every wall MAY be open — the blank
// field is maximally connected. Stamps only narrow. So gating every commit on "nothing previously
// reachable was lost" keeps the floor completable at EVERY moment, by induction from the blank base
// case. Connectivity is never added, only defended.
//
// ONE EDGE ENUMERATION, SHARED. `edgesOf` is the single place an edge comes into existence, and both
// the graph and the router are built from it. This is not tidiness — in the 4u model the graph and
// `findRoute` derived their edges separately, one learned about openings and the other did not, and
// the disagreement surfaced as a phantom "invariant broken" rather than as the mismatch it was. Two
// enumerations is two things that can drift.
//
// Pure + deterministic — integer masks, fixed enumeration order, BFS over dense arrays.

import { wallOwner, type Dir } from './cell.ts';
import { segs, corners, wallTypes, template, type CellField, type Mask } from './cell-field.ts';
import {
  type CellGrid, type Tx, cellIndex, inBounds, stamp,
} from './cell-grid.ts';
import {
  type CellGraph, nodeId, reachableFromSet,
} from './cell-graph.ts';

/** `wall` as a domain bit; everything a wall may be EXCEPT a full-height wall. */
const WALL: Mask = segs('wall');
const NOT_WALL: Mask = segs('none', 'barrier');
/** Off the map: the perimeter shell. */
const PERIMETER: Mask = WALL;
/** An opening is certain when the corner can only be `air` and the type can only be walk-through. */
const AIR: Mask = corners('air');
const OPEN_TYPES: Mask = wallTypes('door', 'arch');

export type Polarity =
  /** optimistic — "could this still be open?" Asks whether a goal is still ACHIEVABLE. */
  | 'may'
  /** pessimistic — "is this open however it collapses?" Asks whether a route is GUARANTEED. */
  | 'must';

/* ------------------------------- reading a field ------------------------------- */

export type FieldAt = (x: number, y: number) => CellField | null;

const conflicted = (f: CellField): boolean =>
  f.floor === 0 || f.wallN === 0 || f.wallW === 0 || f.corner === 0 || f.wallType === 0;

/** A grid's cells. */
export const gridAt = (g: CellGrid): FieldAt => (x, y) => {
  if (!inBounds(g, x, y)) return null;
  const f = g.cells[cellIndex(g, x, y)]!;
  return conflicted(f) ? null : f;
};

/** A TRANSACTION's cells — staged where touched. Lets a placement be judged BEFORE it commits. */
export const txAt = (tx: Tx): FieldAt => (x, y) => {
  if (!inBounds(tx.grid, x, y)) return null;
  const i = cellIndex(tx.grid, x, y);
  const f = tx.staged.get(i) ?? tx.grid.cells[i]!;
  return conflicted(f) ? null : f;
};

/** The domain of the wall on side `d` of (x,y), read from whichever cell OWNS it. */
export function wallMask(at: FieldAt, x: number, y: number, d: Dir): Mask {
  const o = wallOwner(x, y, d);
  const f = at(o.x, o.y);
  if (!f) return PERIMETER;
  return o.side === 'N' ? f.wallN : f.wallW;
}

/* ------------------------------- the predicates ------------------------------- */

/** ∃ a surviving value that is not a full-height wall. False only when pinned to exactly `wall`. */
export const mayBeOpen = (m: Mask): boolean => (m & NOT_WALL) !== 0;
/** ∀ surviving values are not a full-height wall. False as soon as `wall` survives. */
export const mustBeOpen = (m: Mask): boolean => (m & WALL) === 0;

export const wallOpen = (m: Mask, p: Polarity): boolean => (p === 'may' ? mayBeOpen(m) : mustBeOpen(m));

/**
 * Is there CERTAINLY an opening at (x,y)'s corner? Certain-only in BOTH polarities, on purpose: an
 * opening only ever ADDS reachability, so counting a merely-possible one would inflate `may` (keeping
 * a wall in the belief a maybe-door rescues the route) and inflate `must` (calling a route guaranteed
 * on a maybe-door). Requiring certainty under-claims instead, which can never call an unreachable
 * floor reachable.
 */
export function openingCertain(at: FieldAt, x: number, y: number): boolean {
  const f = at(x, y);
  if (!f) return false;
  return f.corner === AIR && f.wallType !== 0 && (f.wallType & ~OPEN_TYPES) === 0;
}

/* ------------------------------- the ONE enumeration ------------------------------- */

/** One traversable connection, and the wall to narrow if a route wants it GUARANTEED. */
export interface StepEdge {
  a: number;
  b: number;
  /** The wall this hop crosses — narrow it to make the hop GUARANTEED. Null for an opening hop. */
  pin: { x: number; y: number; side: 'N' | 'W' } | null;
  /** For an opening hop: the cell whose corner it crosses. Nothing to pin (openings are monotone),
   *  but recorded so `routeGuaranteed` can RE-CHECK it rather than assume it. */
  via?: { x: number; y: number };
}

/**
 * Every edge the field admits under this polarity, in a fixed order. THE single source — the graph and
 * the router are both built from it, so they cannot disagree about what is traversable.
 */
export function edgesOf(at: FieldAt, w: number, h: number, p: Polarity): StepEdge[] {
  const out: StepEdge[] = [];
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      // N and W only: each shared wall is consulted exactly once, from its owner's side
      for (const d of ['N', 'W'] as Dir[]) {
        const nx = d === 'N' ? x : x - 1, ny = d === 'N' ? y - 1 : y;
        if (!inside(nx, ny) || !at(nx, ny)) continue;
        if (!wallOpen(wallMask(at, x, y, d), p)) continue;
        out.push({ a: nodeId(w, x, y), b: nodeId(w, nx, ny), pin: wallOwner(x, y, d) });
      }
      // an air corner is a hole at the junction → every cell touching that point joins
      if (!openingCertain(at, x, y)) continue;
      const around = [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]
        .filter(([ax, ay]) => inside(ax!, ay!) && at(ax!, ay!))
        .map(([ax, ay]) => nodeId(w, ax!, ay!));
      for (let i = 0; i < around.length; i++) {
        for (let j = i + 1; j < around.length; j++) {
          out.push({ a: around[i]!, b: around[j]!, pin: null, via: { x, y } });
        }
      }
    }
  }
  return out;
}

/** The graph of a field under one polarity, built from `edgesOf`. */
export function cellGraphOf(at: FieldAt, w: number, h: number, p: Polarity): CellGraph {
  const n = w * h;
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (const e of edgesOf(at, w, h, p)) { adj[e.a]!.add(e.b); adj[e.b]!.add(e.a); }
  return { w, h, nodeCount: n, adj: adj.map((s) => [...s].sort((a, b) => a - b)) };
}

/* ------------------------------- reachability ------------------------------- */

/**
 * WHICH cells are reachable, as a boolean array. Use this, never a count, for any "nothing was lost"
 * gate: an opening can ADD edges, so one commit may lose a cell and gain another, leave the total
 * identical, and slip through a count comparison.
 */
export const reachSet = (at: FieldAt, w: number, h: number, p: Polarity, start: number): boolean[] =>
  reachableFromSet(cellGraphOf(at, w, h, p), [start]);

/** Every cell reachable in `before` is still reachable in `after`. Growth is fine; loss is not. */
export const keepsReach = (before: readonly boolean[], after: readonly boolean[]): boolean =>
  before.every((was, i) => !was || after[i] === true);

export const reaches = (at: FieldAt, w: number, h: number, p: Polarity, a: number, b: number): boolean =>
  reachSet(at, w, h, p, a)[b] === true;

/**
 * A shortest route from `start` to `goal` as the edges it crosses — BFS over the SAME `edgesOf`, so
 * anything `reachSet` calls reachable is routable by construction. Null when unreachable.
 */
export function findRoute(at: FieldAt, w: number, h: number, p: Polarity, start: number, goal: number): StepEdge[] | null {
  if (start === goal) return [];
  const n = w * h;
  if (start < 0 || start >= n || goal < 0 || goal >= n) return null;

  const inc: StepEdge[][] = Array.from({ length: n }, () => []);
  for (const e of edgesOf(at, w, h, p)) {
    inc[e.a]!.push(e);
    inc[e.b]!.push(e.via ? { a: e.b, b: e.a, pin: e.pin, via: e.via } : { a: e.b, b: e.a, pin: e.pin });
  }
  const from = new Array<StepEdge | null>(n).fill(null);
  const seen = new Array<boolean>(n).fill(false);
  seen[start] = true;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    if (cur === goal) break;
    for (const e of inc[cur]!) {
      if (seen[e.b]) continue;
      seen[e.b] = true;
      from[e.b] = e;
      queue.push(e.b);
    }
  }
  if (!seen[goal]) return null;
  const path: StepEdge[] = [];
  for (let cur = goal; cur !== start; ) {
    const e = from[cur];
    if (!e) return null;
    path.push(e);
    cur = e.a;
  }
  return path.reverse();
}

/* ------------------------------- pinning ------------------------------- */

/**
 * PIN a route open: narrow each wall it crosses so `wall` can no longer survive there. That is the
 * minimal narrowing making `mustBeOpen` true, and it is an ordinary stamp through the caller's
 * transaction — no privileged write path into the grid.
 *
 * Opening hops are skipped: `openingCertain` is monotone under narrowing (a corner pinned to `air`
 * cannot move, and a wallType domain already inside {door,arch} stays inside it), so once an opening
 * is certain it is permanent and there is nothing to defend.
 */
export function pinRouteOpen(tx: Tx, route: readonly StepEdge[]): void {
  for (const e of route) {
    if (!e.pin) continue;
    stamp(tx, { x: e.pin.x, y: e.pin.y, w: 1, h: 1 },
      template(e.pin.side === 'N' ? { wallN: NOT_WALL } : { wallW: NOT_WALL }));
  }
}

/** Does every hop of `route` still read as GUARANTEED open? The gate a proposal must survive. */
export function routeGuaranteed(at: FieldAt, route: readonly StepEdge[]): boolean {
  return route.every((e) => {
    if (e.via) return openingCertain(at, e.via.x, e.via.y);
    if (!e.pin) return false;
    const f = at(e.pin.x, e.pin.y);
    return f ? mustBeOpen(e.pin.side === 'N' ? f.wallN : f.wallW) : false;
  });
}
