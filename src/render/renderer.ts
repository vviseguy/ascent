// ============================================================================
// src/render/renderer.ts — the Three.js view layer (reads sim, never writes it).
// ============================================================================
//
// HARD RULE (ENGINE-ARCHITECTURE.md / CLAUDE.md): the renderer is a PURE READER of
// the deterministic sim. It converts raw Q16.16 ints to floats for display only and
// never feeds anything back into the world. Floats, Math.*, and the JS built-in
// random are allowed HERE (the view layer) and nowhere else — but ONLY for cosmetic
// effects (shake noise, particle jitter); we never write WorldState, never feed the
// sim, so cosmetic divergence between clients is invisible and harmless.
//
// This pass implements the audit's UX cluster on top of the working sim:
//   - INTERPOLATION between sim ticks (alpha) so motion is smooth at any refresh.
//   - VERB FEEDBACK: grab/carry leash (green friendly / magenta hostile-ish), a
//     throw aim-arc whose length grows with charge + a landing reticle, a struggle
//     radial, and a rush streak.
//   - ANCHOR readability: gold, larger, a floating "ANCHOR" label, an always-on
//     beacon ring; plus a top-center ANCHOR STATUS HUD (height = score, state word,
//     health arc) and a controls legend.
//   - CAMERA tuned for the climb: anchor-weighted centroid, a TRUE 55° down-pitch
//     (exact lookAt) with the subject framed 42% up via a PROJECTION SHIFT
//     (setViewOffset), FOV ~40, spread-driven dolly, dt-compensated asymmetric
//     smoothing — plus user wheel-zoom and middle-drag pan with recenter-on-move
//     (all view-only; never in PlayerInput).
//   - WORLD-SPACE AIM: a ray from the cursor onto the LOCAL PLAYER'S floor plane
//     (their current standing Y, updated per query — so screen aim equals world
//     direction under the tilted camera on every stratum, not just the ground).
//
// ...PLUS the JUICE + COALESCENCE visual identity (docs/06 + docs/07 §4), all
// view-only and snapshot-driven (never writes sim state):
//   - SCREEN SHAKE / trauma (docs/07 §1.7): a trauma accumulator decaying ~1.6/s,
//     fed by snapshot-detected events (throw release, hard landing, grab latch); the
//     camera offset = trauma² · maxOffset · cosmetic-noise. Accessibility-gated.
//   - HITSTOP (docs/07 §4.4): a big impact briefly HOLDS the displayed frame (a few
//     ms) by freezing the interpolation alpha — render-presentation only, the sim's
//     fixed tick is untouched.
//   - SQUASH / STRETCH (docs/07 §4.3-4.4): body meshes scale slightly from their
//     speed and pop on landing — view-only mesh scale, never collision shape.
//   - COALESCENCE (docs/06 §2-3): floors ABOVE the crew render as a dotted/glowing
//     wireframe that resolves to solid as the crew nears (per-stratum reveal ∈ [0,1]
//     from the Anchor's height vs each stratum base Y). Floors BELOW desaturate + fog
//     with distance. Crew / Anchor colors stay fog-immune.
//   - IMPACT FX (docs/06 §4): a pooled expanding ring + dust puff at a throw landing
//     or a rush-bump (cheap, reused from a fixed pool — no per-frame allocation).
// ============================================================================

import * as THREE from 'three';
import { type WorldState, BodyFlag, MassClass, NO_ENTITY } from '../sim/world/state.ts';
import { toFloat, fromRaw, toRaw, TWO_PI } from '../sim/fixed/fixed.ts';
import { THROW_CHARGE_TICKS, THROW_J, THROW_ANGLE_DEFAULT } from '../sim/verbs/config.ts';
import type { Terrain, AABB } from '../sim/collide/terrain.ts';
import { StubbyCharacter, CREW_COLORS, ANCHOR_COLOR, type AnimSample, type BodyCharacter } from './character.ts';
import { Hotbar } from './hotbar.ts';
import { GltfCharacter, type GltfOpts } from './gltf-character.ts';
import { Dungeon } from './dungeon.ts';
import type { EyeCam } from './first-person.ts';
import type { StratumCellGrid } from '../game/tower.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const COLORS = {
  player: 0x4ea1ff, anchor: 0xffd23f, light: 0xa0e060, heavy: 0xff7a3d,
  ground: 0x1a1a2e, wall: 0x2e2e4a, grid: 0x33335a,
  leashFriendly: 0x6cff8a, leashHostile: 0xff5a6e, arc: 0xffe27a, struggle: 0xff4fd8, rush: 0x9fd0ff,
  // coalescence: cool indigo "potential" wireframe → warm sodium-amber "lit" accent
  potential: 0x5a78ff, lit: 0xffb24f, dust: 0xb9a98a,
};

const TICK_HZ = 60; // view-side mirror of the sim cadence (for event/age math only)

// --- JUICE tuning (all view-only / cosmetic) --------------------------------
/** Trauma decay per second (docs/07 §1.7). */
const TRAUMA_DECAY = 1.6;
/** Max translational shake offset (world units) at trauma=1. */
const SHAKE_MAX_OFFSET = 0.9;
/** Max cosmetic camera roll (radians) at trauma=1 (~1.2°). */
const SHAKE_MAX_ROLL = 0.021;
/** Trauma added per event (additive, clamped to 1) — mirrors docs/07 §1.7 ladder. */
const TRAUMA_THROW = 0.22, TRAUMA_GRAB = 0.12, TRAUMA_LAND_LIGHT = 0.18, TRAUMA_LAND_HARD = 0.45;
/** A descent speed (u/s) above which a sudden stop counts as a HARD landing. */
const HARD_LAND_SPEED = 9.0;
/** A descent speed (u/s) above which a sudden stop counts as ANY landing (squash + dust). */
const LAND_SPEED = 3.5;
/** Hitstop hold (ms) for a big impact; render-presentation only (docs/07 §4.4). */
const HITSTOP_HARD_MS = 90, HITSTOP_SOFT_MS = 45;
/** Global hitstop budget (ms) per 250ms window so chaos can't slideshow (docs/07 §4.4). */
const HITSTOP_BUDGET_MS = 130, HITSTOP_WINDOW_MS = 250;

// --- COALESCENCE tuning -----------------------------------------------------
/** Reveal radius (u) above the Anchor where a stratum begins to resolve from wireframe. */
const REVEAL_RADIUS = 14;
/** Reveal falloff (u): distance over which reveal ramps 1→0 (docs/06 §2.1). */
const REVEAL_FALLOFF = 8;
/** Below-Anchor desaturation depth (u) over which floors fully recede (floored at 0.18). */
const BELOW_DEPTH = 22;
/** Descent speed (u/s, magnitude) mapped to a full-strength stubby landing squash. */
const LAND_VY_REF = 10;
/** Vertical glide rate (/s) for characters — rounds off short step/hop pops; big falls snap. */
const CHAR_GLIDE_RATE = 18;
/** Above this vertical delta (u) the glide snaps (real jumps/falls never float). */
const CHAR_GLIDE_SNAP = 0.7;
/** Fog-of-war reveal radius (u) around each crew body — reveals the current cell + neighbours. */
const FOG_RADIUS = 7.5;

/** A WORLD/BLOCK visual style (opt-in `?world=NAME` demos) — restyles the tower look. */
interface WorldStyle {
  bg: number;        // scene background + fog tint
  ground: number;    // ground plane
  wall: number;      // base terrain-block color (lit/below blend from this)
  lit: number;       // warm "resolved" accent
  belowDark: number; // color floors fade toward going down
  potential: number; // dotted floor-plan wireframe
  wallRough: number; // block roughness (matte ↔ glossy)
  exposure: number;  // tonemap exposure
  bloom: number;     // bloom strength
}
const WORLD_STYLES: Record<string, WorldStyle> = {
  // the shipped slate look
  default: { bg: 0x0a0a12, ground: 0x1a1a2e, wall: 0x2e2e4a, lit: 0xffb24f, belowDark: 0x0a0a14, potential: 0x5a78ff, wallRough: 0.9, exposure: 1.05, bloom: 0.3 },
  // brighter, flatter cubes — a Minecraft/Crossy-Road toy block look
  blocky: { bg: 0x121826, ground: 0x2a3550, wall: 0x55647f, lit: 0xffd27a, belowDark: 0x10131f, potential: 0x7390ff, wallRough: 1.0, exposure: 1.1, bloom: 0.24 },
  // pale pastel high-key — Monument Valley toy architecture
  clean: { bg: 0x2b2746, ground: 0xc9c4e2, wall: 0xb4aed2, lit: 0xffdca6, belowDark: 0x6b6690, potential: 0x9080ff, wallRough: 0.95, exposure: 1.18, bloom: 0.2 },
  // dark with glowing edges — synthwave / TRON
  neon: { bg: 0x05060d, ground: 0x0a0c18, wall: 0x141a30, lit: 0x39d2ff, belowDark: 0x05060d, potential: 0x00e6ff, wallRough: 0.45, exposure: 1.0, bloom: 0.6 },
  // warm candy — pinks & purples
  candy: { bg: 0x1d1233, ground: 0x3a2a52, wall: 0x5d4480, lit: 0xff9ecb, belowDark: 0x140d24, potential: 0xff86d6, wallRough: 0.8, exposure: 1.1, bloom: 0.4 },
};

// --- CAMERA RIG tuning (all view-only) --------------------------------------
/**
 * TRUE down-pitch components: camera offset = (0, D·sinθ, D·cosθ) and the camera looks
 * at the target EXACTLY, so pitch = atan(sinθ/cosθ) = θ. Framing is a projection SHIFT
 * (FRAME_SHIFT below), never a lookAt rotation, so the pitch stays exact.
 *
 * θ = 72° (was 55°). At the 30×30 scale the dungeon is a SPARSE top-down map (rooms +
 * corridors with genuine void between them, on a 135u footprint), and the crew spawns on
 * the entry row at the floor's −Z EDGE. A shallow 55° pitch looked out toward the horizon
 * — which at an edge spawn is unexplored VOID — so the lit room sat crushed at the bottom
 * of frame under a wall of black (boss #1). A near-top-down 72° looks DOWN onto the floor
 * PLANE, so the player's lit room fills the frame whichever way it extends and the forward
 * void all but disappears (a flat dungeon-crawler map read). At this steep angle the
 * forward look-point is close to straight-down, so a 2-axis framing bias no longer shoves
 * the player off the bottom. (CAM_SIN/COS keep the historical names; the value is now 72°.)
 */
const CAM_SIN55 = 0.951, CAM_COS55 = 0.309;
/**
 * 42%-up framing (07 §1.3) as a view-plane shift: with an exact lookAt the subject
 * projects at the screen center (50% from the bottom). setViewOffset renders a
 * same-size window shifted UP by FRAME_SHIFT·height inside a virtual larger image,
 * which moves all content DOWN by that fraction → the subject sits at
 * 50% − 8% = 42% from the bottom while the true 55° pitch is untouched.
 */
const FRAME_SHIFT = 0.08;
/**
 * dt-compensated smoothing rates (per second): factor = 1 − e^(−rate·dt). Chosen to
 * reproduce the old per-frame lerps at 60 Hz — 1−e^(−12/60) ≈ 0.18 (rise),
 * 1−e^(−6.5/60) ≈ 0.10 (fall), 1−e^(−5/60) ≈ 0.08 (dolly) — so the feel is the same
 * at 60 fps but no longer twice as twitchy at 144 Hz (GAPS M8).
 */
