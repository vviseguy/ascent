// ============================================================================
// src/floor/cell.ts — the CELL: one 2u square, and the whole structural model.
// ============================================================================
//
// A cell is 2u — a QUARTER of the 4u tile the meshes are authored at, so a "tile" is now simply a
// 2×2 group of cells and carries no data of its own.
//
// Everything a cell owns is on its own north-west side:
//
//        (x,y)────wallN────(x+1,y)          wallN — the lattice segment (x,y)→(x+1,y)
//          │                  │             wallW — the lattice segment (x,y)→(x,y+1)
//        wallW   floor        │             floor — ONE material for the whole square
//          │                  │             the NW corner POINT (x,y) is owned too
//        (x,y+1)───────────(x+1,y+1)
//
// A cell's SOUTH wall is the south neighbour's `wallN`; its EAST wall is the east neighbour's
// `wallW`. Single ownership, exactly as before — but now it is the ONLY rule in the model, because
// there is nothing left that a cell could disagree with a neighbour about.
//
// WHY THIS REPLACED THE 9-CELL TILE. The old 4u tile split each side into `inner` + `edge` and kept a
// `centre`, so that a coarse cell could express detail finer than itself. That is a sub-grid
// simulated inside a cell — so we now just have the sub-grid, and every irregularity the simulation
// caused disappears with it:
//   • an arm was 2u and could be HALF expressed (inner without edge) — rendering a full wall while
//     reading as passable. A wall is now one cell; present or absent. That bug is unrepresentable.
//   • the CROSS seam (three cells across two tiles describing one wall) — a wall is one owned cell.
//   • the POINT seam (four floor quadrants meeting at a lattice point) — floor is one value per cell.
//   • the `centre` cell — now an ordinary lattice point.
// The mesh library already matches: `wall_half` is exactly a 2u segment and the floor pieces render
// at half scale, so the pieces stop being *halves of* something and become the unit.
//
// THE CORNER carries the structure of the junction, and it is what makes an opening a LOCAL fact.
// Every lattice point is the NW corner of exactly one cell, so the cell owns it:
//
//     solid   the walls meeting here join through it (the ordinary case)
//     column  a pillar stands here
//     air     there is a HOLE at the junction — the precondition for a door or an archway
//
// `wallType` says which 4u module is drawn there. A door or arch requires `air`; the solid-looking
// kinds (window / hole / low_gate) require a `solid` corner. So "is there a way through here?" reads
// TWO fields on ONE cell — no neighbour lookup — which is what the old model could not do.
//
// The axis is DERIVED, never stored: a straight run through the point is either its two horizontal
// arms or its two vertical arms, and which one it is falls out of the walls. That is why there is one
// `wallType` and not an openH/openV pair — the arch's orientation is a fact about the walls, and
// storing it twice would be storing something that can disagree with them.
//
// A 2u doorway needs no opening at all — just leave the wall segment out.
//
// Pure + deterministic: plain enums, no float, no RNG, no Map iteration on an output-affecting path.

/**
 * One wall segment.
 *   none     nothing is there
 *   wall     full height — stops a body
 *   barrier  low — you get over it
 *   sloped   a ramp from full height down to barrier height. NOT traversable itself; it is what lets
 *            a wall meet a barrier without a step change.
 *
 * APPEND-ONLY. A domain is a bitmask indexed by position in this list, and structures are serialised
 * as those masks, so adding a value at the END keeps every stored mask meaning what it meant. Never
 * insert or reorder.
 */
export type Seg = 'none' | 'wall' | 'barrier' | 'sloped';
export const SEGS: readonly Seg[] = ['none', 'wall', 'barrier', 'sloped'];

/** The segment kinds a body cannot pass. Kept as a LIST so adding another blocking kind is one edit
 *  here rather than a hunt through every passability test. */
export const BLOCKING_SEGS: readonly Seg[] = ['wall', 'sloped'];

/**
 * Ground material for a cell.
 *   none            a PIT — no floor is emitted, you fall through
 *   stone/dirt/wood walkable ground
 *   rock            SOLID FILL — the cell is not a place at all. This is the fallback that turns an
 *                   unreachable pocket into filled stone, so a floor reads as carved OUT of rock
 *                   rather than as an open field someone put walls on.
 *   stairs          part of a STAIR FLIGHT — a rectangular block of stair cells. Which way it climbs
 *                   and which mesh it uses are DERIVED from the walls around it, never stored (see
 *                   `cell-place.ts:stairFlight`). A block that is not a flight draws as ordinary
 *                   ground.
 *   stairs_wood     the same, in wood. A separate material rather than a dressing, because a wooden
 *                   flight is shallower and needs a THREE-cell run where a stone one needs two.
 *
 * APPEND-ONLY, like `SEGS` — masks are serialised by bit position.
 */
