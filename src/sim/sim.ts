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
import { BodyFlag, hasFlag } from './world/state.ts';
import type { PlayerInput } from './world/input.ts';
import { motionPhase, carryPhase } from './world/step.ts';
import { fromRaw, neg, gt, type Fixed } from './fixed/fixed.ts';
import { GridIndex } from './spatial/grid.ts';
import type { SpatialIndex } from './spatial/index.ts';
import { applyCollision } from './collide/index.ts';
import type { Terrain } from './collide/terrain.ts';
import { flatGround } from './collide/terrain.ts';
import { applyHazards } from './hazards/apply.ts';
import { applyFallDamage, FALL_SAFE_SPEED } from './hazards/falldamage.ts';
import type { Hazard } from './hazards/model.ts';
import { applyVerbs, type RoleMap } from './verbs/verbs.ts';

/** Everything the integrated tick needs beyond the world + inputs. */
export interface SimContext {
  /** Static authored level geometry (terrain). Defaults to a flat ground plane. */
  terrain: Terrain;
  /** Scripted hazards for the current floor (pure f(tick)). */
  hazards: readonly Hazard[];
  /** Optional per-body role map for verb strength numbers (defaults Runner). */
  roles?: RoleMap;
}

/** A ready-to-run integrated simulation around a world + context. */
export class Sim {
  readonly world: WorldState;
  readonly ctx: SimContext;
  /** The shared spatial index (derived; rebuilt each advance, never persisted). */
  private readonly index: SpatialIndex;
  /** Per-advance scratch: pre-motion downward velocity, for fall-damage detection. */
  private preVy: Int32Array;

  constructor(world: WorldState, ctx?: Partial<SimContext>) {
    this.world = world;
    this.ctx = {
      terrain: ctx?.terrain ?? flatGround(),
      hazards: ctx?.hazards ?? [],
      ...(ctx?.roles !== undefined ? { roles: ctx.roles } : {}),
    };
    this.index = new GridIndex();
    this.preVy = new Int32Array(world.capacity);
  }

  /**
   * Advance the integrated sim by exactly one tick. Pure function of (world, inputs,
   * ctx): deterministic, rollback-safe (proven in sim/prove.ts). MUTATES world.
   */
  advance(inputs: ReadonlyArray<PlayerInput | undefined>): void {
    const w = this.world;
    const count = w.count;

    // capture pre-motion downward speed for fall-damage (who was falling this tick)
    for (let i = 0; i < count; i++) this.preVy[i] = w.vy[i]!;

    // SYSTEMS 1-4: motion (input→accel, gravity, integrate, ground+friction)
    motionPhase(w, inputs);

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

    // FALL DAMAGE: a body that became Grounded this tick with a fast inbound descent
    // takes impact damage (Anchor is fall-durable — handled inside the helper).
    for (let i = 0; i < count; i++) {
      if (!hasFlag(w, i, BodyFlag.Alive)) continue;
      if (!hasFlag(w, i, BodyFlag.Grounded)) continue;
      // downward impact speed = -(pre-motion vy) if it was descending
      const pv = fromRaw(this.preVy[i]!);
      const impact: Fixed = neg(pv); // positive when pv was negative (falling)
      if (gt(impact, FALL_SAFE_SPEED)) applyFallDamage(w, i, impact);
    }

    w.tick = (w.tick + 1) | 0;
  }
}

/** Convenience: build a Sim around a world with optional context. */
export function makeSim(world: WorldState, ctx?: Partial<SimContext>): Sim {
  return new Sim(world, ctx);
}
