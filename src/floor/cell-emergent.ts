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

import { makeGrid, begin, stamp, commit, rollback, resolveGrid, type CellGrid, type Region } from './cell-grid.ts';
import { template, settleMask, segs, floors, corners, wallTypes, type Mask, type CellField } from './cell-field.ts';
import { nodeId } from './cell-graph.ts';
import {
  gridAt, txAt, findRoute, pinRouteOpen, routeGuaranteed, reachSet, keepsReach, stillConnected,
  type StepEdge,
} from './cell-reach.ts';
import { planMaze, type MazeParams } from './cell-maze.ts';
import { getStructure, listStructures } from './cell-structures.ts';
import { orientStructure, ORIENTATIONS, type Orientation } from './cell-orient.ts';
import { makeRng, subStream, nextInt, mixSeeds, type Rng } from './rng.ts';
import type { Cell } from './cell.ts';

const WALL: Mask = segs('wall');
const NONE: Mask = segs('none');
const POROUS: Mask = segs('none', 'wall');
const STONE: Mask = floors('stone');
const SOLID_CORNER: Mask = corners('solid');
const SOLID_TYPE: Mask = wallTypes('solid');
const ROCK: Mask = floors('rock');

/** Sub-stream tags — stable, so adding a phase never shifts an earlier one's output. */
const STREAM = { structures: 1, maze: 2, pick: 3 } as const;

export interface EmergentConfig {
  width: number;
  height: number;
  seed: bigint;
  /** How many COPIES of each structure to try placing. Default scales with the map. */
  structureAttempts?: number;
  /** Which carver shapes the space between structures. */
  maze?: MazeParams;
}

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
function structureStamp(name: string, porousPerimeter: boolean, o: Orientation): { stamp: (lx: number, ly: number) => CellField; w: number; h: number } | null {
  const base = getStructure(name);
  if (!base) return null;
  const st = orientStructure(base, o); // 4 turns x mirrored = 8 placements per authored piece
  const loosen = (m: Mask): Mask => (m === WALL && porousPerimeter ? POROUS : m);
  // "still allows `none`" is the robust test for "the author did not put a wall here". Comparing
  // against `fullField()` does NOT work: a migrated structure's domains were converted from the old
  // four-value model, so an unpainted wall carries {none,wall,barrier} and never the new full set.
  const assertAir = (m: Mask): Mask => ((m & NONE) !== 0 ? NONE : m);
  const sw = st.w + 1; // the stored grid is the POINT lattice, one larger than the floor extent
  return {
    w: sw,
    h: st.h + 1,
    stamp: (lx, ly) => {
      const f = st.cells[ly * sw + lx]!;
      const onEdge = lx === 0 || ly === 0 || lx === st.w || ly === st.h;
      return onEdge
        ? { ...f, wallN: loosen(f.wallN), wallW: loosen(f.wallW) }
        : { ...f, wallN: assertAir(f.wallN), wallW: assertAir(f.wallW) };
    },
  };
}

export function generateEmergent(cfg: EmergentConfig): EmergentResult {
  const { width: w, height: h, seed } = cfg;
  const grid = makeGrid(w, h);
  const base = makeRng(seed);
  const stats: EmergentResult['stats'] = {
    structuresPlaced: 0, structuresRejectedConflict: 0, structuresRejectedOverlap: 0,
    wallsPlaced: 0, wallsRejectedConflict: 0, wallsRejectedUnreachable: 0,
    ringSealed: 0, doorsKept: 0, mazeNote: '', reachableCells: 0, cellsFilled: 0,
  };

  /* ---- 1. STRUCTURES — the only rooms there are ---- */
  const names = listStructures(); // sorted, so iteration is deterministic
  const sRng: Rng = subStream(base, STREAM.structures);
  const placed: PlacedStructure[] = [];
  const porousWalls: { x: number; y: number; side: 'N' | 'W' }[] = [];
  const copies = cfg.structureAttempts ?? Math.max(2, Math.floor((w * h) / 400));

  /* LARGEST FIRST. Bin-packing's oldest heuristic, and it matters here for the reason it always does:
     a big piece placed late has nowhere left to go, so the floor ends up with small rooms scattered in
     a sea of corridor. Sorting by area descending (ties broken by name, so it stays deterministic)
     lets the big structures claim their space while the floor is still empty.

     Positions run the FULL extent, right up to the border. Insetting by one kept the largest pieces
     away from exactly the edges they fit best against, and left a rim of corridor all the way round. */
  const byArea = names
    .map((n) => ({ n, st: getStructure(n)! }))
    .filter((e) => e.st)
    .sort((a, b) => (b.st.w * b.st.h) - (a.st.w * a.st.h) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));

  const POSITION_TRIES = 24;
  for (const { n: name } of byArea) {
    for (let copy = 0; copy < copies; copy++) {
      for (let t = 0; t < POSITION_TRIES; t++) {
        const o = ORIENTATIONS[nextInt(sRng, ORIENTATIONS.length)]!;
        const s = structureStamp(name, true, o);
        if (!s || s.w > w || s.h > h) break;
        const region: Region = {
          x: nextInt(sRng, w - s.w + 1),
          y: nextInt(sRng, h - s.h + 1),
          w: s.w, h: s.h,
        };
        if (placed.some((q) => overlaps(q.region, region))) { stats.structuresRejectedOverlap++; continue; }

        const tx = begin(grid);
        stamp(tx, region, (lx, ly) => s.stamp(lx, ly));
        if (!commit(tx)) { stats.structuresRejectedConflict++; continue; }

        placed.push({
          name, orientation: o, region,
          centre: nodeId(w, region.x + (region.w >> 1), region.y + (region.h >> 1)),
        });
        stats.structuresPlaced++;
        for (let ly = 0; ly < region.h; ly++) {
          for (let lx = 0; lx < region.w; lx++) {
            if (!(lx === 0 || ly === 0 || lx === region.w - 1 || ly === region.h - 1)) continue;
            porousWalls.push({ x: region.x + lx, y: region.y + ly, side: 'N' });
            porousWalls.push({ x: region.x + lx, y: region.y + ly, side: 'W' });
          }
        }
        break; // placed this copy
      }
    }
  }

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
  const mRng: Rng = subStream(base, STREAM.maze);
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

  /* ---- 6. SETTLE the WHOLE cell. Anything still wide gets decided by the collapse pick otherwise,
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
        }));
      }
    }
    if (!commit(tx)) throw new Error('emergent: settle emptied a domain — impossible, every narrowing is a subset of the surviving options');
  }

  stats.reachableCells = reachSet(gridAt(grid), w, h, 'may', entry).filter(Boolean).length;
  return { grid, placed, entry, exit, routes, stats };
}

/** Collapse the finished field. Fully settled, so the pick has nothing left to decide — but it is
 *  threaded anyway so a future partial settle stays deterministic. */
export function resolveEmergent(r: EmergentResult, seed: bigint): (Cell | null)[] {
  return resolveGrid(r.grid, (x, y) => {
    const hash = mixSeeds(seed, BigInt((y * r.grid.w + x) * 2 + 1));
    return (_field, options) => Number(((hash % BigInt(options.length)) + BigInt(options.length)) % BigInt(options.length));
  });
}
