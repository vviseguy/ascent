import { describe, it, expect } from 'vitest';
import { makeGrid, at, begin, stamp, txConflicts, commit, rollback, applyBatch, collapseGrid, resolveGrid, tileView, type TileGrid } from './tile-grid.ts';
import { template, segs, collapse, fullField, type TileField } from './wall-tile-field.ts';

const wallN = template({ edge: { N: segs('wall') } }); // a stamp: edge.N must be wall
const noneN = template({ edge: { N: segs('none') } }); // a stamp: edge.N must be none

const edgeN = (g: TileGrid, x: number, y: number): string => collapse(at(g, x, y))!.edge.N;

describe('tile-grid — basics', () => {
  it('a fresh grid is all-fullField (every cell collapses to the canonical tile)', () => {
    const g = makeGrid(3, 2);
    expect(g.cells).toHaveLength(6);
    expect(edgeN(g, 2, 1)).toBe('none');
  });
});

describe('tile-grid — transactions: commit / rollback', () => {
  it('a committed stamp lands; an uncommitted one does not', () => {
    const g = makeGrid(2, 2);
    const tx = begin(g);
    stamp(tx, { x: 0, y: 0, w: 1, h: 1 }, wallN);
    expect(edgeN(g, 0, 0)).toBe('none'); // not applied until commit
    expect(commit(tx)).toBe(true);
    expect(edgeN(g, 0, 0)).toBe('wall'); // now applied
  });

  it('rollback discards the staged changes — grid untouched', () => {
    const g = makeGrid(2, 2);
    const tx = begin(g);
    stamp(tx, { x: 0, y: 0, w: 2, h: 2 }, wallN);
    rollback(tx);
    expect(commit(tx)).toBe(true); // nothing staged → trivially commits
    expect(edgeN(g, 0, 0)).toBe('none');
  });
});

describe('tile-grid — ATOMICITY: a conflict rolls back the whole batch', () => {
  it('two incompatible stamps over the same cell → commit fails, grid completely unchanged', () => {
    const g = makeGrid(3, 1);
    const tx = begin(g);
    stamp(tx, { x: 0, y: 0, w: 2, h: 1 }, wallN); // cells (0,0),(1,0) → edge.N wall
    stamp(tx, { x: 1, y: 0, w: 2, h: 1 }, noneN); // cells (1,0),(2,0) → edge.N none  → (1,0) clashes
    const conflicts = txConflicts(tx);
    expect(conflicts).toEqual([{ x: 1, y: 0, cells: ['edge.N'] }]);
    expect(commit(tx)).toBe(false); // atomic: nothing lands
    expect(edgeN(g, 0, 0)).toBe('none'); // (0,0) was fine but is NOT applied — all-or-nothing
    expect(edgeN(g, 2, 0)).toBe('none');
  });

  it('write multiple NON-conflicting rooms at once → all land', () => {
    const g = makeGrid(4, 1);
    const { ok, conflicts } = applyBatch(g, [
      { region: { x: 0, y: 0, w: 2, h: 1 }, stamp: wallN },
      { region: { x: 2, y: 0, w: 2, h: 1 }, stamp: noneN },
    ]);
    expect(ok).toBe(true);
    expect(conflicts).toEqual([]);
    expect(edgeN(g, 1, 0)).toBe('wall');
    expect(edgeN(g, 2, 0)).toBe('none');
  });

  it('applyBatch with an overlapping clash → ok=false and nothing changed', () => {
    const g = makeGrid(3, 1);
    const before = edgeN(g, 0, 0);
    const { ok, conflicts } = applyBatch(g, [
      { region: { x: 0, y: 0, w: 2, h: 1 }, stamp: wallN },
      { region: { x: 1, y: 0, w: 2, h: 1 }, stamp: noneN },
    ]);
    expect(ok).toBe(false);
    expect(conflicts.length).toBe(1);
    expect(edgeN(g, 0, 0)).toBe(before);
  });
});

describe('tile-grid — collapse', () => {
  it('collapseGrid yields one tile per cell; a seeded pick stays in-domain', () => {
    const g = makeGrid(2, 1);
    // narrow (0,0) to edge.N in {none, wall}; leave (1,0) open
    const both: TileField = template({ edge: { N: segs('none', 'wall') } });
    expect(applyBatch(g, [{ region: { x: 0, y: 0, w: 1, h: 1 }, stamp: both }]).ok).toBe(true);
    const tiles = collapseGrid(g, (x) => (x === 0 ? 1 : 0)); // (0,0) picks 2nd option of {none,wall}=wall
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.edge.N).toBe('wall');
    expect(tiles[1]!.edge.N).toBe('none');
  });
});

describe('tile-grid — resolveGrid (owner-resolved shared edges, §12 #4)', () => {
  it('a shared edge resolves to its OWNER: A.edge.E === B.edge.W (the east neighbour wins)', () => {
    const g = makeGrid(2, 1);
    // B (east) owns the shared boundary via its W; stamp it to wall. A (west) keeps its own E = none.
    expect(applyBatch(g, [{ region: { x: 1, y: 0, w: 1, h: 1 }, stamp: template({ edge: { W: segs('wall') } }) }]).ok).toBe(true);
    const tiles = resolveGrid(g);
    expect(tiles[1]!.edge.W).toBe('wall'); // the owner
    expect(tiles[0]!.edge.E).toBe('wall'); // A reads the owner, NOT its own canonical 'none'
  });

  it('the east/south MAP borders resolve to the PERIMETER wall', () => {
    const tiles = resolveGrid(makeGrid(2, 2)); // all fullField → canonical edges = none
    expect(tiles[1]!.edge.E).toBe('wall'); // (1,0): east border
    expect(tiles[2]!.edge.S).toBe('wall'); // (0,1): south border
    expect(tiles[3]!.edge.E).toBe('wall'); // (1,1): the SE corner — both borders
    expect(tiles[3]!.edge.S).toBe('wall');
    expect(tiles[0]!.edge.E).toBe('none'); // (0,0): interior shared edge = neighbour's W = none
    expect(tiles[0]!.edge.S).toBe('none');
  });

  it('owned N/W come from the tile itself (never a neighbour)', () => {
    const g = makeGrid(2, 1);
    expect(applyBatch(g, [{ region: { x: 0, y: 0, w: 1, h: 1 }, stamp: template({ edge: { N: segs('wall'), W: segs('barrier') } }) }]).ok).toBe(true);
    const t = resolveGrid(g)[0]!;
    expect(t.edge.N).toBe('wall');
    expect(t.edge.W).toBe('barrier');
  });

  it('a conflicted neighbour resolves like a border → PERIMETER (no crash)', () => {
    const g = makeGrid(2, 1);
    const broken = fullField();
    broken.edge.N = 0; // empty domain → collapse returns null
    g.cells[1] = broken;
    const tiles = resolveGrid(g);
    expect(tiles[1]).toBeNull(); // the conflicted cell
    expect(tiles[0]!.edge.E).toBe('wall'); // its west neighbour sees PERIMETER, not the null
  });

  it('tileView matches the resolveGrid entry for the same cell', () => {
    const g = makeGrid(3, 2);
    expect(applyBatch(g, [{ region: { x: 1, y: 0, w: 1, h: 1 }, stamp: template({ edge: { W: segs('wall') } }) }]).ok).toBe(true);
    const all = resolveGrid(g);
    expect(tileView(g, 0, 0)!.edge.E).toBe(all[0]!.edge.E);
    expect(tileView(g, 1, 0)!.edge.W).toBe(all[1]!.edge.W);
  });
});
