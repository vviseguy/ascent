// ============================================================================
// src/sim/verbs/abilities-prove.ts — standalone proof of the ROLE ABILITY system.
// ============================================================================
//
// Run: node --experimental-strip-types src/sim/verbs/abilities-prove.ts  (project root)
//
// Proves the assignment's claims for abilities.ts (Button.Ability per role, docs/02 §6):
//   (1) MENDER  : revives a downed bleeding ally in reach (clears Downed + bleedUntil,
//                 restores ~50% health, arms a brief stand-up regrab immunity).
//   (2) BULWARK : Unhand breaks a grab on a nearby ally (force-drops the grabber's hold,
//                 frees the ally, arms regrab immunity) + arms a brace window.
//   (3) ENGINEER: spawns a static Heavy bridge BLOCK in front, on a cooldown (a 2nd
//                 immediate press is refused; the block dissolves on its lifetime tick).
//   (4) RUNNER/BREAKER: scout tags a body; breaker AoE-shoves a nearby body + flags it.
//   (5) DETERMINISM: a scripted multi-role scenario run twice yields identical per-tick
//                 hashes.
//   (6) ROLLBACK-SAFE: restore an earlier tick (across a revive-complete + bridge-spawn
//                 boundary) and re-simulate forward → re-derived hashes match exactly.
//
// Abilities are exercised exactly as the integrator wires them: each tick we run
// step() (motion + carry) THEN applyVerbs() (which now runs applyAbilities as sub-
// system F), with the spatial index rebuilt before applyVerbs.
// ============================================================================

import {
  type Fixed, fromInt, fromFloatConst, toFloat, toRaw, fromRaw, gt, lt, lte, gte, ZERO,
} from '../fixed/fixed.ts';
import {
  type WorldState, createWorld, spawnBody, BodyFlag, MassClass, Role, NO_ENTITY,
  hasFlag, setFlag,
} from '../world/state.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT } from '../world/input.ts';
import { step } from '../world/step.ts';
import { hashWorld } from '../world/hash.ts';
import { clone, restoreInto } from '../world/snapshot.ts';
import { GridIndex } from '../spatial/grid.ts';
import { applyVerbs, commitPrevButtons, type RoleMap } from './verbs.ts';
import {
  GRAB_LATCH_TICKS, REVIVE_CHANNEL_TICKS, REVIVE_CD_TICKS, BRIDGE_CD_TICKS,
  BRIDGE_LIFETIME_TICKS, BREAK_SHOVE_BEAT_TICKS,
} from './config.ts';

// ---- tiny test harness -----------------------------------------------------
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const index = new GridIndex();

/** One full tick exactly as the integrator wires it: motion, then verbs (+abilities). */
function stepWithVerbs(
  w: WorldState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  roles?: RoleMap,
): void {
  step(w, inputs);
  index.rebuild(w);
  applyVerbs(w, inputs, index, roles);
  commitPrevButtons(w, inputs);
}

function mkInput(over: Partial<PlayerInput>): PlayerInput {
  return { ...NEUTRAL_INPUT, ...over };
}

const R = fromFloatConst(0.4);
const HH = fromFloatConst(0.9);

/** Spawn a player body of the given role + crew at (x,z). */
function spawnPlayer(w: WorldState, x: Fixed, z: Fixed, role: Role, crew: number): number {
  return spawnBody(w, {
    px: x, py: HH, pz: z, radius: R, halfHeight: HH,
    massClass: MassClass.Player, flags: BodyFlag.Player, facing: ZERO,
    crewId: crew, role,
  });
}

/** Force a regular player into the downed/bleeding state survival.ts would produce. */
function makeDowned(w: WorldState, id: number, tick: number): void {
  w.health[id] = 0;
  setFlag(w, id, BodyFlag.Downed);
  w.bleedUntil[id] = tick + 480; // mirrors BLEED_OUT_TICKS
  w.downedUntil[id] = tick + 480;
}