export type FloorMaterial =
  'none' | 'stone' | 'dirt' | 'wood' | 'rock' | 'stairs' | 'stairs_wood' | 'grate';
/* APPENDED, AND THE APPEND IS THE FEATURE. Masks are serialised by BIT POSITION, so a value added at
   the end takes a bit no stored mask has ever set — every structure authored before this one simply
   cannot be a grate, which is exactly the wanted answer for a material nobody has placed yet. Insert
   it anywhere else and every mask in the store silently shifts meaning. */
export const FLOOR_MATERIALS: readonly FloorMaterial[] =
  ['none', 'stone', 'dirt', 'wood', 'rock', 'stairs', 'stairs_wood', 'grate'];

/** The stair materials, and how deep a flight of each has to be. A stone flight climbs its storey in
 *  2 cells; the wooden one is a shallower stair and needs 3. So the material is not a skin — it
 *  changes the footprint, which is why it is AUTHORED rather than guessed from the surroundings. */
export const STAIR_FLOORS: readonly FloorMaterial[] = ['stairs', 'stairs_wood'];
// a TYPE GUARD, not a boolean: the placement code narrows `floor` through it to prove the
// remaining branch handles only the materials that have a plain ground mesh
export const isStairFloor = (f: FloorMaterial): f is 'stairs' | 'stairs_wood' =>
  f === 'stairs' || f === 'stairs_wood';

/** Is this cell solid fill — somewhere a body can never be? Unlike every other floor value this one
 *  affects TRAVERSAL: a rock cell contributes no edges at all, walls notwithstanding. */
export const floorSolid = (f: FloorMaterial): boolean => f === 'rock';

/** What a 4u opening looks like. `solid` means there is no opening here. */
export type WallType =
  | 'solid' | 'doorway' | 'arch' | 'window' | 'arch_window'
  | 'scaffold' | 'cracked' | 'gate' | 'pillar';
/**
 * APPEND-ONLY, and the order is the storage format. A domain is a bitmask indexed by POSITION, so a
 * value appended at the end costs one bit and shifts nothing; inserting one silently rewrites the
 * meaning of every mask already saved. The first six are the original set and must stay put.
 *
 * Which mesh each draws is in `cell-place.ts:WALLTYPE_URL`, and every one of these was MEASURED before
 * it was listed (see the asset audit) — several of the kit's names promise a hole that is not there.
 */
export const WALL_TYPES: readonly WallType[] = [
  'solid',        // no module at all — the run system lays a plain wall
  'doorway',      // a framed opening: a leaf when closed, a 2.00 x 2.70 arch when open
  'arch',         // stone arch: a blind relief when closed, the same aperture when open
  'window',       // 1.40 x 1.30 at sill 1.30
  'arch_window',  // 2.00 x 1.60 at sill 1.05 — barred when closed
  'scaffold',     // timber trim; the open form is a bare post-and-lintel frame, 3.40 clear
  'cracked',      // damaged masonry; the open form is a ragged breach
  'gate',         // a portcullis on a 0.75 sill
  'pillar',       // an engaged pillar standing proud of the wall
];

/**
 * IS THERE A HOLE IN IT — separately from what it is.
 *
 * The catalogue used to spend a value on each half of a pair: `window` and `window_closed`,
 * `cracked` and `hole`, `scaffold` and `arch_scaffold`, `arch` and `arch_blind`. Every one of those
 * pairs is the SAME feature in two states, and encoding them as unrelated enum entries meant the
 * relationship existed only as a naming convention — nothing could ask "the closed form of this", and
 * nothing stopped a tenth entry breaking the pattern.
 *
 * `shelves` went too: it is a plain wall with a shelf on it, and `shelf_large` / `shelf_small` /
 * `shelf_small_candles` are all standalone props. A wall type that is a wall plus a prop we already
 * have is a duplicate of both.
 *
 * Nine kinds and two states describe more of the kit than fifteen kinds did, and the whole cell fits
 * in 31 bits again: 7 + 4 + 4 + 3 + 9 + 2 + 2.
 */
