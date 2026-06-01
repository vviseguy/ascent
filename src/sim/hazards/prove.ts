// ============================================================================
// src/sim/hazards/prove.ts — standalone proof for the SCRIPTED HAZARDS layer.
// ============================================================================
//
// Run from the project root:
//   node --experimental-strip-types src/sim/hazards/prove.ts
// Prints PASS and exits 0 on success; FAIL + exit 1 otherwise.
//
// Coverage (matches the assignment):
//  (1) each hazard type affects a test body as specified at the right ticks;
//  (2) crusher position + tile solidity (+ turret shot) are EXACT pure functions
//      of tick, recomputed at arbitrary, out-of-order ticks;
//  (3) DETERMINISM: a scene with several hazards + moving bodies run twice ⇒
//      identical per-tick hashes, and survives save/restore + rollback resim
//      (restore an earlier tick, resim, hashes match);
//  (4) FALL DAMAGE: a fast-falling player takes damage; the Anchor is not
//      instakilled (gets Downed + lesser damage).
//
// Standalone-proof conventions (CLAUDE.md): relative imports w/ .ts extensions;
// exit via the globalThis.process shim; no TS enum/namespace.
// ============================================================================

import {
  type Fixed, fromFloatConst, fromInt, fromRaw, toRaw, toFloat, add, mul, div, ONE,
} from '../fixed/fixed.ts';
import {
  type WorldState, type BodySpec, createWorld, spawnBody, BodyFlag, MassClass,
  hasFlag, setFlag,
} from '../world/state.ts';
import { step } from '../world/step.ts';
import { type PlayerInput, NEUTRAL_INPUT } from '../world/input.ts';
import { hashWorld, hashHex } from '../world/hash.ts';
import { clone, restoreInto, statesEqual } from '../world/snapshot.ts';
import { GridIndex } from '../spatial/grid.ts';
import {
  HazardKind, type Hazard,
  type CrusherHazard, type TurretHazard, type TileHazard,
  type GustHazard, type SpikesHazard,
} from './model.ts';
import { crusherPos, tileSolid, turretShot, triangle01 } from './schedule.ts';
import { applyHazards } from './apply.ts';
import { applyFallDamage } from './falldamage.ts';

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

/** Author a raw-Fixed magnitude from a float (AUTHORING ONLY). */
function R(x: number): number {
  return toRaw(fromFloatConst(x));
}

/** Health of a body as a JS float (RENDER ONLY — test reporting). */
function hp(w: WorldState, id: number): number {
  return toFloat(fromRaw(w.health[id]!));
}

/** Spawn a body with sane defaults; only override what a test needs. */
function spawn(
  w: WorldState,
  opts: { x?: number; y?: number; z?: number; mass?: MassClass; flags?: number; health?: number },
): number {
  const spec: BodySpec = {
    px: fromRaw(opts.x ?? 0),
    py: fromRaw(opts.y ?? 0),
    pz: fromRaw(opts.z ?? 0),
    radius: fromFloatConst(0.5),
    halfHeight: fromFloatConst(0.9),
    massClass: opts.mass ?? MassClass.Player,
    flags: (opts.flags ?? 0) | BodyFlag.Player,
    health: fromFloatConst(opts.health ?? 100),
  };
  return spawnBody(w, spec);
}

/* ----------------- (1) per-hazard-type effect at right tick ----------------- */

function testCrusher(): void {
  console.log('[crusher]');
  const w = createWorld();
  // Crusher oscillates A=(0,0,0) → B=(4,0,0) over 60 ticks. Body sits at x=4.
  const h: CrusherHazard = {
    kind: HazardKind.Crusher,
    ax: R(0), ay: R(0), az: R(0),
    bx: R(4), by: R(0), bz: R(0),
    period: 60, phase: 0,
    radius: R(1.0), impulse: R(6.0), damage: R(5.0),
  };
  const body = spawn(w, { x: R(4), z: R(0) });
  const index = new GridIndex();

  // At tick 0 the crusher is at A=(0,0,0): body at x=4 is OUT of range (no dmg).
  index.rebuild(w);
  const hp0 = hp(w, body);
  applyHazards(w, [h], index, 0);
  check('tick 0: crusher at A, body untouched', hp(w, body) === hp0);

  // At tick 30 (half period) the crusher is at B=(4,0,0): body IS in range.
  index.rebuild(w);
  const hpBefore = hp(w, body);
  applyHazards(w, [h], index, 30);
  check('tick 30: crusher at B, body takes damage', hp(w, body) < hpBefore);
  check('tick 30: crusher imparts impulse (vx != 0)', w.vx[body] !== 0);
}

