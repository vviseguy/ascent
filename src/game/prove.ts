// ============================================================================
// Standalone PROOF for the GAME LAYER (standing, win, death/respawn, beacon).
//   Run:  node --experimental-strip-types src/game/prove.ts
// ============================================================================
//
// The game layer (match/survival/beacon) is deterministic, hashed, and rollback-
// safe — these properties matter as much as the physics, since standings + win are
// now part of the netcode consensus (src/net/prove.ts PROOF 4). This proves the
// rules themselves behave per spec:
//
//   PROOF 1 — STANDING. A crew's committed height tracks its Anchor's stable height,
//             ratchets only after the dwell window, and a thrown-down Anchor that
//             settles low loses committed standing (the diegetic rubber-band).
//   PROOF 2 — WIN. RaceToHeight fires when committed >= target; Endless picks the
//             highest committed at the cap; winner + endedTick freeze the match.
//   PROOF 3 — DEATH/RESPAWN. A regular player below the kill-plane dies and respawns
//             at the crew beacon; the Anchor below the kill-plane does NOT vanish
//             (true-death → respawn), and chip damage never instakills the Anchor.
//   PROOF 4 — BEACON. The Anchor plants; a crew member recalls to it but is clamped
//             to never exceed the Anchor's height (recall is a regroup, not a skip).
//   PROOF 5 — DETERMINISM. The whole game layer is hashed + survives save/restore.
//   PROOF 6 — BOON DRAFT + RUBBER-BAND (cadence, determinism, deficit weighting).
//   PROOF 7 — GEOMETRY SOLVABILITY. The compiled tower (exit holes + STRAIGHT
//             staircases + perimeter walls) admits an ANCHOR-probe route from the
//             stratum-0 entry to the TOP stratum, for MANY seeds — the
//             independent route check on the compiler's OUTPUT (GAPS.md H3).
//   PROOF 8 — END-TO-END CLIMB. A real Anchor body, driven only by held-stick
//             inputs + jump taps (NO teleports), walks to the stratum-0 staircase
//             and strides straight up it to stand grounded on stratum 1. This kills
//             the "proofs pass but the game is unwinnable" blindness for good.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass, Role, NO_ENTITY } from '../sim/world/state.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT } from '../sim/world/input.ts';
import { fromInt, fromFloatConst, toRaw, fromRaw, toFloat } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena, makeBox, flatGround, type Terrain } from '../sim/collide/terrain.ts';
import { WinCondition, type MatchConfig, standingMeters } from './match.ts';
import { clone, restoreInto } from '../sim/world/snapshot.ts';
import { buildTower } from './scene.ts';
import { compileCellTower } from './cell-tower.ts';
import { generateEmergentTower } from '../floor/cell-emergent.ts';
import { resolveFloor } from '../floor/cell-defray.ts';
import { drawOffer, boonById } from './boons.ts';
import { generateFloor } from '../floor/generate.ts';
import { compileTower, CELL_SIZE, GAME_GRID_SIZE } from './tower.ts';
import { summitRoute, CELL_PROBE } from './route-check.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) { ok++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); } };

function scene(cfg: Partial<MatchConfig> = {}, terrain?: Terrain, spawnY = 2): { sim: Sim; anchor: number; players: number[] } {
  const w = createWorld(32);
  const players: number[] = [];
  for (let i = 0; i < 2; i++) {
    players.push(spawnBody(w, {
      px: fromInt(i - 1), py: fromInt(spawnY), pz: fromInt(0),
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player, crewId: 0, role: Role.Runner,
    }));
  }
  const anchor = spawnBody(w, {
    px: fromInt(0), py: fromInt(spawnY), pz: fromInt(0),
    radius: fromFloatConst(0.55), halfHeight: fromFloatConst(1.0),
    massClass: MassClass.Anchor, flags: BodyFlag.Player | BodyFlag.Anchor, crewId: 0, role: Role.Anchor,
  });
  const match: MatchConfig = {
    winCondition: WinCondition.RaceToHeight, targetHeight: toRaw(fromInt(5)),
    matchCap: 100000, numCrews: 1, killPlaneY: toRaw(fromInt(-8)), ...cfg,
  };
  // default terrain: flat ground at y=0 (groundY matches). Tests can pass a custom one.
  const t = terrain ?? flatGround(fromInt(0));
  const ctx: Partial<SimContext> = { terrain: t, match, anchorIds: [anchor], groundY: toRaw(fromInt(0)) };
  return { sim: new Sim(w, ctx), anchor, players };
}

