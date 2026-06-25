// ============================================================================
// src/sim/breakable/index.ts — public surface of the BREAKABLE (destructible) system.
// ============================================================================
//
// Destructible props (crates / pots / barrels) + the item drops they spawn are a
// single deterministic, rollback-safe sim system. The integrator wires
// applyBreakables into sim.ts as SYSTEM 6.5 (after verbs, before fall-damage); see
// break.ts for the rationale.
// ============================================================================

export { applyBreakables } from './break.ts';
export {
  BREAKABLE_INTEGRITY,
  SHOVE_DAMAGE, RUSH_DAMAGE,
  THROW_IMPACT_SPEED, THROW_IMPACT_SCALE, THROW_IMPACT_MAX, CONTACT_SLOP,
  DROP_MIN, DROP_MAX, DROP_RADIUS, DROP_HALF_HEIGHT,
  DROP_SCATTER_SPEED, DROP_POP_UP, DROP_SPAWN_LIFT,
} from './config.ts';
