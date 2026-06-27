/**
 * src/floor/wall-model.ts — the SHARED CONTRACTS for the wall pipeline.
 *
 *      ⓪ PROGRAM ─▶ ① BLUEPRINT ─▶ ② STYLE ─▶ Placement[] ─▶ ③ { render, collision }
 *      (rooms/puzzles)  (structure)   (aesthetic)              (dumb consumers)
 *
 * This file is the single source of truth for the data that flows BETWEEN the layers, so the
 * Blueprint builder (`blueprint.ts`), the Style strategy (`wall-style.ts`), and the two targets
 * (render in `dungeon.ts`, collision in `tower.ts`) all agree by construction. Nothing here is
 * coordinate-bearing — everything is in SQUARE indices; `tower.ts` owns the projection to world
 * units (the §C-bis "render == collision" guarantee lives in that one projection).
 *
 * THE GRID (the thing we're replacing the edge-slot WallGrid with). The board is ONE uniform
 * grid of 2u (KayKit) SQUARES — walls OWN squares, they no longer live on zero-width edges. We
 * lay it out as a `(2W+1) × (2H+1)` lattice over the floor program's W×H cells, but now EVERY
 * lattice position is a real square that carries a class. Cells sit at ODD-ODD positions so the
 * lanes/corners (even) include the OUTER BOUNDARY ring as real squares too:
 *
 *     (odd col, odd row)     → a FLOOR-CELL square  (one per program cell: 2cx+1, 2cy+1)
 *     (exactly one even)     → a WALL-LANE square    (between two cells / on the boundary)
 *     (even col, even row)   → a CORNER square       (where lanes cross — a junction owns THIS)
 *
 * So a wall between two rooms is ONE shared lane square (your "one shared square"); a corner/tee/
 * cross is the corner square where lanes meet. Floor regions are the floor-cell squares. The
 * `square` size and any floor/wall lane-width asymmetry are a PROJECTION choice (tower.ts), not a
 * model choice — keeping this layer pure lets a finer subdivision drop in later untouched.
 */

/**
 * ① BLUEPRINT — the STRUCTURAL class of one square. No piece type, no orientation, no style.
 * This is "where walls must / may / must-not be" — the contract Layer ② (style) realises.
 *  - FLOOR         : walkable interior.
 *  - VOID          : outside the dungeon (negative space; no floor, no wall).
 *  - WALL          : a wall MUST be here (room↔void perimeter, an unconnected seam).
 *  - WALL_POSSIBLE : a wall MAY be here — the styler decides (interior partitions, candidate
 *                    edges, secret-wall sites). Lets generation stay coarse and style add richness.
 *  - OPEN          : a wall must NOT be here (a doorway / a connected passage — a real gap).
 */
export type SquareClass = 'FLOOR' | 'VOID' | 'WALL' | 'WALL_POSSIBLE' | 'OPEN';

/** All classes, ordered (stable iteration / index mapping). */
export const SQUARE_CLASSES: readonly SquareClass[] = ['FLOOR', 'VOID', 'WALL', 'WALL_POSSIBLE', 'OPEN'];

/**
 * Which kind of lattice position a square is (derived from its parity — see the grid note above).
 * Carried explicitly so the styler/targets don't re-derive parity and so a future non-parity
 * subdivision can set it directly.
 */
export type SquareRole = 'CELL' | 'LANE' | 'CORNER';

/**
 * The Blueprint: a dense square grid, coordinate-free. Plain data (like Floor) — the producer
 * (blueprint.ts) and every consumer speak only this.
 */
export interface Blueprint {
  /** Square-grid dimensions (the (2W+1)×(2H+1) lattice → bw = 2W+1, bh = 2H+1). */
  bw: number;
  bh: number;
  /** Echo of the floor program dims (W,H) so consumers can map a square back to a program cell. */
  cellW: number;
  cellH: number;
  /** Dense row-major classes, length bw*bh, index = row*bw + col. */
  cells: SquareClass[];
  /** Dense row-major roles, same indexing — CELL (floor square) / LANE (wall) / CORNER (junction). */
  roles: SquareRole[];
}

/* --------------------------------- index helpers --------------------------------- */

