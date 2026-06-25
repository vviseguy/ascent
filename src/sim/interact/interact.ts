// ============================================================================
// src/sim/interact/interact.ts — the CONTEXTUAL INTERACTION + INVENTORY system.
// ============================================================================
//
// applyInteract(w, inputs, index, tick) is ONE deterministic sim system (docs/12)
// that, per player, each tick:
//   1. applies the selected-slot change (the wire `slot` field),
//   2. computes the interaction SPOT in front of the player + picks the single best
//      interactable (loose item / grabbable body / future container), writing
//      targetEntity + targetActions into WorldState (hashed → rollback-safe + a pure
//      HUD read), and
//   3. resolves the PRIMARY / SECONDARY press-edges into ITEM actions (pickup / place
//      / use / throw-item) and the DEFERRED Open hook.
//
// SCOPE BOUNDARY (intentional): BODY grab/carry/throw stays in the verb layer
// (src/sim/verbs). The IO layer maps a contextual body action onto the existing
// Grab/Throw button bits, so the proven verb code is the single owner of carrying.
// This system only reports that a body action is AVAILABLE (targetActions) and owns
// the ITEM + Open paths. That keeps zero duplication of the carry state machine.
//
// DETERMINISM: integer + Fixed math only, ascending-id sweeps only, press-edges read
// against the SAME prevButtons the verbs use (committed at end of tick by the sim).
// All persisted state lives in WorldState (inv0..inv4, selSlot, targetEntity,
// targetActions) so it is hashed + survives save/restore. No Date / random / float.
//
// WHERE IT SLOTS INTO sim.ts (SYSTEM 6.6): AFTER applyVerbs + applyBreakables (grab
// linkage + drops settled) and BEFORE fall-damage / the game layer. It reuses the
// same per-tick spatial index (positions are final post-collision; it only queries).
// ============================================================================

import {
  type Fixed,
  add, sub, mul, div, sqrt, sin, cos, abs, gt, gte, lt, lte, ZERO, fromRaw, toRaw, fromInt,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, MassClass, NO_ENTITY,
  hasFlag, spawnBody,
} from '../world/state.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT, NUM_SLOTS } from '../world/input.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import { ItemKind, InteractAction } from './model.ts';
import {
  INTERACT_SPOT_REACH, INTERACT_RANGE, INTERACT_HALF_ANGLE,
  ITEM_THROW_SPEED, ITEM_THROW_LOFT, ITEM_BODY_RADIUS, ITEM_BODY_HALF_HEIGHT, ITEM_DROP_OFFSET,
} from './config.ts';

/** Module-private scratch reused by radius queries (cleared each use; not state). */
const scratch: number[] = [];

const inputOf = (inputs: ReadonlyArray<PlayerInput | undefined>, id: number): PlayerInput =>
  inputs[id] ?? NEUTRAL_INPUT;

const isPlayerLike = (w: WorldState, i: number): boolean =>
  hasFlag(w, i, BodyFlag.Player) || hasFlag(w, i, BodyFlag.Anchor);

/** The five inventory slot field names, indexed 0..4 (the per-slot Int32 arrays). */
const SLOT_FIELDS = ['inv0', 'inv1', 'inv2', 'inv3', 'inv4'] as const;
/** The five KEY-DOOR aux field names (parallel to SLOT_FIELDS): the door a Key in slot s opens. */
const SLOT_DOOR_FIELDS = ['slotDoor0', 'slotDoor1', 'slotDoor2', 'slotDoor3', 'slotDoor4'] as const;

/** Read inventory slot `s` of body `i` (an ItemKind). */
function getSlot(w: WorldState, i: number, s: number): number {
  return (w[SLOT_FIELDS[s]!] as Int32Array)[i]!;
}
/** Write inventory slot `s` of body `i` to ItemKind `kind`. */
function setSlot(w: WorldState, i: number, s: number, kind: number): void {
  (w[SLOT_FIELDS[s]!] as Int32Array)[i] = kind;
}
/** Read the door id a Key in slot `s` of body `i` opens (-1 if the slot isn't a key). */
function getSlotDoor(w: WorldState, i: number, s: number): number {
  return (w[SLOT_DOOR_FIELDS[s]!] as Int32Array)[i]!;
}
/** Write the door id a Key in slot `s` of body `i` opens (-1 to clear). */
function setSlotDoor(w: WorldState, i: number, s: number, door: number): void {
  (w[SLOT_DOOR_FIELDS[s]!] as Int32Array)[i] = door;
}

