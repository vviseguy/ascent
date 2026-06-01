// ============================================================================
// src/sim/hazards/model.ts — the SCRIPTED HAZARDS data model (plain structs).
// ============================================================================
//
// WHY PLAIN STRUCTS (no classes, no methods, no closures): a hazard must be a
// PURE FUNCTION of (tick + authored params). Keeping the authored data as flat
// const-able structs means the whole hazard set is trivially serializable,
// comparable, and carries ZERO mutable runtime state. Every hazard's effect at
// tick T is computed from these fields alone (plus current body positions from
// the spatial index), so re-simulation after a rollback reproduces it
// bit-for-bit — exactly like floor data (src/floor) is authored once and read.
//
// UNITS / STORAGE: every spatial/temporal magnitude that participates in sim
// math is a RAW Q16.16 int (authored via toRaw(fromFloatConst(...)) — AUTHORING
// ONLY). Tick counts/cycles/phases are plain integers. NO float ever survives
// into runtime math (matches the determinism bedrock in src/sim/fixed).
//
// DETERMINISM RULES honored here:
//   - No randomness except the tiny seeded jitter derived from (tick,id,channel)
//     in jitter.ts — never JS Math.random (same rule the floor RNG follows).
//   - Hazards hold NO per-tick mutable state; they read the `tick` passed in.
//   - Damage is written to w.health (raw Fixed); impulses to w.vx/vy/vz (raw
//     Fixed); both via fixed.ts ops only.
//
// NOTE on enum style: a const object + type alias (NOT a TS `enum`), so Node's
// strip-only type stripping runs our files dependency-free — same pattern as
// MassClass / BodyFlag / Button in the world layer.
// ============================================================================

/** Hazard kind discriminants. */
export const HazardKind = {
  Crusher: 0,
  Turret: 1,
  Tile: 2,
  Gust: 3,
  Spikes: 4,
} as const;
export type HazardKind = (typeof HazardKind)[keyof typeof HazardKind];

/**
 * CRUSHER — a moving solid that oscillates between authored points A and B on a
 * fixed tick cycle via a TRIANGLE wave of `tick`. Its center position is a pure
 * f(tick) (see schedule.crusherPos). On overlap (within `radius` of the center)
 * it applies a knockback impulse along the body→escape direction plus contact
 * damage. (Kinematic; not a solver impulse — matches the "carry/rush are
 * kinematic, not impulses" engine decision.)
 */
export interface CrusherHazard {
  kind: typeof HazardKind.Crusher;
  /** Endpoint A (raw Fixed). */
  ax: number; ay: number; az: number;
  /** Endpoint B (raw Fixed). */
  bx: number; by: number; bz: number;
  /** Full A→B→A cycle length in ticks (triangle wave period). */
  period: number;
  /** Tick offset so multiple crushers can be phase-shifted deterministically. */
  phase: number;
  /** Contact radius (raw Fixed). */
  radius: number;
  /** Impulse magnitude on contact (raw Fixed velocity delta). */
  impulse: number;
  /** Damage per tick of contact (raw Fixed health). */
  damage: number;
}

/**
 * TURRET — authored MOVING-SEGMENT projectile model (chosen over spawnBody).
 *
 * WHY moving-segment over spawning a body: it needs ZERO entity budget, ZERO new
 * WorldState arrays, and NO lifetime bookkeeping to clean up. The projectile's
 * position is a closed-form pure function of tick, so it cannot desync and costs
 * nothing to roll back (it never touches the authoritative arrays except to write
 * damage/impulse onto bodies it hits). A spawnBody projectile would consume an id,
 * need a despawn pass, and add per-projectile arrays to clone/restore/hash — all
 * avoidable. (We document the alternative; this model is strictly cheaper.)
 *
 * Each `fireEvery` ticks the turret "fires"; for the first `projectileLife` ticks
 * of that cycle a projectile travels from the muzzle along `dir` at `speed`
 * (units PER TICK). Bodies within `hitRadius` of the projectile take `damage`.
 */
export interface TurretHazard {
  kind: typeof HazardKind.Turret;
  /** Muzzle origin (raw Fixed). */
  mx: number; my: number; mz: number;
  /** Fire direction, SHOULD be unit-length (raw Fixed). */
  dx: number; dy: number; dz: number;
  /** Fire one projectile every N ticks. */
  fireEvery: number;
  /** Tick offset for phase. */
  phase: number;
  /** Projectile travel speed, raw Fixed units PER TICK. */
  speed: number;
  /** Projectile lifetime in ticks after each fire. */
  projectileLife: number;
  /** Hit radius around the projectile (raw Fixed). */
  hitRadius: number;
  /** Damage applied on contact (raw Fixed health). */
  damage: number;
}

/**
 * COLLAPSING / REFORMING TILE — a small terrain box that toggles solid on a fixed
 * cycle. Solidity is a pure f(tick): solid for `solidTicks` out of every `period`
 * ticks (offset by `phase`). While solid it acts as a floor box over its XZ
 * footprint with its top at `topY`: a body inside the footprint that is at/below
 * the top is rested on it (py clamped to topY, downward vy zeroed, Grounded set).
 * While non-solid it does nothing, so a body that was resting on it falls under
 * gravity on the next integrate. (Authored like a one-cell platform; the full
 * terrain layer lives in src/sim/collide — this is the dynamic, tick-scheduled
 * variant.)
 */
export interface TileHazard {
  kind: typeof HazardKind.Tile;
  /** Footprint AABB in XZ (raw Fixed). */
  minX: number; minZ: number; maxX: number; maxZ: number;
  /** Top surface height (raw Fixed). */
  topY: number;
  /** Full cycle length in ticks. */
  period: number;
  /** How many ticks of each cycle the tile is solid. */
  solidTicks: number;
  /** Tick offset for phase. */
  phase: number;
}

/**
 * GUST / CONVEYOR — an AABB zone that applies a CONSTANT directional velocity
 * delta each tick to every body inside it. Pure: same zone+tick+occupants ⇒ same
 * deltas. Direction need not be unit; authored as a raw Fixed per-tick impulse.
 */
export interface GustHazard {
  kind: typeof HazardKind.Gust;
  /** Zone AABB in XZ (raw Fixed). */
  minX: number; minZ: number; maxX: number; maxZ: number;
  /** Y band: a body must have minY ≤ py ≤ maxY to be affected (raw Fixed). */
  minY: number; maxY: number;
  /** Per-tick velocity delta (raw Fixed) applied to bodies inside. */
  ix: number; iy: number; iz: number;
}

/**
 * SPIKES — a damage AABB zone. Any body inside (XZ footprint and Y band) takes
 * `damage` (raw Fixed health) per tick.
 */
export interface SpikesHazard {
  kind: typeof HazardKind.Spikes;
  /** Zone AABB in XZ (raw Fixed). */
  minX: number; minZ: number; maxX: number; maxZ: number;
  /** Y band (raw Fixed). */
  minY: number; maxY: number;
  /** Damage per tick (raw Fixed health). */
  damage: number;
}

/** Tagged union of all hazard variants. */
export type Hazard =
  | CrusherHazard
  | TurretHazard
  | TileHazard
  | GustHazard
  | SpikesHazard;
