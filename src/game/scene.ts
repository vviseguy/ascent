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
import { fromInt, fromFloatConst, toRaw, fromRaw, add } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena } from '../sim/collide/terrain.ts';
import { HazardKind, type Hazard } from '../sim/hazards/model.ts';
import { WinCondition, type MatchConfig } from './match.ts';
import { generateFloor } from '../floor/generate.ts';
import { compileTower, FLOOR_HEIGHT } from './tower.ts';

export interface SceneHandle {
  sim: Sim;
  /** The local player's body id (driven by the keyboard). */
  localPlayerId: number;
  playerIds: number[];
  /** Anchor body id per crew (index = crewId). */
  anchorIds: number[];
  /** The local player's crew. */
  localCrew: number;
  /**
   * VIEW-ONLY: world Y (raw Fixed) of each stratum's walkable surface, from the
   * compiled tower. Surfaced for the renderer's Coalescence reveal (docs/06 §2);
   * NOT sim state — the sandbox (flat arena) leaves it undefined.
   */
  stratumBaseY?: number[];
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

/**
 * Build a real TOWER scene: generate `numStrata` deterministic floors from a seed,
 * compile them into stacked terrain, and spawn one crew at stratum 0's entry. This
 * wires the floor generator into the playable game (the audit's `floor-module-not-
 * wired`). Win = race to the top stratum's height.
 */
export function buildTower(opts: { crewSize?: number; numStrata?: number; seed?: bigint } = {}): SceneHandle {
  const crewSize = Math.max(1, opts.crewSize ?? 3);
  const numStrata = Math.max(2, opts.numStrata ?? 5);
  const seed = opts.seed ?? 0x5a17ed_1234n;

  // generate + compile the tower
  const floors = [];
  for (let s = 0; s < numStrata; s++) {
    floors.push(generateFloor({ gridSize: 5, openness: 0.35, guaranteedRoutes: 2, seed, stratumIndex: s }));
  }
  const groundY = fromInt(0);
  const killPlaneY = fromInt(-10);
  const tower = compileTower(floors, 0, { groundY, killPlaneY });

  const w = createWorld(128);
  const playerIds: number[] = [];
  const anchorIds: number[] = [];
  // spawn at stratum 0's entry, slightly above the slab so they drop onto it
  const e0 = tower.entryXZ[0]!;
  const spawnY = fromRaw(tower.stratumBaseY[0]!);
  for (let i = 0; i < crewSize; i++) {
    playerIds.push(spawnBody(w, {
      px: fromRaw(e0.x), py: add(spawnY, fromInt(1)), pz: fromRaw(e0.z),
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player,
      crewId: 0, role: CREW_ROLES[i % CREW_ROLES.length]!,
    }));
  }
  anchorIds.push(spawnBody(w, {
    px: fromRaw(e0.x), py: add(spawnY, fromInt(1)), pz: fromRaw(e0.z),
    radius: fromFloatConst(0.55), halfHeight: fromFloatConst(1.0),
    massClass: MassClass.Anchor, flags: BodyFlag.Player | BodyFlag.Anchor,
    crewId: 0, role: Role.Anchor,
  }));

  // target height = top stratum's floor (raw → meters)
  const topBaseRaw = tower.stratumBaseY[numStrata - 1]!;
  const match: MatchConfig = {
    winCondition: WinCondition.RaceToHeight,
    targetHeight: topBaseRaw,
    matchCap: 60 * 60 * 10,
    numCrews: 1,
    killPlaneY: toRaw(killPlaneY),
    runSeed: seed,
    floorHeight: toRaw(FLOOR_HEIGHT),
    draftEveryFloors: 1, // a draft per stratum climbed
  };

  const ctx: Partial<SimContext> = {
    terrain: tower.terrain, hazards: [], match, anchorIds, groundY: toRaw(groundY),
  };
  return { sim: new Sim(w, ctx), localPlayerId: playerIds[0]!, playerIds, anchorIds, localCrew: 0, stratumBaseY: tower.stratumBaseY };
}
