// ============================================================================
// glow-crystal — emissive crystal cluster in ASCENT's two signature colors.
// ============================================================================
//
// LUMINOUS ACCENT decoration. 3–6 angular shards (hex prism + pyramid cap,
// vertex-welded jitter so facets catch light irregularly) grow out of a dark
// rock mound. The glow is a vertical emissive-gradient bake (dark at the base
// → bright at the tip) so the crystals read as lit from within, plus a faint
// short-range PointLight that rims the rock and ground. update(time) drives a
// slow two-sine pulse on both (no actors needed — this is ambient life).
//
// SUB-LOOKS FROM SEED (document for placement code):
//   even seeds → AMBER  (0xffb24f — "lit / earned" accent)
//   odd  seeds → INDIGO (0x5a78ff — "potential / unrevealed" accent)
//
// Cost: 2 draw calls (merged shards, merged rock) + 1 shadowless PointLight.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type LabElement, mulberry32 } from '../element.ts';

// The two signature looks. `deep` is the unlit body tint; `tip` whitens the apex.
const LOOKS = {
  amber: { glow: new THREE.Color(0xffb24f), tip: new THREE.Color(0xffe6c0) },
  indigo: { glow: new THREE.Color(0x5a78ff), tip: new THREE.Color(0xcdd6ff) },
} as const;

/**
 * Displace vertices by a hash of their (quantized) position so coincident
 * vertices move together — irregular facets without cracking the mesh.
 */