export type Open = 'closed' | 'open';
export const OPENS: readonly Open[] = ['closed', 'open'];

/**
 * THE KINDS THAT ACTUALLY LET YOU THROUGH WHEN OPEN — measured, not inferred from the name.
 *
 * Being open is not the same as being passable. An open window is a hole at sill height 1.30; an open
 * `arch_window` sits at 1.05; an open `cracked` is a ragged breach that pinches to 0.10. You can see
 * through all three and walk through none of them. Only these three are floor-rooted and body-wide.
 */
export const PASSABLE_KINDS: readonly WallType[] = ['doorway', 'arch', 'scaffold'];

/**
 * GRATES: you see through them even CLOSED, because closed does not mean solid for these two.
 * `gate` is a portcullis — bars on a sill — and `arch_window` is barred rather than glazed when it is
 * shut. Everything else that is closed really is closed: a door has a leaf, a blind arch is a relief
 * cut into solid stone, a closed window is infilled, and all three were measured, not assumed.
 */
export const GRATE_KINDS: readonly WallType[] = ['gate', 'arch_window'];

/**
 * CAN YOU SEE THROUGH IT — a third question, and not the same as either of the other two.
 *
 * There are three separate properties here and conflating any pair of them has already cost a bug:
 *   drawn        `moduleAt`      — is a 4u module rendered at this point
 *   walkable     `isOpenType`    — can a body get through it
 *   SEE-THROUGH  this            — does it stop the eye
 *
 * An open window is a hole at sill height: see through, walk through no. A closed portcullis is bars:
 * see through, walk through no. A closed door is neither. `solid` is not a module at all, so the run
 * lays a plain wall and nothing gets through.
 */
export const seesThrough = (wt: WallType, open: Open): boolean =>
  wt !== 'solid' && (open === 'open' || GRATE_KINDS.includes(wt));
/** Can a body walk through this wall? BOTH halves have to agree — the kind and the state. */
export const isOpenType = (wt: WallType, open: Open): boolean =>
  open === 'open' && PASSABLE_KINDS.includes(wt);

/** What stands at a lattice point where walls meet. `air` is a hole — the precondition for a door. */
/**
 * WHAT STANDS AT A JUNCTION — and only that.
 *
 * It used to be `solid | column | air`, where `solid` and `air` both drew NOTHING and differed only in
 * whether an opening at that point counted as walk-through. That put a fact about the OPENING into the
 * corner field, so a door was traversable or not depending on a second field you had to remember to
 * set, and the two disagreed constantly. Passability now comes from the wall type alone (`isOpenType`),
 * which is where it was always described, and the corner says only what is standing there.
 *
 * `column` is the full-height pillar; `balcony` is the short post — a rail height marker for an edge
 * you can see over.
 */
export type Corner = 'none' | 'column' | 'balcony';
export const CORNERS: readonly Corner[] = ['none', 'column', 'balcony'];

/** The four directions, in the fixed order every iteration uses. */
export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

/** Which axis an opening spans. */
export type Axis = 'H' | 'V';
export const AXES: readonly Axis[] = ['H', 'V'];

/** One 2u square. Every field is OWNED by this cell — see the header for what that means. */
/**
 * A torch bracket at this junction. A domain like everything else, so a structure can leave it open
 * and let the generator decide, or pin it.
 *
 * WHICH WAY IT FACES IS NOT STORED — it is read from the walls, the same way a flight's direction and
 * an opening's axis are. A torch mounts on whatever it is standing against and faces a direction you
 * can actually see it from; see `cell-place.ts:torchFacing`.
 */
export type Torch = 'no' | 'yes';
export const TORCHES: readonly Torch[] = ['no', 'yes'];

