// ============================================================================
// src/sim/collide/terrain.ts — the TERRAIN contract + a move-and-slide resolver.
// ============================================================================
//
// Bodies live in a hand/level-authored static world. We model that world as the
// cheapest thing that is both expressive enough for a tower arena and trivially
// deterministic:
//   - ONE ground plane at a fixed Y (the floor a body rests its base on), and
//   - a set of axis-aligned solid BOXES (walls, ledges, pillars, crates that are
//     baked into the level rather than dynamic bodies).
//
// WHY AXIS-ALIGNED BOXES
// ----------------------
// AABBs make body-vs-terrain a pure integer min/max test with no rotation, no
// dot products, no transcendentals — so the whole resolver is exact Q16.16
// arithmetic, identical on every engine (the determinism mandate, CLAUDE.md).
// Anything fancier (slopes, OBBs) can be approximated by stacked boxes for now
// and the interface below does not change.
//
// WHY MOVE-AND-SLIDE (axis-separated), NOT AN IMPULSE SOLVER
// ----------------------------------------------------------
// Terrain is INFINITE-mass and never moves; the only correct response is to push
// the body out of the solid by the SMALLEST penetration axis and zero the inbound
// velocity ON THAT AXIS only (so a body sliding along a wall keeps its tangential
// speed — "move and slide"). Resolving one axis at a time, X then Z then Y, in a
// fixed order, is order-independent for disjoint solids and fully deterministic.
//
// DERIVED/STATIC: a Terrain is authored level data, NOT part of WorldState. It is
// constant for a match, so it is never cloned/hashed/restored — rollback restores
// the bodies and re-runs the resolver against the same constant terrain.
// ============================================================================

import { type Fixed, toRaw, fromFloatConst, add, sub, lt, gt, ZERO, ONE_RAW } from '../fixed/fixed.ts';
import { type WorldState, BodyFlag } from '../world/state.ts';

// ============================================================================
// TERRAIN BROADPHASE (a uniform (x,z) bucket grid over the static solids).
// ----------------------------------------------------------------------------
// The resolver tests every body against every solid box — O(bodies × solids). That
// is fine for the small flat arena, but the 30×30 tower has ~8.7k boxes, so a full
// body roster (crew + puzzle bodies) pushes the per-tick cost to ~9 ms. This grid
// buckets the STATIC solids ONCE (cached per Terrain in a WeakMap — the terrain is
// immutable for a match) so each body only tests boxes in its own + neighbouring
// buckets. It is a PURE SUPERSET FILTER: a box that could overlap a body's query
// rect always shares a bucket the query visits, so the resolved result is BYTE-
// IDENTICAL to the exhaustive scan (the collide prove confirms the hashes). Only the
// candidate set shrinks. Determinism: candidates are returned as ASCENDING box
// indices, exactly the order the old `for s` loop visited them.
// ============================================================================

/** Bucket size in RAW Q16.16 units (~4 m, about one floor cell). */
const BUCKET_RAW = toRaw(fromFloatConst(4));

interface TerrainGrid {
  /** Map from packed bucket key → ascending list of box indices overlapping it. */
  readonly buckets: Map<number, number[]>;
}

/** Per-Terrain cached broadphase grid (built lazily, reused every tick). */
const gridCache = new WeakMap<Terrain, TerrainGrid>();

/** Pack integer bucket coords into one number key (xor-hash; lookup-only, never iterated). */
function bucketKey(gx: number, gz: number): number {
  return (gx * 73856093) ^ (gz * 19349663);
}

/** Floor-divide a raw coordinate into its bucket index (handles negatives correctly). */
function bucketCoord(raw: number): number {
  return Math.floor(raw / BUCKET_RAW);
}

/** Build (or fetch the cached) broadphase grid for a terrain's solids. */
function terrainGrid(terrain: Terrain): TerrainGrid {
  const cached = gridCache.get(terrain);
  if (cached) return cached;
  const buckets = new Map<number, number[]>();
  const solids = terrain.solids;
  for (let i = 0; i < solids.length; i++) {
    const b = solids[i]!;
    const gx0 = bucketCoord(b.minX), gx1 = bucketCoord(b.maxX);
    const gz0 = bucketCoord(b.minZ), gz1 = bucketCoord(b.maxZ);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = bucketKey(gx, gz);
        let list = buckets.get(k);
        if (!list) { list = []; buckets.set(k, list); }
        list.push(i);
      }
    }
  }
  // each bucket's box list is already ascending (we inserted in index order); when a
  // box spans multiple buckets it is appended ascending to each, so per-bucket order is
  // ascending. The GATHER below merges buckets and re-sorts to restore global ascending.
  const grid: TerrainGrid = { buckets };
  gridCache.set(terrain, grid);
  return grid;
}

