// ============================================================================
// grass-clump — instanced 3D grass that BENDS when players move through it.
// ============================================================================
//
// The reference "reactive decoration" element. One InstancedMesh (~420 blades,
// one draw call) + one instanced stone cluster + a soft moss ground disc.
//
// Look decisions (art-directed, don't revert casually):
//  - Each blade is a 6-segment plane with a progressive BOW baked into the
//    geometry (z += t^1.9) so blades read as curved grass, not straight spikes.
//    The bow direction is yawed mostly OUTWARD from the clump center → a
//    natural fountain silhouette.
//  - Root→tip vertex-color gradient (dark desaturated base → brighter, warmer
//    tip) MULTIPLIES the per-instance mossy green, so the clump interior reads
//    dark and dense while tips catch light. Palette stays muted (docs/06):
//    desaturated moss, never neon.
//  - Density is center-weighted and height falls off toward the fringe
//    (dome silhouette), with rare taller seed-stalks for variety.
// Each frame, update(time, actors):
//  - ambient wind sway (per-blade phase), plus
//  - a push-away bend for any actor within reach (falls off with distance,
//    fast attack / slow release spring = natural part + spring-back).
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const BLADES = 420;
const CLUMP_R = 1.5;
const PUSH_R = 1.05; // an actor inside this radius bends blades away
const SEGS = 6; // height segments per blade (enough for a smooth bow)

/** Unit-height tapered blade, bowed progressively toward +z, with a
 *  root→tip color gradient baked into vertex colors. */
function makeBladeGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(0.062, 1, 1, SEGS);
  geo.translate(0, 0.5, 0); // pivot at the base
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const base = { r: 0.17, g: 0.21, b: 0.15 }; // dark, slightly desaturated root
  const tip = { r: 1.0, g: 1.0, b: 0.74 }; // bright, faintly warm tip
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i); // 0 at root → 1 at tip
    // taper to a near-point (slightly convex sides → blade, not triangle)
    pos.setX(i, pos.getX(i) * Math.max(0.06, Math.pow(1 - t, 0.72)));
    // progressive bow: the blade arches over with height
    pos.setZ(i, pos.getZ(i) + 0.32 * Math.pow(t, 1.9));
    const k = Math.pow(t, 0.85); // keep the lower half dark
    colors[i * 3] = base.r + (tip.r - base.r) * k;
    colors[i * 3 + 1] = base.g + (tip.g - base.g) * k;
    colors[i * 3 + 2] = base.b + (tip.b - base.b) * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Soft dark-moss radial-gradient disc that grounds the clump on any floor. */
