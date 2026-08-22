/**
 * src/floor/prove.ts — STANDALONE correctness proof (no deps, no vitest).
 *
 * Run with:  node --experimental-strip-types src/floor/prove.ts
 * (Node 22+, from the repo root). Imports ONLY relative paths within src/floor/ so
 * node's type-stripping needs no vite-alias resolution (CONVENTIONS / build brief).
 *
 * WHAT IT DOES: generates several thousand floors across the whole knob space
 * (multiple grid sizes, openness 0..1, k in 1..4, varied gate densities, many
 * seeds), runs the INDEPENDENT verifier on each, and asserts:
 *   - every floor is solvable (>=1 exit reachable via the fallback layer), and
 *   - the verifier's edge-disjoint route count >= the (clamped) k the generator
 *     guaranteed (two independent methods must agree).
 * Prints a clear PASS/FAIL summary with counts; on ANY failure it prints the exact
 * reproducing seed + config so the bug is one command away from reproduction.
 *
 * This lets correctness be demonstrated without installing anything.
 */

import { generateFloor, type FloorConfig } from './generate.ts';
import { verifyFloor, lockKeyReachable } from './verify.ts';
import type { Cell, Edge, Floor } from './types.ts';
import { cellId } from './types.ts';

interface Failure {
  config: FloorConfig & { seedStr: string };
  reasons: string[];
}

/* ----------------------- negative-control floor builders --------------------- */
//
// Tiny HAND-BUILT floors with a DELIBERATE flaw the lock-and-key verifier must catch.
// These are the non-vacuity check: a verifier that reports SOLVABLE for these is broken.
// All built on a small line/grid of cells with explicit edges so the structure is obvious.

/** Build a bare 1×N corridor floor: cells 0..N-1 in a row, WALK edges between neighbours. */
function lineFloor(n: number): Floor {
  const cells: Cell[] = [];
  for (let x = 0; x < n; x++) cells.push({ id: x, x, y: 0 });
  const edges: Edge[] = [];
  for (let x = 0; x + 1 < n; x++) {
    edges.push({ a: x, b: x + 1, kind: 'WALK', breakable: false, perimeter: true, spine: 0 });
  }
  return {
    width: n, height: 1, cells, edges,
    entry: 0, exits: [n - 1], guaranteedRoutes: 1,
    meta: { runSeed: '0', stratumIndex: 0, openness: 0, requestedRoutes: 1, clamped: false },
  };
}

interface NegCase { name: string; pass: boolean; detail: string }

/**
 * Run the negative + positive controls. Each negative case is constructed to be UNSOLVABLE
 * and must report solvable=false; one positive sanity case must report solvable=true (so we
 * know the checks aren't trivially always-false).
 */
