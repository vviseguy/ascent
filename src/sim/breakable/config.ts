// ============================================================================
// src/sim/breakable/config.ts — the canonical BREAKABLE tuning numbers.
// ============================================================================
//
// Every gameplay number for destructible props (crates / pots / barrels) and the
// item drops they spawn, converted ONCE from authored floats into Fixed / integer
// constants — the same single-source-of-truth discipline as src/sim/verbs/config.ts.
// The rest of the breakable layer reads only these constants; no stray
// fromFloatConst sits on a runtime path.
//
// DETERMINISM: fromFloatConst runs at module load on literals (authoring). No
// runtime float ever enters the sim. Integrity / damage are Fixed; counts/ticks
// are plain integers. (CLAUDE.md "the simulation is deterministic".)
// ============================================================================

import { type Fixed, fromFloatConst, fromInt } from '../fixed/fixed.ts';

// ---- INTEGRITY (authored health used as the break threshold) ----------------
/**
 * Default integrity for a freshly spawned breakable (raw-able Fixed). A breakable
 * is DESTROYED the tick its `health` field reaches 0. ~10 is small enough that a
 * single Breaker shove or a couple of solid hits clears it. (Scene authoring may
 * pass a different value per prop via the spawn spec's `health`.)
 */
export const BREAKABLE_INTEGRITY: Fixed = fromInt(10);

// ---- DAMAGE SOURCES ---------------------------------------------------------
/**
 * Damage dealt to a breakable per tick by a BREAKER AoE shove that reaches it.
 * Tuned so one shove (which lasts a few ticks via breakerShoveUntil) reliably
 * clears a default-integrity prop — the Breaker's "open shortcuts" fantasy (§6.5).
 */
export const SHOVE_DAMAGE: Fixed = fromInt(12);

/**
 * Damage dealt to a breakable per tick by a RUSH dash that contacts it. A single
 * rush (RUSH_TICKS overlapping ticks) deals roughly this × the contact ticks, so
 * one clean rush through a prop destroys it.
 */
export const RUSH_DAMAGE: Fixed = fromInt(6);

/**
 * THROWN-BODY impact: a free, fast-moving body overlapping a breakable deals
 * damage proportional to its excess speed above the threshold. Only impacts at or
 * above THROW_IMPACT_SPEED count (a body merely resting against a prop does
 * nothing). damage = THROW_IMPACT_SCALE × (speed − THROW_IMPACT_SPEED).
 */
export const THROW_IMPACT_SPEED: Fixed = fromFloatConst(5.0); // u/s magnitude
export const THROW_IMPACT_SCALE: Fixed = fromFloatConst(2.0); // dmg per (u/s) over threshold
/** Cap on a single thrown-impact hit so one fast body can't deal absurd damage. */
export const THROW_IMPACT_MAX: Fixed = fromInt(30);

/**
 * Extra ground-plane reach (u) added to the sum of radii when testing whether a
 * damaging body CONTACTS a breakable. A small slop so a near-miss skim still bites.
 */
export const CONTACT_SLOP: Fixed = fromFloatConst(0.15);

// ---- ITEM DROPS -------------------------------------------------------------
/**
 * Min / max number of Pickup drops spawned when a breakable is destroyed. The
 * actual count is a deterministic seeded draw in [MIN, MAX], keyed on
 * (tick, breakableId) — same seed/tick ⇒ identical count on every peer & re-sim.
 */
export const DROP_MIN = 1;
export const DROP_MAX = 3;

/** Radius (u) of a spawned pickup body (small Light throwable). */
export const DROP_RADIUS: Fixed = fromFloatConst(0.2);
/** Half-height (u) of a spawned pickup body. */
export const DROP_HALF_HEIGHT: Fixed = fromFloatConst(0.2);

/**
 * Seeded scatter velocity applied to each drop so the spawn "pops" outward instead
 * of stacking on one point. Horizontal speed magnitude (u/s) and the fixed upward
 * pop (u/s); the horizontal DIRECTION is the per-drop seeded angle.
 */
export const DROP_SCATTER_SPEED: Fixed = fromFloatConst(2.5);
export const DROP_POP_UP: Fixed = fromFloatConst(3.0);
/** Vertical offset (u) above the breakable center where drops appear (slightly up). */
export const DROP_SPAWN_LIFT: Fixed = fromFloatConst(0.1);