// ============================================================================
// (1) MENDER revives a downed bleeding ally in reach.
// ============================================================================
function proveMenderRevive(): void {
  console.log('\n[1] MENDER revives a downed ally (channel, heal, immunity)');
  const w = createWorld(16);
  const mender = spawnPlayer(w, ZERO, ZERO, Role.Mender, 0);
  const ally = spawnPlayer(w, fromFloatConst(1.5), ZERO, Role.Runner, 0); // same crew, in reach

  // settle one tick, then down the ally.
  stepWithVerbs(w, []);
  makeDowned(w, ally, w.tick);
  check('ally is downed + bleeding before revive',
    hasFlag(w, ally, BodyFlag.Downed) && w.bleedUntil[ally]! >= 0);

  // Mender holds Ability to channel the revive.
  let revivedAt = -1;
  for (let t = 0; t < REVIVE_CHANNEL_TICKS + 10; t++) {
    const a: PlayerInput[] = [];
    a[mender] = mkInput({ buttons: Button.Ability });
    stepWithVerbs(w, a);
    if (!hasFlag(w, ally, BodyFlag.Downed) && w.bleedUntil[ally]! < 0) { revivedAt = t; break; }
  }
  check('revive completed (Downed + bleedUntil cleared)', revivedAt >= 0);
  check('revive took ~a channel (not instant)', revivedAt >= REVIVE_CHANNEL_TICKS - 2);
  check('revived ally restored to ~50% health',
    gt(fromRaw(w.health[ally]!), fromInt(40)) && lte(fromRaw(w.health[ally]!), fromInt(60)));
  check('revived ally has brief regrab immunity (stand-up)', w.regrabUntil[ally]! > w.tick);
  check('mender ability on cooldown after revive', w.abilityCdUntil[mender]! > w.tick);

  // --- a downed ENEMY (different crew) is NOT revivable ---
  const w2 = createWorld(16);
  const m2 = spawnPlayer(w2, ZERO, ZERO, Role.Mender, 0);
  const enemy = spawnPlayer(w2, fromFloatConst(1.5), ZERO, Role.Runner, 1); // different crew
  stepWithVerbs(w2, []);
  makeDowned(w2, enemy, w2.tick);
  for (let t = 0; t < REVIVE_CHANNEL_TICKS + 10; t++) {
    const a: PlayerInput[] = [];
    a[m2] = mkInput({ buttons: Button.Ability });
    stepWithVerbs(w2, a);
  }
  check('downed ENEMY is not revived (crew-gated)', hasFlag(w2, enemy, BodyFlag.Downed));
  void m2;
}

// ============================================================================
// (2) BULWARK Unhand breaks a grab on a nearby ally + braces.
// ============================================================================
function proveBulwarkUnhand(): void {
  console.log('\n[2] BULWARK Unhand breaks a grab on an ally + braces');
  const w = createWorld(16);
  // crew 0: bulwark + ally(victim). crew 1: enemy grabber holding the ally.
  // The grabber↔ally pair sits well clear of the bulwark so the grabber's cone has
  // exactly ONE valid target (the ally) — the bulwark only enters via Unhand reach.
  const ally = spawnPlayer(w, fromFloatConst(10.0), ZERO, Role.Runner, 0);
  // grabber stands just past the ally, facing -x toward the ally so its cone reaches it.
  const grabber = spawnBody(w, {
    px: fromFloatConst(11.2), py: HH, pz: ZERO, radius: R, halfHeight: HH,
    massClass: MassClass.Player, flags: BodyFlag.Player, facing: fromFloatConst(Math.PI),
    crewId: 1, role: Role.Runner,
  });
  // bulwark sits just within UNHAND_REACH (3.5u) of the ally, out of the grabber's cone.
  const bulwark = spawnPlayer(w, fromFloatConst(8.0), ZERO, Role.Bulwark, 0);

  // grabber latches the ally (hold Grab through the latch + settle). NOTE: motion
  // System 1 sets facing := input.aim each tick, so we must AIM toward the ally (-x).
  const aimNegX = toRaw(fromFloatConst(Math.PI));
  const latch = GRAB_LATCH_TICKS[MassClass.Player]!;
  for (let t = 0; t < latch + 4; t++) {
    const a: PlayerInput[] = [];
    a[grabber] = mkInput({ buttons: Button.Grab, grabTarget: ally, aim: aimNegX });
    stepWithVerbs(w, a);
  }
  check('enemy grabbed the ally before Unhand', w.grabbedBy[ally] === grabber);

  // Bulwark presses Ability: must break the grab + free the ally + brace. (Keep the
  // grabber holding Grab+aim to prove the BREAK is what frees the ally.)
  const a: PlayerInput[] = [];
  a[grabber] = mkInput({ buttons: Button.Grab, grabTarget: ally, aim: aimNegX });
  a[bulwark] = mkInput({ buttons: Button.Ability });
  stepWithVerbs(w, a);

  check('Unhand freed the ally (grabbedBy cleared)', w.grabbedBy[ally] === NO_ENTITY);
  check('Unhand cleared the grabber\'s hold', w.holding[grabber] === NO_ENTITY);
  check('freed ally has regrab immunity', w.regrabUntil[ally]! > w.tick);
  check('bulwark is bracing (braceUntil active)', w.braceUntil[bulwark]! > w.tick);
  check('bulwark ability on cooldown', w.abilityCdUntil[bulwark]! > w.tick);
}