function negativeControls(): { cases: NegCase[] } {
  const cases: NegCase[] = [];

  // (A) KEY SEALED BEHIND ITS OWN DOOR. Corridor entry=0 … exit=4. Lock the FIRST edge
  // (0–1) with door 0, then hide door-0's key at cell 3 — which is on the FAR side of the
  // very door it opens. The player can never pass door 0 to reach its key → UNSOLVABLE.
  {
    const f = lineFloor(5);
    f.lockedDoors = [{ a: 0, b: 1, doorId: 0 }];
    f.keys = [{ cell: 3, doorId: 0, source: 'LOOSE' }];
    const r = lockKeyReachable(f);
    cases.push({
      name: 'key sealed behind its own door',
      pass: !r.solvable,
      detail: r.solvable ? `WRONGLY solvable (reached ${r.reachedCount})` : `UNSOLVABLE as required (reached ${r.reachedCount} cells, keys [${r.keysAcquired.join(',')}])`,
    });
  }

  // (B) EXIT WALLED OFF. Corridor of 4 cells but DROP the last edge (2–3), so the exit
  // (cell 3) has no connection at all. No locks involved — pure unreachable exit.
  {
    const f = lineFloor(4);
    f.edges = f.edges.filter((e) => !(e.a === 2 && e.b === 3)); // sever the exit
    const r = lockKeyReachable(f);
    cases.push({
      name: 'exit walled off (no edge reaches it)',
      pass: !r.solvable,
      detail: r.solvable ? 'WRONGLY solvable' : `UNSOLVABLE as required (reached ${r.reachedCount}/4 cells)`,
    });
  }

  // (C) CIRCULAR KEY DEPENDENCY. Lock edge 1–2 with door 0 and edge 2–3 with door 1; put
  // door-0's key beyond door 1 (cell 3) and door-1's key beyond door 0 (cell 2). Each key
  // is behind the OTHER's door → neither can ever be obtained → UNSOLVABLE deadlock.
  {
    const f = lineFloor(5);
    f.lockedDoors = [{ a: 1, b: 2, doorId: 0 }, { a: 2, b: 3, doorId: 1 }];
    f.keys = [
      { cell: 3, doorId: 0, source: 'LOOSE' }, // key for door 0 sits past door 1
      { cell: 2, doorId: 1, source: 'RUG' }, // key for door 1 sits past door 0
    ];
    const r = lockKeyReachable(f);
    cases.push({
      name: 'circular key dependency (deadlock)',
      pass: !r.solvable,
      detail: r.solvable ? 'WRONGLY solvable' : `UNSOLVABLE as required (acquired keys [${r.keysAcquired.join(',')}])`,
    });
  }

  // (D) MISSING KEY. Lock edge 2–3 (door 0) but place NO key for it anywhere → the door
  // can never open and the exit beyond it is sealed → UNSOLVABLE.
  {
    const f = lineFloor(5);
    f.lockedDoors = [{ a: 2, b: 3, doorId: 0 }];
    f.keys = []; // no key exists for door 0
    const r = lockKeyReachable(f);
    cases.push({
      name: 'locked door with no key on the floor',
      pass: !r.solvable,
      detail: r.solvable ? 'WRONGLY solvable' : `UNSOLVABLE as required (reached ${r.reachedCount} cells)`,
    });
  }

  // (E) POSITIVE SANITY: a correctly-ordered chain MUST be solvable, so we know the
  // controls aren't trivially always-false. Lock edge 2–3 (door 0); put its key BEFORE
  // the door (cell 1, reachable from entry). Key → door → exit, in order → SOLVABLE.
  {
    const f = lineFloor(5);
    f.lockedDoors = [{ a: 2, b: 3, doorId: 0 }];
    f.keys = [{ cell: 1, doorId: 0, source: 'LOOSE' }];
    const r = lockKeyReachable(f);
    cases.push({
      name: 'POSITIVE: ordered key→door→exit chain',
      pass: r.solvable,
      detail: r.solvable ? `SOLVABLE as required (keys [${r.keysAcquired.join(',')}])` : 'WRONGLY unsolvable',
    });
  }

  return { cases };
}

// keep cellId referenced (handy for future grid-based controls)
void cellId;

