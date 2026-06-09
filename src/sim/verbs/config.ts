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

// ---- JUMP ------------------------------------------------------------------
/** Base jump launch speed (u/s) for a Player on the press-edge while grounded. */
export const JUMP_SPEED: Fixed = fromFloatConst(9.0);
/**
 * Per-MassClass jump-speed multiplier. The Anchor jumps LOWER (its "gap-locked"
 * defining constraint, docs/02 §2.1) so it cannot self-clear a real chasm — the
 * crew must carry/throw it across. Index by MassClass (Light/Player/Heavy/Anchor).
 */
export const JUMP_MUL: readonly Fixed[] = [
  fromFloatConst(1.0), // Light (objects don't self-jump; unused)
  fromFloatConst(1.0), // Player
  fromFloatConst(0.85), // Heavy
  fromFloatConst(0.62), // Anchor — deliberately weak (gap-lock)
];

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
/**
 * CATCH fast-latch (docs/02 §5.3/§5.4): catching an AIRBORNE / falling / thrown body
 * uses a SHORT fixed latch (the body is already in your cone — an "alley-oop") instead
 * of the mass-scaled GRAB_LATCH_TICKS. ~7 ticks regardless of target mass.
 */
export const CATCH_LATCH_TICKS = 7;
/**
 * Downward vy threshold (u/s, magnitude) above which a target counts as a CATCHABLE
 * faller (significant descent). At/below this it's treated as a normal grab.
 */
export const CATCH_FALL_VY: Fixed = fromFloatConst(3.0);
/**
 * Extra VERTICAL reach (u) the grab cone considers for a catch: a faller passing
 * above/below the catcher's plane is still in-cone if |Δy| ≤ catcher.halfHeight +
 * target.halfHeight + this. (Plain horizontal grabs use the in-plane reach only.)
 */
export const CATCH_VERTICAL_REACH: Fixed = fromFloatConst(2.0);
/**
 * TRAIN length cap (docs/02 §4.4): the longest chain of held-of-held bodies. A train
 * of carriers can stack to this many bodies (e.g. B holds A holds Anchor = 3); a grab
 * that would exceed it is refused. Trains are powerful but glacial — bounded for sanity.
 */
export const MAX_TRAIN_LEN = 3;

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
/**
 * AIM-SPOIL (docs/02 §4.2): a struggling held player wriggles the carrier's throw aim
 * by ±(struggle intensity × this) radians (8°). Intensity is the held body's current
 * struggle progress fraction toward its break threshold.
 */
export const THROW_AIM_SPOIL_RANGE: Fixed = fromFloatConst((8 * Math.PI) / 180);
/**
 * CHARGE-BLEED (docs/02 §4.2): a struggling held player bleeds the carrier's throw
 * charge by ~0.02·THROW_CHARGE_TICKS per tick. Stored as a per-tick decrement in
 * charge-ticks (rounded so it stays integer/deterministic — see verbs.ts).
 */
export const THROW_CHARGE_BLEED_PER_TICK: Fixed = fromFloatConst(0.02 * THROW_CHARGE_TICKS);
/**
 * CHARGE-BLEED cap (docs/02 §4.2): a fully-struggling victim caps the carrier's
 * EFFECTIVE charge near ~0.6 — the bleed cannot pull stored charge below this many
 * ticks once it has reached the cap (so a contested throw still fires, just weak).
 */
export const THROW_CHARGE_BLEED_FLOOR_TICKS = Math.round(0.6 * THROW_CHARGE_TICKS);

// -- held-player chip (docs/02 §4.2) --
/** A held player deals 1 HP to the carrier every HELD_CHIP_PERIOD ticks (cost to hold). */
export const HELD_CHIP_PERIOD = 12;
/** HP dealt per chip tick (Fixed). */
export const HELD_CHIP_DAMAGE: Fixed = fromInt(1);

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

// -- mash ramp + anti-bot jitter (docs/02 §4.2) --
/**
 * FRIENDLY-carry break threshold (docs/02 §5.1): when carrier and held are the SAME
 * crew, the held ally can STRUGGLE out almost instantly ("let me down now") — a much
 * lower break threshold than the adversarial STRUGGLE_BREAK (100). Read w.crewId in
 * struggleSystem to pick the threshold per hold.
 */
export const STRUGGLE_BREAK_FRIENDLY: Fixed = fromInt(30);
/**
 * Burst window (ticks): consecutive struggle presses within this gap RAMP the
 * per-press value; a larger gap resets the burst counter. Must be > the debounce so
 * a clean mash can chain. Per docs/02 §4.2 the ramp window is 6 ticks.
 */
export const STRUGGLE_BURST_WINDOW = 6;
/**
 * Mash-ramp per-burst coefficients (docs/02 §4.2): press n in a burst is worth
 * press × clamp(1 + STRUGGLE_RAMP_STEP·(n−1), 1, STRUGGLE_RAMP_MAX). Ramps to 1.8×
 * after ~7 presses, then caps.
 */
