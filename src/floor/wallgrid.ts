/**
 * src/floor/wallgrid.ts — Layer C: the WALL/EDGE GRID (docs/13 §C).
 *
 * The Floor graph (src/floor/types.ts) is cells + edges + rooms. Walls, doors, and
 * corner posts are NOT first-class there — today they're re-derived independently by the
 * renderer (per-cell `wallMask` + edgeKey dedupe + a `convexCorner` heuristic) and by the
 * collision compiler (a perimeter ring + seam lips), so the two disagree (collision ≠
 * visual). This module makes the walls EXPLICIT and SHARED: a single deterministic lattice
 * over the W×H cells that both the renderer and the collision compiler read, so they match
 * *by construction* (docs/13 §C-bis).
 *
 * THE LATTICE — conceptually the (2W+1)×(2H+1) grid from docs/13 §C: floor cells at the
 * nodes, a WALL-EDGE slot on every line between two adjacent cells (and on the outer
 * boundary), and a CORNER POST at every place four edges meet. We store it as three dense,
 * typed arrays (clearer + directly indexable, no parity arithmetic):
 *
 *   - vEdges[(W+1) × H] — VERTICAL wall lines (east/west seams). The line on the WEST side
 *     of cell (col,row) is vEdges[col + row*(W+1)]; col ∈ [0,W] (col=0 and col=W are the
 *     west/east boundary).
 *   - hEdges[W × (H+1)] — HORIZONTAL wall lines (north/south seams). The line on the SOUTH
 *     side of cell (col,row) is hEdges[col + row*W]; row ∈ [0,H] (row=0 and row=H are the
 *     south/north boundary).
 *   - posts[(W+1) × (H+1)] — a corner post at every fence-post corner (incl. the boundary).
 *
 * Side orientation matches the renderer + collision bit convention: +X = east, +Z = north
 * (z grows with the row index), so a cell's NORTH side is the hEdge at row+1 and its EAST
 * side is the vEdge at col+1.
 *
 * PURE & DETERMINISM-CLEAN: a pure function of the Floor (+ a membership-only set of
 * forced-open cells). No floats, no Math.random, dense-array ascending-index iteration only
 * (the lookup Maps are never iterated for output). It runs at build time, not in the sim,
 * but it keeps the sim's discipline so a future sim-side consumer is safe (CLAUDE.md).
 *
 * COORDINATE-FREE: this module knows nothing about world units — it speaks cells/lattice
 * slots only (like the rest of src/floor). The compiler (src/game/tower.ts), which owns
 * CELL_SIZE, projects slots to world AABBs / tile positions.
 */

import type { Floor, EdgeKind } from './types.ts';
import { cellId, edgeKey } from './types.ts';

/**
 * State of a WALL-EDGE slot (the line between two adjacent cells, or a boundary line):
 *  - OPEN    : no wall, no collider — you walk straight across (a room interior seam, a
 *              WALK/GAP graph edge, or a seam touching the climb's stairwell/ascent hole).
 *  - DOORWAY : a passable opening rendered as an arch (a DOORWAY cell's open side). May host
 *              a locked-door body; still no wall collider — the gap is real.
 *  - LIP     : a low passable bump — a BREAK/BUTTON/WEIGHT gate seam. The fallback-layer
 *              shortcut (you can always hop/break through) survives; collision keeps it low.
 *  - SOLID   : a real wall. Floor↔void/wall, the outer boundary, or two floor cells the
 *              generator did NOT connect. Render draws a wall; collision makes it impassable.
 */
export type EdgeState = 'OPEN' | 'DOORWAY' | 'LIP' | 'SOLID';

/** State of a CORNER POST: a pillar only at a TRUE convex corner, else nothing. */
export type PostState = 'NONE' | 'PILLAR';

/** Which side of a cell a vertical/horizontal slot is on (for the accessors). */
export type Side = 'east' | 'west' | 'north' | 'south';

/**
 * The wall/edge grid for one floor. Plain data, like Floor — coordinate-free slot states
 * only. Indexers below decode the dense arrays; `width`/`height` echo the floor's cell dims.
 */
export interface WallGrid {
  /** Floor cell columns (W). */
  width: number;
  /** Floor cell rows (H). */
  height: number;
  /** Vertical (E/W) wall lines, length (W+1)*H, index = col + row*(W+1), col ∈ [0,W]. */
  vEdges: EdgeState[];
  /** Horizontal (N/S) wall lines, length W*(H+1), index = col + row*W, row ∈ [0,H]. */
  hEdges: EdgeState[];
  /** Corner posts, length (W+1)*(H+1), index = pcol + prow*(W+1). */
  posts: PostState[];
}

