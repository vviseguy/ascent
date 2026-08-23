// ============================================================================
// src/floor/cell-emergent.ts — the all-emergent floor generator, on the 2u cell grid.
// ============================================================================
//
// NOTHING IS DRAWN FIRST. There is no coarse map that decides the layout and no procedural room
// shape. The floor starts as a blank field where every cell allows everything, and the layout is what
// is left after a sequence of NARROWINGS, each of which must survive a reachability gate.
//
// The safety argument is the base case: a blank field is `fullField()` everywhere, so every wall MAY
// be open and the floor is maximally connected. `andGate` only ever REMOVES options. So if every
// commit is gated on "no cell that was reachable has been lost", the floor is completable at EVERY
// moment, by induction. Connectivity is never added, only defended — which is why nothing has to be
// reserved up front.
//
// THE PHASES, in dependency order rather than as barriers:
//
//   1. STRUCTURES  the ONLY rooms. Hand-authored patches from `cell-structures.json`, stamped whole
//                  or not at all. Their PERIMETER is stamped porous ({none, wall}) so the later
//                  phases can decide where the doors go; their interior lands exactly as painted.
//   2. ROUTE+PIN   discover a route from the entry to each target IN THE FIELD (never on a map drawn
//                  beforehand) and pin its walls open, turning "achievable" into "guaranteed".
//   3. SEAL        try to close every porous perimeter wall. The ones that REFUSE to close — because
//                  closing them would strand a cell or break a pinned route — are the doors. Doors
//                  are discovered, not placed.
//   4. MAZE        a carver (`cell-maze.ts`) proposes walls; each must keep every cell reachable.
//   5. SETTLE      narrow everything still undecided, so the field is fully determined and the
//                  collapse pick has nothing left to choose.
//
// Deterministic: seeded sub-streams per phase, index-sorted iteration, integer hashes, no float.

import { makeGrid, begin, stamp, commit, rollback, txConflicts, resolveGrid, type CellGrid, type Region } from './cell-grid.ts';
import {
  previewCell, template, settleMask, segs, floors, corners, wallTypes, torches, domainSize,
  type Mask, type CellField,
} from './cell-field.ts';
import { nodeId } from './cell-graph.ts';
import {
  gridAt, txAt, findRoute, pinRouteOpen, routeGuaranteed, reachSet, keepsReach, stillConnected,
  type StepEdge,
} from './cell-reach.ts';
import { planMaze, type MazeParams } from './cell-maze.ts';
import { getStructure, levelsOf, listStructures, type CellStructure } from './cell-structures.ts';
import { orientStructure, ORIENTATIONS, type Orientation } from './cell-orient.ts';
import { makeRng, subStream, nextInt, mixSeeds, type Rng } from './rng.ts';
import { isStairFloor, type Cell } from './cell.ts';
import { torchFacings } from './cell-place.ts';

const WALL: Mask = segs('wall');
const NONE: Mask = segs('none');
const POROUS: Mask = segs('none', 'wall');
const STONE: Mask = floors('stone');
const SOLID_CORNER: Mask = corners('none');
const SOLID_TYPE: Mask = wallTypes('solid');
const ROCK: Mask = floors('rock');
const TORCH_YES: Mask = torches('yes');
/** Roughly one lit point per this many candidates, before spacing thins them further. */
const TORCH_EVERY = 7;
/** No two torches closer than this, in cells — a hash alone clumps. */
const TORCH_SPACING = 5;

/** Sub-stream tags — stable, so adding a phase never shifts an earlier one's output. */
const STREAM = { structures: 1, maze: 2, pick: 3, torches: 4 } as const;

export interface EmergentConfig {
  width: number;
  height: number;
  seed: bigint;
  /** How many COPIES of each structure to try placing. Default scales with the map. */
  structureAttempts?: number;
  /** Which carver shapes the space between structures. */
  maze?: MazeParams;
  /**
   * Where structures come from. Defaults to the authored store.
   *
   * A seam, not a knob: multi-storey placement is the generator's most consequential behaviour and it
   * cannot be exercised at all unless a multi-storey structure exists, so without this the only way to
   * test it would be to put one in the shipped store and assert against art someone may edit.
   */
  structures?: StructureSource;
}

export interface StructureSource {
  names: () => string[];
  get: (name: string) => CellStructure | undefined;
}

