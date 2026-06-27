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

/**
 * The JUNCTION at a corner POST — what the four edge slots meeting there form. Derived from
 * which of the post's incident edges (N/E/S/W) are walls (SOLID|LIP). This generalises the old
 * "pillar at a convex corner" into the full junction family the KayKit kit (and any tileset)
 * needs — caps, corners, tees, crossings — and is the same classification at ANY lattice
 * subdivision (it reads the four incident edges, whatever the granularity).
 *   - NONE     : no walls meet here.
 *   - CAP      : exactly one wall ends here (a dead-end → wall_endcap).
 *   - STRAIGHT : two collinear walls pass through (no junction piece; the runs meet flush).
 *   - CORNER   : two perpendicular walls turn here (an L → wall_corner).
 *   - TEE      : three walls meet (a T → wall_Tsplit; the open side is the 4th direction).
 *   - CROSS    : all four walls meet (a + → wall_crossing).
 */
export type JunctionKind = 'NONE' | 'CAP' | 'STRAIGHT' | 'CORNER' | 'TEE' | 'CROSS';

/** Wall-direction bits at a post (which sides carry a wall). Matches the cell wallMask order. */
export const DIR_E = 1; // +X (east)
export const DIR_W = 2; // -X (west)
export const DIR_N = 4; // +Z (north)
export const DIR_S = 8; // -Z (south)

/** A classified corner post: the junction kind + the wall-direction bitmask that produced it. */
export interface Junction {
  kind: JunctionKind;
  /** Which directions carry a wall (DIR_E|DIR_W|DIR_N|DIR_S). Drives the piece's yaw. */
  dirs: number;
}

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
  /** Corner posts (junctions), length (W+1)*(H+1), index = pcol + prow*(W+1). */
  posts: Junction[];
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

/** The junction at fence-post corner (pcol,prow), pcol ∈ [0,W], prow ∈ [0,H]. */
export function postAt(g: WallGrid, pcol: number, prow: number): Junction {
  return g.posts[postIndex(g.width, pcol, prow)]!;
}

/**
 * Classify the junction at post (pcol,prow): read the FOUR incident edge slots (the wall lines
 * leaving the post N/E/S/W), mark each that is a wall (SOLID|LIP), and name the shape. Pure
 * lattice logic — works at any subdivision. Off-grid incident slots count as no-wall.
 */
export function classifyJunction(g: WallGrid, pcol: number, prow: number): Junction {
  const W = g.width, H = g.height;
  const isWall = (s: EdgeState | undefined): boolean => s === 'SOLID' || s === 'LIP';
  let dirs = 0;
  // E (+X): the hEdge leaving the post eastward = south face of cell (pcol,prow).
  if (pcol < W && isWall(g.hEdges[pcol + prow * W])) dirs |= DIR_E;
  // W (-X): south face of cell (pcol-1,prow).
  if (pcol >= 1 && isWall(g.hEdges[(pcol - 1) + prow * W])) dirs |= DIR_W;
  // N (+Z): the vEdge leaving the post northward = west face of cell (pcol,prow).
  if (prow < H && isWall(g.vEdges[pcol + prow * (W + 1)])) dirs |= DIR_N;
  // S (-Z): west face of cell (pcol,prow-1).
  if (prow >= 1 && isWall(g.vEdges[pcol + (prow - 1) * (W + 1)])) dirs |= DIR_S;

  const n = (dirs & 1) + ((dirs >> 1) & 1) + ((dirs >> 2) & 1) + ((dirs >> 3) & 1);
  let kind: JunctionKind;
  if (n === 0) kind = 'NONE';
  else if (n === 1) kind = 'CAP';
  else if (n === 2) kind = (dirs === (DIR_E | DIR_W) || dirs === (DIR_N | DIR_S)) ? 'STRAIGHT' : 'CORNER';
  else if (n === 3) kind = 'TEE';
  else kind = 'CROSS';
  return { kind, dirs };
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
 *   3. a TRAVERSAL EDGE joins the two cells (any cell type — an edge always wins):
 *        WALK | GAP   → DOORWAY if a flanking cell is a DOORWAY cell, else OPEN
 *        BREAK|BUTTON|WEIGHT → LIP
 *   4. NO edge between them                         → SOLID (floor↔void/wall, or two
 *                                                    UNCONNECTED floor cells = a real wall)
 *
 * Putting the edge check (3) ahead of the cell-type check is what keeps every graph route —
 * including the perimeter FALLBACK LAYER's WALK edges, which thread through VOID cells —
 * physically passable, so collision never walls off a path the verifier proved solvable.
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
    const aFloor = isFloor(aCol, aRow);
    const bFloor = isFloor(bCol, bRow);
    // 2. a FLOOR cell on the climb (hole/stair footprint) keeps its seams OPEN.
    if ((aFloor && openCells.has(a)) || (bFloor && openCells.has(b))) return 'OPEN';

    // 3. a TRAVERSAL EDGE makes the seam PASSABLE regardless of cell type. This is what keeps
    //    the floor's GUARANTEED ROUTES physically open — including the perimeter FALLBACK
    //    LAYER, whose WALK edges run along the boundary through cells the layout may have
    //    typed VOID. If we walled those, collision would block a graph-traversable path that
    //    the (laterally-blind) route-check can't see is blocked — exactly what broke the real
    //    climb. So an edge always wins over the cell type.
    const kind = edgeKinds.get(edgeKey(a, b));
    if (kind === 'WALK' || kind === 'GAP') {
      return (isDoorway(aCol, aRow) || isDoorway(bCol, bRow)) ? 'DOORWAY' : 'OPEN';
    }
    if (kind === 'BREAK' || kind === 'BUTTON' || kind === 'WEIGHT') return 'LIP';

    // 4. no traversal edge → a wall: floor↔void/wall, or two UNCONNECTED floor cells.
    return 'SOLID';
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
  // posts: classify the JUNCTION at each fence-post corner from its incident wall slots (so the
  // renderer/collision can pick caps/corners/tees/crossings). Needs the edges built first.
  const posts: Junction[] = new Array((W + 1) * (H + 1));
  const g: WallGrid = { width: W, height: H, vEdges, hEdges, posts };
  for (let prow = 0; prow <= H; prow++) {
    for (let pcol = 0; pcol <= W; pcol++) {
      posts[postIndex(W, pcol, prow)] = classifyJunction(g, pcol, prow);
    }
  }

  return g;
}

/** Shared empty set so the no-opts path allocates nothing. */
const EMPTY_SET: ReadonlySet<number> = new Set<number>();

/**
 * Project a cell's wall-edge slots back to the legacy 4-bit `wallMask` the renderer's fog
 * BFS + decoration still read (bit 1=+X east, 2=-X west, 4=+Z north, 8=-Z south). A side is
 * "walled" (bit set) when its slot is SOLID or LIP (a break-gate reads as a wall to fog);
 * OPEN/DOORWAY clear the bit. Non-floor and forced-open cells have no wallMask (0). Matches
 * the pre-WallGrid wallMask for every floor↔floor seam; it differs only where a traversal
 * edge now keeps a floor↔VOID seam OPEN (the perimeter fallback) — a deliberate fix so the
 * mask, the render, and the collision all agree the seam is passable (proven in
 * wallgrid.test.ts against an independent reimplementation of the same rule).
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