/**
 * The interaction system. Mutates and returns `w`. `inputs[id]` is body id's input
 * this tick (undefined => neutral). `index` MUST be rebuilt for the current tick.
 */
export function applyInteract(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  index: SpatialIndex,
  tick: number,
): WorldState {
  const count = w.count;

  // ---- A. selected-slot change (the wire `slot` LEVEL field) ---------------
  // Apply first so a same-tick PRIMARY/SECONDARY acts on the freshly-selected slot.
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const s = inputOf(inputs, i).slot;
    if (s >= 0 && s < NUM_SLOTS) w.selSlot[i] = s;
  }

  // ---- B. targeting: pick the best interactable + available actions --------
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) {
      w.targetEntity[i] = NO_ENTITY;
      w.targetActions[i] = 0;
      continue;
    }
    computeTarget(w, index, i);
  }

  // ---- C. resolve PRIMARY / SECONDARY press-edges into ITEM + Open actions --
  for (let i = 0; i < count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    if (!isPlayerLike(w, i)) continue;
    const inp = inputOf(inputs, i);
    const primaryEdge = edge(w, inp, Button.Primary, i);
    const secondaryEdge = edge(w, inp, Button.Secondary, i);
    if (!primaryEdge && !secondaryEdge) continue;

    const actions = w.targetActions[i]!;
    const target = w.targetEntity[i]!;
    const holdingItem = activeItem(w, i) !== ItemKind.Empty;

    if (primaryEdge) {
      // PRIMARY priority: OPEN a puzzle entity · place/use a held item · pick up a loose
      // item. Open is FIRST so "use the key on the door" (you're holding the key AND
      // facing its door) opens it rather than placing the key on the floor — the Open
      // action only lights up for a door when i holds the matching key (isOpenable), or
      // for an un-searched rug. (Body grab/drop is owned by the verb layer.)
      if ((actions & InteractAction.Open) !== 0 && target !== NO_ENTITY) {
        resolveOpen(w, i, target, tick);
      } else if (holdingItem && (actions & InteractAction.PlaceUse) !== 0) {
        placeActiveItem(w, i, tick);
      } else if (!holdingItem && (actions & InteractAction.Pickup) !== 0 && target !== NO_ENTITY) {
        pickUp(w, i, target);
      }
    }

    if (secondaryEdge) {
      // SECONDARY priority: throw a held item · open. (Body throw is the verb layer's
      // charged Grab-release; not resolved here.)
      if (holdingItem && (actions & InteractAction.ThrowItem) !== 0) {
        throwActiveItem(w, i, tick);
      } else if ((actions & InteractAction.Open) !== 0 && target !== NO_ENTITY) {
        resolveOpen(w, i, target, tick);
      }
    }
  }

  return w;
}

// ============================================================================
// TARGETING
// ============================================================================

/**
 * Pick body i's contextual target + write targetEntity/targetActions. The "spot" is a
 * fixed reach in front of `facing`; among in-range, in-cone interactables we choose the
 * one whose CENTER is nearest the spot, by a fixed kind priority then ascending id on
 * ties (deterministic). Available actions are derived from what i holds/carries and the
 * target's kind.
 */
