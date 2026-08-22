import { describe, it, expect } from 'vitest';
import {
  openCell, wallOwner, openingWalls, blocks, cornerIsOpen,
  type Cell, type Dir, type WallType,
} from './cell.ts';
import {
  fullField, template, andGate, collapse, conflicts, hasConflict, isOpen, fromCell,
  segs, floors, wallTypes, domainSize,
} from './cell-field.ts';
import {
  makeGrid, at, begin, stamp, txConflicts, commit, rollback, applyBatch, resolveGrid,
  wallAt, canStep, type CellGrid,
} from './cell-grid.ts';
import { buildCellGraph, nodeId, reaches, reachableFrom, openingActive } from './cell-graph.ts';

const W = 5, H = 5;
const g0 = (): CellGrid => makeGrid(W, H);
/** A resolved grid of plain open cells, with a mutator for the interesting bits. */
const cells = (mutate: (c: Cell, x: number, y: number) => void = () => {}): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = openCell(); mutate(c, x, y); out.push(c); }
  return out;
};

describe('cell — single ownership is the ONLY rule', () => {
  it("a cell owns N and W; its S and E belong to the neighbour beyond", () => {
    expect(wallOwner(2, 2, 'N')).toEqual({ x: 2, y: 2, side: 'N' });
    expect(wallOwner(2, 2, 'W')).toEqual({ x: 2, y: 2, side: 'W' });
    expect(wallOwner(2, 2, 'S')).toEqual({ x: 2, y: 3, side: 'N' }); // the south neighbour's N
    expect(wallOwner(2, 2, 'E')).toEqual({ x: 3, y: 2, side: 'W' }); // the east neighbour's W
  });

  it('one stored value is seen identically from both sides — disagreement is unrepresentable', () => {
    const cs = cells((c, x, y) => { if (x === 2 && y === 2) c.wallN = 'wall'; });
    expect(wallAt(cs, W, H, 2, 2, 'N')).toBe('wall'); // from the south cell looking north
    expect(wallAt(cs, W, H, 2, 1, 'S')).toBe('wall'); // from the north cell looking south
  });

  it('PROPERTY: every wall reads the same from both cells it separates', () => {
    const kinds = ['none', 'wall', 'barrier'] as const;
    const cs = cells((c, x, y) => {
      c.wallN = kinds[(x * 3 + y) % 3]!;
      c.wallW = kinds[(x + y * 2) % 3]!;
    });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      for (const [d, o] of [['N', 'S'], ['E', 'W']] as [Dir, Dir][]) {
        const n = d === 'N' ? { x, y: y - 1 } : { x: x + 1, y };
        if (n.x < 0 || n.y < 0 || n.x >= W || n.y >= H) continue;
        expect(wallAt(cs, W, H, x, y, d)).toBe(wallAt(cs, W, H, n.x, n.y, o));
        expect(canStep(cs, W, H, x, y, d)).toBe(canStep(cs, W, H, n.x, n.y, o));
      }
    }
  });

  it('off the map is the PERIMETER shell — always wall', () => {
    const cs = cells();
    expect(wallAt(cs, W, H, 0, 0, 'N')).toBe('none');   // stored, and open
    expect(wallAt(cs, W, H, 0, 0, 'W')).toBe('none');
    expect(wallAt(cs, W, H, W - 1, 0, 'E')).toBe('wall'); // no east neighbour → shell
    expect(wallAt(cs, W, H, 0, H - 1, 'S')).toBe('wall');
  });
});

describe('cell — a wall is one value, so there is no half-expressed wall', () => {
  it('only a full-height wall blocks; a barrier is surmountable, none is not there', () => {
    expect(blocks('wall')).toBe(true);
    expect(blocks('barrier')).toBe(false);
    expect(blocks('none')).toBe(false);
  });
});

