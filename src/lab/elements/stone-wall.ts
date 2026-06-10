// ============================================================================
// stone-wall — coursed-block wall material for the tower's perimeter walls.
// ============================================================================
//
// A wall/brick material panel: staggered courses of stone blocks with recessed
// mortar shadow lines, per-block tone variation, chipped corners (fresh-stone
// light, not soot), muted moss creeping along lower crevices, and the RARE warm
// amber stain weeping from a joint (the game's "lit/earned" accent family).
//
// TILING IS THE POINT: the 512 canvas represents 2.0u × 2.0u of wall and wraps
// seamlessly in BOTH axes — every stamp goes through a modulo wrap and the
// normal-map Sobel samples with wrap-around. The demo panel is 3.4u × 2.9u so
// the screenshot itself tests >1 repeat in each direction.
//
// Palette: indigo-night cool stone (game walls are 0x2e2e4a) — a notch darker
// than the floor slab so floors read brighter than walls (player readability).
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const SIZE = 512;
const TEX_WORLD = 2.0; // canvas spans 2.0u of wall
const COURSES = 5;     // → block courses 0.4u tall (megalithic vs 0.35u capsule)
const MORTAR = 3;      // px inset per block edge → ~6px mortar grooves
const BEVEL = 5;       // px rise from mortar floor to block face

/** Soft disc stamp with TOROIDAL wrap (both axes) — keeps the texture seamless. */
function wrapStamp(f: Float32Array, cx: number, cy: number, rad: number, amp: number): void {
  const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad);
  const y0 = Math.floor(cy - rad), y1 = Math.ceil(cy + rad);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / rad;
      if (d < 1) {
        const w = (1 - d * d) ** 1.5;
        const xi = ((x % SIZE) + SIZE) % SIZE, yi = ((y % SIZE) + SIZE) % SIZE;
        f[yi * SIZE + xi]! += amp * w;
      }
    }
  }
}

interface Course { y0: number; y1: number; blocks: { x0: number; w: number }[] }