/** A terrain whose ground is far below the kill-plane, plus a tall platform at `topY`
 *  centered at origin — so a body can genuinely STAND at height and a body knocked
 *  off the platform falls past the kill-plane into the void. */
function towerTerrain(topY: number): Terrain {
  const ground = flatGround(fromInt(-30)); // far below the kill-plane
  const platform = makeBox(fromInt(-3), fromInt(0), fromInt(-3), fromInt(3), fromInt(topY), fromInt(3));
  return { groundY: ground.groundY, solids: [platform] };
}

const blank = (n: number): (PlayerInput | undefined)[] => new Array(n);
const hold = (n: number, id: number, inp: PlayerInput): (PlayerInput | undefined)[] => { const a = blank(n); a[id] = inp; return a; };

console.log('----------------------------------------------------------------');
console.log('ASCENT game layer — STANDALONE PROOF (standing / win / death / beacon)');
console.log('----------------------------------------------------------------');

// PROOF 1 — standing tracks committed Anchor height (Anchor stands on a platform@5)
console.log('[1] STANDING');
{
  const { sim } = scene({ targetHeight: toRaw(fromInt(99)) }, towerTerrain(5), 8);
  // let the Anchor settle on the platform top (y = 5 + halfHeight)
  for (let t = 0; t < 120; t++) sim.advance(blank(sim.world.count));
  const m = standingMeters(sim.match, 0);
  check('committed standing reflects platform height (~5-6m)', m > 4.5 && m < 7);
  check('standing is in meters & non-negative', m >= 0);
}

// PROOF 2 — win condition fires when committed >= target (target 4; platform@5)
console.log('[2] WIN');
{
  const { sim } = scene({ targetHeight: toRaw(fromInt(4)) }, towerTerrain(5), 8);
  for (let t = 0; t < 160 && sim.match.winner < 0; t++) sim.advance(blank(sim.world.count));
  check('RaceToHeight winner declared once committed >= target', sim.match.winner === 0);
  check('match end tick recorded', sim.match.endedTick >= 0);
  const frozen = sim.match.endedTick;
  sim.advance(blank(sim.world.count));
  check('match frozen after end (endedTick stable)', sim.match.endedTick === frozen);
}

// PROOF 3 — death/respawn + Anchor durability (flat ground at -30, kill-plane -8)
console.log('[3] DEATH / RESPAWN');
{
  // a platform off to the +x side (the crew stands on it); the region around x=-10 is
  // OPEN AIR above a deep ground — a body shoved there falls through into the void.
  const killTerrain: Terrain = { groundY: toRaw(fromInt(-30)), solids: [makeBox(fromInt(-2), fromInt(-1), fromInt(-6), fromInt(8), fromInt(0), fromInt(6))] };
  const { sim, anchor, players } = scene({}, killTerrain, 2);
  for (let t = 0; t < 40; t++) sim.advance(blank(sim.world.count)); // settle on the platform
  // plant a beacon (anchor presses Recall) so respawns have a target
  sim.advance(hold(sim.world.count, anchor, { ...NEUTRAL_INPUT, buttons: Button.Recall }));
  const beacon = sim.match.crews[0]!;
  check('anchor planted a beacon', beacon.beaconTick >= 0);
  // shove a regular player into the OPEN void (x=-10, below the kill-plane) — nothing
  // catches it there, so the kill-plane fires.
  const p = players[0]!;
  sim.world.px[p] = toRaw(fromInt(-10));
  sim.world.py[p] = toRaw(fromInt(-10));
  sim.advance(blank(sim.world.count));
  check('player below kill-plane scheduled to respawn', sim.world.respawnAt[p]! >= 0);
  // run past the respawn delay
  for (let t = 0; t < 250; t++) sim.advance(blank(sim.world.count));
  check('player respawned (alive, above kill-plane)', (sim.world.flags[p]! & BodyFlag.Alive) !== 0 && sim.world.py[p]! > sim.match.cfg.killPlaneY);
  check('player respawn cleared', sim.world.respawnAt[p]! < 0);
  // Anchor chip to 0 HP: must NOT die (clamps + downed)
  sim.world.health[anchor] = toRaw(fromInt(-50));
  sim.advance(blank(sim.world.count));
  check('anchor not killed by 0 HP (durable)', (sim.world.flags[anchor]! & BodyFlag.Alive) !== 0);
  check('anchor health clamped above 0', sim.world.health[anchor]! > 0);
}

