import { writeFileSync } from 'node:fs';
import { STRUCTURES } from '../src/floor/structures.ts';
import { migrateStructure, type OldStructure } from '../src/floor/structure-migrate.ts';
import { resolveGrid } from '../src/floor/cell-grid.ts';
import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES } from '../src/floor/cell.ts';

const out: Record<string, { w: number; h: number; cells: unknown[]; from: string }> = {};
for (const [name, s] of Object.entries(STRUCTURES.structures)) {
  const old = s as unknown as OldStructure;
  const g = migrateStructure(old); // default 'abstain' border — a structure owns its interior
  const bad = resolveGrid(g).filter((c) => c === null).length;
  if (bad) throw new Error(`${name}: ${bad} cells failed to collapse`);
  // w/h are the FLOOR extent; the stored grid is the (w+1)x(h+1) point lattice
  out[name] = { w: g.w - 1, h: g.h - 1, cells: g.cells, from: `4u ${old.w}x${old.h}` };
  console.log(`  ${name.padEnd(18)} ${old.w}x${old.h} tiles → ${g.w - 1}x${g.h - 1} floor cells, ${g.w}x${g.h} stored (${g.cells.length})`);
}
// Record the value-set SIZES these masks were written against. A domain is a bitmask indexed by
// POSITION, so appending a value to any enum silently changes what an existing mask means.
const valueSets = { seg: SEGS.length, floor: FLOOR_MATERIALS.length, corner: CORNERS.length, wallType: WALL_TYPES.length };
writeFileSync('src/floor/cell-structures.json', JSON.stringify({ version: 2, valueSets, structures: out }, null, 2) + String.fromCharCode(10));
console.log('wrote src/floor/cell-structures.json');