const AUTHORED: StructureSource = { names: listStructures, get: getStructure };

export interface PlacedStructure {
  name: string;
  /** Which of the eight orientations it was placed in. */
  orientation: Orientation;
  region: Region;
  /** The cell at its middle — the target the router must reach, so the room is enterable. */
  centre: number;
}

export interface EmergentResult {
  grid: CellGrid;
  placed: PlacedStructure[];
  entry: number;
  exit: number;
  /** Routes pinned open. Every later phase must keep all of them guaranteed. */
  routes: StepEdge[][];
  stats: {
    structuresPlaced: number;
    /** Declined for being taller than the tower. */
    structuresSkippedMultiLevel: number;
    /** Storeys left with no stairwell, so no way up. Non-zero means the tower is not climbable —
     *  either the store has no multi-storey staircase, or one would not fit. */
    storeysWithoutStairwell: number;
    structuresRejectedConflict: number;
    structuresRejectedOverlap: number;
    wallsPlaced: number;
    wallsRejectedConflict: number;
    wallsRejectedUnreachable: number;
    ringSealed: number;
    doorsKept: number;
    mazeNote: string;
    reachableCells: number;
    /** Cells the maze sealed off, marked as solid rock rather than left as unreachable room. */
    cellsFilled: number;
    /** Points the TORCH phase lit. */
    torchesPlaced: number;
  };
}

const overlaps = (a: Region, b: Region): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A structure as a positional stamp, with two edits to what the author painted — and only two.
 *
 * PERIMETER: a pinned wall is widened to {none, wall}. The author said "there is a wall here"; porous
 * says "…and the generator may cut a door through it". SEAL closes these again, and the ones that
 * refuse to close are the doors.
 *
 * INTERIOR: a wall the author never spoke about is pinned to `none` — THE ROOM STATES THAT ITS INSIDE
 * IS AIR. Leaving it abstaining reads to the maze as "help yourself", and the maze duly carves
 * corridors through the middle of the room. Saying it makes the trespass structurally impossible: a
 * wall proposed in there meets {none} ∩ {wall} = ∅, the transaction conflicts, and the AND-gate
 * rejects it with no policing code involved. Anything the author DID paint is left exactly as painted.
 */
function structureStamp(
  name: string, porousPerimeter: boolean, o: Orientation, level = 0, src: StructureSource = AUTHORED,
): {
  stamp: (lx: number, ly: number) => CellField;
  /** Which slots this stamp actually LOOSENED — the ones SEAL is entitled to close again. */
  opened: (lx: number, ly: number) => { n: boolean; w: boolean };
  w: number; h: number; levels: number;
} | null {
  const base = src.get(name);
  if (!base) return null;
  const st = orientStructure(base, o); // 4 turns x mirrored = 8 placements per authored piece
  const nLevels = levelsOf(st);
  if (level >= nLevels) return null;

  /* WALLS THAT HOLD UP A STAIRCASE ARE NOT NEGOTIABLE.
     The porous rule below exists so the generator can cut a doorway into a room, and for a room that
     is right: the author said "wall", and a door through it costs nothing. A stairwell is different.
     Which way a flight climbs is DERIVED from exactly one end being walled, so a door cut through the
     head does not merely open a room — it stops the staircase being a staircase, and the cells settle
     back to ordinary ground.
     It is not hypothetical: the router treats every structure's middle as a target, walked in through
     the head wall of a 2x2 stairwell, pinned it open, and the flight vanished. So a wall bounding a
     stair cell stays exactly as the author drew it. */
  const preview = st.cells.slice(level * (st.w + 1) * (st.h + 1), (level + 1) * (st.w + 1) * (st.h + 1))
    .map((f) => previewCell(f));
  const lw = st.w + 1, lh = st.h + 1;
  const isStair = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < lw && y < lh && isStairFloor(preview[y * lw + x]?.floor ?? 'none');
  // wallN at (x,y) separates (x,y-1) from (x,y); wallW separates (x-1,y) from (x,y)
  const holdsStairN = (x: number, y: number): boolean => isStair(x, y) || isStair(x, y - 1);
  const holdsStairW = (x: number, y: number): boolean => isStair(x, y) || isStair(x - 1, y);
  const loosen = (m: Mask): Mask => (m === WALL && porousPerimeter ? POROUS : m);
  // "still allows `none`" is the robust test for "the author did not put a wall here". Comparing
  // against `fullField()` does NOT work: a migrated structure's domains were converted from the old
  // four-value model, so an unpainted wall carries {none,wall,barrier} and never the new full set.
  const assertAir = (m: Mask): Mask => ((m & NONE) !== 0 ? NONE : m);
  const sw = st.w + 1; // the stored grid is the POINT lattice, one larger than the floor extent
  const lvBase = level * (st.w + 1) * (st.h + 1); // levels are stored one lattice after another
  const onEdgeAt = (lx: number, ly: number): boolean =>
    lx === 0 || ly === 0 || lx === st.w || ly === st.h;
  return {
    w: sw,
    h: st.h + 1,
    levels: nLevels,
    /* A slot is porous only where the author DREW A WALL and `loosen` widened it. Anywhere else on the
       perimeter the author either drew something specific (which stands) or said nothing at all (which
       must stay nothing) — and treating "said nothing" as porous is how SEAL ended up stamping walls
       around every structure that the author never drew. */
    opened: (lx, ly) => {
      const f = st.cells[lvBase + ly * sw + lx];
      if (!f || !onEdgeAt(lx, ly) || !porousPerimeter) return { n: false, w: false };
      return { n: f.wallN === WALL, w: f.wallW === WALL };
    },
    stamp: (lx, ly) => {
      const f = st.cells[lvBase + ly * sw + lx]!;
      const onEdge = lx === 0 || ly === 0 || lx === st.w || ly === st.h;
      return onEdge
        ? {
          ...f,
          wallN: holdsStairN(lx, ly) ? f.wallN : loosen(f.wallN),
          wallW: holdsStairW(lx, ly) ? f.wallW : loosen(f.wallW),
        }
        : { ...f, wallN: assertAir(f.wallN), wallW: assertAir(f.wallW) };
    },
  };
}

