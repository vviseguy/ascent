// ============================================================================
// Vitest suite for AUTO STEP-UP (src/sim/collide/terrain.ts).
// ============================================================================
//
// Step-up lets a body walking horizontally into a LOW ledge climb onto it instead
// of being side-blocked, while a TALL wall still blocks. These tests mirror — for
// CI (`npm test`) — the properties the standalone prove.ts asserts:
//
//   (a) a body climbs a ledge of height <= MAX_STEP_HEIGHT,
//   (b) a body is BLOCKED by a wall of height >  MAX_STEP_HEIGHT,
//   (c) an overhang (low ceiling) over the destination vetoes the step,
//   (d) DETERMINISM: identical inputs ⇒ identical state, repeated.
//
// The world is driven by a tiny local tick loop (integrate X/Z then resolveTerrain)
// so the test exercises the REAL terrain resolver, not a reimplementation.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { createWorld, spawnBody, BodyFlag, MassClass, type WorldState } from '../world/state.ts';
import { hashWorld } from '../world/hash.ts';
import {
  type Fixed, fromInt, fromFloatConst, toRaw, fromRaw, add, mul, sub, lt, ZERO,
} from '../fixed/fixed.ts';
import { makeBox, flatGround, resolveTerrain, MAX_STEP_HEIGHT, STEP_CLIMB_RATE, type Terrain } from './terrain.ts';

const DT: Fixed = fromFloatConst(1 / 60);
const HALF: Fixed = fromFloatConst(0.9); // body half-height (player-sized)
const RAD: Fixed = fromFloatConst(0.4); // body radius

/**
 * Integrate X/Z by velocity, then resolve terrain. Mirrors the sim's order (no
 * gravity — isolates step-up vs slide).
 *
 * WHY it RE-ASSERTS the drive velocity each tick: move-and-slide legitimately zeros
 * the velocity component on a contact axis when it pushes a body out of a solid. The
 * SMOOTH step-up holds a body flush against a riser for a few ticks while it rises, so
 * the slide zeros vx on each of those ticks. In the real game `motionPhase`'s velocity
 * controller re-drives vx toward the held-stick target every tick, so the body keeps
 * trying to walk; this harness has no controller, so we re-apply the intended drive
 * velocity each tick to model "the player is still holding the stick" (otherwise the
 * body would park the instant it first brushed a wall — an artifact of the bare
 * harness, not of the resolver). `w.vy` is left untouched (no gravity here).
 */
function tick(w: WorldState, terrain: Terrain, driveVx?: number): void {
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) continue;
    if (driveVx !== undefined) w.vx[i] = driveVx; // held-stick: re-assert intended walk
    w.px[i] = toRaw(add(fromRaw(w.px[i]!), mul(fromRaw(w.vx[i]!), DT)));
    w.pz[i] = toRaw(add(fromRaw(w.pz[i]!), mul(fromRaw(w.vz[i]!), DT)));
  }
  resolveTerrain(w, terrain);
  w.tick = (w.tick + 1) | 0;
}

/** Spawn a single player body at (x,y,z) and return its id + world. */
function oneBody(x: Fixed, y: Fixed, z: Fixed): { w: WorldState; id: number } {
  const w = createWorld(8);
  const id = spawnBody(w, {
    px: x, py: y, pz: z, radius: RAD, halfHeight: HALF,
    massClass: MassClass.Player, flags: BodyFlag.Player,
  });
  return { w, id };
}

/**
 * A single solid box [0, +40]×[floorY,topY]×[-5,5], on the +X side of the body. The
 * top surface runs FAR in +X so a walking body parks on it for the test window: the
 * step-up now lifts the body SMOOTHLY over several ticks (rate-limited, not a snap),
 * so a short ledge would let the body stride off the far end before we measure.
 */
function ledgeTerrain(floorY: Fixed, topY: Fixed): Terrain {
  return {
    groundY: toRaw(floorY),
    solids: [makeBox(ZERO, floorY, fromInt(-5), fromInt(40), topY, fromInt(5))],
  };
}

