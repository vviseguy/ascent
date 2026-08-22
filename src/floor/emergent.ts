// ============================================================================
// src/floor/emergent.ts — the ALL-EMERGENT floor generator (docs/16 §4/§5, built).
// ============================================================================
//
// Nothing is drawn on a coarse map first. The floor starts as a field where EVERYTHING is possible
// and the layout is whatever survives a sequence of narrowings, each one gated on "can you still get
// from the entrance to the exit?".
//
//   makeGrid()                every cell = fullField() — the blank field is MAXIMALLY connected
//   ├─ propose a ROOM         stage a role template over a rectangle
//   ├─ propose a WALL RUN     stage a straight line of full-height wall arms
//   │    each proposal: stage → does any domain empty? → is the exit still ACHIEVABLE (`may`)?
//   │                   both ok ⇒ commit, else ⇒ ROLLBACK and the field is byte-identical
//   └─ PIN the route          find the surviving entry→exit route and narrow its arms so `wall`
//                             cannot survive on them → the route becomes GUARANTEED (`must`)
//
// THE GENERATOR POLICES NOTHING. A room states that its inside is AIR (`room-templates.ts` pins the
// interior arms to `none`), so a wall run proposed inside one meets `{none} ∩ {wall} = ∅`, the
// transaction conflicts, and it rolls back. Room-on-room overlap fails the same way. There is no
// ownership table and no trespass check — saying the true thing in the template makes the AND-gate
// the enforcement, which is the whole point of modelling rooms as constraints.
//
// WHY THIS CANNOT PRODUCE AN IMPOSSIBLE FLOOR. `andGate` only ever removes options, so reachability
// is MONOTONE — it can decrease but never increase. The blank field is fully connected, and every
// commit is gated on the exit still being achievable. By induction the exit is achievable at every
// moment of the run; the final pin converts that into a guarantee that survives collapse. There is
// no reserved corridor and no backtracking search — the invariant does the work a scaffold used to.
//
// The maze is not carved by a maze algorithm. It is the residue of "add walls anywhere they don't
// disconnect the floor" — which is the dual of a recursive-backtracker, and it is why hallways,
// loops and dead ends come out of the constraint field rather than being planned into it.
//
// Deterministic (sim): seeded sub-streams per phase (adding a phase never shifts an earlier one's
// output), a coordinate-hash pick at collapse, dense-array iteration, no float / no Math.random.

import { makeRng, mixSeeds, nextInt, nextRange, subStream, type Rng } from './rng.ts';
import { makeGrid, begin, stamp, commit, rollback, resolveGrid, type TileGrid, type Region, type Stamp, type Tx } from './tile-grid.ts';
import { template, segs, centres, floors, wallTypes, type Mask } from './wall-tile-field.ts';
import { DIRS, FLOOR_CORNERS, type Dir, type FloorCorner, type WallTile } from './wall-tile.ts';
import { listStructures, getStructure, type SavedStructure } from './structures.ts';
import { crossSeam, stampSeam, cohere, allPointSeams, allCrossSeams } from './seams.ts';
import { cornerId } from './corner-graph.ts';
import {
  type ArmEdge,
  type FieldAt,
  armMasks,
  findRoute,
  gridAt,
  pinRouteOpen,
  reachesAll,
  routeGuaranteed,
  txAt,
} from './tile-reach.ts';

/** Sub-stream tags — stable; adding a phase must take a NEW tag, never reuse or reorder. */
const STREAM = { rooms: 1, walls: 2, collapse: 3 } as const;

const WALL: Mask = segs('wall');
const NONE: Mask = segs('none');
/** Settle defaults for the parts of a tile that are NOT the wall arms. */
const NONE_CENTRE: Mask = centres('none');
const STONE: Mask = floors('stone');
const SOLID: Mask = wallTypes('solid');
/** Exactly what a POROUS ring arm says: "wall, or nothing". Distinguishing this from a FULL domain is
 *  what stops the seal phase from filling in cells no template ever spoke about — an unconstrained
 *  cell also contains both `wall` and non-`wall`, but no template ever spoke about it. */
const POROUS: Mask = segs('none', 'wall');

