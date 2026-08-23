// ============================================================================
// src/floor/structure-migrate.ts — the 4u TILE structures → the 2u CELL grid.
// ============================================================================
//
// A one-time, exact conversion of everything authored in the Tile Paint Editor. It runs on DOMAINS,
// not collapsed values, so a half-painted structure stays half-painted and keeps its freedom.
//
// THE GEOMETRY. One 4u tile becomes a 2×2 block of 2u cells. The tile's CENTRE is the shared corner
// of those four, i.e. the NW corner of the block's south-east cell:
//
//        ┌───────┬───────┐        A = (0,0) NW    C = (0,1) SW
//        │   A   │   B   │        B = (1,0) NE    D = (1,1) SE
//        ├───────●───────┤        ● = the tile centre = D's NW corner
//        │   C   │   D   │
//        └───────┴───────┘
//
// An ARM ran from the centre out to a boundary midpoint — 2u — which is now exactly one cell wall,
// and it is PERPENDICULAR to the side it points at (the N arm separates A from B):
//
//        N arm → B.wallW        W arm → C.wallN
//        S arm → D.wallW        E arm → D.wallN
//        centre → D.corner      wallType → D.wallType
//
// Every other wall in the block (A.wallN, A.wallW, B.wallN, C.wallW) lies on a TILE BOUNDARY, and the
// 4u model had no way to put a wall there — walls only ever radiated from centres. Those become
// `none`. That asymmetry is the whole reason for the migration: the 2u grid can express a wall on the
// boundary line as well as the centre line, which is the finer structure the old lattice simulated.
//
// TWO CELLS BECOME ONE. An arm was `inner` + `edge`, and a half-expressed arm (one set, one not)
// rendered as a full-length wall while reading as PASSABLE — the divergence that motivated all this.
// The conversion is RENDER-FAITHFUL: it takes the arm's drawn type (`inner` if set, else `edge`,
// matching `armOf`), because the author painted against the 3D preview and that is what they saw.
// Applied over domains by enumerating the 9 (inner, edge) combinations, so no possibility is invented
// or lost.
//
// Deterministic and pure: mask arithmetic over fixed value orders.

import { type Mask, segs, floors, corners, wallTypes, opens, template, type CellField } from './cell-field.ts';
import { makeGrid, type CellGrid } from './cell-grid.ts';
import type { Seg as CellSeg, Corner, Open, WallType } from './cell.ts';

/* ------------------------- the 4u shapes we are reading ------------------------- */
// Declared locally so the migration does not depend on the old modules surviving.

type OldSeg = 'none' | 'wall' | 'barrier';
type OldCentre = 'none' | 'wall' | 'barrier';
const OLD_SEGS: readonly OldSeg[] = ['none', 'wall', 'barrier'];
const OLD_CENTRES: readonly OldCentre[] = ['none', 'wall', 'barrier'];
const OLD_FLOORS = ['none', 'stone', 'dirt', 'wood'] as const;
const OLD_WALLTYPES = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'] as const;

/** A saved 4u tile: masks in the OLD bit orders. */
export interface OldTileField {
  floor: { nw: Mask; ne: Mask; sw: Mask; se: Mask };
  /** OWNED edges only — a tile's E and S edges are its neighbours' W and N (single ownership). */
  edge: { N: Mask; W: Mask };
  inner: { N: Mask; E: Mask; S: Mask; W: Mask };
  centre: Mask;
  wallType: Mask;
}

export interface OldStructure {
  w: number;
  h: number;
  cells: OldTileField[];
}

const valuesOf = <T>(vals: readonly T[], m: Mask): T[] => vals.filter((_, i) => (m & (1 << i)) !== 0);

/* --------------------------------- the mappings --------------------------------- */

/**
 * The set of ARM TYPES an (inner, edge) domain pair can still produce, as a new-model wall domain.
 * Enumerates all surviving combinations of the two old cells and applies the drawn-type rule
 * (`inner` if it is not none, else `edge`) — the same rule `armOf` used to pick a mesh.
 */
export function armDomain(inner: Mask, edge: Mask): Mask {
  let out = 0;
  for (const i of valuesOf(OLD_SEGS, inner)) {
    for (const e of valuesOf(OLD_SEGS, edge)) {
      const t: CellSeg = i !== 'none' ? i : e !== 'none' ? e : 'none';
      out |= segs(t);
    }
  }
  return out;
}

/** Old floor masks and new floor masks share a value order, so a floor domain carries across as-is. */
export const floorDomain = (m: Mask): Mask => {
  let out = 0;
  for (const f of valuesOf(OLD_FLOORS, m)) out |= floors(f);
  return out;
};

/**
 * The 4u model had one wallType enum where the 2u model now has a KIND and a STATE. Each old value
 * carries both halves — `door` was a doorway that is open, `low_gate` a gate that is not — so the
 * conversion returns a pair rather than a renamed mask.
 */
const OLD_TO_NEW: Record<(typeof OLD_WALLTYPES)[number], { kind: WallType; open: Open }> = {
  solid: { kind: 'solid', open: 'closed' },
  door: { kind: 'doorway', open: 'open' },
  window: { kind: 'window', open: 'open' },
  hole: { kind: 'cracked', open: 'open' },
  arch: { kind: 'arch', open: 'open' },
  low_gate: { kind: 'gate', open: 'closed' },
};
export const wallTypeDomain = (m: Mask): { wallType: Mask; open: Mask } => {
  let kind = 0, open = 0;
  for (const t of valuesOf(OLD_WALLTYPES, m)) {
    const n = OLD_TO_NEW[t];
    kind |= wallTypes(n.kind);
    open |= opens(n.open);
  }
  return { wallType: kind || wallTypes('solid'), open: open || opens('closed') };
};

