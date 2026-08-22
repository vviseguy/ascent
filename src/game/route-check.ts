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
// LATERAL BLOCKERS ARE CHECKED. Two adjacent floor slabs are adjacent whether or
// not a wall stands between them, so without this the graph happily routes
// straight through walls. On the 4u tower that was survivable — its rooms are
// open and PROOF 8 walks a hand-picked path along seams known to be clear — but a
// 2u floor is a maze whose walls ARE the layout, and the check cheerfully claimed
// routes that a body then wedged against on the first step it tried.
//
// So an edge a->b now also asks whether a body can fit through the seam between
// them: sample across the shared span at standing height and require a contiguous
// clear run at least a body wide. Still an approximation — it tests the seam, not
// the whole swept path — so the input-driven climbs (PROOF 8 for 4u, PROOF 9 for
// 2u) remain the thing that actually settles it.
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

/**
 * The same probe for a tower built on AUTHORED staircases — identical but for `minSide`.
 *
 * THE ART'S STAIRCASES ARE 45 DEGREES: every stair mesh in the kit climbs 4.00 over a 4.00 run, in
 * eight treads, so a tread is 0.5 deep. `ANCHOR_PROBE.minSide` is 0.8, which rejects them — not
 * because they are unclimbable but because `minSide` asks whether ONE surface is big enough to stand
 * on, and nobody stands on one tread of a staircase. You stand across several, which a per-surface
 * minimum cannot express.
 *
 * The 4u tower never hit this: its staircase is synthesised at roughly 29 degrees, with treads deeper
 * than the art's. So the threshold is not being loosened to make a proof pass — it is being told the
 * tread size of the stairs it is actually looking at. Every other constraint (the 0.6 rise it can hop,
 * the headroom, the reach) is unchanged, and those are the ones that decide climbability.
 */
