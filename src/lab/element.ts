// ============================================================================
// src/lab/element.ts — the ASSET LAB element contract.
// ============================================================================
//
// An "element" is one self-contained, procedurally-generated piece of game art:
// a material slab, a plant clump, a railing, a lamp… Each lives in its own file
// under src/lab/elements/ and DEFAULT-EXPORTS a LabElement. The lab page
// auto-discovers them with import.meta.glob, so adding an element = adding a file
// (no shared registry to conflict on — important for parallel design agents).
//
// RULES for elements (so they can graduate into the game renderer):
//  - Fully procedural from `seed` (no external assets, no network): same seed →
//    same look. Use a local seeded PRNG (mulberry32 below) — this is VIEW-layer
//    tooling, floats are fine, but reproducibility makes screenshot iteration sane.
//  - Self-contained resources: build() creates its own geometries/materials/
//    canvas textures. Nothing global.
//  - Optional `update(timeSec, actors)` animates the element and lets it REACT to
//    moving bodies (actors = world-space positions of nearby players). The game
//    renderer will call this with real player positions; the lab calls it with a
//    demo capsule orbiting through the element (?actor=1).
//  - Keep it cheap: a clump/prop should be ONE draw call where possible
//    (instancing, merged geometry, canvas textures).
// ============================================================================

import type * as THREE from 'three';

export interface LabElementBuild {
  /** The element's scene-graph root (positioned with its base at y=0). */
  root: THREE.Object3D;
  /**
   * Optional per-frame animation/reactivity hook. `timeSec` is scene time;
   * `actors` are world-space positions of nearby moving bodies (players).
   */
  update?: (timeSec: number, actors: readonly THREE.Vector3[]) => void;
  /** Rough ground-plane radius (u) — the lab frames the camera from this. */
  radius?: number;
}

export interface LabElement {
  /** Display name (the element ID is its filename). */
  name: string;
  /** One-liner shown in the lab HUD: what this element is for in the game. */
  describe: string;
  /** Build a fresh instance for `seed`. */
  build(seed: number): LabElementBuild;
}

/** Small seeded PRNG for element generation (view-layer; reproducible looks). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