function computeTarget(w: WorldState, index: SpatialIndex, i: number): void {
  const f = fromRaw(w.facing[i]!);
  const px = fromRaw(w.px[i]!);
  const pz = fromRaw(w.pz[i]!);
  // the interaction spot, a reach in front along facing
  const spotX = add(px, mul(INTERACT_SPOT_REACH, cos(f)));
  const spotZ = add(pz, mul(INTERACT_SPOT_REACH, sin(f)));

  const queryR = toRaw(add(fromRaw(w.radius[i]!), INTERACT_RANGE));
  index.queryRadius(w.px[i]!, w.pz[i]!, queryR, scratch);

  let best = NO_ENTITY;
  let bestTier = 99;
  let bestDistSq: Fixed = ZERO;
  for (const t of scratch) {
    if (t === i) continue;
    if (!hasFlag(w, t, BodyFlag.Alive)) continue;
    const tier = interactTier(w, i, t);
    if (tier < 0) continue; // not interactable
    if (!inInteractCone(w, i, t)) continue;
    // distance from the target center to the interaction spot (closer = better)
    const dx = sub(fromRaw(w.px[t]!), spotX);
    const dz = sub(fromRaw(w.pz[t]!), spotZ);
    const dsq = add(mul(dx, dx), mul(dz, dz));
    if (tier < bestTier || (tier === bestTier && (best === NO_ENTITY || lt(dsq, bestDistSq) || (eqF(dsq, bestDistSq) && t < best)))) {
      best = t;
      bestTier = tier;
      bestDistSq = dsq;
    }
  }

  w.targetEntity[i] = best;
  w.targetActions[i] = availableActions(w, i, best);
}

/**
 * Interaction tier for target t from i's perspective (lower = higher priority), or -1
 * if t is not an interactable. Loose items rank above grabbable bodies so a pickup in a
 * cluttered scene is preferred (you can always face a body to carry it).
 *   0 loose pickup item   1 grabbable body / Anchor / throwable
 *   2 openable puzzle entity (locked door / rug)   (-1 = not interactable)
 */
function interactTier(w: WorldState, i: number, t: number): number {
  if (hasFlag(w, t, BodyFlag.Pickup)) return 0; // a loose item drop
  // a grabbable body: another player / Anchor, or a (non-pickup) throwable world object
  if (hasFlag(w, t, BodyFlag.Player) || hasFlag(w, t, BodyFlag.Anchor)) {
    if (w.grabbedBy[t] !== NO_ENTITY) return -1; // already held by someone
    return 1;
  }
  if (hasFlag(w, t, BodyFlag.Throwable)) {
    if (w.grabbedBy[t] !== NO_ENTITY) return -1;
    return 1;
  }
  // a locked door (needs the matching key in hand) or an un-searched rug → openable.
  if (isOpenable(w, i, t)) return 2;
  return -1;
}

/** Available InteractAction bitfield for body i facing target `best` (NO_ENTITY ok). */
function availableActions(w: WorldState, i: number, best: number): number {
  let a = 0;
  const carryingBody = w.holding[i]! !== NO_ENTITY;
  const holdingItem = activeItem(w, i) !== ItemKind.Empty;

  if (carryingBody) {
    // hands occupied by a carried body → the contextual buttons are drop / throw-body
    // (the verb layer performs them off Grab/Throw; we only advertise the prompt).
    a |= InteractAction.DropBody | InteractAction.ThrowBody;
    return a;
  }

  if (holdingItem) {
    // an item is in hand → place/use (primary) + throw-item (secondary), always available
    a |= InteractAction.PlaceUse | InteractAction.ThrowItem;
  }

  if (best !== NO_ENTITY) {
    const tier = interactTier(w, i, best);
    if (tier === 0 && !holdingItem && hasOpenSlot(w, i)) {
      a |= InteractAction.Pickup; // pick the loose item up (needs a free hand + slot)
    } else if (tier === 1) {
      a |= InteractAction.Grab; // a body to carry (verb layer performs it)
    }
    // Door/rug Open hook (docs/14 §2): lights up for a locked door whose key i holds, or
    // an un-searched rug. isOpenable encapsulates the key-in-hand check for doors.
    if (isOpenable(w, i, best)) a |= InteractAction.Open;
  }
  return a;
}

/**
 * Is target t inside i's frontal interaction cone (reach + half-angle)? Ground-plane
 * (x,z); vertical is ignored (pickups sit at varying heights). Mirrors the verb cone.
 */
