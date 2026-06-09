// ============================================================================
// src/sim/sim.ts — the INTEGRATED simulation: the full tick pipeline.
// ============================================================================
//
// This is where all the proven, independently-tested layers compose into ONE
// deterministic tick. The netcode (src/net) drives the game through exactly three
// calls on a `Sim`: advance(inputs) / snapshot+restore (via world/snapshot) /
// hash (via world/hash). Nothing above the sim ever reaches inside it.
//
// THE INTEGRATED SYSTEM ORDER (fixed; the reason each layer recommended its slot):
//
//   0. VERBS-intent is folded into the verb system which runs LAST (it needs final
//      positions and takes final authority over velocity for rush/encumbrance).
//   1-4. motionPhase   (input→accel, gravity, integrate, ground+friction)   [step.ts]
//   3.5. COLLISION     (terrain move-and-slide, then body-body inverse-mass) [collide]
//        — runs after integrate so it corrects just-moved positions, and the
//          spatial index is rebuilt right before it (derived state for this tick).
//   4.5. HAZARDS       (crushers/turrets/tiles/gusts/spikes; impulses+damage) [hazards]
//        — after positions are final, before carry, so a held body re-slaves after.
//   5.  carryPhase     (slaved bodies follow carrier socket)                 [step.ts]
//   6.  VERBS          (rush/grab/throw/struggle + 5 pressures)             [verbs]
//        — last: needs post-everything positions for cones/contacts and is the
//          final authority on velocity (rush sweep, encumbrance cap).
//   then FALL-DAMAGE   (landing impacts captured across the tick)            [hazards]
//   then tick++.
//
// THE INDEX is rebuilt once, after motion+collision settle positions, and reused
// by hazards and verbs in the same tick. It is DERIVED STATE: never cloned/hashed/
// restored. A rollback restores the world and re-runs advance(), which rebuilds the
// index identically — so the index needs no persistence (proven in sim/prove.ts).
//
// CARRIED-BODY pre-capture for fall damage: a body's downward impact speed must be
// read at the moment it transitions from falling to grounded. We capture each
// alive body's pre-motion vy, then after collision/ground-resolve we see who became
// Grounded this tick with a large inbound downward speed and apply fall damage.
// This needs no extra WorldState array — the pre-vy lives in a per-advance scratch.
// ============================================================================

import type { WorldState } from './world/state.ts';
import { BodyFlag, hasFlag, NO_ENTITY } from './world/state.ts';
import type { PlayerInput } from './world/input.ts';
import { motionPhase, carryPhase, GRAVITY, TICK_DT } from './world/step.ts';
import { fromRaw, neg, gt, add, mul, type Fixed } from './fixed/fixed.ts';
import { GridIndex } from './spatial/grid.ts';
import type { SpatialIndex } from './spatial/index.ts';
import { applyCollision } from './collide/index.ts';
import type { Terrain } from './collide/terrain.ts';
import { flatGround } from './collide/terrain.ts';
import { applyHazards } from './hazards/apply.ts';
import { applyFallDamage, FALL_SAFE_SPEED } from './hazards/falldamage.ts';
import type { Hazard } from './hazards/model.ts';
import { applyVerbs, commitPrevButtons, type RoleMap } from './verbs/verbs.ts';
import { hashWorld } from './world/hash.ts';
import {
  type MatchState, createMatch, cloneMatch, restoreMatch, hashMatch, stepMatch,
  DEFAULT_MATCH, type MatchConfig,
} from '../game/match.ts';
import { applySurvival } from '../game/survival.ts';
import { applyBeacons } from '../game/beacon.ts';

/** Everything the integrated tick needs beyond the world + inputs. */
export interface SimContext {
  /** Static authored level geometry (terrain). Defaults to a flat ground plane. */
  terrain: Terrain;
  /** Scripted hazards for the current floor (pure f(tick)). */
  hazards: readonly Hazard[];
  /** Optional per-body role map for verb strength numbers (defaults Runner). */
  roles?: RoleMap;
  /** Match config (win condition, kill-plane, crews). Defaults to a solo race. */
  match?: MatchConfig;
  /** Anchor body id per crew (index = crewId). Required for standings/beacons. */
  anchorIds?: readonly number[];
  /** Ground Y (raw Fixed) for height/standing. Defaults to terrain.groundY. */
  groundY?: number;
}

/** A ready-to-run integrated simulation around a world + context. */
export class Sim {
  readonly world: WorldState;
  readonly ctx: SimContext;
  /** Per-crew standing + beacons + win state. Part of the snapshot (rollback-safe). */
  readonly match: MatchState;
  /** Ground reference Y (raw Fixed) for height/standing. */
  private readonly groundY: number;
  /** The shared spatial index (derived; rebuilt each advance, never persisted). */
  private readonly index: SpatialIndex;
  /** Per-advance scratch: pre-motion downward velocity, for fall-damage detection. */
  private preVy: Int32Array;
  /** Per-advance scratch: was each body Grounded at tick start (transition detect)? */
  private preGrounded: Uint8Array;

