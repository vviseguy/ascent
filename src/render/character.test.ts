// ============================================================================
// src/render/character.test.ts — smoke tests for the procedural stubby body.
// ============================================================================
// View-layer code, so this is a robustness check (no determinism contract): build
// a character for every role and drive it through every animation state, asserting
// it never produces a non-finite transform and stays in sane scale bounds. Catches
// NaN/throw regressions in the procedural animator without needing a GPU/browser.
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { StubbyCharacter, CharRole, CREW_COLORS, type AnimSample } from './character.ts';

/** A neutral idle sample; spread-override per case. */
function sample(over: Partial<AnimSample> = {}): AnimSample {
  return {
    speed: 0, leanFwd: 0, leanSide: 0, vy: 0, grounded: true, justLanded: false, landStrength: 0,
    holding: false, carryMass: -1, grabbed: false, struggle: 0, throwCharge: 0, justThrew: false,
    rushing: false, staggered: false, downed: false, emissive: 0, tick: 0, ...over,
  };
}

/** True if every component of every transform in the subtree is finite. */
function allFinite(root: THREE.Object3D): boolean {
  let ok = true;
  root.traverse((o) => {
    for (const v of [o.position, o.scale, o.rotation] as const) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) ok = false;
    }
  });
  return ok;
}

describe('StubbyCharacter', () => {
  const roles = [CharRole.Runner, CharRole.Bulwark, CharRole.Mender, CharRole.Engineer, CharRole.Breaker, CharRole.Anchor];

  it('builds a body with parts for every role', () => {
    for (const role of roles) {
      const c = new StubbyCharacter(role, CREW_COLORS[0]!, 0.4, 0.9);
      let meshes = 0;
      c.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
      expect(meshes).toBeGreaterThanOrEqual(6); // torso, head, 2 eyes, 2 arms, 2 legs, 2 feet
      expect(allFinite(c.root)).toBe(true);
    }
  });

  it('drives every animation state without NaN/throw and keeps scale sane', () => {
    const states: Partial<AnimSample>[] = [
      {},                                                        // idle
      { speed: 6, leanFwd: 6 },                                  // sprint
      { grounded: false, vy: 7 },                                // rising
      { grounded: false, vy: -9 },                               // falling
      { grounded: true, justLanded: true, landStrength: 1 },     // hard landing
      { holding: true, carryMass: 3 },                           // carry the Anchor
      { holding: true, carryMass: 1, throwCharge: 0.8 },         // throw wind-up
      { holding: false, justThrew: true },                       // throw release
      { grabbed: true, struggle: 0.9 },                          // helpless wriggle
      { rushing: true, leanFwd: 9 },                             // dash
      { staggered: true },                                       // hit-stun
      { downed: true },                                          // slump
    ];
    const c = new StubbyCharacter(CharRole.Bulwark, CREW_COLORS[2]!, 0.55, 1.0);
    let tick = 0;
    for (const st of states) {
      for (let f = 0; f < 30; f++) {                             // ~0.5s at 60fps per state
        c.update(sample({ ...st, tick: tick++ }), 1 / 60);
        expect(allFinite(c.root)).toBe(true);
      }
    }
    // after a settle, the body should be near neutral vertical scale (not collapsed/exploded)
    for (let f = 0; f < 60; f++) c.update(sample({ tick: tick++ }), 1 / 60);
    const pose = c.root.children[0]!.children[0]!; // root → scaleGroup → poseGroup
    expect(pose.scale.y).toBeGreaterThan(0.8);
    expect(pose.scale.y).toBeLessThan(1.2);
  });

  it('tolerates a huge dt (tab refocus) without exploding', () => {
    const c = new StubbyCharacter(CharRole.Runner, CREW_COLORS[1]!, 0.4, 0.9);
    c.update(sample({ speed: 5, justLanded: true, landStrength: 1 }), 5.0); // 5s frame
    expect(allFinite(c.root)).toBe(true);
  });
});