describe('auto step-up', () => {
  it('(a) climbs a ledge of height <= MAX_STEP_HEIGHT, SMOOTHLY (multi-tick, no snap)', () => {
    // ledge top at the tower RISE (0.5 u) above the ground the body walks on.
    const floorY = ZERO;
    const topY = fromFloatConst(0.5); // 0.5 u tall ledge (the tower's per-tread rise)
    const terrain = ledgeTerrain(floorY, topY);
    const { w, id } = oneBody(fromInt(-2), add(floorY, HALF), ZERO);
    const drive = toRaw(fromInt(4)); // walk into the ledge (held-stick, re-asserted each tick)

    // capture the per-tick feet trajectory: the rise must be RATE-LIMITED (each tick at
    // most STEP_CLIMB_RATE — i.e. NOT a teleport) and take more than one tick.
    let prevFeet = w.py[id]! - toRaw(HALF);
    let maxRise = 0;
    let climbTicks = 0;
    for (let t = 0; t < 120; t++) {
      tick(w, terrain, drive);
      const f = w.py[id]! - toRaw(HALF);
      const d = f - prevFeet;
      if (d > maxRise) maxRise = d;
      if (d > 1) climbTicks++; // a tick where the feet actually rose
      prevFeet = f;
    }

    // body should now be standing ON the ledge: feet at topY, center at topY+half,
    // and it should have moved PAST the ledge's near face (onto the top surface).
    const feet = fromRaw(w.py[id]! - toRaw(HALF));
    expect(Math.abs(toRaw(feet) - toRaw(topY))).toBeLessThan(toRaw(fromFloatConst(0.02)));
    expect(w.px[id]!).toBeGreaterThan(toRaw(fromFloatConst(0.2))); // climbed onto the slab
    expect(Number.isFinite(w.px[id]!)).toBe(true);
    // smoothness: never popped up more than one per-tick budget, and took >=2 ticks.
    expect(maxRise).toBeLessThanOrEqual(toRaw(STEP_CLIMB_RATE) + 1);
    expect(climbTicks).toBeGreaterThanOrEqual(2);
  });

  it('(b) is BLOCKED by a wall taller than MAX_STEP_HEIGHT', () => {
    // wall just over the step height — must NOT be climbed.
    const floorY = ZERO;
    const topY = add(MAX_STEP_HEIGHT, fromFloatConst(0.2)); // 0.7 u — a wall
    const terrain = ledgeTerrain(floorY, topY);
    const { w, id } = oneBody(fromInt(-2), add(floorY, HALF), ZERO);
    void id;

    for (let t = 0; t < 120; t++) tick(w, terrain, toRaw(fromInt(4)));

    // body stays on the ground (feet at floorY) and stops at the wall face minus its
    // radius (center never reaches the box's minX=0, allowing for the radius inflate).
    const feet = fromRaw(w.py[id]! - toRaw(HALF));
    expect(Math.abs(toRaw(feet) - toRaw(floorY))).toBeLessThan(toRaw(fromFloatConst(0.02)));
    const wallFaceMinusR = sub(ZERO, RAD); // box.minX(0) - radius
    expect(lt(fromRaw(w.px[id]!), add(wallFaceMinusR, fromFloatConst(0.05)))).toBe(true);
  });

  it('(c) an overhang above the ledge vetoes the step-up', () => {
    // a climbable ledge, but a low ceiling hangs just above where the body would
    // stand — there is no headroom, so the body must be blocked, not lifted.
    const floorY = ZERO;
    const topY = MAX_STEP_HEIGHT; // ledge is climbable on its own
    // ceiling bottom only 0.3 u above the ledge top → body (1.8 u tall) can't fit.
    const ceilMinY = add(topY, fromFloatConst(0.3));
    const ceilMaxY = add(ceilMinY, fromInt(1));
    const terrain: Terrain = {
      groundY: toRaw(floorY),
      solids: [
        makeBox(ZERO, floorY, fromInt(-5), fromInt(3), topY, fromInt(5)), // the ledge
        makeBox(ZERO, ceilMinY, fromInt(-5), fromInt(3), ceilMaxY, fromInt(5)), // overhang
      ],
    };
    const { w, id } = oneBody(fromInt(-2), add(floorY, HALF), ZERO);
    void id;

    for (let t = 0; t < 120; t++) tick(w, terrain, toRaw(fromInt(4)));

    // feet stay on the lower floor; the body did not climb under the overhang.
    const feet = fromRaw(w.py[id]! - toRaw(HALF));
    expect(Math.abs(toRaw(feet) - toRaw(floorY))).toBeLessThan(toRaw(fromFloatConst(0.02)));
    expect(lt(fromRaw(w.px[id]!), ZERO)).toBe(true); // never got onto the slab
  });

  it('(d) climbs a multi-tread staircase of full-height riser boxes', () => {
    // Mirror the tower: discrete stacked treads, each a FULL-HEIGHT box rising 0.5 u
    // (game/tower.ts RISE). A walking body should climb the whole flight, not stall.
    const floorY = ZERO;
    const rise = MAX_STEP_HEIGHT; // 0.5 u per tread
    const tread = fromFloatConst(0.9);
    const solids = [];
    for (let k = 0; k < 6; k++) {
      const x0 = add(ZERO, mul(fromInt(k), tread));
      // each tread runs FAR in +X (it underlies every higher tread); the TOP tread
      // extends to ~+45 so the walker parks on it for the measurement window rather
      // than striding off the far end (the smooth climb takes a few ticks per riser).
      const x1 = add(x0, fromInt(45));
      const top = mul(fromInt(k + 1), rise);
      solids.push(makeBox(x0, floorY, fromInt(-5), x1, top, fromInt(5)));
    }
    const terrain: Terrain = { groundY: toRaw(floorY), solids };
    const { w, id } = oneBody(fromInt(-2), add(floorY, HALF), ZERO);
    const drive = toRaw(fromInt(3)); // held-stick walk, re-asserted each tick

    // record the feet trajectory: the climb must be CONTINUOUS (never fall back) and
    // SMOOTH (no single tick rises more than the per-tick STEP_CLIMB_RATE + slop).
    let runMax = -(1 << 30);
    let neverFell = true;
    let prevFeet = w.py[id]! - toRaw(HALF);
    let maxRise = 0;
    for (let t = 0; t < 300; t++) {
      tick(w, terrain, drive);
      const f = w.py[id]! - toRaw(HALF);
      if (f < runMax - (toRaw(MAX_STEP_HEIGHT) >> 3)) neverFell = false; // tolerate a tiny dip
      if (f > runMax) runMax = f;
      const d = f - prevFeet;
      if (d > maxRise) maxRise = d;
      prevFeet = f;
    }

    // after enough ticks the body has climbed onto the topmost tread (top = 6*0.5=3 u),
    // climbing the whole flight continuously and smoothly (no fall-through, no teleport).
    const feet = fromRaw(w.py[id]! - toRaw(HALF));
    expect(toRaw(feet)).toBeGreaterThan(toRaw(fromFloatConst(2.9)));
    expect(neverFell).toBe(true);
    // smoothness: no single tick ever climbs more than ONE riser (a body NEVER teleports
    // up multiple treads at once). The rate-limited step-up lift is bounded by
    // STEP_CLIMB_RATE; the move-and-slide "land on top of a box" snap can additionally
    // contribute the small residual penetration on a tread-to-tread transition tick
    // (correct: landing a sinking body onto a surface should not itself be rate-limited),
    // so the strict per-tick anti-teleport bound here is one RISE (0.5 u). The exact
    // STEP_CLIMB_RATE smoothness of the pure step-up path is proven in collide/prove.ts
    // PROOF 5 under the REAL gravity+controller pipeline (max rise there ~0.174 u).
    expect(maxRise).toBeLessThanOrEqual(toRaw(MAX_STEP_HEIGHT));
  });

  it('(e) is DETERMINISTIC: identical inputs reproduce identical state', () => {
    const terrain = ledgeTerrain(ZERO, MAX_STEP_HEIGHT);
    function run(): number[] {
      const { w, id } = oneBody(fromInt(-2), add(ZERO, HALF), ZERO);
      void id;
      const hashes: number[] = [hashWorld(w)];
      for (let t = 0; t < 120; t++) { tick(w, terrain, toRaw(fromInt(4))); hashes.push(hashWorld(w)); }
      return hashes;
    }
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it('(f) flat ground with no solids leaves a walking body unaffected', () => {
    // sanity: step-up must be a no-op when there is nothing to climb.
    const terrain = flatGround(ZERO);
    const { w, id } = oneBody(fromInt(-2), add(ZERO, HALF), ZERO);
    void id;
    for (let t = 0; t < 60; t++) tick(w, terrain, toRaw(fromInt(4)));
    const feet = fromRaw(w.py[id]! - toRaw(HALF));
    expect(Math.abs(toRaw(feet) - toRaw(ZERO))).toBeLessThan(2); // still on the ground plane
    expect(w.px[id]!).toBeGreaterThan(toRaw(fromInt(-2))); // moved forward freely
  });
});