/** Everything one storey needs handed to it, so the phases below can run per level. */
interface Storey {
  grid: CellGrid;
  placed: PlacedStructure[];
  porousWalls: { x: number; y: number; side: 'N' | 'W' }[];
}

/**
 * Place the authored structures across a STACK of storeys.
 *
 * A multi-storey structure lands whole or not at all, ACROSS levels: its transactions on every storey
 * it touches are staged, checked together, and committed together. Committing them one at a time would
 * leave a stairwell with its shaft on the floor above and nothing under it when the lower half was
 * refused — which is exactly the kind of half-placed thing the transactional grid exists to prevent,
 * just one dimension up.
 */
function placeStructures(
  storeys: Storey[], w: number, h: number, sRng: Rng, copies: number,
  stats: EmergentResult['stats'], src: StructureSource = AUTHORED,
): void {
  const names = src.names(); // sorted, so iteration is deterministic

  /* LARGEST FIRST. Bin-packing's oldest heuristic, and it matters here for the reason it always does:
     a big piece placed late has nowhere left to go, so the floor ends up with small rooms scattered in
     a sea of corridor. Sorting by area descending (ties broken by name, so it stays deterministic)
     lets the big structures claim their space while the floor is still empty.

     Positions run the FULL extent, right up to the border. Insetting by one kept the largest pieces
     away from exactly the edges they fit best against, and left a rim of corridor all the way round. */
  const byArea = names
    .map((n) => ({ n, st: src.get(n)! }))
    .filter((e) => e.st)
    .sort((a, b) => (b.st.w * b.st.h) - (a.st.w * a.st.h) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));

  const POSITION_TRIES = 24;

  /** Storeys that have a stairwell STARTING on them — the half with the stairs, not the shaft. */
  const wellStartsAt = new Array<boolean>(storeys.length).fill(false);

  /** One attempt: pick an orientation and a spot, stage every storey, commit or roll the lot back.
   *  Returns the base storey it landed on, or null. */
  const tryPlace = (name: string, nLevels: number, baseLevel: number | null): number | null => {
    const o = ORIENTATIONS[nextInt(sRng, ORIENTATIONS.length)]!;
    const s = structureStamp(name, true, o, 0, src);
    if (!s || s.w > w || s.h > h) return null;
    const region: Region = {
      x: nextInt(sRng, w - s.w + 1),
      y: nextInt(sRng, h - s.h + 1),
      w: s.w, h: s.h,
    };
    // a multi-storey piece needs `nLevels` consecutive storeys with room for it at that spot
    const b = baseLevel ?? nextInt(sRng, storeys.length - nLevels + 1);
    if (b < 0 || b + nLevels > storeys.length) return null;
    const span = Array.from({ length: nLevels }, (_, k) => b + k);
    if (span.some((lv) => storeys[lv]!.placed.some((q) => overlaps(q.region, region)))) {
      stats.structuresRejectedOverlap++; return null;
    }

    // stage EVERY storey, then decide once — see the note on this function
    const txs = span.map((lv, k) => {
      const sk = structureStamp(name, true, o, k, src)!;
      const tx = begin(storeys[lv]!.grid);
      stamp(tx, region, (lx, ly) => sk.stamp(lx, ly));
      return tx;
    });
    if (txs.some((tx) => txConflicts(tx).length > 0)) {
      for (const tx of txs) rollback(tx);
      stats.structuresRejectedConflict++; return null;
    }
    for (const tx of txs) commit(tx);

    for (const lv of span) {
      storeys[lv]!.placed.push({
        name, orientation: o, region,
        centre: nodeId(w, region.x + (region.w >> 1), region.y + (region.h >> 1)),
      });
      /* ONLY THE SLOTS THIS STRUCTURE ACTUALLY OPENED. Pushing the whole perimeter ring here — both
         sides of every edge cell, drawn or not — let SEAL stamp a wall wherever the author had merely
         abstained, and those invented segments are the nubs sprouting off every structure. SEAL exists
         to close what porosity opened, not to add walls of its own. */
      const sk = structureStamp(name, true, o, lv - b, src)!;
      for (let ly = 0; ly < region.h; ly++) {
        for (let lx = 0; lx < region.w; lx++) {
          const op = sk.opened(lx, ly);
          if (op.n) storeys[lv]!.porousWalls.push({ x: region.x + lx, y: region.y + ly, side: 'N' });
          if (op.w) storeys[lv]!.porousWalls.push({ x: region.x + lx, y: region.y + ly, side: 'W' });
        }
      }
    }
    stats.structuresPlaced++;
    return b;
  };

  /* ---- A WAY UP FROM EVERY STOREY, placed FIRST ----------------------------------------------
     A stairwell is not decoration, so it does not compete for space on equal terms with the rooms.
     Left to the opportunistic pass below, whether a floor got one came down to where the dice fell:
     five storeys, and storey 2 would have no stair on it at all, which is a tower you cannot climb.
     So every storey below the top gets one FIRST, while the floor is empty and a spot is easy to find.

     A stairwell is recognised, not declared: a structure that spans storeys AND has stair ground on
     it. Nothing has to be tagged, and an author who draws a two-storey staircase gets one. */
  const wells = byArea.filter((e) => levelsOf(e.st) > 1 && hasStairGround(e.st));
  if (wells.length > 0) {
    for (let lv = 0; lv + 1 < storeys.length; lv++) {
      /* It must START here. A stairwell seated on the storey BELOW also occupies this one — with its
         SHAFT, the hole you arrive through — and counting that as "this storey has a stairwell" left
         every other floor with no way up while looking, from the outside, like it had one. */
      if (wellStartsAt[lv]) continue;
      for (let t = 0; t < POSITION_TRIES * 4 && !wellStartsAt[lv]; t++) {
        const pick = wells[nextInt(sRng, wells.length)]!;
        const n = levelsOf(pick.st);
        if (lv + n > storeys.length) continue; // will not fit above this storey
        if (tryPlace(pick.n, n, lv) === lv) wellStartsAt[lv] = true;
      }
      if (!wellStartsAt[lv]) stats.storeysWithoutStairwell++;
    }
  } else if (storeys.length > 1) {
    // no authored stairwell exists at all — every storey is unreachable from the one below, and that
    // is a fact about the STORE, not about this run
    stats.storeysWithoutStairwell += storeys.length - 1;
  }

  /* ---- and then the rooms, opportunistically ---- */
  for (const { n: name, st } of byArea) {
    const nLevels = levelsOf(st);
    if (nLevels > storeys.length) { stats.structuresSkippedMultiLevel++; continue; } // taller than the tower
    for (let copy = 0; copy < copies; copy++) {
      for (let t = 0; t < POSITION_TRIES; t++) {
        const at = tryPlace(name, nLevels, null);
        if (at !== null) {
          if (nLevels > 1 && hasStairGround(st)) wellStartsAt[at] = true;
          break;
        }
      }
    }
  }
}

