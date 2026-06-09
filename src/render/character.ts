// ============================================================================
// src/render/character.ts — procedural STUBBY/CUTE character (view-only).
// ============================================================================
//
// The first step of the docs/06 character pipeline (Phase 1: "procedural juice,
// no art"). A chunky ~1×1×1.25 body (Fall-Guys / Gang-Beasts chibi proportion)
// composed entirely from Three.js primitives — NO imported model, NO skeleton,
// NO asset dependency — and animated 100% from SIM STATE via a tiny procedural
// rig. When real rigged .glb models land (docs/06 §App-B), this same `update()`
// contract (an AnimSample in, poses out) is what an AnimationMixer state machine
// replaces; the renderer integration stays identical.
//
// DETERMINISM CONTRACT (CLAUDE.md / docs/06 §0): this is pure view code. Every
// POSE-SELECTING input (speed, grounded, holding, throwCharge, …) is read from
// the deterministic sim by the renderer and handed in via `AnimSample`, so all
// peers pick the same pose from the same tick. Only the PLAYBACK PHASE here
// (stride accumulator, land-spring decay, idle breathe) advances on render
// wall-clock `dt` — exactly like an AnimationMixer's clip time, and equally
// view-safe: nothing computed here is ever read back into the sim.
//
// LOCAL FRAME: feet at y=0 growing +Y; FRONT is +X (facing=0). The renderer puts
// the root at the interpolated body centre and applies rotation.y = -facing, so
// the eyes turn to wherever the body faces/aims.
// ============================================================================

import * as THREE from 'three';

/** The 4 crew identity hues (docs/06 §1.4 — max mutual + colorblind separation). */
export const CREW_COLORS: readonly number[] = [0x2fa8ff, 0xffb02e, 0xff3fa4, 0x36e0a0];
/** The gold Anchor (docs/06 — the precious VIP reads gold from any angle). */
export const ANCHOR_COLOR = 0xffd23f;

/** Roles (mirrors sim Role indices; kept local so character.ts has no sim import). */
export const enum CharRole { Runner = 0, Bulwark = 1, Mender = 2, Engineer = 3, Breaker = 4, Anchor = 5, None = 6 }

/**
 * Everything the animator needs for one body this frame. The renderer fills it
 * from sim-truth fields (the determinism-relevant SELECTION); the character only
 * turns it into poses. All distances/speeds are in world float units (u, u/s).
 */
export interface AnimSample {
  speed: number;        // horizontal sim speed |(vx,vz)| — idle vs walk vs run
  leanFwd: number;      // sim velocity component along facing (+ = moving forward)
  leanSide: number;     // sim velocity component across facing (+ = strafing left)
  vy: number;           // sim vertical velocity (+ up)
  grounded: boolean;
  justLanded: boolean;  // a sim-tick grounded edge fired since last frame (one-shot)
  landStrength: number; // 0..1, from the cached last-airborne |vy| (squash depth)
  holding: boolean;     // carrying another body → carry pose + weight sag
  carryMass: number;    // 0..3 massClass of the carried body (sag depth); -1 if none
  grabbed: boolean;     // being carried → helpless wriggle
  struggle: number;     // 0..1 struggle progress fraction (wriggle intensity)
  throwCharge: number;  // 0..1 wind-up while holding + charging
  justThrew: boolean;   // a throw released since last frame (one-shot fling)
  rushing: boolean;     // mid dash → streamlined forward commit
  staggered: boolean;   // hit-stun recoil
  downed: boolean;      // downed/vulnerable beat → slump
  emissive: number;     // per-frame emissive hex (held pulse / vulnerable pulse)
  tick: number;         // sim tick — deterministic phase for wriggle/idle if needed
}

// ---- proportion tuning -----------------------------------------------------
// Built at BASE_WIDTH so the torso width maps to the body's collision diameter;
// per-role multipliers reshape the silhouette (docs/06 §1.6 "shape = category").
const BASE_WIDTH = 0.8;               // == a Player's collision diameter (radius 0.4)
const TOTAL_HEIGHT = 1.27;            // ~1.25× width → the requested stubby ratio