export const STRUGGLE_RAMP_STEP: Fixed = fromFloatConst(0.12);
export const STRUGGLE_RAMP_MIN: Fixed = fromFloatConst(1.0);
export const STRUGGLE_RAMP_MAX: Fixed = fromFloatConst(1.8);
/**
 * Anti-autoclicker seeded micro-jitter half-range (docs/02 §4.2): each valid press is
 * scaled by (1 + STRUGGLE_JITTER_RANGE·jitterUnit(tick, heldId, Struggle)) ∈ ±5%, so
 * perfect-bot timing isn't optimal. Deterministic (seeded), never wall-clock.
 */
export const STRUGGLE_JITTER_RANGE: Fixed = fromFloatConst(0.05);
/**
 * ENCUMBRANCE struggle/shove penalty (docs/02 §4.3): while hands-full you are
 * committed, so your OWN struggle and shove values are scaled by this (−20%).
 */
export const ENCUMBRANCE_VERB_MUL: Fixed = fromFloatConst(0.8);

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

// ---- ROLE ABILITIES (Button.Ability, docs/02 §6) ---------------------------
// All cooldowns/timers are integer TICKS (60 Hz). Reaches/impulses are Fixed.
// Numbers are first-pass tuning targets per docs/02 §6 (e.g. Unhand 9 s cd → 540
// ticks); chosen concrete + buildable, not sacred. abilities.ts reads only these.

// MENDER — Revive (docs/02 §6.3, §8.3): channel a few ticks to raise a downed ally.
/** Reach (u) at which a Mender can begin/continue a revive channel on a downed ally. */
export const REVIVE_REACH: Fixed = fromFloatConst(2.5);
/** Revive channel duration (ticks). Mender baseline (~0.5 s). */
export const REVIVE_CHANNEL_TICKS = 30;
/** Fraction of max health restored on a completed revive (raw Fixed in [0,1]). */
export const REVIVE_HEAL_FRAC: Fixed = fromFloatConst(0.5);
/** Brief stand-up immunity granted to the revived ally (ticks; cannot be re-grabbed). */
export const REVIVE_IMMUNITY_TICKS = 36;
/** Mender ability cooldown (ticks). */
export const REVIVE_CD_TICKS = 120;

// BULWARK — Unhand / body-block + brace (docs/02 §4.5, §6.2).
/** Reach (u) within which Unhand breaks a grab on a nearby ally. */
export const UNHAND_REACH: Fixed = fromFloatConst(3.5);
/** Bulwark brace window (ticks) — reduced incoming knockback after the ability. */
export const BRACE_TICKS = 48;
/** Knockback multiplier (Fixed) applied to a braced body's incoming rush pushback. */
export const BRACE_KNOCKBACK_MUL: Fixed = fromFloatConst(0.5);
/** Bulwark ability cooldown (ticks) — the emergency VIP-rescue button (~9 s). */
export const UNHAND_CD_TICKS = 540;

// ENGINEER — Bridge block (docs/02 §6.4): a one-shot temporary Heavy solid.
/** Distance (u) in front of the Engineer the bridge block spawns. */
export const BRIDGE_OFFSET: Fixed = fromFloatConst(1.6);
/** Bridge block half-extent (u) — radius/halfHeight of the spawned solid. */
export const BRIDGE_HALF: Fixed = fromFloatConst(0.6);
/** Bridge block lifetime (ticks) before it dissolves (~15 s). */
export const BRIDGE_LIFETIME_TICKS = 900;
/** Engineer ability cooldown (ticks). */
export const BRIDGE_CD_TICKS = 90;

// BREAKER — AoE shove (docs/02 §6.5; full destructible terrain is future).
/** Radius (u) of the Breaker's AoE shove. */
export const BREAK_SHOVE_RADIUS: Fixed = fromFloatConst(2.8);
/** Shove impulse (u/s-ish, applied as velocity) before 1/mass scaling. */
export const BREAK_SHOVE_J: Fixed = fromFloatConst(7.0);
/** Post-shove beat (ticks) — a brief flag on each shoved body. */
export const BREAK_SHOVE_BEAT_TICKS = 18;
/** Breaker ability cooldown (ticks). */
export const BREAK_CD_TICKS = 36;

// RUNNER — Scout ping/tag (docs/02 §6.1): mark nearest hazard / highest point.
/** Radius (u) the scout ping searches for a markable target. */
export const SCOUT_RADIUS: Fixed = fromFloatConst(40.0);
/** Runner ability cooldown (ticks) (~3 s). */
export const SCOUT_CD_TICKS = 180;

// Keep MassClass referenced for readers importing from one place.
void MassClass;
