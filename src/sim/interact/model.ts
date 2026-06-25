// ============================================================================
// src/sim/interact/model.ts — the INTERACTION + INVENTORY vocabulary.
// ============================================================================
//
// Small const-object "enums" (strip-only friendly — no TS `enum`, same discipline
// as state.ts / input.ts) shared by the sim interact system, the wire, and the
// render HUD. They are part of the deterministic state vocabulary:
//   - ItemKind      : what sits in a hotbar slot (0 = empty).
//   - InteractAction: a bitfield of the actions the current target offers, written
//                     into WorldState.targetActions each tick so the HUD is a pure
//                     reader and every peer agrees on the available prompts.
//
// Nothing here is a float. These are folded into the hash via the WorldState Int32
// fields (inv0..inv4, selSlot, targetEntity, targetActions); see state.ts.
// ============================================================================

/**
 * What occupies a hotbar slot. A compact small int so it folds into the per-slot
 * Int32 hash field. 0 = Empty (the slot default). Pickups map their kind from the
 * picked body (for now everything loose maps to Generic; bottle/key/coin are reserved
 * for when authored props carry a kind tag — docs/11 §7.3).
 */
export const ItemKind = {
  Empty: 0,
  Generic: 1, // a generic loose prop / breakable drop
  Bottle: 2,
  Key: 3,
  Coin: 4,
} as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

/**
 * The contextual actions a target can offer this tick, as a bitfield in
 * WorldState.targetActions. The HUD shows a PRIMARY hint for the first primary-tier
 * action present and a SECONDARY hint for the first secondary-tier action present
 * (docs/11 §3). Append-only (the value is part of the hash + the HUD contract).
 */
export const InteractAction = {
  None: 0,
  /** PRIMARY: pick a loose item up into the hotbar. */
  Pickup: 1 << 0,
  /** PRIMARY: grab a body → carry (routes to the existing grab verb). */
  Grab: 1 << 1,
  /** PRIMARY/SECONDARY: open a container/door (DEFERRED door hook, docs/11 §3.4). */
  Open: 1 << 2,
  /** PRIMARY: place / use the active hotbar item. */
  PlaceUse: 1 << 3,
  /** SECONDARY: throw the active hotbar item. */
  ThrowItem: 1 << 4,
  /** PRIMARY: drop the carried body (routes to the existing grab-release/drop). */
  DropBody: 1 << 5,
  /** SECONDARY: throw the carried body (routes to the existing charged-throw). */
  ThrowBody: 1 << 6,
} as const;
export type InteractAction = (typeof InteractAction)[keyof typeof InteractAction];
