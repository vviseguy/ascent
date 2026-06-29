// ============================================================================
// src/floor/wall-tile.ts — the WALL-TILE structural model (the 9-cell tile).
// ============================================================================
//
// A wall occupies its own 4u SQUARE, modelled as a "plus" of 9 cells that cleanly
// separates "what connects to the neighbour" (the EDGES) from "what's structurally
// inside" (the INNER sides + the CENTRE):
//
//               edge.N
//               inner.N
//     edge.W  inner.W  ⊙  inner.E  edge.E      ⊙ = centre column (none|wall|barrier)
//               inner.S                          inner.* = inner sides (none|wall|barrier)
//               edge.S                           edge.*  = outer edges (none|wall|barrier)
//
// - Each of the 8 arm-cells (an EDGE + an INNER per direction) is `none | wall | barrier`.
// - The CENTRE column is ADDITIVE: `none` lets walls pass through the middle solid (a
//   cN+cS = a continuous straight wall, a cN+cE = a clean column-less bend); `wall`/`barrier`
//   adds a pillar on top.
// - `wallType` (door/window/…) only matters when a full straight LINE collapses to one wall.
//
// The classic pieces (straight / corner / tee / cross / cap / column / bend) are DERIVED
// labels — see `label()`. Rendering composes per-arm pieces + the centre (wall-tile-assets.ts):
// adjacent same-type cells collapse into longer walls; isolated cells are caps (inner caps
// face in, edge caps face out). Pure + deterministic — no float/RNG/Map-iteration on output.

export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

/** One arm-cell (an edge or an inner side): nothing, a full-height wall, or a low barrier. */
export type Seg = 'none' | 'wall' | 'barrier';

/** The additive centre column. `none` = walls still pass through solid; wall/barrier = a pillar. */
export type Centre = 'none' | 'wall' | 'barrier';

/** A per-direction set of cells. */
export interface SideSet {
  N: Seg;
  E: Seg;
  S: Seg;
  W: Seg;
}

/** Opening of a full straight WALL line (EW or NS). Only read when a full line is all wall. */
export type WallType = 'solid' | 'door' | 'window' | 'hole' | 'arch' | 'low_gate';

/** A floor material at one CORNER of a tile. `none` = a hole at that corner. */
export type FloorMaterial = 'none' | 'stone' | 'dirt' | 'wood';

/** Per-CORNER floor materials. Uniform non-`none` = a full tile; mixed = per-corner. */
export interface CornerFloors {
  nw: FloorMaterial;
  ne: FloorMaterial;
  sw: FloorMaterial;
  se: FloorMaterial;
}

export const FLOOR_CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
export type FloorCorner = (typeof FLOOR_CORNERS)[number];

/** The single material if all four corners agree and it isn't `none`, else null. */
export function uniformFloor(f: CornerFloors): Exclude<FloorMaterial, 'none'> | null {
  return f.nw === f.ne && f.ne === f.sw && f.sw === f.se && f.nw !== 'none' ? f.nw : null;
}

/** The full parameterization of one 4u square — the RESOLVED tile (all four edges known). Produced by
 *  the grid resolver (tile-grid.ts), consumed by tilePlacements/collision/the corner-graph. A plain
 *  floor = all-`none` arms + `centre:'none'`. */
export interface WallTile {
  floor: CornerFloors;
  /** Outer cells, at the tile boundary — the connection to each neighbour. */
  edge: SideSet;
  /** Inner cells, between each edge and the centre. */
  inner: SideSet;
  /** Additive centre column. */
  centre: Centre;
  /** Opening kind for a full straight wall line. */
  wallType: WallType;
}

/** The two edges a tile OWNS (§12 #4): a tile owns its N + W; its E/S are the neighbour's W/N, filled
 *  in only by the grid resolver. So a lone tile cannot even describe a shared boundary twice. */
export type OwnedEdge = 'N' | 'W';
export const OWNED_EDGES: readonly OwnedEdge[] = ['N', 'W'];
export interface OwnedSides {
  N: Seg;
  W: Seg;
}

/** A tile WITHOUT its resolved E/S edges — everything a lone tile knows. `collapse` yields this; the
 *  resolver (`resolveGrid`/`tileView`) fills E (= east neighbour's W) and S (= south neighbour's N) to
 *  produce a full `WallTile`. The `inner` cells are all four — they are interior, per-tile. */
export interface TileCore {
  floor: CornerFloors;
  edge: OwnedSides;
  inner: SideSet;
  centre: Centre;
  wallType: WallType;
}

/* ----------------------------------- derived --------------------------------- */

/** One direction's collapsed arm: its material, and whether it reaches the centre / the edge. */
export interface Arm {
  dir: Dir;
  /** `null` = no arm. For a mixed inner/edge type, the INNER (centre-side) wins. */
  type: 'wall' | 'barrier' | null;
  /** inner cell present → the arm reaches the centre (joins the junction). */
  reachesCentre: boolean;
  /** edge cell present → the arm reaches the tile boundary (connects to the neighbour). */
  reachesEdge: boolean;
}

export function armOf(tile: WallTile, d: Dir): Arm {
  const i = tile.inner[d];
  const e = tile.edge[d];
  const type = i !== 'none' ? i : e !== 'none' ? e : 'none';
  return { dir: d, type: type === 'none' ? null : type, reachesCentre: i !== 'none', reachesEdge: e !== 'none' };
}

/** The directions whose INNER cell is set (these define the centre junction). */
export function innerDirs(tile: WallTile): Dir[] {
  return DIRS.filter((d) => tile.inner[d] !== 'none');
}

/** A human label for the structure, DERIVED from the inner junction + centre (for readouts). */
export function label(tile: WallTile): string {
  const inner = innerDirs(tile);
  const edges = DIRS.filter((d) => tile.edge[d] !== 'none');
  const col = tile.centre !== 'none';
  const n = inner.length;
  if (n === 0) {
    if (col) return tile.centre === 'wall' ? 'column' : 'post';
    return edges.length ? 'edge-caps' : 'empty';
  }
  if (n === 1) return 'cap';
  if (n === 2) {
    const [a, b] = inner as [Dir, Dir];
    const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
    if (opposite) return 'straight';
    return col ? 'corner' : 'bend'; // adjacent: pillared corner vs column-less bend
  }
  if (n === 3) return 'tee';
  return 'cross';
}

/** Is this axis a full straight WALL line (so `wallType` applies)? */
export function fullWallLine(tile: WallTile, axis: 'EW' | 'NS'): boolean {
  const ds: Dir[] = axis === 'EW' ? ['E', 'W'] : ['N', 'S'];
  return ds.every((d) => tile.inner[d] === 'wall' && tile.edge[d] === 'wall');
}

/* ----------------------------------- validate -------------------------------- */

export interface TileIssue {
  code: string;
  message: string;
}

/**
 * Flag tiles a generator/editor shouldn't emit. The model is permissive (an edge cap with no
 * inner is a valid wall finishing at the boundary), so today the only check is a `wallType`
 * opening declared where no full straight line exists to host it (it would be ignored).
 */
export function validate(tile: WallTile): TileIssue[] {
  const issues: TileIssue[] = [];
  if (tile.wallType !== 'solid' && !fullWallLine(tile, 'EW') && !fullWallLine(tile, 'NS')) {
    issues.push({
      code: 'wallType-without-line',
      message: `wallType '${tile.wallType}' needs a full straight wall line (both inner+edge on one axis all wall); it will be ignored.`,
    });
  }
  return issues;
}
