// ============================================================================
// Fixed-point vector math (vec2 / vec3) over `Fixed`.
// ============================================================================
//
// The sim is "2.5D": movement happens on the floor plane while a vertical axis
// carries falls, throw arcs, and climbing. We provide both vec2 (plane) and
// vec3 (full) so different subsystems can use whichever is natural; both are
// pure-functional over immutable plain objects for clarity and determinism.
// (The body layer will later pack hot data into struct-of-arrays for cache
// performance; this module is the readable reference algebra.)
//
// Convention: vec3 is { x, y, z } with y = UP. vec2 is the { x, z } ground plane.
// ============================================================================

import type { Fixed } from './fixed.ts';
import { add, sub, mul, div, sqrt, ZERO, eq } from './fixed.ts';

export interface Vec2 {
  readonly x: Fixed;
  readonly z: Fixed;
}
export interface Vec3 {
  readonly x: Fixed;
  readonly y: Fixed;
  readonly z: Fixed;
}

// ---- vec2 ------------------------------------------------------------------
export const v2 = (x: Fixed, z: Fixed): Vec2 => ({ x, z });
export const V2_ZERO: Vec2 = { x: ZERO, z: ZERO };

export const v2add = (a: Vec2, b: Vec2): Vec2 => ({ x: add(a.x, b.x), z: add(a.z, b.z) });
export const v2sub = (a: Vec2, b: Vec2): Vec2 => ({ x: sub(a.x, b.x), z: sub(a.z, b.z) });
export const v2scale = (a: Vec2, s: Fixed): Vec2 => ({ x: mul(a.x, s), z: mul(a.z, s) });
export const v2dot = (a: Vec2, b: Vec2): Fixed => add(mul(a.x, b.x), mul(a.z, b.z));
export const v2lenSq = (a: Vec2): Fixed => v2dot(a, a);
export const v2len = (a: Vec2): Fixed => sqrt(v2lenSq(a));

/** Unit vector, or ZERO vector if input is zero-length (deterministic, no NaN). */
export function v2normalize(a: Vec2): Vec2 {
  const len = v2len(a);
  if (eq(len, ZERO)) return V2_ZERO;
  return { x: div(a.x, len), z: div(a.z, len) };
}

export const v2dist = (a: Vec2, b: Vec2): Fixed => v2len(v2sub(a, b));
export const v2distSq = (a: Vec2, b: Vec2): Fixed => v2lenSq(v2sub(a, b));

// ---- vec3 ------------------------------------------------------------------
export const v3 = (x: Fixed, y: Fixed, z: Fixed): Vec3 => ({ x, y, z });
export const V3_ZERO: Vec3 = { x: ZERO, y: ZERO, z: ZERO };

export const v3add = (a: Vec3, b: Vec3): Vec3 => ({ x: add(a.x, b.x), y: add(a.y, b.y), z: add(a.z, b.z) });
export const v3sub = (a: Vec3, b: Vec3): Vec3 => ({ x: sub(a.x, b.x), y: sub(a.y, b.y), z: sub(a.z, b.z) });
export const v3scale = (a: Vec3, s: Fixed): Vec3 => ({ x: mul(a.x, s), y: mul(a.y, s), z: mul(a.z, s) });
export const v3dot = (a: Vec3, b: Vec3): Fixed =>
  add(add(mul(a.x, b.x), mul(a.y, b.y)), mul(a.z, b.z));
export const v3lenSq = (a: Vec3): Fixed => v3dot(a, a);
export const v3len = (a: Vec3): Fixed => sqrt(v3lenSq(a));

export function v3normalize(a: Vec3): Vec3 {
  const len = v3len(a);
  if (eq(len, ZERO)) return V3_ZERO;
  return { x: div(a.x, len), y: div(a.y, len), z: div(a.z, len) };
}

export const v3dist = (a: Vec3, b: Vec3): Fixed => v3len(v3sub(a, b));
export const v3distSq = (a: Vec3, b: Vec3): Fixed => v3lenSq(v3sub(a, b));

/** Ground-plane projection of a vec3 (drops y). */
export const v3toGround = (a: Vec3): Vec2 => ({ x: a.x, z: a.z });
/** Lift a ground vec2 to vec3 at height y. */
export const v2toV3 = (a: Vec2, y: Fixed): Vec3 => ({ x: a.x, y, z: a.z });
