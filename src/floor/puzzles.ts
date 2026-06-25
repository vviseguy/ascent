/**
 * src/floor/puzzles.ts — deterministic LOCKED-DOOR + KEY + RUG placement (docs/14 §2).
 *
 * Places a key-and-door DEPENDENCY CHAIN onto an already-solvable Floor, then certifies
 * the result with the INDEPENDENT lock-and-key verifier (verify.ts `lockKeyReachable`)
 * and DROPS any chain that doesn't certify solvable. So the generator only ever emits
 * puzzles the verifier — which shares no "trust me" state with this placer — proves
 * completable (docs/14 §2 "only emit chains the verifier certifies solvable").
 *
 * THE CHAIN MODEL (a DAG of `key → unlocks → door → gates → region(next key / exit)`):
 *   - Find a path entry → exit over the open graph.
 *   - Lock a small ordered set of edges e_0..e_{m-1} ALONG that path (e_0 nearest entry).
 *     Door i requires keyId i.
 *   - Place key i so it is obtained only AFTER door i-1 is open: on the path segment
 *     between door i-1 and door i (key 0 on the entry side of e_0). The exit sits beyond
 *     the last door. This is a genuine chain: key0 (free) → door0 → key1 → door1 → … exit.
 *   - Some keys are hidden under a RUG (cosmetic "search the room" beat); the verifier
 *     treats LOOSE and RUG keys identically (a reachable rug is always interactable).
 *
 * WHY CHAIN-THEN-VERIFY rather than prove-by-construction: the base floor has many routes
 * (openness + the always-walkable perimeter), so a single lock rarely creates a true cut.
 * Locking a chain and re-deriving lock-and-key reachability from scratch is the honest
 * test of "is this still solvable, and is the key actually load-bearing?". The verifier is
 * the source of truth; this placer is just a candidate generator (GENERATION-SOLVABILITY).
 *
 * DETERMINISM: all choices come from a seeded sub-stream `rng`; we iterate cells/edges in
 * id/insertion order and never depend on Map/Set iteration for output. Same floor + seed
 * ⇒ identical puzzle. No floats, no Math.random, no Date.
 */

import type { Floor, KeyItem, KeySource, LockedDoor } from './types.ts';
import { cellId, cellXY, edgeKey } from './types.ts';
import { type Rng, nextInt, chance } from './rng.ts';
import { lockKeyReachable } from './verify.ts';

/** Tuning for puzzle placement (all optional; sensible defaults). */
export interface PuzzleParams {
  /** Probability the floor gets a keyed chain at all. Default 0.7. */
  puzzleChance?: number;
  /** Max doors in a chain (clamped to the available path length). Default 3. */
  maxChain?: number;
  /** Probability a given key is hidden under a RUG vs a loose pickup. Default 0.4. */
  rugChance?: number;
}

const DEFAULTS: Required<PuzzleParams> = { puzzleChance: 0.7, maxChain: 3, rugChance: 0.4 };

/** A placed chain (doors + keys), or null if none could be placed. */
interface Placement {
  doors: LockedDoor[];
  keys: KeyItem[];
}

/**
 * Place a verified-solvable keyed chain on `floor` (mutating it by setting
 * `lockedDoors`/`keys`), or leave it puzzle-free. Returns the floor for chaining.
 *
 * The floor MUST already be base-solvable (the caller generated it that way). We attempt
 * one candidate chain; if it fails to certify, we emit no puzzle (a plain solvable floor
 * is always acceptable). This keeps the invariant: every shipped floor is solvable, with
 * or without a puzzle.
 */
export function placePuzzles(floor: Floor, rng: Rng, params?: PuzzleParams): Floor {
  const p = { ...DEFAULTS, ...params };
  if (!chance(rng, p.puzzleChance)) return floor; // no puzzle this floor (still solvable)

  const candidate = buildChain(floor, rng, p);
  if (!candidate) return floor;

  // CERTIFY with the independent verifier before committing. We test on a shallow clone
  // carrying the candidate so a rejected chain never touches the shipped floor.
  const trial: Floor = { ...floor, lockedDoors: candidate.doors, keys: candidate.keys };
  if (!lockKeyReachable(trial).solvable) return floor; // reject — ship plain solvable floor

  floor.lockedDoors = candidate.doors;
  floor.keys = candidate.keys;
  return floor;
}

/**
 * Build a candidate chain: a path entry→exit, a set of locked edges along it, and a key
 * per door placed in dependency order. Returns null if the floor is too small / no path.
 */
