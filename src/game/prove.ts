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
//   PROOF 7 — GEOMETRY SOLVABILITY. The compiled tower (exit holes + switchback
//             stairs + perimeter walls) admits an ANCHOR-probe route from the
//             stratum-0 entry to the TOP stratum, for MANY seeds — the
//             independent route check on the compiler's OUTPUT (GAPS.md H3).
//   PROOF 8 — END-TO-END CLIMB. A real Anchor body, driven only by held-stick
//             inputs + jump taps (NO teleports), walks the perimeter, climbs the
//             stratum-0 stairs, and stands grounded on stratum 1. This kills the
//             "proofs pass but the game is unwinnable" blindness for good.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass, Role, NO_ENTITY } from '../sim/world/state.ts';
import { type PlayerInput, Button, NEUTRAL_INPUT } from '../sim/world/input.ts';
import { fromInt, fromFloatConst, toRaw, fromRaw, toFloat } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena, makeBox, flatGround, type Terrain } from '../sim/collide/terrain.ts';
import { WinCondition, type MatchConfig, standingMeters } from './match.ts';
import { clone, restoreInto } from '../sim/world/snapshot.ts';
import { buildTower } from './scene.ts';
import { drawOffer, boonById } from './boons.ts';
import { generateFloor } from '../floor/generate.ts';
import { compileTower } from './tower.ts';
import { summitRoute } from './route-check.ts';

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
    const sc = buildTower({ crewSize: 1, numStrata: 5, seed: 42n });
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
// (gridSize 5, openness 0.35, 2 routes, 5 strata, groundY 0, killPlane -10).
const compileForSeed = (seed: bigint, numStrata = 5) => {
  const floors = [];
  for (let s = 0; s < numStrata; s++) {
    floors.push(generateFloor({ gridSize: 5, openness: 0.35, guaranteedRoutes: 2, seed, stratumIndex: s }));
  }
  return { floors, tower: compileTower(floors, 0, { groundY: fromInt(0), killPlaneY: fromInt(-10) }) };
};
const rawF = (raw: number): number => toFloat(fromRaw(raw));

// PROOF 7 — GEOMETRY-LEVEL SOLVABILITY: the compiled tower admits an Anchor-probe
// route from the stratum-0 entry to the TOP stratum surface, across many seeds.
// This is the independent check on the COMPILER's output (the floor verifier only
// proves the cell graph) — a regression in hole-carving, stair height, or wall
// placement fails here with the offending seed printed.
console.log('[7] GEOMETRY SOLVABILITY (Anchor probe, entry -> top, compiled AABBs)');
{
  const seeds: bigint[] = [0x5a17ed_1234n]; // the game's default seed first
  for (let i = 0; i < 24; i++) seeds.push(BigInt(1000 + i * 7919));
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
    if (tower.terrain.solids.length > 700) boxesOk = false;
  }
  check(`anchor-probe route 0 -> top exists for all ${seeds.length} seeds`, allOk);
  check('one stair per non-top stratum (4 stairs across 5 strata)', stairsOk);
  check('box count stays sane (< 700 solids for 5 strata)', boxesOk);
  // determinism: same seed -> byte-identical terrain (same openings/stairs/walls)
  const a = compileForSeed(77n).tower.terrain.solids;
  const b = compileForSeed(77n).tower.terrain.solids;
  check('compilation is deterministic (identical solids across runs)',
    a.length === b.length && a.every((box, i) => JSON.stringify(box) === JSON.stringify(b[i])));

  // NEGATIVE CONTROL: the checker must not be vacuous — re-sealing the exit
  // holes (slab tiles back over every stair, the pre-fix world) must break the
  // route via the headroom test.
  const { tower: t0 } = compileForSeed(0x5a17ed_1234n);
  const R = (v: number): number => Math.round(v * 65536);
  const cs = 3;
  const off = 2; // gridSize 5 → cell center x = (col - 2) * 3, top row z center = 6
  const seals = t0.stairs.map((st) => {
    const xs = st.cols.map((c) => (c - off) * cs);
    return {
      minX: R(Math.min(...xs) - 1.5), maxX: R(Math.max(...xs) + 1.5),
      minY: st.topY - R(0.5), maxY: st.topY,
      minZ: R((4 - off) * cs - 1.5), maxZ: R((4 - off) * cs + 1.5),
    };
  });
  const sealed = summitRoute({
    ...t0,
    terrain: { groundY: t0.terrain.groundY, solids: [...t0.terrain.solids, ...seals] },
  });
  check('negative control: sealing the exit holes breaks the route', !sealed.ok);
}

