// ============================================================================
// src/sim/breakable/prove.ts — standalone proof for the BREAKABLE (destructible) layer.
// ============================================================================
//
// Run from the project root:
//   node --experimental-strip-types src/sim/breakable/prove.ts
// Prints PASS and exits 0 on success; FAIL + exit 1 otherwise.
//
// Coverage (matches the assignment):
//  (1) BREAKS AT 0 INTEGRITY: a breakable destroyed exactly when health hits 0 (a
//      shove flag, a rush dash, and a fast thrown body each break it; an intact one
//      survives a slow brush).
//  (2) DROPS SPAWN DETERMINISTICALLY: destroying the SAME breakable at the SAME
//      (seed/tick) twice yields an identical world hash — same drop count, same
//      positions, same scatter velocities — verified via hashWorld. The count lands
//      in [DROP_MIN, DROP_MAX]; every drop is a Light Throwable+Pickup body.
//  (3) NORMAL BODIES UNAFFECTED: a wall-like static body, a plain Throwable, and a
//      Player are never destroyed by the breakable system (no Breakable flag).
//  (4) CAPACITY: drops are capped by world capacity (no throw when full).
//  (5) FULL-SIM DETERMINISM + ROLLBACK: a scene with a rushing player smashing
//      breakables, run twice through Sim.advance(), yields identical per-tick hash
//      streams; and a restore-an-earlier-tick + resim reproduces every hash — the
//      property rollback netcode depends on, now WITH spawn/kill churn in the loop.
//
// Standalone-proof conventions (CLAUDE.md): relative imports w/ .ts extensions; exit
// via the globalThis.process shim; no TS enum/namespace; integers + Fixed only.
// ============================================================================

import {
  type Fixed, fromFloatConst, fromInt, fromRaw, toRaw, ZERO, add,
} from '../fixed/fixed.ts';
import {
  type WorldState, createWorld, spawnBody, BodyFlag, MassClass, Role, hasFlag,
} from '../world/state.ts';
import { hashWorld } from '../world/hash.ts';
import { clone, restoreInto, statesEqual } from '../world/snapshot.ts';
import { GridIndex } from '../spatial/grid.ts';
import { type PlayerInput, Button, MOVE_Q } from '../world/input.ts';
import { Sim } from '../sim.ts';
import { makeArena } from '../collide/terrain.ts';
import { applyBreakables } from './break.ts';
import { BREAKABLE_INTEGRITY, DROP_MIN, DROP_MAX } from './config.ts';

/* ----------------------------- test harness ----------------------------- */

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log('  ok   - ' + name);
  } else {
    failures++;
    console.log('  FAIL - ' + name);
  }
}

/** Spawn a breakable prop at (x,z) on a flat-ish y. Returns its id. */
function spawnBreakable(w: WorldState, x: number, z: number, integrity: Fixed = BREAKABLE_INTEGRITY): number {
  return spawnBody(w, {
    px: fromInt(x), py: fromInt(1), pz: fromInt(z),
    radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.4),
    massClass: MassClass.Heavy, flags: BodyFlag.Breakable,
    health: integrity,
  });
}

/** Count alive bodies carrying a given flag. */
function countFlag(w: WorldState, f: number): number {
  let n = 0;
  for (let i = 0; i < w.count; i++) {
    if (hasFlag(w, i, BodyFlag.Alive) && (w.flags[i]! & f) !== 0) n++;
  }
  return n;
}

/**
 * True iff the breakable that occupied id `b` is GONE (destroyed). Because spawnBody
 * reuses the lowest dead slot, a freshly-spawned drop can land back on id `b`, so we
 * can't test `!Alive` — we test that id `b` no longer carries the Breakable flag
 * (a Pickup drop reusing the slot clears it; a still-intact prop keeps it).
 */
function breakableGone(w: WorldState, b: number): boolean {
  return !hasFlag(w, b, BodyFlag.Alive) || (w.flags[b]! & BodyFlag.Breakable) === 0;
}

/** Rebuild a fresh index against w and run the breakable system once at `tick`. */
function runBreakables(w: WorldState, tick: number): void {
  const index = new GridIndex();
  index.rebuild(w);
  applyBreakables(w, index, tick);
}

/* ---------------------- (1) breaks at 0 integrity ----------------------- */

