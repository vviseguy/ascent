// ============================================================================
// src/sim/interact/config.ts — tuning for the contextual-interaction system.
// ============================================================================
//
// Authoring constants (converted to Fixed ONCE here, never from float at runtime).
// All consumed by interact.ts. Mirrors the verb config discipline.
// ============================================================================

import { type Fixed, fromFloatConst } from '../fixed/fixed.ts';

/**
 * How far IN FRONT of the player (along facing) the interaction "spot" sits (u). The
 * targeting system picks the interactable nearest this spot within reach + a frontal
 * cone (docs/11 §3.1). ~1.4u reads as "arm's reach" for pickups/chests.
 */
export const INTERACT_SPOT_REACH: Fixed = fromFloatConst(1.4);

/**
 * Max ground-plane distance from the player CENTER an interactable may be and still be
 * a candidate (u). Larger than the spot reach so a slightly off-angle item still
 * qualifies; the cone + spot-distance ranking does the precise pick.
 */
export const INTERACT_RANGE: Fixed = fromFloatConst(2.4);

/**
 * Half-angle of the frontal interaction cone (radians). An item outside this cone of
 * `facing` is never targeted, so you interact with what you face (docs/11 §3.1). 75°.
 */
export const INTERACT_HALF_ANGLE: Fixed = fromFloatConst((75 * Math.PI) / 180);

/**
 * Launch speed of a thrown HOTBAR ITEM (u/s) along facing, lofted. Items are light, so
 * this is a brisk underhand toss — distinct from the mass-scaled body THROW (verbs).
 */
export const ITEM_THROW_SPEED: Fixed = fromFloatConst(9);
/** Upward component fraction of an item throw (gives it a short arc). */
export const ITEM_THROW_LOFT: Fixed = fromFloatConst(0.45);

/** Radius / half-height of a re-spawned (placed or thrown) hotbar item body (u). */
export const ITEM_BODY_RADIUS: Fixed = fromFloatConst(0.28);
export const ITEM_BODY_HALF_HEIGHT: Fixed = fromFloatConst(0.28);
/** Forward offset where a placed/thrown item body appears, beyond the player radius (u). */
export const ITEM_DROP_OFFSET: Fixed = fromFloatConst(0.9);
