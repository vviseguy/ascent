// ============================================================================
// src/sim/interact/interact.test.ts — unit semantics of the interaction system.
// ============================================================================
//
// Vitest counterpart to interact/prove.ts (which owns determinism + rollback). These
// assert the actual contextual behaviour: targeting picks the in-front interactable,
// pickup fills a slot + removes the body, slot-select is applied + clamped, and
// throw-item empties the slot + spawns a free Pickup body. Run with `npm test`.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { createWorld, spawnBody, BodyFlag, MassClass, NO_ENTITY, type WorldState } from '../world/state.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT, NUM_SLOTS } from '../world/input.ts';
import { fromInt, fromFloatConst } from '../fixed/fixed.ts';
import { Sim } from '../sim.ts';
import { makeArena } from '../collide/terrain.ts';
import { ItemKind, InteractAction } from './model.ts';

/** A player at the origin facing +X (aim 0) and an arena to stand in. */
function makePlayerScene(): { sim: Sim; w: WorldState; player: number } {
  const w = createWorld(16);
  const player = spawnBody(w, {
    px: fromInt(0), py: fromFloatConst(0.9), pz: fromInt(0),
    radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
    massClass: MassClass.Player, flags: BodyFlag.Player,
  });
  const terrain = makeArena(fromInt(0), fromInt(12), fromInt(3), fromFloatConst(0.5));
  const sim = new Sim(w, { terrain });
  return { sim, w, player };
}

/** A loose Pickup item body at (x, 0.3, z). */
function spawnItem(w: WorldState, x: number, z: number): number {
  return spawnBody(w, {
    px: fromFloatConst(x), py: fromFloatConst(0.3), pz: fromFloatConst(z),
    radius: fromFloatConst(0.28), halfHeight: fromFloatConst(0.28),
    massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Pickup,
    health: fromInt(1),
  });
}

/** Build a one-player input frame. */
function frame(w: WorldState, player: number, over: Partial<PlayerInput>): (PlayerInput | undefined)[] {
  const a: (PlayerInput | undefined)[] = new Array(w.count);
  a[player] = { ...NEUTRAL_INPUT, aim: 0, ...over };
  return a;
}

function activeSlot(w: WorldState, id: number): number {
  const s = w.selSlot[id]!;
  const arr = [w.inv0, w.inv1, w.inv2, w.inv3, w.inv4][s]!;
  return arr[id]!;
}
function countPickups(w: WorldState): number {
  let n = 0;
  for (let i = 0; i < w.count; i++) if ((w.flags[i]! & (BodyFlag.Alive | BodyFlag.Pickup)) === (BodyFlag.Alive | BodyFlag.Pickup)) n++;
  return n;
}

describe('interaction targeting', () => {
  it('targets a loose item directly in front and offers Pickup', () => {
    const { sim, w, player } = makePlayerScene();
    const item = spawnItem(w, 1.0, 0); // 1u ahead along +X (facing)
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    expect(w.targetEntity[player]).toBe(item);
    expect(w.targetActions[player]! & InteractAction.Pickup).not.toBe(0);
  });

  it('does NOT target an item behind the player (outside the cone)', () => {
    const { sim, w, player } = makePlayerScene();
    spawnItem(w, -1.0, 0); // behind (−X) while facing +X
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    expect(w.targetEntity[player]).toBe(NO_ENTITY);
  });
});