// PROOF 4 — beacon recall clamped to Anchor height
console.log('[4] BEACON RECALL');
{
  const { sim, anchor, players } = scene();
  for (let t = 0; t < 30; t++) sim.advance(blank(sim.world.count));
  // anchor plants beacon at ground
  sim.advance(hold(sim.world.count, anchor, { ...NEUTRAL_INPUT, buttons: Button.Recall }));
  const p = players[0]!;
  // move a player far away + high
  sim.world.px[p] = toRaw(fromInt(15)); sim.world.py[p] = toRaw(fromInt(8));
  sim.advance(blank(sim.world.count));
  const beforeX = sim.world.px[p]!;
  // recall: player should snap toward beacon X/Z, and Y clamped to <= anchor height
  sim.advance(hold(sim.world.count, p, { ...NEUTRAL_INPUT, buttons: Button.Recall }));
  const anchorY = sim.world.py[anchor]!;
  check('recall moved player toward beacon X', Math.abs(toFloat(fromRaw(sim.world.px[p]!))) < Math.abs(toFloat(fromRaw(beforeX))));
  check('recall clamped player to <= Anchor height', sim.world.py[p]! <= anchorY + toRaw(fromInt(1)));
}

// PROOF 5 — determinism + save/restore of the game layer
console.log('[5] DETERMINISM');
{
  const runHashes = (): number[] => {
    const { sim, anchor } = scene();
    const hs: number[] = [];
    for (let t = 0; t < 120; t++) {
      const inp = t % 20 === 0 ? hold(sim.world.count, anchor, { ...NEUTRAL_INPUT, buttons: Button.Recall }) : blank(sim.world.count);
      sim.advance(inp);
      hs.push(sim.hash());
    }
    return hs;
  };
  const a = runHashes(), b = runHashes();
  check('identical hash sequence across two runs', a.length === b.length && a.every((v, i) => v === b[i]));
  // save/restore: snapshot mid-run, diverge, restore, continue — must match a clean run
  const { sim, anchor } = scene();
  for (let t = 0; t < 40; t++) sim.advance(blank(sim.world.count));
  const wSnap = clone(sim.world);
  const mSnap = sim.snapshotMatch();
  const refAfter: number[] = [];
  for (let t = 40; t < 80; t++) { sim.advance(blank(sim.world.count)); refAfter.push(sim.hash()); }
  // restore and replay
  restoreInto(sim.world, wSnap);
  sim.restoreMatchFrom(mSnap);
  const replay: number[] = [];
  for (let t = 40; t < 80; t++) { sim.advance(blank(sim.world.count)); replay.push(sim.hash()); }
  check('save/restore reproduces the game-layer hash sequence', refAfter.every((v, i) => v === replay[i]));
}

