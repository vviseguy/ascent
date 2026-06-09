// ============================================================================
// src/game/match.ts — standing (Anchor height = score), win conditions, beacons.
// ============================================================================
//
// THE canonical rule (00 pillar 1): a crew's standing IS its Anchor's height, and
// nothing else is scored. This module owns the per-crew runtime that the body grid
// cannot hold: each crew's Anchor body id, committed height, recall beacon, and the
// match win-condition evaluation.
//
// DETERMINISM: MatchState is plain integers (raw Fixed + tick counts), part of the
// sim snapshot (cloned/restored/hashed alongside WorldState), so standings and the
// win check roll back exactly like the physics. No floats, no wall-clock.
//
// "Committed" vs "raw" height (04 §1.2): the live Anchor Y bobs as it jumps / is
// thrown / rides a lift. Standing uses a COMMITTED height that only advances when
// the Anchor is stably supported (grounded, not airborne/grabbed/downed) for a
// short window — so a throw upward doesn't bank score you didn't hold, and a throw
// DOWN does cost real committed altitude once you settle low. This is the diegetic
// rubber-band: getting your Anchor thrown down is a real standing loss.
// ============================================================================

import { type WorldState, BodyFlag, NO_ENTITY, hasFlag } from '../sim/world/state.ts';
import { type Fixed, fromInt, fromFloatConst, fromRaw, toRaw, ZERO, add, sub, gt, gte, lt } from '../sim/fixed/fixed.ts';
import { catchupFactor, drawOffer, boonById } from './boons.ts';

/** Win condition kinds (lobby-tunable, locked at match start). */
export const WinCondition = {
  /** First crew whose committed Anchor height reaches targetHeight wins. */
  RaceToHeight: 0,
  /** No fixed end by height; at matchCap ticks, highest committed Anchor wins. */
  Endless: 1,
} as const;
export type WinCondition = (typeof WinCondition)[keyof typeof WinCondition];

/** Match configuration — locked at start and hashed into the determinism seed. */
export interface MatchConfig {
  winCondition: WinCondition;
  /** Target height (raw Fixed) for RaceToHeight. */
  targetHeight: number;
  /** Match length cap in ticks (Endless end; also a hard cap for RaceToHeight). */
  matchCap: number;
  /** Number of crews. */
  numCrews: number;
  /** Bottom kill-plane Y (raw Fixed): a body below this is in the void. */
  killPlaneY: number;
  /** Run seed for deterministic draft draws (defaults to 0n). */
  runSeed?: bigint;
  /** World height of one floor/stratum in raw Fixed (for floor-index from height). */
  floorHeight?: number;
  /** Draft cadence: fire a boon draft every this-many committed floors (default 2). */
  draftEveryFloors?: number;
}

export const DEFAULT_MATCH: MatchConfig = {
  winCondition: WinCondition.RaceToHeight,
  targetHeight: toRaw(fromInt(40)),
  matchCap: 60 * 60 * 8, // 8 minutes @ 60Hz
  numCrews: 1,
  killPlaneY: toRaw(fromInt(-12)),
};

/** Committed-height gate: ticks the Anchor must be stably supported to bank height. */
const COMMIT_DWELL = 18;

/** Per-crew runtime standing + beacon + boons (plain ints; part of the snapshot). */
export interface CrewState {
  anchorId: number;
  /** committed (banked) Anchor height in raw Fixed — THE score. */
  committed: number;
  /** how many consecutive ticks the Anchor has been stably supported. */
  dwell: number;
  /** beacon position (raw Fixed); planted = beaconTick >= 0. */
  beaconX: number; beaconY: number; beaconZ: number;
  beaconTick: number; // tick the beacon was (re)planted; -1 = none
  /** tick this crew first reached the target (RaceToHeight tiebreak); -1 = not yet. */
  reachedTick: number;
  /** highest stratum index this crew has drafted at (draft cadence cursor). */
  lastDraftFloor: number;
  /** active boon ids (bitset as a plain sorted array; small). */
  boons: number[];
  /** the current pending draft offer (boon ids), empty when none open. */
  offer: number[];
  /** Momentum meter 0..100 (rerolls; fills with progress). */
  momentum: number;
}