/** Options for {@link buildWallGrid}. */
export interface WallGridOpts {
  /**
   * Cells that must read as OPEN on every interior seam — the climb's ascent-hole and
   * straight-stair footprints (tower.ts holeCells ∪ stairCells). A seam touching one of
   * these is never a wall (the climb must stay open), mirroring the compiler's old
   * skip-lip-on-stair/hole rule. Membership-test only (never iterated for output).
   */
  openCells?: ReadonlySet<number>;
}

/* --------------------------------- accessors --------------------------------- */

/** Index of the vertical (E/W) slot on the WEST side of the column-`col` line, row `row`. */
function vIndex(width: number, col: number, row: number): number {
  return col + row * (width + 1);
}
/** Index of the horizontal (N/S) slot on the SOUTH side of the row-`row` line, col `col`. */
function hIndex(width: number, col: number, row: number): number {
  return col + row * width;
}
/** Index of the corner post at fence-post corner (pcol,prow). */
function postIndex(width: number, pcol: number, prow: number): number {
  return pcol + prow * (width + 1);
}

/** The wall-edge slot on the given `side` of cell (col,row). */
export function edgeAt(g: WallGrid, side: Side, col: number, row: number): EdgeState {
  switch (side) {
    case 'west': return g.vEdges[vIndex(g.width, col, row)]!;
    case 'east': return g.vEdges[vIndex(g.width, col + 1, row)]!;
    case 'south': return g.hEdges[hIndex(g.width, col, row)]!;
    case 'north': return g.hEdges[hIndex(g.width, col, row + 1)]!;
  }
}

/** The corner-post slot at fence-post corner (pcol,prow), pcol ∈ [0,W], prow ∈ [0,H]. */
export function postAt(g: WallGrid, pcol: number, prow: number): PostState {
  return g.posts[postIndex(g.width, pcol, prow)]!;
}

/* --------------------------------- builder ----------------------------------- */

/**
 * Build the WallGrid for one floor. Pure & deterministic.
 *
 * Each edge slot's state is derived from the SAME data the renderer/compiler already use —
 * cell `cellType`, the traversal-edge graph, and the forced-open (hole/stair) set — so the
 * grid is a faithful, lossless promotion of today's wall logic into one place:
 *
 *   1. boundary line (a cell is off-grid)         → SOLID (the outer safe shell)
 *   2. either cell forced-open (hole/stair)        → OPEN  (the climb stays clear)
 *   3. either cell is VOID/WALL (non-floor)        → SOLID
 *   4. both floor, by the graph edge between them:
 *        WALK | GAP   → DOORWAY if a flanking cell is a DOORWAY cell, else OPEN
 *        BREAK|BUTTON|WEIGHT → LIP
 *        (no edge)    → SOLID  (two floor cells the generator left unconnected = a wall)
 *
 * Posts are PILLAR only at a true convex corner (see {@link convexCornerAt}).
 */
export function buildWallGrid(floor: Floor, opts: WallGridOpts = {}): WallGrid {
  const W = floor.width;
  const H = floor.height;
  const openCells = opts.openCells ?? EMPTY_SET;

  // O(1) edge-kind lookup (LOOKUP ONLY — never iterated for output, so no Map-order hazard,
  // same pattern as tower.ts buildEdgeKindMap).
  const edgeKinds = new Map<number, EdgeKind>();
  for (const e of floor.edges) edgeKinds.set(edgeKey(e.a, e.b), e.kind);

  /** cellType (defaulting to ROOM for legacy floors) → is this a walkable FLOOR cell? */
  const isFloor = (col: number, row: number): boolean => {
    if (col < 0 || col >= W || row < 0 || row >= H) return false;
    const t = floor.cells[cellId(W, col, row)]!.cellType ?? 'ROOM';
    return t !== 'VOID' && t !== 'WALL';
  };
  const isDoorway = (col: number, row: number): boolean =>
    (floor.cells[cellId(W, col, row)]!.cellType ?? 'ROOM') === 'DOORWAY';

  /** Derive an edge slot's state between two cells (either may be off-grid: pass -1 col/row). */
  const slot = (
    aCol: number, aRow: number, bCol: number, bRow: number,
  ): EdgeState => {
    const aIn = aCol >= 0 && aCol < W && aRow >= 0 && aRow < H;
    const bIn = bCol >= 0 && bCol < W && bRow >= 0 && bRow < H;
    if (!aIn || !bIn) return 'SOLID'; // 1. boundary → the outer shell

    const a = cellId(W, aCol, aRow);
    const b = cellId(W, bCol, bRow);
    if (openCells.has(a) || openCells.has(b)) return 'OPEN'; // 2. climb stays open

    const aFloor = isFloor(aCol, aRow);
    const bFloor = isFloor(bCol, bRow);
    if (!aFloor || !bFloor) return 'SOLID'; // 3. floor ↔ void/wall

    // 4. both floor — classify by the traversal edge (if any) between them.
    const kind = edgeKinds.get(edgeKey(a, b));
    if (kind === 'WALK' || kind === 'GAP') {
      return (isDoorway(aCol, aRow) || isDoorway(bCol, bRow)) ? 'DOORWAY' : 'OPEN';
    }
    if (kind === 'BREAK' || kind === 'BUTTON' || kind === 'WEIGHT') return 'LIP';
    return 'SOLID'; // no edge between two floor cells → an interior wall
  };

  // vEdges: the line on the WEST of column `col` (between cell col-1 and cell col), all rows.
  const vEdges: EdgeState[] = new Array((W + 1) * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col <= W; col++) {
      vEdges[vIndex(W, col, row)] = slot(col - 1, row, col, row);
    }
  }
  // hEdges: the line on the SOUTH of row `row` (between cell row-1 and cell row), all cols.
  const hEdges: EdgeState[] = new Array(W * (H + 1));
  for (let row = 0; row <= H; row++) {
    for (let col = 0; col < W; col++) {
      hEdges[hIndex(W, col, row)] = slot(col, row - 1, col, row);
    }
  }
  // posts: a pillar at each fence-post corner where the floor footprint turns a convex corner.
  const posts: PostState[] = new Array((W + 1) * (H + 1));
  for (let prow = 0; prow <= H; prow++) {
    for (let pcol = 0; pcol <= W; pcol++) {
      posts[postIndex(W, pcol, prow)] = convexCornerAt(isFloor, pcol, prow) ? 'PILLAR' : 'NONE';
    }
  }

  return { width: W, height: H, vEdges, hEdges, posts };
}