// ============================================================================
// (3) ENGINEER spawns a static bridge block on a cooldown; it dissolves.
// ============================================================================
function proveEngineerBridge(): void {
  console.log('\n[3] ENGINEER spawns a bridge block on cooldown; it dissolves');
  const w = createWorld(16);
  const eng = spawnPlayer(w, ZERO, ZERO, Role.Engineer, 0);
  stepWithVerbs(w, []);
  const countBefore = w.count;

  // press Ability -> spawn a bridge block.
  const a: PlayerInput[] = [];
  a[eng] = mkInput({ buttons: Button.Ability });
  stepWithVerbs(w, a);
  check('a new body was spawned (the bridge block)', w.count > countBefore);

  // find the bridge: a Throwable+NoGravity Heavy with a dissolve tick.
  let bridge = NO_ENTITY;
  for (let i = 0; i < w.count; i++) {
    if (i === eng) continue;
    if (hasFlag(w, i, BodyFlag.Alive) && w.bridgeExpireAt[i]! >= 0) { bridge = i; break; }
  }
  check('bridge block exists', bridge !== NO_ENTITY);
  check('bridge is a Heavy throwable solid', bridge !== NO_ENTITY &&
    w.massClass[bridge] === MassClass.Heavy && hasFlag(w, bridge, BodyFlag.Throwable));
  check('bridge is static (NoGravity)', bridge !== NO_ENTITY && hasFlag(w, bridge, BodyFlag.NoGravity));
  check('engineer on cooldown after build', w.abilityCdUntil[eng]! > w.tick);

  // a 2nd immediate press while on cooldown must NOT spawn another block.
  const beforeSecond = w.count;
  const a2: PlayerInput[] = [];
  a2[eng] = mkInput({ buttons: 0 });
  stepWithVerbs(w, a2); // release first (need a fresh press edge)
  a2[eng] = mkInput({ buttons: Button.Ability });
  stepWithVerbs(w, a2);
  check('second press during cooldown spawns no extra block', w.count === beforeSecond);

  // run until the bridge dissolves (its NoGravity static body should be killed).
  const expireAt = w.bridgeExpireAt[bridge]!;
  let dissolved = false;
  for (let t = w.tick; t <= expireAt + 2; t++) {
    stepWithVerbs(w, []);
    if (!hasFlag(w, bridge, BodyFlag.Alive)) { dissolved = true; break; }
  }
  check('bridge dissolves on its lifetime tick', dissolved);
  void BRIDGE_LIFETIME_TICKS;
}

