// ============================================================================
// src/sim/hazards/falldamage.ts — deterministic fall-damage helper.
// ============================================================================
//
// WHY SEPARATE FROM A HAZARD STRUCT: fall damage is driven by a body's own
// landing velocity, not by an authored zone. A body landing with downward speed
// beyond a threshold takes damage scaled by how far past the threshold it was.
//
// THE ANCHOR IS FALL-DURABLE (docs/02 "FALLS"): it is never instakilled here —
// instead it takes LESSER damage and gets a brief Downed beat (BodyFlag.Downed),
// the "altitude loss + a brief Downed beat" the spec calls for. This function
// NEVER hard-kills; it only writes health (raw Fixed) and may set Downed +
// schedule the Downed countdown in the per-body w.timer slot (ticks, hashed, so
// it survives save/restore). Death/cleanup policy lives in the integrator.
//
// DETERMINISM: pure Fixed math. The caller supplies the impact speed (the
// integrator already holds the pre-ground-resolve downward velocity at the
// landing tick), so we need NO extra WorldState array to remember it.
// ============================================================================

import { type WorldState, BodyFlag, MassClass, hasFlag, setFlag } from '../world/state.ts';
import {
  type Fixed, fromFloatConst, fromRaw, toRaw, sub, mul, lte,
} from '../fixed/fixed.ts';

/** Downward speed (positive magnitude) below which landing is harmless (u/s). */
export const FALL_SAFE_SPEED: Fixed = fromFloatConst(8.0);
/** Damage per (u/s) of impact speed past the safe threshold. */
export const FALL_DAMAGE_PER_SPEED: Fixed = fromFloatConst(9.0);
/** Anchor takes this fraction of the computed damage (fall-durable). */
export const ANCHOR_FALL_FACTOR: Fixed = fromFloatConst(0.25);
/** Ticks of Downed applied to the Anchor on a hard landing. */
export const ANCHOR_DOWNED_TICKS = 24;

/**
 * Apply fall damage to body `id` given the downward IMPACT SPEED at landing (a
 * positive Fixed magnitude = -vy at the moment of contact). Returns the damage
 * dealt (Fixed) for testing/telemetry. No-op below the safe speed.
 *
 * Player: full scaled damage, no auto-Downed.
 * Anchor (by class OR BodyFlag.Anchor): lesser damage + Downed beat, never an
 *   instakill (we don't zero/negate health to a kill here — just subtract the
 *   reduced amount; integrator clamps/decides death).
 */
export function applyFallDamage(
  w: WorldState,
  id: number,
  impactSpeed: Fixed,
): Fixed {
  if (!hasFlag(w, id, BodyFlag.Alive)) return fromRaw(0);
  if (lte(impactSpeed, FALL_SAFE_SPEED)) return fromRaw(0);

  const excess = sub(impactSpeed, FALL_SAFE_SPEED);
  let dmg: Fixed = mul(excess, FALL_DAMAGE_PER_SPEED);

  const isAnchor =
    w.massClass[id] === MassClass.Anchor || hasFlag(w, id, BodyFlag.Anchor);
  if (isAnchor) {
    // Fall-durable: lesser damage + a brief Downed beat instead of instakill.
    dmg = mul(dmg, ANCHOR_FALL_FACTOR);
    setFlag(w, id, BodyFlag.Downed);
    // Reuse the per-body timer slot for the Downed countdown (ticks, hashed).
    if (w.timer[id]! < ANCHOR_DOWNED_TICKS) w.timer[id] = ANCHOR_DOWNED_TICKS;
  }

  w.health[id] = toRaw(sub(fromRaw(w.health[id]!), dmg));
  return dmg;
}