interface RoleShape {
  head: number;   // head scale (cute = big)
  torsoW: number; // torso width/depth
  torsoH: number; // torso height
  stance: number; // leg spread + body width feel
  height: number; // overall vertical scale (Runner tall, Bulwark/Anchor short)
  armR: number;   // arm thickness
  asym: number;   // Breaker: extra mass on the right arm
}
const ROLE_SHAPE: Record<number, RoleShape> = {
  [CharRole.Runner]:   { head: 0.88, torsoW: 0.88, torsoH: 1.08, stance: 0.9,  height: 1.12, armR: 0.9,  asym: 1.0 },
  [CharRole.Bulwark]:  { head: 0.92, torsoW: 1.30, torsoH: 0.86, stance: 1.25, height: 0.9,  armR: 1.25, asym: 1.0 },
  [CharRole.Mender]:   { head: 1.18, torsoW: 1.02, torsoH: 0.98, stance: 0.95, height: 1.0,  armR: 0.95, asym: 1.0 },
  [CharRole.Engineer]: { head: 0.95, torsoW: 1.12, torsoH: 1.0,  stance: 1.05, height: 0.98, armR: 1.1,  asym: 1.0 },
  [CharRole.Breaker]:  { head: 0.9,  torsoW: 1.15, torsoH: 0.95, stance: 1.1,  height: 0.98, armR: 1.15, asym: 1.6 },
  [CharRole.Anchor]:   { head: 1.05, torsoW: 1.45, torsoH: 0.82, stance: 1.4,  height: 0.82, armR: 1.3,  asym: 1.0 },
  [CharRole.None]:     { head: 1.0,  torsoW: 1.0,  torsoH: 1.0,  stance: 1.0,  height: 1.0,  armR: 1.0,  asym: 1.0 },
};

// ---- animation tuning ------------------------------------------------------
const RUN_SPEED = 5.0;        // u/s at which limb swing saturates
const STRIDE_RATE = 1.9;      // stride radians per unit travelled
const MAX_SWING = 0.9;        // peak leg/arm swing (rad) at full run
const LEAN_K = 0.05;          // rad of body tilt per u/s of velocity
const LEAN_MAX = 0.35;        // clamp body tilt (rad)
const LAND_DEPTH = 0.45;      // squash fraction at a full-strength landing
const LAND_DECAY = 9.0;       // land-spring damping
const LAND_FREQ = 22.0;       // land-spring bounce rate (rad/s)
const SMOOTH = 14.0;          // pose smoothing rate (per second) — soft "crossfade"