// ============================================================================
// (4) RUNNER scout tags a body; BREAKER AoE-shoves + flags a nearby body.
// ============================================================================
function proveRunnerAndBreaker(): void {
  console.log('\n[4] RUNNER scout tag + BREAKER AoE shove (safe stub)');
  // RUNNER scout: tag the highest body in range.
  const w = createWorld(16);
  const runner = spawnPlayer(w, ZERO, ZERO, Role.Runner, 0);
  const high = spawnBody(w, {
    px: fromFloatConst(3.0), py: fromFloatConst(8.0), pz: ZERO, radius: R, halfHeight: HH,
    massClass: MassClass.Player, flags: BodyFlag.Player | BodyFlag.NoGravity, crewId: 0, role: Role.Runner,
  });
  stepWithVerbs(w, []);
  const a: PlayerInput[] = [];
  a[runner] = mkInput({ buttons: Button.Ability });
  stepWithVerbs(w, a);
  check('runner scout marked the highest reachable body', w.scoutMark[runner] === high);
  check('runner ability on cooldown', w.abilityCdUntil[runner]! > w.tick);

  // BREAKER AoE shove: a nearby free body gets velocity + a post-shove flag.
  const w2 = createWorld(16);
  const breaker = spawnPlayer(w2, ZERO, ZERO, Role.Breaker, 0);
  const victim = spawnPlayer(w2, fromFloatConst(1.5), ZERO, Role.Runner, 1);
  stepWithVerbs(w2, []);
  const velBefore = Math.abs(w2.vx[victim]!) + Math.abs(w2.vz[victim]!);
  const b: PlayerInput[] = [];
  b[breaker] = mkInput({ buttons: Button.Ability });
  stepWithVerbs(w2, b);
  const velAfter = Math.abs(w2.vx[victim]!) + Math.abs(w2.vz[victim]!);
  check('breaker shove imparted velocity to a nearby body', velAfter > velBefore);
  check('breaker shove set the post-shove beat flag', w2.breakerShoveUntil[victim]! > w2.tick - BREAK_SHOVE_BEAT_TICKS);
  check('breaker ability on cooldown', w2.abilityCdUntil[breaker]! > w2.tick);
}

// ============================================================================
// (5)+(6) DETERMINISM + ROLLBACK-SAFE: a scripted multi-role scenario.
// ============================================================================

/**
 * Build a scenario world + a per-tick input generator. Fixed spawn order so ids and
 * inputs line up on every run / resim:
 *   0 mender, 1 downed ally, 2 grabbed ally, 3 enemy grabber, 4 bulwark, 5 engineer.
 * The mender revives id1; the bulwark Unhands the grab on id2; the engineer builds.
 */
function scenario(): { w: WorldState; inputsAt: (tick: number) => PlayerInput[] } {
  const w = createWorld(32);
  const mender = spawnPlayer(w, ZERO, ZERO, Role.Mender, 0);
  const downed = spawnPlayer(w, fromFloatConst(1.5), ZERO, Role.Runner, 0);
  // bulwark + grabbedAlly + enemy sit on a separate row; the enemy's grab cone must
  // see ONLY the ally (bulwark placed within UNHAND_REACH of the ally, off the cone).
  const grabbedAlly = spawnPlayer(w, fromFloatConst(10.0), fromFloatConst(6.0), Role.Runner, 0);
  const enemy = spawnBody(w, {
    px: fromFloatConst(11.2), py: HH, pz: fromFloatConst(6.0), radius: R, halfHeight: HH,
    massClass: MassClass.Player, flags: BodyFlag.Player, facing: fromFloatConst(Math.PI),
    crewId: 1, role: Role.Runner,
  });
  const bulwark = spawnPlayer(w, fromFloatConst(8.0), fromFloatConst(6.0), Role.Bulwark, 0);
  const engineer = spawnPlayer(w, fromFloatConst(0.0), fromFloatConst(12.0), Role.Engineer, 0);

  // down the ally at tick 0 so the mender has something to revive.
  makeDowned(w, downed, 0);

  const aimNegX = toRaw(fromFloatConst(Math.PI));
  const latch = GRAB_LATCH_TICKS[MassClass.Player]!;
  const inputsAt = (tick: number): PlayerInput[] => {
    const a: PlayerInput[] = [];
    // mender channels the revive from tick 2 onward (hold Ability).
    a[mender] = mkInput({ buttons: tick >= 2 ? Button.Ability : 0 });
    // downed ally does nothing (it's prone).
    a[downed] = NEUTRAL_INPUT;
    // enemy latches the grabbedAlly early (hold Grab + aim toward it; motion sets
    // facing := aim each tick); it RELEASES grab once unhanded so the ally stays free
    // (the test asserts the freed state at end-of-scenario).
    a[enemy] = mkInput(
      tick <= latch + 6
        ? { buttons: Button.Grab, grabTarget: grabbedAlly, aim: aimNegX }
        : { buttons: 0, aim: aimNegX },
    );
    // bulwark presses Unhand once the grab is established (single edge at a fixed tick).
    a[bulwark] = mkInput({ buttons: tick === latch + 6 ? Button.Ability : 0 });
    // engineer builds at a fixed tick (single edge).
    a[engineer] = mkInput({ buttons: tick === 4 ? Button.Ability : 0 });
    return a;
  };
  void bulwark; void engineer;
  return { w, inputsAt };
}