function testTurret(): void {
  console.log('[turret]');
  const w = createWorld();
  // Turret at origin fires +x every 30 ticks, speed 0.5u/tick, lives 20 ticks.
  // A body at x=5 is hit when the projectile reaches x≈5 (age 10).
  const h: TurretHazard = {
    kind: HazardKind.Turret,
    mx: R(0), my: R(0), mz: R(0),
    dx: R(1), dy: R(0), dz: R(0),
    fireEvery: 30, phase: 0,
    speed: R(0.5), projectileLife: 20,
    hitRadius: R(0.6), damage: R(7.0),
  };
  const body = spawn(w, { x: R(5), z: R(0) });
  const index = new GridIndex();

  // age 0 (tick 0): projectile at muzzle x=0, body at x=5 NOT hit.
  index.rebuild(w);
  const hpA = hp(w, body);
  applyHazards(w, [h], index, 0);
  check('tick 0: projectile at muzzle, body unhit', hp(w, body) === hpA);

  // age 10 (tick 10): projectile at x=5, body hit.
  index.rebuild(w);
  const hpB = hp(w, body);
  applyHazards(w, [h], index, 10);
  check('tick 10: projectile reaches body, damage applied', hp(w, body) < hpB);

  // age 22 (tick 22): past projectileLife=20 ⇒ no live projectile, no damage.
  index.rebuild(w);
  const hpC = hp(w, body);
  applyHazards(w, [h], index, 22);
  check('tick 22: projectile expired, body unhit', hp(w, body) === hpC);
}

function testTile(): void {
  console.log('[tile]');
  const w = createWorld();
  // Tile footprint covers origin, top at y=1, solid for first 30 of 60 ticks.
  const h: TileHazard = {
    kind: HazardKind.Tile,
    minX: R(-1), minZ: R(-1), maxX: R(1), maxZ: R(1),
    topY: R(1),
    period: 60, solidTicks: 30, phase: 0,
  };
  // Body sitting at the tile top with a downward velocity.
  const body = spawn(w, { x: R(0), y: R(1) });
  w.vy[body] = R(-3.0);
  const index = new GridIndex();

  // While solid (tick 5): body is supported → py clamped to topY, vy zeroed,
  // Grounded set.
  index.rebuild(w);
  applyHazards(w, [h], index, 5);
  check('tick 5: tile solid, body supported (py==topY)', w.py[body] === R(1));
  check('tick 5: tile solid, downward vy zeroed', w.vy[body] === 0);
  check('tick 5: tile solid, body Grounded', hasFlag(w, body, BodyFlag.Grounded));

  // Pure-function solidity checks at arbitrary ticks.
  check('tick 15: tile reports solid', tileSolid(h, 15) === true);
  check('tick 45: tile reports NON-solid', tileSolid(h, 45) === false);

  // Concrete fall demo: a body floating above the tile with the tile NON-solid
  // for the whole window should descend (gravity + integrate, no support).
  // We place it high enough that the base ground plane (y = halfHeight) never
  // catches it during the window.
  const w2 = createWorld();
  const b2 = spawn(w2, { x: R(0), y: R(8) });
  const idx2 = new GridIndex();
  const startY = w2.py[b2]!;
  const DT: Fixed = div(ONE, fromInt(60));
  const G: Fixed = fromFloatConst(-22);
  for (let t = 30; t < 50; t++) {
    // gravity + integrate (mirror of step's free-body motion, sans ground here)
    w2.vy[b2] = toRaw(add(fromRaw(w2.vy[b2]!), mul(G, DT)));
    w2.py[b2] = toRaw(add(fromRaw(w2.py[b2]!), mul(fromRaw(w2.vy[b2]!), DT)));
    idx2.rebuild(w2);
    applyHazards(w2, [h], idx2, t); // tile non-solid in [30,60): no support
  }
  check('tile non-solid: floating body falls', w2.py[b2]! < startY);
}