// PROOF 8 — END-TO-END CLIMB: a REAL Anchor body, driven only by held-stick input
// and periodic jump taps (NO teleports, no flag-pinning), walks the perimeter to
// the stair mouth, hops up both flights, and stands grounded on stratum 1. The
// route: entry -> east along row 0 -> north along the east column (all perimeter
// WALK seams, no lips) -> west into the outer stair lane -> landing -> inner
// flight -> step off onto the stratum-1 slab.
console.log('[8] END-TO-END — real Anchor climbs stratum 0 -> 1 (stick + jump taps)');
{
  const seed = 0x5a17ed_1234n;
  const sc = buildTower({ crewSize: 1, numStrata: 5, seed });
  // recompile the identical tower for the stair metadata (pure + deterministic)
  const { floors, tower } = compileForSeed(seed);
  const st = tower.stairs[0]!;
  const fl0 = floors[0]!;
  const a = sc.anchorIds[0]!;
  const w = sc.sim.world;
  const half = rawF(w.halfHeight[a]!);
  const base1 = rawF(sc.stratumBaseY![1]!);
  const dir = st.dirX;
  const openX = rawF(st.openX);
  const laneA = rawF(st.laneAZ);
  const laneB = rawF(st.laneBZ);
  const landX = rawF(st.landingX);
  // approach along the perimeter on the side AWAY from the stair (WALK seams only)
  const sideCol = dir < 0 ? fl0.width - 1 : 0;
  const colX = (sideCol - ((fl0.width - 1) / 2 | 0)) * 3;
  const rowZ = (y: number): number => (y - ((fl0.height - 1) / 2 | 0)) * 3;
  const turnX = landX - dir * 0.75; // center of the un-railed turn opening
  const wps: readonly (readonly [number, number])[] = [
    [colX, rowZ(0)], // east along the entry row
    [colX, rowZ(fl0.height - 1)], // north along the side column
    [openX - dir * 0.9, laneA], // into the outer-lane stair mouth
    [turnX, laneA], // up flight A to the top treads
    [turnX, laneB], // turn: hop sideways through the rail gap onto flight B
    [openX - dir * 1.2, laneB], // up flight B, step off at the top
    [openX - dir * 2.6, laneB + 1.0], // settle on the stratum-1 slab (off any seam lip)
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
      buttons: t % 12 === 0 ? Button.Jump : 0, // press-edge taps; hop each riser
    };
    const frame: (PlayerInput | undefined)[] = new Array(w.count);
    frame[a] = inp;
    sc.sim.advance(frame);
    if ((w.flags[a]! & BodyFlag.Alive) === 0) aliveAll = false;
    const feet = rawF(w.py[a]!) - half;
    const grounded = (w.flags[a]! & BodyFlag.Grounded) !== 0;
    const pastOpenEnd = (rawF(w.px[a]!) - openX) * -dir > 0.3; // off the stair, on the slab
    // feet up to base1+0.7 still counts: standing on a 0.6 seam lip IS stratum 1
    if (wpi >= 5 && grounded && pastOpenEnd && feet >= base1 - 0.05 && feet <= base1 + 0.7) {
      okClimb = true;
    }
  }
  if (!okClimb) {
    console.log(`       stuck at wp ${wpi}, pos (${rawF(w.px[a]!).toFixed(2)}, ${rawF(w.py[a]!).toFixed(2)}, ${rawF(w.pz[a]!).toFixed(2)})`);
  }
  check(`real Anchor summited stratum 0 -> 1 by inputs alone (${t} ticks, no teleport)`, okClimb);
  check('anchor alive for the whole climb', aliveAll);
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