  constructor(world: WorldState, ctx?: Partial<SimContext>) {
    this.world = world;
    const terrain = ctx?.terrain ?? flatGround();
    this.ctx = {
      terrain,
      hazards: ctx?.hazards ?? [],
      ...(ctx?.roles !== undefined ? { roles: ctx.roles } : {}),
    };
    this.groundY = ctx?.groundY ?? terrain.groundY;
    const cfg = ctx?.match ?? DEFAULT_MATCH;
    this.match = createMatch(cfg, ctx?.anchorIds ?? []);
    this.index = new GridIndex();
    this.preVy = new Int32Array(world.capacity);
    this.preGrounded = new Uint8Array(world.capacity);
  }

  /**
   * Advance the integrated sim by exactly one tick. Pure function of (world, inputs,
   * ctx): deterministic, rollback-safe (proven in sim/prove.ts). MUTATES world.
   */
  advance(inputs: ReadonlyArray<PlayerInput | undefined>): void {
    const w = this.world;
    const count = w.count;

    // capture pre-motion downward speed + grounded state for fall-damage detection
    // (fall damage fires only on the falling→grounded TRANSITION this tick)
    for (let i = 0; i < count; i++) {
      this.preVy[i] = w.vy[i]!;
      this.preGrounded[i] = (w.flags[i]! & BodyFlag.Grounded) !== 0 ? 1 : 0;
    }

    // SYSTEMS 1-4: motion. Pass the TERRAIN's ground Y so motion's ground clamp and
    // the terrain resolver agree (no double-floor). With a deep terrain ground under
    // a platform world, a body in an open void falls past the kill-plane uncaught.
    motionPhase(w, inputs, fromRaw(this.ctx.terrain.groundY));

    // SYSTEM 3.5: collision — rebuild the index against just-moved positions, then
    // resolve terrain + body-body. (Index is derived state for THIS tick.)
    this.index.rebuild(w);
    applyCollision(w, this.index, this.ctx.terrain);

    // SYSTEM 4.5: scripted hazards (positions final post-collision). Reuses index.
    if (this.ctx.hazards.length > 0) {
      applyHazards(w, this.ctx.hazards, this.index, w.tick);
    }

    // SYSTEM 5: carry transform (held bodies re-slave after hazards/collision).
    carryPhase(w);

    // SYSTEM 6: verbs (rush/grab/throw/struggle). Index is still valid for queries
    // (positions only moved by carry for held bodies, which verbs treat specially).
    applyVerbs(w, inputs, this.index, this.ctx.roles);

    // FALL DAMAGE: a body that TRANSITIONED falling→Grounded this tick with a fast
    // inbound descent takes impact damage (Anchor is fall-durable — handled inside).
    // Skip bodies that became carried this tick (catching a faller converts a lethal
    // fall into a carry, §5.4) and bodies that were already grounded at tick start.
    for (let i = 0; i < count; i++) {
      if (!hasFlag(w, i, BodyFlag.Alive)) continue;
      if (!hasFlag(w, i, BodyFlag.Grounded)) continue;
      if (this.preGrounded[i] === 1) continue; // not a landing transition
      if (w.grabbedBy[i] !== NO_ENTITY) continue; // caught mid-fall — no phantom hit
      // impact speed = -(pre-motion vy + this tick's gravity), i.e. the true speed at
      // contact, not the start-of-tick speed (off-by-one-gravity-tick fix).
      const pv = add(fromRaw(this.preVy[i]!), mul(GRAVITY, TICK_DT));
      const impact: Fixed = neg(pv); // positive when descending
      if (gt(impact, FALL_SAFE_SPEED)) applyFallDamage(w, i, impact, w.tick);
    }

    // GAME LAYER (after physics/verbs, all deterministic + part of the snapshot):
    //   beacons (Anchor plant + crew recall) → survival (death/bleed/respawn/
    //   kill-plane) → standing+win evaluation. Order: beacons before survival so a
    //   just-planted beacon is a valid respawn target; survival before match so a
    //   respawned-low Anchor's committed height reflects reality this tick.
    applyBeacons(w, this.match, inputs, w.tick);
    applySurvival(w, this.match, w.tick);
    stepMatch(this.match, w, w.tick, this.groundY);

    // LAST: commit prevButtons for next-tick edge detection (after verbs AND
    // beacons, so all edge-reading systems shared one previous-buttons snapshot).
    commitPrevButtons(w, inputs);

    w.tick = (w.tick + 1) | 0;
  }

  /** Hash of the FULL game state (world + match) for desync detection / rollback. */
  hash(): number {
    return hashMatch(this.match, hashWorld(this.world));
  }

  /** Snapshot the match half (the world half uses world/snapshot clone/restore). */
  snapshotMatch(): MatchState { return cloneMatch(this.match); }
  restoreMatchFrom(m: MatchState): void { restoreMatch(this.match, m); }
}

/** Convenience: build a Sim around a world with optional context. */
export function makeSim(world: WorldState, ctx?: Partial<SimContext>): Sim {
  return new Sim(world, ctx);
}
