/**
 * src/floor/blueprint.ts — Layer ① BLUEPRINT (see docs/13 / wall-model.ts).
 *
 *      ⓪ PROGRAM ─▶ ① BLUEPRINT ─▶ ② STYLE ─▶ Placement[] ─▶ ③ { render, collision }
 *
 * This module turns a generated {@link Floor} (the program) into a uniform square-grid
 * {@link Blueprint} — the STRUCTURAL classes only (FLOOR / VOID / WALL / WALL_POSSIBLE / OPEN),
 * with NO piece types, NO orientation, NO style. It is the contract Layer ② (wall-style.ts)
 * realises, and is coordinate-free (square indices only).
 *
 * PHASE-1 REUSE — derives from the proven {@link buildWallGrid}. Rather than re-deriving wall
 * classification (which the edge-slot WallGrid already does correctly, and is tested against an
 * independent oracle in wallgrid.test.ts), we BUILD the WallGrid and MAP it onto the square
 * lattice: cells map to their program cell, vertical/horizontal LANE squares map to the
 * WallGrid's vEdge/hEdge `EdgeState`, and CORNER squares map to the WallGrid post `Junction`.
 * This guarantees the Blueprint agrees with the (tested) wall logic by construction. The
 * WallGrid will later be folded directly into this layer; until then this reuse keeps the two
 * representations in lock-step.
 *
 * DETERMINISM-CLEAN (CLAUDE.md): a pure function of the Floor (+ a membership-only open-cell
 * set, passed straight through to buildWallGrid). No floats, no Math.random, dense-array
 * ascending-index iteration only; the WallGrid's lookup Maps are never iterated for output.
 */

import type { Floor } from './types.ts';
import { cellId } from './types.ts';
import type { Blueprint, SquareClass, SquareRole } from './wall-model.ts';
import { roleAt } from './wall-model.ts';
import type { EdgeState, WallGridOpts } from './wallgrid.ts';
import { buildWallGrid } from './wallgrid.ts';

/** Map a WallGrid edge slot state to a LANE square's structural class. */
function laneClassFor(state: EdgeState): SquareClass {
  switch (state) {
    case 'OPEN': return 'OPEN';
    case 'DOORWAY': return 'OPEN'; // a passable opening — a wall must NOT be here
    case 'LIP': return 'WALL_POSSIBLE'; // a low break-gate seam — the styler decides
    case 'SOLID': return 'WALL';
  }
}

/**
 * Build the {@link Blueprint} for one floor (Layer ①). Pure & deterministic.
 *
 * The board is the (2W+1)×(2H+1) lattice over the floor's W×H program cells. Every lattice
 * position is a real square carrying a class, indexed dense row-major (index = row*bw + col):
 *  - CELL   (odd col, odd row)   → program cell (cx,cy)=((col-1)/2,(row-1)/2): FLOOR if that
 *                                  cell's type is walkable (not VOID/WALL), else VOID.
 *  - LANE   (exactly one even)   → the WallGrid edge slot between the two flanking cells, mapped
 *                                  OPEN/DOORWAY→OPEN, LIP→WALL_POSSIBLE, SOLID→WALL.
 *  - CORNER (even col, even row) → the WallGrid post junction: WALL iff its kind ≠ NONE, else VOID.
 *
 * @param floor the generated program floor.
 * @param opts  forwarded verbatim to {@link buildWallGrid} (e.g. forced-open hole/stair cells).
 */
export function buildBlueprint(floor: Floor, opts?: { openCells?: ReadonlySet<number> }): Blueprint {
  const W = floor.width;
  const H = floor.height;
  const bw = 2 * W + 1;
  const bh = 2 * H + 1;

  // Derive the proven wall classification (Phase-1 reuse — see module doc).
  const wgOpts: WallGridOpts = opts?.openCells !== undefined ? { openCells: opts.openCells } : {};
  const wg = buildWallGrid(floor, wgOpts);

  const cells: SquareClass[] = new Array(bw * bh);
  const roles: SquareRole[] = new Array(bw * bh);

  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      const idx = row * bw + col;
      const role = roleAt(col, row);
      roles[idx] = role;

      let cls: SquareClass;
      if (role === 'CELL') {
        // (odd,odd) → program cell ((col-1)/2,(row-1)/2). FLOOR unless VOID/WALL typed.
        const cx = (col - 1) / 2;
        const cy = (row - 1) / 2;
        const t = floor.cells[cellId(W, cx, cy)]!.cellType ?? 'ROOM';
        cls = t !== 'VOID' && t !== 'WALL' ? 'FLOOR' : 'VOID';
      } else if (role === 'CORNER') {
        // (even,even) → WallGrid post index (col/2)+(row/2)*(W+1).
        const j = wg.posts[(col / 2) + (row / 2) * (W + 1)]!;
        cls = j.kind !== 'NONE' ? 'WALL' : 'VOID';
      } else {
        // LANE: vertical (even col, odd row) → vEdge; horizontal (odd col, even row) → hEdge.
        let state: EdgeState;
        if (col % 2 === 0) {
          state = wg.vEdges[(col / 2) + ((row - 1) / 2) * (W + 1)]!;
        } else {
          state = wg.hEdges[((col - 1) / 2) + (row / 2) * W]!;
        }
        cls = laneClassFor(state);
      }
      cells[idx] = cls;
    }
  }

  return { bw, bh, cellW: W, cellH: H, cells, roles };
}
