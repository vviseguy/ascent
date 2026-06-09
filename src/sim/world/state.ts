// ============================================================================
// src/sim/world/state.ts — the deterministic WORLD STATE (struct-of-arrays).
// ============================================================================
//
// This is the single mutable data structure the simulation advances each tick,
// the thing rollback saves/restores, and the thing we hash for desync detection.
// EVERYTHING here is integers (raw Q16.16 `Fixed` stored as Int32, plus small
// enums/flags), so the state is exactly cloneable, exactly hashable, and
// bit-identical across JS engines (see CLAUDE.md "the simulation is deterministic").
//
// WHY STRUCT-OF-ARRAYS (SoA)
// --------------------------
// Bodies are stored as parallel typed arrays indexed by a dense entity id
// (0..capacity-1), NOT as an array of objects. Reasons:
//   1. Determinism: iteration is plain ascending-index order — never Map/Set
//      iteration, whose order can vary. The id IS the iteration order.
//   2. Rollback cost: save = copy a handful of typed arrays; restore = copy back.
//      No per-object allocation, no GC churn on the hot rollback path.
//   3. Hashing: hashing contiguous typed arrays is trivial and fast.
//   4. Cache: the integrator sweeps each field array linearly.
//
// Capacity is fixed at creation (a rollback ring buffer wants stable sizes); the
// bound is generous for the AoI-bounded entity count near one crew's Anchor.
// ============================================================================

import { type Fixed, fromInt, fromFloatConst, ZERO } from '../fixed/fixed.ts';

/** Max simultaneously-tracked bodies in one sim instance (AoI-bounded in practice). */
export const MAX_ENTITIES = 256;

/**
 * Mass class — the "mass hierarchy" pillar (00-master-vision §3 pillar 2):
 * Light < Player < Heavy < Anchor. Drives carry-slow, throw force, struggle
 * resistance, and shove outcomes. The actual Fixed mass value is looked up from
 * MASS_OF so the class stays a compact small int in the state.
 *
 * NOTE: a plain const object (not a TS `enum`) so Node's strip-only type stripping
 * can run our files dependency-free (CLAUDE.md / floor module use the same pattern).
 */
export const MassClass = {
  Light: 0, // small throwable objects (crate fragments)
  Player: 1, // a regular crew member
  Heavy: 2, // big throwable objects (barrels, built blocks)
  Anchor: 3, // the precious VIP — heaviest
} as const;
export type MassClass = (typeof MassClass)[keyof typeof MassClass];

/** Fixed mass per class (authoring constants; converted once, never at runtime from float). */
export const MASS_OF: readonly Fixed[] = [
  fromFloatConst(0.4), // Light
  fromFloatConst(1.0), // Player
  fromFloatConst(1.8), // Heavy
  fromFloatConst(3.2), // Anchor
];

/**
 * Per-body bit flags packed into one integer field. Bitwise ops are exact on
 * 32-bit integers across engines, so flags are determinism-safe. Plain const
 * object (not a TS `enum`) for strip-only compatibility.
 */
export const BodyFlag = {
  Alive: 1 << 0,
  Grounded: 1 << 1, // resting on a surface this tick (enables friction / jump)
  Player: 1 << 2, // controllable by an input stream
  Anchor: 1 << 3, // is a crew's scoring VIP
  Throwable: 1 << 4, // a world object that can be grabbed/thrown
  Downed: 1 << 5, // in the downed/vulnerable beat (Anchor after a big throw)
  NoGravity: 1 << 6, // carried bodies ignore gravity (carrier owns transform)
} as const;
export type BodyFlag = (typeof BodyFlag)[keyof typeof BodyFlag];

/** Sentinel for "no entity" in id-valued fields (grabbedBy / holding). */
export const NO_ENTITY = -1;

/** Sentinel crew id for "no crew" (world objects, hazards). */
export const NO_CREW = 255;

/**
 * Player role (the six identities, docs/02 §6). A small per-body byte. Drives verb
 * strength tables AND role abilities (catch/revive/body-block/bridge/break). World
 * objects use Role.None. Const object (strip-only friendly), kept in sync with the
 * verb config's Role indices (Runner..Anchor map to 0..5).
 */