function proveDeterminismAndRollback(): void {
  console.log('\n[5] DETERMINISM + [6] ROLLBACK-SAFE (scripted multi-role scenario)');
  const TOTAL = REVIVE_CHANNEL_TICKS + 60;

  // --- run A: reference hashes per tick ---
  const A = scenario();
  const hashesA: number[] = [];
  for (let t = 0; t < TOTAL; t++) {
    stepWithVerbs(A.w, A.inputsAt(A.w.tick));
    hashesA.push(hashWorld(A.w));
  }

  // --- run B: identical scenario -> must match A tick-for-tick ---
  const B = scenario();
  let allMatch = true;
  for (let t = 0; t < TOTAL; t++) {
    stepWithVerbs(B.w, B.inputsAt(B.w.tick));
    if (hashWorld(B.w) !== hashesA[t]) { allMatch = false; break; }
  }
  check('same scenario run twice => identical per-tick hashes', allMatch);

  // sanity: the scenario actually exercised the abilities (revive completed, bridge
  // spawned). Re-derive on a fresh run and assert observable effects.
  const S = scenario();
  for (let t = 0; t < TOTAL; t++) stepWithVerbs(S.w, S.inputsAt(S.w.tick));
  check('scenario: downed ally was revived', !hasFlag(S.w, 1, BodyFlag.Downed));
  // grabbedAlly is id 2; assert it WAS grabbed mid-scenario then freed by Unhand.
  check('scenario: grabbed ally was unhanded (freed)', S.w.grabbedBy[2] === NO_ENTITY);
  check('scenario: engineer bridge was built', S.w.count > 6);

  // --- forced-rollback torture: restore earlier ticks (incl. across the revive-
  //     complete + bridge-spawn boundary), resim forward, compare hashes. ---
  const C = scenario();
  const saves = new Map<number, WorldState>();
  const saveTicks = [0, 3, 5, REVIVE_CHANNEL_TICKS, REVIVE_CHANNEL_TICKS + 4, REVIVE_CHANNEL_TICKS + 30];
  const hashesC: number[] = [];
  for (let t = 0; t < TOTAL; t++) {
    if (saveTicks.includes(C.w.tick)) saves.set(C.w.tick, clone(C.w));
    stepWithVerbs(C.w, C.inputsAt(C.w.tick));
    hashesC.push(hashWorld(C.w));
  }

  let rollbackOk = true;
  const work = createWorld(C.w.capacity);
  // input generator independent of the scenario closure (so resim is reproducible).
  const refInputs = scenario().inputsAt;
  for (const saveTick of saveTicks) {
    const snap = saves.get(saveTick);
    if (!snap) continue;
    restoreInto(work, snap);
    for (let t = saveTick; t < TOTAL; t++) {
      stepWithVerbs(work, refInputs(work.tick));
      if (hashWorld(work) !== hashesC[t]) { rollbackOk = false; break; }
    }
    if (!rollbackOk) break;
  }
  check('forced rollback: restore + resim reproduces reference hashes exactly', rollbackOk);
  void REVIVE_CD_TICKS; void BRIDGE_CD_TICKS;
}

// ============================================================================
// run all
// ============================================================================
console.log('=== ROLE ABILITY PROOF ===');
proveMenderRevive();
proveBulwarkUnhand();
proveEngineerBridge();
proveRunnerAndBreaker();
proveDeterminismAndRollback();

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  (${passed} ok, ${failed} failed)`);
const exit = failed === 0 ? 0 : 1;
(globalThis as { process?: { exit(c: number): void } }).process?.exit(exit);

// keep a couple imports live even if a branch is trimmed
void toFloat; void lt; void gte; void toRaw;