function inInteractCone(w: WorldState, i: number, t: number): boolean {
  const dx = sub(fromRaw(w.px[t]!), fromRaw(w.px[i]!));
  const dz = sub(fromRaw(w.pz[t]!), fromRaw(w.pz[i]!));
  const dist = sqrt(add(mul(dx, dx), mul(dz, dz)));
  const reach = add(add(fromRaw(w.radius[i]!), fromRaw(w.radius[t]!)), INTERACT_RANGE);
  if (gt(dist, reach)) return false;
  if (lte(dist, ZERO)) return true; // coincident in plan → in cone
  const f = fromRaw(w.facing[i]!);
  const dot = add(mul(cos(f), div(dx, dist)), mul(sin(f), div(dz, dist)));
  return gte(dot, cos(INTERACT_HALF_ANGLE));
}

// ============================================================================
// INVENTORY + ITEM ACTIONS
// ============================================================================

/** ItemKind currently "in hand" (the selected slot's contents) for body i. */
function activeItem(w: WorldState, i: number): number {
  return getSlot(w, i, w.selSlot[i]!);
}

/** Does body i have at least one empty hotbar slot? */
function hasOpenSlot(w: WorldState, i: number): boolean {
  for (let s = 0; s < NUM_SLOTS; s++) if (getSlot(w, i, s) === ItemKind.Empty) return true;
  return false;
}

/** First empty slot index for body i, preferring the SELECTED slot if it is empty. */
function firstOpenSlot(w: WorldState, i: number): number {
  const sel = w.selSlot[i]!;
  if (getSlot(w, i, sel) === ItemKind.Empty) return sel;
  for (let s = 0; s < NUM_SLOTS; s++) if (getSlot(w, i, s) === ItemKind.Empty) return s;
  return -1;
}

/**
 * Map a loose pickup BODY to the ItemKind it becomes in the hotbar. A KEY body (a
 * Pickup carrying a non-negative `doorId`, spawned by the compiler or revealed by a
 * rug — docs/14 §2) becomes ItemKind.Key so it can open its matching door; everything
 * else is Generic (breakable drops carry no kind tag).
 */
function itemKindOf(w: WorldState, t: number): number {
  if (w.doorId[t]! >= 0) return ItemKind.Key;
  return ItemKind.Generic;
}

/** PRIMARY pickup: move loose item body `t` into i's first open slot + remove the body. */
function pickUp(w: WorldState, i: number, t: number): void {
  const slot = firstOpenSlot(w, i);
  if (slot < 0) return; // no room (shouldn't happen — Pickup action gated on hasOpenSlot)
  const kind = itemKindOf(w, t);
  setSlot(w, i, slot, kind);
  // a KEY carries which door it opens — bind it to the slot so it survives the body's
  // consumption (the door binding lives in the hashed slotDoorN field, docs/14 §2).
  setSlotDoor(w, i, slot, kind === ItemKind.Key ? w.doorId[t]! : -1);
  w.selSlot[i] = slot; // the freshly-picked item becomes "in hand"
  // consume the world body (the item now lives in the hotbar, not the world).
  killItemBody(w, t);
}

/** PRIMARY place/use: drop the active item back into the world as a free body, in front. */
function placeActiveItem(w: WorldState, i: number, tick: number): void {
  void tick;
  const kind = activeItem(w, i);
  if (kind === ItemKind.Empty) return;
  const sel = w.selSlot[i]!;
  const door = kind === ItemKind.Key ? getSlotDoor(w, i, sel) : -1;
  const id = spawnItemBody(w, i, kind, door);
  if (id < 0) return; // world full — keep it in the hotbar rather than vanish it
  // it rests in front (no launch velocity for a placement).
  setSlot(w, i, sel, ItemKind.Empty);
  setSlotDoor(w, i, sel, -1);
}

