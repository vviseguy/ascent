// ============================================================================
// src/game/route-check.ts — GEOMETRY-LEVEL solvability of the compiled tower.
// ============================================================================
//
// WHY (GAPS.md H3, `verifier-promise-severed`): the floor verifier proves the
// CELL GRAPH solvable, but compileTower is a lossy projection of that graph into
// AABBs — a compiler bug could ship an untraversable tower with the verifier
// green. This module independently re-proves the invariant ON THE OUTPUT: it
// builds a walk graph over solid-box TOP surfaces and asks whether a probe with
// the Anchor's capabilities can path from the stratum-0 entry to the TOP
// stratum's surface. "Never trust the generator — prove it independently"
// applied one layer down: never trust the compiler either.
//
// MODEL — nodes are STANDABLE box tops:
//   - a box top is standable if its footprint is at least `minSide` on both axes
//     (excludes rails/lips/walls — you route over real floor, not fence tops) and
//     has HEADROOM: no other box's underside hangs over the footprint's core
//     (shrunk by `shrink` ≈ body radius) within standing height. The headroom
//     test is what catches a missing ceiling hole: stairs under an uncarved slab
//     read as blocked, so the route fails loudly.
//   - directed edge a→b when the footprints adjoin/overlap within `reach` and the
//     climb (b.top − a.top) is at most `maxStep`. Drops are unlimited (you can
//     always fall); ascents are capped at what the probe can hop.
//
// DETERMINISM: this is a BUILD/PROOF-TIME check, never on the sim's hot path, so
// plain JS number math is fine — inputs are raw Q16.16 ints, every operation is
// the same float64 sequence on every run, and no Map/Set iteration order affects
// the result (plain arrays, ascending index).
//
// KNOWN LIMITATION: edges do not model LATERAL blockers (e.g. a guard rail
// standing between two adjacent tops), so this check can pass a layout a real
// body cannot squeeze through. The END-TO-END input-driven climb in
// src/game/prove.ts (PROOF 8) covers that physically for the canonical layout —
// it caught exactly such a pinch at the stair turn on the first cut.
// ============================================================================

import { ONE_RAW } from '../sim/fixed/fixed.ts';
import type { CompiledTower } from './tower.ts';

/** Traversal capabilities of the route probe (meters, plain numbers). */
export interface RouteProbe {
  /** Max climbable rise per move — under the probe's jump apex with margin. */
  maxStep: number;
  /** Horizontal reach when stepping between surfaces (≈ body radius). */
  reach: number;
  /** Clearance required above a surface to stand on it (≈ body height). */
  headroom: number;
  /** Footprint core shrink for the headroom test (≈ body radius). */
  shrink: number;
  /** Minimum footprint side for a top to count as standable floor. */
  minSide: number;
}

/**
 * The solo ANCHOR probe — the binding constraint (everyone else climbs better).
 * maxStep 0.6 < its 0.71 u jump apex; 1.9 headroom for its 2.0 u body (the small
 * allowance keeps flush-top boxes from reading as their own ceiling).
 */
export const ANCHOR_PROBE: RouteProbe = {
  maxStep: 0.6,
  reach: 0.35,
  headroom: 1.9,
  shrink: 0.4,
  minSide: 0.8,
};

/** One standable box-top surface (float meters). */
interface StandNode {
  top: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SummitRouteResult {
  /** True if the probe can path stratum-0 entry → top stratum surface. */
  ok: boolean;
  /** Number of standable nodes found (diagnostic). */
  nodes: number;
  /** Number of nodes reached from the start (diagnostic). */
  reached: number;
  /** Failure description, '' on success (diagnostic for proof output). */
  reason: string;
}

const F = (raw: number): number => raw / ONE_RAW;

/**
 * Can the probe walk/hop from the tower's stratum-0 entry to the TOP stratum's
 * walkable surface, over the compiled AABBs alone? BFS over standable tops.
 */
export function summitRoute(tower: CompiledTower, probe: RouteProbe = ANCHOR_PROBE): SummitRouteResult {
  const solids = tower.terrain.solids;
  const baseTop = F(tower.stratumBaseY[tower.stratumBaseY.length - 1]!);

  // --- spatial bucket over (x,z) so the headroom test + BFS adjacency scan only NEARBY
  // boxes instead of all of them. This makes the proof near-linear in box count (the
  // 30×30 tower has ~8.7k boxes; the old O(n^2) scan was ~400 ms/tower). It is a pure
  // SUPERSET filter — every box that could matter shares or neighbours a bucket — so the
  // result is byte-identical to the exhaustive scan; only the candidate set shrinks.
  // Deterministic: buckets hold ascending box/node indices; we iterate them in order.
  const CELL = 4.0; // bucket size in meters (~one floor cell); a couple cells of reach span
  const keyOf = (gx: number, gz: number): number => gx * 73856093 ^ gz * 19349663;
  // box-index buckets (for the headroom query against ALL solids).
  const boxBuckets = new Map<number, number[]>();
  const addToBuckets = (m: Map<number, number[]>, idx: number, minX: number, maxX: number, minZ: number, maxZ: number): void => {
    const gx0 = Math.floor(minX / CELL), gx1 = Math.floor(maxX / CELL);
    const gz0 = Math.floor(minZ / CELL), gz1 = Math.floor(maxZ / CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = keyOf(gx, gz);
        let list = m.get(k);
        if (!list) { list = []; m.set(k, list); }
        list.push(idx);
      }
    }
  };
  for (let i = 0; i < solids.length; i++) {
    const b = solids[i]!;
    addToBuckets(boxBuckets, i, F(b.minX), F(b.maxX), F(b.minZ), F(b.maxZ));
  }
  // gather UNIQUE candidate box indices overlapping a query rect (ascending order).
  const gatherBoxes = (minX: number, maxX: number, minZ: number, maxZ: number, seen: Set<number>, out: number[]): void => {
    seen.clear(); out.length = 0;
    const gx0 = Math.floor(minX / CELL), gx1 = Math.floor(maxX / CELL);
    const gz0 = Math.floor(minZ / CELL), gz1 = Math.floor(maxZ / CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = boxBuckets.get(keyOf(gx, gz));
        if (!list) continue;
        for (const idx of list) if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    }
    out.sort((p, q) => p - q);
  };

