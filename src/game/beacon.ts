// ============================================================================
// src/game/beacon.ts — the Recall Beacon (plant + recall), one of the three
// escort primitives (00 pillar 1, 01 §2.2-C).
// ============================================================================
//
// The ANCHOR plants a per-crew beacon at its feet (cooldown-gated). Any crew member
// can RECALL to it — teleporting to the beacon's position — BUT never above the
// Anchor's current height (recall is a regroup, not a shortcut: "recall is to the
// Anchor, never ahead", the structural anti-turtle). Recall is the regular-player
// respawn point too (see survival.ts).
//
// Determinism: beacon position + plant tick live in MatchState.crews (hashed,
// snapshotted). Recall is a position write gated by integer-tick cooldowns. The
// Recall button edge is detected via the body's hashed prevButtons (set by the verb
// layer), so plant/recall fire on a true press edge and roll back cleanly.
// ============================================================================

import {
  type WorldState, BodyFlag, NO_ENTITY, NO_CREW, hasFlag,
} from '../sim/world/state.ts';
import { type PlayerInput, Button, isDown, NEUTRAL_INPUT } from '../sim/world/input.ts';
import { type MatchState } from './match.ts';

/** Cooldown (ticks) between beacon (re)plants by an Anchor. */
export const BEACON_REPLANT_CD = 60 * 20; // 20s
/** Cooldown (ticks) between recalls for a given player (reuses regrabUntil-style gate). */
export const RECALL_CD = 60 * 12; // 12s

/**
 * Apply beacon plant + recall for this tick. `inputs[id]` is each body's input.
 * Pure function of (world, match, inputs, tick).
 */
export function applyBeacons(
  w: WorldState,
  match: MatchState,
  inputs: ReadonlyArray<PlayerInput | undefined>,
  tick: number,
): void {
  for (let i = 0; i < w.count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    const crew = w.crewId[i]!;
    if (crew === NO_CREW) continue;
    const cs = match.crews[crew];
    if (!cs) continue;
    const inp = inputs[i] ?? NEUTRAL_INPUT;
    const pressNow = isDown(inp, Button.Recall);
    const pressPrev = (w.prevButtons[i]! & Button.Recall) !== 0;
    if (!(pressNow && !pressPrev)) continue; // press-edge only
    // can't act while grabbed/downed
    if (w.grabbedBy[i] !== NO_ENTITY || hasFlag(w, i, BodyFlag.Downed)) continue;

    const isAnchor = hasFlag(w, i, BodyFlag.Anchor);
    if (isAnchor) {
      // PLANT / REPLANT the crew beacon at the Anchor's feet (cooldown-gated).
      if (cs.beaconTick < 0 || tick - cs.beaconTick >= BEACON_REPLANT_CD) {
        cs.beaconX = w.px[i]!;
        cs.beaconY = w.py[i]!;
        cs.beaconZ = w.pz[i]!;
        cs.beaconTick = tick;
      }
    } else {
      // RECALL to the beacon — but never above the Anchor's current height.
      if (cs.beaconTick < 0) continue; // no beacon planted yet
      if (tick < w.recallReadyAt[i]!) continue; // recall cooldown
      let ty = cs.beaconY;
      const anchorId = cs.anchorId;
      if (anchorId >= 0 && anchorId < w.count) {
        const anchorY = w.py[anchorId]!;
        if (ty > anchorY) ty = anchorY; // clamp: never recall above the Anchor
      }
      w.px[i] = cs.beaconX;
      w.py[i] = ty;
      w.pz[i] = cs.beaconZ;
      w.vx[i] = 0; w.vy[i] = 0; w.vz[i] = 0;
      w.recallReadyAt[i] = tick + RECALL_CD;
    }
  }
}