const CAM_RISE_RATE = 12, CAM_FALL_RATE = 6.5, CAM_DOLLY_RATE = 5;
/** Dolly base: D = clamp((D_CLOSE + extent·0.9)·userZoom, MIN..MAX). D_CLOSE 17 frames the
 *  player's room tightly at the 30×30 dungeon scale so the lit area fills the frame on load
 *  (a far opening dolly shrank the sparse room into a void speck = the "black on load" read);
 *  MIN/MAX clamp the user wheel zoom so they can still pull back for an overview. */
const CAM_D_CLOSE = 17, CAM_D_FAR = 40, CAM_DIST_MIN = 11, CAM_DIST_MAX = 56;
/** Wheel zoom: exponential scale per wheel deltaY unit (≈1.13× per 100-unit notch),
 *  with the multiplier itself clamped (the absolute distance is clamped above too). */
const ZOOM_PER_DELTA = 0.0012, ZOOM_MIN = 0.45, ZOOM_MAX = 2.6;
/** Recenter-on-move: while the local player actively moves, the manual pan drifts
 *  home at this rate (/s → settles in ~1-2 s), toward a small forward LEAD in the
 *  facing direction (≤ PAN_LEAD_MAX u, scaled by speed) so the view settles slightly
 *  ahead of travel. While stationary the manual pan stays exactly where it was put. */
const PAN_RECENTER_RATE = 1.2, PAN_LEAD_MAX = 1.5, PAN_LEAD_PER_SPEED = 0.25;
/** FRAMING BIAS (boss #1/#2): how far (world u, max) the camera target slides off the
 *  player toward the proximity-weighted centroid of the EXPLORED dungeon cells, so the
 *  opening view sits over the lit room instead of the perimeter void. Capped so the
 *  player stays well in frame. The weighting (in Dungeon.exploredFrameNear) keeps the
 *  player's own room dominant, so far corridor cells can't drag the target into the dark. */
const FRAME_BIAS_MAX = 0, FRAME_BIAS_RATE = 2.5;

// --- EYE-LEVEL INSPECTION CAMERA (`?cam=fp`; see first-person.ts) -----------
/**
 * A DEBUG INSTRUMENT, NOT A CAMERA CHANGE. The shipped rig above is locked by docs/06
 * §1.2 / bible pillar 7 and none of its numbers move. These three are the eye's own,
 * used only while `setEyeCam` holds a pose.
 *
 * FOV 70 rather than the shipped 40: at 40 an eye-level view is a telephoto tube with
 * one brick in it, and the point of the mode is to see a surface IN ITS SURROUNDINGS.
 * NEAR 0.02 rather than 0.1: pressing your face against a wall is the acceptance test
 * for relief and per-texel roughness, and 0.1 clips through the wall before you get
 * close enough to judge it.
 */
const EYE_FOV = 70, EYE_NEAR = 0.02;
/** Eye height below the top of the body capsule (u) — a head, not a periscope. */
const EYE_DROP = 0.25;

/** Per-body render record holding previous + current sim positions for interpolation. */
interface Vis {
  /** the transform target: a StubbyCharacter's root (Player/Anchor) or an object box. */
  obj: THREE.Object3D;
  /** the animated body for Player/Anchor (procedural stubby OR loaded glTF); null for boxes. */
  char: BodyCharacter | null;
  px: number; py: number; pz: number; ppx: number; ppy: number; ppz: number;
  pf: number; cf: number;
  /** smoothed display Y (characters) — glides short steps/hops; snaps big falls. */
  glideY: number;
  /** view-only squash spring state (BOX path only); pops on landing, eases back. */
  squash: number;
  /** a pending landing-crush impulse (BOX path; the spring dips here, then eases to 1). */
  squashImpulse: number;
  /** the body's base color hex (BOX path; characters bake crew color at build). */
  baseColor: number;
  /** CHARACTER one-shots, set tick-accurately in detectEvents, consumed by sampleAnim. */
  landPending: boolean; landStrength: number; throwPending: boolean;
}

/** One stratum band of terrain: a solid group + a wireframe overlay, styled by reveal. */
interface Band {
  baseY: number;            // world Y of the stratum's walkable surface (float)
  solid: THREE.Group;       // opaque slab/lip meshes
  wire: THREE.LineSegments; // dotted "potential" wireframe overlay
  solidMats: THREE.MeshStandardMaterial[]; // materials to tint per reveal/below-depth
}