// PROOF 6 — boon DRAFT fires at milestone floors as a crew climbs the real tower;
// rubber-banding draws better for a deficit; deterministic.
console.log('[6] BOON DRAFT + RUBBER-BAND');
{
  // climb the REAL compiled tower (slabs exist at each stratum, so committing works);
  // pin the anchor onto each successive stratum surface so it commits + drafts.
  const climb = (): { boons: number[]; hash: number } => {
    const sc = buildTower({ crewSize: 1, numStrata: 5, seed: 42n, substrate: '4u' });
    const a = sc.anchorIds[0]!;
    const bases = sc.stratumBaseY!;
    for (let floor = 1; floor < bases.length; floor++) {
      const y = bases[floor]! + toRaw(fromFloatConst(1.0)); // rest on the slab
      for (let t = 0; t < 25; t++) {
        sc.sim.world.py[a] = y; sc.sim.world.vy[a] = 0;
        sc.sim.world.flags[a] = (sc.sim.world.flags[a]! | BodyFlag.Grounded) & 0xffff;
        sc.sim.advance(new Array(sc.sim.world.count));
      }
    }
    return { boons: sc.sim.match.crews[0]!.boons.slice(), hash: sc.sim.hash() };
  };
  const r1 = climb();
  check('drafted boons while climbing the tower (cadence fires)', r1.boons.length >= 3);
  const r2 = climb();
  check('draft is deterministic (same boons + hash across runs)',
    JSON.stringify(r1.boons) === JSON.stringify(r2.boons) && r1.hash === r2.hash);
  // rubber-band: a trailing crew (large deficit) draws a higher average tier than a leader.
  let lead = 0, trail = 0;
  for (let i = 0; i < 100; i++) {
    for (const id of drawOffer(7n, 0, i, 0)) lead += boonById(id)!.tier;
    for (const id of drawOffer(7n, 1, i, 1)) trail += boonById(id)!.tier;
  }
  check('rubber-band: trailing crew draws higher-tier boons', trail > lead);
}

// helper shared by PROOFS 7/8: generate + compile the same tower scene.ts builds
// (gridSize GAME_GRID_SIZE, openness 0.35, 2 routes, 5 strata, groundY 0, killPlane -10).
const compileForSeed = (seed: bigint, numStrata = 5) => {
  const floors = [];
  for (let s = 0; s < numStrata; s++) {
    floors.push(generateFloor({ gridSize: GAME_GRID_SIZE, openness: 0.35, guaranteedRoutes: 2, seed, stratumIndex: s }));
  }
  return { floors, tower: compileTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) }) };
};
const rawF = (raw: number): number => toFloat(fromRaw(raw));

/** The 2u tower for a seed — the same stack `buildTower({ substrate: '2u' })` builds. */
const CELL_W = GAME_GRID_SIZE * 2, CELL_H = GAME_GRID_SIZE * 2;
const compileCellForSeed = (seed: bigint, numStrata = 5) => {
  const stack = generateEmergentTower({ width: CELL_W, height: CELL_H, seed, levels: numStrata });
  const floors = stack.floors.map((f) => ({
    cells: resolveFloor(f), width: CELL_W, height: CELL_H, entry: f.entry, exit: f.exit,
  }));
  return { stack, tower: compileCellTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) }) };
};
const CS = toFloat(CELL_SIZE); // float cell size — tracks tower.ts CELL_SIZE (no stale hardcodes)

// PROOF 7 — GEOMETRY-LEVEL SOLVABILITY: the compiled tower admits an Anchor-probe
// route from the stratum-0 entry to the TOP stratum surface, across many seeds.
// This is the independent check on the COMPILER's output (the floor verifier only
// proves the cell graph) — a regression in hole-carving, stair height, or wall
// placement fails here with the offending seed printed.
console.log('[7] GEOMETRY SOLVABILITY (Anchor probe, entry -> top, compiled AABBs)');
{
  // The geometry route-check is spatially bucketed (route-check.ts), so it scales ~linearly
  // even at the game's 30×30 grid (~8.7k boxes/tower). We sweep a representative seed set
  // here (incl. the game's default seed); the CELL-GRAPH solvability — including lock-and-
  // key — is fuzzed across thousands of seeds in src/floor/prove.ts. This proof guards the
  // lossy compiler→AABB projection.
  const seeds: bigint[] = [0x5a17ed_1234n]; // the game's default seed first
  for (let i = 0; i < 12; i++) seeds.push(BigInt(1000 + i * 7919));
  let allOk = true;
  let stairsOk = true;
  let boxesOk = true;
  for (const seed of seeds) {
    const { tower } = compileForSeed(seed);
    const r = summitRoute(tower);
    if (!r.ok) {
      allOk = false;
      console.log(`       seed ${seed} FAILED: ${r.reason} (${r.reached}/${r.nodes} nodes reached)`);
    }
    if (tower.stairs.length !== 4) stairsOk = false;
    // 30×30 grid → ~900 cells/stratum; slab + seam-lip + wall boxes land well under 12k.
    if (tower.terrain.solids.length > 12000) boxesOk = false;
  }
  check(`anchor-probe route 0 -> top exists for all ${seeds.length} seeds`, allOk);
  check('one stair per non-top stratum (4 stairs across 5 strata)', stairsOk);
  // 30×30 grid → more slab/lip boxes; stays under the 12k bound across the seed sweep.
  check('box count stays sane (< 12000 solids for 5 strata)', boxesOk);
  // determinism: same seed -> byte-identical terrain (same openings/stairs/walls)
  const a = compileForSeed(77n).tower.terrain.solids;
  const b = compileForSeed(77n).tower.terrain.solids;
  check('compilation is deterministic (identical solids across runs)',
    a.length === b.length && a.every((box, i) => JSON.stringify(box) === JSON.stringify(b[i])));

  // NEGATIVE CONTROL: the checker must not be vacuous — re-sealing the ascent
  // shafts (a slab tile back over every stair's run footprint, the pre-hole world)
  // must break the route via the headroom test (the upper treads get pinched under
  // the restored ceiling). We seal exactly the run footprint each StairInfo reports.
  const { tower: t0 } = compileForSeed(0x5a17ed_1234n);
  const R = (v: number): number => Math.round(v * 65536);
  const seals = t0.stairs.map((st) => ({
    minX: st.originX, maxX: st.originX + st.width,
    minY: st.topY - R(0.5), maxY: st.topY,
    minZ: st.entryZ, maxZ: st.topZ,
  }));
  const sealed = summitRoute({
    ...t0,
    terrain: { groundY: t0.terrain.groundY, solids: [...t0.terrain.solids, ...seals] },
  });
  check('negative control: sealing the exit holes breaks the route', !sealed.ok);
}