export const Role = {
  Runner: 0,
  Bulwark: 1,
  Mender: 2,
  Engineer: 3,
  Breaker: 4,
  Anchor: 5,
  None: 6, // non-player bodies (objects)
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/**
 * The world state. All numeric arrays hold RAW Q16.16 integers (via toRaw/fromRaw)
 * or small enums/flags. Treat every array as parallel: index `i` across all arrays
 * is body `i`. `count` is the high-water mark of used ids; ids below count may be
 * dead (Alive flag clear) — we keep ids stable for the lifetime of a sim so that
 * hashes and cross-peer references line up (no compaction that would renumber).
 */
export interface WorldState {
  /** Capacity (length of every parallel array). Constant for a sim instance. */
  readonly capacity: number;
  /** Highest used id + 1. Iterate [0, count). */
  count: number;
  /** The simulation tick this state represents (integer, monotonic). */
  tick: number;

  // --- transform & motion (raw Fixed) ---
  px: Int32Array;
  py: Int32Array;
  pz: Int32Array;
  vx: Int32Array;
  vy: Int32Array;
  vz: Int32Array;
  /** Facing angle (raw Fixed radians), used for aim / socket offset. */
  facing: Int32Array;

  // --- shape & mass ---
  /** Collision radius (raw Fixed). We model bodies as upright capsules → circle in plan. */
  radius: Int32Array;
  /** Half-height (raw Fixed) for vertical extent / standing. */
  halfHeight: Int32Array;
  /** MassClass enum per body. */
  massClass: Uint8Array;
  /** Crew id per body (0..numCrews-1), or NO_CREW for objects/hazards. Hashed. */
  crewId: Uint8Array;
  /** Role per body (see Role const). Drives verb strength + role abilities. Hashed. */
  role: Uint8Array;

  // --- gameplay relations ---
  /** Bitfield of BodyFlag. */
  flags: Uint16Array;
  /** Entity id currently grabbing this body, or NO_ENTITY. */
  grabbedBy: Int32Array;
  /** Entity id this body is currently holding, or NO_ENTITY. */
  holding: Int32Array;
  /** Health / integrity (raw Fixed). For players/anchor; objects may ignore. */
  health: Int32Array;
  /**
   * Per-body small integer scratch the verb system uses for tick-counted state
   * (e.g. struggle accumulator, downed-until tick). Kept in-state so it is part
   * of the hash and survives save/restore. Meaning is owned by the verb layer.
   */
  timer: Int32Array;

  // --- VERB SYSTEM tick-state (src/sim/verbs) -------------------------------
  // All of the following are per-body Int32 fields owned by the verb layer. They
  // are listed in INT32_FIELDS, so hashWorld / clone / restoreInto / statesEqual
  // (which all iterate INT32_FIELDS) cover them automatically — that is what keeps
  // the verb state machines rollback-safe. They store absolute TICK numbers
  // ("...Until" = the tick the effect ends, exclusive) or accumulators, never
  // wall-clock, never floats. Sentinel for "no scheduled tick" is -1.

  /**
   * Tick at which the carrier's in-progress GRAB latch on this (target) body
   * completes; valid only while a latch is pending. -1 when idle. (Also doubles
   * as the latch-owner channel via grabbedBy not yet being set: while pending,
   * grabbedBy is still NO_ENTITY but grabLatchUntil>=0 and grabLatchBy holds the
   * would-be carrier.)
   */
  grabLatchUntil: Int32Array;
  /** Would-be carrier id during a pending latch on this body, else NO_ENTITY. */
  grabLatchBy: Int32Array;
  /**
   * Tick until which this body cannot be re-grabbed after breaking free
   * (REGRAB_IMMUNITY). -1/absent => grabbable now.
   */
  regrabUntil: Int32Array;
  /** Accumulated STRUGGLE progress (raw Fixed) while this body is held. */
  struggleProgress: Int32Array;
  /** Last tick a valid struggle press EDGE was counted (for debounce + idle decay). */
  struggleLastPress: Int32Array;
  /** Snapshot of this body's input buttons from the PREVIOUS tick (press-edge detect). */
  prevButtons: Int32Array;
  /** Tick until which this body is mid-RUSH dash (kinematic sweep active). -1 idle. */
  rushUntil: Int32Array;
  /** Tick at which this body's RUSH dash STARTED (for ease-out progress). -1 idle. */
  rushStart: Int32Array;
  /** Tick until which RUSH is on cooldown (cannot start a new dash). */
  rushCdUntil: Int32Array;
  /** True(1)/false(0): this body has already air-rushed since last grounded. */
  airRushUsed: Int32Array;
  /** Tick until which this body is staggered (can't grab/jump/ability). -1 idle. */
  staggerUntil: Int32Array;
  /**
   * The releaseTick of the last THROW this body performed, for idempotency: a
   * throw is applied at most once per (thrower, releaseTick). -1 => none yet.
   */
  lastThrowTick: Int32Array;
  /** Tick until which SHOVE (empty-hand throw tap) is on cooldown. */
  lastShoveTick: Int32Array;
  /** Tick this body was first held in the current hold (for MAX_HELPLESS cap). -1 idle. */
  heldSince: Int32Array;
  /**
   * Throw-charge accumulator (ticks, 0..THROW_CHARGE_TICKS) while this body holds
   * something and the GRAB button is held. Its OWN field (not the shared `timer`) so
   * it can't be clobbered by the downed countdown or any other timer user. Hashed.
   */
  throwCharge: Int32Array;
  /**
   * Tick until which this body is in the DOWNED beat (fall/throw-down vulnerable
   * window). Its OWN field so it isn't aliased with `timer`/throwCharge. -1 = not
   * downed. Cleared (and BodyFlag.Downed removed) when tick >= this. Hashed.
   */
  downedUntil: Int32Array;
  /**
   * Tick at which a dead regular player respawns (at their crew beacon). -1 = alive
   * / not scheduled. Death/respawn resolution (sim.ts) sets and consumes it. Hashed.
   */
  respawnAt: Int32Array;
  /**
   * Tick until which a downed (0-HP) regular player is bleeding out; if not revived
   * by then they die. -1 = not bleeding. Hashed.
   */
  bleedUntil: Int32Array;
  /** Tick at/after which this body may RECALL again (beacon recall cooldown). Hashed. */
  recallReadyAt: Int32Array;
}

/** Allocate an empty world state of the given capacity. All bodies start dead. */
export function createWorld(capacity: number = MAX_ENTITIES): WorldState {
  return {
    capacity,
    count: 0,
    tick: 0,
    px: new Int32Array(capacity),
    py: new Int32Array(capacity),
    pz: new Int32Array(capacity),
    vx: new Int32Array(capacity),
    vy: new Int32Array(capacity),
    vz: new Int32Array(capacity),
    facing: new Int32Array(capacity),
    radius: new Int32Array(capacity),
    halfHeight: new Int32Array(capacity),
    massClass: new Uint8Array(capacity),
    crewId: new Uint8Array(capacity).fill(NO_CREW),
    role: new Uint8Array(capacity).fill(Role.None),
    flags: new Uint16Array(capacity),
    grabbedBy: new Int32Array(capacity).fill(NO_ENTITY),
    holding: new Int32Array(capacity).fill(NO_ENTITY),
    health: new Int32Array(capacity),
    timer: new Int32Array(capacity),
    // verb tick-state — "...Until"/"...Tick"/"Start"/"Since" channels default to -1
    // (no scheduled tick / idle); accumulators + flags default to 0.
    grabLatchUntil: new Int32Array(capacity).fill(-1),
    grabLatchBy: new Int32Array(capacity).fill(NO_ENTITY),
    regrabUntil: new Int32Array(capacity).fill(-1),
    struggleProgress: new Int32Array(capacity),
    struggleLastPress: new Int32Array(capacity).fill(-1),
    prevButtons: new Int32Array(capacity),
    rushUntil: new Int32Array(capacity).fill(-1),
    rushStart: new Int32Array(capacity).fill(-1),
    rushCdUntil: new Int32Array(capacity).fill(-1),
    airRushUsed: new Int32Array(capacity),
    staggerUntil: new Int32Array(capacity).fill(-1),
    lastThrowTick: new Int32Array(capacity).fill(-1),
    lastShoveTick: new Int32Array(capacity).fill(-1),
    heldSince: new Int32Array(capacity).fill(-1),
    throwCharge: new Int32Array(capacity),
    downedUntil: new Int32Array(capacity).fill(-1),
    respawnAt: new Int32Array(capacity).fill(-1),
    bleedUntil: new Int32Array(capacity).fill(-1),
    recallReadyAt: new Int32Array(capacity),
  };
}

/** Spec for spawning a body (Fixed-typed, converted to raw on write). */
export interface BodySpec {
  px: Fixed;
  py: Fixed;
  pz: Fixed;
  radius: Fixed;
  halfHeight: Fixed;
  massClass: MassClass;
  flags: number; // BodyFlag bits (Alive is added automatically)
  health?: Fixed;
  facing?: Fixed;
  crewId?: number; // defaults to NO_CREW (objects)
  role?: Role; // defaults to Role.None
}

/**
 * Spawn a body, returning its stable id. Reuses the lowest dead slot if any (so a
 * long match with churn does not grow `count` unbounded), else extends `count`.
 * Deterministic: the dead-slot scan is ascending-index, so the same spawn sequence
 * always yields the same ids on every peer.
 */
export function spawnBody(w: WorldState, spec: BodySpec): number {
  let id = -1;
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) {
      id = i;
      break;
    }
  }
  if (id === -1) {
    if (w.count >= w.capacity) throw new Error('world capacity exceeded');
    id = w.count++;
  }
  w.px[id] = spec.px;
  w.py[id] = spec.py;
  w.pz[id] = spec.pz;
  w.vx[id] = 0;
  w.vy[id] = 0;
  w.vz[id] = 0;
  w.facing[id] = spec.facing ?? ZERO;
  w.radius[id] = spec.radius;
  w.halfHeight[id] = spec.halfHeight;
  w.massClass[id] = spec.massClass;
  w.crewId[id] = spec.crewId ?? NO_CREW;
  w.role[id] = spec.role ?? Role.None;
  w.flags[id] = (spec.flags | BodyFlag.Alive) & 0xffff;
  w.grabbedBy[id] = NO_ENTITY;
  w.holding[id] = NO_ENTITY;
  w.health[id] = spec.health ?? fromInt(100);
  w.timer[id] = 0;
  // verb tick-state — reset to idle so a reused slot carries no stale verb state.
  w.grabLatchUntil[id] = -1;
  w.grabLatchBy[id] = NO_ENTITY;
  w.regrabUntil[id] = -1;
  w.struggleProgress[id] = 0;
  w.struggleLastPress[id] = -1;
  w.prevButtons[id] = 0;
  w.rushUntil[id] = -1;
  w.rushStart[id] = -1;
  w.rushCdUntil[id] = -1;
  w.airRushUsed[id] = 0;
  w.staggerUntil[id] = -1;
  w.lastThrowTick[id] = -1;
  w.lastShoveTick[id] = -1;
  w.heldSince[id] = -1;
  w.throwCharge[id] = 0;
  w.downedUntil[id] = -1;
  w.respawnAt[id] = -1;
  w.bleedUntil[id] = -1;
  w.recallReadyAt[id] = 0;
  return id;
}

