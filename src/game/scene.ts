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
import { BREAKABLE_INTEGRITY } from '../sim/breakable/config.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena } from '../sim/collide/terrain.ts';
import { HazardKind, type Hazard } from '../sim/hazards/model.ts';
import { WinCondition, type MatchConfig } from './match.ts';
import { generateFloor } from '../floor/generate.ts';
import { compileTower, FLOOR_HEIGHT, GAME_GRID_SIZE } from './tower.ts';
import { compileCellTower, type CellFloor } from './cell-tower.ts';
import { generateEmergent } from '../floor/cell-emergent.ts';
import { resolveGrid } from '../floor/cell-grid.ts';

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
  /** VIEW-ONLY: per-stratum tile LAYOUT grid (from the compiled tower) so the renderer
   *  can place a KayKit dungeon tileset. NOT sim state. Undefined for the flat sandbox. */
  cellGrid?: import('./tower.ts').StratumCellGrid[];
  /** VIEW-ONLY: exact stair placements (origin/dir/width/run/rise) from the compiled tower so
   *  the renderer drops the KayKit staircase aligned to the sim collision. NOT sim state. */
  stairs?: import('./tower.ts').StairInfo[];
  /** VIEW-ONLY: puzzle-body spawn list (doors/keys/rugs) from the compiled tower so a later
   *  render pass can dress them. The bodies themselves ARE sim state (spawned in the world);
   *  this is just the placement metadata. Undefined for the flat sandbox. */
  puzzleSpawns?: import('./tower.ts').PuzzleSpawn[];
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

  // a few BREAKABLE props (crates/pots/barrels) the Breaker can smash for drops.
  // Heavy mass so they sit as solid obstacles; low integrity so a shove/rush/throw
  // clears them. Lined up off to one side, clear of the throwable scatter above.
  for (let i = 0; i < 4; i++) {
    spawnBody(w, {
      px: fromInt(i * 2 - 3), py: fromInt(1), pz: fromInt(8),
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.4),
      massClass: MassClass.Heavy, flags: BodyFlag.Breakable,
      health: BREAKABLE_INTEGRITY,
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
export function buildTower(opts: {
  crewSize?: number; numStrata?: number; seed?: bigint; gridSize?: number;
  /**
   * WHICH SUBSTRATE THE TOWER IS BUILT ON.
   *
   * '2u' is the cell model: hand-authored structures, real staircases the author drew, and walls that
   * own single edges. '4u' is the older tile lattice, kept because it still carries what the 2u path
   * has no equivalent for yet — room roles for decoration, and the puzzle bodies (locked doors, keys,
   * rugs). Neither is half-converted; they are two complete producers of the same IR, and the seam
   * they meet at is `StratumCellGrid.wallPlacements`.
   */
  substrate?: '2u' | '4u';
} = {}): SceneHandle {
  const crewSize = Math.max(1, opts.crewSize ?? 3);
  const numStrata = Math.max(2, opts.numStrata ?? 5);
  const seed = opts.seed ?? 0x5a17ed_1234n;
  const gridSize = Math.max(4, opts.gridSize ?? GAME_GRID_SIZE);
  const substrate = opts.substrate ?? '4u';

  const groundY = fromInt(0);
  const killPlaneY = fromInt(-10);

  let tower;
  if (substrate === '2u') {
    // TWICE the grid in each direction covers the same ground: a 2u cell is half a 4u tile.
    const cw = gridSize * 2, ch = gridSize * 2;
    const cellFloors: CellFloor[] = [];
    for (let s = 0; s < numStrata; s++) {
      const r = generateEmergent({ width: cw, height: ch, seed: seed + BigInt(s) });
      cellFloors.push({ cells: resolveGrid(r.grid), width: cw, height: ch, entry: r.entry, exit: r.exit });
    }
    const t = compileCellTower(cellFloors, 0, { groundY, killPlaneY });
    if (t.strataWithoutStairs.length) {
      // said out loud rather than silently producing a tower you cannot climb
      console.warn(`[tower] no way up from stratum ${t.strataWithoutStairs.join(', ')} — no stair flight on that floor`);
    }
    tower = t;
  } else {
    const floors = [];
    for (let s = 0; s < numStrata; s++) {
      // openness 0.40 = "40% edges": ~40% of interior seams get an extra connection, so the
      // now-SOLID Layer-C walls don't read as a claustrophobic maze (more doorways/openings).
      floors.push(generateFloor({ gridSize, openness: 0.40, guaranteedRoutes: 2, seed, stratumIndex: s }));
    }
    tower = compileTower(floors, 0, { groundY, killPlaneY });
  }

  // Capacity headroom for crew + breakables + the floor's puzzle bodies (doors/keys/rugs
  // across all strata, plus revealed-key drops). 256 = MAX_ENTITIES; sized to never throw.
  const w = createWorld(256);
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

  // BREAKABLE props (crates/pots/barrels): ~8 destructibles scattered across
  // stratum 0's floor near the entry, for the Breaker to smash into item drops.
  // A 3×3-ish grid (minus the center cell, kept clear for the spawn cluster), each
  // just above the slab so it settles onto the floor. Heavy mass = solid obstacle;
  // low integrity (BREAKABLE_INTEGRITY) so a shove/rush/throw clears it. Positions
  // are authored Fixed offsets — no spawn randomness (deterministic).
  const propHalf = fromFloatConst(0.4);
  const dropY = add(spawnY, fromFloatConst(0.5)); // base ~rests on the slab
  let placed = 0;
  for (let gx = -1; gx <= 1 && placed < 8; gx++) {
    for (let gz = -1; gz <= 1 && placed < 8; gz++) {
      if (gx === 0 && gz === 0) continue; // leave the center clear (crew spawns there)
      spawnBody(w, {
        px: add(fromRaw(e0.x), fromInt(gx * 3)),
        py: dropY,
        pz: add(fromRaw(e0.z), fromInt(gz * 3)),
        radius: propHalf, halfHeight: propHalf,
        massClass: MassClass.Heavy, flags: BodyFlag.Breakable,
        health: BREAKABLE_INTEGRITY,
      });
      placed++;
    }
  }

  // PUZZLE BODIES (docs/14 §2): spawn each locked DOOR / KEY / RUG the floor generator
  // placed (tower.puzzleSpawns). These are deterministic sim entities (hashed doorId /
  // lockState / rugRevealed), so rollback-safe:
  //  - DOOR: a heavy, near-immovable solid plug filling the doorway seam, flagged Door +
  //    locked. The interaction door hook opens it (kills it) when a player uses the
  //    matching key. Anchor mass + the doorway's terrain walls on both sides keep it from
  //    being shoved aside, so it functions as a wall until unlocked.
  //  - KEY : a loose Key Pickup body carrying the doorId it opens (picked into the hotbar).
  //  - RUG : a movable Throwable + Rug body; interacting (or shoving it off its tile)
  //    reveals its hidden key (spawns a Key Pickup for its doorId).
  const doorHalf = fromFloatConst(1.0);
  const itemHalf = fromFloatConst(0.3);
  const rugHalf = fromFloatConst(0.45);
  for (const ps of tower.puzzleSpawns ?? []) {
    if (ps.kind === 'door') {
      spawnBody(w, {
        px: fromRaw(ps.x), py: fromRaw(ps.y), pz: fromRaw(ps.z),
        radius: fromFloatConst(0.8), halfHeight: doorHalf,
        massClass: MassClass.Anchor, // heaviest → barely budges (a wedged plug)
        flags: BodyFlag.Door,
        doorId: ps.doorId, lockState: 1, // starts LOCKED
      });
    } else if (ps.kind === 'key') {
      spawnBody(w, {
        px: fromRaw(ps.x), py: fromRaw(ps.y), pz: fromRaw(ps.z),
        radius: itemHalf, halfHeight: itemHalf,
        massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Pickup,
        health: fromInt(1), doorId: ps.doorId, // the door this key opens
      });
    } else { // rug
      spawnBody(w, {
        px: fromRaw(ps.x), py: fromRaw(ps.y), pz: fromRaw(ps.z),
        radius: rugHalf, halfHeight: fromFloatConst(0.1), // a flat movable mat
        massClass: MassClass.Light, flags: BodyFlag.Throwable | BodyFlag.Rug,
        health: fromInt(1), doorId: ps.doorId, // the door the hidden key opens
      });
    }
  }

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
  return {
    sim: new Sim(w, ctx), localPlayerId: playerIds[0]!, playerIds, anchorIds, localCrew: 0,
    stratumBaseY: tower.stratumBaseY, ...(tower.cellGrid ? { cellGrid: tower.cellGrid } : {}),
    ...(tower.stairs.length ? { stairs: tower.stairs } : {}),
    ...(tower.puzzleSpawns && tower.puzzleSpawns.length ? { puzzleSpawns: tower.puzzleSpawns } : {}),
  };
}
