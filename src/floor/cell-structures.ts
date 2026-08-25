// ============================================================================
// src/floor/cell-structures.ts — the authored structures, on the 2u cell grid.
// ============================================================================
//
// Hand-painted patches of map — a room, a hallway, a junction — authored in the tile editor and saved
// to a git-tracked store so the GENERATOR can place them deterministically. These are the ONLY rooms
// the emergent generator places; there is no procedural room shape.
//
// Stored as FIELDS (domains), not collapsed cells, so a half-painted structure keeps its freedom and
// the generator collapses it with its own seeded pick. Anything the author did not paint abstains,
// which is what lets a structure sit in a maze without dictating its surroundings.
//
// Produced by `structure-migrate.ts` from the 4u store, verified cell-for-cell against the old
// resolver (`structure-migrate.test.ts`). The `from` field records the original tile dimensions.

import data from './cell-structures.json' with { type: 'json' };
import { fullField, type CellField } from './cell-field.ts';
import { makeGrid, type CellGrid } from './cell-grid.ts';

/**
 * THE STORED GRID IS THE LATTICE OF POINTS, not the grid of cells.
 *
 * `w` × `h` is the FLOOR extent — what you would call the size of the room. The `cells` array is
 * (w+1) × (h+1), because each entry describes what happens at one lattice POINT:
 *
 *   wallN     the horizontal edge running EAST from this point
 *   wallW     the vertical edge running SOUTH from this point
 *   corner    the junction AT this point
 *   floor     the ground of the cell to this point's south-east (meaningless on the last row/column)
 *
 * The padding is what makes a structure SYMMETRIC: it owns all four of its border walls instead of
 * only N and W. Without it, rotating pushes the north and west walls onto sides no cell can own and
 * they simply vanish — four quarter-turns stopped being the identity, which is how this was found.
 */
export interface CellStructure {
  /** FLOOR extent. The `cells` array is (w+1)×(h+1) per LEVEL — see above. */
  w: number;
  h: number;
  /**
   * How many STOREYS this structure occupies. Omitted means one, so every structure authored before
   * levels existed still reads correctly.
   *
   * A structure is not always a floor plan. A staircase needs to say something about the storey ABOVE
   * it — that there is a hole in that floor to climb through, and no wall standing where you arrive —
   * and there is nowhere to say that on a single level. Levels are stacked FLOOR_HEIGHT apart, level 0
   * lowest, and each is a complete point lattice of its own.
   */
  levels?: number;
  /** `levels * (w+1) * (h+1)` fields, indexed `cells[level * levelSize + py * (w+1) + px]`. */
  cells: CellField[];
  /** Provenance: the 4u dimensions this was converted from. */
  from?: string;
}

/** Row stride of the stored point lattice. */
export const stride = (s: { w: number }): number => s.w + 1;
/** Storeys. Absent means one — see `CellStructure.levels`. */
export const levelsOf = (s: { levels?: number }): number => Math.max(1, s.levels ?? 1);
/** Entries in ONE level's point lattice. */
export const levelSize = (s: { w: number; h: number }): number => (s.w + 1) * (s.h + 1);
/** Index of a point on a given level. */
export const pointAt = (s: { w: number; h: number }, level: number, px: number, py: number): number =>
  level * levelSize(s) + py * (s.w + 1) + px;

/**
 * WHAT A PADDED LATTICE ACTUALLY OWNS. The trailing row and column exist to carry the south and east
 * borders, and nothing else — so at those points most slots describe somewhere the structure has no
 * business describing:
 *
 *   wallN   the edge running EAST from the point   — owned where px < w
 *   wallW   the edge running SOUTH from the point  — owned where py < h   (a SEPARATE test, not the same)
 *   floor   the cell to the point's south-east     — owned where px < w AND py < h
 *   corner, wallType — properties of the POINT itself, so they are owned everywhere
 *
 * The two edge tests are independent: at the south-east corner point neither holds, but along the east
 * column `wallW` is owned (it IS the east border) while `wallN` is not.
 */
export const ownsWallN = (px: number, w: number): boolean => px < w;
export const ownsWallW = (py: number, h: number): boolean => py < h;
export const ownsFloor = (px: number, py: number, w: number, h: number): boolean => px < w && py < h;

/**
 * Make every UNOWNED slot abstain. This is the STORAGE form, and the distinction it turns on is the
 * one this model keeps punishing people for getting backwards:
 *
 *   ABSTAIN (full domain) = "I have no opinion about this."   <- what a structure owes its surroundings
 *   ASSERT  (pinned none) = "this is air."                    <- a claim, and out here a false one
 *
 * `structureStamp` stamps the WHOLE lattice, padding included, so a structure that stores `none` in its
 * padding is not merely untidy — it stamps "no floor and no wall here" onto the strip of map just past
 * its own extent, punching a void along its south and east faces and forbidding a corridor from running
 * flush against it. Abstaining AND-gates to a no-op instead, which is the only correct answer for ground
 * the structure does not own.
 *
 * The editor still PINS the same slots to `none` for its schematic, where the requirement is the exact
 * opposite — draw nothing rather than claim nothing. Same predicate, opposite fill, different job.
 *
 * Idempotent.
 */