export interface MatchState {
  cfg: MatchConfig;
  crews: CrewState[];
  /** winning crew id once decided, else -1. */
  winner: number;
  /** tick the match ended, else -1. */
  endedTick: number;
}

export function createMatch(cfg: MatchConfig, anchorIds: readonly number[]): MatchState {
  const crews: CrewState[] = [];
  for (let c = 0; c < cfg.numCrews; c++) {
    crews.push({
      anchorId: anchorIds[c] ?? NO_ENTITY,
      committed: 0, dwell: 0,
      beaconX: 0, beaconY: 0, beaconZ: 0, beaconTick: -1,
      reachedTick: -1,
      lastDraftFloor: -1, boons: [], offer: [], momentum: 0,
    });
  }
  return { cfg, crews, winner: -1, endedTick: -1 };
}

/** Deep value-copy for the snapshot ring. cfg is immutable so it's shared. */
export function cloneMatch(m: MatchState): MatchState {
  return {
    cfg: m.cfg,
    crews: m.crews.map((c) => ({ ...c, boons: c.boons.slice(), offer: c.offer.slice() })),
    winner: m.winner, endedTick: m.endedTick,
  };
}
export function restoreMatch(dst: MatchState, src: MatchState): void {
  dst.winner = src.winner; dst.endedTick = src.endedTick;
  for (let c = 0; c < dst.crews.length; c++) {
    const s = src.crews[c]!, d = dst.crews[c]!;
    d.anchorId = s.anchorId; d.committed = s.committed; d.dwell = s.dwell;
    d.beaconX = s.beaconX; d.beaconY = s.beaconY; d.beaconZ = s.beaconZ;
    d.beaconTick = s.beaconTick; d.reachedTick = s.reachedTick;
    d.lastDraftFloor = s.lastDraftFloor; d.momentum = s.momentum;
    d.boons = s.boons.slice(); d.offer = s.offer.slice();
  }
}

/** Fold the match into a running FNV-1a hash (so standings desync is detectable). */
export function hashMatch(m: MatchState, h0: number): number {
  let h = h0 >>> 0;
  const fold = (x: number) => { h ^= x >>> 0; h = Math.imul(h, 0x01000193) >>> 0; };
  fold(m.winner); fold(m.endedTick);
  for (const c of m.crews) {
    fold(c.anchorId); fold(c.committed | 0); fold(c.dwell);
    fold(c.beaconX | 0); fold(c.beaconY | 0); fold(c.beaconZ | 0);
    fold(c.beaconTick); fold(c.reachedTick);
    fold(c.lastDraftFloor); fold(c.momentum | 0);
    for (const b of c.boons) fold(b);
    for (const b of c.offer) fold(b);
  }
  return h >>> 0;
}

/**
 * Advance the match one tick: update each crew's committed standing from its Anchor
 * body, then evaluate the win condition. Pure function of (match, world, tick).
 * Called by sim.ts after the physics/verbs pipeline each tick.
 */
export function stepMatch(m: MatchState, w: WorldState, tick: number, groundY: number): void {
  if (m.endedTick >= 0) return; // match already decided — freeze
  for (let c = 0; c < m.crews.length; c++) {
    const crew = m.crews[c]!;
    const a = crew.anchorId;
    if (a < 0 || a >= w.count || !hasFlag(w, a, BodyFlag.Alive)) continue;
    // raw height above ground
    const rawH = w.py[a]! - groundY;
    // "stably supported" = grounded, not grabbed, not downed
    const stable =
      hasFlag(w, a, BodyFlag.Grounded) &&
      w.grabbedBy[a] === NO_ENTITY &&
      !hasFlag(w, a, BodyFlag.Downed);
    if (stable) {
      crew.dwell++;
      // commit height once stably supported for COMMIT_DWELL ticks. Commit ratchets
      // UP to the current stable height; a stable LOWER position also recommits down
      // (you really did lose that altitude — diegetic rubber-band).
      if (crew.dwell >= COMMIT_DWELL) crew.committed = rawH;
    } else {
      crew.dwell = 0;
    }
  }
  runDrafts(m);
  evaluateWin(m, tick);
}