/**
 * Per-box dedup STAMP buffer: gatherSolids marks each gathered box with the current call
 * stamp instead of using a Set (Set.add/clear churn dominated the broadphase cost). A box
 * is "already gathered this call" iff its stamp == the current stamp. Grown on demand;
 * holds no cross-tick state (the stamp monotonically increases per call). Scratch only.
 */
let dedupStamp = new Int32Array(0);
let curStamp = 0;

function ensureDedup(n: number): void {
  if (dedupStamp.length < n) dedupStamp = new Int32Array(n);
}

/**
 * Gather ascending box indices whose buckets overlap the raw (x,z) query rect into `out`
 * (cleared first). Dedup via a per-box stamp (no Set). The result is a SUPERSET of the
 * boxes that could overlap the rect, in ascending order (matching the old full-scan order
 * so resolution is byte-identical). Empty terrain / no nearby boxes → empty list.
 */
function gatherSolids(
  grid: TerrainGrid, count: number, minX: number, maxX: number, minZ: number, maxZ: number,
  out: number[],
): void {
  out.length = 0;
  ensureDedup(count);
  // bump the stamp; on the (astronomically rare) wraparound, clear so stale stamps can't
  // alias the new one. Keeps dedup correct without per-call clears in the common case.
  curStamp++;
  if (curStamp === 0x7fffffff) { dedupStamp.fill(0); curStamp = 1; }
  const stamp = curStamp;
  const gx0 = bucketCoord(minX), gx1 = bucketCoord(maxX);
  const gz0 = bucketCoord(minZ), gz1 = bucketCoord(maxZ);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const list = grid.buckets.get(bucketKey(gx, gz));
      if (!list) continue;
      for (let n = 0; n < list.length; n++) {
        const idx = list[n]!;
        if (dedupStamp[idx] === stamp) continue;
        dedupStamp[idx] = stamp;
        out.push(idx);
      }
    }
  }
  out.sort((p, q) => p - q);
}

/** Reusable broadphase scratch (one body at a time; holds no cross-tick state). */
const bpOut: number[] = [];
/** Separate scratch for step-up (it runs INSIDE resolveTerrain, before the main gather). */
const stepOut: number[] = [];

/**
 * AUTO STEP-UP height (meters, raw Q16.16): the tallest ledge whose TOP a body
 * will automatically climb onto when its horizontal motion runs into it, instead
 * of being blocked by its side. Anything taller than this is a wall and still
 * blocks (move & slide).
 *
 * WHY 0.55 u (was 0.5): the tower's stairs rise RISE = 0.5 u per tread
 * (game/tower.ts). The step window must be at LEAST one RISE so a body walks up a
 * flight without jumping each tread. We set it a HAIR above RISE rather than exactly
 * equal because a grounded body's feet can sit a sub-cm below the tread top it last
 * climbed onto (fixed-point rounding, or a frame where it slid before it finished
 * rising) — with the window at exactly 0.5 those boundary ticks fail `top - base <=
 * step` and the next tread reads as a WALL, stalling the climb. 0.55 keeps the next
 * tread inside the window with margin while staying BELOW the 0.6 u seam lip (so lips
 * are NOT auto-climbed — they remain a deliberate speed bump) and well under the
 * Anchor's ~0.71 u jump apex. Anything taller than 0.55 u in one face still blocks.
 * Authored once as a Fixed const (no runtime float) → bit-identical on every peer.
 */
export const MAX_STEP_HEIGHT: Fixed = fromFloatConst(0.55);

