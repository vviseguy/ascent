// ============================================================================
// src/sim/breakable/break.ts — applyBreakables: the DESTRUCTIBLE-PROP system.
// ============================================================================
//
// One call per tick resolves every breakable prop (crate / pot / barrel):
//
//     applyBreakables(w, index, tick)
//
// It is a single deterministic sim system — a pure function of (state, tick): only
// Fixed / integer math, ascending-id sweeps, and a seeded PRNG keyed on
// (tick, breakableId). No Date / Math.random / float ever enters it. Everything it
// touches (a breakable's `health` integrity, the `flags` it sets, the bodies it
// spawns/kills) is already part of WorldState's hash/clone/restore, so the whole
// system is rollback-safe with NO new persisted fields.
//
// WHERE IT SLOTS INTO sim.ts (SYSTEM 6.5, after verbs, before fall-damage):
//   ... applyVerbs (rush/grab/throw/shove + abilities incl. Breaker shove) ...
//   applyBreakables(w, index, w.tick)   // <-- here
//   ... fall-damage ...
// WHY THIS SLOT: verbs are the FINAL authority on velocity for the tick (the rush
// sweep, the throw/shove impulses, encumbrance), and the Breaker shove ability
// (which arms breakerShoveUntil) runs inside applyVerbs. Running breakables right
// after means impact speeds and the shove flag are settled before we test them.
//
// THREE DAMAGE SOURCES (docs/02 §2.1, §6.5):
//   (a) BREAKER AoE shove — a breakable hit by the shove has breakerShoveUntil set
//       this tick (the ability's "future destructible hook"); deal SHOVE_DAMAGE.
//   (b) RUSH impact — a body mid-dash (rushUntil >= 0) overlapping the breakable
//       deals RUSH_DAMAGE.
//   (c) THROWN-body impact — a free, fast-moving body overlapping the breakable
//       deals impact damage scaled by its excess speed above THROW_IMPACT_SPEED.
//
// On integrity <= 0 the breakable is KILLED and 1..3 Pickup drops spawn at its
// position with seeded scatter velocities (capped by world capacity).
// ============================================================================

import {
  type Fixed,
  ZERO, TWO_PI, add, sub, mul, sqrt, gt, fromRaw, toRaw, sin, cos, fromInt,
} from '../fixed/fixed.ts';
import {
  type WorldState, BodyFlag, MassClass, NO_ENTITY,
  hasFlag, killBody, spawnBody,
} from '../world/state.ts';
import { hash3 } from '../hazards/jitter.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import {
  SHOVE_DAMAGE, RUSH_DAMAGE, THROW_IMPACT_SPEED, THROW_IMPACT_SCALE, THROW_IMPACT_MAX,
  CONTACT_SLOP, DROP_MIN, DROP_MAX, DROP_RADIUS, DROP_HALF_HEIGHT,
  DROP_SCATTER_SPEED, DROP_POP_UP, DROP_SPAWN_LIFT,
} from './config.ts';

/** PRNG channels (distinct so two draws on the same (tick,id) don't correlate). */
const CH_DROP_COUNT = 0x4b00_0001;
const CH_DROP_ANGLE = 0x4b00_0002;

/**
 * Module-private reusable scratch buffer for radius queries. Cleared (length=0) by
 * each query, holds no cross-tick meaning, never affects output ordering — so it is
 * determinism-safe (same pattern as hazards/apply.ts `_scratch`).
 */
const scratch: number[] = [];

/** Subtract `dmg` (Fixed) from a breakable's integrity (`health`, raw Fixed). */
function damage(w: WorldState, id: number, dmg: Fixed): void {
  w.health[id] = toRaw(sub(fromRaw(w.health[id]!), dmg));
}

/** Ground-plane (x,z) distance between bodies a and b (Fixed). */
function planarDist(w: WorldState, a: number, b: number): Fixed {
  const dx = sub(fromRaw(w.px[a]!), fromRaw(w.px[b]!));
  const dz = sub(fromRaw(w.pz[a]!), fromRaw(w.pz[b]!));
  return sqrt(add(mul(dx, dx), mul(dz, dz)));
}

/** Horizontal speed magnitude of body i (Fixed) — its in-plane velocity length. */
function planarSpeed(w: WorldState, i: number): Fixed {
  const vx = fromRaw(w.vx[i]!);
  const vz = fromRaw(w.vz[i]!);
  return sqrt(add(mul(vx, vx), mul(vz, vz)));
}

/**
 * Resolve all breakables for the current tick. MUTATES w (integrity / kills /
 * spawned drops). `index` MUST be rebuilt against w for this tick before calling.
 *
 * Two ascending-id passes keep write order deterministic and independent of any
 * Map/Set iteration: pass 1 accumulates damage onto each live breakable; pass 2
 * destroys (and spawns drops for) every breakable whose integrity hit 0. Spawning
 * is deferred to pass 2 so a drop body cannot itself be re-scanned as a damager in
 * the same tick (the new ids land above `count` at spawn time, but deferring also
 * keeps the two phases cleanly separable for the proof).
 */
