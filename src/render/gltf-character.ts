// ============================================================================
// src/render/gltf-character.ts — a LOADED rigged/animated glTF body (Step 3).
// ============================================================================
//
// The "better assets" path: instead of the procedural primitive rig, drive a real
// skinned glTF model with an AnimationMixer. Proves the drop-in pipeline end-to-end —
// GLTFLoader → SkeletonUtils.clone (per body: own skeleton, shared geometry) → one
// AnimationMixer each → clip SELECTION as a pure function of sim integers (rollback-
// safe) → the SAME crew-rim material + blob shadow + bloom/IBL the procedural body
// renders through. Implements the `BodyCharacter` contract so the renderer swaps freely.
//
// MODEL-AGNOSTIC: clip names differ per model (Idle/Running/Walking vs Idle/Run/Walk vs
// idle/run/walk vs Survey/Walk/Run). We resolve canonical states (idle/walk/run/jump/
// death/hit) to whatever the model actually ships by keyword-matching, with fallbacks —
// so any animated .glb works without per-model clip tables.
//
// DETERMINISM: clip SELECTION is a pure function of the AnimSample (sim integers); only
// the mixer's PLAYBACK TIME advances on render `dt` (view-only). Nothing is read back.
// ============================================================================

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { type BodyCharacter, type AnimSample, applyRim, shadowTex } from './character.ts';

/** Options for adapting an arbitrary model (orientation/scale quirks vary by source). */
export interface GltfOpts {
  /** Yaw (radians) to face the model's front toward world +X (facing=0). Default +90°. */
  yaw?: number;
  /** Multiplier on the auto-fit scale (some models read better a bit smaller/larger). */
  scale?: number;
}

// canonical animation state → keywords found in real clip names (case-insensitive)
const KEYWORDS: Record<string, string[]> = {
  idle: ['idle', 'survey', 'stand', 'breath'],
  walk: ['walk', 'sneak'],
  run: ['run', 'sprint', 'jog'],
  jump: ['jump'],
  death: ['death', 'die', 'dead', 'sad'],
  hit: ['no', 'headshake', 'shake', 'hit', 'stagger', 'flinch'],
};
// if a canonical state has no clip, fall back along this chain
const FALLBACK: Record<string, string[]> = {
  idle: ['idle'],
  walk: ['walk', 'run', 'idle'],
  run: ['run', 'walk', 'idle'],
  jump: ['jump', 'run', 'walk', 'idle'],
  death: ['death', 'idle'],
  hit: ['hit', 'walk', 'idle'],
};

/** Map a sim-state AnimSample to a canonical animation state. */
function pickState(a: AnimSample): string {
  if (a.downed) return 'death';
  if (a.grabbed || a.staggered) return 'hit';
  if (!a.grounded) return 'jump';
  if (a.rushing || a.speed > 3.2) return 'run';
  if (a.speed > 0.3) return 'walk';
  return 'idle';
}

/** A loaded skeletal glTF body driven by an AnimationMixer from sim state. */
export class GltfCharacter implements BodyCharacter {
  readonly root = new THREE.Object3D();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** canonical state → resolved actual clip name (or '' if the model lacks any fallback). */
  private readonly clipFor = new Map<string, string>();
  private readonly firstClip: string;
  private current = '';
  private readonly blobMat: THREE.MeshBasicMaterial;
  private blobOpacity = 0.34;