function testBreaksAtZeroIntegrity(): void {
  console.log('-- breaks exactly at 0 integrity --');

  // (a) BREAKER shove flag: arm breakerShoveUntil, expect destruction once health<=0.
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(10)); // SHOVE_DAMAGE=12 > 10 → one tick breaks it
    w.breakerShoveUntil[b] = 5; // armed for ticks < 5
    runBreakables(w, 0);
    check('shove flag destroys a breakable past 0 integrity', breakableGone(w, b));
  }

  // shove that does NOT yet reach 0 leaves it ALIVE (integrity decremented, not dead).
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(20)); // 20 > SHOVE_DAMAGE(12) → survives one tick
    w.breakerShoveUntil[b] = 5;
    runBreakables(w, 0);
    check('shove below threshold leaves breakable alive', hasFlag(w, b, BodyFlag.Alive));
    check('shove still decremented integrity', toRaw(fromRaw(w.health[b]!)) < toRaw(fromInt(20)));
    // a second shove tick finishes it (20 - 12 - 12 < 0).
    runBreakables(w, 1);
    check('second shove tick destroys it (cumulative)', breakableGone(w, b));
  }

  // (b) RUSH impact: a body mid-dash in contact deals RUSH_DAMAGE per tick.
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(6)); // RUSH_DAMAGE=6 → one tick breaks it
    const r = spawnBody(w, {
      px: fromFloatConst(0.5), py: fromInt(1), pz: ZERO, // overlapping the breakable
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player,
    });
    w.rushUntil[r] = 5; // mid-dash for ticks < 5
    runBreakables(w, 0);
    check('a contacting RUSH dash destroys a breakable', breakableGone(w, b));
  }

  // a rush that does NOT contact (too far) deals nothing.
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(6));
    const r = spawnBody(w, {
      px: fromInt(8), py: fromInt(1), pz: ZERO, // far away
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player,
    });
    w.rushUntil[r] = 5;
    runBreakables(w, 0);
    check('a non-contacting rush leaves the breakable intact', hasFlag(w, b, BodyFlag.Alive));
    check('non-contacting rush deals no damage', w.health[b] === toRaw(fromInt(6)));
  }

  // (c) THROWN-body impact: a fast free body in contact deals scaled damage.
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(10));
    const proj = spawnBody(w, {
      px: fromFloatConst(0.5), py: fromInt(1), pz: ZERO,
      radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
      massClass: MassClass.Light, flags: BodyFlag.Throwable,
    });
    // speed 12 u/s: (12-5)*2 = 14 dmg > 10 → breaks. Set a fast horizontal velocity.
    w.vx[proj] = toRaw(fromInt(12));
    runBreakables(w, 0);
    check('a fast thrown body destroys a breakable', breakableGone(w, b));
  }

  // a SLOW body brushing the breakable (below THROW_IMPACT_SPEED) does nothing.
  {
    const w = createWorld(64);
    const b = spawnBreakable(w, 0, 0, fromInt(10));
    const slow = spawnBody(w, {
      px: fromFloatConst(0.5), py: fromInt(1), pz: ZERO,
      radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
      massClass: MassClass.Light, flags: BodyFlag.Throwable,
    });
    w.vx[slow] = toRaw(fromInt(2)); // below the 5 u/s threshold
    runBreakables(w, 0);
    check('a slow brush leaves the breakable intact', hasFlag(w, b, BodyFlag.Alive));
    check('slow brush deals no damage', w.health[b] === toRaw(fromInt(10)));
  }
}

/* ------------------ (2) deterministic drops on destruction -------------- */

function testDropsDeterministic(): void {
  console.log('-- drops spawn deterministically (same seed/tick → same hash) --');

  function destroyOne(tick: number): WorldState {
    const w = createWorld(64);
    // Same single breakable at the same id (0) and position, destroyed at `tick`.
    const b = spawnBreakable(w, 0, 0, fromInt(1));
    w.health[b] = toRaw(ZERO); // already at 0 → pass 2 destroys it this tick
    runBreakables(w, tick);
    return w;
  }

  const wA = destroyOne(100);
  const wB = destroyOne(100);
  check('identical (tick,id) ⇒ identical world hash after destruction', hashWorld(wA) === hashWorld(wB));
  check('identical (tick,id) ⇒ byte-for-byte equal states', statesEqual(wA, wB));

  // drop count is in [DROP_MIN, DROP_MAX] and every drop is Light + Throwable + Pickup.
  const drops = countFlag(wA, BodyFlag.Pickup);
  check('drop count within [DROP_MIN, DROP_MAX]', drops >= DROP_MIN && drops <= DROP_MAX);
  let allLightThrowable = drops > 0;
  for (let i = 0; i < wA.count; i++) {
    if (!hasFlag(wA, i, BodyFlag.Pickup)) continue;
    if (wA.massClass[i] !== MassClass.Light) allLightThrowable = false;
    if (!hasFlag(wA, i, BodyFlag.Throwable)) allLightThrowable = false;
  }
  check('every drop is a Light Throwable Pickup body', allLightThrowable);

  // the breakable itself is gone (its id may have been reused by a drop).
  check('the destroyed breakable no longer carries the Breakable flag', (wA.flags[0]! & BodyFlag.Breakable) === 0);
  check('no Breakable bodies remain after destroying the only one', countFlag(wA, BodyFlag.Breakable) === 0);

  // DIFFERENT ticks should (generally) differ — sanity that the seed actually varies.
  const wC = destroyOne(777);
  check('a different tick changes the drop result (seed varies)', hashWorld(wA) !== hashWorld(wC));

  // drops carry a non-zero scatter velocity (the "pop"), and a positive upward vy.
  let anyScatter = false; let allPopUp = drops > 0;
  for (let i = 0; i < wA.count; i++) {
    if (!hasFlag(wA, i, BodyFlag.Pickup)) continue;
    if (wA.vx[i] !== 0 || wA.vz[i] !== 0) anyScatter = true;
    if (wA.vy[i]! <= 0) allPopUp = false;
  }
  check('drops have seeded horizontal scatter', anyScatter);
  check('drops pop upward (positive vy)', allPopUp);
}

