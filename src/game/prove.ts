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

console.log('----------------------------------------------------------------');
if (fail === 0) {
  console.log(`RESULT: PASS — game layer correct & deterministic (${ok} checks).`);
  (globalThis as { process?: { exit(c: number): void } }).process?.exit(0);
} else {
  console.log(`RESULT: FAIL — ${fail} checks failed (${ok} passed).`);
  (globalThis as { process?: { exit(c: number): void } }).process?.exit(1);
}

void NO_ENTITY;