/**
 * Per-tick SMOOTH-CLIMB rate (meters/tick, raw Q16.16): the most a stepping body's
 * feet rise toward a ledge top in ONE tick. The step-up does NOT teleport the body
 * onto the ledge; it lifts py by at most this much each tick, so a 0.5 u riser is
 * mounted over a few ticks and reads as WALKING up rather than snapping/jittering.
 *
 * WHY ~0.18 u/tick (≈ 10.8 u/s at 60 Hz): fast enough that a 0.5 u tread is fully
 * climbed in ~3 ticks (~50 ms) — quicker than the body crosses one 0.9 u tread at
 * the 7 u/s walk speed (~7-8 ticks) — so on a continuous staircase the body never
 * stalls: it finishes rising each tread well before it reaches the next riser, then
 * strides forward, then rises again. Slower than this and a brisk walker would pile
 * up against successive risers faster than it can climb; faster and a single tall-ish
 * (near-0.55) step looks like a teleport again. Chosen as a clean authoring constant.
 * Deterministic: the lift is min(remainingRise, this) in exact fixed-point, never an
 * overshoot, so the same inputs always produce the identical per-tick py.
 */
export const STEP_CLIMB_RATE: Fixed = fromFloatConst(0.18);

/**
 * One axis-aligned solid box. All six bounds are RAW Q16.16 ints (matching the
 * world-state convention). minX<=maxX, minY<=maxY, minZ<=maxZ (caller's contract;
 * makeBox enforces it). y is UP (consistent with vec3 / step.ts).
 */