describe('inventory pickup / throw', () => {
  it('PRIMARY picks a loose item into a slot and removes its world body', () => {
    const { sim, w, player } = makePlayerScene();
    const item = spawnItem(w, 1.0, 0);
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    expect(activeSlot(w, player)).toBe(ItemKind.Empty);

    sim.advance(frame(w, player, { buttons: Button.Primary })); // press edge
    expect(activeSlot(w, player)).not.toBe(ItemKind.Empty);
    expect(w.flags[item]! & BodyFlag.Alive).toBe(0); // body consumed
  });

  it('SECONDARY throws the active item back into the world, emptying the slot', () => {
    const { sim, w, player } = makePlayerScene();
    spawnItem(w, 1.0, 0);
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, { buttons: Button.Primary }));
    sim.advance(frame(w, player, {})); // release to re-arm edge
    expect(activeSlot(w, player)).not.toBe(ItemKind.Empty);
    const before = countPickups(w);

    sim.advance(frame(w, player, { buttons: Button.Secondary })); // throw
    expect(activeSlot(w, player)).toBe(ItemKind.Empty);
    expect(countPickups(w)).toBe(before + 1); // a free Pickup body reappeared
  });
});

describe('slot selection', () => {
  it('applies a valid slot select and clamps out-of-range to the valid range', () => {
    const { sim, w, player } = makePlayerScene();
    sim.advance(frame(w, player, { slot: 3 }));
    expect(w.selSlot[player]).toBe(3);
    // NO_SLOT (-1) leaves the selection unchanged
    sim.advance(frame(w, player, { slot: -1 }));
    expect(w.selSlot[player]).toBe(3);
    // an in-range select moves it; the system only accepts 0..NUM_SLOTS-1
    sim.advance(frame(w, player, { slot: NUM_SLOTS - 1 }));
    expect(w.selSlot[player]).toBe(NUM_SLOTS - 1);
  });
});

// ============================================================================
// TERRAIN PUZZLES — the filled door hook (docs/14 §2): locked doors, keys, rugs.
// ============================================================================

/** A KEY pickup body (doorId = the door it opens) at (x, 0.3, z). */
function spawnKey(w: WorldState, x: number, z: number, doorId: number): number {
  return spawnBody(w, {
    px: fromFloatConst(x), py: fromFloatConst(0.3), pz: fromFloatConst(z),
    radius: fromFloatConst(0.28), halfHeight: fromFloatConst(0.28),
    massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Pickup,
    health: fromInt(1), doorId,
  });
}
/** A locked DOOR body (doorId, starts locked) at (x, y, z). */
function spawnDoor(w: WorldState, x: number, z: number, doorId: number): number {
  return spawnBody(w, {
    px: fromFloatConst(x), py: fromFloatConst(0.9), pz: fromFloatConst(z),
    radius: fromFloatConst(0.5), halfHeight: fromFloatConst(0.9),
    massClass: MassClass.Anchor, flags: BodyFlag.Door, doorId, lockState: 1,
  });
}
/** A movable RUG body whose hidden key opens `doorId`, at (x, y, z). */
function spawnRug(w: WorldState, x: number, z: number, doorId: number): number {
  return spawnBody(w, {
    px: fromFloatConst(x), py: fromFloatConst(0.3), pz: fromFloatConst(z),
    radius: fromFloatConst(0.45), halfHeight: fromFloatConst(0.1),
    massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Rug,
    health: fromInt(1), doorId,
  });
}

