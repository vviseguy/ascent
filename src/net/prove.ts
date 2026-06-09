// ============================================================================
// Standalone PROOF for the netcode (rollback over a lossy/laggy/reordered link).
//   Run:  node --experimental-strip-types src/net/prove.ts
// ============================================================================
//
// This is the multiplayer analog of the sim proofs: it stands up N independent
// peers, each with its OWN Sim + RollbackManager, connected only through the
// in-process LoopbackHub with a seeded latency/jitter/loss/reorder model. Each peer
// sees only its own local input live and learns every other peer's input solely
// from the (degraded) wire. The properties that make rollback netcode correct:
//
//   PROOF 1 — CONVERGENCE UNDER A CLEAN LINK. With tiny latency and no loss, after
//             inputs settle every peer's world hash is IDENTICAL at the verified
//             frontier. (Baseline: the loop wires up and agrees.)
//
//   PROOF 2 — CONVERGENCE UNDER A HOSTILE LINK. With variable latency, jitter,
//             ~15% packet loss, and reordering on the hot channel, every peer STILL
//             converges to identical hashes through the verified frontier — the
//             redundant-input resend + prediction + rollback self-heal the damage.
//
//   PROOF 3 — NO DESYNCS REPORTED. The peers' periodic check-frame hashes agree
//             (the desync detector fires zero false positives and, more importantly,
//             zero real divergences) across the hostile run.
//
//   PROOF 4 — EQUALS THE SINGLE-PLAYER REFERENCE. The networked world matches a
//             local, no-network sim fed the identical input streams — proving the
//             netcode changes WHEN inputs are known, never the resulting simulation.
// ============================================================================

import { createWorld, spawnBody, BodyFlag, MassClass } from '../sim/world/state.ts';
import { hashWorld } from '../sim/world/hash.ts';
import { type PlayerInput, Button, MOVE_Q } from '../sim/world/input.ts';
import { fromInt, fromFloatConst, toRaw } from '../sim/fixed/fixed.ts';
import { Sim, type SimContext } from '../sim/sim.ts';
import { makeArena } from '../sim/collide/terrain.ts';
import { HazardKind, type Hazard } from '../sim/hazards/model.ts';
import { canonicalizeInput } from './wire.ts';
import { RollbackManager } from './rollback.ts';
import { LoopbackHub, LoopbackTransport, type LinkModel, Channel } from './transport.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUM_PLAYERS = 3;
const TICKS = 900;

/** Identical starting scene on every peer (same seed/authored layout = determinism). */
function makeScene(): Sim {
  const w = createWorld(48);
  for (let i = 0; i < NUM_PLAYERS; i++) {
    spawnBody(w, {
      px: fromInt(i * 2 - 2), py: fromInt(3), pz: fromInt(0),
      radius: fromFloatConst(0.4), halfHeight: fromFloatConst(0.9),
      massClass: MassClass.Player, flags: BodyFlag.Player,
    });
  }
  spawnBody(w, {
    px: fromInt(0), py: fromInt(3), pz: fromInt(2),
    radius: fromFloatConst(0.5), halfHeight: fromFloatConst(1.0),
    massClass: MassClass.Anchor, flags: BodyFlag.Player | BodyFlag.Anchor,
  });
  for (let i = 0; i < 5; i++) {
    spawnBody(w, {
      px: fromInt(i - 2), py: fromInt(2), pz: fromInt(-3),
      radius: fromFloatConst(0.3), halfHeight: fromFloatConst(0.3),
      massClass: i % 2 === 0 ? MassClass.Light : MassClass.Heavy, flags: BodyFlag.Throwable,
    });
  }
  const terrain = makeArena(fromInt(0), fromInt(10), fromInt(3), fromFloatConst(0.5));
  const hazards: Hazard[] = [{
    kind: HazardKind.Crusher,
    ax: toRaw(fromInt(-3)), ay: toRaw(fromInt(1)), az: toRaw(fromInt(4)),
    bx: toRaw(fromInt(3)), by: toRaw(fromInt(1)), bz: toRaw(fromInt(4)),
    period: 150, phase: 0, radius: toRaw(fromFloatConst(1.2)),
    impulse: toRaw(fromFloatConst(0.3)), damage: toRaw(fromInt(1)),
  }];
  const ctx: Partial<SimContext> = { terrain, hazards };
  return new Sim(w, ctx);
}

/** Deterministic per-player input streams (each peer authors its OWN locally). */
function makeStreams(seed: number): PlayerInput[][] {
  const streams: PlayerInput[][] = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    const rnd = mulberry32(seed + p * 1000);
    const s: PlayerInput[] = [];
    let cur: PlayerInput = { moveX: 0, moveZ: 0, aim: 0, buttons: 0, grabTarget: -1 };
    for (let t = 0; t < TICKS; t++) {
      if (rnd() < 0.12) {
        let b = 0;
        const r = rnd();
        if (r < 0.12) b |= Button.Grab; else if (r < 0.2) b |= Button.Throw;
        else if (r < 0.28) b |= Button.Rush; else if (r < 0.34) b |= Button.Struggle;
        cur = {
          moveX: Math.floor((rnd() * 2 - 1) * MOVE_Q),
          moveZ: Math.floor((rnd() * 2 - 1) * MOVE_Q),
          aim: Math.floor((rnd() * 2 - 1) * 205887),
          buttons: b, grabTarget: -1,
        };
      }
      s.push(cur);
    }
    streams.push(s);
  }
  return streams;
}

/** A link model: base latency + jitter (+ optional loss) in TICK units, seeded. */
function linkModel(seed: number, baseDelay: number, jitter: number, lossPct: number): LinkModel {
  const rnd = mulberry32(seed);
  return {
    shape() {
      const delay = baseDelay + Math.floor(rnd() * (jitter + 1));
      const drop = rnd() < lossPct;
      return { delayTicks: delay, drop };
    },
  };
}