function testGust(): void {
  console.log('[gust]');
  const w = createWorld();
  const h: GustHazard = {
    kind: HazardKind.Gust,
    minX: R(-2), minZ: R(-2), maxX: R(2), maxZ: R(2),
    minY: R(-1), maxY: R(5),
    ix: R(0.3), iy: R(0), iz: R(0),
  };
  const inside = spawn(w, { x: R(0), y: R(1) });
  const outside = spawn(w, { x: R(10), y: R(1) });
  const index = new GridIndex();
  index.rebuild(w);
  applyHazards(w, [h], index, 0);
  check('gust pushes body inside zone (+vx)', w.vx[inside]! > 0);
  check('gust leaves body outside zone alone', w.vx[outside] === 0);
}

function testSpikes(): void {
  console.log('[spikes]');
  const w = createWorld();
  const h: SpikesHazard = {
    kind: HazardKind.Spikes,
    minX: R(-2), minZ: R(-2), maxX: R(2), maxZ: R(2),
    minY: R(-1), maxY: R(2),
    damage: R(10.0),
  };
  const inside = spawn(w, { x: R(0), y: R(0) });
  const outside = spawn(w, { x: R(9), y: R(0) });
  const index = new GridIndex();
  const hpIn = hp(w, inside);
  const hpOut = hp(w, outside);
  index.rebuild(w);
  applyHazards(w, [h], index, 0);
  check('spikes damage body inside zone', hp(w, inside) < hpIn);
  check('spikes leave body outside zone alone', hp(w, outside) === hpOut);
}

/* ------------- (2) pure f(tick): recompute at arbitrary ticks ------------- */

function testPureFunctions(): void {
  console.log('[pure f(tick)]');
  const cr: CrusherHazard = {
    kind: HazardKind.Crusher,
    ax: R(0), ay: R(0), az: R(0),
    bx: R(4), by: R(0), bz: R(0),
    period: 60, phase: 0,
    radius: R(1.0), impulse: R(6.0), damage: R(5.0),
  };
  const at = (t: number) => crusherPos(cr, t);
  check('crusher@0 == A', at(0).x === R(0));
  check('crusher@30 == B', at(30).x === R(4));
  check('crusher@60 == A (cycle wrap)', at(60).x === at(0).x);
  check('crusher@90 == B (cycle wrap)', at(90).x === at(30).x);

  // Recompute in scrambled, out-of-order ticks, twice ⇒ identical.
  const order = [45, 7, 30, 59, 0, 12, 30, 7];
  let stable = true;
  for (const t of order) {
    const a = crusherPos(cr, t);
    const b = crusherPos(cr, t);
    if (a.x !== b.x || a.y !== b.y || a.z !== b.z) stable = false;
  }
  check('crusher position repeatable for same tick', stable);
  check('triangle01@15 == 0.5 (raw)', triangle01(15, 60, 0) === R(0.5));

  const tile: TileHazard = {
    kind: HazardKind.Tile,
    minX: R(-1), minZ: R(-1), maxX: R(1), maxZ: R(1),
    topY: R(0), period: 60, solidTicks: 30, phase: 0,
  };
  check('tile solid @0', tileSolid(tile, 0) === true);
  check('tile solid @29', tileSolid(tile, 29) === true);
  check('tile NON-solid @30', tileSolid(tile, 30) === false);
  check('tile NON-solid @59', tileSolid(tile, 59) === false);
  check('tile solid @60 (wrap)', tileSolid(tile, 60) === true);
  const tileP: TileHazard = { ...tile, phase: 30 };
  check('phased tile NON-solid @0', tileSolid(tileP, 0) === false);
  check('phased tile solid @30', tileSolid(tileP, 30) === true);

  const tur: TurretHazard = {
    kind: HazardKind.Turret,
    mx: R(0), my: R(0), mz: R(0), dx: R(1), dy: R(0), dz: R(0),
    fireEvery: 30, phase: 0, speed: R(0.5), projectileLife: 20,
    hitRadius: R(0.6), damage: R(7.0),
  };
  check('turret shot active @0', turretShot(tur, 0).active === true);
  check('turret shot age 10 @10', turretShot(tur, 10).age === 10);
  check('turret projectile x @10 == 5u', turretShot(tur, 10).x === R(5));
  check('turret shot inactive @22 (past life)', turretShot(tur, 22).active === false);
  check('turret refires @30 (active, age 0)',
    turretShot(tur, 30).active === true && turretShot(tur, 30).age === 0);
}