/** A pooled impact effect (expanding ring + a few dust motes) reused across frames. */
interface ImpactFx {
  ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial;
  dust: THREE.Points; dustMat: THREE.PointsMaterial;
  /** wall-clock spawn time (ms); -1 = free in the pool. */
  born: number;
  x: number; y: number; z: number;
  /** lifetime (ms) and peak radius (u). */
  life: number; peak: number;
  baseColor: number;
}

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  /** Scratch for the drawing-buffer size, so the per-frame cutout update allocates nothing. */
  private readonly _screenSize = new THREE.Vector2();
  /** Post-processing stack (render → SMAA → bloom → ACES output). View-only. */
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  // --- Step 3 (opt-in): a preloaded rigged glTF body template ---
  private useGltf = false;
  private modelTemplate: { scene: THREE.Object3D; clips: THREE.AnimationClip[]; opts: GltfOpts } | null = null;
  /** Per-role rigged templates (the default KayKit crew); ensureVis picks by w.role. */
  private roleModels: Map<number, { scene: THREE.Object3D; clips: THREE.AnimationClip[]; opts: GltfOpts }> | null = null;
  /** KayKit dungeon environment (built from the layout grid); when set, replaces the box terrain. */
  private dungeon: Dungeon | null = null;
  private dungeonActive = false;
  private groundMesh: THREE.Mesh | null = null;
  private gridHelper: THREE.GridHelper | null = null;
  /** Active world/block style palette (set via setWorldStyle before buildTerrain). */
  private style: WorldStyle = WORLD_STYLES.default!;
  private vis: (Vis | null)[] = [];
  /** DEV-only: last local-player render position (set each frame; for headless framing checks). */
  dbgLocalPos: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly bodyGroup = new THREE.Group();
  private readonly fxGroup = new THREE.Group(); // verb-feedback overlay (rebuilt each frame)
  private camTarget = new THREE.Vector3();
  private camDist = 20;
  /** Camera orbit heading (radians) — the player's focus direction (docs/11). View-only. */
  private focusYaw = 0;
  /** Camera INCLINATION / pitch (radians) — left-drag vertical tilts it (docs/11 §2).
   *  Default ≈72° = atan2(CAM_SIN55, CAM_COS55), the shipped fixed pitch. View-only. */
  private focusPitch = Math.atan2(CAM_SIN55, CAM_COS55);
  private camReady = false;
  /** EYE-LEVEL INSPECTION pose (`?cam=fp`), or null for the shipped top-down rig. */
  private eye: EyeCam | null = null;
  /** Where the eye sits this frame (local player's head), and whether it was found. */
  private readonly eyeAt = new THREE.Vector3();
  private eyeValid = false;
  // --- USER CAMERA state (wheel zoom / middle-drag pan / recenter; view-only) ---
  /** Wheel-driven multiplier on the dolly distance (clamped; see ZOOM_*). */
  private userZoom = 1;
  /** Middle-drag pan of the camera target on the ground plane (world u). */
  private panX = 0;
  private panZ = 0;
  /** Smoothed framing bias (world u) sliding the camera target toward the explored room
   *  centroid (boss #1/#2) — keeps the opening view on the lit dungeon, never the void. */
  private frameBiasX = 0;
  private frameBiasZ = 0;
  /** Local-player motion snapshot (set per frame by the loop) for recenter-on-move. */
  private localMoving = false;
  private localFacing = 0;
  private localSpeed = 0;
  private groundY = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** HUD elements (DOM overlay; pure readout of sim state). */
  private hud: { root: HTMLElement; height: HTMLElement; state: HTMLElement; health: HTMLElement } | null = null;
  /** Local-player health pill (bottom-right): bar + number, mirrors the Anchor arc style. */
  private localHud: { root: HTMLElement; bar: HTMLElement; num: HTMLElement } | null = null;
  /** Inventory hotbar + contextual hint prompts (docs/11). Pure reader of sim state. */
  private hotbar: Hotbar | null = null;
  private winBanner: HTMLElement | null = null;
  /** Off-screen crew indicators: a DOM container + per-body arrow elements (pooled). */
  private indicatorRoot: HTMLElement | null = null;
  private readonly indicators = new Map<number, { el: HTMLElement; tri: HTMLElement }>();
  private standingsRail: HTMLElement | null = null;
  private onboard: HTMLElement | null = null;
  private railBeads: HTMLElement[] = [];
  private startMs = -1;

  // --- JUICE state (view-only) ---
  /** Screen-shake trauma ∈ [0,1] (cosmetic, decays each frame). */
  private trauma = 0;
  /** Accessibility: shake intensity scalar ∈ [0,1] (default on). Set via setShakeIntensity. */
  private shakeIntensity = 1;
  /** Wall-clock of the previous rendered frame (ms) — for trauma decay / hitstop. */
  private lastFrameMs = -1;
  /** Hitstop: wall-clock until which we hold the displayed frame (ms). */
  private hitstopUntil = 0;
  /** The held interpolation alpha while a hitstop is active (frozen frame). */
  private heldAlpha = 0;
  /** Rolling record of recent hitstop charges (ms) for the per-window budget. */
  private hitstopLog: { t: number; ms: number }[] = [];
  /** Per-body snapshot of last seen grabbedBy, to detect a fresh GRAB latch this frame. */
  private prevGrabbedBy: Int32Array = new Int32Array(0);
  /** Per-body snapshot of last seen lastThrowTick, to detect a THROW release this frame. */
  private prevThrowTick: Int32Array = new Int32Array(0);
  /** Per-body snapshot of last seen rushUntil, to detect a fresh RUSH start (bump fx). */
  private prevRushUntil: Int32Array = new Int32Array(0);
  /** Per-body PREVIOUS-tick descent speed (u/s, +down), to detect a landing (fast→stop). */
  private prevDescend: Float32Array = new Float32Array(0);

  // --- COALESCENCE state (view-only) ---
  /** Per-stratum terrain bands, sorted ascending by baseY. */
  private bands: Band[] = [];
  /** World Y of each stratum's walkable surface (raw Fixed), passed from the scene. */
  private strataBaseY: number[] = [];

  // --- IMPACT FX pool (view-only, pre-allocated; never per-frame alloc) ---
  private readonly impactPool: ImpactFx[] = [];
  private readonly impactGroup = new THREE.Group();
  private static readonly IMPACT_POOL_SIZE = 24;
  private static readonly DUST_PER_FX = 10;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // AA via SMAA in the post stack
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // ACES filmic tonemap (docs/06 §7.2): r169 defaults to NoToneMapping, which hard-
    // clips every emissive >1 (rims/beacons/Anchor) to flat white. ACES rolls highlights
    // off so the look reads "graded" and bloom gets clean HDR to threshold against.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(0x0a0a12);
    this.scene.fog = new THREE.Fog(0x0a0a12, 30, 70);

    // IBL (docs/06 §1.5): bake a RoomEnvironment into a PMREM cubemap and use it as soft
    // image-based lighting. NOT a dynamic light — folds into the standard shader, so it
    // stays inside the "1 directional + ambient" budget while turning flat matte
    // primitives into rounded, soft-shaded "toy" volumes.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.42;
    pmrem.dispose();

    // FOV ~40 (longer lens, less edge parallax — spec 07 §1.1).
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);

    // 1 key directional ("light from the resolved tower") + a hemisphere fill (cool
    // indigo sky / warm ground) mapping onto the cold-void / warm-floor palette.
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(8, 22, 10);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x4a3826, 0.45));
    this.scene.add(this.bodyGroup);
    this.scene.add(this.fxGroup);
    this.scene.add(this.impactGroup);
    this.buildImpactPool();

    // POST STACK (docs/06 §7.2): render → SMAA edge-AA → bloom (only emissive/rims above
    // the threshold glow → the "emissive intent" look) → OutputPass (applies ACES + sRGB).
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new SMAAPass());
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.32, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Per-stratum walkable-surface world Y (raw Fixed), from the compiled tower
   * (CompiledTower.stratumBaseY). VIEW-ONLY input — drives the Coalescence reveal;
   * we do NOT add sim state for this. Call before/after buildTerrain (order-free).
   */
  setStrata(stratumBaseY: readonly number[]): void {
    this.strataBaseY = stratumBaseY.slice();
  }

  /**
   * WORLD/BLOCK STYLE demo (opt-in `?world=NAME`): pick a palette that restyles the
   * tower blocks, ground, accent, fog/background, exposure and bloom. View-only — must
   * be called BEFORE buildTerrain so the terrain materials pick up the style. Unknown
   * (or null) name falls back to the shipped 'default' look.
   */
  setWorldStyle(name: string | null): void {
    this.style = WORLD_STYLES[name ?? ''] ?? WORLD_STYLES.default!;
    (this.scene.background as THREE.Color).setHex(this.style.bg);
    (this.scene.fog as THREE.Fog).color.setHex(this.style.bg);
    this.renderer.toneMappingExposure = this.style.exposure;
    if (this.bloom) this.bloom.strength = this.style.bloom;
  }

  /**
   * STEP 3 (opt-in): preload a rigged/animated glTF body template. Once loaded, ensureVis
   * builds skeletal `GltfCharacter`s for Player/Anchor bodies instead of the procedural
   * stubby body. MUST be awaited BEFORE the loop starts (never load mid-match) so ensureVis
   * stays synchronous and rollback-safe — the determinism contract is untouched (the asset
   * is just a different view of the same sim-driven `BodyCharacter`). View-only.
   */
  async preloadModels(url: string, opts: GltfOpts = {}): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.modelTemplate = { scene: gltf.scene, clips: gltf.animations, opts };
    this.useGltf = true;
  }

  /**
   * Preload a PER-ROLE set of rigged glTF bodies (the default look — the KayKit crew):
   * each crew Role gets its own model, picked in ensureVis by w.role. Loaded in parallel,
   * awaited before the loop (never mid-match). View-only; the determinism contract is
   * untouched — these are just different views of the same sim-driven BodyCharacter.
   */
  async preloadModelSet(entries: { role: number; url: string; opts?: GltfOpts }[]): Promise<void> {
    const loader = new GLTFLoader();
    const uniq = [...new Set(entries.map((e) => e.url))]; // load each model file once
    const byUrl = new Map(await Promise.all(uniq.map(async (url) => {
      const gltf = await loader.loadAsync(url);
      return [url, { scene: gltf.scene, clips: gltf.animations }] as const;
    })));
    // share each url's template (GltfCharacter clones per body); opts (yaw) are per-role
    this.roleModels = new Map(entries.map((e) => [e.role, { ...byUrl.get(e.url)!, opts: e.opts ?? {} }]));
    this.useGltf = true;
  }

  /**
   * Build the KayKit DUNGEON environment from the per-stratum layout grid and use it as
   * the world — the abstract box terrain + coalescence wireframe are hidden in favour of
   * real dungeon tiles (floors/walls/doorways/torches). Await before the loop. View-only:
   * collision is still the sim's AABB terrain underneath. Call AFTER buildTerrain.
   */
  async buildDungeon(
    grids: StratumCellGrid[],
    stairs?: import('../game/tower.ts').StairInfo[],
    opts?: { dressing?: boolean; torchEvery?: number },
  ): Promise<void> {
    const d = new Dungeon();
    await d.load();
    if (opts) d.setDressing(opts.dressing ?? true, opts.torchEvery ?? 11);
    d.build(grids, stairs);
    this.scene.add(d.group);
    this.dungeon = d;
    this.dungeonActive = true;
    for (const band of this.bands) { band.solid.visible = false; band.wire.visible = false; }
    if (this.groundMesh) this.groundMesh.visible = false; // the pale ground plane would break the void
    if (this.gridHelper) this.gridHelper.visible = false;
    // INKY VOID (issue 2): unexplored / outside the arena reads as BLACK LIQUID SHADOW.
    // A near-pure-black background + a TIGHT black fog so anything past the explored play
    // area dissolves into ink (you forget the far sides of walls exist), reinforcing the
    // per-cell fog-of-war fade. Pulled in from (20,62) so the void closes around the player.
    (this.scene.background as THREE.Color).setHex(0x02030a);
    const fog = this.scene.fog as THREE.Fog;
    // near keeps the immediate void inky; far is loose enough that a zoomed-out overview of
    // the EXPLORED floor still reads (the fog-of-war hide is the real "unexplored" gate, so
    // fog is just atmospheric depth here, not the primary void mechanism).
    fog.color.setHex(0x02030a); fog.near = 18; fog.far = 64;
    // DEV: expose the dungeon for headless screenshot verification / debugging (e.g.
    // `__dungeon.revealAll()` to lift the fog). Gated to a `?debug` URL param so it never
    // leaks a handle into a normal session. View-only; touches nothing in the sim.
    if (new URLSearchParams(location.search).has('debug')) {
      (globalThis as Record<string, unknown>)['__dungeon'] = d;
    }
  }

  /**
   * Accessibility: scale screen shake (0 = off, 1 = full). Default on (1). At 0 the
   * camera never shakes (the impact read still comes through hitstop + impact FX).
   */
  setShakeIntensity(v: number): void {
    this.shakeIntensity = Math.max(0, Math.min(1, v));
  }

  buildTerrain(terrain: Terrain): void {
    // NOTE: terrain.groundY is the DEEP slab (≈ −14 for the compiled tower), used
    // only to place the cosmetic ground mesh below. The AIM plane is set per query
    // in worldAimFrom from the local player's feet (GAPS C7: aiming against the deep
    // slab skewed every cursor ray up-screen by whole floors of height).
    this.groundY = toFloat(fromRaw(terrain.groundY));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: this.style.ground, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.groundY;
    this.scene.add(ground);
    this.groundMesh = ground;
    const grid = new THREE.GridHelper(60, 30, COLORS.grid, COLORS.grid);
    grid.position.y = this.groundY + 0.01;
    (grid.material as THREE.Material).opacity = 0.3;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);
    this.gridHelper = grid;

    // Group the terrain AABB solids into per-stratum BANDS so Coalescence can style
    // each band (wireframe→solid above the crew; desaturate+fog below). A box is
    // assigned to the nearest stratum surface whose baseY is at/below the box top.
    const bandsByBase = new Map<number, AABB[]>();
    const baseYs = this.strataBaseY.map((r) => toFloat(fromRaw(r)));
    for (const b of terrain.solids) {
      const topY = toFloat(fromRaw(b.maxY));
      const baseY = this.nearestBandBase(topY, baseYs);
      const arr = bandsByBase.get(baseY) ?? [];
      arr.push(b);
      bandsByBase.set(baseY, arr);
    }

    // build one solid group + one merged wireframe per band
    const sortedBases = [...bandsByBase.keys()].sort((a, z) => a - z);
    for (const baseY of sortedBases) {
      const boxes = bandsByBase.get(baseY)!;
      const solid = new THREE.Group();
      const solidMats: THREE.MeshStandardMaterial[] = [];
      const wirePos: number[] = [];
      for (const b of boxes) {
        const w = toFloat(fromRaw(b.maxX - b.minX)), h = toFloat(fromRaw(b.maxY - b.minY)), d = toFloat(fromRaw(b.maxZ - b.minZ));
        const cxw = toFloat(fromRaw((b.minX + b.maxX) >> 1)), cyw = toFloat(fromRaw((b.minY + b.maxY) >> 1)), czw = toFloat(fromRaw((b.minZ + b.maxZ) >> 1));
        const mat = new THREE.MeshStandardMaterial({ color: this.style.wall, roughness: this.style.wallRough, transparent: true, opacity: 1 });
        solidMats.push(mat);
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        box.position.set(cxw, cyw, czw);
        solid.add(box);
        // wireframe is a flat 2D plan: every cell's outline drawn on ONE plane (the
        // band's walkable surface), so the "potential" floor above reads as a clean
        // map, not a 3D lattice. (planeY = the band base, shared by all its boxes.)
        appendBoxEdges(wirePos, cxw, czw, w, d, toFloat(fromRaw(baseY)) + 0.02);
      }
      const wireGeo = new THREE.BufferGeometry();
      wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
      const wireMat = new THREE.LineDashedMaterial({ color: this.style.potential, transparent: true, opacity: 0.0, dashSize: 0.22, gapSize: 0.18 });
      const wire = new THREE.LineSegments(wireGeo, wireMat);
      wire.computeLineDistances();
      this.scene.add(solid);
      this.scene.add(wire);
      this.bands.push({ baseY, solid, wire, solidMats });
    }
    this.bands.sort((a, z) => a.baseY - z.baseY);
  }

  /**
   * Choose the stratum band base-Y a box belongs to: the HIGHEST stratum surface at
   * or below the box's top. A box under no stratum (e.g. the deep ground slab below
   * the lowest stratum) falls into the lowest band. Returns 0 if no strata are known.
   */
  private nearestBandBase(topY: number, baseYs: number[]): number {
    if (baseYs.length === 0) return 0;
    let best = Infinity;          // lowest base seen (fallback for sub-lowest boxes)
    let chosen = -Infinity;       // highest base ≤ box top
    for (const b of baseYs) {
      if (b < best) best = b;
      if (b <= topY + 0.01 && b > chosen) chosen = b;
    }
    return chosen === -Infinity ? best : chosen;
  }

  /** Resolve a screen cursor (px) to a WORLD aim angle (raw Fixed) on the plane of
   *  the LOCAL PLAYER'S FEET — `standY` (float), updated per call — relative to a
   *  world origin (the player's x,z). Intersecting the player's own floor instead of
   *  the deep terrain slab keeps screen aim == world direction on every stratum.
   *  (The raycaster goes through the camera's projection matrix, so the 42%-framing
   *  view offset is automatically accounted for.) */
  worldAimFrom(screenX: number, screenY: number, originX: number, originZ: number, standY: number): number {
    const ndc = new THREE.Vector2((screenX / window.innerWidth) * 2 - 1, -(screenY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.groundPlane.constant = -standY; // plane y = standY (normal +Y ⇒ constant = −y)
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return 0;
    let ang = Math.atan2(hit.z - originZ, hit.x - originX); // world ground-plane angle
    if (ang < 0) ang += Math.PI * 2;
    return toRaw(fromRaw(Math.round((ang / (Math.PI * 2)) * toRaw(TWO_PI)))); // quantize like the wire
  }

  /**
   * Per-frame USER camera controls from the loop. VIEW-ONLY by construction: this
   * state never enters PlayerInput or the sim, so each client may frame the scene
   * differently with zero sync impact (CLAUDE.md determinism rule).
   *  - `wheel`: accumulated wheel deltaY this frame → exponential zoom multiplier on
   *    the dolly distance (eased by the dt-smoothed dolly in updateCamera).
   *  - `panDX/panDY`: middle-drag pixels this frame → "grab the world" pan of the
   *    camera target on the ground plane. Pixel→world mapping: at distance D the
   *    screen spans 2·D·tan(fov/2) world u vertically, so s = that/screenHeight is
   *    u-per-pixel; horizontal screen maps straight to world X (camera yaw is fixed),
   *    and vertical screen maps to ground Z divided by sin(pitch) — a ground step in
   *    Z is foreshortened by sin55° on screen — so the drag feels ~1:1 (the point
   *    under the cursor stays under it). Signs are negative because dragging the
   *    world right means moving the camera target left.
   *  - `moving/facing/speed`: the local player's live motion, consumed with dt in
   *    updateCamera for the recenter-on-move drift.
   */
  setViewControls(wheel: number, panDX: number, panDY: number, moving: boolean, facing: number, speed: number, focusYaw = 0, focusPitch = Math.atan2(CAM_SIN55, CAM_COS55)): void {
    if (wheel !== 0) {
      this.userZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.userZoom * Math.exp(wheel * ZOOM_PER_DELTA)));
    }
    if (panDX !== 0 || panDY !== 0) {
      const s = (2 * this.camDist * Math.tan((this.camera.fov * Math.PI) / 360)) / window.innerHeight;
      this.panX -= panDX * s;
      this.panZ -= (panDY * s) / CAM_SIN55;
    }
    this.localMoving = moving;
    this.localFacing = facing;
    this.localSpeed = speed;
    this.focusYaw = focusYaw; // camera orbits the player at this heading (docs/11)
    this.focusPitch = focusPitch; // ...and at this inclination (left-drag vertical, docs/11 §2)
  }

  /**
   * EYE-LEVEL INSPECTION CAMERA (`?cam=fp` — see first-person.ts for the why and the lock).
   *
   * Pass a pose to stand the camera in the local player's head; pass null to hand the frame
   * back to the shipped top-down rig. Nothing about the rig's own numbers changes either way
   * — the eye only overrides the pose, the FOV and the near plane while it is held, and puts
   * all three back on the way out. VIEW-ONLY, like everything else in this file.
   *
   * Called once at boot and again on every toggle; a no-op when the mode does not change, so
   * the loop may call it every frame.
   */
  setEyeCam(eye: EyeCam | null): void {
    const was = this.eye !== null;
    this.eye = eye;
    if ((eye !== null) === was) return;
    if (eye) {
      this.camera.fov = EYE_FOV;
      this.camera.near = EYE_NEAR;
      // the 42%-up framing SHIFT is a top-down composition device; at eye level it just
      // slides the horizon off-centre, so the eye renders the plain frustum.
      this.camera.clearViewOffset();
    } else {
      this.camera.fov = 40;
      this.camera.near = 0.1;
    }
    this.resize(); // re-applies aspect (+ the framing shift, when the rig is back)
  }

  private colorFor(w: WorldState, id: number): number {
    if ((w.flags[id]! & BodyFlag.Anchor) !== 0) return COLORS.anchor;
    if ((w.flags[id]! & BodyFlag.Player) !== 0) return COLORS.player;
    return w.massClass[id] === MassClass.Heavy ? COLORS.heavy : COLORS.light;
  }

  /** Crew-identity color for a player body (docs/06 §1.4); gold for the Anchor. */
  private bodyColorFor(w: WorldState, id: number): number {
    if ((w.flags[id]! & BodyFlag.Anchor) !== 0) return ANCHOR_COLOR;
    const crew = w.crewId[id]!;
    return crew < CREW_COLORS.length ? CREW_COLORS[crew]! : COLORS.player;
  }

  private ensureVis(w: WorldState, id: number): Vis {
    let v = this.vis[id] ?? null;
    if (!v) {
      const r = toFloat(fromRaw(w.radius[id]!)), hh = toFloat(fromRaw(w.halfHeight[id]!));
      const isBody = (w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0;
      const baseColor = isBody ? this.bodyColorFor(w, id) : this.colorFor(w, id);
      let obj: THREE.Object3D;
      let char: BodyCharacter | null = null;
      if (isBody) {
        // Player/Anchor body: a loaded rigged glTF if preloaded — a PER-ROLE model from
        // the KayKit crew set (default), or a single override model — else the procedural
        // STUBBY/CUTE body. Same BodyCharacter contract regardless.
        const role = w.role[id]!;
        const tpl = this.roleModels?.get(role) ?? this.modelTemplate;
        char = (this.useGltf && tpl)
          ? new GltfCharacter(tpl.scene, tpl.clips, baseColor, r, hh, tpl.opts)
          : new StubbyCharacter(role, baseColor, r, hh);
        obj = char.root;
        // gold beacon ring + ANCHOR label for the Anchor (always findable)
        if ((w.flags[id]! & BodyFlag.Anchor) !== 0) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.6, r * 1.9, 24), new THREE.MeshBasicMaterial({ color: COLORS.anchor, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
          ring.rotation.x = -Math.PI / 2; ring.position.y = -hh + 0.02; obj.add(ring);
          obj.add(this.makeLabel('ANCHOR', COLORS.anchor, hh + 0.9));
        }
      } else if ((w.flags[id]! & BodyFlag.Pickup) !== 0) {
        // ITEM DROP: a bright emissive gem (crew-neutral) — clearly readable, feeds bloom.
        const m = new THREE.MeshStandardMaterial({ color: 0xffe27a, emissive: 0xffb52e, emissiveIntensity: 1.1, roughness: 0.2, metalness: 0.3 });
        obj = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.26, r * 1.3)), m);
      } else if ((w.flags[id]! & BodyFlag.Breakable) !== 0) {
        // BREAKABLE crate: a chunky wooden box with a darker edge frame (reads "smash me").
        const grp = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(r * 2, hh * 2, r * 2), new THREE.MeshStandardMaterial({ color: 0x9c6b3f, roughness: 0.85 }));
        grp.add(box);
        grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x4a2f18 })));
        obj = grp;
      } else {
        // plain world objects (throwables): in the dungeon, render a small KayKit prop
        // (barrel/crate/box) instead of a placeholder coloured cube so no programmer-art
        // cubes remain. Outside the dungeon, keep the original mass-tier coloured box.
        const prop = this.dungeon?.propFor(r, hh, id * 2654435761) ?? null;
        if (prop) {
          obj = prop;
        } else {
          const mat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.5, emissive: 0x000000 });
          obj = new THREE.Mesh(new THREE.BoxGeometry(r * 2, hh * 2, r * 2), mat);
        }
      }
      this.bodyGroup.add(obj);
      const x = toFloat(fromRaw(w.px[id]!)), y = toFloat(fromRaw(w.py[id]!)), z = toFloat(fromRaw(w.pz[id]!)), f = toFloat(fromRaw(w.facing[id]!));
      v = {
        obj, char, px: x, py: y, pz: z, ppx: x, ppy: y, ppz: z, pf: f, cf: f, glideY: y,
        squash: 1, squashImpulse: 0, baseColor, landPending: false, landStrength: 0, throwPending: false,
      };
      this.vis[id] = v;
    }
    return v;
  }

  /** Local-player "YOU" marker: a bright ground ring + floating label, attached once. */
  private localMarkerDone = false;
  private ensureLocalMarker(w: WorldState, localId: number): void {
    if (this.localMarkerDone || localId < 0 || localId >= w.count) return;
    const v = this.vis[localId];
    if (!v) return; // body not yet built; try again next frame
    const r = toFloat(fromRaw(w.radius[localId]!)), hh = toFloat(fromRaw(w.halfHeight[localId]!));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 1.5, r * 1.85, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -hh + 0.02;
    v.obj.add(ring);
    v.obj.add(this.makeLabel('YOU', 0xffffff, hh + 0.7));
    this.localMarkerDone = true;
  }

  /** A camera-facing text sprite (world-space label). */
  private makeLabel(text: string, color: number, yOff: number): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 40px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#' + color.toString(16).padStart(6, '0'); g.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(2.4, 0.6, 1); spr.position.y = yOff;
    return spr;
  }

  /** Called once per sim tick by the loop: snapshot current→previous for interpolation. */
  commitTick(w: WorldState): void {
    for (let id = 0; id < w.count; id++) {
      if ((w.flags[id]! & BodyFlag.Alive) === 0) continue;
      const v = this.ensureVis(w, id);
      v.ppx = v.px; v.ppy = v.py; v.ppz = v.pz; v.pf = v.cf;
      v.px = toFloat(fromRaw(w.px[id]!)); v.py = toFloat(fromRaw(w.py[id]!)); v.pz = toFloat(fromRaw(w.pz[id]!));
      v.cf = toFloat(fromRaw(w.facing[id]!));
    }
    // After positions advance, fold this tick's sim-events into the JUICE layer
    // (trauma, hitstop, impact FX, landing squash). Pure reader of WorldState.
    this.detectEvents(w);
  }

  /** Render a frame. `alpha` ∈ [0,1] interpolates between previous and current tick. */
  /** Optional live standing/win readout (committed height in m, winner crew or -1).
   *  `crews` (heights in m, index = crewId) drives the multi-crew standings rail. */
  standing: { committed: number; winner: number; localCrew: number; crews?: number[]; target?: number } | null = null;

  render(w: WorldState, alpha: number, localId: number, anchorId: number): void {
    // Attach a persistent "YOU" marker (ground ring + label) to the local player the
    // first time we render — so the player can always find which body they drive.
    this.ensureLocalMarker(w, localId);

    // wall-clock frame delta (view-only; never touches the sim) for time-based juice
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dtMs = this.lastFrameMs < 0 ? 16.7 : Math.min(100, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;

    // HITSTOP: if a big impact is holding the frame, freeze interpolation at the held
    // alpha (render-presentation pause ONLY — the sim already advanced; we just don't
    // move the displayed snapshot forward). docs/07 §4.4 determinism guard.
    if (nowMs < this.hitstopUntil) alpha = this.heldAlpha;
    else this.heldAlpha = alpha;

    // TRAUMA decays continuously (docs/07 §1.7).
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * (dtMs / 1000));

    // clear per-frame FX overlay
    while (this.fxGroup.children.length) {
      const c = this.fxGroup.children.pop()!;
      (c as THREE.Mesh).geometry?.dispose?.();
    }

    let wsum = 0, cx = 0, cy = 0, cz = 0, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    this.eyeValid = false; // re-found below, from the local player, if they are alive
    const anchorY = anchorId >= 0 && anchorId < w.count ? toFloat(fromRaw(w.py[anchorId]!)) : 0;
    let localY = anchorY;
    const localPos = { x: 0, y: anchorY, z: 0 }; // local player world pos → occlusion cutaway
    const crew: { x: number; y: number; z: number }[] = []; // crew positions → fog-of-war reveal
    for (let id = 0; id < w.count; id++) {
      const alive = (w.flags[id]! & BodyFlag.Alive) !== 0;
      const v = this.vis[id] ?? null;
      if (!alive) { if (v) v.obj.visible = false; continue; }
      const vv = this.ensureVis(w, id);
      vv.obj.visible = true;
      // interpolate position + facing (shortest arc)
      const x = vv.ppx + (vv.px - vv.ppx) * alpha;
      const y = vv.ppy + (vv.py - vv.ppy) * alpha;
      const z = vv.ppz + (vv.pz - vv.ppz) * alpha;
      // characters GLIDE short vertical steps/hops (the smooth-step-up read); a big
      // jump/fall (> snap) is shown instantly so the model never floats off the ground.
      if (vv.char) {
        const dy = y - vv.glideY;
        vv.glideY = Math.abs(dy) > CHAR_GLIDE_SNAP ? y : vv.glideY + dy * (1 - Math.exp(-CHAR_GLIDE_RATE * (dtMs / 1000)));
        vv.obj.position.set(x, vv.glideY, z);
      } else {
        vv.obj.position.set(x, y, z);
      }
      vv.obj.rotation.y = -lerpAngle(vv.pf, vv.cf, alpha);
      if ((w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0) crew.push({ x, y, z });

      // held bodies pulse an emissive aura (identity preserved); a downed Anchor pulses red.
      const emissive = w.grabbedBy[id]! !== NO_ENTITY ? 0x442266
        : (w.flags[id]! & BodyFlag.Downed) !== 0 ? 0x551122 : 0x000000;
      if (vv.char) {
        // STUBBY CHARACTER: all deformation + limb posing driven from sim state.
        vv.char.update(this.sampleAnim(w, id, vv, emissive), dtMs / 1000);
      } else {
        // BOX (world object): the original speed-stretch + color/emissive path. Breakable
        // crates (Groups) and pickup gems keep their authored material — recolor only plain boxes.
        this.applySquashStretch(w, id, vv, dtMs);
        const mesh = vv.obj as THREE.Mesh;
        if (mesh.isMesh && (w.flags[id]! & (BodyFlag.Breakable | BodyFlag.Pickup)) === 0) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.color.setHex(vv.baseColor = this.colorFor(w, id));
          mat.emissive.setHex(emissive);
        }
      }

      // camera centers ONLY on the local player; the crew/Anchor are kept findable via
      // off-screen edge indicators instead of pulling the frame (drawOffscreenIndicators).
      let wt = 0;
      if (id === localId) {
        wt = 1.0; localY = y; localPos.x = x; localPos.y = y; localPos.z = z;
        /* THE EYE (`?cam=fp`). It rides the DISPLAYED body, not the raw sim Y — a character
           glides short steps, so an eye on the raw value would bob a quarter of a metre on
           every stair tread while the body it belongs to did not. The head is the top of the
           capsule (halfHeight above centre) less EYE_DROP. And the body itself is hidden,
           because at eye level you are standing inside your own skull. */
        this.eyeAt.set(x, (vv.char ? vv.glideY : y) + toFloat(fromRaw(w.halfHeight[id]!)) - EYE_DROP, z);
        this.eyeValid = true;
        if (this.eye) vv.obj.visible = false;
      }
      if (wt > 0) { wsum += wt; cx += x * wt; cy += y * wt; cz += z * wt; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    }

    this.dbgLocalPos = localPos; // DEV: last local-player render pos (headless framing checks)
    if (this.dungeon) {
      this.dungeon.reveal(crew, FOG_RADIUS, dtMs / 1000);
      // ROUTE-BASED, not height-based: a storey is shown where getting to it is not much further than
      // getting to the cell under or over it here. Must run AFTER reveal, which sets visibility from
      // the explored flag alone and knows nothing about which storeys are worth showing.
      this.dungeon.cullByRoute(localPos.x, localPos.y, localPos.z);
    }
    this.updateCoalescence(anchorY);
    this.updateImpactFx(nowMs);
    this.drawVerbFx(w, alpha, localId);
    this.updateFrameBias(localPos, dtMs / 1000); // slide the target onto the lit room (boss #1/#2)
    this.updateCamera(dtMs / 1000, wsum, cx, cy, cz, minX, maxX, minZ, maxZ);
    // OCCLUSION CUTAWAY: after the camera is posed, cut a hole through whatever stands between it and
    // the local player. A screen-space `discard`, not a fade — so there is no dt to pass.
    if (this.dungeon) {
      // the cut is a SCREEN-SPACE circle, so it needs the drawing-buffer size and the device ratio
      const sz = this.renderer.getSize(this._screenSize);
      this.dungeon.occlude(this.camera, localPos,
        { w: sz.x, h: sz.y, dpr: this.renderer.getPixelRatio() });
    }
    this.drawOffscreenIndicators(w, localId, anchorId);
    this.updateHud(w, anchorId, localId);
    if (this.hotbar && localId >= 0 && localId < w.count) this.hotbar.update(w, localId);
    this.composer.render();
  }

  /**
   * Edge ARROWS pointing to off-screen crew/Anchor (since the camera now centers only on
   * the local player). Pure DOM overlay: project each important body to the camera, and if
   * it's outside the viewport (or behind), clamp an arrow to the screen edge pointing at it.
   * View-only — reads interpolated render positions, never the sim.
   */
  private drawOffscreenIndicators(w: WorldState, localId: number, anchorId: number): void {
    if (!this.indicatorRoot) return;
    const cw = window.innerWidth, ch = window.innerHeight, margin = 40;
    const p = new THREE.Vector3();
    for (let id = 0; id < w.count; id++) {
      const important = id !== localId && (w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0;
      const alive = (w.flags[id]! & BodyFlag.Alive) !== 0;
      const v = this.vis[id] ?? null;
      let rec = this.indicators.get(id) ?? null;
      if (!important || !alive || !v) { if (rec) rec.el.style.display = 'none'; continue; }
      p.copy(v.obj.position); p.y += 0.6;
      const cam = p.clone().applyMatrix4(this.camera.matrixWorldInverse); // camera space (-z forward)
      const behind = cam.z > -0.05;
      const ndc = p.project(this.camera);
      let dx = ndc.x, dy = ndc.y;
      if (behind) { dx = -cam.x; dy = cam.y; } // behind: use camera-space direction
      const onScreen = !behind && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
      if (onScreen) { if (rec) rec.el.style.display = 'none'; continue; }
      // clamp the direction to the [-1,1] NDC box edge, then to screen px with a margin
      const k = 1 / Math.max(Math.abs(dx), Math.abs(dy), 1e-4);
      const ex = dx * k, ey = dy * k;
      const sx = Math.max(margin, Math.min(cw - margin, (ex * 0.5 + 0.5) * cw));
      const sy = Math.max(margin, Math.min(ch - margin, (-ey * 0.5 + 0.5) * ch));
      if (!rec) { rec = this.makeIndicator(); this.indicators.set(id, rec); this.indicatorRoot.appendChild(rec.el); }
      rec.el.style.display = 'block';
      rec.el.style.left = sx + 'px';
      rec.el.style.top = sy + 'px';
      const ang = Math.atan2(sy - ch / 2, sx - cw / 2); // point outward toward the body
      rec.el.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
      const color = (w.flags[id]! & BodyFlag.Anchor) !== 0 ? ANCHOR_COLOR : this.bodyColorFor(w, id);
      rec.tri.style.borderLeftColor = '#' + color.toString(16).padStart(6, '0');
    }
  }

  /** Build one pooled edge-arrow element (a CSS triangle pointing +X, rotated per frame). */
  private makeIndicator(): { el: HTMLElement; tri: HTMLElement } {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;width:0;height:0';
    const tri = document.createElement('div');
    tri.style.cssText = 'width:0;height:0;border-top:11px solid transparent;border-bottom:11px solid transparent;border-left:17px solid #fff;filter:drop-shadow(0 0 5px rgba(0,0,0,.6))';
    el.appendChild(tri);
    return { el, tri };
  }

  // ==========================================================================
  // JUICE — event detection (snapshot-driven, view-only)
  // ==========================================================================

  /**
   * Diff this tick's WorldState against the previous tick's snapshot to detect the
   * juice-worthy events, and feed trauma / hitstop / impact FX. Pure reader: it only
   * reads WorldState fields and updates renderer-local cosmetic state. (docs/07 §4.)
   */
  private detectEvents(w: WorldState): void {
    const n = w.count;
    if (this.prevGrabbedBy.length < n) {
      // grow (and seed) the per-body snapshot arrays — never shrink mid-match.
      this.prevGrabbedBy = growI32(this.prevGrabbedBy, n, w.grabbedBy);
      this.prevThrowTick = growI32(this.prevThrowTick, n, w.lastThrowTick);
      this.prevRushUntil = growI32(this.prevRushUntil, n, w.rushUntil);
      const nd = new Float32Array(n); nd.set(this.prevDescend); this.prevDescend = nd;
    }
    for (let id = 0; id < n; id++) {
      if ((w.flags[id]! & BodyFlag.Alive) === 0) continue;
      const v = this.vis[id];

      // LANDING: this tick's vertical drop, in u/s (+down). A fast descent that just
      // stopped (now grounded / nearly still) is a landing → squash + dust + (player/
      // Anchor) trauma + hitstop. Tick-accurate (snapshot diff), fires exactly once.
      const descend = (v ? (v.ppy - v.py) * TICK_HZ : 0);
      const grounded = (w.flags[id]! & BodyFlag.Grounded) !== 0;
      if (v && this.prevDescend[id]! > LAND_SPEED && (grounded || descend < LAND_SPEED * 0.4)) {
        const hard = this.prevDescend[id]! > HARD_LAND_SPEED;
        if (v.char) { v.landPending = true; v.landStrength = Math.min(1, this.prevDescend[id]! / LAND_VY_REF); } // stubby land-spring
        else v.squashImpulse = hard ? 0.62 : 0.8; // box crush depth on impact
        this.spawnImpact(v.px, v.py - toFloat(fromRaw(w.halfHeight[id]!)) * 0.9, v.pz, COLORS.dust, hard ? 1.5 : 0.9, hard ? 420 : 300);
        if ((w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0) {
          if (hard) { this.addTrauma(TRAUMA_LAND_HARD); this.chargeHitstop(HITSTOP_HARD_MS); }
          else this.addTrauma(TRAUMA_LAND_LIGHT);
        }
      }
      this.prevDescend[id] = Math.max(0, descend);

      // THROW release: a body's lastThrowTick advanced to this tick (it just threw).
      const lt = w.lastThrowTick[id]!;
      if (lt !== this.prevThrowTick[id] && lt === w.tick) {
        this.addTrauma(TRAUMA_THROW);
        this.chargeHitstop(HITSTOP_SOFT_MS);
        if (v?.char) v.throwPending = true; // stubby throw-release fling one-shot
        // burst an impact ring at what the thrower is holding (its position) if any,
        // else at the thrower (the launch point).
        const held = w.holding[id]!;
        const src = held !== NO_ENTITY && this.vis[held] ? held : id;
        const sv = this.vis[src];
        if (sv) this.spawnImpact(sv.px, sv.py, sv.pz, COLORS.arc, 1.4, 380);
      }

      // GRAB latch: grabbedBy transitioned from NO_ENTITY to a real grabber.
      const gb = w.grabbedBy[id]!;
      if (gb !== this.prevGrabbedBy[id] && gb !== NO_ENTITY) {
        this.addTrauma(TRAUMA_GRAB);
        if (v) this.spawnImpact(v.px, v.py, v.pz, COLORS.leashFriendly, 0.8, 260);
      }

      // RUSH start: rushUntil freshly set to a future tick (a dash just launched).
      const ru = w.rushUntil[id]!;
      if (ru !== this.prevRushUntil[id] && ru > w.tick && this.prevRushUntil[id]! <= w.tick) {
        if (v) this.spawnImpact(v.px, v.py - toFloat(fromRaw(w.halfHeight[id]!)) * 0.8, v.pz, COLORS.rush, 0.9, 280);
      }

      this.prevGrabbedBy[id] = gb;
      this.prevThrowTick[id] = lt;
      this.prevRushUntil[id] = ru;
    }
  }

  /** Add cosmetic trauma, clamped to [0,1] (docs/07 §1.7). */
  private addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * Charge a hitstop hold, respecting the per-window budget (concurrent events take
   * the MAX, not the sum — docs/07 §4.4). Render-presentation only.
   */
  private chargeHitstop(ms: number): void {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // prune log entries outside the rolling window
    this.hitstopLog = this.hitstopLog.filter((e) => now - e.t < HITSTOP_WINDOW_MS);
    const used = this.hitstopLog.reduce((s, e) => s + e.ms, 0);
    const grant = Math.max(0, Math.min(ms, HITSTOP_BUDGET_MS - used));
    if (grant <= 0) return;
    this.hitstopLog.push({ t: now, ms: grant });
    // take the MAX target time, never stack: extend the hold, don't sum it.
    this.hitstopUntil = Math.max(this.hitstopUntil, now + grant);
  }

  /**
   * SQUASH/STRETCH (per render frame, view-only mesh scale — never the collision
   * shape). Airborne bodies stretch slightly along Y with their interpolated descent
   * speed; a pending landing impulse (set tick-accurately in detectEvents) snaps the
   * spring down, then the spring eases back to neutral. Volume is roughly conserved.
   */
  private applySquashStretch(w: WorldState, id: number, v: Vis, dtMs: number): void {
    const descend = (v.ppy - v.py) * TICK_HZ; // interpolated per-tick descent (u/s; +down)
    const grounded = (w.flags[id]! & BodyFlag.Grounded) !== 0;

    // consume a pending landing crush this frame (snap the spring down once).
    if (v.squashImpulse > 0) { v.squash = v.squashImpulse; v.squashImpulse = 0; }

    // airborne stretch target: scale Y up slightly with descent speed (capped).
    let targetY = 1;
    if (!grounded) targetY = 1 + Math.min(0.22, Math.abs(descend) * 0.012);

    // ease the squash spring back toward the target
    const k = Math.min(1, dtMs / 90);
    v.squash += (targetY - v.squash) * k;
    const xz = 1 / Math.sqrt(Math.max(0.2, v.squash)); // conserve rough volume (x·z·y ≈ const)
    v.obj.scale.set(xz, v.squash, xz);
  }

  /**
   * Build the per-frame AnimSample for a stubby character — a PURE READ of sim-truth
   * fields (the determinism-relevant SELECTION). The character turns it into poses;
   * only its internal playback phase (stride/land-spring) uses render wall-clock, which
   * is view-safe (CLAUDE.md / docs/06 §0). One-shots set in detectEvents are consumed here.
   */
  private sampleAnim(w: WorldState, id: number, v: Vis, emissive: number): AnimSample {
    const vx = toFloat(fromRaw(w.vx[id]!)), vy = toFloat(fromRaw(w.vy[id]!)), vz = toFloat(fromRaw(w.vz[id]!));
    const f = toFloat(fromRaw(w.facing[id]!));
    const cosF = Math.cos(f), sinF = Math.sin(f);
    const holding = w.holding[id]! !== NO_ENTITY;
    const s: AnimSample = {
      speed: Math.hypot(vx, vz),
      leanFwd: vx * cosF + vz * sinF,       // velocity along facing (lean into travel)
      leanSide: -vx * sinF + vz * cosF,     // velocity across facing (strafe lean)
      vy,
      grounded: (w.flags[id]! & BodyFlag.Grounded) !== 0,
      justLanded: v.landPending,
      landStrength: v.landStrength,
      holding,
      carryMass: holding ? w.massClass[w.holding[id]!]! : -1,
      grabbed: w.grabbedBy[id]! !== NO_ENTITY,
      struggle: Math.min(1, toFloat(fromRaw(w.struggleProgress[id]!)) / 100), // /STRUGGLE_BREAK(100)
      throwCharge: Math.min(1, w.throwCharge[id]! / THROW_CHARGE_TICKS),
      justThrew: v.throwPending,
      rushing: w.rushUntil[id]! >= w.tick,
      staggered: w.staggerUntil[id]! >= w.tick,
      downed: (w.flags[id]! & BodyFlag.Downed) !== 0 || w.downedUntil[id]! >= w.tick,
      emissive,
      tick: w.tick,
    };
    v.landPending = false; v.throwPending = false; // consume one-shots
    return s;
  }

  // ==========================================================================
  // COALESCENCE — per-stratum reveal (view-only)
  // ==========================================================================

  /**
   * Drive each terrain BAND's look from the Anchor's height (docs/06 §2-3):
   *   - ABOVE the Anchor: a band resolves from a dotted "potential" wireframe to a
   *     solid lit slab as the Anchor nears its base Y (reveal ∈ [0,1]).
   *   - BELOW the Anchor: the band desaturates + darkens with depth (still visible,
   *     floored — you can always read where a thrown body lands; pillar 4/7).
   * Reveal is purely cosmetic; collision is sim-truth regardless of look.
   */
  private updateCoalescence(anchorY: number): void {
    if (this.dungeonActive) return; // dungeon tiles replace the abstract floor reveal
    if (this.bands.length === 0) return;
    // Spacing between strata surfaces (the "one floor up" unit). Derived from the two
    // lowest bands; falls back to 6 m (the tower's FLOOR_HEIGHT) if only one exists.
    let spacing = 6;
    if (this.bands.length >= 2) spacing = Math.max(1, this.bands[1]!.baseY - this.bands[0]!.baseY);

    for (const band of this.bands) {
      // Floor offset relative to the one the Anchor is standing ON. We bias by half a
      // floor so the Anchor's CENTER (≈ surface + halfHeight) still reads its own floor
      // as "current" (rel≈0), not as "below". rel≈0 = your floor; +1 = the next floor
      // up; +2 and beyond = higher floors (hidden).
      const rel = (band.baseY - anchorY + spacing * 0.45) / spacing;

      if (rel < 0.5) {
        // CURRENT floor (and anything at/below it) → fully SOLID, lit, no wireframe.
        // Floors genuinely below desaturate gently with depth so the climb still reads.
        band.wire.visible = false;
        band.solid.visible = true;
        const depth = clamp01(-rel / 4); // 0 at your floor → 1 about 4 floors down
        const col = lerpHex(this.style.wall, this.style.belowDark, depth * 0.85);
        for (const m of band.solidMats) {
          m.opacity = 1;
          m.color.setHex(col);
          m.emissive.setHex(0x000000);
        }
      } else if (rel < 1.6) {
        // The floor DIRECTLY ABOVE → a faint 2D floor-plan that resolves to a lit slab
        // as the Anchor climbs the last stretch toward it (reveal 0→1 over rel 1.0→0.5).
        const reveal = clamp01((1.6 - rel) / 1.1);
        (band.wire.material as THREE.LineDashedMaterial).opacity = (1 - reveal) * 0.3;
        band.wire.visible = reveal < 0.999;
        const lit = reveal * reveal;
        const col = lerpHex(this.style.wall, this.style.lit, lit * 0.5);
        for (const m of band.solidMats) {
          // keep the floor above SEE-THROUGH: it only approaches ~0.6 opacity right as
          // you arrive (reveal→1), staying a translucent ghost most of the approach so
          // it never blocks the view of your own floor.
          m.opacity = 0.02 + 0.58 * (reveal * reveal);
          m.color.setHex(col);
          m.emissive.setHex(lerpHex(0x000000, this.style.lit, lit * 0.35));
        }
        band.solid.visible = reveal > 0.02;
      } else {
        // HIGHER floors (2+ strata up) → INVISIBLE (no clutter above the next floor).
        band.wire.visible = false;
        band.solid.visible = false;
      }
    }
  }

  // ==========================================================================
  // IMPACT FX — pooled expanding ring + dust puff (view-only)
  // ==========================================================================

  /** Pre-allocate the impact effect pool (rings + dust point-clouds). No per-frame alloc. */
  private buildImpactPool(): void {
    const ringGeo = new THREE.RingGeometry(0.85, 1.0, 28);
    for (let i = 0; i < Renderer.IMPACT_POOL_SIZE; i++) {
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2; ring.visible = false;
      this.impactGroup.add(ring);

      const dustGeo = new THREE.BufferGeometry();
      const pos = new Float32Array(Renderer.DUST_PER_FX * 3);
      const dir = new Float32Array(Renderer.DUST_PER_FX * 3); // baked unit-ish scatter
      for (let d = 0; d < Renderer.DUST_PER_FX; d++) {
        const a = (d / Renderer.DUST_PER_FX) * Math.PI * 2 + (i * 0.7);
        dir[d * 3] = Math.cos(a); dir[d * 3 + 1] = 0.4 + (d % 3) * 0.25; dir[d * 3 + 2] = Math.sin(a);
      }
      dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const dustMat = new THREE.PointsMaterial({ color: COLORS.dust, size: 0.16, transparent: true, opacity: 0, depthWrite: false });
      const dust = new THREE.Points(dustGeo, dustMat);
      dust.visible = false;
      (dust as unknown as { _dir: Float32Array })._dir = dir;
      this.impactGroup.add(dust);

      this.impactPool.push({ ring, ringMat, dust, dustMat, born: -1, x: 0, y: 0, z: 0, life: 300, peak: 1, baseColor: 0xffffff });
    }
  }

  /** Spawn an impact effect from the pool (oldest reused if full). View-only. */
  private spawnImpact(x: number, y: number, z: number, color: number, peak: number, life: number): void {
    let slot = this.impactPool.find((f) => f.born < 0);
    if (!slot) { // reuse the oldest live one
      slot = this.impactPool.reduce((a, b) => (a.born <= b.born ? a : b));
    }
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    slot.born = now; slot.x = x; slot.y = y; slot.z = z; slot.life = life; slot.peak = peak; slot.baseColor = color;
    slot.ring.position.set(x, y, z); slot.ring.visible = true;
    slot.ringMat.color.setHex(color); slot.ringMat.opacity = 0.9;
    slot.dust.position.set(x, y, z); slot.dust.visible = true;
    slot.dustMat.color.setHex(color); slot.dustMat.opacity = 0.9;
    // reset dust to the origin
    const p = slot.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count * 3; i++) (p.array as Float32Array)[i] = 0;
    p.needsUpdate = true;
  }

  /** Advance all live impact effects (expand ring, scatter dust, fade out). View-only. */
  private updateImpactFx(now: number): void {
    for (const f of this.impactPool) {
      if (f.born < 0) continue;
      const t = (now - f.born) / f.life;
      if (t >= 1) { f.born = -1; f.ring.visible = false; f.dust.visible = false; continue; }
      const e = 1 - (1 - t) * (1 - t); // ease-out
      const s = 0.15 + f.peak * e;
      f.ring.scale.set(s, s, s);
      f.ringMat.opacity = 0.9 * (1 - t);
      // scatter dust outward along baked dirs, settling with gravity-ish droop
      const dir = (f.dust as unknown as { _dir: Float32Array })._dir;
      const p = f.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      const spread = f.peak * 0.9 * e;
      for (let d = 0; d < Renderer.DUST_PER_FX; d++) {
        arr[d * 3] = dir[d * 3]! * spread;
        arr[d * 3 + 1] = dir[d * 3 + 1]! * spread - 1.6 * t * t * f.peak;
        arr[d * 3 + 2] = dir[d * 3 + 2]! * spread;
      }
      p.needsUpdate = true;
      f.dustMat.opacity = 0.9 * (1 - t);
    }
  }

  /** Grab leashes, throw aim-arc + reticle, struggle radials, rush streaks. */
  private drawVerbFx(w: WorldState, alpha: number, localId: number): void {
    const posOf = (id: number) => { const v = this.vis[id]!; return new THREE.Vector3(v.ppx + (v.px - v.ppx) * alpha, v.ppy + (v.py - v.ppy) * alpha, v.ppz + (v.pz - v.ppz) * alpha); };
    for (let id = 0; id < w.count; id++) {
      if ((w.flags[id]! & BodyFlag.Alive) === 0) continue;
      // GRAB/CARRY leash: holder → held
      const held = w.holding[id]!;
      if (held !== NO_ENTITY && this.vis[held]) {
        const friendly = id === localId; // (crew identity not yet modeled; local-carry = friendly)
        this.fxGroup.add(line(posOf(id), posOf(held), friendly ? COLORS.leashFriendly : COLORS.leashHostile));
      }
      // STRUGGLE radial: a ring above a body that's accumulating struggle progress
      if (w.struggleProgress[id]! > 0) {
        const p = posOf(id); p.y += toFloat(fromRaw(w.halfHeight[id]!)) + 0.6;
        this.fxGroup.add(dot(p, COLORS.struggle, 0.18));
      }
    }
    // local player's THROW aim-arc (only while holding + charging)
    if (localId >= 0 && localId < w.count && w.holding[localId] !== NO_ENTITY) {
      const charge = Math.min(1, w.throwCharge[localId]! / THROW_CHARGE_TICKS);
      const from = posOf(localId);
      // Terminate the preview at the LOCAL PLAYER'S floor (feet Y), not the deep
      // terrain slab at ≈ −14 (GAPS M5: the arc used to pierce every floor). Good
      // enough until real per-box terrain termination lands.
      const floorY = from.y - toFloat(fromRaw(w.halfHeight[localId]!));
      this.fxGroup.add(this.throwArc(from, toFloat(fromRaw(w.facing[localId]!)), charge, w.massClass[w.holding[localId]!]! as MassClass, floorY));
    }
  }

  /** A dotted parabolic arc previewing where a held body would land at this charge.
   *  `floorY` = the world Y the arc terminates against (the local player's floor). */
  private throwArc(from: THREE.Vector3, facing: number, charge: number, heldMass: MassClass, floorY: number): THREE.Object3D {
    const massV = [0.4, 1.0, 1.8, 3.2][heldMass] ?? 1.0;
    const j = toFloat(THROW_J) * Math.max(0.05, charge) * (1 / Math.sqrt(massV));
    const ang = toFloat(THROW_ANGLE_DEFAULT);
    const vx = j * Math.cos(ang) * Math.cos(facing), vz = j * Math.cos(ang) * Math.sin(facing), vy = j * Math.sin(ang);
    const g = 22, pts: THREE.Vector3[] = [];
    for (let t = 0; t <= 1.2; t += 0.06) {
      const py = from.y + vy * t - 0.5 * g * t * t;
      if (py < floorY && t > 0.1) break;
      pts.push(new THREE.Vector3(from.x + vx * t, py, from.z + vz * t));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const col = new THREE.Color(COLORS.arc).lerp(new THREE.Color(0xff5a6e), charge); // hotter = stronger
    return new THREE.Line(geo, new THREE.LineDashedMaterial({ color: col, dashSize: 0.25, gapSize: 0.2 })).computeLineDistances();
  }

  /**
   * FRAMING BIAS (boss #1/#2): ease a small offset that slides the camera target off the
   * player toward the centroid of the EXPLORED dungeon cells around them, capped at
   * FRAME_BIAS_MAX. At an EDGE spawn the player sits against the perimeter wall and the
   * room opens to one side; a naive player-centered, +Z-looking camera then frames the
   * void → an all-black opening. Pulling the target toward the lit centroid guarantees the
   * revealed dungeon is on screen. View-only; reads only the reveal state. No-op without a
   * dungeon (the abstract box tower frames fine player-centered).
   */
  private updateFrameBias(localPos: { x: number; y: number; z: number }, dt: number): void {
    let tx = 0, tz = 0;
    if (this.dungeon && FRAME_BIAS_MAX > 0) {
      const f = this.dungeon.exploredFrameNear(localPos.x, localPos.y, localPos.z);
      if (f) {
        // Slide the target toward the lit-cell centroid in BOTH ground axes, capped at
        // FRAME_BIAS_MAX so the player stays in frame.
        const ox = f.x - localPos.x, oz = f.z - localPos.z;
        const len = Math.hypot(ox, oz);
        if (len > 1e-3) {
          const m = Math.min(FRAME_BIAS_MAX, len);
          tx = (ox / len) * m; tz = (oz / len) * m;
        }
      }
    }
    // SNAP on the very first framed frame so the OPENING view is already on the lit room
    // (no 1-second slide); ease thereafter.
    if (!this.camReady) { this.frameBiasX = tx; this.frameBiasZ = tz; return; }
    const k = 1 - Math.exp(-FRAME_BIAS_RATE * dt);
    this.frameBiasX += (tx - this.frameBiasX) * k;
    this.frameBiasZ += (tz - this.frameBiasZ) * k;
  }

  private updateCamera(dt: number, wsum: number, cx: number, cy: number, cz: number, minX: number, maxX: number, minZ: number, maxZ: number): void {
    /* EYE-LEVEL INSPECTION (`?cam=fp`): stand in the local player's head and look along the
       mouse. RIGID, not smoothed — a smoothed eye lags into the wall you just walked up to,
       and a lagging eye is exactly the thing this mode exists to avoid. No dolly, no pan, no
       framing bias, and no screen shake: a 0.9u shake offset at eye level puts the camera
       through the masonry. `updateFrameBias` above is left running so leaving the mode does
       not snap. */
    if (this.eye && this.eyeValid) {
      const cp = Math.cos(this.eye.pitch), sp = Math.sin(this.eye.pitch);
      const { x, y, z } = this.eyeAt;
      this.camera.position.set(x, y, z);
      this.camera.lookAt(x - Math.sin(this.eye.yaw) * cp, y + sp, z - Math.cos(this.eye.yaw) * cp);
      return;
    }
    if (wsum <= 0) { this.composer.render(); return; }
    // bias the target toward the explored-room centroid so the opening view frames the lit
    // dungeon, not the perimeter void (boss #1/#2). The bias is itself eased in updateFrameBias.
    const target = new THREE.Vector3(cx / wsum + this.frameBiasX, cy / wsum, cz / wsum + this.frameBiasZ);
    if (!this.camReady) { this.camTarget.copy(target); this.camReady = true; }
    // FRAMERATE-INDEPENDENT asymmetric smoothing: factor = 1 − e^(−rate·dt) converges
    // identically per second at any refresh (the old per-frame lerp(0.18/0.10) was
    // ~2× twitchier at 144 Hz). Snappier when the target rises (climb), looser down.
    const up = target.y > this.camTarget.y;
    this.camTarget.lerp(target, 1 - Math.exp(-(up ? CAM_RISE_RATE : CAM_FALL_RATE) * dt));

    // RECENTER-ON-MOVE: while the local player actively moves, the manual pan drifts
    // back toward a small forward LEAD in their facing direction (speed-scaled,
    // capped) so the view settles slightly ahead of travel — "the pan shifts back to
    // the prescribed angle in the direction the user is facing". While stationary
    // the manual pan stays exactly where the user put it.
    if (this.localMoving) {
      const lead = Math.min(PAN_LEAD_MAX, this.localSpeed * PAN_LEAD_PER_SPEED);
      const leadX = Math.cos(this.localFacing) * lead, leadZ = Math.sin(this.localFacing) * lead;
      const k = 1 - Math.exp(-PAN_RECENTER_RATE * dt);
      this.panX += (leadX - this.panX) * k;
      this.panZ += (leadZ - this.panZ) * k;
    }

    // DOLLY × user wheel zoom, clamped to an absolute range. The camera centers only on the
    // local player (extent≈0), so the opening dolly sits at CAM_D_CLOSE — a TIGHT framing that
    // fills the screen with the player's lit room (the 30×30 dungeon is a sparse top-down map;
    // a far dolly shrinks the room into a speck adrift in void, which read as "black on load").
    const extent = Math.max(maxX - minX, maxZ - minZ, 0);
    const baseDist = Math.min(CAM_D_FAR, CAM_D_CLOSE + extent * 0.9);
    const wantDist = Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, baseDist * this.userZoom));
    this.camDist += (wantDist - this.camDist) * (1 - Math.exp(-CAM_DOLLY_RATE * dt));

    // Camera offset (0, D·sinP, D·cosP) + lookAt the (panned) target EXACTLY, so the
    // pitch equals focusPitch (default ≈72° = atan2(CAM_SIN55, CAM_COS55); now USER-
    // adjustable via left-drag vertical, docs/11 §2). The 42%-up framing stays a projection
    // SHIFT via setViewOffset in resize() (CAM_SIN55/FRAME_SHIFT) and is left as-is.
    // Orbit the player at the focus heading (docs/11): rotate the ground offset around Y by
    // focusYaw. focusYaw 0 = the shipped +Z view; camera-forward = (−sin,−cos) matches the
    // input's forwardDir, so "W" always goes up the screen.
    const D = this.camDist;
    const fx = this.camTarget.x + this.panX, fy = this.camTarget.y, fz = this.camTarget.z + this.panZ;
    const sinP = Math.sin(this.focusPitch), cosP = Math.cos(this.focusPitch);
    const gr = D * cosP;
    this.camera.position.set(fx + Math.sin(this.focusYaw) * gr, fy + D * sinP, fz + Math.cos(this.focusYaw) * gr);
    this.camera.lookAt(fx, fy, fz);

    // SCREEN SHAKE (docs/07 §1.7): offset = trauma² · maxOffset · cosmetic-noise.
    // Squared so the low end is gentle. Accessibility-gated by shakeIntensity.
    const sh = this.trauma * this.trauma * this.shakeIntensity;
    if (sh > 0.0001) {
      const t = this.lastFrameMs;
      const ox = shakeNoise(t, 1) * SHAKE_MAX_OFFSET * sh;
      const oy = shakeNoise(t, 2) * SHAKE_MAX_OFFSET * sh;
      const oz = shakeNoise(t, 3) * SHAKE_MAX_OFFSET * sh;
      this.camera.position.x += ox; this.camera.position.y += oy; this.camera.position.z += oz;
      this.camera.rotation.z += shakeNoise(t, 4) * SHAKE_MAX_ROLL * sh; // bounded cosmetic roll
    }
  }

  /** Top-center Anchor Status: HEIGHT (=score, COMMITTED), state word, health arc.
   *  Plus the LOCAL-PLAYER health pill (bottom-right). Both pure readers of WorldState. */
  private updateHud(w: WorldState, anchorId: number, localId = -1): void {
    // LOCAL PLAYER HEALTH (independent of the Anchor block below — always update if alive).
    if (this.localHud && localId >= 0 && localId < w.count && (w.flags[localId]! & BodyFlag.Alive) !== 0) {
      const lhp = Math.max(0, Math.min(100, toFloat(fromRaw(w.health[localId]!))));
      const col = lhp > 50 ? '#6cff8a' : lhp > 25 ? '#ffb24f' : '#ff5a6e';
      this.localHud.bar.style.width = lhp + '%';
      this.localHud.bar.style.background = col;
      this.localHud.num.textContent = String(Math.round(lhp));
      this.localHud.num.style.color = col;
      this.localHud.root.style.display = 'block';
    } else if (this.localHud) {
      this.localHud.root.style.display = 'none';
    }
    if (!this.hud) return;
    if (anchorId < 0 || anchorId >= w.count) return;
    // Prefer the COMMITTED standing (the actual score) when available; else live Y.
    const liveH = Math.max(0, toFloat(fromRaw(w.py[anchorId]!)) - this.groundY);
    const heightU = this.standing ? this.standing.committed : liveH;
    this.hud.height.textContent = heightU.toFixed(1) + ' m';
    // win banner
    if (this.standing && this.standing.winner >= 0 && this.winBanner) {
      this.winBanner.style.display = 'block';
      this.winBanner.textContent = this.standing.winner === this.standing.localCrew ? 'YOUR CREW WINS!' : `CREW ${this.standing.winner + 1} WINS`;
    }
    const grabbed = w.grabbedBy[anchorId] !== NO_ENTITY;
    const downed = (w.flags[anchorId]! & BodyFlag.Downed) !== 0;
    const state = downed ? 'DOWNED' : grabbed ? 'GRABBED' : 'SECURE';
    this.hud.state.textContent = state;
    this.hud.state.style.color = downed ? '#ff5a6e' : grabbed ? '#ffb24f' : '#6cff8a';
    this.hud.root.style.boxShadow = grabbed || downed ? '0 0 24px #ff5a6e88' : 'none';
    const hp = Math.max(0, Math.min(100, toFloat(fromRaw(w.health[anchorId]!))));
    this.hud.health.style.width = hp + '%';
    this.hud.health.style.background = hp > 50 ? '#6cff8a' : hp > 25 ? '#ffb24f' : '#ff5a6e';

    this.updateStandingsRail();
    this.updateOnboard();
  }

  /** Render the per-crew altitude beads on the standings rail (docs/07 §2.1). */
  private updateStandingsRail(): void {
    const rail = this.standingsRail;
    if (!rail || !this.standing?.crews) return;
    const crews = this.standing.crews;
    const target = this.standing.target && this.standing.target > 0 ? this.standing.target : Math.max(1, ...crews) * 1.2;
    // lazily create one bead per crew
    while (this.railBeads.length < crews.length) {
      const b = document.createElement('div');
      b.style.cssText = 'position:absolute;left:6px;width:20px;height:20px;border-radius:50%;transform:translateY(50%);transition:bottom .2s;border:2px solid #0a0a12;font:9px/20px system-ui;text-align:center;color:#0a0a12;font-weight:800';
      rail.appendChild(b);
      this.railBeads.push(b);
    }
    for (let c = 0; c < crews.length; c++) {
      const bead = this.railBeads[c]!;
      const frac = Math.max(0, Math.min(1, crews[c]! / target));
      bead.style.bottom = `calc(${(frac * 100).toFixed(1)}% - 10px)`;
      bead.style.background = '#' + this.crewColor(c).toString(16).padStart(6, '0');
      const mine = c === this.standing.localCrew;
      bead.style.boxShadow = mine ? '0 0 10px #fff' : 'none';
      bead.style.zIndex = mine ? '2' : '1';
      bead.textContent = mine ? 'YOU' : String(c + 1);
      bead.style.fontSize = mine ? '8px' : '10px';
    }
  }

  /** Fade the onboarding panel out after a grace period. */
  private updateOnboard(): void {
    if (!this.onboard) return;
    if (this.startMs < 0) this.startMs = (this.lastFrameMs ?? 0) || 1;
    const now = this.lastFrameMs ?? 0;
    if (now - this.startMs > 14000) this.onboard.style.opacity = '0';
  }

  /** Attach the DOM HUD overlay (called once by main). */
  attachHud(app: HTMLElement): void {
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);text-align:center;font-family:system-ui;color:#cdd;background:rgba(10,10,22,0.72);padding:8px 18px;border-radius:12px;pointer-events:none;backdrop-filter:blur(6px);transition:box-shadow .2s';
    const label = document.createElement('div'); label.textContent = 'ANCHOR HEIGHT = SCORE'; label.style.cssText = 'font-size:10px;letter-spacing:.18em;opacity:.6';
    const height = document.createElement('div'); height.style.cssText = 'font-size:30px;font-weight:800;line-height:1.1';
    const state = document.createElement('div'); state.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:.1em';
    const bar = document.createElement('div'); bar.style.cssText = 'margin-top:5px;width:140px;height:5px;border-radius:3px;background:#ffffff22;overflow:hidden';
    const health = document.createElement('div'); health.style.cssText = 'height:100%;width:100%;background:#6cff8a;transition:width .15s,background .15s'; bar.appendChild(health);
    root.append(label, height, state, bar);
    app.appendChild(root);
    this.hud = { root, height, state, health };

    // off-screen crew-indicator layer (edge arrows pointing to off-screen players/Anchor)
    const ind = document.createElement('div');
    ind.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden';
    app.appendChild(ind);
    this.indicatorRoot = ind;

    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:42%;left:50%;transform:translate(-50%,-50%);font-family:system-ui;font-weight:800;font-size:48px;color:#ffd23f;text-shadow:0 4px 24px #000;display:none;pointer-events:none';
    app.appendChild(banner);
    this.winBanner = banner;

    // STANDINGS RAIL (top-left): a vertical track with a bead per crew at its relative
    // Anchor altitude — "am I winning?" at a glance (docs/07 §2.1). Pure reader.
    const rail = document.createElement('div');
    rail.style.cssText = 'position:fixed;left:14px;top:80px;bottom:80px;width:34px;pointer-events:none;font-family:system-ui';
    const track = document.createElement('div');
    track.style.cssText = 'position:absolute;left:15px;top:0;bottom:0;width:3px;background:#ffffff22;border-radius:2px';
    rail.appendChild(track);
    app.appendChild(rail);
    this.standingsRail = rail;

    // ONBOARDING (bottom-center): the thesis + verb prompts, fades after ~14s.
    const onboard = document.createElement('div');
    onboard.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);font-family:system-ui;color:#cdd;background:rgba(10,10,22,0.7);padding:10px 16px;border-radius:10px;pointer-events:none;text-align:center;transition:opacity 1.2s;max-width:440px';
    onboard.innerHTML = '<b style="color:#ffd23f">Get your gold Anchor to the top.</b><br>' +
      '<span style="opacity:.75;font-size:13px">Its height is your score. Climb together — carry it across gaps, ' +
      '<b>left-tap</b> to grab &amp; <b>right-click</b> to throw, <b>E</b> for your role ability, <b>Q</b> to plant/recall.</span>';
    app.appendChild(onboard);
    this.onboard = onboard;

    // LOCAL-PLAYER HEALTH (bottom-right): a compact "YOU" health pill in the same dark
    // blurred-glass style as the Anchor panel — so the player can read their own HP at a
    // glance without it crowding the Anchor score (top) or controls (bottom-left). Pure
    // reader of w.health[localId].
    const lh = document.createElement('div');
    lh.style.cssText = 'position:fixed;right:16px;bottom:16px;font-family:system-ui;color:#cdd;background:rgba(10,10,22,0.72);padding:8px 12px;border-radius:12px;pointer-events:none;backdrop-filter:blur(6px);min-width:128px;text-align:left';
    const lhLabel = document.createElement('div');
    lhLabel.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;font-size:10px;letter-spacing:.16em;opacity:.7';
    const lhTag = document.createElement('span'); lhTag.textContent = 'YOU · HEALTH';
    const lhNum = document.createElement('span'); lhNum.style.cssText = 'font-size:13px;font-weight:800;letter-spacing:0;opacity:1;color:#6cff8a'; lhNum.textContent = '100';
    lhLabel.append(lhTag, lhNum);
    const lhBarBg = document.createElement('div'); lhBarBg.style.cssText = 'margin-top:5px;width:100%;height:7px;border-radius:4px;background:#ffffff1c;overflow:hidden';
    const lhBar = document.createElement('div'); lhBar.style.cssText = 'height:100%;width:100%;background:#6cff8a;transition:width .15s,background .15s'; lhBarBg.appendChild(lhBar);
    lh.append(lhLabel, lhBarBg);
    app.appendChild(lh);
    this.localHud = { root: lh, bar: lhBar, num: lhNum };
  }

  /**
   * Attach the INVENTORY HOTBAR + contextual HINT overlay (docs/11). Pure reader of the
   * sim's per-player inventory + targeting state; `localCrew` only picks the accent color.
   * Kept as its own method (and its own file, src/render/hotbar.ts) so the renderer edit
   * stays minimal. Call once by main after attachHud.
   */
  attachHotbar(app: HTMLElement, localCrew: number): void {
    this.hotbar = new Hotbar(app, localCrew);
  }

  /** Crew identity colors (index = crewId). Crew 0 = the local crew (warm gold-blue). */
  private crewColor(crewId: number): number {
    return CREW_COLORS[crewId % CREW_COLORS.length]!;
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h); // resizes RenderPass/SMAA/bloom targets too
    this.camera.aspect = w / h;
    // 42%-up FRAMING (07 §1.3): render a same-size window shifted UP by 8% of the
    // image height inside a virtual larger frustum — all content moves DOWN 8%, so
    // the exactly-lookAt'd subject (screen center, 50%) lands at 42% from the bottom
    // with the true 55° pitch untouched. Recomputed on every resize because the
    // offset is in pixels. setViewOffset keeps aspect = w/h (full == sub size) and
    // bakes the shift into the projection matrix, so cursor raycasts in worldAimFrom
    // automatically see the shifted frustum.
    // ...except under the eye-level inspection camera, which frames nothing and wants
    // the plain frustum (setEyeCam already cleared the offset; don't put it back).
    if (this.eye) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, 0, -FRAME_SHIFT * h, w, h);
    this.camera.updateProjectionMatrix();
  }
}

