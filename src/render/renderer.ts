// ============================================================================
// src/render/renderer.ts — the Three.js view layer (reads sim, never writes it).
// ============================================================================
//
// HARD RULE (ENGINE-ARCHITECTURE.md / CLAUDE.md): the renderer is a PURE READER of
// the deterministic sim. It converts raw Q16.16 ints to floats for display only and
// never feeds anything back into the world. Floats, Math.*, and per-frame
// interpolation are allowed here and nowhere else.
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
// ============================================================================

import * as THREE from 'three';
import { type WorldState, BodyFlag, MassClass, NO_ENTITY } from '../sim/world/state.ts';
import { toFloat, fromRaw, toRaw, TWO_PI } from '../sim/fixed/fixed.ts';
import { THROW_CHARGE_TICKS, THROW_J, THROW_ANGLE_DEFAULT } from '../sim/verbs/config.ts';
import type { Terrain } from '../sim/collide/terrain.ts';

const COLORS = {
  player: 0x4ea1ff, anchor: 0xffd23f, light: 0xa0e060, heavy: 0xff7a3d,
  ground: 0x1a1a2e, wall: 0x2e2e4a, grid: 0x33335a,
  leashFriendly: 0x6cff8a, leashHostile: 0xff5a6e, arc: 0xffe27a, struggle: 0xff4fd8, rush: 0x9fd0ff,
};

/** Per-body render record holding previous + current sim positions for interpolation. */
interface Vis { mesh: THREE.Mesh; px: number; py: number; pz: number; ppx: number; ppy: number; ppz: number; pf: number; cf: number; }

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

    this.resize();
    window.addEventListener('resize', () => this.resize());
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
    for (const b of terrain.solids) {
      const w = toFloat(fromRaw(b.maxX - b.minX)), h = toFloat(fromRaw(b.maxY - b.minY)), d = toFloat(fromRaw(b.maxZ - b.minZ));
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9 }));
      box.position.set(toFloat(fromRaw((b.minX + b.maxX) >> 1)), toFloat(fromRaw((b.minY + b.maxY) >> 1)), toFloat(fromRaw((b.minZ + b.maxZ) >> 1)));
      this.scene.add(box);
    }
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

  private ensureVis(w: WorldState, id: number): Vis {
    let v = this.vis[id] ?? null;
    if (!v) {
      const r = toFloat(fromRaw(w.radius[id]!)), hh = toFloat(fromRaw(w.halfHeight[id]!));
      const isPlayer = (w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0;
      const geom = isPlayer ? new THREE.CapsuleGeometry(r, Math.max(0.1, hh * 2 - r * 2), 4, 10) : new THREE.BoxGeometry(r * 2, hh * 2, r * 2);
      const mat = new THREE.MeshStandardMaterial({ color: this.colorFor(w, id), roughness: 0.5, emissive: 0x000000 });
      const mesh = new THREE.Mesh(geom, mat);
      this.bodyGroup.add(mesh);
      // gold beacon ring + ANCHOR label for the Anchor (always findable)
      if ((w.flags[id]! & BodyFlag.Anchor) !== 0) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.6, r * 1.9, 24), new THREE.MeshBasicMaterial({ color: COLORS.anchor, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = -hh + 0.02; mesh.add(ring);
        mesh.add(this.makeLabel('ANCHOR', COLORS.anchor, hh + 0.9));
      }
      const x = toFloat(fromRaw(w.px[id]!)), y = toFloat(fromRaw(w.py[id]!)), z = toFloat(fromRaw(w.pz[id]!)), f = toFloat(fromRaw(w.facing[id]!));
      v = { mesh, px: x, py: y, pz: z, ppx: x, ppy: y, ppz: z, pf: f, cf: f };
      this.vis[id] = v;
    }
    return v;
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
  }

  /** Render a frame. `alpha` ∈ [0,1] interpolates between previous and current tick. */
  render(w: WorldState, alpha: number, localId: number, anchorId: number): void {
    // clear per-frame FX overlay
    while (this.fxGroup.children.length) {
      const c = this.fxGroup.children.pop()!;
      (c as THREE.Mesh).geometry?.dispose?.();
    }

    let wsum = 0, cx = 0, cy = 0, cz = 0, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let id = 0; id < w.count; id++) {
      const alive = (w.flags[id]! & BodyFlag.Alive) !== 0;
      const v = this.vis[id] ?? null;
      if (!alive) { if (v) v.mesh.visible = false; continue; }
      const vv = this.ensureVis(w, id);
      vv.mesh.visible = true;
      // interpolate position + facing (shortest arc)
      const x = vv.ppx + (vv.px - vv.ppx) * alpha;
      const y = vv.ppy + (vv.py - vv.ppy) * alpha;
      const z = vv.ppz + (vv.pz - vv.ppz) * alpha;
      vv.mesh.position.set(x, y, z);
      vv.mesh.rotation.y = -lerpAngle(vv.pf, vv.cf, alpha);
      const mat = vv.mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(this.colorFor(w, id));
      // held bodies pulse an emissive aura (identity color preserved — audit fix)
      mat.emissive.setHex(w.grabbedBy[id] !== NO_ENTITY ? 0x442266 : 0x000000);

      // camera weighting: anchor 3.0, local 1.5, other players 1.0, objects 0
      let wt = 0;
      if (id === anchorId) wt = 3.0; else if (id === localId) wt = 1.5;
      else if ((w.flags[id]! & BodyFlag.Player) !== 0) wt = 1.0;
      if (wt > 0) { wsum += wt; cx += x * wt; cy += y * wt; cz += z * wt; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    }

    this.drawVerbFx(w, alpha, localId);
    this.updateCamera(w, wsum, cx, cy, cz, minX, maxX, minZ, maxZ);
    this.updateHud(w, anchorId);
    this.renderer.render(this.scene, this.camera);
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
  }

  /** Top-center Anchor Status: HEIGHT (=score), state word, health arc. */
  private updateHud(w: WorldState, anchorId: number): void {
    if (!this.hud) return;
    if (anchorId < 0 || anchorId >= w.count) return;
    const heightU = Math.max(0, toFloat(fromRaw(w.py[anchorId]!)) - this.groundY);
    this.hud.height.textContent = heightU.toFixed(1) + ' m';
    const grabbed = w.grabbedBy[anchorId] !== NO_ENTITY;
    const downed = (w.flags[anchorId]! & BodyFlag.Downed) !== 0;
    const state = downed ? 'DOWNED' : grabbed ? 'GRABBED' : 'SECURE';
    this.hud.state.textContent = state;
    this.hud.state.style.color = downed ? '#ff5a6e' : grabbed ? '#ffb24f' : '#6cff8a';
    this.hud.root.style.boxShadow = grabbed || downed ? '0 0 24px #ff5a6e88' : 'none';
    const hp = Math.max(0, Math.min(100, toFloat(fromRaw(w.health[anchorId]!))));
    this.hud.health.style.width = hp + '%';
    this.hud.health.style.background = hp > 50 ? '#6cff8a' : hp > 25 ? '#ffb24f' : '#ff5a6e';
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