/** SECONDARY throw-item: launch the active item as a free body along facing, lofted. */
function throwActiveItem(w: WorldState, i: number, tick: number): void {
  void tick;
  const kind = activeItem(w, i);
  if (kind === ItemKind.Empty) return;
  const sel = w.selSlot[i]!;
  const door = kind === ItemKind.Key ? getSlotDoor(w, i, sel) : -1;
  const id = spawnItemBody(w, i, kind, door);
  if (id < 0) return;
  const f = fromRaw(w.facing[i]!);
  w.vx[id] = toRaw(mul(ITEM_THROW_SPEED, cos(f)));
  w.vz[id] = toRaw(mul(ITEM_THROW_SPEED, sin(f)));
  w.vy[id] = toRaw(mul(ITEM_THROW_SPEED, ITEM_THROW_LOFT));
  setSlot(w, i, sel, ItemKind.Empty);
  setSlotDoor(w, i, sel, -1);
}

/**
 * Spawn a world body for a placed/thrown hotbar item, in front of carrier i. Returns the
 * new id, or -1 if the world is full. The body is a Throwable + Pickup Light body (so it
 * falls, can be re-grabbed, and re-picked-up via the same path) — symmetric with how
 * breakable drops spawn (src/sim/breakable).
 */
function spawnItemBody(w: WorldState, i: number, kind: number, door = -1): number {
  void kind;
  const f = fromRaw(w.facing[i]!);
  const off = add(fromRaw(w.radius[i]!), ITEM_DROP_OFFSET);
  const ox = add(fromRaw(w.px[i]!), mul(off, cos(f)));
  const oz = add(fromRaw(w.pz[i]!), mul(off, sin(f)));
  const oy = add(fromRaw(w.py[i]!), ITEM_BODY_HALF_HEIGHT);
  let id = -1;
  try {
    id = spawnBody(w, {
      px: ox, py: oy, pz: oz,
      radius: ITEM_BODY_RADIUS, halfHeight: ITEM_BODY_HALF_HEIGHT,
      massClass: MassClass.Light,
      flags: BodyFlag.Throwable | BodyFlag.Pickup,
      health: fromInt(1),
      // a placed/thrown KEY re-spawns carrying its door binding (door >= 0); other
      // items carry -1 (no puzzle), so itemKindOf still reads them back correctly.
      doorId: door,
    });
  } catch {
    return -1; // world capacity exceeded — never throw on the sim hot path
  }
  return id;
}

/** Remove a picked-up loose item body from the world (clears its slot). */
function killItemBody(w: WorldState, t: number): void {
  // mirror killBody's clearing without importing it twice; flags=0 frees the slot.
  w.flags[t] = 0;
  w.grabbedBy[t] = NO_ENTITY;
  w.holding[t] = NO_ENTITY;
}

// ============================================================================
// DOORS / CONTAINERS — DEFERRED hook (docs/12 §3.4)
// ============================================================================

/**
 * Is target t an OPENABLE puzzle entity (docs/14 §2)? Two cases:
 *  - a LOCKED DOOR body (BodyFlag.Door, lockState 1) — the Open prompt lights up only
 *    when player i is HOLDING the matching key (so the prompt is honest: pressing it
 *    will actually open + consume the key). An open door (lockState 0) is no longer a
 *    target (it has been killed on unlock; this guards a same-tick race).
 *  - a RUG body (BodyFlag.Rug) whose hidden key has not yet been revealed — Open
 *    "searches" it (no key needed to interact).
 * Anything else is not openable (returns false), exactly as before.
 */
function isOpenable(w: WorldState, i: number, t: number): boolean {
  if (hasFlag(w, t, BodyFlag.Door)) {
    return w.lockState[t]! === 1 && playerHasKeyFor(w, i, w.doorId[t]!);
  }
  if (hasFlag(w, t, BodyFlag.Rug)) {
    return w.rugRevealed[t]! === 0;
  }
  return false;
}

/** Does player i hold a Key in any hotbar slot whose bound door equals `door`? */
function playerHasKeyFor(w: WorldState, i: number, door: number): boolean {
  if (door < 0) return false;
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (getSlot(w, i, s) === ItemKind.Key && getSlotDoor(w, i, s) === door) return true;
  }
  return false;
}

