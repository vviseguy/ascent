// ============================================================================
// src/floor/prove-emergent.ts — STANDALONE proof for the all-emergent generator.
// ============================================================================
//
// Runs with zero dependencies:  node --experimental-strip-types src/floor/prove-emergent.ts
//
// What it proves, across the knob space (size × seed × wall budget):
//   1. DETERMINISM      — same config + seed ⇒ byte-identical field, twice.
//   2. TOTALITY         — the field always settles: no conflicted tile, every domain a singleton.
//   3. SOLVABILITY      — every target (exit + each room's middle) is reachable from the entry, checked
//                         TWICE and independently: pessimistically on the domain field, and by an
//                         ordinary BFS over the COLLAPSED tiles the renderer/collision would consume.
//   4. NON-VACUITY      — the gates refuse real proposals. A generator that accepted everything would
//                         pass (1)-(3) trivially, so this is the control that gives them meaning.
//
// The independence in (3) is the point: the generator decides using `may`/`must` over domains, and the
// check re-derives reachability from the finished tiles with none of that machinery. If the domain
// bookkeeping were wrong, the two would disagree.

import { generateEmergent, resolveEmergent, type EmergentConfig } from './emergent.ts';
import { buildCornerGraph, reachableFromSet, cornerCount, cornerId, cornerReachable } from './corner-graph.ts';
import { tileOpening } from './wall-tile.ts';
import { gridAt, reaches, routeGuaranteed } from './tile-reach.ts';
import { seamDisagreements } from './seams.ts';
import { domainSize } from './wall-tile-field.ts';
import { DIRS } from './wall-tile.ts';

interface Failure { config: string; detail: string }
const failures: Failure[] = [];
const fail = (config: string, detail: string): void => { failures.push({ config, detail }); };

const SIZES: readonly (readonly [number, number])[] = [[8, 8], [12, 10], [16, 14], [20, 16], [24, 20]];
const SEEDS: readonly bigint[] = [1n, 2n, 3n, 5n, 7n, 11n, 13n, 17n, 23n, 42n];

let floors = 0;
let settled = 0;
let solvableField = 0;
let solvableTiles = 0;
let deterministic = 0;
let totalRooms = 0;
let totalWalls = 0;
let totalDoors = 0;
let rejectedUnreachable = 0;
let rejectedConflict = 0;
let cohered = 0;
let seamDrift = 0;

for (const [w, h] of SIZES) {
  for (const seed of SEEDS) {
    const cfg: EmergentConfig = { width: w, height: h, seed };
    const tag = `${w}x${h} seed=${seed}`;
    floors++;

    const r = generateEmergent(cfg);
    totalRooms += r.stats.roomsPlaced;
    totalWalls += r.stats.wallsPlaced;
    totalDoors += r.stats.doorsKept;
    rejectedUnreachable += r.stats.wallsRejectedUnreachable + r.stats.roomsRejectedUnreachable;
    rejectedConflict += r.stats.wallsRejectedConflict + r.stats.roomsRejectedConflict;
    cohered += r.stats.seamsCohered;
    seamDrift += seamDisagreements(r.grid, gridAt(r.grid)).length;

    // 1. determinism
    if (JSON.stringify(generateEmergent(cfg).grid) === JSON.stringify(r.grid)) deterministic++;
    else fail(tag, 'a second run produced a different field');

    // 2. totality — settled to singletons, no conflicted tile
    const tiles = resolveEmergent(r, seed);
    const nulls = tiles.filter((t) => t === null).length;
    let multi = 0;
    for (const c of r.grid.cells) {
      for (const d of DIRS) if (domainSize(c.inner[d]) !== 1) multi++;
      if (domainSize(c.edge.N) !== 1) multi++;
      if (domainSize(c.edge.W) !== 1) multi++;
    }
    if (nulls === 0 && multi === 0) settled++;
    else fail(tag, `not settled: ${nulls} conflicted tile(s), ${multi} undecided cell(s)`);

    // 3a. solvability on the DOMAIN field (pessimistic)
    const fieldOk = routeGuaranteed(gridAt(r.grid), r.route)
      && r.targets.every((t) => reaches(gridAt(r.grid), w, h, 'must', r.entryCorner, t));
    if (fieldOk) solvableField++;
    else fail(tag, 'a target is not GUARANTEED on the domain field');

    // 3b. solvability on the COLLAPSED tiles (independent BFS, no domain machinery)
    const seen = reachableFromSet(buildCornerGraph(tiles, w, h), [r.entryCorner]);
    const unreachable = r.targets.filter((t) => seen[t] !== true);
    if (unreachable.length === 0) solvableTiles++;
    else fail(tag, `${unreachable.length} target(s) unreachable on the collapsed tiles: ${unreachable.join(',')}`);
  }
}

// 4. NON-VACUITY controls
interface Control { name: string; pass: boolean; detail: string }
const controls: Control[] = [];