/* --------------------- (3) normal bodies unaffected --------------------- */

function testNormalBodiesUnaffected(): void {
  console.log('-- non-breakable bodies are never destroyed --');

  const w = createWorld(64);
  // a "wall"-like static heavy body (no Breakable flag), a plain throwable, a player.
  const wall = spawnBody(w, {
    px: ZERO, py: fromInt(1), pz: ZERO,
    radius: fromFloatConst(0.5), halfHeight: fromFloatConst(0.5),
    massClass: MassClass.Heavy, flags: 0,
  });
  const thr = spawnBody(w, {
    px: fromFloatConst(0.6), py: fromInt(1), pz: ZERO,
    radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
    massClass: MassClass.Light, flags: BodyFlag.Throwable,
  });
  const ply = spawnBody(w, {
    px: fromFloatConst(0.8), py: fromInt(1), pz: ZERO,
    radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
    massClass: MassClass.Player, flags: BodyFlag.Player,
  });
  // make them all "look damaging": fast + mid-rush + shove-flagged. A correct system
  // ignores all of this because none of them carry BodyFlag.Breakable.
  w.vx[thr] = toRaw(fromInt(20));
  w.rushUntil[ply] = 10;
  w.breakerShoveUntil[wall] = 10;
  w.breakerShoveUntil[thr] = 10;
  w.breakerShoveUntil[ply] = 10;
  const before = hashWorld(w);

  for (let t = 0; t < 30; t++) runBreakables(w, t);

  check('wall body survives (not breakable)', hasFlag(w, wall, BodyFlag.Alive));
  check('plain throwable survives (not breakable)', hasFlag(w, thr, BodyFlag.Alive));
  check('player survives (not breakable)', hasFlag(w, ply, BodyFlag.Alive));
  check('no Pickup drops spawned from non-breakables', countFlag(w, BodyFlag.Pickup) === 0);
  // health of the non-breakables is untouched by the breakable system.
  check('non-breakable integrity/health untouched', hashWorld(w) === before);
}

/* ------------------------------ (4) capacity ---------------------------- */

function testCapacityCap(): void {
  console.log('-- drops respect world capacity (no throw when full) --');

  // tiny world: 2 breakables fill 0..1; with cap 2 there is no room for any drop.
  const w = createWorld(2);
  const b0 = spawnBreakable(w, 0, 0, fromInt(1));
  const b1 = spawnBreakable(w, 4, 0, fromInt(1));
  w.health[b0] = toRaw(ZERO);
  w.health[b1] = toRaw(ZERO);
  let threw = false;
  try {
    runBreakables(w, 50);
  } catch {
    threw = true;
  }
  check('destroying with no free capacity does not throw', !threw);
  check('both breakables destroyed even at capacity', breakableGone(w, b0) && breakableGone(w, b1));
  // freed slots may now hold drops, but never exceed capacity — just assert sanity.
  check('count never exceeds capacity', w.count <= w.capacity);
}

/* ---------------- (5) full-sim determinism + rollback ------------------- */