export function applyBreakables(w: WorldState, index: SpatialIndex, tick: number): void {
  const count = w.count;

  // --- PASS 1: accumulate damage onto each alive breakable (ascending id) ---
  for (let b = 0; b < count; b++) {
    if (!hasFlag(w, b, BodyFlag.Alive)) continue;
    if (!hasFlag(w, b, BodyFlag.Breakable)) continue;

    // (a) BREAKER AoE shove: the ability arms breakerShoveUntil on bodies it hits.
    // A breakable flagged this tick (>= current tick) eats SHOVE_DAMAGE.
    if (w.breakerShoveUntil[b]! >= 0 && tick < w.breakerShoveUntil[b]!) {
      damage(w, b, SHOVE_DAMAGE);
    }

    // (b)/(c) contact damage from nearby damaging bodies (rush / thrown impact).
    // Query a generous ground-plane radius around the breakable; the per-body test
    // below applies the true sum-of-radii + slop contact check.
    const queryR = toRaw(add(add(fromRaw(w.radius[b]!), fromInt(2)), CONTACT_SLOP));
    index.queryRadius(w.px[b]!, w.pz[b]!, queryR, scratch);
    for (const t of scratch) {
      if (t === b) continue;
      if (!hasFlag(w, t, BodyFlag.Alive)) continue;
      if (hasFlag(w, t, BodyFlag.Breakable)) continue; // props don't damage props
      // a body carried by someone is owned by the carrier — not a free impact.
      if (w.grabbedBy[t] !== NO_ENTITY) continue;

      // contact = within sum of radii + slop on the ground plane.
      const dist = planarDist(w, b, t);
      const contactR = add(add(fromRaw(w.radius[b]!), fromRaw(w.radius[t]!)), CONTACT_SLOP);
      if (gt(dist, contactR)) continue;

      // (b) RUSH impact: the contacting body is mid-dash.
      if (w.rushUntil[t]! >= 0 && tick < w.rushUntil[t]!) {
        damage(w, b, RUSH_DAMAGE);
      }

      // (c) THROWN-body impact: a fast free body (above the speed threshold) deals
      // damage proportional to its excess speed. Players walking into a prop move
      // below the threshold, so only genuine throws/launches break it.
      const speed = planarSpeed(w, t);
      if (gt(speed, THROW_IMPACT_SPEED)) {
        let imp = mul(sub(speed, THROW_IMPACT_SPEED), THROW_IMPACT_SCALE);
        if (gt(imp, THROW_IMPACT_MAX)) imp = THROW_IMPACT_MAX;
        damage(w, b, imp);
      }
    }
  }

  // --- PASS 2: destroy every breakable at 0 integrity + spawn drops (asc id) ---
  // Snapshot the pre-spawn high-water id so newly spawned drops (which land at ids
  // >= preCount, or in reused dead slots BELOW b that we've already passed) are
  // never re-examined as breakables this tick.
  for (let b = 0; b < count; b++) {
    if (!hasFlag(w, b, BodyFlag.Alive)) continue;
    if (!hasFlag(w, b, BodyFlag.Breakable)) continue;
    if (gt(fromRaw(w.health[b]!), ZERO)) continue; // still intact
    destroyBreakable(w, b, tick);
  }
}

/**
 * Destroy breakable `b`: capture its position, kill it, then spawn 1..3 Pickup
 * drops with seeded scatter. Deterministic: the drop COUNT and each drop's scatter
 * ANGLE come from hash3(tick, b, channel), so identical seed/tick reproduce the
 * exact same drops (count + positions + velocities) on every peer and re-sim.
 */
function destroyBreakable(w: WorldState, b: number, tick: number): void {
  // capture spawn origin BEFORE killing (killBody only clears flags/relations, but
  // be explicit so intent is clear and we don't depend on that).
  const ox = fromRaw(w.px[b]!);
  const oy = add(fromRaw(w.py[b]!), DROP_SPAWN_LIFT);
  const oz = fromRaw(w.pz[b]!);

  killBody(w, b);

  // deterministic drop count in [DROP_MIN, DROP_MAX] from the seeded hash.
  const span = DROP_MAX - DROP_MIN + 1; // inclusive range width
  const n = DROP_MIN + (hash3(tick, b, CH_DROP_COUNT) % span);

  for (let k = 0; k < n; k++) {
    // capacity guard: stop if the world is full (never throw on the sim hot path).
    if (freeSlot(w) < 0) break;

    // per-drop scatter ANGLE: a full-circle seeded direction (the drop index k is
    // mixed into the channel so the n drops fan out, not overlap).
    const aRaw = hash3(tick, b, CH_DROP_ANGLE + k) >>> 0;
    // map the 32-bit hash to an angle in [0, 2π): (h & 0xffff) is a Q16.16 fraction
    // of 1.0 → scale by 2π. Pure Fixed math.
    const frac = fromRaw(aRaw & 0xffff); // [0,1)
    const angle = mul(frac, TWO_PI);
    const dirx = cos(angle);
    const dirz = sin(angle);

    const id = spawnBody(w, {
      px: ox, py: oy, pz: oz,
      radius: DROP_RADIUS, halfHeight: DROP_HALF_HEIGHT,
      massClass: MassClass.Light,
      // a drop is a Throwable Light body (so existing physics/verbs handle it) AND
      // flagged Pickup (so render/HUD can distinguish it). No integrity needed.
      flags: BodyFlag.Throwable | BodyFlag.Pickup,
      health: fromInt(1),
    });
    // seeded scatter velocity: horizontal pop along the drop's angle + a fixed up.
    w.vx[id] = toRaw(mul(DROP_SCATTER_SPEED, dirx));
    w.vz[id] = toRaw(mul(DROP_SCATTER_SPEED, dirz));
    w.vy[id] = toRaw(DROP_POP_UP);
  }
}

/**
 * Lowest reusable id (a dead slot below count, else count if there's capacity),
 * or -1 if the world is full. Mirrors spawnBody's allocation scan so the capacity
 * guard above predicts whether the next spawnBody would succeed — without throwing.
 */
function freeSlot(w: WorldState): number {
  for (let i = 0; i < w.count; i++) {
    if ((w.flags[i]! & BodyFlag.Alive) === 0) return i;
  }
  return w.count < w.capacity ? w.count : -1;
}
