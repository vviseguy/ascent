// ============================================================================
// fern-shrub — a broadleaf fern of arched fronds that PART when pushed through.
// ============================================================================
//
// Reactive flora #2. 4–7 arched fronds, each a curved rachis (stem) carrying
// pairs of tapered leaflets. EVERYTHING — stem segments, leaflets, tip leaf —
// is an instance of ONE creased-leaf geometry in ONE InstancedMesh, so the
// whole plant is a single draw call (+ a root knob + a moss disc).
//
// Look decisions (art-directed):
//  - The rachis is integrated as a polyline whose pitch starts steep (~65°)
//    and "uncurls" toward/below horizontal at the tip → the classic fern arch.
//  - Leaflet length follows a sine profile along the frond (small at base,
//    widest mid-frond, vanishing at the tip) with a slight downward tip droop
//    baked into the leaf geometry.
//  - Base→edge vertex gradient × per-frond muted moss green (hue/light jitter
//    per frond, slightly brighter toward the frond tip) keeps it harmonized
//    with the indigo-night palette — desaturated, never neon.
//
// REACTIVITY (the soul): update(time, actors) gives each frond a smoothed
// dip (pressed down/away) and a yaw part (swings sideways away from the
// actor), both applied PROGRESSIVELY along the rachis (the root stays
// anchored, the tip moves most) — fronds part naturally and spring back
// (fast attack, slow release), plus gentle ambient wind sway.
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const STEM_STEPS = 12; // rachis integration segments (also stem instances)
const PAIRS = 12; // leaflet pairs per frond
const PUSH_R = 1.15; // actor reach against each frond's resting mid-point
const CORE_R = 0.7; // actor this close to the root pushes ALL fronds down/out

interface Frond {
  yaw0: number; // resting horizontal direction
  len: number; // total rachis length
  pitch0: number; // starting pitch (rad above horizontal)
  curl: number; // total pitch lost root→tip (arch-over amount)
  phase: number; // wind phase
  color: THREE.Color; // muted moss green, per frond
  dip: number; // smoothed reactive dip (rad)
  part: number; // smoothed reactive yaw-away (rad)
  midX: number; midZ: number; // RESTING mid-point (fixed → no push feedback loop)
}

/** Unit leaflet: base at origin, length 1 along +x, width on z, gentle
 *  center crease (edges folded down) and a drooping tip. Doubles as the
 *  stem-segment geometry when scaled long and thin. */
function makeLeafletGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(1, 0.34, 4, 2);
  geo.translate(0.5, 0, 0); // base at origin
  const pos = geo.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const HALF_W = 0.17;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i); // 0 base → 1 tip
    const y = pos.getY(i);
    // leaf outline: narrow base, widest ~40% out, pointed tip
    const w = Math.sin((0.18 + 0.82 * t) * Math.PI);
    pos.setY(i, y * Math.max(0.04, w));
    const edge = Math.abs(y) / HALF_W; // 0 at crease → 1 at edge
    // slight V-crease (edges up, catches rim light) + tip drooping DOWN.
    // NOTE rotateX(-π/2) below maps local +z → world +y, so up = +z here.
    pos.setZ(i, pos.getZ(i) + edge * 0.03 - t * t * 0.1);
    // base→tip gradient: dark attachment → brighter, slightly warm edge/tip
    const k = Math.pow(t, 0.9) * 0.8 + edge * 0.2;
    colors[i * 3] = 0.34 + 0.66 * k;
    colors[i * 3 + 1] = 0.40 + 0.60 * k;
    colors[i * 3 + 2] = 0.30 + 0.46 * k;
  }
  geo.rotateX(-Math.PI / 2); // lay flat: width→z, fold/droop→ -y (downward)
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Soft dark-moss radial-gradient disc (same grounding trick as grass-clump). */
function makeMossDisc(radius: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
  g.addColorStop(0, 'rgba(24, 32, 19, 0.85)');
  g.addColorStop(0.55, 'rgba(23, 30, 19, 0.5)');
  g.addColorStop(1, 'rgba(22, 28, 19, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.012;
  return disc;
}

const fernShrub: LabElement = {
  name: 'Fern shrub',
  describe: 'Arched leaflet fronds that dip & part when a player pushes through, then spring back.',
  build(seed: number) {
    const rnd = mulberry32(seed * 9176 + 3);

    const outerN = 5 + Math.floor(rnd() * 3); // 5–7 full arched fronds
    const frondN = outerN + 2; // + 2 young upright fronds filling the crown
    const fronds: Frond[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    let maxLen = 0;
    for (let i = 0; i < frondN; i++) {
      const young = i >= outerN;
      const len = young ? 0.45 + rnd() * 0.18 : 0.9 + rnd() * 0.45;
      if (!young) maxLen = Math.max(maxLen, len);
      const c = new THREE.Color();
      // muted moss per frond; young center fronds slightly brighter/yellower
      c.setHSL(
        0.24 + rnd() * 0.09 + (young ? -0.02 : 0),
        0.3 + rnd() * 0.14,
        0.3 + rnd() * 0.12 + (young ? 0.06 : 0),
      );
      const fr: Frond = {
        yaw0: i * golden + rnd() * 0.7,
        len,
        pitch0: young ? 1.25 + rnd() * 0.15 : 0.92 + rnd() * 0.22,
        curl: young ? 0.75 + rnd() * 0.3 : 1.25 + rnd() * 0.4, // arch-over
        phase: rnd() * Math.PI * 2,
        color: c,
        dip: 0,
        part: 0,
        midX: 0, midZ: 0,
      };
      // resting mid-point (~55% along the rachis, no dip/part/wind): the
      // FIXED anchor for actor-proximity tests, so a parting frond doesn't
      // "escape" its own trigger zone and oscillate.
      {
        const segLen = fr.len / STEM_STEPS;
        let mx = 0, mz = 0;
        for (let s2 = 0; s2 <= Math.floor(STEM_STEPS * 0.55); s2++) {
          const pitch = fr.pitch0 - fr.curl * (s2 / (STEM_STEPS - 1));
          mx += Math.cos(pitch) * Math.cos(fr.yaw0) * segLen;
          mz += Math.cos(pitch) * Math.sin(fr.yaw0) * segLen;
        }
        fr.midX = mx; fr.midZ = mz;
      }
      fronds.push(fr);
    }

    const perFrond = STEM_STEPS + PAIRS * 2 + 1; // stems + leaflet pairs + tip
    const COUNT = frondN * perFrond;
    const geo = makeLeafletGeometry();
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
      roughness: 0.85,
      vertexColors: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // per-instance colors are static: frond color, brighter toward the tip,
    // stems darker/browner — set once here, posed every frame in update().
    const cTmp = new THREE.Color();
    for (let f = 0; f < frondN; f++) {
      const fr = fronds[f]!;
      let idx = f * perFrond;
      for (let s2 = 0; s2 < STEM_STEPS; s2++) {
        cTmp.copy(fr.color).multiplyScalar(0.45).lerp(new THREE.Color(0x4f4326), 0.5);
        mesh.setColorAt(idx++, cTmp);
      }
      for (let p = 0; p < PAIRS; p++) {
        const t = (p + 1) / (PAIRS + 1);
        cTmp.copy(fr.color).multiplyScalar(0.72 + t * 0.55); // brighter at tip
        mesh.setColorAt(idx++, cTmp);
        mesh.setColorAt(idx++, cTmp);
      }
      cTmp.copy(fr.color).multiplyScalar(1.3);
      mesh.setColorAt(idx++, cTmp);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qy = new THREE.Quaternion();
    const qp = new THREE.Quaternion();
    const qr = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    const X = new THREE.Vector3(1, 0, 0);

    /** Pose one frond's instances from its current dip/part/wind state. */
    const poseFrond = (f: number, timeSec: number): void => {
      const fr = fronds[f]!;
      const wind = Math.sin(timeSec * 1.25 + fr.phase) * 0.045 + Math.sin(timeSec * 0.5 + fr.phase * 2.1) * 0.03;
      const segLen = fr.len / STEM_STEPS;
      let px = 0, py = 0.1, pz = 0;
      let idx = f * perFrond;
      const leafBase = f * perFrond + STEM_STEPS;
      let pairsPlaced = 0;
      for (let s2 = 0; s2 < STEM_STEPS; s2++) {
        const t = s2 / (STEM_STEPS - 1);
        // progressive: root anchored, tip moves most
        const prog = Math.pow(t, 1.4);
        const pitch = fr.pitch0 - fr.curl * t - (fr.dip + wind) * prog * 1.25;
        const yawNow = fr.yaw0 + (fr.part + wind * 0.5) * prog * 1.9;
        // orient unit +x along (pitch, yaw)
        qy.setFromAxisAngle(Y, -yawNow);
        qp.setFromAxisAngle(Z, pitch);
        q.copy(qy).multiply(qp);
        // stem segment instance (long + thin)
        m.compose(pos.set(px, py, pz), q, scl.set(segLen * 1.12, 1, 0.045));
        mesh.setMatrixAt(idx++, m);

        // leaflet pair stations sit between stem steps
        const tNext = (s2 + 1) / STEM_STEPS;
        while (pairsPlaced < PAIRS && (pairsPlaced + 1) / (PAIRS + 1) <= tNext) {
          const lt = (pairsPlaced + 1) / (PAIRS + 1);
          // length profile: small base → widest mid-frond → gone at tip
          const lp = Math.sin((0.12 + 0.88 * lt) * Math.PI);
          const leafLen = fr.len * 0.26 * (0.3 + 0.7 * lp);
          for (const side of [-1, 1]) {
            // sweep leaflets FORWARD along the frond (≈52°), not perpendicular,
            // and let their pitch follow the rachis so the frond reads as one
            // feathered plane instead of stacked shelves.
            qy.setFromAxisAngle(Y, -(yawNow + side * (0.9 + wind * 2)));
            qp.setFromAxisAngle(Z, Math.max(-0.6, pitch * 0.55 + 0.06 - fr.dip * prog * 0.5));
            qr.setFromAxisAngle(X, side * 0.22); // slight roll toward the light
            q.copy(qy).multiply(qp).multiply(qr);
            m.compose(pos.set(px, py, pz), q, scl.set(leafLen, 1, leafLen * 0.7));
            mesh.setMatrixAt(leafBase + pairsPlaced * 2 + (side < 0 ? 0 : 1), m);
          }
          pairsPlaced++;
        }

        px += Math.cos(pitch) * Math.cos(yawNow) * segLen;
        py += Math.sin(pitch) * segLen;
        pz += Math.cos(pitch) * Math.sin(yawNow) * segLen;
      }
      // tip leaflet, along the final heading
      const tipPitch = fr.pitch0 - fr.curl - (fr.dip + wind) * 1.25;
      const tipYaw = fr.yaw0 + (fr.part + wind * 0.5) * 1.9;
      qy.setFromAxisAngle(Y, -tipYaw);
      qp.setFromAxisAngle(Z, tipPitch);
      q.copy(qy).multiply(qp);
      const tipLen = fr.len * 0.2;
      m.compose(pos.set(px, py, pz), q, scl.set(tipLen, 1, tipLen * 0.7));
      mesh.setMatrixAt(f * perFrond + perFrond - 1, m);
    };

    const update = (timeSec: number, actors: readonly THREE.Vector3[]): void => {
      for (let f = 0; f < frondN; f++) {
        const fr = fronds[f]!;
        let dipT = 0, partT = 0;
        for (const a of actors) {
          if (Math.abs(a.y) > 1.6) continue;
          // proximity to this frond's mid-point → dip + yaw-away
          const dx = fr.midX - a.x, dz = fr.midZ - a.z;
          const d = Math.hypot(dx, dz);
          if (d < PUSH_R && d > 1e-4) {
            const s = (1 - d / PUSH_R) ** 2;
            dipT += s * 0.85;
            // part toward whichever side of the frond the push lands on —
            // the lateral swing is what sells "pushing through foliage"
            const awayAng = Math.atan2(dz, dx);
            let delta = awayAng - fr.yaw0;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            partT += Math.sign(delta) * s * 1.1;
          }
          // actor over the root crown presses every frond down & outward
          const dc = Math.hypot(a.x, a.z);
          if (dc < CORE_R) dipT += (1 - dc / CORE_R) ** 2 * 0.8;
        }
        // fast attack, slow release springs
        const kD = dipT > fr.dip ? 0.4 : 0.07;
        const kP = Math.abs(partT) > 1e-4 ? 0.4 : 0.07;
        fr.dip += (Math.min(1.2, dipT) - fr.dip) * kD;
        fr.part += (Math.max(-1.0, Math.min(1.0, partT)) - fr.part) * kP;
        poseFrond(f, timeSec);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    const root = new THREE.Group();
    root.add(makeMossDisc(maxLen * 0.95));
    root.add(mesh);

    // root crown knob hides the converging stem bases
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshStandardMaterial({ color: 0x33321f, roughness: 1 }),
    );
    knob.scale.y = 0.7;
    knob.castShadow = true;
    root.add(knob);

    // settle springs/wind so the static (no-actor) pose is the resting pose
    update(0, []);
    return { root, update, radius: maxLen + 0.35 };
  },
};

export default fernShrub;
