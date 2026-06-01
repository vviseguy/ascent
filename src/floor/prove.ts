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
import { verifyFloor } from './verify.ts';

interface Failure {
  config: FloorConfig & { seedStr: string };
  reasons: string[];
}

function run(): number {
  // --- knob space ---
  const gridSizes = [2, 3, 4, 5, 6, 8, 10, 12, 16];
  const opennessLevels = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const ks = [1, 2, 3, 4];
  const gateDensities = [0, 0.25, 0.5, 0.75, 1];
  const seedsPerCombo = 7; // total ~= 9*7*4*5*7 = 8820 floors

  let total = 0;
  let solvable = 0;
  let routesOk = 0;
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

            const result = verifyFloor(floor);
            total++;
            if (result.reachability.reachable) solvable++;
            if (result.routeCount.meetsClaim) routesOk++;

            if (!result.ok && failures.length < MAX_FAILURES_PRINTED) {
              failures.push({ config: { ...config, seedStr: seed.toString() }, reasons: result.failures });
            }
          }
        }
      }
    }
  }

  // --- report ---
  const line = '-'.repeat(64);
  console.log(line);
  console.log('ASCENT floor-gen + verifier - STANDALONE PROOF');
  console.log(line);
  console.log(`floors generated & verified : ${total}`);
  console.log(`  solvable (exit reachable) : ${solvable}/${total}`);
  console.log(`  route-count >= claimed k  : ${routesOk}/${total}`);
  console.log(`  floors with k clamped     : ${clampedCount} (expected on tiny grids / high k)`);
  console.log(line);

  const allPass = solvable === total && routesOk === total && failures.length === 0;
  if (allPass) {
    console.log('RESULT: PASS - every floor across the knob space is solvable and');
    console.log('        meets its guaranteed-route count (two independent methods agree).');
    console.log(line);
    return 0;
  }

  console.log(`RESULT: FAIL - ${failures.length} failing config(s) (showing up to ${MAX_FAILURES_PRINTED}):`);
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