export interface AABB {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * The static terrain: a ground plane (raw Fixed Y) plus a list of solid boxes.
 * A plain immutable struct — authored once, shared, never mutated by the sim.
 */
export interface Terrain {
  /** The single ground plane height (raw Fixed). A body's BASE rests here. */
  readonly groundY: number;
  /** Solid boxes the bodies must stay out of. Iterated in array order (stable). */
  readonly solids: readonly AABB[];
}

/** Build an AABB from Fixed bounds, normalizing min/max so callers can be sloppy. */
export function makeBox(
  minX: Fixed, minY: Fixed, minZ: Fixed,
  maxX: Fixed, maxY: Fixed, maxZ: Fixed,
): AABB {
  return {
    minX: toRaw(lt(minX, maxX) ? minX : maxX),
    minY: toRaw(lt(minY, maxY) ? minY : maxY),
    minZ: toRaw(lt(minZ, maxZ) ? minZ : maxZ),
    maxX: toRaw(gt(maxX, minX) ? maxX : minX),
    maxY: toRaw(gt(maxY, minY) ? maxY : minY),
    maxZ: toRaw(gt(maxZ, minZ) ? maxZ : minZ),
  };
}

/**
 * Convenience: a flat floor at groundY plus four perimeter walls forming an arena
 * of half-extent `halfExtent` (meters, Fixed), wall height `wallHeight`, wall
 * thickness `thickness`. Handy for proofs/sandboxes; real levels author their own
 * Terrain. Deterministic (pure Fixed arithmetic).
 */
export function makeArena(
  groundY: Fixed,
  halfExtent: Fixed,
  wallHeight: Fixed,
  thickness: Fixed,
): Terrain {
  const lo = sub(ZERO, halfExtent); // -halfExtent
  const hi = halfExtent;
  const top = add(groundY, wallHeight);
  const inLo = add(lo, thickness);
  const inHi = sub(hi, thickness);
  const solids: AABB[] = [
    // west wall (−X face)
    makeBox(lo, groundY, lo, inLo, top, hi),
    // east wall (+X face)
    makeBox(inHi, groundY, lo, hi, top, hi),
    // south wall (−Z face), between the X walls so corners don't double-thick
    makeBox(inLo, groundY, lo, inHi, top, inLo),
    // north wall (+Z face)
    makeBox(inLo, groundY, inHi, inHi, top, hi),
  ];
  return { groundY: toRaw(groundY), solids };
}

/**
 * Keep every ALIVE, non-carried body out of the terrain solids and on/above the
 * ground plane. MUTATES `w` in place. Pure function of (w, terrain).
 *
 * ALGORITHM (per body, ascending id — the only iteration order):
 *   1. Ground plane: if the body's base is below groundY, lift it so the base
 *      rests on the plane and zero downward Y velocity; mark Grounded.
 *   1.5 Auto step-up: BEFORE the side-blocking slide pass, if the body is running
 *      into a low ledge (a solid whose TOP is at most MAX_STEP_HEIGHT above the
 *      body's feet) and there is headroom to stand on it, lift the body's feet onto
 *      that ledge's top. This turns the side block (step 2 would zero its horizontal
 *      velocity) into a smooth climb. Walls taller than MAX_STEP_HEIGHT are NOT
 *      stepped and still block normally. See stepUpOntoLedges.
 *   2. For each solid box (array order): treat the body as a circle of `radius`
 *      in plan with a vertical span [base, base+2*halfHeight]. The body-vs-box
 *      overlap region is the box inflated by the body's radius on X/Z (Minkowski
 *      sum of an AABB and a circle, conservatively boxed — exact for face contacts
 *      and slightly generous at corners, which is fine and stays deterministic).
 *      If the inflated box overlaps on all three axes, push the body out along the
 *      axis of MINIMUM penetration and zero that velocity component (move & slide).
 *
 * Carried bodies (grabbedBy set) are owned by the carry transform (step SYSTEM 5),
 * so we skip them here — the carrier's own terrain resolution keeps the pair sane.
 */
export function resolveTerrain(w: WorldState, terrain: Terrain): void {
  const count = w.count;
  const groundY = terrain.groundY;
  const solids = terrain.solids;
  const grid = terrainGrid(terrain);
  for (let i = 0; i < count; i++) {
    const fl = w.flags[i]!;
    if ((fl & BodyFlag.Alive) === 0) continue;
    if (w.grabbedBy[i] !== -1) continue; // carried — carrier owns transform

    // --- 1. ground plane (base on the plane) ---
    const half = w.halfHeight[i]!;
    const baseFloor = groundY + half; // center Y so the base sits on groundY
    if (w.py[i]! < baseFloor) {
      w.py[i] = baseFloor;
      if (w.vy[i]! < 0) w.vy[i] = 0;
      w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
    }

    // --- 1.5 auto step-up (lift onto low ledges before they can side-block) ---
    stepUpOntoLedges(w, i, solids, grid);

    // --- 2. solid boxes (move & slide, min-penetration axis) ---
    // Broadphase: only boxes near the body. The loop MUTATES px/pz as it pushes the body
    // out, so we inflate the query by radius + a one-bucket HALO so any box the body could
    // be pushed into mid-loop is already a candidate (a single push ≤ one box width ≈ one
    // bucket). Ascending indices ⇒ resolution order matches the old full scan exactly →
    // byte-identical result (the collide prove confirms the hashes).
    const r = w.radius[i]!;
    const halo = r + BUCKET_RAW;
    gatherSolids(grid, solids.length, w.px[i]! - halo, w.px[i]! + halo, w.pz[i]! - halo, w.pz[i]! + halo, bpOut);
    for (let si = 0; si < bpOut.length; si++) {
      const s = bpOut[si]!;
      const box = solids[s]!;
      // inflate the box by the body radius on X/Z (circle-vs-AABB → point-vs-inflated-AABB)
      const bMinX = box.minX - r;
      const bMaxX = box.maxX + r;
      const bMinZ = box.minZ - r;
      const bMaxZ = box.maxZ + r;
      // vertical span of the (upright capsule) body: [base, top]
      const base = w.py[i]! - half;
      const topY = w.py[i]! + half;

      const px = w.px[i]!;
      const pz = w.pz[i]!;
      // overlap test on all three axes
      if (px <= bMinX || px >= bMaxX) continue;
      if (pz <= bMinZ || pz >= bMaxZ) continue;
      if (topY <= box.minY || base >= box.maxY) continue;

      // penetration depth toward each face (always positive given the overlap above)
      const penXNeg = px - bMinX; // push to −X
      const penXPos = bMaxX - px; // push to +X
      const penZNeg = pz - bMinZ; // push to −Z
      const penZPos = bMaxZ - pz; // push to +Z
      const penYNeg = topY - box.minY; // push down (body below box) — rare
      const penYPos = box.maxY - base; // push up (body on top of box)

      // smallest of the six → the separation axis (ties resolved by fixed order)
      const minX = penXNeg < penXPos ? penXNeg : penXPos;
      const minZ = penZNeg < penZPos ? penZNeg : penZPos;
      const minY = penYNeg < penYPos ? penYNeg : penYPos;

      if (minX <= minZ && minX <= minY) {
        // resolve on X
        if (penXNeg < penXPos) w.px[i] = px - penXNeg;
        else w.px[i] = px + penXPos;
        w.vx[i] = 0;
      } else if (minZ <= minY) {
        // resolve on Z
        if (penZNeg < penZPos) w.pz[i] = pz - penZNeg;
        else w.pz[i] = pz + penZPos;
        w.vz[i] = 0;
      } else {
        // resolve on Y
        if (penYPos <= penYNeg) {
          // sitting on top of the box → treat its top as a floor
          w.py[i] = box.maxY + half;
          if (w.vy[i]! < 0) w.vy[i] = 0;
          w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
        } else {
          // bumped the underside of the box
          w.py[i] = box.minY - half;
          if (w.vy[i]! > 0) w.vy[i] = 0;
        }
      }
    }
  }
}

/**
 * AUTO STEP-UP for one body (raw-int math, deterministic & order-independent).
 *
 * Runs BEFORE the side-blocking slide pass. Looks for the HIGHEST solid the body is
 * horizontally running into whose TOP is a climbable LEDGE — its top is above the
 * body's current feet but no more than MAX_STEP_HEIGHT above them — and, if the body
 * would have HEADROOM standing there, raises the body's feet TOWARD that top by at
 * most STEP_CLIMB_RATE this tick (a smooth, rate-limited climb — never a teleport).
 *
 * WHY rate-limited (the smoothing): snapping py straight to the ledge top reads as a
 * vertical pop/jitter and, on a staircase, as the body flickering up each riser. We
 * instead lift by min(remainingRise, STEP_CLIMB_RATE) per tick:
 *   - If the WHOLE remaining rise fits in one tick's budget, the feet land exactly on
 *     the ledge top: the body is now standing on the box (no vertical overlap), so the
 *     slide pass does NOT side-block it and it strides forward. Small steps (and the
 *     last tick of a big one) complete instantly, as before.
 *   - If the rise is BIGGER than the budget, we lift only part way. The feet are still
 *     below the ledge top, so the slide pass WILL hold the body flush against the riser
 *     face this tick (no forward progress, no penetration) while it keeps rising. Over
 *     the next couple of ticks the lift completes and the body walks on. Visually: it
 *     climbs UP the face of the step smoothly instead of popping on top.
 * The lift is min(...) in exact fixed-point, so it NEVER overshoots the ledge top.
 *
 * WHY detection uses a SKIN (the "doesn't fire" bug this fixes): the slide pass
 * separates a blocked body to EXACTLY the radius-inflated face (px == box.minX - r).
 * At that flush position a strict `px <= box.minX - r` overlap test reads "not
 * touching", so on every subsequent tick the OLD step-up skipped the very box the body
 * was pinned against and never climbed — the body just wedged against the riser. We
 * test overlap with a small SKIN added to the inflated box so a body resting flush
 * against (or a hair inside) the face still registers as "running into" the step and
 * gets lifted. The skin is tiny (a few mm) so it never reaches a box the body is not
 * actually in contact with.
 *
 * WHY a pre-pass that picks the highest qualifying ledge (not per-box in the slide
 * loop): a flight of stair treads, or a corner where two treads meet, overlaps the
 * body's inflated footprint with SEVERAL boxes at once. Choosing the single highest
 * climbable top among them and lifting toward it once is order-INDEPENDENT (`max` over
 * the candidate set, plus a headroom scan over ALL solids) and correct.
 *
 * WHY it must NOT fire on tall walls: only boxes whose top is within MAX_STEP_HEIGHT
 * of the feet qualify, so a wall (top far above the feet) is never a step candidate and
 * the slide pass blocks it normally — the determinism/correctness invariants for walls
 * are untouched.
 *
 * HEADROOM: lifting is only legal if, standing with feet at the ledge top, no OVERHANG
 * traps the body's head. An overhang is a solid whose BOTTOM (minY) hangs above the new
 * feet yet below the new head. Ground-connected solids (minY at/below the new feet) are
 * the treads/walls the body stands on/beside, NOT overhangs, so they never veto the
 * step. A tiny epsilon keeps flush surfaces from counting.
 *
 * Pure function of (w[i], solids); MUTATES only w.py[i] (and clears downward vy / sets
 * Grounded, exactly as standing on a surface does). No floats, no allocation.
 */
function stepUpOntoLedges(w: WorldState, i: number, solids: readonly AABB[], grid: TerrainGrid): void {
  // Don't yank a body that is RISING (mid-jump) onto a ledge — that would cut a jump
  // short / pin it to a wall it is trying to clear. A body steps up only when it is
  // walking (grounded, vy==0) or descending (vy<0) — at which point mounting a ledge
  // it ran into is exactly the intended behaviour. This keeps jumps/gravity intact.
  if (w.vy[i]! > 0) return;

  const half = w.halfHeight[i]!;
  const r = w.radius[i]!;
  const px = w.px[i]!;
  const pz = w.pz[i]!;
  const base = w.py[i]! - half; // current feet Y (raw)
  const maxStep = toRaw(MAX_STEP_HEIGHT);
  const climbRate = toRaw(STEP_CLIMB_RATE);
  // tiny tolerance (raw) so flush/touching surfaces don't read as overlaps. 1/256 u.
  const EPS = ONE_RAW >> 8;
  // CONTACT SKIN (raw): the slide pass parks a blocked body EXACTLY on the inflated
  // face, so the overlap test must count "flush" (and a hair past) as touching, or the
  // step the body is pinned against is skipped forever. ~1/512 u (≈ 2 mm). Strictly
  // smaller than EPS so a body flush on a face is detected as a step but flush surfaces
  // still don't false-trip the headroom test. See doc comment ("WHY detection ... SKIN").
  const SKIN = ONE_RAW >> 9;

  // horizontal (plan) overlap of the body circle with a radius-inflated box, made
  // inclusive of flush contact via SKIN (so a body slid to rest on the face counts).
  const overlapsXZ = (box: AABB): boolean =>
    px > box.minX - r - SKIN && px < box.maxX + r + SKIN &&
    pz > box.minZ - r - SKIN && pz < box.maxZ + r + SKIN;

  // Broadphase candidates near the body (px/pz are fixed for the whole step-up). The body
  // does not move here, so radius + SKIN is the exact reach; a one-bucket halo keeps the
  // candidate set a safe superset. Same ascending order as the old full scan.
  const halo = r + BUCKET_RAW;
  gatherSolids(grid, solids.length, px - halo, px + halo, pz - halo, pz + halo, stepOut);

  // 1. find the highest climbable ledge top among the boxes we're running into.
  let bestTop = base; // nothing below or at the feet is a step; start at the feet
  let found = false;
  for (let si = 0; si < stepOut.length; si++) {
    const box = solids[stepOut[si]!]!;
    if (!overlapsXZ(box)) continue;
    const top = box.maxY;
    // a step is a TOP strictly above the feet but within one step height of them
    if (top <= base || top > base + maxStep) continue;
    if (top > bestTop) { bestTop = top; found = true; }
  }
  if (!found) return;

  // 2. headroom: with feet at bestTop, no OVERHANG may hang inside the body's span
  // [bestTop, bestTop+2*half). Only solids whose BOTTOM (minY) is strictly above the
  // new feet and below the new head count — those are ceilings the body would clip.
  // Ground-connected solids (minY at/below the new feet) are walls/treads the body
  // stands on/beside, NOT overhangs, so they never veto the step (see doc comment).
  const newBase = bestTop;
  const newTop = bestTop + half + half;
  for (let si = 0; si < stepOut.length; si++) {
    const box = solids[stepOut[si]!]!;
    if (!overlapsXZ(box)) continue;
    if (box.minY <= newBase + EPS) continue; // ground-connected (wall/tread), not a ceiling
    if (box.minY >= newTop - EPS) continue; // overhang sits at/above the head — clears
    return; // an overhang hangs in the body's standing column — cannot step up here
  }

  // 3. SMOOTH lift TOWARD the ledge: raise the feet by at most climbRate this tick,
  // clamped so we never overshoot bestTop. When the full rise fits in one tick the
  // feet land exactly on the ledge (body stands → slide pass lets it walk on); when it
  // doesn't, the body keeps rising against the face over the next few ticks. Either
  // way treat the ledge as a floor (kill downward vy, mark Grounded) so gravity does
  // not undo the climb mid-rise.
  const remaining = bestTop - base; // > 0 (found a top above the feet)
  const lift = remaining < climbRate ? remaining : climbRate;
  w.py[i] = w.py[i]! + lift;
  if (w.vy[i]! < 0) w.vy[i] = 0;
  w.flags[i] = (w.flags[i]! | BodyFlag.Grounded) & 0xffff;
}

/** Empty terrain (just a ground plane at y) — for tests that want body-body only. */
export function flatGround(groundY: Fixed = ZERO): Terrain {
  return { groundY: toRaw(groundY), solids: [] };
}