  constructor(template: THREE.Object3D, clips: THREE.AnimationClip[], baseColor: number, radius: number, halfHeight: number, opts: GltfOpts = {}) {
    // OWN skeleton per body (plain .clone() would leave the skeleton unbound — the
    // classic skinned-mesh bug); geometry is shared by reference.
    const model = cloneSkeleton(template);
    const rim = new THREE.Color(baseColor);
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      // cloned meshes share materials by reference → clone per body for per-crew rim.
      const src = m.material as THREE.MeshStandardMaterial;
      const mat = src.clone();
      mat.envMapIntensity = 0.7;
      // lightly tint non-dark materials toward the crew hue (keep the model's character;
      // the crew Fresnel RIM carries most of the team identity)
      if (mat.color.getHSL({ h: 0, s: 0, l: 0 }).l > 0.18) mat.color.lerp(rim, 0.32);
      applyRim(mat, rim); // crew Fresnel rim — keeps GPU skinning (patches std shader)
      m.material = mat;
    });

    // Measure via the SKELETON, not Box3.setFromObject: a skinned mesh's geometry bbox
    // ignores bone scaling (RobotExpressive's armature is 100×) so the naive box reads
    // near-zero and the model would blow up off-screen. Bone world positions include the
    // armature scale. (Fallback to the mesh box if a model has no bones.)
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const tmp = new THREE.Vector3();
    model.traverse((o) => { if ((o as THREE.Bone).isBone) box.expandByPoint(o.getWorldPosition(tmp)); });
    if (box.isEmpty()) box.setFromObject(model);
    const h = Math.max(0.001, box.max.y - box.min.y);
    const sc = ((2 * halfHeight) / h) * 0.82 * (opts.scale ?? 1);
    const inner = new THREE.Group();
    inner.add(model);
    inner.scale.setScalar(sc);
    inner.position.y = -halfHeight - box.min.y * sc;
    inner.rotation.y = opts.yaw ?? Math.PI / 2; // orient model front toward world +X
    this.root.add(inner);

    // soft blob contact shadow (shared with the procedural body)
    this.blobMat = new THREE.MeshBasicMaterial({ map: shadowTex(), color: 0x000000, transparent: true, opacity: this.blobOpacity, depthWrite: false });
    const blob = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.6, 20), this.blobMat);
    blob.rotation.x = -Math.PI / 2; blob.position.y = -halfHeight + 0.02;
    this.root.add(blob);

    // mixer + actions, then resolve canonical states → actual clip names by keyword
    this.mixer = new THREE.AnimationMixer(model);
    for (const c of clips) this.actions.set(c.name, this.mixer.clipAction(c));
    this.firstClip = clips[0]?.name ?? '';
    const lower = clips.map((c) => ({ name: c.name, low: c.name.toLowerCase() }));
    for (const [state, keys] of Object.entries(KEYWORDS)) {
      const matches = lower.filter((c) => keys.some((k) => c.low.includes(k)));
      if (!matches.length) continue;
      // prefer an EXACT keyword match, else the SHORTEST name (the "base" clip) — so a
      // 76-clip pack resolves "idle"→"Idle" not "2H_Melee_Idle", "walk"→"Walking_A".
      matches.sort((a, b) => {
        const ae = keys.includes(a.low) ? 0 : 1, be = keys.includes(b.low) ? 0 : 1;
        return ae - be || a.name.length - b.name.length;
      });
      this.clipFor.set(state, matches[0]!.name);
    }
    this.play('idle');
  }

  /** Resolve a canonical state to an actual clip via the fallback chain. */
  private resolve(state: string): string {
    for (const s of FALLBACK[state] ?? [state]) {
      const c = this.clipFor.get(s);
      if (c) return c;
    }
    return this.firstClip;
  }

  /** Crossfade to the clip for a canonical state (no-op if already current). */
  private play(state: string): void {
    const name = this.resolve(state);
    if (!name || name === this.current) return;
    const next = this.actions.get(name);
    if (!next) return;
    const prev = this.actions.get(this.current);
    // DEATH plays ONCE and holds the final (fallen) frame; everything else loops.
    if (state === 'death') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    else { next.setLoop(THREE.LoopRepeat, Infinity); next.clampWhenFinished = false; }
    next.reset().setEffectiveWeight(1).fadeIn(0.18).play();
    prev?.fadeOut(0.18);
    this.current = name;
  }

  update(a: AnimSample, dt: number): void {
    this.play(pickState(a));                // SELECTION from sim state (deterministic)
    this.mixer.update(dt);                  // PLAYBACK phase on render wall-clock (view-only)
    this.blobOpacity += ((a.grounded ? 0.34 : 0.1) - this.blobOpacity) * (1 - Math.exp(-8 * dt));
    this.blobMat.opacity = this.blobOpacity;
  }
}