/** Build an integrated scene: a player who rushes into a line of breakables. */
function makeSimScene(): { sim: Sim; playerId: number; breakableIds: number[] } {
  const w = createWorld(64);
  // a player at origin, facing +x.
  const playerId = spawnBody(w, {
    px: fromInt(-4), py: fromInt(1), pz: ZERO,
    radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
    massClass: MassClass.Player, flags: BodyFlag.Player,
    role: Role.Breaker,
  });
  const breakableIds: number[] = [];
  for (let i = 0; i < 6; i++) {
    breakableIds.push(spawnBreakable(w, -2 + i, 0, fromInt(8)));
  }
  // also a couple of plain throwables in the mix.
  for (let i = 0; i < 3; i++) {
    spawnBody(w, {
      px: fromInt(i * 2 - 2), py: fromInt(1), pz: fromInt(3),
      radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
      massClass: MassClass.Light, flags: BodyFlag.Throwable,
    });
  }
  const terrain = makeArena(fromInt(0), fromInt(20), fromInt(20), fromFloatConst(0.5));
  return { sim: new Sim(w, { terrain, groundY: toRaw(ZERO) }), playerId, breakableIds };
}

/** A scripted input stream: move right and spam rush + the Breaker ability. */
function scriptInput(_tick: number): PlayerInput {
  const buttons = Button.Rush | Button.Ability; // rush + breaker shove
  return { moveX: MOVE_Q, moveZ: 0, aim: 0, buttons, grabTarget: -1, slot: -1 };
}

function testFullSimDeterminism(): void {
  console.log('-- full-sim determinism + rollback (with break/spawn churn) --');

  const TICKS = 400;

  function run(): number[] {
    const { sim, playerId } = makeSimScene();
    const hashes: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      const inputs: (PlayerInput | undefined)[] = [];
      inputs[playerId] = scriptInput(t);
      sim.advance(inputs);
      hashes.push(sim.hash());
    }
    return hashes;
  }

  const a = run();
  const b = run();
  let identical = a.length === b.length;
  for (let i = 0; i < a.length && identical; i++) if (a[i] !== b[i]) identical = false;
  check('two identical runs ⇒ identical per-tick hash stream', identical);

  // confirm the scene actually broke something + spawned drops (the churn is real).
  {
    const { sim, playerId, breakableIds } = makeSimScene();
    for (let t = 0; t < TICKS; t++) {
      const inputs: (PlayerInput | undefined)[] = [];
      inputs[playerId] = scriptInput(t);
      sim.advance(inputs);
    }
    const w = sim.world;
    // fewer Breakable bodies remain than we spawned ⇒ at least one was destroyed.
    const remaining = countFlag(w, BodyFlag.Breakable);
    check('the rushing player actually broke at least one breakable', remaining < breakableIds.length);
    check('at least one Pickup drop exists after the run', countFlag(w, BodyFlag.Pickup) > 0);
  }

  // ROLLBACK EQUIVALENCE: restore an earlier world tick + resim → same hashes.
  {
    const { sim, playerId } = makeSimScene();
    const ref: number[] = [];
    const w = sim.world;
    for (let t = 0; t < TICKS; t++) {
      const inputs: (PlayerInput | undefined)[] = [];
      inputs[playerId] = scriptInput(t);
      sim.advance(inputs);
      ref.push(hashWorld(w));
    }

    const { sim: sim2, playerId: pid2 } = makeSimScene();
    const w2 = sim2.world;
    const ROLL_AT = 150;
    const RESIM = 60;
    let ok = true;
    let snap: WorldState | null = null;
    for (let t = 0; t < TICKS; t++) {
      const inputs: (PlayerInput | undefined)[] = [];
      inputs[pid2] = scriptInput(t);
      sim2.advance(inputs);
      if (t === ROLL_AT) snap = clone(w2);
      if (t === ROLL_AT + RESIM && snap) {
        // restore the saved tick and resim forward; hashes must match the reference.
        restoreInto(w2, snap);
        for (let rt = ROLL_AT + 1; rt <= ROLL_AT + RESIM; rt++) {
          const ri: (PlayerInput | undefined)[] = [];
          ri[pid2] = scriptInput(rt);
          sim2.advance(ri);
          if (hashWorld(w2) !== ref[rt]) ok = false;
        }
      }
    }
    check('rollback restore + resim reproduces the reference hashes', ok);
  }
}

/* ------------------------------- main ------------------------------- */

console.log('=== BREAKABLE PROOF ===');
testBreaksAtZeroIntegrity();
testDropsDeterministic();
testNormalBodiesUnaffected();
testCapacityCap();
testFullSimDeterminism();

const exit = failures === 0 ? 0 : 1;
console.log('');
console.log(failures === 0 ? 'PASS' : ('FAIL (' + failures + ' checks failed)'));
(globalThis as { process?: { exit(c: number): void } }).process?.exit(exit);