/** Run a full networked session; return each peer's final + verified-frontier hash. */
function runSession(link: LinkModel, streams: PlayerInput[][]): {
  managers: RollbackManager[]; hub: LoopbackHub;
} {
  let now = 0;
  const hub = new LoopbackHub(NUM_PLAYERS, link);
  const managers: RollbackManager[] = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    const t = new LoopbackTransport(p, hub, () => now);
    managers.push(new RollbackManager(makeScene(), t, NUM_PLAYERS));
  }
  // advance the shared clock; each tick every peer steps once, then we pump delivery.
  for (let tk = 0; tk < TICKS; tk++) {
    now = tk;
    for (let p = 0; p < NUM_PLAYERS; p++) managers[p]!.tick(streams[p]![tk]!);
    hub.pump(now);
  }
  // drain remaining in-flight + let peers resolve trailing rollbacks
  for (let extra = 0; extra < 120; extra++) {
    now = TICKS + extra;
    for (let p = 0; p < NUM_PLAYERS; p++) {
      managers[p]!.tick(streams[p]![TICKS - 1]!); // hold last input
    }
    hub.pump(now);
  }
  return { managers, hub };
}

/**
 * Single-player reference: one sim fed ALL players' canonical inputs directly, with
 * NO network. Advancing `steps` ticks leaves the world at tick=steps, whose hash is
 * the canonical state at the START of tick `steps` — the value every networked peer
 * must agree on once tick `steps` is fully confirmed.
 */
function runReference(streams: PlayerInput[][], steps: number): number {
  const sim = makeScene();
  const frame: (PlayerInput | undefined)[] = new Array(NUM_PLAYERS);
  for (let t = 0; t < steps; t++) {
    for (let p = 0; p < NUM_PLAYERS; p++) {
      frame[p] = canonicalizeInput(streams[p]![Math.min(t, TICKS - 1)]!);
    }
    sim.advance(frame);
  }
  // FULL game-state hash (world + match) — matches RollbackManager.hashAt, which
  // now hashes both halves so standings/beacons/win are part of the consensus.
  return sim.hash();
}

/** The common verified tick to compare across peers (min frontier, minus slack). */
function commonVerified(managers: RollbackManager[]): number {
  let vf = Infinity;
  for (const m of managers) vf = Math.min(vf, m.verifiedThrough());
  // compare a tick safely inside everyone's confirmed range + snapshot ring
  return Math.max(0, (vf === Infinity ? 0 : vf) - 2);
}

let failures = 0;
const log = (s: string) => console.log(s);
log('----------------------------------------------------------------');
log('ASCENT netcode — STANDALONE PROOF (rollback over a degraded link)');
log('----------------------------------------------------------------');

const streams = makeStreams(0x2468ace0);

// NOTE: peers are compared at the VERIFIED FRONTIER (the latest tick every player's
// input is confirmed), NOT the bleeding edge — the newest few ticks legitimately
// contain unconfirmed predictions that differ per peer until inputs arrive. That's
// how rollback works; the verified history is what must agree.

// PROOF 1 — clean link convergence
{
  const { managers } = runSession(linkModel(1, 1, 0, 0), streams);
  const vt = commonVerified(managers);
  const h0 = managers[0]!.hashAt(vt);
  let p1 = h0 !== null;
  for (const m of managers) if (m.hashAt(vt) !== h0) p1 = false;
  log(`PROOF 1 clean-link convergence @verified tick ${vt} (${NUM_PLAYERS} peers): ${p1 ? 'PASS' : 'FAIL'} (hash=${((h0??0)>>>0).toString(16)})`);
  if (!p1) failures++;
}

// PROOF 2 — hostile link convergence (latency + jitter + 15% loss + reorder)
let hostileVt = 0;
let hostileHash: number | null = 0;
{
  const { managers } = runSession(linkModel(7, 3, 5, 0.15), streams);
  hostileVt = commonVerified(managers);
  hostileHash = managers[0]!.hashAt(hostileVt);
  let p2 = hostileHash !== null;
  for (const m of managers) if (m.hashAt(hostileVt) !== hostileHash) p2 = false;
  log(`PROOF 2 hostile-link convergence @verified tick ${hostileVt} (lat 3-8t, 15% loss, reorder): ${p2 ? 'PASS' : 'FAIL'} (hash=${((hostileHash??0)>>>0).toString(16)})`);
  if (!p2) failures++;

  // PROOF 3 — zero desyncs reported by the check-frame referee
  let totalDesyncs = 0;
  for (const m of managers) totalDesyncs += m.desyncs.length;
  const p3 = totalDesyncs === 0;
  log(`PROOF 3 check-frame desyncs across all peers: ${p3 ? 'PASS' : 'FAIL'} (${totalDesyncs} desyncs)`);
  if (!p3) failures++;
}

// PROOF 4 — networked equals the single-player reference at the SAME verified tick
{
  const ref = runReference(streams, hostileVt);
  const p4 = hostileHash !== null && ref === hostileHash;
  log(`PROOF 4 networked == single-player reference @tick ${hostileVt}: ${p4 ? 'PASS' : 'FAIL'} (ref=${(ref>>>0).toString(16)} net=${((hostileHash??0)>>>0).toString(16)})`);
  if (!p4) failures++;
}

log('----------------------------------------------------------------');
if (failures === 0) {
  log('RESULT: PASS — peers converge to identical state over a lossy/laggy/reordered');
  log('        link, report no desyncs, and match the single-player reference.');
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(0);
} else {
  log(`RESULT: FAIL — ${failures} property(ies) failed.`);
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
}

void Channel;
