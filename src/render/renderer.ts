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
//   - CAMERA tuned for the climb: anchor-weighted centroid, framed ~42% up, FOV ~40,
//     ~55° down-pitch, spread-driven dolly, asymmetric up/down smoothing.
//   - WORLD-SPACE AIM: a ray from the cursor onto the ground plane (so screen aim
//     equals world direction under the tilted camera).
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
import { StubbyCharacter, CREW_COLORS, ANCHOR_COLOR, type AnimSample } from './character.ts';

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

/** Per-body render record holding previous + current sim positions for interpolation. */
interface Vis {
  /** the transform target: a StubbyCharacter's root (Player/Anchor) or an object box. */
  obj: THREE.Object3D;
  /** procedural stubby body for Player/Anchor bodies; null for world-object boxes. */
  char: StubbyCharacter | null;
  px: number; py: number; pz: number; ppx: number; ppy: number; ppz: number;
  pf: number; cf: number;
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
  private vis: (Vis | null)[] = [];
  private readonly bodyGroup = new THREE.Group();
  private readonly fxGroup = new THREE.Group(); // verb-feedback overlay (rebuilt each frame)
  private camTarget = new THREE.Vector3();
  private camDist = 20;
  private camReady = false;
  private groundY = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** HUD elements (DOM overlay; pure readout of sim state). */
  private hud: { root: HTMLElement; height: HTMLElement; state: HTMLElement; health: HTMLElement } | null = null;
  private winBanner: HTMLElement | null = null;
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0a0a12);
    this.scene.fog = new THREE.Fog(0x0a0a12, 30, 70);

    // FOV ~40 (longer lens, less edge parallax — spec 07 §1.1).
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(8, 22, 10);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0x6677aa, 0.6));
    this.scene.add(this.bodyGroup);
    this.scene.add(this.fxGroup);
    this.scene.add(this.impactGroup);
    this.buildImpactPool();

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
   * Accessibility: scale screen shake (0 = off, 1 = full). Default on (1). At 0 the
   * camera never shakes (the impact read still comes through hitstop + impact FX).
   */
  setShakeIntensity(v: number): void {
    this.shakeIntensity = Math.max(0, Math.min(1, v));
  }

  buildTerrain(terrain: Terrain): void {
    this.groundY = toFloat(fromRaw(terrain.groundY));
    this.groundPlane.constant = -this.groundY;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = this.groundY;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(60, 30, COLORS.grid, COLORS.grid);
    grid.position.y = this.groundY + 0.01;
    (grid.material as THREE.Material).opacity = 0.3;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);

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
        const mat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9, transparent: true, opacity: 1 });
        solidMats.push(mat);
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        box.position.set(cxw, cyw, czw);
        solid.add(box);
        appendBoxEdges(wirePos, cxw, cyw, czw, w, h, d);
      }
      const wireGeo = new THREE.BufferGeometry();
      wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
      const wireMat = new THREE.LineDashedMaterial({ color: COLORS.potential, transparent: true, opacity: 0.0, dashSize: 0.22, gapSize: 0.18 });
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

  /** Resolve a screen cursor (px) to a WORLD ground-plane aim angle (raw Fixed),
   *  relative to a world origin (the local player's x,z). Screen aim → world dir. */
  worldAimFrom(screenX: number, screenY: number, originX: number, originZ: number): number {
    const ndc = new THREE.Vector2((screenX / window.innerWidth) * 2 - 1, -(screenY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return 0;
    let ang = Math.atan2(hit.z - originZ, hit.x - originX); // world ground-plane angle
    if (ang < 0) ang += Math.PI * 2;
    return toRaw(fromRaw(Math.round((ang / (Math.PI * 2)) * toRaw(TWO_PI)))); // quantize like the wire
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
      let char: StubbyCharacter | null = null;
      if (isBody) {
        // a procedural STUBBY/CUTE body (docs/06 App-B Phase 1; ~1×1×1.25), crew-tinted,
        // role-shaped for silhouette readability — replaces the old capsule.
        char = new StubbyCharacter(w.role[id]!, baseColor, r, hh);
        obj = char.root;
        // gold beacon ring + ANCHOR label for the Anchor (always findable)
        if ((w.flags[id]! & BodyFlag.Anchor) !== 0) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.6, r * 1.9, 24), new THREE.MeshBasicMaterial({ color: COLORS.anchor, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
          ring.rotation.x = -Math.PI / 2; ring.position.y = -hh + 0.02; obj.add(ring);
          obj.add(this.makeLabel('ANCHOR', COLORS.anchor, hh + 0.9));
        }
      } else {
        // world objects (throwables) stay simple boxes, mass-tier colored.
        const mat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.5, emissive: 0x000000 });
        obj = new THREE.Mesh(new THREE.BoxGeometry(r * 2, hh * 2, r * 2), mat);
      }
      this.bodyGroup.add(obj);
      const x = toFloat(fromRaw(w.px[id]!)), y = toFloat(fromRaw(w.py[id]!)), z = toFloat(fromRaw(w.pz[id]!)), f = toFloat(fromRaw(w.facing[id]!));
      v = {
        obj, char, px: x, py: y, pz: z, ppx: x, ppy: y, ppz: z, pf: f, cf: f,
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
    const anchorY = anchorId >= 0 && anchorId < w.count ? toFloat(fromRaw(w.py[anchorId]!)) : 0;
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
      vv.obj.position.set(x, y, z);
      vv.obj.rotation.y = -lerpAngle(vv.pf, vv.cf, alpha);

      // held bodies pulse an emissive aura (identity preserved); a downed Anchor pulses red.
      const emissive = w.grabbedBy[id]! !== NO_ENTITY ? 0x442266
        : (w.flags[id]! & BodyFlag.Downed) !== 0 ? 0x551122 : 0x000000;
      if (vv.char) {
        // STUBBY CHARACTER: all deformation + limb posing driven from sim state.
        vv.char.update(this.sampleAnim(w, id, vv, emissive), dtMs / 1000);
      } else {
        // BOX (world object): the original speed-stretch + color/emissive path.
        this.applySquashStretch(w, id, vv, dtMs);
        const mat = (vv.obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
        mat.color.setHex(vv.baseColor = this.colorFor(w, id));
        mat.emissive.setHex(emissive);
      }

      // camera weighting: anchor 3.0, local 1.5, other players 1.0, objects 0
      let wt = 0;
      if (id === anchorId) wt = 3.0; else if (id === localId) wt = 1.5;
      else if ((w.flags[id]! & BodyFlag.Player) !== 0) wt = 1.0;
      if (wt > 0) { wsum += wt; cx += x * wt; cy += y * wt; cz += z * wt; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    }

    this.updateCoalescence(anchorY);
    this.updateImpactFx(nowMs);
    this.drawVerbFx(w, alpha, localId);
    this.updateCamera(w, wsum, cx, cy, cz, minX, maxX, minZ, maxZ);
    this.updateHud(w, anchorId);
    this.renderer.render(this.scene, this.camera);
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
    if (this.bands.length === 0) return;
    for (const band of this.bands) {
      const dist = band.baseY - anchorY; // >0 above the Anchor, <0 below
      if (dist >= -0.5) {
        // AT or ABOVE the crew → coalescence reveal
        const reveal = clamp01((REVEAL_RADIUS - dist) / REVEAL_FALLOFF);
        // wireframe fades OUT as reveal → 1; solid fades IN. The "potential" plan is
        // kept faint (0.4 ceiling) so stacked floors above never crowd the camera.
        (band.wire.material as THREE.LineDashedMaterial).opacity = (1 - reveal) * 0.4;
        band.wire.visible = reveal < 0.999;
        const lit = reveal * reveal; // ease-in the "earned warmth"
        const col = lerpHex(COLORS.wall, COLORS.lit, lit * 0.5); // warm sodium accent on resolve
        for (const m of band.solidMats) {
          m.opacity = 0.08 + 0.92 * reveal; // ghost → solid
          m.color.setHex(col);
          m.emissive.setHex(lerpHex(0x000000, COLORS.lit, lit * 0.35));
        }
        band.solid.visible = reveal > 0.02;
      } else {
        // BELOW the crew → persist, but desaturate + darken with depth (floored).
        band.wire.visible = false;
        const depth = clamp01(-dist / BELOW_DEPTH);
        const fade = 1 - 0.82 * depth; // value crush, floored ~0.18 (still readable)
        const col = lerpHex(COLORS.wall, 0x0a0a14, depth);
        band.solid.visible = true;
        for (const m of band.solidMats) {
          m.opacity = Math.max(0.5, fade);
          m.color.setHex(col);
          m.emissive.setHex(0x000000);
        }
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
      this.fxGroup.add(this.throwArc(posOf(localId), toFloat(fromRaw(w.facing[localId]!)), charge, w.massClass[w.holding[localId]!]! as MassClass));
    }
  }

  /** A dotted parabolic arc previewing where a held body would land at this charge. */
  private throwArc(from: THREE.Vector3, facing: number, charge: number, heldMass: MassClass): THREE.Object3D {
    const massV = [0.4, 1.0, 1.8, 3.2][heldMass] ?? 1.0;
    const j = toFloat(THROW_J) * Math.max(0.05, charge) * (1 / Math.sqrt(massV));
    const ang = toFloat(THROW_ANGLE_DEFAULT);
    const vx = j * Math.cos(ang) * Math.cos(facing), vz = j * Math.cos(ang) * Math.sin(facing), vy = j * Math.sin(ang);
    const g = 22, pts: THREE.Vector3[] = [];
    for (let t = 0; t <= 1.2; t += 0.06) {
      const py = from.y + vy * t - 0.5 * g * t * t;
      if (py < this.groundY && t > 0.1) break;
      pts.push(new THREE.Vector3(from.x + vx * t, py, from.z + vz * t));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const col = new THREE.Color(COLORS.arc).lerp(new THREE.Color(0xff5a6e), charge); // hotter = stronger
    return new THREE.Line(geo, new THREE.LineDashedMaterial({ color: col, dashSize: 0.25, gapSize: 0.2 })).computeLineDistances();
  }

  private updateCamera(_w: WorldState, wsum: number, cx: number, cy: number, cz: number, minX: number, maxX: number, minZ: number, maxZ: number): void {
    if (wsum <= 0) { this.renderer.render(this.scene, this.camera); return; }
    const target = new THREE.Vector3(cx / wsum, cy / wsum, cz / wsum);
    if (!this.camReady) { this.camTarget.copy(target); this.camReady = true; }
    // asymmetric smoothing: snappier when target rises (climb), looser when it drops
    const up = target.y > this.camTarget.y;
    this.camTarget.lerp(target, up ? 0.18 : 0.10);
    // spread-driven dolly: D_close 16 → D_far 30
    const extent = Math.max(maxX - minX, maxZ - minZ, 0);
    const wantDist = Math.min(30, 16 + extent * 0.9);
    this.camDist += (wantDist - this.camDist) * 0.08;
    // ~55° down-pitch: offset (0, D·sin55, D·cos55); frame target ~42% up by lowering lookAt
    const D = this.camDist;
    this.camera.position.set(this.camTarget.x, this.camTarget.y + D * 0.819, this.camTarget.z + D * 0.574);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + D * 0.12, this.camTarget.z);

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

  /** Top-center Anchor Status: HEIGHT (=score, COMMITTED), state word, health arc. */
  private updateHud(w: WorldState, anchorId: number): void {
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
      'hold <b>K</b> to grab &amp; <b>release</b> to throw, <b>E</b> for your role ability, <b>Q</b> to plant/recall.</span>';
    app.appendChild(onboard);
    this.onboard = onboard;
  }

  /** Crew identity colors (index = crewId). Crew 0 = the local crew (warm gold-blue). */
  private crewColor(crewId: number): number {
    return CREW_COLORS[crewId % CREW_COLORS.length]!;
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
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
function appendBoxEdges(out: number[], cx: number, cy: number, cz: number, w: number, h: number, d: number): void {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const yTop = cy + h / 2; // the walkable surface plane
  // four corners of the top face, in plan order
  const c = [[x0, yTop, z0], [x1, yTop, z0], [x1, yTop, z1], [x0, yTop, z1]];
  const E = [[0, 1], [1, 2], [2, 3], [3, 0]]; // just the rectangle outline
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
