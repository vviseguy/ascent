// ============================================================================
// src/game/survival.ts — death, downed/bleed-out, respawn, kill-plane, recall.
// ============================================================================
//
// The position-kill (Smash) model needs real consequences for 0-HP and for falling
// past the bottom of the shaft (01 §4). This resolves them deterministically each
// tick, AFTER the physics/verbs pipeline:
//
//   REGULAR PLAYER:
//     - health <= 0  → DOWNED + bleed-out timer; if not revived by bleedUntil, dies.
//     - below kill-plane → dies immediately (thrown into the void).
//     - on death → schedule respawn at the crew beacon after RESPAWN_DELAY.
//   ANCHOR (fall-durable, position-kill):
//     - health <= 0 from chip/hazards → does NOT die; clamps to 1 + a downed beat.
//     - below the kill-plane (thrown off the bottom) → TRUE DEATH: respawns at the
//       crew beacon with an altitude penalty (committed height already reflects the
//       fall via match.ts). A true Anchor death is the biggest swing in the game.
//
// All timers are ticks in hashed WorldState fields (respawnAt / bleedUntil /
// downedUntil), so death/respawn rolls back exactly. No floats, no wall-clock.
// ============================================================================

import {
  type WorldState, BodyFlag, MassClass, NO_ENTITY, hasFlag, setFlag, clearFlag,
} from '../sim/world/state.ts';
import { type MatchState } from './match.ts';
import { fromInt, fromRaw, toRaw, ZERO, lte } from '../sim/fixed/fixed.ts';

/** Ticks a 0-HP regular player bleeds out before dying if not revived. */
export const BLEED_OUT_TICKS = 60 * 8; // 8s
/** Ticks before a dead regular player respawns at the beacon. */
export const RESPAWN_DELAY = 60 * 3; // 3s
/** Anchor downed-beat ticks after a true death/respawn. */
export const ANCHOR_RESPAWN_DOWNED = 90;
/** Min health the Anchor clamps to from non-kill-plane damage (never chip-killed). */
const ANCHOR_MIN_HP = fromInt(1);

/**
 * Resolve survival for every body this tick. `match` provides per-crew beacons +
 * the kill-plane. Pure function of (world, match, tick).
 */
export function applySurvival(w: WorldState, match: MatchState, tick: number): void {
  const killPlane = match.cfg.killPlaneY;
  for (let i = 0; i < w.count; i++) {
    if (!hasFlag(w, i, BodyFlag.Alive)) continue;
    const isPlayer = hasFlag(w, i, BodyFlag.Player) || hasFlag(w, i, BodyFlag.Anchor);
    if (!isPlayer) continue;
    const isAnchor = hasFlag(w, i, BodyFlag.Anchor) || w.massClass[i] === MassClass.Anchor;

    // --- respawn a body whose respawn tick has come ---
    if (w.respawnAt[i]! >= 0 && tick >= w.respawnAt[i]!) {
      respawnAtBeacon(w, match, i, tick, isAnchor);
      continue;
    }
    // a body waiting to respawn is inert this tick
    if (w.respawnAt[i]! >= 0) continue;

    // --- kill-plane: fell off the bottom of the shaft ---
    if (w.py[i]! < killPlane) {
      if (isAnchor) {
        // TRUE Anchor death — respawn at beacon after a delay, big downed beat.
        scheduleRespawn(w, i, tick);
      } else {
        scheduleRespawn(w, i, tick);
      }
      continue;
    }

    // --- 0 HP handling ---
    if (lte(fromRaw(w.health[i]!), ZERO)) {
      if (isAnchor) {
        // Anchor is fall/chip-durable: never dies from HP, clamps to 1 + downed beat.
        w.health[i] = toRaw(ANCHOR_MIN_HP);
        setFlag(w, i, BodyFlag.Downed);
        if (w.downedUntil[i]! < tick + ANCHOR_RESPAWN_DOWNED) {
          w.downedUntil[i] = tick + ANCHOR_RESPAWN_DOWNED;
        }
      } else if (w.bleedUntil[i]! < 0) {
        // regular player: enter downed + bleed-out (revivable by a Mender)
        setFlag(w, i, BodyFlag.Downed);
        w.bleedUntil[i] = tick + BLEED_OUT_TICKS;
        w.downedUntil[i] = tick + BLEED_OUT_TICKS;
      } else if (tick >= w.bleedUntil[i]!) {
        // bled out → death → schedule respawn
        scheduleRespawn(w, i, tick);
      }
    } else if (w.bleedUntil[i]! >= 0 && !isAnchor) {
      // healed above 0 before bleeding out — recover from downed.
      w.bleedUntil[i] = -1;
      w.downedUntil[i] = -1;
      clearFlag(w, i, BodyFlag.Downed);
    }
  }
}

