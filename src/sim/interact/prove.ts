// ============================================================================
// Standalone PROOF for the INTERACTION + INVENTORY system (docs/11).
//   Run:  node --experimental-strip-types src/sim/interact/prove.ts
// ============================================================================
//
// The interact system (contextual targeting + the 5-slot hotbar: pickup / place / use
// / throw-item + slot-select) is sim state — it lives in WorldState (inv0..inv4,
// selSlot, targetEntity, targetActions), is hashed, and is cloned/restored. The
// netcode therefore depends on it being deterministic + rollback-safe. This proves it,
// driven through the FULL integrated Sim.advance() (so it composes with motion /
// collision / verbs / breakables exactly as it ships).
//
//   PROOF 1 — DETERMINISM. A scene (players + an Anchor + loose Pickup items in an
//             arena) run twice through advance() with the SAME interaction input
//             stream (slot scrolls + Primary/Secondary presses) yields an identical
//             per-tick hash stream.
//
//   PROOF 2 — ROLLBACK EQUIVALENCE. A reference run records every tick's hash; a second
//             run repeatedly restores an earlier tick and re-advances forward (the
//             rollback hot path), and must reproduce every reference hash exactly —
//             INCLUDING across pickup / use / throw-item boundaries (where slots flip
//             and item bodies spawn/despawn).
//
//   PROOF 3 — EFFECT SANITY. With a scripted pickup-then-throw, an item actually lands
//             in a hotbar slot on pickup and the slot empties + a free Pickup body
//             reappears on throw — i.e. the system DOES the thing, deterministically.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass, NO_ENTITY, type WorldState } from '../world/state.ts';
import { hashWorld } from '../world/hash.ts';
import { clone, restoreInto } from '../world/snapshot.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT, MOVE_Q, NUM_SLOTS } from '../world/input.ts';
import { fromInt, fromFloatConst, toFloat, fromRaw } from '../fixed/fixed.ts';
import { Sim, type SimContext } from '../sim.ts';
import { makeArena } from '../collide/terrain.ts';
import { ItemKind } from './model.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUM_PLAYERS = 3;
const NUM_ITEMS = 6;
const TICKS = 900;

/** Build a scene: players (one Anchor) + loose Pickup items in a walled arena. */
function makeScene(): { sim: Sim; playerIds: number[]; itemIds: number[] } {
  const w = createWorld(64);
  const playerIds: number[] = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    playerIds.push(spawnBody(w, {
      px: fromInt(i * 2 - 2), py: fromInt(2), pz: fromInt(0),
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player,
    }));
  }
  // an Anchor (a grabbable body target, exercises the body-grab interact tier too)
  spawnBody(w, {
    px: fromInt(0), py: fromInt(2), pz: fromInt(1),
    radius: fromFloatConst(0.5), halfHeight: fromFloatConst(1.0),
    massClass: MassClass.Anchor, flags: BodyFlag.Player | BodyFlag.Anchor,
  });
  // loose Pickup items scattered near the players (the hotbar fodder)
  const itemIds: number[] = [];
  for (let i = 0; i < NUM_ITEMS; i++) {
    itemIds.push(spawnBody(w, {
      px: fromFloatConst((i - 2.5) * 0.8), py: fromFloatConst(0.3), pz: fromFloatConst(-0.6),
      radius: fromFloatConst(0.28), halfHeight: fromFloatConst(0.28),
      massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Pickup,
      health: fromInt(1),
    }));
  }
  const terrain = makeArena(fromInt(0), fromInt(12), fromInt(3), fromFloatConst(0.5));
  const ctx: Partial<SimContext> = { terrain };
  return { sim: new Sim(w, ctx), playerIds, itemIds };
}

/** Deterministic per-tick inputs: move, scroll slots, and press Primary/Secondary. */
function makeStream(seed: number, players: number[], ticks: number, cap: number): PlayerInput[][] {
  const rnd = mulberry32(seed);
  const cur: PlayerInput[] = players.map(() => ({ ...NEUTRAL_INPUT }));
  const stream: PlayerInput[][] = [];
  for (let t = 0; t < ticks; t++) {
    const frame: PlayerInput[] = new Array(cap);
    for (let pi = 0; pi < players.length; pi++) {
      if (rnd() < 0.18) {
        let buttons = 0;
        const r = rnd();
        if (r < 0.30) buttons |= Button.Primary;       // pick up / place / grab
        else if (r < 0.50) buttons |= Button.Secondary; // throw item
        else if (r < 0.58) buttons |= Button.Grab;      // also exercise the body verb
        const slot = rnd() < 0.5 ? Math.floor(rnd() * NUM_SLOTS) : -1;
        cur[pi] = {
          moveX: Math.floor((rnd() * 2 - 1) * MOVE_Q),
          moveZ: Math.floor((rnd() * 2 - 1) * MOVE_Q),
          aim: Math.floor((rnd() * 2 - 1) * 205887),
          buttons, grabTarget: -1, slot,
        };
      } else {
        // release buttons most ticks so press-EDGES actually fire (pickup/throw are edges)
        cur[pi] = { ...cur[pi]!, buttons: 0, slot: -1 };
      }
      frame[players[pi]!] = cur[pi]!;
    }
    stream.push(frame);
  }
  return stream;
}

function runReference(stream: PlayerInput[][]): number[] {
  const { sim } = makeScene();
  const hashes: number[] = [hashWorld(sim.world)];
  for (let t = 0; t < stream.length; t++) {
    sim.advance(stream[t]!);
    hashes.push(hashWorld(sim.world));
  }
  return hashes;
}

let failures = 0;
const log = (s: string) => console.log(s);
log('----------------------------------------------------------------');
log('ASCENT interaction + inventory — STANDALONE PROOF (docs/11)');
log('----------------------------------------------------------------');

