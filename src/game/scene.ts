// ============================================================================
// src/game/scene.ts — build a playable scene (crews + anchors + objects + match).
// ============================================================================
//
// The game layer assembling sim primitives into a starting state: one or more
// CREWS, each with an Anchor (gold, heavy, the scoring VIP) and regular players
// with assigned ROLES, plus throwable objects, terrain, hazards, and the MATCH
// config (win condition, kill-plane). The sim owns how it all evolves.
//
// Deterministic: positions are authored Fixed constants; roles/crews are assigned
// round-robin; no spawn randomness.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass, Role } from '../sim/world/state.ts';
import { fromInt, fromFloatConst, toRaw } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena } from '../sim/collide/terrain.ts';
import { HazardKind, type Hazard } from '../sim/hazards/model.ts';
import { WinCondition, type MatchConfig } from './match.ts';

export interface SceneHandle {
  sim: Sim;
  /** The local player's body id (driven by the keyboard). */
  localPlayerId: number;
  playerIds: number[];
  /** Anchor body id per crew (index = crewId). */
  anchorIds: number[];
  /** The local player's crew. */
  localCrew: number;
}

/** Non-anchor role rotation for crew members. */
const CREW_ROLES: readonly Role[] = [Role.Runner, Role.Bulwark, Role.Mender, Role.Engineer, Role.Breaker];

export interface SandboxOpts {
  /** Players per crew (excluding the Anchor). */
  crewSize?: number;
  /** Number of crews (>=1). */
  numCrews?: number;
  /** Win condition. */
  winCondition?: WinCondition;
}

/** Build the sandbox scene. Defaults: 1 crew of 3 + Anchor, race to height 40. */
export function buildSandbox(crewSizeOrOpts: number | SandboxOpts = 3): SceneHandle {
  const opts: SandboxOpts = typeof crewSizeOrOpts === 'number' ? { crewSize: crewSizeOrOpts } : crewSizeOrOpts;
  const crewSize = Math.max(1, opts.crewSize ?? 3);
  const numCrews = Math.max(1, opts.numCrews ?? 1);

  const w = createWorld(128);
  const playerIds: number[] = [];
  const anchorIds: number[] = [];

  for (let c = 0; c < numCrews; c++) {
    const baseX = c * 8 - (numCrews - 1) * 4; // separate crews along X
    for (let i = 0; i < crewSize; i++) {
      playerIds.push(
        spawnBody(w, {
          px: fromInt(baseX + i * 2 - crewSize),
          py: fromInt(2), pz: fromInt(0),
          radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
          massClass: MassClass.Player, flags: BodyFlag.Player,
          crewId: c, role: CREW_ROLES[i % CREW_ROLES.length]!,
        }),
      );
    }
    anchorIds.push(
      spawnBody(w, {
        px: fromInt(baseX), py: fromInt(2), pz: fromInt(3),
        radius: fromFloatConst(0.55), halfHeight: fromFloatConst(1.0),
        massClass: MassClass.Anchor, flags: BodyFlag.Player | BodyFlag.Anchor,
        crewId: c, role: Role.Anchor,
      }),
    );
  }

  // a scatter of throwable objects (alternating light/heavy), no crew
  for (let i = 0; i < 8; i++) {
    spawnBody(w, {
      px: fromInt((i % 4) * 2 - 3), py: fromInt(1), pz: fromInt(i < 4 ? -4 : -6),
      radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
      massClass: i % 2 === 0 ? MassClass.Light : MassClass.Heavy, flags: BodyFlag.Throwable,
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

  const match: MatchConfig = {
    winCondition: opts.winCondition ?? WinCondition.RaceToHeight,
    targetHeight: toRaw(fromInt(40)),
    matchCap: 60 * 60 * 8,
    numCrews,
    killPlaneY: toRaw(fromInt(-12)),
  };

  const ctx: Partial<SimContext> = { terrain, hazards, match, anchorIds, groundY: toRaw(fromInt(0)) };
  return {
    sim: new Sim(w, ctx),
    localPlayerId: playerIds[0]!,
    playerIds,
    anchorIds,
    localCrew: 0,
  };
}