/** Schedule a dead body to respawn at its crew beacon. Drops anything it held. */
function scheduleRespawn(w: WorldState, id: number, tick: number): void {
  // drop whatever this body was holding / break being held
  dropLinks(w, id);
  w.respawnAt[id] = tick + RESPAWN_DELAY;
  w.bleedUntil[id] = -1;
  setFlag(w, id, BodyFlag.Downed);
  w.downedUntil[id] = tick + RESPAWN_DELAY;
  // park it out of play (no gravity, zero velocity) until respawn
  w.vx[id] = 0; w.vy[id] = 0; w.vz[id] = 0;
  setFlag(w, id, BodyFlag.NoGravity);
}

/** Place a respawning body at its crew beacon (or its anchor's position). */
function respawnAtBeacon(w: WorldState, match: MatchState, id: number, tick: number, isAnchor: boolean): void {
  const crew = w.crewId[id]!;
  const cs = match.crews[crew];
  let x = w.px[id]!, y = w.py[id]!, z = w.pz[id]!;
  if (cs && cs.beaconTick >= 0) {
    x = cs.beaconX; y = cs.beaconY; z = cs.beaconZ;
  } else if (cs && cs.anchorId >= 0 && cs.anchorId < w.count && cs.anchorId !== id) {
    // no beacon: respawn near the crew's Anchor (never above it)
    x = w.px[cs.anchorId]!; y = w.py[cs.anchorId]!; z = w.pz[cs.anchorId]!;
  } else {
    // last resort: lift to ground height
    y = toRaw(fromInt(1));
  }
  w.px[id] = x; w.py[id] = y; w.pz[id] = z;
  w.vx[id] = 0; w.vy[id] = 0; w.vz[id] = 0;
  w.health[id] = toRaw(fromInt(100));
  w.respawnAt[id] = -1;
  w.bleedUntil[id] = -1;
  clearFlag(w, id, BodyFlag.NoGravity);
  // brief stand-up downed beat (anti-pile-on), longer for the Anchor
  w.downedUntil[id] = tick + (isAnchor ? ANCHOR_RESPAWN_DOWNED : 30);
  setFlag(w, id, BodyFlag.Downed);
  // regrab immunity on stand-up so you aren't instantly re-grabbed
  w.regrabUntil[id] = tick + 90;
}

/** Break both ends of any grab linkage this body participates in. */
function dropLinks(w: WorldState, id: number): void {
  const held = w.holding[id]!;
  if (held !== NO_ENTITY) {
    w.grabbedBy[held] = NO_ENTITY;
    clearFlag(w, held, BodyFlag.NoGravity);
    w.holding[id] = NO_ENTITY;
  }
  const carrier = w.grabbedBy[id]!;
  if (carrier !== NO_ENTITY) {
    if (carrier >= 0 && carrier < w.count && w.holding[carrier] === id) w.holding[carrier] = NO_ENTITY;
    w.grabbedBy[id] = NO_ENTITY;
    clearFlag(w, id, BodyFlag.NoGravity);
  }
}
