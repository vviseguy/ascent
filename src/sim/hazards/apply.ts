// ============================================================================
// src/sim/hazards/apply.ts — applyHazards: the SCRIPTED HAZARDS system.
// ============================================================================
//
// WHY A SINGLE ENTRY POINT: the integrator calls applyHazards(w, hazards, index,
// tick) once per tick as a SYSTEM. Every hazard is resolved as a pure function of
// (tick + authored params + current body positions). We iterate the hazards array
// in order, and within each hazard iterate affected bodies by ASCENDING id (the
// SpatialIndex guarantees ascending output), so write order is deterministic and
// never depends on Map/Set iteration.
//
// STEP-ORDER RECOMMENDATION (documented for the integrator; this layer does NOT
// edit step.ts). Run applyHazards AFTER integrate + ground-resolve (step's
// SYSTEM 4) and BEFORE carry-transform (step's SYSTEM 5) — i.e. between (4) and
// (5). Rationale:
//   - Positions are final for the tick (post-integrate), so AABB/radius tests hit
//     where bodies actually are.
//   - Impulses written to velocity are consumed by the NEXT tick's integrate, so
//     a gust/crusher pushes on the following tick — the intuitive, stable
//     behavior, and it avoids double-applying within the same tick.
//   - Running before carry-transform means a held body re-slaves to its carrier
//     afterward, so a hazard impulse on a held body is overridden by the carrier
//     socket ("carrier owns transform"), as the engine intends. (A hazard that
//     should knock a body OUT of a hold is the bump-to-break rush path in the
//     verbs layer, not here.)
//
// Practical note for the proof: step() currently advances tick++ and runs all of
// SYSTEMS 1..5; with nothing held, SYSTEM 5 is a no-op, so calling step() then
// applyHazards(w, ..., w.tick) faithfully reproduces "between (4) and (5)".
//
// DAMAGE writes w.health (raw Fixed). IMPULSE writes w.vx/vy/vz (raw Fixed). TILE
// support writes w.py + Grounded. Nothing here hard-kills; the integrator decides
// death/cleanup. Index MUST be rebuilt against w for this tick before calling.
// ============================================================================

import { type WorldState, BodyFlag, hasFlag, setFlag } from '../world/state.ts';
import type { SpatialIndex } from '../spatial/index.ts';
import {
  type Fixed, ZERO, fromFloatConst, fromRaw, toRaw, add, sub, mul, div, sqrt,
  lt, lte,
} from '../fixed/fixed.ts';
import type {
  CrusherHazard, GustHazard, Hazard, SpikesHazard, TileHazard, TurretHazard,
} from './model.ts';
import { HazardKind } from './model.ts';
import { crusherPos, tileSolid, turretShot } from './schedule.ts';
import { jitterFixed } from './jitter.ts';

/** Jitter channels (distinct per effect so they don't correlate). */
const CH_CRUSHER_X = 1;
const CH_CRUSHER_Z = 101;
const CH_TURRET = 2;

/** Tiny knockback/shove jitter amplitude (raw Fixed ~0.05 u/tick). */
const JITTER_AMP: Fixed = fromFloatConst(0.05);
/** Turret on-hit forward shove magnitude (raw Fixed u/tick). */
const TURRET_SHOVE: Fixed = fromFloatConst(0.05);

/** Add a Fixed velocity delta into a raw-int velocity slot. */
function addVel(arr: Int32Array, id: number, dv: Fixed): void {
  arr[id] = toRaw(add(fromRaw(arr[id]!), dv));
}

/** Subtract damage (Fixed) from a body's health (raw Fixed). */
function damage(w: WorldState, id: number, dmg: Fixed): void {
  w.health[id] = toRaw(sub(fromRaw(w.health[id]!), dmg));
}

function inYBand(py: number, minY: number, maxY: number): boolean {
  return py >= minY && py <= maxY;
}

function applyCrusher(
  w: WorldState, h: CrusherHazard, index: SpatialIndex, tick: number,
  scratch: number[],
): void {
  const c = crusherPos(h, tick);
  index.queryRadius(c.x, c.z, h.radius, scratch);
  const impulse = fromRaw(h.impulse);
  const dmg = fromRaw(h.damage);
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]!;
    if (!hasFlag(w, id, BodyFlag.Alive)) continue;
    // Escape direction = from crusher center toward the body (push away).
    let ex: Fixed = sub(fromRaw(w.px[id]!), fromRaw(c.x));
    let ez: Fixed = sub(fromRaw(w.pz[id]!), fromRaw(c.z));
    const lenSq = add(mul(ex, ex), mul(ez, ez));
    if (lenSq === ZERO) {
      ex = fromRaw(65536); ez = ZERO; // dead-center: deterministic +x fallback
    } else {
      const len = sqrt(lenSq);
      ex = div(ex, len);
      ez = div(ez, len);
    }
    const jx = jitterFixed(tick, id, CH_CRUSHER_X, JITTER_AMP);
    const jz = jitterFixed(tick, id, CH_CRUSHER_Z, JITTER_AMP);
    addVel(w.vx, id, add(mul(ex, impulse), jx));
    addVel(w.vz, id, add(mul(ez, impulse), jz));
    damage(w, id, dmg);
  }
}