controls.push({
  name: 'the reachability gate refuses proposals',
  pass: rejectedUnreachable > 0,
  detail: `${rejectedUnreachable} proposal(s) rejected for breaking connectivity across the space`,
});
controls.push({
  name: 'the AND-gate refuses trespass (a wall proposed inside a room)',
  pass: rejectedConflict > 0,
  detail: `${rejectedConflict} proposal(s) rejected because a domain emptied — no policing code involved`,
});
controls.push({
  name: 'split-across-tile features are pulled into agreement',
  pass: cohered > floors * 100 && seamDrift < floors,
  detail: `${cohered} seams cohered, ${seamDrift} still disagree across ${floors} floors (<1 per floor)`,
});
// RENDER == GRAPH for openings. A door/arch draws a clear archway; if the graph still calls that
// tile's corners disconnected, the floor has walls you can see through and not walk through.
{
  let drawn = 0, connected = 0;
  for (const seed of [3n, 23n, 101n, 42n]) {
    const r = generateEmergent({ width: 18, height: 14, seed });
    const tiles = resolveEmergent(r, seed);
    const g = buildCornerGraph(tiles, 18, 14);
    tiles.forEach((t, i) => {
      if (!t || !tileOpening(t)) return;
      drawn++;
      const x = i % 18, y = Math.floor(i / 18);
      if (cornerReachable(g, cornerId(18, x, y), cornerId(18, x + 1, y + 1))) connected++;
    });
  }
  controls.push({
    name: 'every DRAWN opening is walkable in the graph (render == graph)',
    pass: drawn > 0 && connected === drawn,
    detail: `${connected}/${drawn} door/arch tiles have all four corners connected`,
  });
}

controls.push({
  name: 'the floors are actually walled (not empty rooms)',
  pass: totalWalls > floors * 20,
  detail: `${totalWalls} wall runs placed over ${floors} floors`,
});
controls.push({
  name: 'rooms are opened, not sealed',
  pass: totalDoors > 0 && totalRooms > 0,
  detail: `${totalRooms} rooms with ${totalDoors} door cells kept`,
});
// The old target-only gate, run deliberately over-walled: STILL solvable (the gate, not luck), but it
// seals off much of the floor — which is exactly why the carvers exist. Both facts asserted together.
{
  const stress: EmergentConfig = {
    width: 16, height: 14, seed: 99n,
    maze: { kind: 'scatter', braid: 0 }, wallAttempts: 16 * 14 * 20, maxRunLength: 8,
  };
  const r = generateEmergent(stress);
  const tiles = resolveEmergent(r, stress.seed);
  const g = buildCornerGraph(tiles, stress.width, stress.height);
  const seen = reachableFromSet(g, [r.entryCorner]);
  const pct = seen.filter(Boolean).length / cornerCount(stress.width, stress.height);
  controls.push({
    name: 'a 20x over-walled `scatter` floor is still solvable',
    pass: r.targets.every((t) => seen[t] === true),
    detail: `${r.stats.wallsPlaced} placed / ${r.stats.wallsRejectedUnreachable} refused by the gate`,
  });
  controls.push({
    name: '...but a target-only gate DOES strand most of the floor (why the carvers exist)',
    pass: pct < 0.7,
    detail: `${Math.round(pct * 100)}% of corners reachable`,
  });
}

// the default strategy must keep essentially the whole floor reachable
{
  let worst = 1;
  for (const seed of [3n, 23n, 101n, 42n]) {
    const r = generateEmergent({ width: 18, height: 14, seed });
    const tiles = resolveEmergent(r, seed);
    const seen = reachableFromSet(buildCornerGraph(tiles, 18, 14), [r.entryCorner]);
    worst = Math.min(worst, seen.filter(Boolean).length / cornerCount(18, 14));
  }
  controls.push({
    name: 'the DEFAULT carver leaves the floor essentially whole',
    pass: worst > 0.95,
    detail: `worst case ${Math.round(worst * 100)}% of corners reachable`,
  });
}

console.log('ASCENT emergent generator - STANDALONE PROOF');
console.log(`floors generated            : ${floors}`);
console.log(`  deterministic (2 runs)    : ${deterministic}/${floors}`);
console.log(`  settled (no undecided)    : ${settled}/${floors}`);
console.log(`  solvable on the FIELD     : ${solvableField}/${floors}`);
console.log(`  solvable on COLLAPSED     : ${solvableTiles}/${floors}   (independent BFS)`);
console.log(`  totals: ${totalRooms} rooms, ${totalWalls} wall runs, ${totalDoors} doors`);
console.log('');
console.log('NON-VACUITY CONTROLS (a generator that accepted everything would fail these):');
for (const c of controls) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);

const controlsOk = controls.every((c) => c.pass);
if (failures.length === 0 && controlsOk) {
  console.log('');
  console.log('RESULT: PASS - every emergent floor settles to a fully-determined field whose exit and');
  console.log('        every room are reachable, agreed by BOTH the domain check and an independent');
  console.log('        BFS over the collapsed tiles, and the gates demonstrably refuse real proposals.');
  process.exit(0);
} else {
  console.log('');
  if (failures.length) {
    console.log(`FAIL - ${failures.length} failure(s):`);
    for (const f of failures.slice(0, 10)) console.log(`  - ${f.config}: ${f.detail}`);
  }
  if (!controlsOk) console.log('FAIL - a NON-VACUITY control did not fire (the gates may be dead code).');
  process.exit(1);
}