/**
 * The old `centre` said what the junction DID, not whether it was open:
 *   none    → walls pass through solid          → `solid`
 *   wall    → a pillar                          → `column`
 *   barrier → a low pillar                      → `column`  (LOSSY: the low-ness is dropped)
 * `air` never arises from this mapping — an opening was inferred from wallType, and
 * `cornerDomainFor` handles that case.
 */
export function centreDomain(m: Mask): Mask {
  let out = 0;
  for (const c of valuesOf(OLD_CENTRES, m)) {
    const to: Corner = c === 'none' ? 'none' : 'column';
    out |= corners(to);
  }
  return out;
}

/** Did this tile CERTAINLY carry a walk-through opening — a door or arch on a full straight line?
 *  That is exactly the old render condition, so a tile that drew an archway converts to an `air`
 *  corner and a tile that did not keeps its junction. */
export function certainOpening(t: OldTileField): boolean {
  const openOnly = (m: Mask): boolean => m !== 0 && valuesOf(OLD_WALLTYPES, m).every((v) => v === 'door' || v === 'arch');
  const pinnedWall = (m: Mask): boolean => m === (1 << OLD_SEGS.indexOf('wall'));
  const lineEW = pinnedWall(t.inner.E) && pinnedWall(t.inner.W);
  const lineNS = pinnedWall(t.inner.N) && pinnedWall(t.inner.S);
  return openOnly(t.wallType) && (lineEW || lineNS);
}

/** The corner domain for the tile centre. An opening no longer needs the corner to agree — the wall
 *  TYPE decides passability on its own — so a certain opening simply leaves nothing standing there. */
export const cornerDomainFor = (t: OldTileField): Mask =>
  certainOpening(t) ? corners('none') : centreDomain(t.centre);

/* --------------------------------- the conversion --------------------------------- */

/**
 * What an E/S edge resolves to at the structure's own border, where there is no neighbour inside it.
 *
 *   'abstain' — the structure says nothing about what lies beyond it. CORRECT for a patch that gets
 *               stamped into a world: it owns its interior, not its surroundings.
 *   'wall'    — the closed-shell reading the old `resolveGrid` used for a whole map. Only useful for
 *               comparing against that resolver, which is what the migration test does.
 */
export type BorderPolicy = 'abstain' | 'wall';

const FULL_SEG: Mask = segs('none', 'wall', 'barrier');

/**
 * Convert one saved 4u structure into a 2u `CellGrid` of twice the width and height.
 *
 * The E and S arms need their neighbour's OWNED edge — `edge.E of A` is `edge.W of B` — so this
 * resolves across the structure the same way the old grid resolver did. Getting that wrong empties
 * every domain, which is exactly what the migration test caught.
 */
export function migrateStructure(s: OldStructure, border: BorderPolicy = 'abstain'): CellGrid {
  // PADDED BY ONE. The stored grid is the lattice of POINTS, not the grid of cells: a w×h structure
  // stores (w+1)×(h+1) fields, so it owns all FOUR of its border walls rather than only N and W.
  // Without that, rotating a structure pushes its north and west walls onto sides no cell can own and
  // they vanish — four quarter-turns stopped being the identity. The extra row and column carry walls
  // and corners only; their floor is meaningless and abstains.
  const g = makeGrid(s.w * 2 + 1, s.h * 2 + 1);
  const put = (x: number, y: number, f: CellField): void => { g.cells[y * g.w + x] = f; };

  for (let ty = 0; ty < s.h; ty++) {
    for (let tx = 0; tx < s.w; tx++) {
      const t = s.cells[ty * s.w + tx]!;
      const bx = tx * 2, by = ty * 2;
      const NONE = segs('none');
      const outside = border === 'wall' ? segs('wall') : FULL_SEG;
      // the neighbour owns this tile's E and S edges
      const east = tx + 1 < s.w ? s.cells[ty * s.w + tx + 1]! : null;
      const south = ty + 1 < s.h ? s.cells[(ty + 1) * s.w + tx]! : null;
      const edgeE = east ? east.edge.W : outside;
      const edgeS = south ? south.edge.N : outside;

      // A — NW quadrant: its own two walls sit on the tile boundary, so they are `none`
      put(bx, by, template({ floor: floorDomain(t.floor.nw), wallN: NONE, wallW: NONE }));
      // B — NE: its W wall IS the tile's N arm
      put(bx + 1, by, template({
        floor: floorDomain(t.floor.ne),
        wallN: NONE,
        wallW: armDomain(t.inner.N, t.edge.N),
      }));
      // C — SW: its N wall IS the tile's W arm
      put(bx, by + 1, template({
        floor: floorDomain(t.floor.sw),
        wallN: armDomain(t.inner.W, t.edge.W),
        wallW: NONE,
      }));
      // D — SE: owns the tile CENTRE, so it carries the E arm, the S arm, the junction and the type
      put(bx + 1, by + 1, template({
        floor: floorDomain(t.floor.se),
        wallN: armDomain(t.inner.E, edgeE), // E arm — horizontal, between B and D
        wallW: armDomain(t.inner.S, edgeS), // S arm — vertical, between C and D
        corner: cornerDomainFor(t),
        ...wallTypeDomain(t.wallType),
      }));
    }
  }
  return g;
}

/** The serialisable form the new store keeps. */
export interface CellStructure {
  w: number;
  h: number;
  cells: CellField[];
}

export const toStructure = (g: CellGrid): CellStructure => ({ w: g.w, h: g.h, cells: g.cells });
