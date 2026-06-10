// ============================================================================
// vine-wall — flat ivy patch climbing a wall panel (static, very cheap).
// ============================================================================
//
// The non-reactive sibling of vine-drape: ivy runners random-walk UP a wall
// panel, branching as they go; leaves lie nearly flat against the wall (small
// outward tilt so they catch the key light), bigger old growth low, smaller
// young leaves at the climbing tips. Deep mossy greens with occasional
// indigo-dusted leaves; 2–4 tiny amber buds as the rare warm accent.
//
// 2 draw calls, no update(): one box InstancedMesh (panel + ledge + stem
// segments + buds via instanceColor) + one alpha-tested leaf InstancedMesh.
// All matrices are written once at build time — zero per-frame cost, so this
// can be scattered liberally across tower walls.
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const PANEL_W = 2.2;
const PANEL_H = 2.6;
const PANEL_D = 0.12;
const X_MAX = PANEL_W / 2 - 0.12; // keep growth inside the panel face
const Z_STEM = PANEL_D / 2 + 0.015;
const Z_LEAF = PANEL_D / 2 + 0.028;

/** Same stylized lobed ivy-leaf card as vine-drape (kept local: elements are
 *  self-contained by contract). */
function makeLeafTexture(): THREE.CanvasTexture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  const body = new Path2D();
  body.moveTo(32, 61);
  body.bezierCurveTo(20, 56, 10, 52, 6, 42);
  body.bezierCurveTo(2, 32, 12, 28, 18, 30);
  body.bezierCurveTo(14, 20, 22, 8, 32, 3);
  body.bezierCurveTo(42, 8, 50, 20, 46, 30);
  body.bezierCurveTo(52, 28, 62, 32, 58, 42);
  body.bezierCurveTo(54, 52, 44, 56, 32, 61);
  const g = ctx.createLinearGradient(0, 61, 0, 3);
  g.addColorStop(0, 'rgb(152,170,132)');
  g.addColorStop(0.55, 'rgb(198,212,176)');
  g.addColorStop(1, 'rgb(174,192,156)');
  ctx.fillStyle = g;
  ctx.fill(body);
  ctx.strokeStyle = 'rgba(74,92,62,0.6)';
  ctx.lineWidth = 2.5;
  ctx.stroke(body);
  ctx.strokeStyle = 'rgba(92,112,76,0.5)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(32, 58); ctx.lineTo(32, 8); ctx.stroke();
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

interface Seg { x0: number; y0: number; x1: number; y1: number; thick: number }
interface Leaf { x: number; y: number; ang: number; tilt: number; size: number; f: number }

