// ============================================================================
// src/lab/world-object.ts — the WORLD-OBJECT contract (docs/15).
// ============================================================================
//
// A WorldObject is the VIEW/AUTHORING-layer model of a tangible thing in the
// world: a wall, a table, a door, a whole staircase room. It is a SUPERSET of a
// LabElement (build(seed) → { root }) with three additions that the game needs:
//
//   1. VARIANTS — named visual "modes/versions" of the same object (a Door has
//      'plain' | 'barred' | 'handled'). This is how one model carries different
//      textures/fittings (a door's handle, its metal bars) without new types.
//   2. FOOTPRINT — the collision shape, authored RIGHT NEXT TO the visual, in
//      object-local space. One definition can then feed both the renderer AND the
//      collider — docs/13 §C-bis "collision matches the visual". (The sim stays
//      AABB + fixed-point; this is just where the boxes are authored.)
//   3. LEVEL + COMPOSITION — 'object' → 'grouping' → 'room'. A grouping/room
//      build() COMPOSES other WorldObjects, so abstraction stacks.
//
// Like LabElement, a WorldObject is pure VIEW: floats + seeded randomness are
// fine, it never touches src/sim, and gameplay-affecting facts (where a door IS)
// come from the deterministic generator — only cosmetic variant picks live here.
// ============================================================================

import type * as THREE from 'three';

/** A collision box in OBJECT-LOCAL space (centre + half-extents, metres). */
export interface FootprintBox {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
}

/** The collision shape authored alongside the visual (empty = non-colliding decor). */
export interface Footprint {
  boxes: FootprintBox[];
}

export interface WorldObjectBuild {
  /** Scene-graph root, base at local y=0 (same convention as LabElement). */
  root: THREE.Object3D;
  /** Rough ground-plane radius (u) — the viewer frames the camera from this. */
  radius?: number;
  /** Collision shape (object-local). Drives the collider when wired to the sim. */
  footprint?: Footprint;
  /** Optional per-frame animation/reactivity (actors = nearby world-space player positions). */
  update?: (timeSec: number, actors: readonly THREE.Vector3[]) => void;
}

export type WorldObjectLevel = 'object' | 'grouping' | 'room';

export interface WorldObject {
  /** Display name. The object ID is its filename (objects/<id>.ts). */
  name: string;
  /** One-liner: what this is for in the game. */
  describe: string;
  /** Abstraction level — individual object, a grouping/prefab, or a whole room. */
  level: WorldObjectLevel;
  /** Named visual modes; the first is the default. Always at least one. */
  variants: string[];
  /** Build a fresh instance for (variant, seed). Unknown variant → fall back to variants[0]. */
  build(variant: string, seed: number): WorldObjectBuild;
}