export const CELL_PROBE: RouteProbe = { ...ANCHOR_PROBE, minSide: 0.45 };

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
  /**
   * The route itself when `ok` — the centre and height of each standable surface along it, entry
   * first. A body can be DRIVEN along this, which is the difference between "a path exists in the
   * graph" and "a body can physically follow it": the graph does not model lateral blockers, so the
   * two can disagree, and only walking it finds out.
   */
  path: { x: number; z: number; top: number }[];
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
  if (!e0) return { ok: false, nodes: nodes.length, reached: 0, reason: 'no stratum-0 entry', path: [] };
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
  if (start < 0) return { ok: false, nodes: nodes.length, reached: 0, reason: 'no standable node at the entry', path: [] };

  // --- goal: a REAL floor surface (not a stair tread) at the top stratum's base ---
  const isGoal = (n: StandNode): boolean =>
    Math.abs(n.top - baseTop) <= 0.02 && (n.maxX - n.minX) * (n.maxZ - n.minZ) >= 2.0;

  // --- BFS over node adjacency; candidates from the spatial bucket (reach-expanded
  // rect), so each step scans only nearby nodes instead of all of them. Same edges as
  // the exhaustive scan (the rect is the exact adjacency test's bounding box). ---
  /**
   * Can a body get from one surface to the other, or is something standing in the way?
   *
   * The seam is the span the two surfaces share, on the axis they meet across. Sampling it at
   * standing height and looking for a contiguous clear run at least a body wide is what tells a
   * doorway apart from a wall — both of which look identical to a pair of adjacent rectangles.
   *
   * Only asked of surfaces at the SAME height; see the call site for why.
   */
  const SAMPLE = 0.1;
  const bodyWide = probe.shrink * 2;
  function seamBlocked(a: StandNode, b: StandNode): boolean {
    const y0 = Math.max(a.top, b.top) + 0.05;
    const y1 = y0 + probe.headroom * 0.55; // knee to chest — where a wall would stop you
    // which axis do they meet across? the one where they do NOT overlap
    const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    const acrossX = overlapX < overlapZ;
    const seam = acrossX
      ? (a.maxX <= b.minX ? (a.maxX + b.minX) / 2 : (b.maxX + a.minX) / 2)
      : (a.maxZ <= b.minZ ? (a.maxZ + b.minZ) / 2 : (b.maxZ + a.minZ) / 2);
    const lo = acrossX ? Math.max(a.minZ, b.minZ) : Math.max(a.minX, b.minX);
    const hi = acrossX ? Math.min(a.maxZ, b.maxZ) : Math.min(a.maxX, b.maxX);
    if (hi - lo < bodyWide) return true; // the shared span is narrower than the body

    const near: number[] = [];
    const seen = new Set<number>();
    const px0 = acrossX ? seam - SAMPLE : lo, px1 = acrossX ? seam + SAMPLE : hi;
    const pz0 = acrossX ? lo : seam - SAMPLE, pz1 = acrossX ? hi : seam + SAMPLE;
    gatherBoxes(px0, px1, pz0, pz1, seen, near);

    let run = 0;
    for (let t = lo; t <= hi; t += SAMPLE) {
      const x = acrossX ? seam : t;
      const z = acrossX ? t : seam;
      let hit = false;
      for (const bi of near) {
        const s2 = solids[bi]!;
        if (F(s2.maxY) <= y0 || F(s2.minY) >= y1) continue;
        if (x <= F(s2.minX) || x >= F(s2.maxX) || z <= F(s2.minZ) || z >= F(s2.maxZ)) continue;
        hit = true; break;
      }
      if (hit) { run = 0; continue; }
      run += SAMPLE;
      if (run >= bodyWide - 1e-9) return false; // a gap wide enough to walk through
    }
    return true;
  }

  const visited = new Array<boolean>(nodes.length).fill(false);
  const prev = new Array<number>(nodes.length).fill(-1);
  const queue: number[] = [start];
  visited[start] = true;
  let head = 0;
  let reached = 1;
  const aSeen = new Set<number>();
  const aOut: number[] = [];
  /** Walk `prev` back to the start; the centre of each surface, entry first. */
  const trace = (end: number): { x: number; z: number; top: number }[] => {
    const out: { x: number; z: number; top: number }[] = [];
    for (let i = end; i >= 0; i = prev[i]!) {
      const n = nodes[i]!;
      out.push({ x: (n.minX + n.maxX) / 2, z: (n.minZ + n.maxZ) / 2, top: n.top });
    }
    return out.reverse();
  };
  while (head < queue.length) {
    const ai = queue[head++]!;
    const a = nodes[ai]!;
    if (isGoal(a)) return { ok: true, nodes: nodes.length, reached, reason: '', path: trace(ai) };
    gatherNodes(a.minX - probe.reach, a.maxX + probe.reach, a.minZ - probe.reach, a.maxZ + probe.reach, aSeen, aOut);
    for (const j of aOut) {
      if (visited[j]) continue;
      const b = nodes[j]!;
      if (b.top - a.top > probe.maxStep) continue; // too high to hop (drops are free)
      if (b.minX >= a.maxX + probe.reach || b.maxX <= a.minX - probe.reach) continue;
      if (b.minZ >= a.maxZ + probe.reach || b.maxZ <= a.minZ - probe.reach) continue;
      // ONLY BETWEEN SURFACES AT THE SAME HEIGHT. Something standing above the seam between two
      // level surfaces is a wall; between surfaces at different heights it is usually the STEP
      // itself — a staircase's higher treads sit above its lower ones, which is what a staircase is.
      // Telling those apart needs the swept-path model this check explicitly is not, so a hop is
      // left to the input-driven climbs to falsify. (Applying it to hops rejected the 4u tower's own
      // staircase, which PROOF 8 demonstrably walks.)
      if (Math.abs(b.top - a.top) < 0.05 && seamBlocked(a, b)) continue;
      visited[j] = true;
      prev[j] = ai;
      reached++;
      queue.push(j);
    }
  }
  // diagnostic: how high did it actually get, and onto what?
  let best = -Infinity;
  for (let i = 0; i < nodes.length; i++) if (visited[i] && nodes[i]!.top > best) best = nodes[i]!.top;
  return {
    ok: false, nodes: nodes.length, reached,
    reason: `top stratum unreachable from the entry (highest surface reached ${best.toFixed(2)}, goal ${baseTop.toFixed(2)})`,
    path: [],
  };
}