function buildChain(floor: Floor, rng: Rng, p: Required<PuzzleParams>): Placement | null {
  const path = findOpenPath(floor);
  if (!path || path.length < 4) return null; // need room for at least one door + key

  // candidate lockable edges = consecutive path steps, EXCLUDING the very first step out
  // of the entry (lock-before-key: never gate the first move) and keeping the entry cell
  // free for key 0. Each path step i connects path[i] → path[i+1].
  const lockableSteps: number[] = [];
  for (let i = 1; i + 1 < path.length; i++) lockableSteps.push(i);
  if (lockableSteps.length === 0) return null;

  // choose chain length (1..maxChain), bounded by available steps with room for keys
  // between consecutive doors. We pick door steps spaced out along the path so each pair
  // of consecutive doors has at least one cell between them to host the next key.
  const maxDoors = Math.max(1, Math.min(p.maxChain, Math.floor(lockableSteps.length / 2)));
  const chainLen = 1 + nextInt(rng, maxDoors);

  // pick `chainLen` strictly-increasing door step indices with >=2 gap so a key fits
  // between them (and before the first / after — handled by segments below).
  const doorSteps = pickSpacedSteps(rng, lockableSteps, chainLen);
  if (doorSteps.length === 0) return null;

  const doors: LockedDoor[] = [];
  const keys: KeyItem[] = [];
  for (let d = 0; d < doorSteps.length; d++) {
    const step = doorSteps[d]!;
    const a = path[step]!;
    const b = path[step + 1]!;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const doorId = d; // doorId per floor = chain index (0..chainLen-1)
    doors.push({ a: lo, b: hi, doorId });

    // key d goes on the path segment that becomes reachable only after door d-1 opens:
    //   - key 0  → between the entry and door 0  (steps [0, doorSteps[0]])
    //   - key d  → between door d-1 and door d   (steps (doorSteps[d-1], doorSteps[d]])
    // we place the key on a path CELL in that segment (a cell, not on a locked edge).
    const segLo = d === 0 ? 0 : doorSteps[d - 1]! + 1; // first path index in the segment
    const segHi = step; // up to (and including) the cell just before this door's edge
    const keyCell = pickSegmentCell(rng, path, segLo, segHi);
    const source: KeySource = chance(rng, p.rugChance) ? 'RUG' : 'LOOSE';
    keys.push({ cell: keyCell, doorId, source });
  }

  return { doors, keys };
}

/**
 * BFS path from entry to ANY exit over the OPEN graph (every traversal edge is passable;
 * no locks exist yet at this stage). Returns the cell-id path entry…exit, or null.
 * Deterministic: fixed neighbour order (sorted ascending), FIFO frontier.
 */
function findOpenPath(floor: Floor): number[] | null {
  const n = floor.width * floor.height;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of floor.edges) {
    if (e.a < 0 || e.a >= n || e.b < 0 || e.b >= n) continue;
    (adj[e.a] as number[]).push(e.b);
    (adj[e.b] as number[]).push(e.a);
  }
  for (const list of adj) list.sort((x, y) => x - y);

  const exitSet = new Set(floor.exits);
  const prev = new Int32Array(n).fill(-2);
  const start = floor.entry;
  if (start < 0 || start >= n) return null;
  prev[start] = -1;
  const queue: number[] = [start];
  let head = 0;
  let goal = -1;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    if (cur !== start && exitSet.has(cur)) { goal = cur; break; }
    for (const nb of adj[cur] as number[]) {
      if (prev[nb] !== -2) continue;
      prev[nb] = cur;
      queue.push(nb);
    }
  }
  if (goal < 0) return null;
  const rev: number[] = [];
  let c = goal;
  while (c !== -1) { rev.push(c); c = prev[c] as number; }
  rev.reverse();
  return rev;
}

/**
 * Pick `count` strictly-increasing values from `steps` (already ascending) with at least
 * a 2-index gap between chosen values, so consecutive doors leave a path cell between them
 * for the next key. Deterministic greedy from a seeded start offset. Returns fewer than
 * `count` only if the spacing can't be met (caller handles the short chain).
 */
function pickSpacedSteps(rng: Rng, steps: number[], count: number): number[] {
  if (steps.length === 0 || count <= 0) return [];
  const out: number[] = [];
  // start at a seeded offset into the step list, then take every value that keeps a >=2
  // path-cell gap from the previously chosen door.
  let idx = nextInt(rng, steps.length);
  let lastDoorStep = -100;
  // sweep forward (wrapping once) so we can fill the chain even from a late start.
  for (let scanned = 0; scanned < steps.length && out.length < count; scanned++) {
    const s = steps[idx]!;
    if (s - lastDoorStep >= 2) {
      out.push(s);
      lastDoorStep = s;
    }
    idx++;
    if (idx >= steps.length) break; // no wrap (keep strictly increasing door order)
  }
  return out;
}

/**
 * Pick a path cell in [segLo, segHi] (inclusive path indices) to host a key. Prefers a
 * cell strictly inside the segment (not the door endpoints) when possible. Deterministic.
 */
function pickSegmentCell(rng: Rng, path: number[], segLo: number, segHi: number): number {
  const lo = Math.max(0, segLo);
  const hi = Math.min(path.length - 1, segHi);
  if (hi < lo) return path[Math.max(0, Math.min(path.length - 1, segLo))]!;
  const span = hi - lo + 1;
  const pick = lo + nextInt(rng, span);
  return path[pick]!;
}

/* ----- small re-exports for tests/proofs that want the helpers directly ----- */
export { findOpenPath };

// keep imports referenced (used in helpers above / by callers)
void cellId; void cellXY; void edgeKey;
