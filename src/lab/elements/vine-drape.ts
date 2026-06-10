// ============================================================================
// vine-drape — reactive hanging ivy strands for lintels & stair-hole edges.
// ============================================================================
//
// 8–9 leafy strands hang from a dark mounting bar (a 2.5u lintel at y≈3), plus
// one sagging garland swag up near the bar. Each hanging strand is a length-
// preserving chain rebuilt every frame from (rest shape + smoothed push offsets
// + ambient sway), so strands PART around an actor moving through and swing
// back like pendulums:
//   - per-call attack lerp (house pattern, frozen-snapshot safe) gives the
//     instant parting, and
//   - an underdamped dt-integrated spring gives live swing-past-and-settle.
//
// 2 draw calls: one box InstancedMesh (bar + brackets + stem segments + rare
// amber buds, colored per-instance) and one alpha-tested leaf InstancedMesh
// (canvas-painted ivy leaf, per-instance muted green→indigo tints).
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const BAR_Y = 3.0; // lintel height (u)
const BAR_W = 2.5; // lintel width (u)
const PUSH_R = 1.1; // horizontal reach of an actor's push (u)
const PUSH_S = 1.55; // max horizontal push offset at the actor's center (u)
const SPRING_K = 26; // underdamped spring → pendulum swing-back…
const SPRING_C = 3.4; // …with gentle damping so it settles in ~2s

interface Strand {
  rest: THREE.Vector3[]; // rest node positions (local space, node 0 = anchor)
  cur: THREE.Vector3[]; // current node positions (rebuilt per frame)
  restDir: THREE.Vector3[]; // rest unit dir into node j (from node j-1)
  segLen: number[]; // length of segment j (node j → j+1)
  ox: Float32Array; // smoothed push offset per node (x)
  oz: Float32Array;
  vx: Float32Array; // spring velocity per node
  vz: Float32Array;
  phase: number; // ambient sway phase
  reactive: boolean; // swags near the bar are ambient-only
}

interface LeafRef { strand: number; node: number; qRest: THREE.Quaternion; size: number }
interface StemRef { strand: number; node: number; thick: number } // segment node→node+1
interface BudRef { strand: number; node: number }

/** Paint one stylized pointed ivy leaf (alpha-cut card, neutral light green so
 *  per-instance colors drive the final hue). */