/** Slot index of the first matching key for `door` in i's hotbar, or -1. */
function keySlotFor(w: WorldState, i: number, door: number): number {
  if (door < 0) return -1;
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (getSlot(w, i, s) === ItemKind.Key && getSlotDoor(w, i, s) === door) return s;
  }
  return -1;
}

/**
 * Resolve an Open press on a puzzle entity (docs/14 §2). Deterministic, hashed:
 *  - DOOR: consume the matching key from i's hotbar (slot → Empty, slotDoor → -1) and
 *    UNLOCK the door — lockState → 0 and the door body is killed, removing its solid
 *    plug so the doorway becomes passable. Gated by isOpenable (only fires when i holds
 *    the key), so this can't open a door for free.
 *  - RUG: REVEAL the hidden key once — spawn a Key Pickup body (carrying the rug's
 *    doorId) just off the rug, then latch rugRevealed → 1 so it never re-spawns.
 */
function resolveOpen(w: WorldState, i: number, t: number, tick: number): void {
  void tick;
  if (hasFlag(w, t, BodyFlag.Door)) {
    if (w.lockState[t]! !== 1) return; // already open (race guard)
    const slot = keySlotFor(w, i, w.doorId[t]!);
    if (slot < 0) return; // no matching key — isOpenable should have prevented this
    setSlot(w, i, slot, ItemKind.Empty); // CONSUME the key
    setSlotDoor(w, i, slot, -1);
    w.lockState[t] = 0; // unlock (hashed)
    // remove the door's solid plug so the doorway opens. Killing clears its flags so it
    // no longer blocks; the verifier already proved the key was reachable.
    w.flags[t] = 0;
    w.grabbedBy[t] = NO_ENTITY;
    w.holding[t] = NO_ENTITY;
    return;
  }
  if (hasFlag(w, t, BodyFlag.Rug)) {
    if (w.rugRevealed[t]! !== 0) return; // one-shot
    revealRugKey(w, t);
    w.rugRevealed[t] = 1;
  }
}

/**
 * Spawn the KEY a rug hides (docs/14 §2 "rug → mat → key reveal"). The key Pickup body
 * appears just above the rug's tile carrying the rug's doorId, so the existing pickup
 * path (itemKindOf → ItemKind.Key) folds it into the hotbar. Deterministic position
 * (the rug's own location); no random. If the world is full the reveal is a no-op (the
 * rug stays un-revealed-effectively, but rugRevealed latches so we don't spin — the
 * verifier treats the rug-key as obtainable once the rug cell is reachable regardless).
 */
function revealRugKey(w: WorldState, t: number): void {
  const door = w.doorId[t]!;
  if (door < 0) return;
  try {
    spawnBody(w, {
      px: fromRaw(w.px[t]!),
      py: add(fromRaw(w.py[t]!), add(fromRaw(w.halfHeight[t]!), ITEM_BODY_HALF_HEIGHT)),
      pz: fromRaw(w.pz[t]!),
      radius: ITEM_BODY_RADIUS, halfHeight: ITEM_BODY_HALF_HEIGHT,
      massClass: MassClass.Light,
      flags: BodyFlag.Throwable | BodyFlag.Pickup,
      health: fromInt(1),
      doorId: door,
    });
  } catch {
    // world full — never throw on the sim hot path; the rug latches revealed anyway.
  }
}

// ============================================================================
// shared helpers
// ============================================================================

/**
 * Press EDGE detector: true iff button b is down this tick and was UP last tick (per the
 * body's stored prevButtons). Same discipline as the verb layer's edge() so the interact
 * presses fire once and stay rollback-consistent (prevButtons committed at end of tick).
 */
function edge(w: WorldState, inp: PlayerInput, b: number, i: number): boolean {
  const now = (inp.buttons & b) !== 0;
  const prev = (w.prevButtons[i]! & b) !== 0;
  return now && !prev;
}

/** Fixed equality (no dedicated eq in fixed.ts; cheap inline). */
function eqF(a: Fixed, b: Fixed): boolean {
  return !lt(a, b) && !gt(a, b);
}

// keep abs referenced (reserved for future vertical gating of pickups)
void abs;