/** Mark a body dead (slot becomes reusable). Clears relations to keep state clean. */
export function killBody(w: WorldState, id: number): void {
  w.flags[id] = 0;
  w.grabbedBy[id] = NO_ENTITY;
  w.holding[id] = NO_ENTITY;
}

/** Convenience flag test/set helpers (kept tiny + inlinable). */
export const hasFlag = (w: WorldState, id: number, f: BodyFlag): boolean =>
  (w.flags[id]! & f) !== 0;
export const setFlag = (w: WorldState, id: number, f: BodyFlag): void => {
  w.flags[id] = (w.flags[id]! | f) & 0xffff;
};
export const clearFlag = (w: WorldState, id: number, f: BodyFlag): void => {
  w.flags[id] = w.flags[id]! & ~f & 0xffff;
};

/**
 * The parallel Int32 field arrays, in a FIXED order — used by hash & snapshot.
 *
 * NOTE: hashWorld / clone / restoreInto / statesEqual all iterate THIS list, so
 * appending the verb-system fields here is what makes them automatically hashed,
 * cloned, restored, and compared (and therefore rollback-safe). Order is part of
 * the on-the-wire hash contract: only ever APPEND, never reorder/remove, or two
 * peers (or a peer vs. its own pre-change replay) would compute different hashes.
 */
export const INT32_FIELDS: readonly (keyof WorldState)[] = [
  'px', 'py', 'pz', 'vx', 'vy', 'vz', 'facing', 'radius', 'halfHeight',
  'grabbedBy', 'holding', 'health', 'timer',
  // --- verb system tick-state (appended; see WorldState above) ---
  'grabLatchUntil', 'grabLatchBy', 'regrabUntil', 'struggleProgress',
  'struggleLastPress', 'prevButtons', 'rushUntil', 'rushStart', 'rushCdUntil',
  'airRushUsed', 'staggerUntil', 'lastThrowTick', 'lastShoveTick', 'heldSince',
  'throwCharge', 'downedUntil', 'respawnAt', 'bleedUntil', 'recallReadyAt',
];

/**
 * The parallel Uint8 field arrays, in a FIXED order — used by hash & snapshot
 * alongside INT32_FIELDS. Same append-only contract: only append, never reorder.
 * (massClass/crewId/role are body identity/relations that are part of the state.)
 */
export const BYTE_FIELDS: readonly (keyof WorldState)[] = ['massClass', 'crewId', 'role'];
