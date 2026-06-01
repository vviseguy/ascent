// ============================================================================
// Standalone PROOF for the spatial index.
//   Run:  node --experimental-strip-types src/sim/spatial/prove.ts
// ============================================================================
//
// The spatial index is derived state with two contracts that must hold for both
// correctness and determinism:
//
//   PROOF 1 — QUERY CORRECTNESS. The grid's queryRadius / queryAABB return EXACTLY
//             the same id sets as a brute-force O(n^2) reference scan, across many
//             random scenes and query regions. (The acceleration structure must
//             not drop or invent bodies.)
//
//   PROOF 2 — CANDIDATE-PAIR COMPLETENESS. Every pair of bodies that actually
//             overlap (circle-vs-circle on the ground plane) is reported by
//             eachCandidatePair. (Broadphase must never miss a real collision; it
//             may over-report, which the narrowphase filters.) Requires cellSize >=
//             max body diameter, which we assert in the test config.
//
//   PROOF 3 — DETERMINISM & ORDER. Two rebuilds of the same scene yield identical
//             query outputs, query outputs are strictly ascending, and the pair
//             walk yields a stable ordered list.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass, type WorldState } from '../world/state.ts';
import { GridIndex } from './grid.ts';
import { fromFloatConst, fromInt, toRaw, ONE_RAW, idivFloor } from '../fixed/fixed.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mulRaw(a: number, b: number): number {
  const ah = Math.floor(a / ONE_RAW);
  const al = a - ah * ONE_RAW;
  return ah * b + idivFloor(al * b, ONE_RAW);
}

/** Build a random scene of n bodies spread over a region. Deterministic from seed. */
function makeScene(rnd: () => number, n: number): WorldState {
  const w = createWorld(Math.max(64, n));
  for (let i = 0; i < n; i++) {
    spawnBody(w, {
      px: fromInt(Math.floor((rnd() * 2 - 1) * 20)),
      py: fromInt(0),
      pz: fromInt(Math.floor((rnd() * 2 - 1) * 20)),
      radius: fromFloatConst(0.3 + rnd() * 0.4),
      halfHeight: fromFloatConst(0.5),
      massClass: MassClass.Light,
      flags: BodyFlag.Throwable,
    });
  }
  // kill a few to ensure dead-slot handling is exercised
  for (let i = 0; i < n; i += 7) w.flags[i] = 0;
  return w;
}

function bruteRadius(w: WorldState, x: number, z: number, r: number): number[] {
  const out: number[] = [];
  const r2 = mulRaw(r, r);
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    const dx = w.px[i]! - x;
    const dz = w.pz[i]! - z;
    if (mulRaw(dx, dx) + mulRaw(dz, dz) <= r2) out.push(i);
  }
  return out;
}
function bruteAABB(w: WorldState, a: number, b: number, c: number, d: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    const x = w.px[i]!, z = w.pz[i]!;
    if (x >= a && x <= c && z >= b && z <= d) out.push(i);
  }
  return out;
}
const eqArr = (p: number[], q: number[]): boolean =>
  p.length === q.length && p.every((v, i) => v === q[i]);
const ascending = (p: number[]): boolean => p.every((v, i) => i === 0 || v > p[i - 1]!);

let failures = 0;
const log = (s: string) => console.log(s);
log('----------------------------------------------------------------');
log('ASCENT spatial index — STANDALONE PROOF');
log('----------------------------------------------------------------');

const rnd = mulberry32(0x5a71a1);
const grid = new GridIndex(fromFloatConst(2)); // cell 2m >= max diameter (~1.4m)
const out: number[] = [];

// PROOF 1 — query correctness vs brute force
let p1 = true, queries = 0;
for (let s = 0; s < 200; s++) {
  const w = makeScene(rnd, 30 + Math.floor(rnd() * 60));
  grid.rebuild(w);
  for (let q = 0; q < 20; q++) {
    const x = fromInt(Math.floor((rnd() * 2 - 1) * 22));
    const z = fromInt(Math.floor((rnd() * 2 - 1) * 22));
    const r = fromFloatConst(1 + rnd() * 8);
    grid.queryRadius(toRaw(x), toRaw(z), toRaw(r), out);
    if (!eqArr(out, bruteRadius(w, toRaw(x), toRaw(z), toRaw(r))) || !ascending(out)) p1 = false;
    const a = toRaw(fromInt(-10)), b = toRaw(fromInt(-10)), c = toRaw(fromInt(10)), d = toRaw(fromInt(10));
    grid.queryAABB(a, b, c, d, out);
    if (!eqArr(out, bruteAABB(w, a, b, c, d)) || !ascending(out)) p1 = false;
    queries += 2;
  }
}
log(`PROOF 1 query correctness vs brute force (${queries} queries): ${p1 ? 'PASS' : 'FAIL'}`);
if (!p1) failures++;

// PROOF 2 — candidate-pair completeness: every truly-overlapping pair is reported
let p2 = true, scenes2 = 0;
for (let s = 0; s < 300; s++) {
  const w = makeScene(rnd, 20 + Math.floor(rnd() * 50));
  grid.rebuild(w);
  // collect reported pairs
  const reported = new Set<number>();
  grid.eachCandidatePair((a, b) => reported.add(a * 100000 + b));
  // brute-force the truly-overlapping pairs and ensure each is reported
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    for (let j = i + 1; j < w.count; j++) {
      if ((w.flags[j]! & BodyFlag.Alive) === 0) continue;
      const dx = w.px[i]! - w.px[j]!;
      const dz = w.pz[i]! - w.pz[j]!;
      const rsum = w.radius[i]! + w.radius[j]!;
      if (mulRaw(dx, dx) + mulRaw(dz, dz) <= mulRaw(rsum, rsum)) {
        if (!reported.has(i * 100000 + j)) p2 = false;
      }
    }
  }
  scenes2++;
}
log(`PROOF 2 candidate-pair completeness (${scenes2} scenes): ${p2 ? 'PASS' : 'FAIL'}`);
if (!p2) failures++;

// PROOF 3 — determinism + ordering of the pair walk
let p3 = true;
{
  const w = makeScene(mulberry32(7), 80);
  grid.rebuild(w);
  const a: number[] = [];
  grid.eachCandidatePair((x, y) => { if (x >= y) p3 = false; a.push(x * 100000 + y); });
  grid.rebuild(w);
  const b: number[] = [];
  grid.eachCandidatePair((x, y) => b.push(x * 100000 + y));
  if (!eqArr(a, b)) p3 = false;
}
log(`PROOF 3 determinism + a<b pair ordering: ${p3 ? 'PASS' : 'FAIL'}`);
if (!p3) failures++;

log('----------------------------------------------------------------');
if (failures === 0) {
  log('RESULT: PASS — spatial index matches brute force, never misses an overlap,');
  log('        and is deterministic with ascending output order.');
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(0);
} else {
  log(`RESULT: FAIL — ${failures} property(ies) failed.`);
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
}