/** Exponential smoothing toward a target, frame-rate independent. */
function damp(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A composed stubby body + its procedural animator. One per Player/Anchor body. */
export class StubbyCharacter {
  /** Placed by the renderer at the interpolated body centre; rotated by facing. */
  readonly root = new THREE.Object3D();
  private readonly pose = new THREE.Object3D();   // squash + lean pivot at the feet
  private readonly torso: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly armL: THREE.Object3D; private readonly armR: THREE.Object3D;
  private readonly legL: THREE.Object3D; private readonly legR: THREE.Object3D;
  private readonly tinted: THREE.MeshStandardMaterial[] = [];

  // view-only animation phase (advances on render dt — like a mixer's clip time)
  private stride = 0;
  private landT = 99; private landMag = 0;
  private aL = 0; private aR = 0; private lL = 0; private lR = 0; // smoothed limb angles
  private leanX = 0; private leanZ = 0; private squashY = 1;

  constructor(role: number, baseColor: number, radius: number, halfHeight: number) {
    const s = ROLE_SHAPE[role] ?? ROLE_SHAPE[CharRole.None]!;
    const base = new THREE.Color(baseColor);
    const body = new THREE.MeshStandardMaterial({ color: base, roughness: 0.62, metalness: 0.0 });
    const limb = new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.8), roughness: 0.7 });
    const headMat = new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color(0xffffff), 0.18), roughness: 0.55 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x10121a, roughness: 0.3 });
    this.tinted.push(body, limb, headMat);

    // --- rig (feet at y=0) -------------------------------------------------
    const rig = new THREE.Object3D();
    const torsoH = 0.5 * s.torsoH, torsoY = 0.42 + torsoH * 0.5;
    this.torso = new THREE.Mesh(roundedBox(BASE_WIDTH * s.torsoW, torsoH * 2, BASE_WIDTH * 0.78 * s.torsoW), body);
    this.torso.position.y = torsoY;
    rig.add(this.torso);

    const headR = 0.3 * s.head;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(headR, 18, 14), headMat);
    this.head.position.y = torsoY + torsoH + headR * 0.55; // sits low on torso — no neck (cute)
    this.head.scale.set(1, 0.95, 0.95);
    rig.add(this.head);
    // eyes on the FRONT (+X) so orientation/aim reads at a glance
    for (const dz of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.22, 10, 8), eyeMat);
      eye.position.set(headR * 0.82, this.head.position.y + headR * 0.1, dz * headR * 0.42);
      rig.add(eye);
    }

    // arms — pivots at the shoulders, mesh hangs below (so rotation.z swings fwd/back)
    const shoulderY = torsoY + torsoH * 0.5, shoulderX = BASE_WIDTH * 0.5 * s.torsoW + 0.04;
    const mkArm = (sign: number, thick: number) => {
      const pivot = new THREE.Object3D();
      pivot.position.set(0, shoulderY, sign * shoulderX);
      const len = 0.4 * s.height;
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.12 * s.armR * thick, len, 4, 8), limb);
      m.position.y = -len * 0.5 - 0.06;
      pivot.add(m);
      rig.add(pivot);
      return pivot;
    };
    this.armL = mkArm(1, 1);
    this.armR = mkArm(-1, s.asym); // Breaker's right arm is chunkier (asymmetric mass)

    // legs — pivots at the hips
    const hipY = 0.42, hipX = 0.2 * s.stance;
    const mkLeg = (sign: number) => {
      const pivot = new THREE.Object3D();
      pivot.position.set(0, hipY, sign * hipX);
      const len = hipY - 0.06;
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, len, 4, 8), limb);
      m.position.y = -len * 0.5;
      pivot.add(m);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), limb);
      foot.scale.set(1.1, 0.55, 1.0); foot.position.set(0.04, -len - 0.02, 0);
      pivot.add(foot);
      rig.add(pivot);
      return pivot;
    };
    this.legL = mkLeg(1);
    this.legR = mkLeg(-1);

    // --- transform stack: root(centre) → scale → pose(feet pivot) → rig -----
    this.pose.add(rig);
    const scale = new THREE.Object3D();
    scale.add(this.pose);
    // map torso width to collision diameter, apply role height; plant feet at -halfHeight
    const bodyScale = (radius * 2) / BASE_WIDTH;
    scale.scale.set(bodyScale, bodyScale * s.height, bodyScale);
    scale.position.y = -halfHeight;
    this.root.add(scale);
    void TOTAL_HEIGHT;
  }

  /** Per-frame base color (crew can't change, but kept for completeness/teamswap). */
  setBaseColor(hex: number): void {
    const c = new THREE.Color(hex);
    this.tinted[0]!.color.copy(c);
    this.tinted[1]!.color.copy(c).multiplyScalar(0.8);
    this.tinted[2]!.color.copy(c).lerp(new THREE.Color(0xffffff), 0.18);
  }

  /** Advance the procedural animation one rendered frame. `dt` = render seconds. */
  update(a: AnimSample, dt: number): void {
    // ---- locomotion phase (view-only; stride accumulates with travel) ------
    this.stride += a.speed * dt * STRIDE_RATE;
    const gait = clamp(a.speed / RUN_SPEED, 0, 1);
    const swing = Math.sin(this.stride) * MAX_SWING * gait;

    // ---- target limb angles by STATE (priority high → low) -----------------
    // defaults: opposed arm/leg swing (walk), arms rest slightly out
    let tAL = -swing, tAR = swing, tLL = swing, tLR = -swing;
    let tLeanZ = -clamp(a.leanFwd * LEAN_K, -LEAN_MAX, LEAN_MAX);   // tip into travel
    let tLeanX = clamp(a.leanSide * LEAN_K, -LEAN_MAX, LEAN_MAX);
    let tSquash = 1;

    const wob = Math.sin(a.tick * 0.9) * 0.5 + Math.sin(a.tick * 1.7) * 0.3; // deterministic flail

    if (a.downed) {
      // slump: crushed, head/limbs splay, planted
      tSquash = 0.55; tAL = 1.4; tAR = -1.4; tLL = 0.5; tLR = -0.5; tLeanZ = 0.25; tLeanX = 0.12;
    } else if (a.staggered) {
      tLeanZ = 0.3; tAL = -1.1 + wob * 0.3; tAR = 1.1 - wob * 0.3; tSquash = 0.95;
    } else if (a.grabbed) {
      // helpless wriggle — intensity rises with struggle mash
      const k = 0.6 + a.struggle * 1.0;
      tAL = -1.3 + wob * k; tAR = 1.3 - wob * k; tLL = wob * k * 0.6; tLR = -wob * k * 0.6;
      tLeanX = wob * 0.2 * k;
    } else if (a.rushing) {
      // streamlined dash: hard forward commit, arms swept back, stretched
      tLeanZ = -LEAN_MAX; tAL = 1.5; tAR = -1.5; tSquash = 1.12;
    } else if (a.holding) {
      // carry: arms forward to hold the load; weight sag scales with carried mass
      const sag = 0.12 + (a.carryMass < 0 ? 0 : a.carryMass) * 0.06;
      tAL = -1.5; tAR = -1.5; tLeanZ = 0.18 + sag;        // lean back under the weight
      tSquash = 1 - sag * 0.6;
      if (a.throwCharge > 0) { const c = a.throwCharge; tAL = -1.5 + c * 2.6; tAR = -1.5 + c * 2.6; tLeanZ = 0.18 - c * 0.3; } // wind back
      tLL = swing * 0.5; tLR = -swing * 0.5;               // shorter carry steps
    }

    // ---- one-shots ---------------------------------------------------------
    if (a.justLanded) { this.landT = 0; this.landMag = a.landStrength; }
    if (a.justThrew) { this.landT = Math.min(this.landT, 0.02); /* tiny recoil pop */ }

    // ---- land spring + air stretch (squash, volume-preserving) -------------
    this.landT += dt;
    const landSquash = -this.landMag * LAND_DEPTH * Math.exp(-this.landT * LAND_DECAY) * Math.cos(this.landT * LAND_FREQ);
    let airStretch = 0;
    if (!a.grounded) airStretch = clamp(a.vy * 0.03, -0.12, 0.18);   // stretch when rising/falling fast
    const idle = a.speed < 0.25 && a.grounded ? Math.sin(a.tick * 0.12) * 0.018 : 0; // breathe
    const targetSY = clamp(tSquash + landSquash + airStretch + idle, 0.45, 1.3);

    // ---- smooth everything (soft crossfade between states) -----------------
    this.aL = damp(this.aL, tAL, SMOOTH, dt); this.aR = damp(this.aR, tAR, SMOOTH, dt);
    this.lL = damp(this.lL, tLL, SMOOTH, dt); this.lR = damp(this.lR, tLR, SMOOTH, dt);
    this.leanZ = damp(this.leanZ, tLeanZ, SMOOTH, dt);
    this.leanX = damp(this.leanX, tLeanX, SMOOTH, dt);
    this.squashY = damp(this.squashY, targetSY, SMOOTH * 1.6, dt);

    // ---- apply -------------------------------------------------------------
    this.armL.rotation.z = this.aL; this.armR.rotation.z = this.aR;
    this.legL.rotation.z = this.lL; this.legR.rotation.z = this.lR;
    this.pose.rotation.z = this.leanZ; this.pose.rotation.x = this.leanX;
    const sxz = 1 / Math.sqrt(this.squashY);              // preserve volume
    this.pose.scale.set(sxz, this.squashY, sxz);

    // held / vulnerable emissive pulse (parity with the old per-frame mutation)
    for (const m of this.tinted) m.emissive.setHex(a.emissive);
  }

  /** Free GPU resources when a body's vis is torn down. */
  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
  }
}

/** A chunky rounded box (cheap: a scaled, smoothed sphere reads softer than a hard box). */
function roundedBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 16, 12);
  g.scale(w, h, d);
  return g;
}