/**
 * GIVE EVERY STORED CELL A `ceiling`, because none of them were saved with one.
 *
 * `ceiling` arrived after every structure in the store was authored, so the JSON has no such key and
 * the field reads `undefined` — which is not a domain, and quietly poisons every mask operation that
 * touches it. Normalised HERE, on the way out, for the same reason `abstainUnowned` is: the file is
 * an old format and nothing downstream should have to know that.
 *
 * PINNED TO `none`, not abstaining. A structure authored before ceilings existed said nothing about
 * them, and "nothing" here means an open room, not "help yourself" — an abstaining lid would let the
 * generator settle a ceiling onto every cell of every old structure, roofing rooms whose authors drew
 * them open. The editor's back-fill is how a ceiling gets added, deliberately.
 */
export function withCeilings(cells: readonly CellField[]): CellField[] {
  const NONE_FLOOR = 1;   // bit 0 of the floor value set is `none` — the same set the lid draws from
  return cells.map((f) => (f.ceiling === undefined ? { ...f, ceiling: NONE_FLOOR } : f));
}

export function abstainUnowned(cells: readonly CellField[], w: number, h: number): CellField[] {
  const s = w + 1, size = (w + 1) * (h + 1);
  const full = fullField();
  return cells.map((f, i) => {
    const within = i % size;               // the same lattice repeats once per LEVEL
    const px = within % s, py = Math.floor(within / s);
    const n = ownsWallN(px, w), e = ownsWallW(py, h), g = ownsFloor(px, py, w, h);
    if (n && e && g) return f;
    /* `ceiling` is CELL-OWNED, exactly like `floor` — the lid of the square south-east of this point —
       so it is owned by the same test and abstains in the same padding. Missing it here left the
       padding claiming a lid it does not own, which is the assert-vs-abstain error this whole function
       exists to prevent. */
    return {
      ...f,
      wallN: n ? f.wallN : full.wallN,
      wallW: e ? f.wallW : full.wallW,
      floor: g ? f.floor : full.floor,
      ceiling: g ? f.ceiling : full.ceiling,
    };
  });
}

const store = data as unknown as {
  version: number;
  valueSets?: { seg: number; floor: number; corner: number; wallType: number };
  structures: Record<string, CellStructure>;
};

/**
 * The value-set sizes these masks were written against.
 *
 * A domain is a bitmask indexed by POSITION, so appending a value to any enum silently changes what an
 * existing mask means: a floor mask of 15 meant "any material" when there were four, and means "any
 * material EXCEPT rock" now there are five. Nothing breaks loudly — a structure just quietly stops
 * abstaining where it used to. `cell-structures.test.ts` asserts these still match the live enums, so
 * the next person to append a value is told to re-run the migration instead of finding out later.
 */
export const STORED_VALUE_SETS = store.valueSets;

export const STRUCTURE_VERSION = store.version;
/** Names in a FIXED order — sorted, so any iteration over structures is deterministic. */
export const listStructures = (): string[] => Object.keys(store.structures).sort();

/**
 * WHICH CONTENT A RESULT WAS MEASURED AGAINST.
 *
 * This store is authored by a human through a live dev server WHILE sessions are testing against it,
 * so it moves under you. A before/after comparison that straddles a save is not a comparison at all,
 * and it fails silently: both runs look valid and the conclusion is wrong. It has already happened —
 * an isolation blaming one structure was run across an edit to a different one, twice.
 *
 * So anything whose result depends on the CONTENT prints this. A stale comparison then shows up as two
 * different fingerprints instead of two numbers that seem to disagree for no reason.
 *
 * Deliberately cheap and human-readable rather than a hash: when it changes you can SEE what changed.
 */
export function storeFingerprint(): string {
  const parts = listStructures().map((n) => {
    const st = store.structures[n]!;
    const saved = (st as { savedAt?: string }).savedAt;
    return `${n} ${st.w}x${st.h}L${levelsOf(st)}${saved ? `@${saved.slice(11, 16)}` : ''}`;
  });
  return `v${store.version} [${parts.join(', ')}]`;
}
/**
 * A structure, normalised on the way OUT rather than trusted from the file. Two things happen here:
 *
 *   - the padding is made to ABSTAIN (see `abstainUnowned`) — an older editor saved it pinned to
 *     `none`, and nothing downstream should have to know that;
 *   - the result is rebuilt from the DECLARED fields only, so the dev server's `savedAt` stamp does
 *     not ride along. An orientation of a structure has no meaningful save time, so `orientStructure`
 *     drops it — which quietly stopped `orient(identity) === input` from holding.
 */
export const getStructure = (name: string): CellStructure | undefined => {
  const s = store.structures[name];
  if (!s) return undefined;
  return {
    w: s.w, h: s.h,
    ...(levelsOf(s) > 1 ? { levels: levelsOf(s) } : {}),
    cells: abstainUnowned(withCeilings(s.cells), s.w, s.h),
    ...(s.from !== undefined ? { from: s.from } : {}),
  };
};

/**
 * ONE STOREY of a structure as a standalone grid, ready to resolve or preview.
 *
 * A grid is a single lattice, so a multi-storey structure cannot be one — asking for the whole thing
 * would hand back a grid whose dimensions disagree with its own array length, which is what this did
 * before levels existed.
 */
export function structureGrid(name: string, level = 0): CellGrid | undefined {
  const s = getStructure(name);
  if (!s || level < 0 || level >= levelsOf(s)) return undefined;
  const g = makeGrid(s.w + 1, s.h + 1); // the point lattice, not the floor extent
  const size = levelSize(s);
  g.cells = s.cells.slice(level * size, (level + 1) * size).map((f) => ({ ...f }));
  return g;
}
