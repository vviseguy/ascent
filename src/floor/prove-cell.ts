// ============================================================================
// src/floor/prove-cell.ts — STANDALONE proof of the 2u cell generator.
// ============================================================================
// Runs with no dependencies: `node --experimental-strip-types src/floor/prove-cell.ts`.
// Fuzzes the generator across the seed/size space and checks, for every floor, that it is
// deterministic, TOTAL (fully settled), and SOLVABLE — the last agreed by an independent walk of the
// collapsed cells, not by the domain machinery that built them. Then the non-vacuity controls: a
// generator that accepted every proposal would pass the first three and fail these.

import { generateEmergent, resolveEmergent } from './cell-emergent.ts';
import { buildCellGraph, reachableFrom } from './cell-graph.ts';
import { domainSize, FIELD_KEYS, hasConflict } from './cell-field.ts';
import { listStructures } from './cell-structures.ts';
import type { Cell } from './cell.ts';

let floors = 0, settled = 0, deterministic = 0, exitOk = 0, roomsOk = 0, wholeOk = 0;
let placed = 0, walls = 0, doors = 0, sealed = 0, refused = 0;

const SIZES: [number, number][] = [[24, 20], [30, 24], [36, 28]];
for (const [w, h] of SIZES) {
  for (let i = 0; i < 12; i++) {
    const seed = BigInt(i * 7919 + w * 31 + 1);
    const r = generateEmergent({ width: w, height: h, seed });
    const cells = resolveEmergent(r, seed) as (Cell | null)[];
    floors++;

    if (r.grid.cells.every((f) => !hasConflict(f) && FIELD_KEYS.every((k) => domainSize(f[k]) === 1))) settled++;
    if (JSON.stringify(generateEmergent({ width: w, height: h, seed }).grid) === JSON.stringify(r.grid)) deterministic++;

    const seen = reachableFrom(buildCellGraph(cells, w, h), r.entry);
    if (seen[r.exit]) exitOk++;
    if (r.placed.every((p) => seen[p.centre])) roomsOk++;
    if (seen.filter(Boolean).length / (w * h) > 0.95) wholeOk++;

    placed += r.stats.structuresPlaced;
    walls += r.stats.wallsPlaced;
    doors += r.stats.doorsKept;
    sealed += r.stats.ringSealed;
    refused += r.stats.wallsRejectedUnreachable + r.stats.wallsRejectedConflict + r.stats.structuresRejectedOverlap;
  }
}

const controls: { name: string; pass: boolean; detail: string }[] = [];
controls.push({
  name: 'the gates refuse real proposals',
  pass: refused > floors,
  detail: `${refused} proposal(s) rejected across ${floors} floors`,
});
controls.push({
  name: 'structures are placed, and they are the authored ones',
  pass: placed > floors && listStructures().length > 0,
  detail: `${placed} placements from ${listStructures().length} authored structures`,
});
controls.push({
  name: 'rooms are opened, not sealed — doors are what refuses to close',
  pass: sealed > 0 && doors > 0,
  detail: `${sealed} perimeter walls sealed, ${doors} refused (those are the doors)`,
});
controls.push({
  name: 'the floors are actually walled (not empty rooms)',
  pass: walls > floors * 20,
  detail: `${walls} walls placed over ${floors} floors`,
});

// the WEAK gate, kept as the reason the strong one exists
{
  const r = generateEmergent({ width: 30, height: 24, seed: 23n, maze: { kind: 'scatter', braid: 0 } });
  const cells = resolveEmergent(r, 23n) as (Cell | null)[];
  const seen = reachableFrom(buildCellGraph(cells, 30, 24), r.entry);
  const pct = seen.filter(Boolean).length / (30 * 24);
  controls.push({
    name: '...but a TARGET-ONLY gate strands much of the floor (why the carvers exist)',
    pass: pct < 0.9,
    detail: `${Math.round(pct * 100)}% of cells reachable`,
  });
}

console.log('ASCENT 2u cell generator — STANDALONE PROOF');
console.log(`floors generated             : ${floors}`);
console.log(`  fully SETTLED              : ${settled}/${floors}   (no domain left undecided)`);
console.log(`  DETERMINISTIC              : ${deterministic}/${floors}`);
console.log(`  exit reachable             : ${exitOk}/${floors}   (independent walk of collapsed cells)`);
console.log(`  every structure reachable  : ${roomsOk}/${floors}`);
console.log(`  >95% of the floor reachable: ${wholeOk}/${floors}`);
console.log(`  totals: ${placed} structures, ${walls} walls, ${doors} doors`);
console.log('');
console.log('NON-VACUITY CONTROLS (a generator that accepted everything would fail these):');
for (const c of controls) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);

const ok = settled === floors && deterministic === floors && exitOk === floors
  && roomsOk === floors && wholeOk === floors && controls.every((c) => c.pass);
console.log('');
if (ok) {
  console.log('RESULT: PASS - every floor settles to a fully-determined field whose exit and every');
  console.log('        authored structure are reachable, agreed by an independent walk over the');
  console.log('        collapsed cells, and the gates demonstrably refuse real proposals.');
  process.exit(0);
}
console.log('RESULT: FAIL');
process.exit(1);