/** Square index from (col,row) in the blueprint lattice. */
export function sqIndex(bp: Blueprint, col: number, row: number): number {
  return row * bp.bw + col;
}
/** Is (col,row) inside the lattice? */
export function sqIn(bp: Blueprint, col: number, row: number): boolean {
  return col >= 0 && col < bp.bw && row >= 0 && row < bp.bh;
}
/** Class at (col,row), or VOID if off-grid. */
export function classAt(bp: Blueprint, col: number, row: number): SquareClass {
  return sqIn(bp, col, row) ? bp.cells[sqIndex(bp, col, row)]! : 'VOID';
}
/** The lattice coords of the floor-cell square for program cell (cx,cy): (2cx+1, 2cy+1). */
export function cellSquare(cx: number, cy: number): { col: number; row: number } {
  return { col: 2 * cx + 1, row: 2 * cy + 1 };
}
/** Square role from its lattice parity: CELL (odd,odd) / CORNER (even,even) / LANE (one even). */
export function roleAt(col: number, row: number): SquareRole {
  const ce = col % 2 === 0, re = row % 2 === 0;
  if (!ce && !re) return 'CELL';
  if (ce && re) return 'CORNER';
  return 'LANE';
}

/* ----------------------------------- ② STYLE output ----------------------------------- */

/**
 * The kind of wall PIECE the styler chose for a wall/corner square — the auto-tiled shape from
 * its wall-neighbours (the junction family, now over squares). Maps 1:1 to a KayKit asset.
 *  - STRAIGHT : a wall run segment (rendered full-4u where two collinear LANE squares pair up,
 *               else a 2u half).
 *  - CORNER / TEE / CROSS : a CORNER square where 2-perp / 3 / 4 wall lanes meet.
 *  - CAP      : a wall dead-end.
 *  - PILLAR   : a free-standing column (no adjoining walls).
 *  - DOORWAY  : an OPEN lane that hosts a door frame (carries `doorId` via Placement).
 */
export type PieceKind = 'STRAIGHT' | 'CORNER' | 'TEE' | 'CROSS' | 'CAP' | 'PILLAR' | 'DOORWAY';

/** All piece kinds, ordered. */
export const PIECE_KINDS: readonly PieceKind[] = ['STRAIGHT', 'CORNER', 'TEE', 'CROSS', 'CAP', 'PILLAR', 'DOORWAY'];

/**
 * A STYLE variant on top of a piece — the ONLY place aesthetics live (the styler picks these from
 * a seeded hash + style rules; generation never sees them). Targets map (piece,variant) → asset.
 */
export type Variant = 'PLAIN' | 'BROKEN' | 'ARCHED' | 'GATED' | 'WINDOW';

/** All variants, ordered. */
export const VARIANTS: readonly Variant[] = ['PLAIN', 'BROKEN', 'ARCHED', 'GATED', 'WINDOW'];

/** Wall-direction bits at a junction square (which sides carry a wall). Drives the piece yaw. */
export const DIR_E = 1; // +X (east)
export const DIR_W = 2; // -X (west)
export const DIR_N = 4; // +Z (north)
export const DIR_S = 8; // -Z (south)

/**
 * One placed wall piece — the INTERMEDIATE REPRESENTATION both targets consume (so render and
 * collision match by construction). Coordinate-free + ASSET-AGNOSTIC: it carries the STRUCTURAL
 * orientation (`axis` for runs, `dirs` for junctions), and the TARGETS derive the asset yaw +
 * footprint (the §C-bis "render == collision" mapping lives there, against the measured KayKit
 * native orientations). `col,row` is the anchor square (lattice coords); `tower.ts` projects to world.
 */
export interface Placement {
  piece: PieceKind;
  variant: Variant;
  /** Anchor square (lattice col,row) — for a STRAIGHT span 2, the LOW-coordinate square. */
  col: number;
  row: number;
  /** How many squares along `axis` the piece covers (1 = 2u half/corner/etc., 2 = full 4u wall). */
  span: number;
  /** Run axis for STRAIGHT/DOORWAY: 'X' = east/west wall (spans cols), 'Z' = north/south (rows). */
  axis: 'X' | 'Z';
  /** Junction wall-direction bitmask (DIR_*) for CORNER/TEE/CROSS/CAP/PILLAR; 0 for runs. */
  dirs: number;
  /** Lock id if this DOORWAY is gated by a LockedDoor, else -1. */
  doorId: number;
}