/** Shared empty set so the no-opts path allocates nothing. */
const EMPTY_SET: ReadonlySet<number> = new Set<number>();

/**
 * Is the fence-post corner (pcol,prow) a TRUE convex corner where a pillar belongs?
 * The corner is shared by the four cells (pcol-1,prow-1) (pcol,prow-1) (pcol-1,prow)
 * (pcol,prow). Count how many are FLOOR (off-grid = not floor):
 *   - 1 floor  → inner corner (an L),   3 floor → outer corner (an L)  → PILLAR
 *   - 2 floor on a DIAGONAL (two areas kissing at the point)            → PILLAR
 *   - 2 adjacent (a straight wall run), 0 (open void) or 4 (open floor) → no post
 * This is the renderer's old `convexCorner` test, promoted here as the single source so the
 * renderer stops re-deriving it (and removes its spurious posts at T-junctions structurally).
 */
export function convexCornerAt(
  isFloor: (col: number, row: number) => boolean,
  pcol: number, prow: number,
): boolean {
  const sw = isFloor(pcol - 1, prow - 1);
  const se = isFloor(pcol, prow - 1);
  const nw = isFloor(pcol - 1, prow);
  const ne = isFloor(pcol, prow);
  const n = (sw ? 1 : 0) + (se ? 1 : 0) + (nw ? 1 : 0) + (ne ? 1 : 0);
  if (n === 1 || n === 3) return true;             // L (inner / outer convex corner)
  if (n === 2 && sw === ne && se === nw && sw !== se) return true; // diagonal kiss
  return false;                                     // straight run / T / open / solid
}

/**
 * Project a cell's wall-edge slots back to the legacy 4-bit `wallMask` the renderer's fog
 * BFS + decoration still read (bit 1=+X east, 2=-X west, 4=+Z north, 8=-Z south). A side is
 * "walled" (bit set) when its slot is SOLID or LIP (a break-gate reads as a wall to fog,
 * matching the old behaviour); OPEN/DOORWAY clear the bit. Non-floor and forced-open cells
 * have no wallMask (0), exactly as the old compiler's `buildCellGrid` guarded — so this
 * projection is byte-identical to the pre-WallGrid wallMask (proven in wallgrid.test.ts).
 */
export function wallMaskFor(
  g: WallGrid, col: number, row: number,
  isFloor: (col: number, row: number) => boolean,
  openCells: ReadonlySet<number>,
): number {
  if (!isFloor(col, row) || openCells.has(cellId(g.width, col, row))) return 0;
  const walled = (s: EdgeState): boolean => s === 'SOLID' || s === 'LIP';
  let m = 0;
  if (walled(edgeAt(g, 'east', col, row))) m |= 1;
  if (walled(edgeAt(g, 'west', col, row))) m |= 2;
  if (walled(edgeAt(g, 'north', col, row))) m |= 4;
  if (walled(edgeAt(g, 'south', col, row))) m |= 8;
  return m;
}
