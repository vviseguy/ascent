// ============================================================================
// src/sim/interact/index.ts — public surface of the interaction + inventory system.
// ============================================================================
//
// The contextual-interaction + 5-slot hotbar scheme (docs/12). One deterministic,
// rollback-safe sim system; the integrator wires applyInteract into sim.ts as
// SYSTEM 6.6 (after verbs/breakables, before fall-damage). See interact.ts.
// ============================================================================

export { applyInteract } from './interact.ts';
export { ItemKind, InteractAction } from './model.ts';
export {
  INTERACT_SPOT_REACH, INTERACT_RANGE, INTERACT_HALF_ANGLE,
  ITEM_THROW_SPEED, ITEM_THROW_LOFT,
} from './config.ts';