export interface EmergentConfig {
  width: number;
  height: number;
  /** Run seed; combined with `stratumIndex` so each floor of a tower differs. */
  seed: bigint;
  stratumIndex?: number;
  /** Entry / exit CORNER coordinates on the (width+1)×(height+1) corner lattice. */
  entry?: { cx: number; cy: number };
  exit?: { cx: number; cy: number };
  /** How many room placements to attempt (each may be rejected). */
  roomAttempts?: number;
  /** How many wall-run placements to attempt (each may be rejected). */
  wallAttempts?: number;
  /** Longest wall run a single proposal may stage. */
  maxRunLength?: number;
  /** Room size bounds, in tiles (inclusive). */
  roomMin?: number;
  roomMax?: number;
}

/** Every arm a wall run would touch, as tile+dir pairs. */
function runArms(g: TileGrid, x: number, y: number, d: Dir, len: number): { x: number; y: number; d: Dir }[] {
  const [sx, sy] = d === 'N' || d === 'S' ? [1, 0] : [0, 1];
  const out: { x: number; y: number; d: Dir }[] = [];
  for (let i = 0; i < len; i++) {
    const px = x + sx * i;
    const py = y + sy * i;
    if (px < 0 || py < 0 || px >= g.w || py >= g.h) break;
    out.push({ x: px, y: py, d });
  }
  return out;
}

export interface PlacedRoom extends Region {
  /** Which authored structure was stamped here (a key of `structures.json`). */
  structure: string;
}

export interface EmergentResult {
  grid: TileGrid;
  /** Every arm pinned open — the entry→exit route plus one route into each room. Guaranteed open
   *  whatever else collapses; this is the set the end-gate re-checks. */
  route: ArmEdge[];
  rooms: PlacedRoom[];
  entryCorner: number;
  exitCorner: number;
  /** Corners connectivity is guaranteed to: the exit, and one interior corner of each room. */
  targets: number[];
  stats: {
    roomsPlaced: number;
    roomsRejectedConflict: number;
    roomsRejectedUnreachable: number;
    /** Refused because the authored structure does not fit inside the floor at all. */
    roomsRejectedTooBig: number;
    wallsPlaced: number;
    wallsRejectedConflict: number;
    wallsRejectedUnreachable: number;
    /** Ring cells narrowed from `{none, wall}` to a finished wall. */
    ringSealed: number;
    /** Ring cells left open because sealing them would have closed a guaranteed route — the doors. */
    doorsKept: number;
    /** Split-across-tiles features pulled into agreement (cross seams + point seams). */
    seamsCohered: number;
  };
}

/* ------------------------------- proposals ------------------------------- */

/**
 * Stage a full-height wall across ONE TILE BOUNDARY — the whole CROSS seam (seams.ts), not one tile's
 * arm. Setting only the near tile's arm leaves its partner to settle to nothing, so the wall runs from
 * A's centre to the boundary and stops with an end-cap: the stub. Setting all three cells makes it a
 * continuous centre-to-centre run, which is what a wall is supposed to look like.
 *
 * `d` is taken from tile (x,y); the seam itself is stored east/south of a tile, so a N or W direction
 * addresses the seam belonging to the neighbour on that side.
 */
function stampWallArm(tx: Tx, g: TileGrid, x: number, y: number, d: Dir): void {
  const seam =
    d === 'E' ? crossSeam(g, x, y, 'E')
    : d === 'S' ? crossSeam(g, x, y, 'S')
    : d === 'W' ? crossSeam(g, x - 1, y, 'E')
    : crossSeam(g, x, y - 1, 'S');
  if (seam) { stampSeam(tx, seam, WALL); return; }
  // no second tile — the map border. The outer edge is already the perimeter shell, so only this
  // tile's own inner half exists to be set.
  const inner: Partial<Record<Dir, Mask>> = {};
  inner[d] = WALL;
  stamp(tx, { x, y, w: 1, h: 1 }, template({ inner }));
}

/** A straight run of `len` arms from (x,y) in direction `d`: the arms sit on successive tiles ALONG
 *  the wall's own line (a W arm is vertical, so the run steps south; an N arm is horizontal, so it
 *  steps east). Out-of-grid steps are simply skipped — a short run is still a legal proposal. */
function stampWallRun(tx: Tx, g: TileGrid, x: number, y: number, d: Dir, len: number): void {
  for (const a of runArms(g, x, y, d, len)) stampWallArm(tx, g, a.x, a.y, a.d);
}