const vineWall: LabElement = {
  name: 'Vine wall',
  describe: 'Static ivy patch climbing a wall panel — zero per-frame cost, scatter it on tower walls.',
  build(seed: number) {
    const rnd = mulberry32(seed * 48271 + 11);

    const segs: Seg[] = [];
    const leafDefs: Leaf[] = [];
    const budPos: Array<{ x: number; y: number }> = [];

    // ---- grow runners up the wall (random walk biased upward, with branching)
    const grow = (x: number, y: number, heading: number, steps: number, depth: number): void => {
      for (let s = 0; s < steps; s++) {
        heading += (rnd() - 0.5) * 0.55;
        heading += (Math.PI / 2 - heading) * 0.18; // bias back toward "up"
        const l = 0.11 + rnd() * 0.07;
        const nx = x + Math.cos(heading) * l;
        const ny = y + Math.sin(heading) * l;
        if (ny > PANEL_H - 0.15 || Math.abs(nx) > X_MAX) break;
        segs.push({ x0: x, y0: y, x1: nx, y1: ny, thick: Math.max(0.012, 0.026 - depth * 0.006 - (s / steps) * 0.008) });

        const f = ny / PANEL_H; // 0 low (old growth) → 1 high (young tips)
        if (rnd() < 0.9) {
          const side = rnd() < 0.5 ? 1 : -1;
          leafDefs.push({
            x: nx + Math.cos(heading + side * 1.4) * 0.04,
            y: ny + Math.sin(heading + side * 1.4) * 0.04,
            ang: heading + side * (0.7 + rnd() * 0.9),
            tilt: 0.18 + rnd() * 0.35,
            size: (0.2 - f * 0.07) * (0.8 + rnd() * 0.5),
            f,
          });
        }
        // occasional second leaf keeps low growth dense
        if (rnd() < 0.45 - f * 0.25) {
          leafDefs.push({
            x: nx, y: ny,
            ang: heading + (rnd() - 0.5) * 2.4,
            tilt: 0.18 + rnd() * 0.35,
            size: (0.17 - f * 0.05) * (0.8 + rnd() * 0.5),
            f,
          });
        }
        // branch (less often as we go up / deeper)
        if (depth < 2 && rnd() < 0.14 - depth * 0.04) {
          grow(nx, ny, heading + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), Math.floor(steps * (0.35 + rnd() * 0.3)), depth + 1);
        }
        x = nx; y = ny;
      }
      // a young tip leaf finishes each runner; rarely an amber bud beside it
      leafDefs.push({ x, y, ang: heading, tilt: 0.3 + rnd() * 0.3, size: 0.1 + rnd() * 0.04, f: y / PANEL_H });
      if (rnd() < 0.35 && budPos.length < 4) budPos.push({ x, y });
    };

    const nRunners = 4 + Math.floor(rnd() * 2);
    for (let i = 0; i < nRunners; i++) {
      const x0 = -0.55 + (1.1 * i) / (nRunners - 1) + (rnd() - 0.5) * 0.2;
      grow(x0, 0.04, Math.PI / 2 + (rnd() - 0.5) * 0.9, 13 + Math.floor(rnd() * 7), 0);
    }

    // ------------------------------------------------------------------ boxes
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const FIXED = 2; // panel + ledge
    const boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, FIXED + segs.length + budPos.length);
    boxMesh.castShadow = boxMesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qa = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const Z = new THREE.Vector3(0, 0, 1);
    const X = new THREE.Vector3(1, 0, 0);

    // wall panel (the tower-wall context) + a grounding ledge at its foot
    m.compose(v.set(0, PANEL_H / 2, 0), q.identity(), scl.set(PANEL_W, PANEL_H, PANEL_D));
    boxMesh.setMatrixAt(0, m);
    boxMesh.setColorAt(0, color.set(0x2c2c46));
    m.compose(v.set(0, 0.06, 0.02), q.identity(), scl.set(PANEL_W + 0.12, 0.12, PANEL_D + 0.08));
    boxMesh.setMatrixAt(1, m);
    boxMesh.setColorAt(1, color.set(0x232338));

    // stem segments: thin boxes lying on the wall face
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i]!;
      const dx = sg.x1 - sg.x0, dy = sg.y1 - sg.y0;
      const len = Math.hypot(dx, dy);
      q.setFromAxisAngle(Z, Math.atan2(dy, dx) - Math.PI / 2);
      m.compose(v.set((sg.x0 + sg.x1) / 2, (sg.y0 + sg.y1) / 2, Z_STEM), q, scl.set(sg.thick, len + sg.thick, sg.thick));
      boxMesh.setMatrixAt(FIXED + i, m);
      color.setHSL(0.2 + rnd() * 0.1, 0.32, 0.13 + rnd() * 0.06);
      boxMesh.setColorAt(FIXED + i, color);
    }
    // amber buds at a few runner tips
    for (let i = 0; i < budPos.length; i++) {
      q.setFromAxisAngle(Z, rnd() * Math.PI);
      m.compose(v.set(budPos[i]!.x, budPos[i]!.y, Z_LEAF + 0.01), q, scl.set(0.05, 0.07, 0.05));
      boxMesh.setMatrixAt(FIXED + segs.length + i, m);
      boxMesh.setColorAt(FIXED + segs.length + i, color.set(0xffb24f));
    }
    if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;

    // ----------------------------------------------------------------- leaves
    const leafGeo = new THREE.PlaneGeometry(0.62, 1, 1, 1);
    leafGeo.translate(0, 0.5, 0); // pivot at the stem end
    const leafTex = makeLeafTexture();
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85,
      emissive: 0x121a12, emissiveIntensity: 1, // never dead black at night
    });
    const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, leafDefs.length);
    leafMesh.castShadow = true;
    leafMesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.5,
    });

    for (let i = 0; i < leafDefs.length; i++) {
      const lf = leafDefs[i]!;
      // lie in the wall plane pointing along `ang`, tipped outward by `tilt`
      q.setFromAxisAngle(Z, lf.ang - Math.PI / 2);
      qa.setFromAxisAngle(X, lf.tilt);
      q.multiply(qa);
      m.compose(v.set(lf.x, lf.y, Z_LEAF), q, scl.set(lf.size, lf.size, lf.size));
      leafMesh.setMatrixAt(i, m);
      // deep moss low → slightly lighter/cooler young growth; ~14% of leaves
      // are indigo-dusted so the patch sits in the game's night palette
      if (rnd() < 0.14) color.setHSL(0.58 + rnd() * 0.05, 0.22, 0.3 + rnd() * 0.07);
      else color.setHSL(0.29 + lf.f * 0.06 + (rnd() - 0.5) * 0.04, 0.4 + rnd() * 0.1, 0.24 + lf.f * 0.06 + rnd() * 0.08);
      leafMesh.setColorAt(i, color);
    }
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;

    const root = new THREE.Group();
    root.add(boxMesh);
    root.add(leafMesh);
    return { root, radius: 2.4 };
  },
};

export default vineWall;
