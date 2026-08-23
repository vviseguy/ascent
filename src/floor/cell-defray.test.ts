// De-fraying must not eat what an author drew.
//
// The pass exists to take nubs off, and it did that job so enthusiastically that it removed the
// structures' own walls along with them — 181 of 974 asserted walls gone by the time a floor rendered,
// and `odd wall section`, a piece that is nothing BUT a wall, lost 42% of itself. These tests pin the
// end-to-end property, because the unit-level one (does `defray` respect `keep`?) would have passed
// throughout: the bug was that nobody was passing anything.

import { describe, it, expect } from 'vitest';
import { generateEmergent } from './cell-emergent.ts';
import { resolveFloor, defray, structureWalls } from './cell-defray.ts';
import { resolveGrid } from './cell-grid.ts';
import { getStructure } from './cell-structures.ts';
import { orientStructure } from './cell-orient.ts';
import { segs } from './cell-field.ts';
import { openCell, type Cell } from './cell.ts';

const NONE = segs('none');
const W = 36, H = 28;

/** Every wall a placed structure ASSERTED, and whether it is still there. */
function survey(seed: bigint): { drawn: number; kept: number; worst: string } {
  const r = generateEmergent({ width: W, height: H, seed });
  const cells = resolveFloor(r);
  let drawn = 0, kept = 0;
  const lost = new Map<string, number>();

  for (const p of r.placed) {
    const base = getStructure(p.name);
    if (!base) continue;
    const st = orientStructure(base, p.orientation);
    const sw = st.w + 1, sh = st.h + 1;
    for (let ly = 0; ly < sh; ly++) {
      for (let lx = 0; lx < sw; lx++) {
        const f = st.cells[ly * sw + lx];
        if (!f) continue;
        const g = cells[(p.region.y + ly) * W + (p.region.x + lx)];
        // the outermost ring is deliberately made porous so SEAL can cut doors through it; only the
        // walls the generator never offered up are the ones that must survive untouched
        const onRing = lx === 0 || ly === 0 || lx === st.w || ly === st.h;
        if (onRing) continue;
        if (lx < st.w && (f.wallN & NONE) === 0) { drawn++; if (g?.wallN !== 'none') kept++; else lost.set(p.name, (lost.get(p.name) ?? 0) + 1); }
        if (ly < st.h && (f.wallW & NONE) === 0) { drawn++; if (g?.wallW !== 'none') kept++; else lost.set(p.name, (lost.get(p.name) ?? 0) + 1); }
      }
    }
  }
  const worst = [...lost].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} lost ${c}`).join(', ');
  return { drawn, kept, worst };
}

describe('cell-defray — an authored wall is not fraying', () => {
  it.each([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])('seed %s keeps every asserted structure wall', (seed) => {
    const { drawn, kept, worst } = survey(seed);
    expect(drawn).toBeGreaterThan(0);           // the test would be vacuous if nothing were asserted
    expect({ kept, worst }).toEqual({ kept: drawn, worst: '' });
  });

  it('still takes nubs off — the exemption did not turn the pass into a no-op', () => {
    // a lone wall segment with both ends in mid-air, nowhere near a structure
    const cells: (Cell | null)[] = Array.from({ length: 25 }, () => openCell());
    cells[12]!.wallN = 'wall';
    const stats = defray(cells, 5, 5, 2);
    expect(stats.removed[0]).toBe(1);
    expect(cells[12]!.wallN).toBe('none');
  });

  it('protects a segment only where a structure actually asserted one', () => {
    const r = generateEmergent({ width: W, height: H, seed: 1n });
    const keep = structureWalls(r.placed);
    const p = r.placed[0]!;
    const st = orientStructure(getStructure(p.name)!, p.orientation);
    const sw = st.w + 1;
    // find an asserted wall and an unasserted one, and check the predicate tells them apart
    let asserted: [number, number] | null = null, blank: [number, number] | null = null;
    for (let ly = 0; ly < st.h && (!asserted || !blank); ly++) {
      for (let lx = 0; lx < st.w && (!asserted || !blank); lx++) {
        const f = st.cells[ly * sw + lx]!;
        const at: [number, number] = [p.region.x + lx, p.region.y + ly];
        if ((f.wallN & NONE) === 0) asserted ??= at; else blank ??= at;
      }
    }
    expect(asserted).not.toBeNull();
    expect(keep(asserted![0], asserted![1], 'N')).toBe(true);
    if (blank) expect(keep(blank[0], blank[1], 'N')).toBe(false);
  });

  it('resolveFloor and a bare resolveGrid differ ONLY by the nubs', () => {
    const r = generateEmergent({ width: W, height: H, seed: 3n });
    const raw = resolveGrid(r.grid);
    const done = resolveFloor(r);
    let removed = 0, added = 0;
    for (let i = 0; i < raw.length; i++) {
      for (const side of ['wallN', 'wallW'] as const) {
        const a = raw[i]?.[side] ?? 'none', b = done[i]?.[side] ?? 'none';
        if (a !== 'none' && b === 'none') removed++;
        if (a === 'none' && b !== 'none') added++;
      }
    }
    expect(added).toBe(0);                       // de-fraying only ever takes away
    expect(removed).toBeGreaterThan(0);          // ...and it is still doing something
  });
});