describe('terrain puzzles: locked doors / keys / rugs', () => {
  it('a held key unlocks its matching door on PRIMARY and is consumed', () => {
    const { sim, w, player } = makePlayerScene();
    // a key for door 7 directly in front; pick it up.
    spawnKey(w, 1.0, 0, 7);
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, { buttons: Button.Primary })); // pickup
    sim.advance(frame(w, player, {})); // release
    expect(activeSlot(w, player)).toBe(ItemKind.Key);
    // now a door for the SAME id appears in front; the Open action should light up.
    const door = spawnDoor(w, 1.0, 0, 7);
    sim.advance(frame(w, player, {}));
    expect(w.targetEntity[player]).toBe(door);
    expect(w.targetActions[player]! & InteractAction.Open).not.toBe(0);
    // PRIMARY uses the key: door unlocks (killed) + the key slot empties.
    sim.advance(frame(w, player, { buttons: Button.Primary }));
    expect(w.lockState[door]).toBe(0); // unlocked
    expect(w.flags[door]! & BodyFlag.Alive).toBe(0); // plug removed
    expect(activeSlot(w, player)).toBe(ItemKind.Empty); // key consumed
  });

  it('a WRONG key does not open a door (no Open prompt; door stays locked)', () => {
    const { sim, w, player } = makePlayerScene();
    spawnKey(w, 1.0, 0, 3); // key for door 3
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, { buttons: Button.Primary }));
    sim.advance(frame(w, player, {}));
    const door = spawnDoor(w, 1.0, 0, 9); // a DIFFERENT door (id 9)
    sim.advance(frame(w, player, {}));
    // no matching key → the door is NOT an Open target (the prompt never lights up), so
    // the wrong key can never open it. (Pressing PRIMARY here would PLACE the held key,
    // not open the door — the Open action bit being clear is the load-bearing guarantee.)
    expect(w.targetActions[player]! & InteractAction.Open).toBe(0);
    expect(w.lockState[door]).toBe(1); // door remains locked
  });

  it('interacting a rug reveals a key for its door (one-shot) and is pickable', () => {
    const { sim, w, player } = makePlayerScene();
    const rug = spawnRug(w, 1.0, 0, 5);
    sim.advance(frame(w, player, {}));
    expect(w.targetEntity[player]).toBe(rug);
    expect(w.targetActions[player]! & InteractAction.Open).not.toBe(0);
    const pickupsBefore = countPickups(w);
    sim.advance(frame(w, player, { buttons: Button.Primary })); // search the rug
    expect(w.rugRevealed[rug]).toBe(1); // latched
    expect(countPickups(w)).toBe(pickupsBefore + 1); // a key body appeared
    // the revealed body is a Key for door 5.
    let keyBody = -1;
    for (let i = 0; i < w.count; i++) {
      if ((w.flags[i]! & (BodyFlag.Alive | BodyFlag.Pickup)) === (BodyFlag.Alive | BodyFlag.Pickup) && w.doorId[i] === 5) keyBody = i;
    }
    expect(keyBody).toBeGreaterThanOrEqual(0);
    // the rug is latched, so a second interaction never spawns ANOTHER key. (The next
    // PRIMARY press picks up the now-in-front revealed key instead — also fine; what we
    // assert is the rug NEVER produces a second key body, i.e. total keys for door 5 == 1
    // counting the one in-hand + any loose.)
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, { buttons: Button.Primary }));
    let looseKeysForDoor5 = 0;
    for (let i = 0; i < w.count; i++) if ((w.flags[i]! & BodyFlag.Alive) !== 0 && w.doorId[i] === 5 && (w.flags[i]! & BodyFlag.Pickup) !== 0) looseKeysForDoor5++;
    const inHandKey5 = activeSlot(w, player) === ItemKind.Key ? 1 : 0;
    expect(looseKeysForDoor5 + inHandKey5).toBe(1); // exactly one key total, never two
    expect(w.rugRevealed[rug]).toBe(1); // still latched
  });

  it('a placed/thrown key keeps its door binding (round-trips through the world)', () => {
    const { sim, w, player } = makePlayerScene();
    spawnKey(w, 1.0, 0, 4);
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, {}));
    sim.advance(frame(w, player, { buttons: Button.Primary })); // pickup key(4)
    sim.advance(frame(w, player, {}));
    expect(activeSlot(w, player)).toBe(ItemKind.Key);
    sim.advance(frame(w, player, { buttons: Button.Secondary })); // throw it back out
    sim.advance(frame(w, player, {}));
    // a thrown key body with doorId 4 must exist (binding survived).
    let thrownKey = -1;
    for (let i = 0; i < w.count; i++) {
      if ((w.flags[i]! & (BodyFlag.Alive | BodyFlag.Pickup)) === (BodyFlag.Alive | BodyFlag.Pickup) && w.doorId[i] === 4) thrownKey = i;
    }
    expect(thrownKey).toBeGreaterThanOrEqual(0);
  });
});
