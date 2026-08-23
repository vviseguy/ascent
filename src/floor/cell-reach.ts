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

import { SEGS, BLOCKING_SEGS, wallOwner, type Dir } from './cell.ts';
import { segs, corners, wallTypes, floors, template, type CellField, type Mask, opens } from './cell-field.ts';
import {
  type CellGrid, type Tx, cellIndex, inBounds, stamp,
} from './cell-grid.ts';
import {
  type CellGraph, nodeId, reachableFromSet, DIRS,
} from './cell-graph.ts';

/** The BLOCKING kinds as one mask, and its complement — both derived from `BLOCKING_SEGS`, so adding
 *  another impassable segment kind needs no edit here. */
const BLOCKING: Mask = segs(...BLOCKING_SEGS);
const PASSABLE: Mask = segs(...SEGS.filter((s) => !BLOCKING_SEGS.includes(s)));
/** Off the map: the perimeter shell. */
const PERIMETER: Mask = segs('wall');
/** An opening is certain when the wall TYPE can only be walk-through — the corner has no say now. */
/** A cell is CERTAINLY solid fill when `rock` is the only ground it can still be. Solid fill is not a
 *  place a body can occupy, so it contributes no edges — the one way `floor` reaches passability. */
const ROCK_ONLY: Mask = floors('rock');
export const isSolid = (f: CellField): boolean => f.floor !== 0 && (f.floor & ~ROCK_ONLY) === 0;
/** The kinds that let a body through when OPEN. Being open is not enough on its own — a window
 *  is a hole you cannot walk through — so certainty needs both halves. */
const PASSABLE_KINDS_MASK: Mask = wallTypes('doorway', 'arch', 'scaffold');
const OPEN_STATE: Mask = opens('open');

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

/** ∃ a surviving value a body can pass. False only when every option blocks. */
export const mayBeOpen = (m: Mask): boolean => (m & PASSABLE) !== 0;
/** ∀ surviving values are passable. False as soon as any blocking kind survives. */
export const mustBeOpen = (m: Mask): boolean => (m & BLOCKING) === 0;

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
  // CERTAIN when every type still on the table walks through. The corner used to have to agree
  // as well, which meant an opening's passability lived in two fields that could disagree.
  // CERTAIN when every kind still on the table is passable AND it can only be open. Either field
  // left undecided means the opening might not be one, and under-claiming is the safe direction.
  return f.wallType !== 0 && (f.wallType & ~PASSABLE_KINDS_MASK) === 0
    && f.open !== 0 && (f.open & ~OPEN_STATE) === 0;
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
      const self = at(x, y);
      if (!self || isSolid(self)) continue; // solid fill is not a place
      // N and W only: each shared wall is consulted exactly once, from its owner's side
      for (const d of ['N', 'W'] as Dir[]) {
        const nx = d === 'N' ? x : x - 1, ny = d === 'N' ? y - 1 : y;
        const nb = inside(nx, ny) ? at(nx, ny) : null;
        if (!nb || isSolid(nb)) continue;
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
 *
 * ALLOCATION-FREE. This is the hot path — the generator runs it once per proposal, thousands of times
 * per floor — so it walks neighbours on the fly instead of materialising a graph. Building one cost a
 * `Set` per cell plus a sort, every single call, which is where the generation time actually went
 * (1.4s for a 60x48 floor). It must agree with `edgesOf` exactly, so the two are pinned together by a
 * property test rather than by hoping.
 */
export function reachSet(at: FieldAt, w: number, h: number, p: Polarity, start: number): boolean[] {
  const n = w * h;
  const seen = new Array<boolean>(n).fill(false);
  if (start < 0 || start >= n) return seen;
  const readable = (x: number, y: number): CellField | null => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const f = at(x, y);
    return f && !isSolid(f) ? f : null;
  };
  if (!readable(start % w, Math.floor(start / w))) return seen;

  seen[start] = true;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const x = cur % w, y = Math.floor(cur / w);
    const visit = (nx: number, ny: number): void => {
      if (!readable(nx, ny)) return;
      const id = ny * w + nx;
      if (seen[id]) return;
      seen[id] = true;
      queue.push(id);
    };
    // the four wall-crossings
    for (const d of DIRS) {
      const nx = d === 'E' ? x + 1 : d === 'W' ? x - 1 : x;
      const ny = d === 'S' ? y + 1 : d === 'N' ? y - 1 : y;
      if (!readable(nx, ny)) continue;
      if (!wallOpen(wallMask(at, x, y, d), p)) continue;
      visit(nx, ny);
    }
    // openings: a cell touches FOUR lattice points, and an open one joins everything around it
    for (const [px, py] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] as [number, number][]) {
      if (!openingCertain(at, px, py)) continue;
      visit(px - 1, py - 1); visit(px, py - 1); visit(px - 1, py); visit(px, py);
    }
  }
  return seen;
}

/**
 * Do `a` and `b` still reach each other? BFS from `a` that stops the moment it finds `b`.
 *
 * THIS IS THE GATE. Walling removes edges and can only ever SPLIT a component, and a split happens if
 * and only if some removed edge's endpoints stop being connected. So:
 *
 *     stillConnected  ⟹  no cell that was reachable became unreachable.
 *
 * It is STRICTER than `keepsReach`, not equal to it — deliberately. `keepsReach` only defends cells
 * the ENTRY can reach, so it would happily let a wall sever a pocket the entry cannot get to anyway.
 * This defends every component. The difference costs a few refused walls in regions that were going to
 * be rock-filled regardless, and buys a gate that never has to look at the whole floor.
 * `cell-reach.test.ts` pins the implication, and pins that the two agree wherever the entry can reach
 * — rather than asserting an equivalence that does not hold.
 *
 * The difference is what it costs. A full `reachSet` explores the floor every time (2 ms on a 60x48,
 * times ~1500 proposals — the entire generation time). This usually terminates in a handful of steps,
 * because a barrier worth walling almost always has a loop right next to it, and only degrades to a
 * full component walk in the rare case where the answer really is "no".
 */
export function stillConnected(at: FieldAt, w: number, h: number, p: Polarity, a: number, b: number): boolean {
  if (a === b) return true;
  const n = w * h;
  if (a < 0 || a >= n || b < 0 || b >= n) return false;
  const seen = new Uint8Array(n);
  const readable = (x: number, y: number): CellField | null => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const f = at(x, y);
    return f && !isSolid(f) ? f : null;
  };
  if (!readable(a % w, Math.floor(a / w)) || !readable(b % w, Math.floor(b / w))) return false;

  seen[a] = 1;
  const queue = [a];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const x = cur % w, y = Math.floor(cur / w);
    let found = false;
    const visit = (nx: number, ny: number): void => {
      if (found || !readable(nx, ny)) return;
      const id = ny * w + nx;
      if (seen[id]) return;
      if (id === b) { found = true; return; }
      seen[id] = 1;
      queue.push(id);
    };
    for (const d of DIRS) {
      const nx = d === 'E' ? x + 1 : d === 'W' ? x - 1 : x;
      const ny = d === 'S' ? y + 1 : d === 'N' ? y - 1 : y;
      if (!readable(nx, ny) || !wallOpen(wallMask(at, x, y, d), p)) continue;
      visit(nx, ny);
    }
    for (const [px, py] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] as [number, number][]) {
      if (!openingCertain(at, px, py)) continue;
      visit(px - 1, py - 1); visit(px, py - 1); visit(px - 1, py); visit(px, py);
    }
    if (found) return true;
  }
  return false;
}

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
      template(e.pin.side === 'N' ? { wallN: PASSABLE } : { wallW: PASSABLE }));
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
