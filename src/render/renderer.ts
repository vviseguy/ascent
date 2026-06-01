// ============================================================================
// src/render/renderer.ts — the Three.js view layer (reads sim, never writes it).
// ============================================================================
//
// HARD RULE (ENGINE-ARCHITECTURE.md / CLAUDE.md): the renderer is a PURE READER of
// the deterministic sim. It converts raw Q16.16 ints to floats *for display only*
// (toFloat) and never feeds anything back into the world. Nothing here is part of
// the simulation, so none of it threatens determinism — this is the one place
// floats, Math.*, and per-frame interpolation are allowed.
//
// SCOPE: a clean, readable first renderer for the integrated sim — a slight-tilt
// three-quarter camera (Hades-style, Pillar 7) that frames the body centroid, a
// ground arena, and instanced body meshes colored by role/kind for instant
// readability. The coalescence/fog spectacle (06-art-direction-shaders.md) layers
// on later; this is the honest, working base it builds upon.
// ============================================================================

import * as THREE from 'three';
import { type WorldState, BodyFlag, MassClass } from '../sim/world/state.ts';
import { toFloat, fromRaw } from '../sim/fixed/fixed.ts';
import type { Terrain } from '../sim/collide/terrain.ts';

/** Color language for instant readability (Pillar: silhouette + color). */
const COLORS = {
  player: 0x4ea1ff, // cool blue — a regular crew member
  anchor: 0xffd23f, // gold — the precious VIP (always findable)
  light: 0xa0e060, // green — light throwable
  heavy: 0xff7a3d, // orange — heavy throwable
  held: 0xff4fd8, // magenta tint — something being carried
  ground: 0x1a1a2e,
  wall: 0x2e2e4a,
  grid: 0x33335a,
};

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  /** One mesh per body id (created lazily; hidden when a slot is dead). */
  private bodyMeshes: (THREE.Mesh | null)[] = [];
  private readonly bodyGroup = new THREE.Group();
  /** Smoothed camera target (the body centroid), for gentle follow. */
  private camTarget = new THREE.Vector3(0, 0, 0);
  private camReady = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0a0a12);
    this.scene.fog = new THREE.Fog(0x0a0a12, 28, 60); // depth haze (cheap; full volumetric later)

    // slight-tilt three-quarter camera (Pillar 7)
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 18, 16);
    this.camera.lookAt(0, 0, 0);

    // lighting: a key directional + soft ambient for readable forms
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(8, 20, 10);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0x6677aa, 0.6));
    this.scene.add(this.bodyGroup);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Build static scenery from the terrain (ground + a grid + wall boxes). */
  buildTerrain(terrain: Terrain): void {
    const groundY = toFloat(fromRaw(terrain.groundY));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 48),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = groundY;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(48, 24, COLORS.grid, COLORS.grid);
    grid.position.y = groundY + 0.01;
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);

    for (const b of terrain.solids) {
      const w = toFloat(fromRaw(b.maxX - b.minX));
      const h = toFloat(fromRaw(b.maxY - b.minY));
      const d = toFloat(fromRaw(b.maxZ - b.minZ));
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9 }),
      );
      box.position.set(
        toFloat(fromRaw((b.minX + b.maxX) >> 1)),
        toFloat(fromRaw((b.minY + b.maxY) >> 1)),
        toFloat(fromRaw((b.minZ + b.maxZ) >> 1)),
      );
      this.scene.add(box);
    }
  }

  /** Pick a body's display color from its flags/class. */
  private colorFor(w: WorldState, id: number): number {
    if ((w.flags[id]! & BodyFlag.Anchor) !== 0) return COLORS.anchor;
    if (w.grabbedBy[id] !== -1) return COLORS.held;
    if ((w.flags[id]! & BodyFlag.Player) !== 0) return COLORS.player;
    return w.massClass[id] === MassClass.Heavy ? COLORS.heavy : COLORS.light;
  }

  /** Lazily create a capsule-ish mesh for a body. */
  private ensureMesh(w: WorldState, id: number): THREE.Mesh {
    let m = this.bodyMeshes[id] ?? null;
    if (!m) {
      const r = toFloat(fromRaw(w.radius[id]!));
      const hh = toFloat(fromRaw(w.halfHeight[id]!));
      const geom =
        (w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0
          ? new THREE.CapsuleGeometry(r, Math.max(0.1, hh * 2 - r * 2), 4, 8)
          : new THREE.BoxGeometry(r * 2, hh * 2, r * 2);
      m = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: this.colorFor(w, id), roughness: 0.5 }));
      this.bodyMeshes[id] = m;
      this.bodyGroup.add(m);
    }
    return m;
  }

  /**
   * Render one frame from the current sim state. `alpha` is the optional [0,1]
   * interpolation factor between the previous and current tick (visual smoothing
   * only — never fed back). For now we render the authoritative positions directly;
   * interpolation hooks are left for the netcode pass.
   */
  render(w: WorldState): void {
    let cx = 0, cz = 0, cy = 0, n = 0;
    for (let id = 0; id < w.count; id++) {
      const alive = (w.flags[id]! & BodyFlag.Alive) !== 0;
      const existing = this.bodyMeshes[id] ?? null;
      if (!alive) {
        if (existing) existing.visible = false;
        continue;
      }
      const m = this.ensureMesh(w, id);
      m.visible = true;
      const x = toFloat(fromRaw(w.px[id]!));
      const y = toFloat(fromRaw(w.py[id]!));
      const z = toFloat(fromRaw(w.pz[id]!));
      m.position.set(x, y, z);
      m.rotation.y = -toFloat(fromRaw(w.facing[id]!));
      (m.material as THREE.MeshStandardMaterial).color.setHex(this.colorFor(w, id));
      // centroid (players + anchor frame the camera)
      if ((w.flags[id]! & (BodyFlag.Player | BodyFlag.Anchor)) !== 0) {
        cx += x; cy += y; cz += z; n++;
      }
    }

    // gentle camera follow of the crew centroid
    if (n > 0) {
      const target = new THREE.Vector3(cx / n, cy / n, cz / n);
      if (!this.camReady) { this.camTarget.copy(target); this.camReady = true; }
      this.camTarget.lerp(target, 0.08);
      this.camera.position.set(this.camTarget.x, this.camTarget.y + 18, this.camTarget.z + 16);
      this.camera.lookAt(this.camTarget.x, this.camTarget.y, this.camTarget.z);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