/** Does any storey of this structure pin STAIR ground? That is what makes it a stairwell rather than
 *  a two-storey room — read off the art, so nothing has to be tagged. */
function hasStairGround(st: CellStructure): boolean {
  return st.cells.some((f) => isStairFloor(previewCell(f)?.floor ?? 'none'));
}

/** Substream for one storey. Without the level in the mix every floor gets an identical maze. */
const levelStream = (base: Rng, id: number, level: number): Rng => subStream(base, id + level * 16);

export function generateEmergent(cfg: EmergentConfig): EmergentResult {
  const t = generateEmergentTower({ ...cfg, levels: 1 });
  return { ...t.floors[0]!, stats: t.stats };
}

/** One storey of a tower, shaped exactly like a single-floor result minus the shared stats. */
export type EmergentFloor = Omit<EmergentResult, 'stats'>;

export interface EmergentTower {
  floors: EmergentFloor[];
  stats: EmergentResult['stats'];
}

/**
 * Generate a STACK of floors, so a structure can span storeys.
 *
 * The structures are placed across the whole stack FIRST — that is the only phase that knows about
 * more than one floor — and then every storey is finished on its own: its own routes, its own seal,
 * its own maze, its own fill. Each floor's solvability is therefore exactly the property it always
 * was, proven per floor, and the only thing levels add is that some ground was already claimed.
 */