/** Courses fill the canvas exactly (V-wrap); block runs fill each row (U-wrap). */
function buildLayout(rnd: () => number): Course[] {
  const rows: Course[] = [];
  let prevStart = 0;
  for (let r = 0; r < COURSES; r++) {
    const y0 = Math.round((r * SIZE) / COURSES);
    const y1 = Math.round(((r + 1) * SIZE) / COURSES);
    const blocks: { x0: number; w: number }[] = [];
    // running bond: each course starts ~half a module past the previous one so
    // vertical joints never stack (random starts kept aligning them)
    prevStart = r === 0 ? Math.floor(rnd() * SIZE) : prevStart + Math.floor(SIZE * (0.4 + rnd() * 0.2));
    const start = prevStart % SIZE;
    let x = start;
    while (x < start + SIZE) {
      let w = 90 + Math.floor(rnd() * 110);
      if (start + SIZE - (x + w) < 55) w = start + SIZE - x; // absorb tiny remainder
      blocks.push({ x0: x, w });
      x += w;
    }
    rows.push({ y0, y1, blocks });
  }
  return rows;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Stamp every block: plateau relief, per-block tone, mottle, chips, moss. */
function paintBlocks(
  h: Float32Array, tone: Float32Array, chip: Float32Array, moss: Float32Array,
  layout: Course[], rnd: () => number,
): void {
  // per-pixel edge wobble so block edges read rough-hewn, not machine-chamfered
  const wobSeed = rnd() * 100;
  const wob = (x: number, y: number): number => {
    const s = Math.sin(x * 127.1 + y * 311.7 + wobSeed) * 43758.5453;
    return s - Math.floor(s);
  };
  for (const { y0, y1, blocks } of layout) {
    for (const { x0, w } of blocks) {
      const blockH = 0.50 + (rnd() - 0.5) * 0.20;
      // per-block tone: gentle value drift + the occasional warmer/cooler block
      const toneOff = (rnd() - 0.5) * 0.07 + (rnd() < 0.12 ? (rnd() - 0.5) * 0.12 : 0);
      // per-block, per-side mortar inset variation (hand-set, not machined)
      const inL = MORTAR + rnd() * 2.5, inR = MORTAR + rnd() * 2.5;
      const inT = MORTAR + rnd() * 2, inB = MORTAR + rnd() * 2;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const dx = Math.min(x - x0 - inL, x0 + w - 1 - inR - x);
          const dy = Math.min(y - y0 - inT, y1 - 1 - inB - y);
          const d = Math.min(dx, dy) + (wob(x, y) - 0.5) * 2.2;
          if (d <= 0) continue; // mortar stays at 0
          const xi = ((x % SIZE) + SIZE) % SIZE;
          const i = y * SIZE + xi; // y is always in [0,SIZE)
          const p = smooth(Math.min(1, d / BEVEL));
          h[i]! += blockH * p;
          tone[i]! += toneOff * p;
        }
      }
      // face mottle (wrapped blotches kept inside the block-ish)
      const mottles = 6 + Math.floor(rnd() * 4);
      for (let k = 0; k < mottles; k++) {
        wrapStamp(h, x0 + MORTAR + rnd() * (w - MORTAR * 2), y0 + MORTAR + rnd() * (y1 - y0 - MORTAR * 2),
          4 + rnd() * 12, (rnd() - 0.5) * 0.16);
      }
      // chipped corners/edges: relief dip + LIGHT fresh-stone face (not soot)
      if (rnd() < 0.55) {
        const nChips = 1 + (rnd() < 0.35 ? 1 : 0);
        for (let k = 0; k < nChips; k++) {
          const cx = rnd() < 0.5 ? x0 + MORTAR + rnd() * 8 : x0 + w - MORTAR - rnd() * 8;
          const cy = rnd() < 0.5 ? y0 + MORTAR + rnd() * 5 : y1 - MORTAR - rnd() * 5;
          const rad = 5 + rnd() * 8;
          wrapStamp(h, cx, cy, rad, -blockH * 0.6);
          wrapStamp(chip, cx, cy, rad * 0.9, 0.45);
        }
      }
      // moss creeping along the bottom crevice + sometimes up a vertical joint
      if (rnd() < 0.38) {
        const nM = 2 + Math.floor(rnd() * 3);
        for (let k = 0; k < nM; k++) {
          const mx = x0 + MORTAR + rnd() * (w - MORTAR * 2);
          const my = y1 - MORTAR - 1 + (rnd() - 0.5) * 3;
          wrapStamp(moss, mx, my, 4 + rnd() * 6, 0.85);
          wrapStamp(moss, mx, my, 9 + rnd() * 7, 0.22); // faint halo
        }
        if (rnd() < 0.4) {
          const jx = rnd() < 0.5 ? x0 : x0 + w; // a vertical joint
          for (let k = 0; k < 3; k++) {
            wrapStamp(moss, jx + (rnd() - 0.5) * 3, y1 - MORTAR - 4 - k * 7, 3.5 + rnd() * 3, 0.6 - k * 0.15);
          }
        }
      }
    }
  }
}

/** A couple of warm amber stains weeping down from mortar joints (rare accent). */
function paintAmberStains(amber: Float32Array, layout: Course[], rnd: () => number): void {
  const n = 2 + (rnd() < 0.4 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const row = layout[Math.floor(rnd() * layout.length)]!;
    const yb = row.y0; // a horizontal mortar line
    let x = rnd() * SIZE;
    wrapStamp(amber, x, yb, 6 + rnd() * 3, 0.7); // source blob in the joint
    const steps = 12 + Math.floor(rnd() * 14);
    for (let k = 0; k < steps; k++) {
      x += (rnd() - 0.5) * 1.6;
      wrapStamp(amber, x, yb + k * 2, 3.0, 0.3 * (1 - k / steps)); // fading drip
    }
  }
}

