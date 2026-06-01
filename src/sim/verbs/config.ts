// ============================================================================
// src/sim/verbs/config.ts — the canonical VERB tuning numbers (authoring consts).
// ============================================================================
//
// Every gameplay number for RUSH / GRAB / THROW / STRUGGLE and the five grab
// pressures lives here, converted ONCE from the design doc's floats into Fixed /
// integer-tick constants (docs/02-roles-anchor-verbs.md "DESIGN SPEC"). The rest
// of the verb layer reads only these — so the numbers are auditable in one place
// and there is no stray fromFloatConst on a runtime path.
//
// DETERMINISM: fromFloatConst is an AUTHORING conversion run at module load on a
// literal. No runtime float ever enters the sim. Tick counts are plain integers.
// ============================================================================

import { type Fixed, fromFloatConst, fromInt } from '../fixed/fixed.ts';
import { MassClass } from '../world/state.ts';

// ---- RUSH ------------------------------------------------------------------
/** Dash distance (u) covered over the dash window, ease-out. */
export const RUSH_DIST: Fixed = fromFloatConst(4.0);
/** Dash duration in ticks. */
export const RUSH_TICKS = 9;
/** RUSH cooldown in ticks (from dash start). */
export const RUSH_CD_TICKS = 48;
/** Stagger applied to a rush-hit target, in ticks (can't grab/jump/ability). */
export const RUSH_STAGGER_TICKS = 24;
/** Base pushback distance (u) imparted to a rush-hit target before mass scaling. */
export const RUSH_PUSHBACK_BASE: Fixed = fromFloatConst(1.5);
/** Pushback clamp range (u) after mass scaling. */
export const RUSH_PUSHBACK_MIN: Fixed = fromFloatConst(0.3);
export const RUSH_PUSHBACK_MAX: Fixed = fromFloatConst(3.0);
/** Contact half-width (u) of the rush sweep (how close the line must pass). */
export const RUSH_HIT_RADIUS: Fixed = fromFloatConst(0.9);

// ---- GRAB ------------------------------------------------------------------
/** Frontal grab cone reach (u). */
export const GRAB_REACH: Fixed = fromFloatConst(2.2);
/** Grab cone HALF-angle (radians) ≈ 70 deg. */
export const GRAB_HALF_ANGLE: Fixed = fromFloatConst((70 * Math.PI) / 180);
/** Latch time per target MassClass (ticks). Index by MassClass. */
export const GRAB_LATCH_TICKS: readonly number[] = [
  3, // Light
  7, // Player
  9, // Heavy
  22, // Anchor
];
/** Carry socket distance in front of the carrier (u) — matches step.ts CARRY_REACH. */
export const CARRY_REACH: Fixed = fromFloatConst(0.9);

// ---- THROW / SHOVE ---------------------------------------------------------
/** Throw charge ramp duration (ticks) for full charge c=1. */
export const THROW_CHARGE_TICKS = 30;
/** Throw impulse base coefficient: J = THROW_J * c * (1/sqrt(mass)) * strength. */
export const THROW_J: Fixed = fromFloatConst(14.0);
/** Throw arc angle clamp (radians) and default. */
export const THROW_ANGLE_MIN: Fixed = fromFloatConst((10 * Math.PI) / 180);
export const THROW_ANGLE_MAX: Fixed = fromFloatConst((60 * Math.PI) / 180);
export const THROW_ANGLE_DEFAULT: Fixed = fromFloatConst((38 * Math.PI) / 180);
/** Seeded jitter half-range on the throw angle (radians); tiny, deterministic. */
export const THROW_JITTER_RANGE: Fixed = fromFloatConst((2 * Math.PI) / 180);

/** SHOVE (empty-hand throw tap) micro impulse (u/s-ish, applied as velocity). */
export const SHOVE_J: Fixed = fromFloatConst(4.0);
/** SHOVE cone reach (u). */
export const SHOVE_REACH: Fixed = fromFloatConst(1.6);
/** SHOVE cooldown (ticks). */
export const SHOVE_CD_TICKS = 18;

// ---- STRUGGLE --------------------------------------------------------------
/** Break threshold in progress units. */
export const STRUGGLE_BREAK: Fixed = fromInt(100);
/** Per-valid-press base: press = STRUGGLE_PRESS * strength * (mass / grip). */
export const STRUGGLE_PRESS: Fixed = fromInt(6);
/** Anti-autoclicker: presses fewer than this many ticks apart are ignored. */
export const STRUGGLE_DEBOUNCE_TICKS = 2;
/** Idle ticks before struggle progress begins to decay. */
export const STRUGGLE_IDLE_TICKS = 8;
/** Progress decay per tick once idle. */
export const STRUGGLE_DECAY: Fixed = fromInt(4);
/** Carrier "grip" denominator in the press formula (carrier resistance). */
export const CARRIER_GRIP: Fixed = fromFloatConst(1.0);

// ---- INVARIANTS ------------------------------------------------------------
/** Re-grab immunity after breaking free (ticks). */
export const REGRAB_IMMUNITY_TICKS = 18;
/** Hard cap: force-break a hold that has lasted this many ticks (held-never-forever). */
export const MAX_HELPLESS_TICKS = 600; // 10s @ 60Hz

// ---- ROLE STRENGTHS (throw + struggle), indexed by Role ---------------------
/**
 * Roles per docs/02. Stored as a small const object (strip-only friendly). A body
 * does not yet carry a role field in WorldState, so the verb layer accepts an
 * optional role map; absent => Runner (1.0 baseline). Kept here so the numbers
 * live with the rest of the tuning.
 */
export const Role = {
  Runner: 0,
  Bulwark: 1,
  Mender: 2,
  Engineer: 3,
  Breaker: 4,
  Anchor: 5,
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Thrower strength by role (throw impulse multiplier). */
export const THROW_STRENGTH: readonly Fixed[] = [
  fromFloatConst(1.0), // Runner
  fromFloatConst(1.6), // Bulwark
  fromFloatConst(0.9), // Mender
  fromFloatConst(1.0), // Engineer
  fromFloatConst(1.3), // Breaker
  fromFloatConst(1.1), // Anchor
];

/** Struggler strength by role (struggle press multiplier). */
export const STRUGGLE_STRENGTH: readonly Fixed[] = [
  fromFloatConst(1.0), // Runner
  fromFloatConst(1.4), // Bulwark
  fromFloatConst(0.9), // Mender
  fromFloatConst(1.0), // Engineer
  fromFloatConst(1.2), // Breaker
  fromFloatConst(1.8), // Anchor — slippery, breaks fast
];

// ---- ENCUMBRANCE (pressure c): carry-speed multiplier by CARRIED tier --------
/** Carrier move/rush speed multiplier while carrying a body of this MassClass. */
export const CARRY_SPEED_MUL: readonly Fixed[] = [
  fromFloatConst(0.92), // carrying a Light
  fromFloatConst(0.78), // carrying a Player
  fromFloatConst(0.70), // carrying a Heavy
  fromFloatConst(0.45), // carrying the Anchor — sharply slowed
];

// Keep MassClass referenced for readers importing from one place.
void MassClass;