function makeLeafTexture(): THREE.CanvasTexture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);

  // ivy silhouette: pointed central lobe + two side lobes (reads as ivy even
  // at ~15px on screen — an oval just reads as confetti)
  const body = new Path2D();
  body.moveTo(32, 61); // stem base
  body.bezierCurveTo(20, 56, 10, 52, 6, 42); // into left lobe
  body.bezierCurveTo(2, 32, 12, 28, 18, 30); // left lobe tip & notch
  body.bezierCurveTo(14, 20, 22, 8, 32, 3); // up to the central point
  body.bezierCurveTo(42, 8, 50, 20, 46, 30); // down the right side
  body.bezierCurveTo(52, 28, 62, 32, 58, 42); // right lobe
  body.bezierCurveTo(54, 52, 44, 56, 32, 61); // back to base
  const g = ctx.createLinearGradient(0, 61, 0, 3);
  g.addColorStop(0, 'rgb(152,170,132)');
  g.addColorStop(0.55, 'rgb(198,212,176)');
  g.addColorStop(1, 'rgb(174,192,156)');
  ctx.fillStyle = g;
  ctx.fill(body);

  // soft darker rim so cards read as individual leaves when overlapping
  ctx.strokeStyle = 'rgba(74,92,62,0.6)';
  ctx.lineWidth = 2.5;
  ctx.stroke(body);

  // central vein + a few side veins, subtle
  ctx.strokeStyle = 'rgba(92,112,76,0.5)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(32, 58); ctx.lineTo(32, 8);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(92,112,76,0.32)';
  for (const [y0, y1] of [[50, 40], [40, 28], [30, 16]] as const) {
    ctx.beginPath(); ctx.moveTo(32, y0); ctx.lineTo(12, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(32, y0); ctx.lineTo(52, y1); ctx.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

const vineDrape: LabElement = {
  name: 'Vine drape',
  describe: 'Hanging ivy for lintels & stair-hole edges — sways, parts around players, swings back.',
  build(seed: number) {
    const rnd = mulberry32(seed * 92821 + 7);

    const strands: Strand[] = [];
    const leaves: LeafRef[] = [];
    const stems: StemRef[] = [];
    const buds: BudRef[] = [];

    const addLeaf = (s: number, node: number, yaw: number, droop: number, roll: number, size: number): void => {
      const qRest = new THREE.Quaternion().setFromEuler(new THREE.Euler(-droop, yaw, roll, 'YXZ'));
      leaves.push({ strand: s, node, qRest, size });
    };

    // ---- hanging strands: random-walk droop from anchors spread along the bar
    const nStrands = 9 + (rnd() < 0.5 ? 1 : 0);
    for (let i = 0; i < nStrands; i++) {
      const ax = -1.12 + (2.24 * i) / (nStrands - 1) + (rnd() - 0.5) * 0.1;
      const az = (i % 2 === 0 ? -0.07 : 0.07) + (rnd() - 0.5) * 0.06;
      const len = i % 2 === 0 ? 1.9 + rnd() * 0.8 : 1.35 + rnd() * 0.7;
      const n = Math.max(7, Math.round(len / 0.15));

      const rest: THREE.Vector3[] = [new THREE.Vector3(ax, BAR_Y, az)];
      const segLen: number[] = [];
      let dx = (rnd() - 0.5) * 0.14, dz = (rnd() - 0.5) * 0.14;
      for (let j = 0; j < n; j++) {
        dx = Math.max(-0.3, Math.min(0.3, dx + (rnd() - 0.5) * 0.13));
        dz = Math.max(-0.3, Math.min(0.3, dz + (rnd() - 0.5) * 0.13));
        const l = 0.13 + rnd() * 0.04;
        const inv = l / Math.hypot(dx, 1, dz);
        const p = rest[j]!;
        rest.push(new THREE.Vector3(p.x + dx * inv, p.y - inv, p.z + dz * inv));
        segLen.push(l);
      }

      const sIdx = strands.length;
      strands.push(mkStrandState(rest, segLen, rnd() * Math.PI * 2, true));

      // stems along every segment; leaves spiral down the strand (phyllotaxis-ish)
      for (let j = 0; j < n; j++) stems.push({ strand: sIdx, node: j, thick: 0.022 - (j / n) * 0.012 });
      for (let j = 1; j <= n; j++) {
        const f = j / n;
        const size = (0.19 + rnd() * 0.09) * (0.85 + 0.45 * Math.sin(Math.PI * Math.min(1, f * 1.15)));
        addLeaf(sIdx, j, j * 2.4 + rnd() * 0.7, 1.7 + rnd() * 0.6, (rnd() - 0.5) * 0.6, size);
        addLeaf(sIdx, j, j * 2.4 + Math.PI * (0.8 + rnd() * 0.4), 1.5 + rnd() * 0.7, (rnd() - 0.5) * 0.6, size * (0.7 + rnd() * 0.25));
      }
      // small leaf pair at the very tip
      addLeaf(sIdx, n, rnd() * Math.PI * 2, 2.3 + rnd() * 0.4, (rnd() - 0.5) * 0.5, 0.14);
      // rare amber bud near the tip (the lone warm accent)
      if (rnd() < 0.45) buds.push({ strand: sIdx, node: n - 1 - Math.floor(rnd() * 2) });
    }

    // ---- leafy collar: short dense fringe along the bar so the drape has mass
    // at the top (where the ivy "grows from") instead of strings on a stick
    {
      const nF = 13;
      for (let i = 0; i < nF; i++) {
        const ax = -1.18 + (2.36 * i) / (nF - 1) + (rnd() - 0.5) * 0.07;
        const az = (i % 2 === 0 ? -0.09 : 0.09) + (rnd() - 0.5) * 0.05;
        const n = 2 + Math.floor(rnd() * 2);
        const rest: THREE.Vector3[] = [new THREE.Vector3(ax, BAR_Y + 0.02, az)];
        const segLen: number[] = [];
        let dx = (rnd() - 0.5) * 0.5, dz = (rnd() - 0.5) * 0.5;
        for (let j = 0; j < n; j++) {
          const l = 0.12 + rnd() * 0.05;
          const inv = l / Math.hypot(dx, 1, dz);
          const p = rest[j]!;
          rest.push(new THREE.Vector3(p.x + dx * inv, p.y - inv, p.z + dz * inv));
          segLen.push(l);
          dx *= 0.6; dz *= 0.6;
        }
        const sIdx = strands.length;
        strands.push(mkStrandState(rest, segLen, rnd() * Math.PI * 2, false));
        for (let j = 0; j < n; j++) stems.push({ strand: sIdx, node: j, thick: 0.016 });
        for (let j = 1; j <= n; j++) {
          addLeaf(sIdx, j, rnd() * Math.PI * 2, 1.5 + rnd() * 0.8, (rnd() - 0.5) * 0.7, 0.22 + rnd() * 0.1);
          addLeaf(sIdx, j, rnd() * Math.PI * 2, 1.8 + rnd() * 0.7, (rnd() - 0.5) * 0.7, 0.18 + rnd() * 0.09);
        }
      }
    }

    // ---- one garland swag sagging across the bar (ambient-only, above actors)
    {
      const sag = 0.42 + rnd() * 0.16;
      const x0 = -0.95, x1 = 0.95, n = 12;
      const rest: THREE.Vector3[] = [];
      const segLen: number[] = [];
      for (let j = 0; j <= n; j++) {
        const f = j / n;
        rest.push(new THREE.Vector3(
          x0 + (x1 - x0) * f,
          BAR_Y - 0.05 - sag * 4 * f * (1 - f),
          0.07 - 0.1 * f + (rnd() - 0.5) * 0.03,
        ));
      }
      for (let j = 0; j < n; j++) segLen.push(rest[j]!.distanceTo(rest[j + 1]!));
      const sIdx = strands.length;
      strands.push(mkStrandState(rest, segLen, rnd() * Math.PI * 2, false));
      for (let j = 0; j < n; j++) stems.push({ strand: sIdx, node: j, thick: 0.016 });
      for (let j = 1; j < n; j++) {
        addLeaf(sIdx, j, rnd() * Math.PI * 2, 2.2 + rnd() * 0.7, (rnd() - 0.5) * 0.5, 0.17 + rnd() * 0.08);
        if (rnd() < 0.6) addLeaf(sIdx, j, rnd() * Math.PI * 2, 1.9 + rnd() * 0.7, (rnd() - 0.5) * 0.5, 0.14 + rnd() * 0.07);
      }
      if (rnd() < 0.5) buds.push({ strand: sIdx, node: Math.floor(n / 2) });
    }

    // ------------------------------------------------------------------ boxes
    // one instanced unit box = bar + brackets + all stem segments + buds
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const FIXED = 3; // bar + 2 brackets
    const boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, FIXED + stems.length + buds.length);
    boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    boxMesh.castShadow = boxMesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qSeg = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    // bar + brackets (static; written once)
    m.compose(v.set(0, BAR_Y + 0.045, 0), q.identity(), scl.set(BAR_W + 0.24, 0.09, 0.13));
    boxMesh.setMatrixAt(0, m);
    boxMesh.setColorAt(0, color.set(0x2a2733));
    for (let k = 0; k < 2; k++) {
      m.compose(v.set((k === 0 ? -1 : 1) * (BAR_W / 2 + 0.05), BAR_Y + 0.04, 0), q.identity(), scl.set(0.07, 0.2, 0.18));
      boxMesh.setMatrixAt(1 + k, m);
      boxMesh.setColorAt(1 + k, color.set(0x211e29));
    }
    // stem colors: dark green-brown, slightly varied
    for (let i = 0; i < stems.length; i++) {
      color.setHSL(0.21 + rnd() * 0.12, 0.3, 0.14 + rnd() * 0.07);
      boxMesh.setColorAt(FIXED + i, color);
    }
    // bud colors: the rare warm amber accent
    for (let i = 0; i < buds.length; i++) {
      boxMesh.setColorAt(FIXED + stems.length + i, color.set(0xffb24f));
    }
    if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;

    // ----------------------------------------------------------------- leaves
    const leafGeo = new THREE.PlaneGeometry(0.62, 1, 1, 2);
    leafGeo.translate(0, 0.5, 0); // pivot at the stem end of the leaf
    const leafTex = makeLeafTexture();
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8,
      // slight emissive lift so back-lit/shadowed leaves go dark mossy green,
      // never dead black (foliage cheat; keeps the curtain readable at night)
      emissive: 0x121a12, emissiveIntensity: 1,
    });
    const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, leaves.length);
    leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    leafMesh.castShadow = true;
    leafMesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.5,
    });

    // leaf tint: mossy green at the anchor → muted indigo-tinged at the tips
    // (indigo = the game's "potential/unrevealed" — tips hang into the unknown)
    for (let i = 0; i < leaves.length; i++) {
      const lf = leaves[i]!;
      const st = strands[lf.strand]!;
      const f = (BAR_Y - st.rest[lf.node]!.y) / 2.6; // 0 at bar → 1 near floor
      color.setHSL(
        0.3 + f * 0.26 + (rnd() - 0.5) * 0.04,
        0.38 - f * 0.08 + rnd() * 0.08,
        0.26 + rnd() * 0.09 + (1 - f) * 0.04,
      );
      leafMesh.setColorAt(i, color);
    }
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;

    // ----------------------------------------------------------------- update
    let lastT: number | undefined;
    const update = (timeSec: number, actors: readonly THREE.Vector3[]): void => {
      const dt = lastT === undefined ? 0 : Math.max(0, Math.min(0.05, timeSec - lastT));
      lastT = timeSec;

      for (let s = 0; s < strands.length; s++) {
        const st = strands[s]!;
        const n = st.rest.length - 1;

        // push targets + spring per node
        if (st.reactive) {
          for (let j = 1; j <= n; j++) {
            const p = st.cur[j]!;
            let tx = 0, tz = 0;
            for (const a of actors) {
              const ddx = p.x - a.x, ddz = p.z - a.z;
              const vert = 1 - Math.max(0, Math.min(1, (Math.abs(p.y - a.y) - 1.0) / 0.9));
              if (vert <= 0) continue;
              const d = Math.hypot(ddx, ddz);
              if (d < PUSH_R) {
                const str = (1 - d / PUSH_R) ** 1.5 * PUSH_S * vert;
                if (d > 1e-4) { tx += (ddx / d) * str; tz += (ddz / d) * str; } else tx += str;
              }
            }
            // immediate attack (visible even in single frozen frames)
            const tMag = Math.hypot(tx, tz);
            if (tMag > Math.hypot(st.ox[j]!, st.oz[j]!)) {
              st.ox[j] = st.ox[j]! + (tx - st.ox[j]!) * 0.5;
              st.oz[j] = st.oz[j]! + (tz - st.oz[j]!) * 0.5;
            }
            // underdamped spring toward target (target=0 once actor leaves →
            // swings back past rest, oscillates, settles = pendulum feel)
            if (dt > 0) {
              st.vx[j] = st.vx[j]! + ((tx - st.ox[j]!) * SPRING_K - st.vx[j]! * SPRING_C) * dt;
              st.vz[j] = st.vz[j]! + ((tz - st.oz[j]!) * SPRING_K - st.vz[j]! * SPRING_C) * dt;
              st.ox[j] = st.ox[j]! + st.vx[j]! * dt;
              st.oz[j] = st.oz[j]! + st.vz[j]! * dt;
            }
          }
        }

        // rebuild the chain: rest + offsets + ambient sway, lengths preserved
        st.cur[0]!.copy(st.rest[0]!);
        for (let j = 1; j <= n; j++) {
          const f = j / n;
          const amp = f ** 1.5 * (st.reactive ? 1 : 0.4 * Math.sin(Math.PI * f));
          const swayX = (Math.sin(timeSec * 0.8 + st.phase) * 0.05 + Math.sin(timeSec * 2.0 + st.phase * 1.7) * 0.02) * amp;
          const swayZ = (Math.cos(timeSec * 0.66 + st.phase * 1.3) * 0.04 + Math.sin(timeSec * 1.7 + st.phase) * 0.018) * amp;
          if (st.reactive) {
            v.set(st.rest[j]!.x + st.ox[j]! + swayX, st.rest[j]!.y, st.rest[j]!.z + st.oz[j]! + swayZ);
            v2.copy(v).sub(st.cur[j - 1]!).normalize().multiplyScalar(st.segLen[j - 1]!);
            st.cur[j]!.copy(st.cur[j - 1]!).add(v2);
          } else {
            // swag is anchored at both ends: just offset, no chain pass
            st.cur[j]!.set(st.rest[j]!.x + swayX * 0.5, st.rest[j]!.y, st.rest[j]!.z + swayZ);
          }
        }
      }

      // write stem segment instances
      for (let i = 0; i < stems.length; i++) {
        const sg = stems[i]!;
        const st = strands[sg.strand]!;
        const a = st.cur[sg.node]!, b = st.cur[sg.node + 1]!;
        v.copy(a).sub(b);
        const len = v.length() || 1e-4;
        q.setFromUnitVectors(UP, v.multiplyScalar(1 / len));
        m.compose(v2.copy(a).add(b).multiplyScalar(0.5), q, scl.set(sg.thick, len, sg.thick));
        boxMesh.setMatrixAt(FIXED + i, m);
      }
      // write bud instances (tiny diamonds at their node)
      for (let i = 0; i < buds.length; i++) {
        const bd = buds[i]!;
        const p = strands[bd.strand]!.cur[bd.node]!;
        q.setFromEuler(new THREE.Euler(0.6, i * 1.3, 0.5));
        m.compose(v.copy(p), q, scl.set(0.055, 0.075, 0.055));
        boxMesh.setMatrixAt(FIXED + stems.length + i, m);
      }
      boxMesh.instanceMatrix.needsUpdate = true;

      // write leaf instances: rigidly follow their segment's rotation
      for (let i = 0; i < leaves.length; i++) {
        const lf = leaves[i]!;
        const st = strands[lf.strand]!;
        v.copy(st.cur[lf.node]!).sub(st.cur[lf.node - 1]!).normalize();
        qSeg.setFromUnitVectors(st.restDir[lf.node]!, v);
        q.copy(qSeg).multiply(lf.qRest);
        m.compose(v2.copy(st.cur[lf.node]!), q, scl.set(lf.size, lf.size, lf.size));
        leafMesh.setMatrixAt(i, m);
      }
      leafMesh.instanceMatrix.needsUpdate = true;
    };

    const root = new THREE.Group();
    root.add(boxMesh);
    root.add(leafMesh);

    update(0, []);
    return { root, update, radius: 3.2 };
  },
};

/** Allocate the per-node sim state for one strand. */
function mkStrandState(rest: THREE.Vector3[], segLen: number[], phase: number, reactive: boolean): Strand {
  const n = rest.length;
  const restDir: THREE.Vector3[] = [new THREE.Vector3(0, -1, 0)];
  for (let j = 1; j < n; j++) {
    restDir.push(new THREE.Vector3().copy(rest[j]!).sub(rest[j - 1]!).normalize());
  }
  return {
    rest,
    cur: rest.map((p) => p.clone()),
    restDir,
    segLen,
    ox: new Float32Array(n), oz: new Float32Array(n),
    vx: new Float32Array(n), vz: new Float32Array(n),
    phase,
    reactive,
  };
}

export default vineDrape;