/** Shortest-arc angle interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function line(a: THREE.Vector3, b: THREE.Vector3, color: number): THREE.Line {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color }));
}
function dot(p: THREE.Vector3, color: number, r: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(p); return m;
}

/** clamp a number to [0,1]. */
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Linear blend between two packed RGB hex colors → packed RGB hex. */
function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Cosmetic shake noise ∈ [-1,1] from a wall-clock time + channel. Deterministic given
 * (t,ch) but VIEW-ONLY (never enters the sim) — a cheap value-noise via fract(sin).
 */
function shakeNoise(t: number, ch: number): number {
  const s = Math.sin(t * 0.013 * (ch + 1) + ch * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Append the 12 edges of an axis-aligned box (center + size) as line-segment verts. */
// "Potential" floors above the crew are drawn as a FLAT 2D FLOOR-PLAN — just the
// top-face rectangle of each slab at its walkable surface — not a full 3D wire box.
// Rationale (player feedback): full box edges (12 per slab: verticals + both faces)
// pile up in front of the tilted up-looking camera and bury the playfield. The top
// quad alone (4 edges) reads as "a platform is up there" with ~1/3 the visual weight
// and no vertical struts crossing the view. Collision is sim-truth regardless.
function appendBoxEdges(out: number[], cx: number, cz: number, w: number, d: number, planeY: number): void {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  // four corners of the cell footprint, ALL on the band's single surface plane
  const c = [[x0, planeY, z0], [x1, planeY, z0], [x1, planeY, z1], [x0, planeY, z1]];
  const E = [[0, 1], [1, 2], [2, 3], [3, 0]]; // rectangle outline only — pure 2D plan
  for (const [a, b] of E) {
    const p = c[a!]!, q = c[b!]!;
    out.push(p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!);
  }
}

/** Grow an Int32 snapshot array to length n, seeding new slots from `seed`. */
function growI32(prev: Int32Array, n: number, seed: Int32Array): Int32Array {
  const next = new Int32Array(n);
  next.set(prev);
  for (let i = prev.length; i < n; i++) next[i] = seed[i]!;
  return next;
}