function jitterWelded(geo: THREE.BufferGeometry, rnd: () => number, amp: number): void {
  const pos = geo.attributes.position!;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)}|${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`;
    let d = seen.get(k);
    if (!d) {
      d = [(rnd() - 0.5) * amp, (rnd() - 0.5) * amp * 0.6, (rnd() - 0.5) * amp];
      seen.set(k, d);
    }
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
}

/** One crystal shard: 6-sided prism + pyramid cap, UV.v remapped to 0..1 along height. */
function makeShard(rnd: () => number, h: number, girth: number): THREE.BufferGeometry {
  // long parallel-sided prism + SHORT pyramid cap = crystal, not flame
  const bodyH = h * (0.68 + rnd() * 0.12);
  const tipH = h - bodyH;
  const topR = girth * (0.5 + rnd() * 0.25);
  const body = new THREE.CylinderGeometry(topR, girth, bodyH, 6, 1);
  body.translate(0, bodyH / 2, 0);
  const cap = new THREE.ConeGeometry(topR, tipH, 6);
  cap.translate(0, bodyH + tipH / 2, 0);
  const geo = mergeGeometries([body.toNonIndexed(), cap.toNonIndexed()])!;
  jitterWelded(geo, rnd, girth * 0.3);
  // v = normalized height, so a shared vertical-gradient emissiveMap glows tip-ward
  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, 0.5, Math.max(0, Math.min(1, pos.getY(i) / h)));
  }
  return geo;
}

/** Vertical glow gradient: near-black base → glow color → whitened tip. */
function bakeGlowGradient(glow: THREE.Color, tip: THREE.Color): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  // flipY=true (CanvasTexture default): canvas TOP row samples at v=1 (the tip).
  // Dark stays low on the shard, the hot zone lives in the upper third.
  const g = ctx.createLinearGradient(0, 128, 0, 0); // stop 0 at canvas bottom = v=0
  const css = (col: THREE.Color, mul: number) =>
    `rgb(${Math.round(col.r * 255 * mul)},${Math.round(col.g * 255 * mul)},${Math.round(col.b * 255 * mul)})`;
  g.addColorStop(0.0, css(glow, 0.04));
  g.addColorStop(0.42, css(glow, 0.16));
  g.addColorStop(0.7, css(glow, 0.6));
  g.addColorStop(0.9, css(glow, 1.0));
  g.addColorStop(1.0, css(tip, 1.0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowCrystal: LabElement = {
  name: 'Glow crystal',
  describe:
    'Emissive crystal cluster with slow pulse + faint light. Even seeds amber (earned), odd seeds indigo (potential).',
  build(seed: number) {
    const rnd = mulberry32(seed * 48271 + 11);
    const look = seed % 2 === 0 ? LOOKS.amber : LOOKS.indigo;

    // ---- shards: one dominant + 2–5 satellites, merged to one mesh ----------
    const shardGeos: THREE.BufferGeometry[] = [];
    const n = 3 + Math.floor(rnd() * 4); // 3..6
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const baseAngle = rnd() * Math.PI * 2;
    const domH = 0.82 + rnd() * 0.28;
    for (let i = 0; i < n; i++) {
      const dominant = i === 0;
      // satellites are STRICTLY subordinate (≤ ~0.62·dominant) so every seed
      // keeps a clear hierarchy instead of merging into one flame-mass
      const h = dominant ? domH : domH * (0.32 + rnd() * 0.3);
      const girth = dominant ? 0.16 + rnd() * 0.05 : 0.1 + rnd() * 0.05;
      const g = makeShard(rnd, h, girth);
      // place: dominant near center, satellites ringed around, leaning outward
      const ang = baseAngle + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
      const r = dominant ? rnd() * 0.08 : 0.21 + rnd() * 0.17;
      const tilt = dominant ? rnd() * 0.14 : 0.3 + rnd() * 0.32;
      e.set(Math.cos(ang) * tilt, rnd() * Math.PI * 2, -Math.sin(ang) * tilt);
      q.setFromEuler(e);
      m.compose(
        new THREE.Vector3(Math.cos(ang) * r, -0.04, Math.sin(ang) * r),
        q,
        new THREE.Vector3(1, 1, 1),
      );
      g.applyMatrix4(m);
      shardGeos.push(g);
    }
    const shardGeo = mergeGeometries(shardGeos)!;
    for (const g of shardGeos) g.dispose();

    const emissiveMap = bakeGlowGradient(look.glow, look.tip);
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0x16161f, // unlit facets stay dark crystal
      roughness: 0.32,
      metalness: 0.0,
      flatShading: true,
      emissive: 0xffffff,
      emissiveMap,
      emissiveIntensity: 1.3, // >1 so the low-luminance indigo tip still reads HOT
    });
    const shards = new THREE.Mesh(shardGeo, shardMat);
    shards.castShadow = true;

    // ---- dark rock mound the cluster grows from -----------------------------
    const rockGeos: THREE.BufferGeometry[] = [];
    const rockN = 6 + Math.floor(rnd() * 3);
    for (let i = 0; i < rockN; i++) {
      const s = 0.11 + rnd() * 0.11;
      const g = new THREE.IcosahedronGeometry(s, 0);
      jitterWelded(g, rnd, s * 0.45);
      const ang = rnd() * Math.PI * 2;
      const r = rnd() * 0.32;
      e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      q.setFromEuler(e);
      m.compose(
        new THREE.Vector3(Math.cos(ang) * r, s * 0.34, Math.sin(ang) * r),
        q,
        new THREE.Vector3(1, 0.62, 1), // squashed = settled, not floating
      );
      g.applyMatrix4(m);
      rockGeos.push(g);
    }
    const rockGeo = mergeGeometries(rockGeos)!;
    for (const g of rockGeos) g.dispose();
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x252531, // desaturated cool stone, darker than the 0x2e2e4a walls
      roughness: 0.97,  // so facets never out-shine the crystal glow
      flatShading: true,
    });
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.castShadow = rock.receiveShadow = true;

    // ---- faint inner light: rims the rock, must never blow out the scene ----
    // (physical decay blows up at near range — keep it WEAK and slightly high
    //  so shard bases don't get nuked into flat brightness)
    const LIGHT_BASE = 0.85;
    const light = new THREE.PointLight(look.glow, LIGHT_BASE, 2.6, 2);
    light.position.set(0, 0.55, 0);

    const root = new THREE.Group();
    root.add(rock, shards, light);

    // ---- slow organic pulse (two incommensurate sines; phase from seed) ----
    const phase = rnd() * Math.PI * 2;
    const update = (timeSec: number): void => {
      const p = 1.3 + 0.22 * Math.sin(timeSec * 0.9 + phase) + 0.09 * Math.sin(timeSec * 2.3 + phase * 1.7);
      shardMat.emissiveIntensity = p;
      light.intensity = LIGHT_BASE * (0.55 + p * 0.55);
    };
    update(0);

    return { root, update, radius: 0.95 };
  },
};

export default glowCrystal;