export function generateEmergentTower(cfg: EmergentConfig & { levels?: number }): EmergentTower {
  const { width: w, height: h, seed } = cfg;
  const levels = Math.max(1, cfg.levels ?? 1);
  const base = makeRng(seed);
  const stats: EmergentResult['stats'] = {
    structuresPlaced: 0, structuresSkippedMultiLevel: 0, storeysWithoutStairwell: 0, torchesPlaced: 0,
    structuresRejectedConflict: 0, structuresRejectedOverlap: 0,
    wallsPlaced: 0, wallsRejectedConflict: 0, wallsRejectedUnreachable: 0,
    ringSealed: 0, doorsKept: 0, mazeNote: '', reachableCells: 0, cellsFilled: 0,
  };

  /* ---- 1. STRUCTURES — the only rooms there are, and the only phase that spans storeys ---- */
  const storeys: Storey[] = Array.from({ length: levels }, () => ({
    grid: makeGrid(w, h), placed: [], porousWalls: [],
  }));
  const copies = cfg.structureAttempts ?? Math.max(2, Math.floor((w * h) / 400));
  placeStructures(storeys, w, h, subStream(base, STREAM.structures), copies, stats, cfg.structures ?? AUTHORED);

  const floors: EmergentFloor[] = [];
  for (let lv = 0; lv < levels; lv++) {
    floors.push(finishStorey(storeys[lv]!, w, h, base, lv, cfg, stats));
  }
  return { floors, stats };
}