function run(): number {
  // --- knob space (incl. gridSize 30 = the game's scale, so the puzzle placer + the
  // lock-and-key verifier are fuzzed at the real grid where chains actually fit) ---
  const gridSizes = [2, 3, 4, 5, 6, 8, 10, 12, 16, 30];
  const opennessLevels = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const ks = [1, 2, 3, 4];
  const gateDensities = [0, 0.25, 0.5, 0.75, 1];
  const seedsPerCombo = 7; // total ~= 10*7*4*5*7 = 9800 floors

  let total = 0;
  let solvable = 0;
  let routesOk = 0;
  let lockKeyOk = 0; // lock-and-key fixpoint reaches an exit
  let withPuzzle = 0; // floors that got an actual locked-door chain
  let totalDoors = 0;
  let rugKeys = 0;
  let clampedCount = 0;
  const failures: Failure[] = [];
  const MAX_FAILURES_PRINTED = 10;

  // Seeds derived from a counter → any failure is exactly reproducible.
  let seedCounter = 0n;
  for (const gridSize of gridSizes) {
    for (const openness of opennessLevels) {
      for (const k of ks) {
        for (const gateDensity of gateDensities) {
          for (let s = 0; s < seedsPerCombo; s++) {
            const seed = (seedCounter * 0x9e3779b97f4a7c15n + 0x1234567n) & 0xffffffffffffffffn;
            seedCounter += 1n;
            const stratumIndex = Number(seedCounter % 97n) | 0;

            const config: FloorConfig = {
              gridSize,
              openness,
              guaranteedRoutes: k,
              gateDensity,
              seed,
              stratumIndex,
            };

            const floor = generateFloor(config);
            if (floor.meta.clamped) clampedCount++;
            if (floor.lockedDoors && floor.lockedDoors.length) {
              withPuzzle++;
              totalDoors += floor.lockedDoors.length;
              for (const key of floor.keys ?? []) if (key.source === 'RUG') rugKeys++;
            }

            const result = verifyFloor(floor);
            total++;
            if (result.reachability.reachable) solvable++;
            if (result.routeCount.meetsClaim) routesOk++;
            if (result.lockKey.solvable) lockKeyOk++;

            if (!result.ok && failures.length < MAX_FAILURES_PRINTED) {
              failures.push({ config: { ...config, seedStr: seed.toString() }, reasons: result.failures });
            }
          }
        }
      }
    }
  }

  // --- NEGATIVE CONTROLS (non-vacuity): hand-built floors that MUST verify UNSOLVABLE.
  // A verifier that passes everything is worthless (docs/14 §3). These prove the
  // lock-and-key fixpoint actually REJECTS broken puzzles. ---
  const neg = negativeControls();

  // --- report ---
  const line = '-'.repeat(64);
  console.log(line);
  console.log('ASCENT floor-gen + verifier - STANDALONE PROOF');
  console.log(line);
  console.log(`floors generated & verified : ${total}`);
  console.log(`  solvable (exit reachable) : ${solvable}/${total}`);
  console.log(`  route-count >= claimed k  : ${routesOk}/${total}`);
  console.log(`  LOCK-AND-KEY solvable     : ${lockKeyOk}/${total}  (0 unsolvable required)`);
  console.log(`  floors with a keyed chain : ${withPuzzle}  (${totalDoors} doors, ${rugKeys} rug-hidden keys)`);
  console.log(`  floors with k clamped     : ${clampedCount} (expected on tiny grids / high k)`);
  console.log(line);
  console.log('NEGATIVE CONTROLS (must report UNSOLVABLE — proves the verifier is not vacuous):');
  for (const c of neg.cases) {
    console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  console.log(line);

  const fuzzPass = solvable === total && routesOk === total && lockKeyOk === total && failures.length === 0;
  const negPass = neg.cases.every((c) => c.pass);

  if (fuzzPass && negPass) {
    console.log('RESULT: PASS - every floor across the knob space is solvable (base reachability,');
    console.log('        route count, AND lock-and-key fixpoint all agree), and every negative');
    console.log('        control is correctly reported UNSOLVABLE (the verifier is non-vacuous).');
    console.log(line);
    return 0;
  }

  if (!fuzzPass) {
    console.log(`FAIL - ${failures.length} fuzz failure(s) (showing up to ${MAX_FAILURES_PRINTED}):`);
    for (const f of failures) {
      console.log('  - repro:');
      console.log(`      seed         = ${f.config.seedStr}n`);
      console.log(`      stratumIndex = ${f.config.stratumIndex}`);
      console.log(`      gridSize     = ${f.config.gridSize}`);
      console.log(`      openness     = ${f.config.openness}`);
      console.log(`      k (routes)   = ${f.config.guaranteedRoutes}`);
      console.log(`      gateDensity  = ${f.config.gateDensity}`);
      for (const r of f.reasons) console.log(`      reason       : ${r}`);
    }
  }
  if (!negPass) {
    console.log('FAIL - a NEGATIVE CONTROL did not report UNSOLVABLE (verifier is vacuous!):');
    for (const c of neg.cases) if (!c.pass) console.log(`      ${c.name}: ${c.detail}`);
  }
  console.log(line);
  return 1;
}

const exitCode = run();

// Exit with the proof's status code WITHOUT a hard compile-time dependency on the
// Node `process` global type (tsconfig "types" is ["vite/client"], no @types/node).
// At runtime under Node this sets the process exit code; under any other host it is
// a harmless no-op. We read it off globalThis to avoid referencing `process` by name.
const proc = (globalThis as { process?: { exitCode?: number } }).process;
if (proc) proc.exitCode = exitCode;