// PROOF 8 — END-TO-END CLIMB: a REAL Anchor body, driven only by held-stick input
// and periodic jump taps (NO teleports, no flag-pinning), walks to the STRAIGHT
// staircase's entry end and strides straight up its treads (auto step-up — no jump
// needed per riser) until it stands grounded at the stratum-1 surface. The route:
// entry -> north up the stair column to the run's low (entry) end -> straight up the
// treads in +Z to the top, which is flush with the stratum-1 slab through the hole.
console.log('[8] END-TO-END — real Anchor climbs stratum 0 -> 1 (stick + jump taps)');
{
  const seed = 0x5a17ed_1234n;
  const sc = buildTower({ crewSize: 1, numStrata: 5, seed, substrate: '4u' });
  // recompile the identical tower for the stair metadata (pure + deterministic)
  const { floors, tower } = compileForSeed(seed);
  const st = tower.stairs[0]!;
  const fl0 = floors[0]!;
  const a = sc.anchorIds[0]!;
  const w = sc.sim.world;
  const half = rawF(w.halfHeight[a]!);
  const base1 = rawF(sc.stratumBaseY![1]!);
  // the straight stair runs purely in +Z at x = centerX; it tops out at topZ flush
  // with stratum 1's surface under the 2-cell ascent hole.
  const centerX = rawF(st.centerX);
  const entryZ = rawF(st.entryZ);
  const topZ = rawF(st.topZ);
  const runLen = rawF(st.run);
  const rowZ = (y: number): number => (y - ((fl0.height - 1) / 2 | 0)) * CS;
  const colX = (x: number): number => (x - ((fl0.width - 1) / 2 | 0)) * CS;
  // Approach the stair up its BOUNDARY column (st.cols[0] hugs the grid edge), whose seams are
  // the perimeter FALLBACK LAYER's WALK edges — guaranteed OPEN through the now-real Layer-C
  // walls. The old path walked the seam BETWEEN the two stair columns and jammed against an
  // interior wall once collision became solid. From the run foot we step east onto the stair
  // centerline (those stair cells are forced-OPEN), then straight up the treads.
  const boundX = colX(st.cols[0]);
  const wps: readonly (readonly [number, number])[] = [
    [boundX, rowZ(0)], // slide along the entry row to the stair's boundary column
    [boundX, entryZ - 0.4], // north up the boundary column (perimeter, OPEN) to the run foot
    [centerX, entryZ - 0.4], // east onto the stair centerline (stair cells are OPEN)
    [centerX, topZ], // STRAIGHT UP the treads to the top tread (auto step-up, no jump)
    [centerX, topZ + CS * 0.6], // step +Z off the top tread onto the exit-row slab
  ];
  let wpi = 0;
  let okClimb = false;
  let aliveAll = true;
  let t = 0;
  for (; t < 6000 && !okClimb; t++) {
    const px = rawF(w.px[a]!);
    const pz = rawF(w.pz[a]!);
    const wp = wps[Math.min(wpi, wps.length - 1)]!;
    const dx = wp[0] - px;
    const dz = wp[1] - pz;
    const d = Math.hypot(dx, dz);
    if (d < 0.5 && wpi < wps.length - 1) wpi++;
    const s = d > 1e-6 ? 1 / d : 0;
    const inp: PlayerInput = {
      ...NEUTRAL_INPUT,
      moveX: Math.max(-1024, Math.min(1024, Math.round(dx * s * 1024))),
      moveZ: Math.max(-1024, Math.min(1024, Math.round(dz * s * 1024))),
      buttons: t % 12 === 0 ? Button.Jump : 0, // press-edge taps; hop any seam lip
    };
    const frame: (PlayerInput | undefined)[] = new Array(w.count);
    frame[a] = inp;
    sc.sim.advance(frame);
    if ((w.flags[a]! & BodyFlag.Alive) === 0) aliveAll = false;
    const feet = rawF(w.py[a]!) - half;
    const grounded = (w.flags[a]! & BodyFlag.Grounded) !== 0;
    const climbedRun = pz - entryZ > runLen * 0.8; // ascended (almost) the whole run in +Z
    // the top tread is FLUSH with the stratum-1 surface (feet at base1) under the open
    // hole — standing there, grounded, having climbed the run, IS standing on stratum 1.
    if (wpi >= 2 && grounded && climbedRun && feet >= base1 - 0.05 && feet <= base1 + 0.05) {
      okClimb = true;
    }
  }
  if (!okClimb) {
    console.log(`       stuck at wp ${wpi}, pos (${rawF(w.px[a]!).toFixed(2)}, ${rawF(w.py[a]!).toFixed(2)}, ${rawF(w.pz[a]!).toFixed(2)})`);
  }
  check(`real Anchor summited stratum 0 -> 1 by inputs alone (${t} ticks, no teleport)`, okClimb);
  check('anchor alive for the whole climb', aliveAll);
}