const SEED = 0x12345678;
const scene0 = makeScene();
const stream = makeStream(SEED, scene0.playerIds, TICKS, scene0.sim.world.capacity);

// PROOF 1 — determinism across two runs
const refHashes = runReference(stream);
const ref2 = runReference(stream);
let p1 = refHashes.length === ref2.length;
if (p1) for (let i = 0; i < refHashes.length; i++) if (refHashes[i] !== ref2[i]) { p1 = false; break; }
log(`PROOF 1 determinism (${TICKS} ticks, ${NUM_PLAYERS}p + anchor + ${NUM_ITEMS} items): ${p1 ? 'PASS' : 'FAIL'}`);
if (!p1) failures++;

// PROOF 2 — rollback torture across pickup/use/throw boundaries
{
  const rnd = mulberry32(0xcafe1234);
  const { sim } = makeScene();
  const frames = new Map<number, WorldState>();
  frames.set(0, clone(sim.world));
  let mismatches = 0, rollbacks = 0, t = 0;
  while (t < TICKS) {
    sim.advance(stream[t]!);
    t++;
    if (hashWorld(sim.world) !== refHashes[t]) mismatches++;
    frames.set(t, clone(sim.world));
    if (t > 12 && rnd() < 0.25) {
      const back = 1 + Math.floor(rnd() * 9);
      const target = t - back;
      const snap = frames.get(target);
      if (snap) {
        restoreInto(sim.world, snap);
        rollbacks++;
        for (let tt = target; tt < t; tt++) {
          sim.advance(stream[tt]!);
          if (hashWorld(sim.world) !== refHashes[tt + 1]) mismatches++;
        }
      }
    }
    if (t > 40) frames.delete(t - 41);
  }
  const p2 = mismatches === 0;
  log(`PROOF 2 rollback equivalence (${rollbacks} forced rollbacks across pickup/use/throw): ${p2 ? 'PASS' : 'FAIL'} (${mismatches} mismatches)`);
  if (!p2) failures++;
}

// PROOF 3 — effect sanity: a scripted pickup then throw actually mutates the hotbar.
{
  const w = createWorld(16);
  const player = spawnBody(w, {
    px: fromInt(0), py: fromFloatConst(0.9), pz: fromInt(0),
    radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
    massClass: MassClass.Player, flags: BodyFlag.Player,
  });
  // a loose item DIRECTLY in front of the player (facing 0 → +X), within reach.
  const item = spawnBody(w, {
    px: fromFloatConst(1.0), py: fromFloatConst(0.3), pz: fromInt(0),
    radius: fromFloatConst(0.28), halfHeight: fromFloatConst(0.28),
    massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Pickup,
    health: fromInt(1),
  });
  const terrain = makeArena(fromInt(0), fromInt(12), fromInt(3), fromFloatConst(0.5));
  const sim = new Sim(w, { terrain });

  const frame = (buttons: number, slot = -1): (PlayerInput | undefined)[] => {
    const a: (PlayerInput | undefined)[] = new Array(w.count);
    a[player] = { ...NEUTRAL_INPUT, aim: 0, buttons, slot }; // aim 0 = facing +X (toward item)
    return a;
  };

  // settle a couple ticks (let bodies ground + facing apply), no presses.
  sim.advance(frame(0));
  sim.advance(frame(0));
  const slotBefore = w.inv0[player]!;
  const itemAliveBefore = (w.flags[item]! & BodyFlag.Alive) !== 0;
  const pickupsBefore = countPickups(w); // exactly 1 (the loose item)

  // PRIMARY press-edge → pick up the item (needs a release after to re-arm the edge).
  sim.advance(frame(Button.Primary));
  sim.advance(frame(0));
  const slotAfterPickup = w.inv0[player]!; // freshly-picked item lands in slot 0 (first open)
  const pickupsAfterPickup = countPickups(w);

  // SECONDARY press-edge → throw the active item back into the world.
  sim.advance(frame(Button.Secondary));
  sim.advance(frame(0));
  const selSlot = w.selSlot[player]!;
  const slotAfterThrow = readSlot(w, player, selSlot);
  const pickupsAfterThrow = countPickups(w);

  const pickedUp = slotBefore === ItemKind.Empty && slotAfterPickup !== ItemKind.Empty && itemAliveBefore;
  const consumedBody = pickupsAfterPickup < pickupsBefore; // the picked body left the world
  const threw = slotAfterThrow === ItemKind.Empty && pickupsAfterThrow > pickupsAfterPickup;
  const p3 = pickedUp && consumedBody && threw;
  log(`PROOF 3 effect sanity (pickup fills a slot + consumes the body; throw empties it + spawns a body): ${p3 ? 'PASS' : 'FAIL'}`);
  if (!p3) failures++;
}

/** Count live Pickup bodies in the world. */
function countPickups(w: WorldState): number {
  let n = 0;
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    if ((w.flags[i]! & BodyFlag.Pickup) !== 0) n++;
  }
  return n;
}

function readSlot(w: WorldState, id: number, s: number): number {
  const arr = s === 0 ? w.inv0 : s === 1 ? w.inv1 : s === 2 ? w.inv2 : s === 3 ? w.inv3 : w.inv4;
  return arr[id]!;
}

// keep imports referenced (used in PROOF 3 helpers / scene)
void toFloat; void fromRaw; void NO_ENTITY;

log('----------------------------------------------------------------');
if (failures === 0) {
  log('RESULT: PASS — the interaction + inventory system is deterministic,');
  log('        rollback-safe, and functionally correct (pickup/use/throw).');
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(0);
} else {
  log(`RESULT: FAIL — ${failures} property(ies) failed.`);
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
}
