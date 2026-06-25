// ============================================================================
// glow-crystal — emissive crystal cluster in ASCENT's two signature colors.
// ============================================================================
//
// LUMINOUS ACCENT decoration. 3–6 angular shards (hex prism + pyramid cap,
// vertex-welded jitter so facets catch light irregularly) grow out of a dark
// rock mound. The glow is an emissive bake with PER-FACET BANDING: each side
// facet samples its own brightness column of a striped gradient texture
// (column picked from the facet's yaw sector), so adjacent facets glow at
// different strengths — that hard banding is what makes it read CRYSTAL
// instead of airbrushed flame. Vertically the gradient stays dark-glassy for
// the lower half, rises over a hard knee, and whitens only the last ~4% (a
// tip sparkle, not a flame tongue). A faint short-range PointLight rims the
// rock and ground. update(time) drives a slow two-sine pulse on both.
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
 * NB: quantize via Math.round (+0 to kill -0), NOT toFixed — the cylinder's
 * θ=0/2π seam vertices differ by ~1e-16 and toFixed(3) renders them as
 * "0.000" vs "-0.000" → different keys → the seam tears open into a slit.
 */
const q3 = (v: number): number => Math.round(v * 1000) + 0;
function jitterWelded(geo: THREE.BufferGeometry, rnd: () => number, amp: number): void {
  const pos = geo.attributes.position!;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${q3(pos.getX(i))}|${q3(pos.getY(i))}|${q3(pos.getZ(i))}`;
    let d = seen.get(k);
    if (!d) {
      d = [(rnd() - 0.5) * amp, (rnd() - 0.5) * amp * 0.6, (rnd() - 0.5) * amp];
      seen.set(k, d);
    }
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
}

/** Brightness columns in the striped gradient bake (one per facet "slot"). */
const COLS = 6;
const COL_W = 8; // px per column — wide enough that linear filtering stays inside

/**
 * One crystal shard: 6-sided prism + pyramid cap. Every triangle gets a FLAT
 * uv: u = the brightness column for its yaw sector (so each side facet glows
 * at its own strength), v = normalized height (the vertical gradient).
 */
function makeShard(rnd: () => number, h: number, girth: number): THREE.BufferGeometry {
  // long parallel-sided prism + SHORT pyramid cap = crystal, not flame
  const bodyH = h * (0.74 + rnd() * 0.1);
  const tipH = h - bodyH;
  const topR = girth * (0.55 + rnd() * 0.2);
  const body = new THREE.CylinderGeometry(topR, girth, bodyH, 6, 1);
  body.translate(0, bodyH / 2, 0);
  const cap = new THREE.ConeGeometry(topR, tipH, 6);
  cap.translate(0, bodyH + tipH / 2, 0);
  const geo = mergeGeometries([body.toNonIndexed(), cap.toNonIndexed()])!;
  jitterWelded(geo, rnd, girth * 0.24);

  const pos = geo.attributes.position!;
  const uv = geo.attributes.uv!;
  const salt = Math.floor(rnd() * COLS); // per-shard column rotation
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    // yaw sector of the face normal → which brightness column this facet samples
    const yaw = Math.atan2(n.z, n.x);
    const sector = Math.floor(((yaw + Math.PI) / (Math.PI * 2)) * 6) % 6;
    const u = (((sector + salt) % COLS) + 0.5) / COLS;
    for (let k = 0; k < 3; k++) {
      uv.setXY(t + k, u, Math.max(0, Math.min(1, pos.getY(t + k) / h)));
    }
  }
  return geo;
}

/**
 * Striped glow bake: COLS columns, each a vertical gradient at its own random
 * brightness — dark glassy base, hard knee past mid-height, hot upper third,
 * and a whitened TIP SPARKLE confined to the last ~4% (any longer reads flame).
 */
function bakeGlowGradient(glow: THREE.Color, tip: THREE.Color, rnd: () => number): THREE.CanvasTexture {
  const cvs = document.createElement('canvas');
  cvs.width = COLS * COL_W;
  cvs.height = 128;
  const ctx = cvs.getContext('2d')!;
  const css = (col: THREE.Color, mul: number) =>
    `rgb(${Math.min(255, Math.round(col.r * 255 * mul))},${Math.min(255, Math.round(col.g * 255 * mul))},${Math.min(255, Math.round(col.b * 255 * mul))})`;
  for (let i = 0; i < COLS; i++) {
    const bright = 0.55 + rnd() * 0.62; // per-facet glow strength (the banding)
    // flipY=true (CanvasTexture default): canvas BOTTOM row samples at v=0.
    const g = ctx.createLinearGradient(0, 128, 0, 0);
    // the low zone is deep-glass, NOT void: against a brighter shard behind it
    // a pure-black base reads as a hole in the cluster
    g.addColorStop(0.0, css(glow, 0.07));
    g.addColorStop(0.34, css(glow, 0.13 * bright));
    g.addColorStop(0.52, css(glow, 0.32 * bright)); // …slow build…
    g.addColorStop(0.62, css(glow, 0.98 * bright)); // hard knee = crystalline band
    g.addColorStop(0.93, css(glow, 1.1 * bright));
    g.addColorStop(0.962, css(glow, 1.1 * bright));
    g.addColorStop(1.0, css(tip, 1.0)); // tip sparkle only
    ctx.fillStyle = g;
    ctx.fillRect(i * COL_W, 0, COL_W, 128);
  }
  const t = new THREE.CanvasTexture(cvs);
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
      // satellites are STRICTLY subordinate (≤ ~0.46·dominant): tall satellites
      // foreshorten across the dominant from some camera yaws and cut a dark
      // slot through its hot zone (verified by parallax snaps — keep them short)
      const h = dominant ? domH : domH * (0.26 + rnd() * 0.2);
      const girth = dominant ? 0.16 + rnd() * 0.05 : 0.1 + rnd() * 0.05;
      const g = makeShard(rnd, h, girth);
      // place: dominant near center, satellites ringed CLEAR of it (a tight,
      // hard-leaning satellite occludes the dominant as a black slot from some
      // angles — keep them out at r≥0.3 with a moderate outward lean)
      const ang = baseAngle + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const r = dominant ? rnd() * 0.08 : 0.3 + rnd() * 0.15;
      const tilt = dominant ? rnd() * 0.14 : 0.3 + rnd() * 0.25;
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

    const emissiveMap = bakeGlowGradient(look.glow, look.tip, rnd);
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0x232840, // unlit facets = dark indigo glass (lit, never a void)
      roughness: 0.28,
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
    const rockN = 8 + Math.floor(rnd() * 3);
    for (let i = 0; i < rockN; i++) {
      // a couple of big anchor boulders + smaller fill; ringed so shards clearly
      // EMERGE from rock instead of floating on bare ground
      const big = i < 2;
      const s = big ? 0.2 + rnd() * 0.08 : 0.11 + rnd() * 0.1;
      const g = new THREE.IcosahedronGeometry(s, 0);
      jitterWelded(g, rnd, s * 0.45);
      const ang = rnd() * Math.PI * 2;
      const r = big ? 0.1 + rnd() * 0.16 : 0.14 + rnd() * 0.26;
      e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
      q.setFromEuler(e);
      m.compose(
        new THREE.Vector3(Math.cos(ang) * r, s * 0.3, Math.sin(ang) * r),
        q,
        new THREE.Vector3(1, 0.58, 1), // squashed = settled, not floating
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
      const p = 1.3 + 0.3 * Math.sin(timeSec * 0.9 + phase) + 0.1 * Math.sin(timeSec * 2.3 + phase * 1.7);
      shardMat.emissiveIntensity = p;
      // the ground pool breathes MORE than the shards — that's where the pulse
      // stays readable once the shard hot zone saturates
      light.intensity = LIGHT_BASE * (0.3 + p * 0.7);
    };
    update(0);

    return { root, update, radius: 0.95 };
  },
};

export default glowCrystal;