/**
 * Stamp an AUTHORED structure with a POROUS OUTER BOUNDARY.
 *
 * The structure is used exactly as painted, with ONE relaxation: on its outer ring, any arm the author
 * pinned to `wall` is widened to `{none, wall}`. That is the difference between a room that can grow a
 * door and one that is sealed forever — domains only ever narrow, so a boundary pinned hard to `wall`
 * can never reopen, and the connect phase would have no way in. Widening it defers the choice; the
 * connect phase pins the cells a route needs to `none` (those become the doors) and the seal phase
 * puts the rest back to `wall`.
 *
 * The INTERIOR is untouched — pillars, alcoves, partitions, floor materials all stamp exactly as
 * authored. Only where the room meets the outside is left undecided.
 */
function porousBoundary(st: SavedStructure): Stamp {
  return (lx, ly) => {
    const f = st.cells[ly * st.w + lx]!;
    if (lx !== 0 && ly !== 0 && lx !== st.w - 1 && ly !== st.h - 1) return f; // interior: verbatim
    const loosen = (m: Mask): Mask => (m === WALL ? POROUS : m);
    return {
      floor: { ...f.floor },
      edge: { N: loosen(f.edge.N), W: loosen(f.edge.W) },
      inner: { N: loosen(f.inner.N), E: loosen(f.inner.E), S: loosen(f.inner.S), W: loosen(f.inner.W) },
      centre: f.centre,
      wallType: f.wallType,
    };
  };
}

/* ------------------------------- the generator ------------------------------- */

/**
 * Generate a floor by narrowing a field of possibilities. Returns the (still uncollapsed) grid plus
 * the pinned route; call `resolveEmergent` for the concrete tiles.
 *
 * Throws only if the exit is unreachable on a BLANK field, which is impossible by construction (a
 * blank field is fully connected) — the check is a tripwire for a future change breaking that
 * invariant, not a runtime failure mode.
 */