export interface Cell {
  floor: FloorMaterial;
  /**
   * THE LID — a second surface, facing DOWN, drawn from the same tiles as the floor.
   *
   * NOT the underside of the deck above, which is what it looks like from inside a room and is the
   * wrong model: they are two tiles, one facing up and one facing down, that happen to describe one
   * surface. Making the ceiling a reading of the floor above ties a room's lid to a storey that may
   * not exist and cannot be given its own material.
   *
   * `none` means open to whatever is above. It settles to `none`, so nothing sprouts a ceiling it was
   * not given: the editor's back-fill puts one in where the storey above has floor, and that is a
   * deliberate act rather than a default.
   */
  ceiling: FloorMaterial;
  /** The wall along this cell's north edge: the lattice segment (x,y)→(x+1,y). */
  wallN: Seg;
  /** The wall along this cell's west edge: the lattice segment (x,y)→(x,y+1). */
  wallW: Seg;
  /** What STANDS at this cell's NW corner point — nothing, a pillar, or a balcony post. It says
   *  nothing about passability; see `Corner`. */
  corner: Corner;
  /** Which 4u module is drawn at that corner — WHAT it is, not whether it has a hole. */
  wallType: WallType;
  /** Whether that module has a hole in it. With `wallType`, decides passability (`isOpenType`). */
  open: Open;
  /** A torch bracket at this point. See `Torch`. */
  torch: Torch;
}

/** A plain open cell: stone ground, no walls, no openings. */
export const openCell = (floor: FloorMaterial = 'stone'): Cell => ({
  floor, ceiling: 'none', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no',
});

/** Does this wall segment stop a body? `wall` and `sloped` do; `barrier` is surmountable and `none`
 *  is not there. One value, one test — there is no half-expressed wall to reason about. */
export const blocks = (s: Seg): boolean => BLOCKING_SEGS.includes(s);

/** The neighbour whose cell OWNS the wall on side `d` of cell (x,y), and which of its two walls it is.
 *  N and W are the cell's own; S and E belong to the neighbour beyond them. */
export function wallOwner(x: number, y: number, d: Dir): { x: number; y: number; side: 'N' | 'W' } {
  if (d === 'N') return { x, y, side: 'N' };
  if (d === 'W') return { x, y, side: 'W' };
  if (d === 'S') return { x, y: y + 1, side: 'N' };
  return { x: x + 1, y, side: 'W' }; // 'E'
}

/** Step from a cell to its neighbour in direction `d`. */
export const stepped = (x: number, y: number, d: Dir): { x: number; y: number } =>
  d === 'N' ? { x, y: y - 1 } : d === 'S' ? { x, y: y + 1 } : d === 'E' ? { x: x + 1, y } : { x: x - 1, y };

/** The opposite direction — used when a rule has to be stated from the other side of a shared wall. */
export const opposite = (d: Dir): Dir => (d === 'N' ? 'S' : d === 'S' ? 'N' : d === 'E' ? 'W' : 'E');

/** Is there a hole at this cell's corner that a body can actually get through? Both fields are on
 *  THIS cell — the local half of the test. The axis still has to be derived from the walls. */
/** Is there a walk-through opening here? The WALL TYPE says so, and nothing else needs to agree. */
export const cornerIsOpen = (c: Cell): boolean => isOpenType(c.wallType, c.open);

/**
 * The four cells around the lattice point owned by cell (x,y) — its NW corner — split into the two
 * groups an opening on each axis connects.
 *
 * A HORIZONTAL opening is a hole in the horizontal wall run through the point, so it lets a body
 * cross NORTH↔SOUTH anywhere along its 4u span: every north cell reaches every south cell. A VERTICAL
 * opening does the same across WEST↔EAST.
 *
 * Deliberately NOT "all four join". The perpendicular wall run still meets the point and its end
 * stands in the doorway, so claiming (say) NW↔NE off the back of a horizontal door would be an
 * over-claim — and over-claiming reachability is the one direction a solvability check must never err.
 */
export function openingGroups(x: number, y: number, axis: Axis): { a: { x: number; y: number }[]; b: { x: number; y: number }[] } {
  const nw = { x: x - 1, y: y - 1 }, ne = { x, y: y - 1 };
  const sw = { x: x - 1, y }, se = { x, y };
  return axis === 'H' ? { a: [nw, ne], b: [sw, se] } : { a: [nw, sw], b: [ne, se] };
}

/** The wall segments a point-centred opening spans, as owner references. A horizontal opening covers
 *  the `wallN` of the cells west and east of the point; a vertical one covers the `wallW` of the cells
 *  north and south of it. */
export function openingWalls(x: number, y: number, axis: Axis): { x: number; y: number; side: 'N' | 'W' }[] {
  return axis === 'H'
    ? [{ x: x - 1, y, side: 'N' }, { x, y, side: 'N' }]
    : [{ x, y: y - 1, side: 'W' }, { x, y, side: 'W' }];
}