function bakeTextures(
  h: Float32Array, tone: Float32Array, chip: Float32Array, moss: Float32Array,
  amber: Float32Array, rnd: () => number,
): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    return c;
  };
  const albedo = mk(), normal = mk(), rough = mk();
  const aCtx = albedo.getContext('2d')!, nCtx = normal.getContext('2d')!, rCtx = rough.getContext('2d')!;
  const aImg = aCtx.createImageData(SIZE, SIZE), nImg = nCtx.createImageData(SIZE, SIZE), rImg = rCtx.createImageData(SIZE, SIZE);
  const cl = (v: number) => Math.max(0, Math.min(1, v));

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const o = i * 4;
      const grain = (rnd() - 0.5) * 0.05;
      const mv = cl(moss[i]!);
      const av = Math.min(0.8, amber[i]!);
      const tn = tone[i]!;

      // a notch darker than the floor slab; mortar floors are deep indigo shadow
      const lum = cl(0.165 + h[i]! * 0.50 + tn * 0.6 + chip[i]! * 0.10 + grain);
      // tone also drifts hue: lighter blocks slightly warm, darker slightly cooler
      let r = lum * (0.80 + tn * 0.55), g = lum * (0.87 + tn * 0.3), b = lum * (1.18 - tn * 0.2);
      // moss: pull toward a muted dark green (desaturated — must not read "jungle")
      r += (0.16 - r) * mv * 0.55;
      g += (0.27 - g) * mv * 0.55;
      b += (0.14 - b) * mv * 0.55;
      // amber stain: hue-shift at near-constant value (same trick as the slab)
      const wR = cl(lum * 1.5 + 0.07), wG = cl(lum * 1.05 + 0.02), wB = lum * 0.4;
      r += (wR - r) * av; g += (wG - g) * av; b += (wB - b) * av;
      aImg.data[o] = cl(r) * 150; aImg.data[o + 1] = cl(g) * 150; aImg.data[o + 2] = cl(b) * 158; aImg.data[o + 3] = 255;

      // Sobel with WRAP-AROUND sampling so the normal map tiles seamlessly too
      const xl = h[y * SIZE + ((x + SIZE - 1) % SIZE)]!, xr = h[y * SIZE + ((x + 1) % SIZE)]!;
      const yu = h[((y + SIZE - 1) % SIZE) * SIZE + x]!, yd = h[((y + 1) % SIZE) * SIZE + x]!;
      const strength = 2.4;
      let nx = (xl - xr) * strength, ny = (yu - yd) * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      nImg.data[o] = (nx * 0.5 + 0.5) * 255; nImg.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      nImg.data[o + 2] = (nz * 0.5 + 0.5) * 255; nImg.data[o + 3] = 255;

      const rg = cl(0.94 - h[i]! * 0.16 + mv * 0.04 - av * 0.25 - chip[i]! * 0.08);
      rImg.data[o] = rg * 255; rImg.data[o + 1] = rg * 255; rImg.data[o + 2] = rg * 255; rImg.data[o + 3] = 255;
    }
  }
  aCtx.putImageData(aImg, 0, 0); nCtx.putImageData(nImg, 0, 0); rCtx.putImageData(rImg, 0, 0);
  const wrap = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return { map: wrap(albedo), normalMap: wrap(normal), roughnessMap: wrap(rough) };
}

/** Demo panel with box-projected world-scale UVs (front face shows >1 repeat). */
function buildPanelGeometry(w: number, hgt: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, hgt, d).toNonIndexed();
  geo.translate(0, hgt / 2, 0);
  const pos = geo.attributes.position!;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const S = 1 / TEX_WORLD;
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const vx = pos.getX(t + k), vy = pos.getY(t + k), vz = pos.getZ(t + k);
      let u: number, v: number;
      if (az >= ax && az >= ay) { u = vx * S + 0.5; v = vy * S; }        // front/back
      else if (ax >= ay) { u = vz * S + 0.5; v = vy * S; }               // ends
      else { u = vx * S + 0.5; v = vz * S + 0.5; }                       // top/bottom
      uv[(t + k) * 2] = u; uv[(t + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

const stoneWall: LabElement = {
  name: 'Stone wall',
  describe: 'Coursed-block tower wall: mortar shadow lines, chipped edges, moss + rare amber in crevices. Tiles seamlessly both axes.',
  build(seed: number) {
    const rnd = mulberry32(seed * 104729 + 31);
    const h = new Float32Array(SIZE * SIZE);
    const tone = new Float32Array(SIZE * SIZE);
    const chip = new Float32Array(SIZE * SIZE);
    const moss = new Float32Array(SIZE * SIZE);
    const amber = new Float32Array(SIZE * SIZE);

    const layout = buildLayout(rnd);
    paintBlocks(h, tone, chip, moss, layout, rnd);
    paintAmberStains(amber, layout, rnd);
    // per-pixel micro-relief so block faces have tooth in the normal map
    for (let i = 0; i < h.length; i++) h[i]! += (rnd() - 0.5) * 0.018;

    const { map, normalMap, roughnessMap } = bakeTextures(h, tone, chip, moss, amber, rnd);
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap, roughnessMap,
      normalScale: new THREE.Vector2(1.0, 1.0),
      metalness: 0.0,
    });
    const panel = new THREE.Mesh(buildPanelGeometry(3.4, 2.9, 0.3), mat);
    panel.castShadow = panel.receiveShadow = true;
    return { root: panel, radius: 2.6 };
  },
};

export default stoneWall;
