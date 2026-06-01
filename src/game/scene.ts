// ============================================================================
// src/game/scene.ts — build a playable sandbox scene (crew + anchor + objects).
// ============================================================================
//
// A small, deterministic starting scene for local play and for the visible demo:
// a walled arena, a few crew players, the Anchor (heavy/gold), and an assortment of
// throwable objects. This is the game layer assembling sim primitives — it owns
// "what bodies exist at the start"; the sim owns "how they evolve".
//
// Deterministic: positions are authored Fixed constants; no randomness at spawn.
// The floor generator (src/floor) feeds real terrain/hazards later — this sandbox
// uses a hand-built arena so the integrated sim is playable today.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass } from '../sim/world/state.ts';
import { fromInt, fromFloatConst } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena } from '../sim/collide/terrain.ts';
import { HazardKind, type Hazard } from '../sim/hazards/model.ts';
import { toRaw } from '../sim/fixed/fixed.ts';

export interface SceneHandle {
  sim: Sim;
  /** The local player's body id (driven by the keyboard). */
  localPlayerId: number;
  playerIds: number[];
  anchorId: number;
}

/** Build the sandbox arena scene. `crew` = number of regular players (>=1). */
export function buildSandbox(crew = 3): SceneHandle {
  const w = createWorld(64);
  const playerIds: number[] = [];
  for (let i = 0; i < crew; i++) {
    playerIds.push(
      spawnBody(w, {
        px: fromInt(i * 2 - crew),
        py: fromInt(2),
        pz: fromInt(0),
        radius: fromFloatConst(0.4),
        halfHeight: fromFloatConst(0.9),
        massClass: MassClass.Player,
        flags: BodyFlag.Player,
      }),
    );
  }
  const anchorId = spawnBody(w, {
    px: fromInt(0),
    py: fromInt(2),
    pz: fromInt(3),
    radius: fromFloatConst(0.55),
    halfHeight: fromFloatConst(1.0),
    massClass: MassClass.Anchor,
    flags: BodyFlag.Player | BodyFlag.Anchor,
  });
  // a scatter of throwable objects (alternating light/heavy)
  for (let i = 0; i < 8; i++) {
    spawnBody(w, {
      px: fromInt((i % 4) * 2 - 3),
      py: fromInt(1),
      pz: fromInt(i < 4 ? -4 : -6),
      radius: fromFloatConst(0.3),
      halfHeight: fromFloatConst(0.3),
      massClass: i % 2 === 0 ? MassClass.Light : MassClass.Heavy,
      flags: BodyFlag.Throwable,
    });
  }

  const terrain = makeArena(fromInt(0), fromInt(14), fromInt(3), fromFloatConst(0.5));
  const hazards: Hazard[] = [
    {
      kind: HazardKind.Crusher,
      ax: toRaw(fromInt(-5)), ay: toRaw(fromInt(1)), az: toRaw(fromInt(6)),
      bx: toRaw(fromInt(5)), by: toRaw(fromInt(1)), bz: toRaw(fromInt(6)),
      period: 180, phase: 0, radius: toRaw(fromFloatConst(1.3)),
      impulse: toRaw(fromFloatConst(0.35)), damage: toRaw(fromInt(1)),
    },
  ];
  const ctx: Partial<SimContext> = { terrain, hazards };
  return { sim: new Sim(w, ctx), localPlayerId: playerIds[0]!, playerIds, anchorId };
}