/* ---------------- scene builder for determinism/rollback ---------------- */

function buildScene(): { w: WorldState; hazards: Hazard[]; index: GridIndex } {
  const w = createWorld();
  // A few moving bodies of mixed mass (Player flag so they self-move under step).
  const b0 = spawn(w, { x: R(4), y: R(3), mass: MassClass.Player });
  const b1 = spawn(w, { x: R(0), y: R(2), mass: MassClass.Light });
  w.vx[b1] = R(1.5);
  const b2 = spawn(w, { x: R(-3), y: R(4), mass: MassClass.Heavy });
  w.vz[b2] = R(-1.0);
  const b3 = spawn(w, { x: R(8), y: R(1), mass: MassClass.Anchor, flags: BodyFlag.Anchor });
  void b0; void b3;

  const hazards: Hazard[] = [
    {
      kind: HazardKind.Crusher,
      ax: R(0), ay: R(0), az: R(0), bx: R(4), by: R(0), bz: R(0),
      period: 48, phase: 0, radius: R(1.2), impulse: R(5.0), damage: R(3.0),
    } satisfies CrusherHazard,
    {
      kind: HazardKind.Turret,
      mx: R(8), my: R(1), mz: R(0), dx: R(-1), dy: R(0), dz: R(0),
      fireEvery: 24, phase: 3, speed: R(0.4), projectileLife: 18,
      hitRadius: R(0.7), damage: R(4.0),
    } satisfies TurretHazard,
    {
      kind: HazardKind.Tile,
      minX: R(-1), minZ: R(-1), maxX: R(1), maxZ: R(1),
      topY: R(0), period: 40, solidTicks: 20, phase: 5,
    } satisfies TileHazard,
    {
      kind: HazardKind.Gust,
      minX: R(-5), minZ: R(-5), maxX: R(5), maxZ: R(5),
      minY: R(-1), maxY: R(6), ix: R(0.05), iy: R(0), iz: R(0.02),
    } satisfies GustHazard,
    {
      kind: HazardKind.Spikes,
      minX: R(2), minZ: R(-3), maxX: R(6), maxZ: R(3),
      minY: R(-1), maxY: R(2), damage: R(2.0),
    } satisfies SpikesHazard,
  ];
  return { w, hazards, index: new GridIndex() };
}

/**
 * Advance one full tick INCLUDING hazards, in the recommended order: step() runs
 * SYSTEMS 1..5 (carry-transform is a no-op here since nothing is held), then we
 * rebuild the index and run applyHazards — faithfully reproducing "between (4)
 * and (5)" for this scene.
 */
function advance(
  w: WorldState, hazards: ReadonlyArray<Hazard>, index: GridIndex,
  inputs: ReadonlyArray<PlayerInput | undefined>,
): void {
  step(w, inputs);
  index.rebuild(w);
  applyHazards(w, hazards, index, w.tick);
}

/* ---------------------- (3) determinism + rollback ---------------------- */