function applyTurret(
  w: WorldState, h: TurretHazard, index: SpatialIndex, tick: number,
  scratch: number[],
): void {
  const shot = turretShot(h, tick);
  if (!shot.active) return;
  index.queryRadius(shot.x, shot.z, h.hitRadius, scratch);
  const dmg = fromRaw(h.damage);
  const dirx = fromRaw(h.dx);
  const dirz = fromRaw(h.dz);
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]!;
    if (!hasFlag(w, id, BodyFlag.Alive)) continue;
    const j = jitterFixed(tick, id, CH_TURRET, JITTER_AMP);
    addVel(w.vx, id, add(mul(dirx, TURRET_SHOVE), j));
    addVel(w.vz, id, mul(dirz, TURRET_SHOVE));
    damage(w, id, dmg);
  }
}

function applyTile(
  w: WorldState, h: TileHazard, index: SpatialIndex, tick: number,
  scratch: number[],
): void {
  if (!tileSolid(h, tick)) return; // non-solid ⇒ no support; bodies fall.
  index.queryAABB(h.minX, h.minZ, h.maxX, h.maxZ, scratch);
  const topY = fromRaw(h.topY);
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]!;
    if (!hasFlag(w, id, BodyFlag.Alive)) continue;
    // A body at/below the top surface is supported: clamp to topY, kill downward
    // velocity, mark Grounded so gravity won't accumulate next tick.
    if (lte(fromRaw(w.py[id]!), topY)) {
      w.py[id] = h.topY;
      if (lt(fromRaw(w.vy[id]!), ZERO)) w.vy[id] = 0;
      setFlag(w, id, BodyFlag.Grounded);
    }
  }
}

function applyGust(
  w: WorldState, h: GustHazard, index: SpatialIndex, scratch: number[],
): void {
  index.queryAABB(h.minX, h.minZ, h.maxX, h.maxZ, scratch);
  const ix = fromRaw(h.ix);
  const iy = fromRaw(h.iy);
  const iz = fromRaw(h.iz);
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]!;
    if (!hasFlag(w, id, BodyFlag.Alive)) continue;
    if (!inYBand(w.py[id]!, h.minY, h.maxY)) continue;
    addVel(w.vx, id, ix);
    addVel(w.vy, id, iy);
    addVel(w.vz, id, iz);
  }
}

function applySpikes(
  w: WorldState, h: SpikesHazard, index: SpatialIndex, scratch: number[],
): void {
  index.queryAABB(h.minX, h.minZ, h.maxX, h.maxZ, scratch);
  const dmg = fromRaw(h.damage);
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]!;
    if (!hasFlag(w, id, BodyFlag.Alive)) continue;
    if (!inYBand(w.py[id]!, h.minY, h.maxY)) continue;
    damage(w, id, dmg);
  }
}

/**
 * Module-private reusable scratch buffer. It is cleared (length=0) by each query
 * (queryRadius/queryAABB set out.length=0 first), holds no cross-tick meaning,
 * and never affects output ordering, so it is determinism-safe.
 */
const _scratch: number[] = [];

/**
 * Resolve all hazards for the current tick. Mutates w (velocity / health / flags;
 * py for tiles). `index` MUST be rebuilt against w for this tick before calling.
 */
export function applyHazards(
  w: WorldState,
  hazards: ReadonlyArray<Hazard>,
  index: SpatialIndex,
  tick: number,
): void {
  for (let i = 0; i < hazards.length; i++) {
    const h = hazards[i]!;
    switch (h.kind) {
      case HazardKind.Crusher:
        applyCrusher(w, h, index, tick, _scratch);
        break;
      case HazardKind.Turret:
        applyTurret(w, h, index, tick, _scratch);
        break;
      case HazardKind.Tile:
        applyTile(w, h, index, tick, _scratch);
        break;
      case HazardKind.Gust:
        applyGust(w, h, index, _scratch);
        break;
      case HazardKind.Spikes:
        applySpikes(w, h, index, _scratch);
        break;
      default: {
        // Exhaustiveness guard (never reached): keeps the union honest.
        const _never: never = h;
        void _never;
      }
    }
  }
}