export function generateEmergent(cfg: EmergentConfig): EmergentResult {
  const w = Math.max(2, cfg.width);
  const h = Math.max(2, cfg.height);
  const grid = makeGrid(w, h);

  const entry = cfg.entry ?? { cx: 1, cy: 1 };
  const exit = cfg.exit ?? { cx: w - 1, cy: h - 1 };
  const entryCorner = cornerId(w, entry.cx, entry.cy);
  const exitCorner = cornerId(w, exit.cx, exit.cy);

  const base = makeRng(mixSeeds(cfg.seed, BigInt(cfg.stratumIndex ?? 0)));
  const stats: EmergentResult['stats'] = {
    roomsPlaced: 0, roomsRejectedConflict: 0, roomsRejectedUnreachable: 0, roomsRejectedTooBig: 0,
    wallsPlaced: 0, wallsRejectedConflict: 0, wallsRejectedUnreachable: 0,
    ringSealed: 0, doorsKept: 0, seamsCohered: 0,
  };

  /** Everywhere connectivity must survive to: the exit, plus one interior corner per placed room.
   *  Grows as rooms land — a room that cannot be reached is not a room, it is a sealed box. */
  const targets: number[] = [exitCorner];

  /** Are ALL targets still ACHIEVABLE in this (possibly staged) view? The gate every commit passes. */
  const stillAchievable = (at: FieldAt): boolean =>
    reachesAll(at, w, h, 'may', entryCorner, targets);

  if (!stillAchievable(gridAt(grid))) {
    throw new Error('emergent: a blank field is not connected — the monotonicity invariant is broken');
  }

  /* ---- phase 1: rooms — placed ONLY from the AUTHORED structure library (structures.ts), never
     generated. A room is a big narrowing, so it goes first, while the field is still loose enough to
     accept one. ---- */
  const rooms: PlacedRoom[] = [];
  const roomRng: Rng = subStream(base, STREAM.rooms);
  const names = listStructures(); // Object.keys of a frozen JSON store — stable order
  const roomAttempts = cfg.roomAttempts ?? Math.max(12, Math.round((w * h) / 12));
  for (let i = 0; i < roomAttempts && names.length > 0; i++) {
    const name = names[nextInt(roomRng, names.length)]!;
    const st = getStructure(name)!;
    const rw = st.w, rh = st.h;
    if (rw >= w || rh >= h) { stats.roomsRejectedTooBig++; continue; }
    const rx = nextInt(roomRng, w - rw);
    const ry = nextInt(roomRng, h - rh);

    // Rooms don't overlap. This is a PLACEMENT POLICY, not an authority mechanism: a room's hard
    // walls landing in another's air already conflicts, but a POROUS boundary is `{none, wall}` and
    // `{none} ∩ {none, wall} = {none}` — permissive by design, so overlap slips through the AND-gate.
    // A rectangle test against the rooms we placed is the honest tool; nothing needs a claims table.
    if (rooms.some((m) => rx < m.x + m.w && m.x < rx + rw && ry < m.y + m.h && m.y < ry + rh)) {
      stats.roomsRejectedConflict++;
      continue;
    }

    const tx = begin(grid);
    stamp(tx, { x: rx, y: ry, w: rw, h: rh }, porousBoundary(st));
    const at = txAt(tx);
    if (!at(rx, ry)) { rollback(tx); stats.roomsRejectedConflict++; continue; } // a domain emptied
    // the room's own MIDDLE joins the targets for THIS check — a room we cannot reach is a box.
    // (the middle, not a boundary corner: a route that only touches the doorway hasn't entered.)
    targets.push(cornerId(w, rx + Math.max(1, rw >> 1), ry + Math.max(1, rh >> 1)));
    if (!stillAchievable(at)) { targets.pop(); rollback(tx); stats.roomsRejectedUnreachable++; continue; }
    if (!commit(tx)) { targets.pop(); stats.roomsRejectedConflict++; continue; }
    rooms.push({ x: rx, y: ry, w: rw, h: rh, structure: name });
    stats.roomsPlaced++;
  }

  /* ---- phase 2: maze walls. Add walls anywhere they do not disconnect the floor. The maze is the
     residue of this rule — nothing plans the corridors. ---- */
  const wallRng: Rng = subStream(base, STREAM.walls);
  const wallAttempts = cfg.wallAttempts ?? w * h * 3;
  const maxRun = cfg.maxRunLength ?? 4;
  for (let i = 0; i < wallAttempts; i++) {
    const x = nextInt(wallRng, w);
    const y = nextInt(wallRng, h);
    const d = DIRS[nextInt(wallRng, DIRS.length)]!;
    const len = nextRange(wallRng, 1, maxRun);
    if (runArms(grid, x, y, d, len).length === 0) continue;

    const tx = begin(grid);
    stampWallRun(tx, grid, x, y, d, len);
    const at = txAt(tx);
    if (!at(x, y)) { rollback(tx); stats.wallsRejectedConflict++; continue; }
    if (!stillAchievable(at)) { rollback(tx); stats.wallsRejectedUnreachable++; continue; }
    if (!commit(tx)) { stats.wallsRejectedConflict++; continue; }
    stats.wallsPlaced++;
  }

  /* ---- phase 3: CONNECT. Up to here every target was only ACHIEVABLE; pin a route to each so it
     becomes GUARANTEED and no later narrowing can close it. Routes cross the rooms' porous rings —
     pinning an arm there is exactly what makes it a door. ---- */
  const route: ArmEdge[] = [];
  for (const t of targets) {
    const r = findRoute(gridAt(grid), w, h, 'may', entryCorner, t);
    if (!r) {
      throw new Error(`emergent: target ${t} became unreachable despite the per-commit gate — invariant broken`);
    }
    const pinTx = begin(grid);
    pinRouteOpen(pinTx, r);
    if (!commit(pinTx)) {
      throw new Error('emergent: pinning a route emptied a domain — an arm was already forced to wall');
    }
    route.push(...r);
  }

  /* ---- phase 4: SEAL the rings. Every porous arm the routes did NOT need is narrowed the other way,
     to a finished wall — the last tightening. An arm a route depends on cannot be sealed (its domain
     no longer contains `wall`, so the stamp empties it and the transaction rolls back), so the doors
     fall out of the same mechanism rather than being special-cased: a door is simply a ring cell that
     sealing was refused. ---- */
  for (const m of rooms) {
    for (let y = m.y; y < m.y + m.h; y++) {
      for (let x = m.x; x < m.x + m.w; x++) {
        for (const d of DIRS) {
          const masks = armMasks(gridAt(grid), x, y, d);
          if (!masks) continue;
          // A ring cell the connect phase already pinned open IS the door — it left the porous state
          // in the open direction and there is nothing left to decide.
          if ((masks.inner & WALL) === 0 && (masks.inner & NONE) !== 0) { stats.doorsKept++; continue; }
          // ONLY the room's own porous ring cells. An untouched interior cell is also "wall or not",
          // but no template spoke about it — sealing those would fill the room in solid.
          if (masks.inner !== POROUS) continue;

          const tx = begin(grid);
          stampWallArm(tx, grid, x, y, d);
          const at = txAt(tx);
          if (!at(x, y) || !routeGuaranteed(at, route)) { rollback(tx); stats.doorsKept++; continue; }
          if (!commit(tx)) { stats.doorsKept++; continue; }
          stats.ringSealed++;
        }
      }
    }
  }

  /* ---- phase 5: SETTLE. Everything no template ever spoke about is still a full domain — space that
     has simply never been decided. Narrow it so the field is fully determined and the collapse pick has
     nothing left to choose; that independence is what "the generator decided the floor" means.

     SETTLE THE WHOLE TILE, not just its arms. A TileField is nine cells PLUS a floor per corner, a
     centre column and a wall type — leave any of those wide and the pick decides them at random, which
     shows up as speckled floor materials and pillars sprouting in mid-air. (It did; that was the bug.)
     Defaults: arms/centre → `none` (open space, no pillar), floor → `stone` (the corridor ground),
     wallType → `solid`. Opening can only ADD reachability, so this needs no gate; cells already
     narrowed to a wall no longer contain `none` and are untouched. ---- */
  /* ---- phase 4b: COHERE the seams. Before anything defaults, pull every split-across-tiles feature
     toward agreement: each CROSS seam (2 tiles — the wall line over a boundary) and each POINT seam
     (4 tiles — the floor quadrants meeting at a lattice point). Narrowing to the intersection where
     one is still available lets a decision made in one tile carry into its partners, which is what
     stops walls half-crossing a boundary and floors changing material four ways around a point. A
     seam whose members were genuinely decided differently has an empty intersection and is left
     alone — coherence is a tendency, never an override. ---- */
  const cohereTx = begin(grid);
  {
    const at = txAt(cohereTx);
    for (const seam of allCrossSeams(grid)) if (cohere(cohereTx, at, seam)) stats.seamsCohered++;
    for (const seam of allPointSeams(grid)) if (cohere(cohereTx, at, seam)) stats.seamsCohered++;
  }
  if (!commit(cohereTx)) {
    throw new Error('emergent: cohering a seam emptied a domain — impossible, the intersection was checked');
  }

  const settleTx = begin(grid);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = grid.cells[y * w + x]!;
      const inner: Partial<Record<Dir, Mask>> = {};
      for (const d of DIRS) if ((f.inner[d] & NONE) !== 0) inner[d] = NONE;
      const edge: Partial<Record<'N' | 'W', Mask>> = {};
      if ((f.edge.N & NONE) !== 0) edge.N = NONE;
      if ((f.edge.W & NONE) !== 0) edge.W = NONE;
      const floor: Partial<Record<FloorCorner, Mask>> = {};
      for (const c of FLOOR_CORNERS) if ((f.floor[c] & STONE) !== 0) floor[c] = STONE;
      const centre = (f.centre & NONE_CENTRE) !== 0 ? NONE_CENTRE : undefined;
      const wallType = (f.wallType & SOLID) !== 0 ? SOLID : undefined;
      stamp(settleTx, { x, y, w: 1, h: 1 }, template({
        inner, edge, floor,
        ...(centre !== undefined ? { centre } : {}),
        ...(wallType !== undefined ? { wallType } : {}),
      }));
    }
  }
  if (!commit(settleTx)) {
    throw new Error('emergent: settling open space emptied a domain — impossible, `none` was checked present');
  }

  return { grid, route, rooms, entryCorner, exitCorner, targets, stats };
}

/** Collapse an emergent field to concrete tiles. The pick is a COORDINATE HASH (order-independent,
 *  integer-only), so the output does not depend on cell visit order or on how many phases ran. */
export function resolveEmergent(result: EmergentResult, seed: bigint): (WallTile | null)[] {
  const pick = (x: number, y: number, cell: string, options: readonly string[]): number => {
    let tag = 0n;
    for (let i = 0; i < cell.length; i++) tag = tag * 131n + BigInt(cell.charCodeAt(i));
    const hMix = mixSeeds(seed, mixSeeds(BigInt(x * 73856093 + y * 19349663), tag));
    const n = BigInt(options.length);
    return Number(((hMix % n) + n) % n);
  };
  return resolveGrid(result.grid, pick);
}

/** The generator's own end-gate: after collapse, is the pinned route still open on the CONCRETE
 *  tiles? Cheap, and it catches a collapse that disagreed with the field it came from. */
export function verifyEmergent(result: EmergentResult): boolean {
  return routeGuaranteed(gridAt(result.grid), result.route);
}