describe('cell-field — abstain vs assert', () => {
  it('a fresh field abstains on everything', () => {
    expect(isOpen(fullField())).toBe(true);
    expect(hasConflict(fullField())).toBe(false);
  });

  it('a template constrains ONLY what it names', () => {
    const t = template({ wallN: segs('wall') });
    expect(t.wallN).toBe(segs('wall'));
    expect(t.wallW).toBe(fullField().wallW); // untouched — still abstaining
    expect(t.floor).toBe(fullField().floor);
  });

  it('andGate intersects, and an impossible intersection is a conflict, not an error', () => {
    const a = template({ wallN: segs('none') });
    const b = template({ wallN: segs('wall') });
    const both = andGate(a, b);
    expect(both.wallN).toBe(0);
    expect(conflicts(both)).toEqual(['wallN']);
    expect(collapse(both)).toBeNull();
  });

  it('collapse takes the canonical lowest option unless a pick says otherwise', () => {
    const f = template({ wallN: segs('none', 'wall'), floor: floors('stone', 'wood') });
    expect(collapse(f)!.wallN).toBe('none');
    expect(collapse(f)!.floor).toBe('stone');
    expect(collapse(f, (_k, opts) => opts.length - 1)!.wallN).toBe('wall');
  });

  it('round-trips a concrete cell', () => {
    const c: Cell = { floor: 'wood', wallN: 'barrier', wallW: 'wall', corner: 'air', wallType: 'door' };
    expect(collapse(fromCell(c))).toEqual(c);
    for (const k of ['floor', 'wallN', 'wallW', 'corner', 'wallType'] as const) {
      expect(domainSize(fromCell(c)[k])).toBe(1);
    }
  });
});

describe('cell-grid — transactions are atomic', () => {
  it('a clean batch lands whole', () => {
    const g = g0();
    const r = applyBatch(g, [{ region: { x: 1, y: 1, w: 2, h: 2 }, stamp: template({ wallN: segs('wall') }) }]);
    expect(r.ok).toBe(true);
    expect(at(g, 1, 1)!.wallN).toBe(segs('wall'));
    expect(at(g, 3, 3)!.wallN).toBe(fullField().wallN); // outside the region, untouched
  });

  it('a conflicting batch changes NOTHING — not even the cells that would have been fine', () => {
    const g = g0();
    applyBatch(g, [{ region: { x: 0, y: 0, w: 1, h: 1 }, stamp: template({ wallN: segs('none') }) }]);
    const before = JSON.stringify(g.cells);
    const r = applyBatch(g, [
      { region: { x: 2, y: 2, w: 1, h: 1 }, stamp: template({ wallN: segs('wall') }) }, // fine on its own
      { region: { x: 0, y: 0, w: 1, h: 1 }, stamp: template({ wallN: segs('wall') }) }, // conflicts
    ]);
    expect(r.ok).toBe(false);
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(JSON.stringify(g.cells)).toBe(before);
  });

  it('rollback leaves the grid byte-identical', () => {
    const g = g0();
    const before = JSON.stringify(g.cells);
    const tx = begin(g);
    stamp(tx, { x: 0, y: 0, w: W, h: H }, template({ wallN: segs('wall') }));
    expect(txConflicts(tx)).toEqual([]);
    rollback(tx);
    expect(JSON.stringify(g.cells)).toBe(before);
  });

  it('stamps outside the grid are skipped, not an error', () => {
    const g = g0();
    const r = applyBatch(g, [{ region: { x: W - 1, y: H - 1, w: 4, h: 4 }, stamp: template({ wallN: segs('wall') }) }]);
    expect(r.ok).toBe(true);
    expect(at(g, W - 1, H - 1)!.wallN).toBe(segs('wall'));
  });

  it('resolveGrid collapses every cell', () => {
    const g = g0();
    expect(resolveGrid(g).every((c) => c !== null)).toBe(true);
  });
});

describe('cell-graph — cells are the nodes', () => {
  const id = (x: number, y: number): number => nodeId(W, x, y);

  it('an open grid is fully connected', () => {
    const g = buildCellGraph(cells(), W, H);
    expect(reachableFrom(g, id(0, 0)).filter(Boolean).length).toBe(W * H);
  });

  it('a wall severs the pair it sits between, and nothing else', () => {
    const g = buildCellGraph(cells((c, x, y) => { if (x === 2 && y === 2) c.wallW = 'wall'; }), W, H);
    // (1,2)→(2,2) is blocked directly, but the grid is open elsewhere so they still connect around
    expect(canStep(cells((c, x, y) => { if (x === 2 && y === 2) c.wallW = 'wall'; }), W, H, 2, 2, 'W')).toBe(false);
    expect(reaches(g, id(1, 2), id(2, 2))).toBe(true); // around, not through
  });

  it('NEGATIVE CONTROL: a full wall column really does cut the map in two', () => {
    const cs = cells((c, x) => { if (x === 2) c.wallW = 'wall'; });
    const g = buildCellGraph(cs, W, H);
    expect(reaches(g, id(0, 0), id(4, 4))).toBe(false);
    expect(reachableFrom(g, id(0, 0)).filter(Boolean).length).toBe(2 * H); // only the two west columns
  });

  it('a barrier column does NOT cut it — barriers are surmountable', () => {
    const g = buildCellGraph(cells((c, x) => { if (x === 2) c.wallW = 'barrier'; }), W, H);
    expect(reaches(g, id(0, 0), id(4, 4))).toBe(true);
  });
});