/**
 * Fire boon drafts at milestone floors and auto-resolve them (the trailing crew
 * draws from a deficit-shifted pool — Mario-Kart rubber-banding, docs/03 §4). The
 * pick is deterministic (highest-tier card; ties → lowest id) so the draft needs no
 * extra input channel yet; a player-facing pick UI can override later. Pure.
 */
function runDrafts(m: MatchState): void {
  const fh = m.cfg.floorHeight && m.cfg.floorHeight > 0 ? m.cfg.floorHeight : (6 << 16);
  const every = m.cfg.draftEveryFloors ?? 2;
  const seed = m.cfg.runSeed ?? 0n;
  // leader committed-floor for the deficit input
  let leaderFloors = 0;
  for (const c of m.crews) leaderFloors = Math.max(leaderFloors, Math.floor(c.committed / fh));
  for (let ci = 0; ci < m.crews.length; ci++) {
    const crew = m.crews[ci]!;
    const floor = Math.floor(crew.committed / fh);
    const milestone = Math.floor(floor / every);
    if (milestone <= crew.lastDraftFloor) continue; // not a new milestone
    crew.lastDraftFloor = milestone;
    const deficit = leaderFloors - floor;
    const catchup = catchupFactor(deficit);
    const offer = drawOffer(seed, ci, milestone, catchup);
    // auto-pick the best card (highest tier; tie → lowest id) — deterministic.
    let best = -1, bestTier = -1;
    for (const id of offer) {
      const def = boonById(id);
      if (def && (def.tier > bestTier || (def.tier === bestTier && (best < 0 || id < best)))) {
        bestTier = def.tier; best = id;
      }
    }
    if (best >= 0 && !crew.boons.includes(best)) {
      crew.boons.push(best);
      crew.boons.sort((a, b) => a - b); // keep deterministic order for the hash
    }
    crew.offer = offer;
    crew.momentum = Math.min(100, crew.momentum + 15);
  }
}

function evaluateWin(m: MatchState, tick: number): void {
  if (m.cfg.winCondition === WinCondition.RaceToHeight) {
    let best = -1, bestTick = Infinity;
    for (let c = 0; c < m.crews.length; c++) {
      const crew = m.crews[c]!;
      if (crew.committed >= m.cfg.targetHeight) {
        if (crew.reachedTick < 0) crew.reachedTick = tick;
        if (crew.reachedTick < bestTick) { bestTick = crew.reachedTick; best = c; }
      }
    }
    if (best >= 0) { m.winner = best; m.endedTick = tick; return; }
  }
  // Endless OR RaceToHeight hitting the hard cap: highest committed wins at the cap.
  if (tick >= m.cfg.matchCap) {
    let best = 0, bestH = -Infinity;
    for (let c = 0; c < m.crews.length; c++) {
      if (m.crews[c]!.committed > bestH) { bestH = m.crews[c]!.committed; best = c; }
    }
    m.winner = best; m.endedTick = tick;
  }
}

/** Standing (committed height in METERS as a float) for HUD/debug. View-only. */
export function standingMeters(m: MatchState, crew: number): number {
  const c = m.crews[crew];
  return c ? c.committed / 65536 : 0;
}

// referenced for future tuning; keep the fixed import meaningful
void { fromFloatConst, fromRaw, ZERO, add, sub, gt, gte, lt } as unknown;