function finishStorey(
  st: Storey, w: number, h: number, base: Rng, level: number,
  cfg: EmergentConfig, stats: EmergentResult['stats'],
): EmergentFloor {
  const { grid, placed, porousWalls } = st;

  /* Phase 1 (STRUCTURES) already ran, across the whole stack — it is the only phase that knows about
     more than one storey. Everything from here is this floor on its own. */

  /* ---- 2. ROUTE + PIN. The route is DISCOVERED in the field, not imposed on a map. ---- */
  const entry = nodeId(w, 1, 1);
  const exit = nodeId(w, w - 2, h - 2);
  const targets = [exit, ...placed.map((p) => p.centre)];
  const routes: StepEdge[][] = [];
  for (const t of targets) {
    const route = findRoute(gridAt(grid), w, h, 'may', entry, t);
    if (!route) continue; // a structure sealed by its own authoring; the seal phase will not open it
    const tx = begin(grid);
    pinRouteOpen(tx, route);
    if (commit(tx)) routes.push(route);
  }

  const guarded = (at: ReturnType<typeof gridAt>): boolean => routes.every((r) => routeGuaranteed(at, r));

  /* ---- 3. SEAL. Close every porous perimeter wall that CAN close. The refusals are the doors —
     discovered by what connectivity needs, never placed by a rule. ---- */
  {
    for (const pw of porousWalls) {
      const tx = begin(grid);
      stamp(tx, { x: pw.x, y: pw.y, w: 1, h: 1 }, template(pw.side === 'N' ? { wallN: WALL } : { wallW: WALL }));
      const at = txAt(tx);
      // the wall separates this cell from the neighbour beyond it; if they still reach each other,
      // no component split, so nothing became unreachable
      const other = pw.side === 'N' ? nodeId(w, pw.x, pw.y - 1) : nodeId(w, pw.x - 1, pw.y);
      const here = nodeId(w, pw.x, pw.y);
      if (!at(pw.x, pw.y) || !guarded(at) || !stillConnected(at, w, h, 'may', here, other)) {
        rollback(tx); stats.doorsKept++; continue;
      }
      if (commit(tx)) stats.ringSealed++; else stats.doorsKept++;
    }
  }

  /* ---- 4. MAZE. Every proposal must keep EVERY cell reachable — not just the targets. That is the
     difference between a maze and a field of sealed pockets. ---- */
  const maze: MazeParams = cfg.maze ?? { kind: 'backtracker', braid: 0.3 };
  const mRng: Rng = levelStream(base, STREAM.maze, level);
  {
    // `scatter` keeps the OLD, WEAK gate on purpose: targets only, nobody asks about the rest of the
    // floor. It is retained as the control that shows what the full-connectivity gate is worth.
    const targetsOnly = maze.kind === 'scatter';
    const budget = reachSet(gridAt(grid), w, h, 'may', entry);
    const plan = planMaze(grid, mRng, maze, entry);
    stats.mazeNote = plan.note;
    for (const e of plan.order) {
      const tx = begin(grid);
      // a barrier is `step` walls wide and lands whole or not at all, so a corridor never ends up
      // half-blocked
      for (const pin of e.pins) {
        stamp(tx, { x: pin.x, y: pin.y, w: 1, h: 1 },
          template(pin.side === 'N' ? { wallN: WALL } : { wallW: WALL }));
      }
      const at = txAt(tx);
      if (e.pins.some((pin) => !at(pin.x, pin.y))) { rollback(tx); stats.wallsRejectedConflict++; continue; }
      const stillOk = targetsOnly
        ? guarded(at) && targets.every((t) => reachSet(at, w, h, 'may', entry)[t] === true)
        // every wall of the barrier must leave its own two cells connected — equivalent to "no cell
        // was lost", and it exits as soon as it finds a way round
        : guarded(at) && e.pins.every((pin) => stillConnected(
          at, w, h, 'may',
          nodeId(w, pin.x, pin.y),
          pin.side === 'N' ? nodeId(w, pin.x, pin.y - 1) : nodeId(w, pin.x - 1, pin.y),
        ));
      if (!stillOk) { rollback(tx); stats.wallsRejectedUnreachable++; continue; }
      if (commit(tx)) stats.wallsPlaced += e.pins.length; else stats.wallsRejectedConflict++;
    }
  }

  /* ---- 5. FILL. Whatever the maze sealed off is not a room nobody can enter — it is ROCK. Marking
     it that way is what makes a floor read as carved OUT of solid stone rather than as an open field
     someone put walls on, and it is the never-empty fallback for space no structure claimed.

     Safe by construction: a rock cell contributes NO edges, so filling a cell that was already
     unreachable cannot disconnect anything that was reachable. Cells whose floor has been pinned by a
     structure are left alone — an author's ground is not ours to overwrite. ---- */
  {
    const before = reachSet(gridAt(grid), w, h, 'may', entry);
    const tx = begin(grid);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (before[y * w + x]) continue;                       // reachable — leave it
        if ((grid.cells[y * w + x]!.floor & ROCK) === 0) continue; // an author pinned this ground
        stamp(tx, { x, y, w: 1, h: 1 }, template({ floor: ROCK }));
        stats.cellsFilled++;
      }
    }
    if (!commit(tx)) throw new Error('emergent: fill emptied a domain — impossible, rock was checked to be available');
  }

  /* ---- 6. TORCHES. Light, placed as a phase rather than sprinkled by the renderer.
     ---------------------------------------------------------------------------------------------
     The renderer used to scatter these with a per-cell hash, which is why a 2u floor came up with
     four times as many as the 4u grid it was tuned for: the density was written in CELLS, and cells
     got smaller. Placing them here fixes that, and buys two things the renderer could not do.

     IT PICKS PLACES, NOT CELLS. A torch has to hang on something and light somewhere a body can
     stand, and `torchFacings` already answers that from the walls. Only points that pass are
     considered, so a torch never ends up inside a wall or facing solid rock.

     COLUMNS ALWAYS GET ONE, and get one on EVERY open side — up to four. A free-standing pillar is a
     landmark, and lighting all of its faces is what makes it read as one.

     SPACING IS ENFORCED, NOT HOPED FOR. A hash alone clumps: it will happily light four points in a
     row and leave the next corridor black. So a candidate is rejected if another torch is already
     within TORCH_SPACING, which turns "one in eleven cells" into "about one every eleven cells".

     AN AUTHOR ALWAYS WINS. A structure that pinned `torch` — either way — has already decided, and
     is skipped: this only fills in points that ABSTAIN. ---- */
  {
    const tRng: Rng = subStream(base, STREAM.torches);
    const cells = resolveGrid(grid);
    const placed: { x: number; y: number }[] = [];
    const farEnough = (x: number, y: number): boolean =>
      placed.every((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) >= TORCH_SPACING);

    const tx = begin(grid);
    // fixed index order, so which points get torches is a property of the seed and not of the loop
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = grid.cells[y * w + x]!;
        if (domainSize(f.torch) < 2) continue;              // the author already decided
        if (!torchFacings(cells, w, h, x, y).length) continue;

        const onColumn = cells[y * w + x]?.corner !== 'none';
        if (!onColumn && (nextInt(tRng, TORCH_EVERY) !== 0 || !farEnough(x, y))) continue;
        if (onColumn && !farEnough(x, y)) continue;

        stamp(tx, { x, y, w: 1, h: 1 }, template({ torch: TORCH_YES }));
        placed.push({ x, y });
      }
    }
    if (commit(tx)) stats.torchesPlaced = placed.length;
    else rollback(tx);
  }

  /* ---- 7. SETTLE the WHOLE cell. Anything still wide gets decided by the collapse pick otherwise,
     which shows up as speckled floors and walls nobody asked for. Defaults: walls open, ground stone,
     junction solid, no opening. Opening can only ADD reachability, so this needs no gate.

     ALWAYS DECIDES. Narrowing to the preferred default only works when the default is still on the
     table — an authored structure can exclude it (one here pins wallType to {hole, arch, low_gate}),
     which used to leave three options for the pick to resolve at random. So: take the default if it
     survives, otherwise the canonical LOWEST surviving option. Every field ends a singleton. ---- */
  {
    const tx = begin(grid);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = grid.cells[y * w + x]!;
        stamp(tx, { x, y, w: 1, h: 1 }, template({
          wallN: settleMask(f.wallN, 'wallN'),
          wallW: settleMask(f.wallW, 'wallW'),
          floor: settleMask(f.floor, 'floor'),
          corner: settleMask(f.corner, 'corner'),
          wallType: settleMask(f.wallType, 'wallType'),
          torch: settleMask(f.torch, 'torch'),
        }));
      }
    }
    if (!commit(tx)) throw new Error('emergent: settle emptied a domain — impossible, every narrowing is a subset of the surviving options');
  }

  stats.reachableCells += reachSet(gridAt(grid), w, h, 'may', entry).filter(Boolean).length;
  return { grid, placed, entry, exit, routes };
}

/** Collapse the finished field. Fully settled, so the pick has nothing left to decide — but it is
 *  threaded anyway so a future partial settle stays deterministic. */
export function resolveEmergent(r: EmergentResult, seed: bigint): (Cell | null)[] {
  return resolveGrid(r.grid, (x, y) => {
    const hash = mixSeeds(seed, BigInt((y * r.grid.w + x) * 2 + 1));
    return (_field, options) => Number(((hash % BigInt(options.length)) + BigInt(options.length)) % BigInt(options.length));
  });
}