describe('cell-graph — an opening is a CORNER that is air, plus a door', () => {
  const id = (x: number, y: number): number => nodeId(W, x, y);
  /** A full vertical wall column at x=2, with the corner at (2,oy) opened and typed `wt`. */
  const column = (wt: WallType, corner: 'solid' | 'column' | 'air', oy = 2): Cell[] =>
    cells((c, x, y) => {
      if (x === 2) c.wallW = 'wall';
      if (x === 2 && y === oy) { c.corner = corner; c.wallType = wt; }
    });

  it.each<[WallType, boolean]>([
    ['solid', false], ['door', true], ['arch', true],
    ['window', false], ['hole', false], ['low_gate', false],
  ])('air corner + %s → crosses the wall: %s', (wt, want) => {
    expect(reaches(buildCellGraph(column(wt, 'air'), W, H), id(0, 0), id(4, 4))).toBe(want);
  });

  it('a door on a SOLID corner is inert — the corner must be air', () => {
    expect(openingActive(column('door', 'solid'), W, 2, 2)).toBe(false);
    expect(reaches(buildCellGraph(column('door', 'solid'), W, H), id(0, 0), id(4, 4))).toBe(false);
  });

  it('a door on a COLUMN corner is inert too — a pillar is not a hole', () => {
    expect(openingActive(column('door', 'column'), W, 2, 2)).toBe(false);
  });

  it('the local test short-circuits: air + door is decided on ONE cell', () => {
    expect(cornerIsOpen({ floor: 'stone', wallN: 'none', wallW: 'none', corner: 'air', wallType: 'door' })).toBe(true);
    expect(cornerIsOpen({ floor: 'stone', wallN: 'none', wallW: 'none', corner: 'solid', wallType: 'door' })).toBe(false);
    expect(cornerIsOpen({ floor: 'stone', wallN: 'none', wallW: 'none', corner: 'air', wallType: 'window' })).toBe(false);
  });

  it('a CROSS is an opening too — a junction open both ways, not a special case', () => {
    const cs = cells((c, x, y) => {
      if (x === 2) c.wallW = 'wall';                 // vertical run
      if (y === 2) c.wallN = 'wall';                 // horizontal run, crossing at (2,2)
      if (x === 2 && y === 2) { c.corner = 'air'; c.wallType = 'door'; }
    });
    expect(openingActive(cs, W, 2, 2)).toBe(true);
    const g = buildCellGraph(cs, W, H);
    // all four quadrants around the point reach each other through the hole
    const q = [id(1, 1), id(2, 1), id(1, 2), id(2, 2)];
    for (const a of q) for (const b of q) expect(reaches(g, a, b)).toBe(true);
  });

  it('needs no neighbour lookup at all — the whole test is two fields on one cell', () => {
    const cs = cells((c, x, y) => {
      if (x === 2 && y === 2) { c.corner = 'air'; c.wallType = 'arch'; } // no walls anywhere
    });
    expect(openingActive(cs, W, 2, 2)).toBe(true); // redundant here, never wrong
  });

  it('spans the two collinear segments either side of the point (render only)', () => {
    expect(openingWalls(2, 2, 'V')).toEqual([{ x: 2, y: 1, side: 'W' }, { x: 2, y: 2, side: 'W' }]);
    expect(openingWalls(2, 2, 'H')).toEqual([{ x: 1, y: 2, side: 'N' }, { x: 2, y: 2, side: 'N' }]);
  });
});