function makeMossDisc(radius: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
  g.addColorStop(0, 'rgba(26, 34, 20, 0.85)');
  g.addColorStop(0.55, 'rgba(24, 31, 20, 0.55)');
  g.addColorStop(1, 'rgba(22, 28, 20, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.012;
  disc.receiveShadow = false;
  return disc;
}

const grassClump: LabElement = {
  name: 'Grass clump',
  describe: 'Instanced reactive grass — curved blades bend away from players moving through, spring back after.',
  build(seed: number) {
    const rnd = mulberry32(seed * 31337 + 5);

    const geo = makeBladeGeometry();
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      roughness: 0.88,
      color: 0xffffff,
      vertexColors: true, // root→tip gradient × per-instance green
    });
    const mesh = new THREE.InstancedMesh(geo, mat, BLADES);
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // per-blade state (base position, yaw, scales, wind phase, current bend)
    const baseX = new Float32Array(BLADES), baseZ = new Float32Array(BLADES);
    const yaw = new Float32Array(BLADES);
    const scaleY = new Float32Array(BLADES), scaleZ = new Float32Array(BLADES);
    const phase = new Float32Array(BLADES);
    const bendX = new Float32Array(BLADES), bendZ = new Float32Array(BLADES); // smoothed bend vector
    const color = new THREE.Color();
    for (let i = 0; i < BLADES; i++) {
      // center-weighted spread (pow < 0.5·2 → denser core than disc-uniform)
      const u = rnd();
      const r = Math.pow(u, 0.68) * CLUMP_R;
      const a = rnd() * Math.PI * 2;
      baseX[i] = Math.cos(a) * r;
      baseZ[i] = Math.sin(a) * r;
      // bow mostly OUTWARD from center (fountain), with plenty of jitter
      yaw[i] = -a + (rnd() - 0.5) * 2.4;
      // dome profile: tall center, short fringe; rare taller seed-stalks
      const dome = 1 - 0.42 * Math.pow(r / CLUMP_R, 1.6);
      let h = (0.3 + rnd() * 0.52) * dome;
      if (rnd() < 0.06) h *= 1.55;
      scaleY[i] = h;
      // bow depth scales with height (+ variety) so short blades aren't hooks
      scaleZ[i] = h * (0.55 + rnd() * 0.95);
      phase[i] = rnd() * Math.PI * 2;
      // muted mossy greens — desaturated, mid-dark; gradient supplies the pop
      color.setHSL(0.26 + rnd() * 0.07, 0.32 + rnd() * 0.14, 0.34 + rnd() * 0.16);
      mesh.setColorAt(i, color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const tmp = new THREE.Vector3();

    const update = (timeSec: number, actors: readonly THREE.Vector3[]): void => {
      for (let i = 0; i < BLADES; i++) {
        // ambient wind: small sway in a fixed per-blade direction
        const sway = Math.sin(timeSec * 1.7 + phase[i]!) * 0.06 + Math.sin(timeSec * 0.43 + phase[i]! * 1.7) * 0.035;
        // actor push: sum of pushes from actors in range, away from each actor
        let pushX = 0, pushZ = 0;
        for (const a of actors) {
          const dx = baseX[i]! - a.x;
          const dz = baseZ[i]! - a.z;
          const d = Math.hypot(dx, dz);
          if (d < PUSH_R && d > 1e-4 && Math.abs(a.y) < 1.4) {
            const s = (1 - d / PUSH_R) ** 2 * 1.35; // radians of bend at center
            pushX += (dx / d) * s;
            pushZ += (dz / d) * s;
          }
        }
        // spring toward the target bend (fast attack, slower release = springy feel)
        const k = (Math.abs(pushX) + Math.abs(pushZ)) > 1e-4 ? 0.45 : 0.08;
        bendX[i] = bendX[i]! + (pushX - bendX[i]!) * k;
        bendZ[i] = bendZ[i]! + (pushZ - bendZ[i]!) * k;

        const bx = bendX[i]! + sway * 0.4;
        const bz = bendZ[i]! + sway;
        const mag = Math.min(1.45, Math.hypot(bx, bz));
        // bend = rotate around the horizontal axis PERPENDICULAR to the bend dir
        if (mag > 1e-4) {
          axis.set(bz / (mag || 1), 0, -bx / (mag || 1));
          q.setFromAxisAngle(axis, mag);
        } else {
          q.identity();
        }
        qYaw.setFromAxisAngle(tmp.set(0, 1, 0), yaw[i]!);
        q.multiply(qYaw);
        scl.set(1, scaleY[i]!, scaleZ[i]!);
        m.compose(tmp.set(baseX[i]!, 0, baseZ[i]!), q, scl);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    const root = new THREE.Group();
    root.add(makeMossDisc(CLUMP_R * 1.18));
    root.add(mesh);

    // a few small stones nestled in the clump ground the composition (1 draw call)
    const STONES = 5;
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x555a66, roughness: 0.95 });
    const stones = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), stoneMat, STONES);
    stones.castShadow = stones.receiveShadow = true;
    for (let i = 0; i < STONES; i++) {
      const s = 0.07 + rnd() * 0.11;
      const a = rnd() * Math.PI * 2, r = (0.25 + rnd() * 0.65) * CLUMP_R;
      q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
      m.compose(tmp.set(Math.cos(a) * r, s * 0.35, Math.sin(a) * r), q, scl.set(s, s * 0.8, s));
      stones.setMatrixAt(i, m);
    }
    root.add(stones);

    update(0, []);
    return { root, update, radius: CLUMP_R + 0.55 };
  },
};

export default grassClump;