function testDeterminism(): void {
  console.log('[determinism]');
  const TICKS = 80;
  const inputs: ReadonlyArray<PlayerInput | undefined> =
    [NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT];

  // Run A.
  const a = buildScene();
  const hashesA: number[] = [];
  for (let t = 0; t < TICKS; t++) {
    advance(a.w, a.hazards, a.index, inputs);
    hashesA.push(hashWorld(a.w));
  }

  // Run B (fresh scene, same inputs).
  const b = buildScene();
  const hashesB: number[] = [];
  for (let t = 0; t < TICKS; t++) {
    advance(b.w, b.hazards, b.index, inputs);
    hashesB.push(hashWorld(b.w));
  }

  let identical = true;
  for (let t = 0; t < TICKS; t++) if (hashesA[t] !== hashesB[t]) identical = false;
  check('two independent runs ⇒ identical per-tick hashes', identical);
  check('final states equal', statesEqual(a.w, b.w));
  console.log('       final hash = ' + hashHex(a.w));

  // Save/restore + rollback resim:
  // run to tick 30, snapshot, run to 80, restore the snapshot, resim to 80.
  const c = buildScene();
  for (let t = 0; t < 30; t++) advance(c.w, c.hazards, c.index, inputs);
  const snap = clone(c.w);
  const hashAt30 = hashWorld(c.w);
  for (let t = 30; t < TICKS; t++) advance(c.w, c.hazards, c.index, inputs);
  const hashAt80 = hashWorld(c.w);

  restoreInto(c.w, snap); // DERIVED index is rebuilt each advance(), never restored.
  check('restore reproduces tick-30 hash', hashWorld(c.w) === hashAt30);
  for (let t = 30; t < TICKS; t++) advance(c.w, c.hazards, c.index, inputs);
  check('rollback resim reproduces tick-80 hash', hashWorld(c.w) === hashAt80);
  check('rollback resim final state equals original run', statesEqual(c.w, a.w));
}

/* -------------------------- (4) fall damage -------------------------- */

function testFallDamage(): void {
  console.log('[fall damage]');
  const w = createWorld();

  // A regular player slamming down at 16 u/s.
  const player = spawn(w, { mass: MassClass.Player, health: 100 });
  const dmgP = applyFallDamage(w, player, fromFloatConst(16.0));
  check('fast-falling player takes damage', toRaw(dmgP) > 0 && hp(w, player) < 100);
  check('player NOT auto-Downed by fall', !hasFlag(w, player, BodyFlag.Downed));

  // A gentle landing under the safe threshold: no damage.
  const player2 = spawn(w, { mass: MassClass.Player, health: 100 });
  const dmgSafe = applyFallDamage(w, player2, fromFloatConst(5.0));
  check('soft landing deals no damage', toRaw(dmgSafe) === 0 && hp(w, player2) === 100);

  // The Anchor slamming down at the SAME speed that hurt the player.
  const anchor = spawn(w, { mass: MassClass.Anchor, flags: BodyFlag.Anchor, health: 100 });
  setFlag(w, anchor, BodyFlag.Anchor);
  const dmgA = applyFallDamage(w, anchor, fromFloatConst(16.0));
  check('anchor takes LESSER damage than player (fall-durable)', toRaw(dmgA) < toRaw(dmgP));
  check('anchor not instakilled (health remains > 0)', hp(w, anchor) > 0);
  check('anchor gets Downed beat', hasFlag(w, anchor, BodyFlag.Downed));
  check('anchor Downed timer set (ticks, hashed)', w.timer[anchor]! > 0);

  // Extreme speed: still no instakill for the Anchor (helper never hard-kills).
  const anchor2 = spawn(w, { mass: MassClass.Anchor, flags: BodyFlag.Anchor, health: 100 });
  applyFallDamage(w, anchor2, fromFloatConst(40.0));
  check('anchor survives extreme fall (no instakill in helper)', hp(w, anchor2) > 0);
}

/* ------------------------------- main ------------------------------- */

console.log('=== HAZARDS PROOF ===');
testCrusher();
testTurret();
testTile();
testGust();
testSpikes();
testPureFunctions();
testDeterminism();
testFallDamage();

const exit = failures === 0 ? 0 : 1;
console.log('');
console.log(failures === 0 ? 'PASS' : ('FAIL (' + failures + ' checks failed)'));
(globalThis as { process?: { exit(c: number): void } }).process?.exit(exit);