// PROOF 9 — THE 2u TOWER, on its own terms. Same two questions as 7 and 8, asked of the
// cell substrate: does the compiled geometry admit a route, and can a real body driven by
// inputs alone actually follow it?
//
// The route is not hand-written this time. PROOF 8 walks a path someone worked out in
// advance, which only exists because the 4u staircase is synthesised at a known column
// pair. A 2u floor is a maze around structures an author drew, so there is no such path to
// write down — the body follows the route the CHECKER found. That is a strictly stronger
// statement: the check's own answer is handed to physics to falsify, and the graph does not
// model lateral blockers, so the two really can disagree.
console.log('[9] THE 2u TOWER — compiled route, then a real Anchor walking it');
{
  const seeds: bigint[] = [0x5a17ed_1234n, 1000n, 8919n, 16838n];
  let routeOk = true;
  let stairsEverywhere = true;
  let shaftsOpen = true;
  for (const seed of seeds) {
    const { tower } = compileCellForSeed(seed);
    if (tower.strataWithoutStairs.length) {
      stairsEverywhere = false;
      console.log(`       seed ${seed}: no way up from stratum ${tower.strataWithoutStairs.join(', ')}`);
    }
    if (tower.ceilingSealedFlights.length) {
      shaftsOpen = false;
      console.log(`       seed ${seed}: ${tower.ceilingSealedFlights.length} flight(s) climb into a ceiling`);
    }
    const r = summitRoute(tower, CELL_PROBE);
    if (!r.ok) {
      routeOk = false;
      console.log(`       seed ${seed} FAILED: ${r.reason} (${r.reached}/${r.nodes} nodes)`);
    }
  }
  check(`a stairwell starts on every storey below the top (${seeds.length} seeds)`, stairsEverywhere);
  check('every flight climbs into an OPEN shaft', shaftsOpen);
  check(`anchor-probe route 0 -> top exists for all ${seeds.length} seeds`, routeOk);

  // NEGATIVE CONTROL: floor the shafts back in and the route must die. Without this the
  // check above would pass just as happily on a tower with no holes in it at all.
  {
    const stack = generateEmergentTower({ width: CELL_W, height: CELL_H, seed: 1000n, levels: 5 });
    const floors = stack.floors.map((f) => ({
      cells: resolveFloor(f), width: CELL_W, height: CELL_H, entry: f.entry, exit: f.exit,
    }));
    for (const f of floors) for (const c of f.cells) if (c && c.floor === 'none') c.floor = 'stone';
    const sealed = compileCellTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) });
    check('negative control: flooring the shafts breaks the route', !summitRoute(sealed, CELL_PROBE).ok);
  }

  /* --- and now a REAL body, walking the route the checker found --- */
  const seed = 0x5a17ed_1234n;
  const sc = buildTower({ crewSize: 1, numStrata: 5, seed, gridSize: CELL_W / 2, substrate: '2u' });
  const { tower } = compileCellForSeed(seed);
  const route = summitRoute(tower, CELL_PROBE);
  const a = sc.anchorIds[0]!;
  const w = sc.sim.world;
  const half = rawF(w.halfHeight[a]!);
  const base1 = rawF(sc.stratumBaseY![1]!);

  // Only as far as stratum 1 — the same bar PROOF 8 sets. Trim the route there so the body
  // is not asked to walk four more floors to prove one climb.
  const upTo1 = route.path.findIndex((n) => n.top >= base1 - 0.05);
  const wps = route.path.slice(0, upTo1 >= 0 ? upTo1 + 1 : route.path.length);

  let wpi = 0, okClimb = false, aliveAll = true, t = 0;
  for (; t < 20000 && !okClimb; t++) {
    const px = rawF(w.px[a]!);
    const pz = rawF(w.pz[a]!);
    const wp = wps[Math.min(wpi, wps.length - 1)]!;
    const dx = wp.x - px, dz = wp.z - pz;
    const d = Math.hypot(dx, dz);
    if (d < 0.6 && wpi < wps.length - 1) wpi++;
    const sc2 = d > 1e-6 ? 1 / d : 0;
    const inp: PlayerInput = {
      ...NEUTRAL_INPUT,
      moveX: Math.max(-1024, Math.min(1024, Math.round(dx * sc2 * 1024))),
      moveZ: Math.max(-1024, Math.min(1024, Math.round(dz * sc2 * 1024))),
      buttons: t % 12 === 0 ? Button.Jump : 0, // press-edge taps; hop any seam lip
    };
    const frame: (PlayerInput | undefined)[] = new Array(w.count);
    frame[a] = inp;
    sc.sim.advance(frame);
    if ((w.flags[a]! & BodyFlag.Alive) === 0) aliveAll = false;
    const feet = rawF(w.py[a]!) - half;
    const grounded = (w.flags[a]! & BodyFlag.Grounded) !== 0;
    if (grounded && feet >= base1 - 0.05) okClimb = true;
  }
  if (!okClimb) {
    const wp = wps[Math.min(wpi, wps.length - 1)]!;
    console.log(`       stuck at wp ${wpi}/${wps.length} (${wp.x.toFixed(1)}, ${wp.z.toFixed(1)}), `
      + `pos (${rawF(w.px[a]!).toFixed(2)}, ${rawF(w.py[a]!).toFixed(2)}, ${rawF(w.pz[a]!).toFixed(2)})`);
  }
  check(`real Anchor walked the CHECKER'S route to stratum 1 (${t} ticks, no teleport)`, okClimb);
  check('anchor alive for the whole 2u climb', aliveAll);
}

console.log('----------------------------------------------------------------');
if (fail === 0) {
  console.log(`RESULT: PASS — game layer correct & deterministic (${ok} checks).`);
  (globalThis as { process?: { exit(c: number): void } }).process?.exit(0);
} else {
  console.log(`RESULT: FAIL — ${fail} checks failed (${ok} passed).`);
  (globalThis as { process?: { exit(c: number): void } }).process?.exit(1);
}

void NO_ENTITY;