  // --- collect standable nodes (ascending box order — deterministic) ---
  const nodes: StandNode[] = [];
  const qSeen = new Set<number>();
  const qOut: number[] = [];
  for (let i = 0; i < solids.length; i++) {
    const b = solids[i]!;
    const n: StandNode = { top: F(b.maxY), minX: F(b.minX), maxX: F(b.maxX), minZ: F(b.minZ), maxZ: F(b.maxZ) };
    if (n.maxX - n.minX < probe.minSide || n.maxZ - n.minZ < probe.minSide) continue;
    // headroom: another box's underside over the footprint CORE within standing
    // height blocks the node (this is what catches a missing ceiling hole).
    const cMinX = n.minX + probe.shrink;
    const cMaxX = n.maxX - probe.shrink;
    const cMinZ = n.minZ + probe.shrink;
    const cMaxZ = n.maxZ - probe.shrink;
    let blocked = false;
    gatherBoxes(cMinX, cMaxX, cMinZ, cMaxZ, qSeen, qOut);
    for (const o of qOut) {
      if (o === i) continue;
      const ob = solids[o]!;
      const oMinY = F(ob.minY);
      if (oMinY <= n.top + 0.2 || oMinY >= n.top + probe.headroom) continue;
      if (F(ob.minX) >= cMaxX || F(ob.maxX) <= cMinX) continue;
      if (F(ob.minZ) >= cMaxZ || F(ob.maxZ) <= cMinZ) continue;
      blocked = true;
      break;
    }
    if (!blocked) nodes.push(n);
  }

  // bucket the STANDABLE nodes too, for the BFS adjacency query (reach-expanded rect).
  const nodeBuckets = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    addToBuckets(nodeBuckets, i, n.minX, n.maxX, n.minZ, n.maxZ);
  }
  const gatherNodes = (minX: number, maxX: number, minZ: number, maxZ: number, seen: Set<number>, out: number[]): void => {
    seen.clear(); out.length = 0;
    const gx0 = Math.floor(minX / CELL), gx1 = Math.floor(maxX / CELL);
    const gz0 = Math.floor(minZ / CELL), gz1 = Math.floor(maxZ / CELL);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const list = nodeBuckets.get(keyOf(gx, gz));
        if (!list) continue;
        for (const idx of list) if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    }
    out.sort((p, q) => p - q);
  };

  // --- start: the standable top under the stratum-0 entry point ---
  const e0 = tower.entryXZ[0];
  const base0 = F(tower.stratumBaseY[0]!);
  if (!e0) return { ok: false, nodes: nodes.length, reached: 0, reason: 'no stratum-0 entry' };
  const ex = F(e0.x);
  const ez = F(e0.z);
  let start = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (ex < n.minX - 0.2 || ex > n.maxX + 0.2) continue;
    if (ez < n.minZ - 0.2 || ez > n.maxZ + 0.2) continue;
    if (Math.abs(n.top - base0) > 0.75) continue;
    start = i;
    break;
  }
  if (start < 0) return { ok: false, nodes: nodes.length, reached: 0, reason: 'no standable node at the entry' };

  // --- goal: a REAL floor surface (not a stair tread) at the top stratum's base ---
  const isGoal = (n: StandNode): boolean =>
    Math.abs(n.top - baseTop) <= 0.02 && (n.maxX - n.minX) * (n.maxZ - n.minZ) >= 2.0;

  // --- BFS over node adjacency; candidates from the spatial bucket (reach-expanded
  // rect), so each step scans only nearby nodes instead of all of them. Same edges as
  // the exhaustive scan (the rect is the exact adjacency test's bounding box). ---
  const visited = new Array<boolean>(nodes.length).fill(false);
  const queue: number[] = [start];
  visited[start] = true;
  let head = 0;
  let reached = 1;
  const aSeen = new Set<number>();
  const aOut: number[] = [];
  while (head < queue.length) {
    const a = nodes[queue[head++]!]!;
    if (isGoal(a)) return { ok: true, nodes: nodes.length, reached, reason: '' };
    gatherNodes(a.minX - probe.reach, a.maxX + probe.reach, a.minZ - probe.reach, a.maxZ + probe.reach, aSeen, aOut);
    for (const j of aOut) {
      if (visited[j]) continue;
      const b = nodes[j]!;
      if (b.top - a.top > probe.maxStep) continue; // too high to hop (drops are free)
      if (b.minX >= a.maxX + probe.reach || b.maxX <= a.minX - probe.reach) continue;
      if (b.minZ >= a.maxZ + probe.reach || b.maxZ <= a.minZ - probe.reach) continue;
      visited[j] = true;
      reached++;
      queue.push(j);
    }
  }
  return { ok: false, nodes: nodes.length, reached, reason: 'top stratum unreachable from the entry' };
}
