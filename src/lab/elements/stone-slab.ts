// ============================================================================
// stone-slab — procedural stone material on a floor slab (the tower's surface).
// ============================================================================
//
// The reference material for "graphics quality pass": layered value-noise stone
// with a PRIMARY fracture network (few, wide, angular cracks that split the top
// into readable plates at game-camera distance), secondary hairlines, worn and
// chipped edges, and rare warm amber mineral veins (the game's "lit/earned"
// accent, used sparingly). Baked into canvas textures (albedo+normal+roughness)
// from one height field + masks. Palette: cool indigo-night mid-gray — the slab
// must sit INTO the 0x0a0a12 world, never glow against it.
//
// Geometry is a chamfer-edged slab (ExtrudeGeometry, box-projected UVs) so the
// silhouette itself reads "worn stone block", not "machined box".
// ============================================================================

import * as THREE from 'three';
import { type LabElement, mulberry32 } from '../element.ts';

const SIZE = 512;
const W = 3.2; // slab width/depth in units; the canvas spans exactly the top face

// ---------------------------------------------------------------------------
// height-field painters (all write into Float32Array fields in 0-ish ranges)
// ---------------------------------------------------------------------------

/** Layered soft elliptical blotches — large undulation down to fine mottle. */
function paintBlotches(h: Float32Array, rnd: () => number): void {
  const oct = [
    { n: 22, r: 120, amp: 0.09 },
    { n: 80, r: 40, amp: 0.08 },
    { n: 420, r: 10, amp: 0.06 },
  ];
  for (const { n, r, amp } of oct) {
    for (let i = 0; i < n; i++) {
      const cx = rnd() * SIZE, cy = rnd() * SIZE;
      const rad = r * (0.5 + rnd());
      const s = (rnd() - 0.5) * 2 * amp;
      const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(SIZE - 1, Math.ceil(cx + rad));
      const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(SIZE - 1, Math.ceil(cy + rad));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy) / rad;
          if (d < 1) h[y * SIZE + x]! += s * (1 - d) * (1 - d);
        }
      }
    }
  }
}

/** Huge ultra-soft tonal zones (albedo-only) so the slab isn't one flat tone at 20u. */
function paintToneZones(tone: Float32Array, rnd: () => number): void {
  for (let i = 0; i < 5; i++) {
    const cx = rnd() * SIZE, cy = rnd() * SIZE;
    const rad = 150 + rnd() * 160;
    const s = (rnd() - 0.5) * 0.14;
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(SIZE - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(SIZE - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d < 1) tone[y * SIZE + x]! += s * (1 - d) * (1 - d);
      }
    }
  }
}

/** Stamp a soft disc into a field (groove if amp<0, halo mask if amp>0). */
function stamp(f: Float32Array, cx: number, cy: number, rad: number, amp: number): void {
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(SIZE - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(SIZE - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / rad;
      if (d < 1) {
        const w = (1 - d * d) ** 1.5;
        f[y * SIZE + x]! += amp * w;
      }
    }
  }
}

/**
 * PRIMARY fractures: few, long, mostly-straight cracks with sharp angular kinks
 * that cross the whole slab — wide dark grooves with a soft dark halo. These are
 * the feature that must read from the game camera (~20u).
 */
function carvePrimaryCracks(
  h: Float32Array, crack: Float32Array, rnd: () => number, count: number,
): void {
  for (let i = 0; i < count; i++) {
    // enter from a random edge, head roughly across
    const side = Math.floor(rnd() * 4);
    let x = side === 0 ? 2 : side === 1 ? SIZE - 3 : rnd() * SIZE;
    let y = side === 2 ? 2 : side === 3 ? SIZE - 3 : rnd() * SIZE;
    const heading = side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? Math.PI / 2 : -Math.PI / 2;
    let ang = heading + (rnd() - 0.5) * 0.9;
    let width = 2.2 + rnd() * 1.2;
    let sinceKink = 0;
    for (let s = 0; s < 300; s++) {
      ang += (rnd() - 0.5) * 0.05; // near-straight between kinks — fracture, not vine
      sinceKink++;
      if (sinceKink > 18 && rnd() < 0.07) {
        ang += (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.4); // sharp angular kink
        // keep overall direction so the crack actually crosses the slab
        const dev = ((ang - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        if (Math.abs(dev) > 1.0) ang = heading + Math.sign(dev) * 1.0;
        sinceKink = 0;
      }
      x += Math.cos(ang) * 3;
      y += Math.sin(ang) * 3;
      if (x < -8 || x > SIZE + 8 || y < -8 || y > SIZE + 8) break;
      width = Math.max(1.4, Math.min(3.4, width + (rnd() - 0.5) * 0.4));
      stamp(h, x, y, width * 1.3, -0.30);            // the groove itself
      stamp(crack, x, y, width * 2.0, 0.10);         // tight darkening halo
      // rare branch — thinner, dies out
      if (rnd() < 0.012) {
        let bx = x, by = y, ba = ang + (rnd() < 0.5 ? 1 : -1) * (0.7 + rnd() * 0.5);
        let bw = width * 0.5;
        for (let t = 0; t < 30 + rnd() * 40; t++) {
          ba += (rnd() - 0.5) * 0.12;
          bx += Math.cos(ba) * 2.6; by += Math.sin(ba) * 2.6;
          if (bx < 1 || bx > SIZE - 2 || by < 1 || by > SIZE - 2) break;
          bw = Math.max(1.0, bw - 0.012);
          stamp(h, bx, by, bw * 1.3, -0.22);
          stamp(crack, bx, by, bw * 1.9, 0.08);
        }
      }
    }
  }
}

/** Secondary hairlines — fine surface crazing, much shallower than primaries. */
function carveHairlines(h: Float32Array, crack: Float32Array, rnd: () => number, count: number): void {
  for (let i = 0; i < count; i++) {
    let x = rnd() * SIZE, y = rnd() * SIZE, ang = rnd() * Math.PI * 2;
    const len = 40 + rnd() * 60;
    for (let s = 0; s < len; s++) {
      ang += (rnd() - 0.5) * 0.5;
      x += Math.cos(ang) * 2.2; y += Math.sin(ang) * 2.2;
      if (x < 1 || x > SIZE - 2 || y < 1 || y > SIZE - 2) break;
      stamp(h, x, y, 1.6, -0.10);
      stamp(crack, x, y, 3.0, 0.05);
    }
  }
}

/** Warm amber mineral veins — the RARE accent. Thin, slightly proud, low-roughness. */
function paintVeins(h: Float32Array, vein: Float32Array, rnd: () => number, count: number): void {
  for (let i = 0; i < count; i++) {
    let x = rnd() * SIZE, y = rnd() * SIZE, ang = rnd() * Math.PI * 2;
    for (let s = 0; s < 90 + rnd() * 80; s++) {
      ang += (rnd() - 0.5) * 0.3;
      x += Math.cos(ang) * 2.0; y += Math.sin(ang) * 2.0;
      if (x < 1 || x > SIZE - 2 || y < 1 || y > SIZE - 2) break;
      stamp(h, x, y, 1.5, 0.04);     // slightly proud of the surface
      stamp(vein, x, y, 1.6, 0.55);  // tight warm core
      stamp(vein, x, y, 3.0, 0.08);  // faint warm bloom
    }
  }
}

/** Worn border band + chips bitten out of the slab edge (canvas border = slab edge). */
function wearEdges(h: Float32Array, crack: Float32Array, rnd: () => number): void {
  const E = 12; // tight border band so the top doesn't read "pillowed"
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y);
      if (d < E) {
        const e = 1 - d / E;
        h[y * SIZE + x]! -= e * e * 0.09;
        crack[y * SIZE + x]! += e * e * 0.22;
      }
    }
  }
  // chips: half-discs centred on the border so they bite into the edge
  for (let i = 0; i < 7; i++) {
    const side = Math.floor(rnd() * 4);
    const t = rnd() * SIZE;
    const cx = side === 0 ? 0 : side === 1 ? SIZE - 1 : t;
    const cy = side === 2 ? 0 : side === 3 ? SIZE - 1 : t;
    const rad = 8 + rnd() * 11;
    stamp(h, cx, cy, rad, -0.34);
    stamp(crack, cx, cy, rad * 1.2, 0.1); // mostly relief — chips aren't soot

  }
}

// ---------------------------------------------------------------------------
// bake: height + masks → albedo / normal / roughness canvases
// ---------------------------------------------------------------------------

function bakeTextures(
  h: Float32Array, crack: Float32Array, vein: Float32Array, tone: Float32Array, rnd: () => number,
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
      const grain = (rnd() - 0.5) * 0.05; // fine per-pixel stone grain (albedo only)
      const cv = cl(crack[i]!);
      const vv = Math.min(0.85, vein[i]!);
      const tn = tone[i]!;

      // value: indigo-night mid-gray. Hollows drop hard, highs stay restrained.
      const lum = cl(0.355 + h[i]! * 0.62 + grain) * (1 - cv * 0.62);
      // cool indigo cast; tone zones drift it subtly warm/cool
      let r = lum * (0.82 + tn * 0.5);
      let g = lum * (0.88 + tn * 0.25);
      let b = lum * (1.16 - tn * 0.15);
      // amber mineral vein accent: shift HUE at near-constant value so it reads
      // as warm mineral in the stone, not a pale painted line
      const warmR = cl(lum * 1.5 + 0.08), warmG = cl(lum * 1.05 + 0.03), warmB = lum * 0.42;
      r += (warmR - r) * vv;
      g += (warmG - g) * vv;
      b += (warmB - b) * vv;
      aImg.data[o] = cl(r) * 150; aImg.data[o + 1] = cl(g) * 150; aImg.data[o + 2] = cl(b) * 158; aImg.data[o + 3] = 255;

      // normal from height (Sobel), z-up tangent space
      const xl = h[y * SIZE + Math.max(0, x - 1)]!, xr = h[y * SIZE + Math.min(SIZE - 1, x + 1)]!;
      const yu = h[Math.max(0, y - 1) * SIZE + x]!, yd = h[Math.min(SIZE - 1, y + 1) * SIZE + x]!;
      const strength = 2.8;
      let nx = (xl - xr) * strength, ny = (yu - yd) * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      nImg.data[o] = (nx * 0.5 + 0.5) * 255; nImg.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      nImg.data[o + 2] = (nz * 0.5 + 0.5) * 255; nImg.data[o + 3] = 255;

      // rough everywhere, roughest in cracks, a faint sheen on veins + high spots
      const rg = cl(0.92 - h[i]! * 0.25 + cv * 0.05 - vv * 0.30);
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

// ---------------------------------------------------------------------------
// geometry: chamfer-edged slab with box-projected UVs (top face = full canvas)
// ---------------------------------------------------------------------------

function buildSlabGeometry(): THREE.BufferGeometry {
  const corner = 0.10; // rounded plan corners
  const half = W / 2;
  const s = new THREE.Shape();
  s.moveTo(-half + corner, -half);
  s.lineTo(half - corner, -half);
  s.quadraticCurveTo(half, -half, half, -half + corner);
  s.lineTo(half, half - corner);
  s.quadraticCurveTo(half, half, half - corner, half);
  s.lineTo(-half + corner, half);
  s.quadraticCurveTo(-half, half, -half, half - corner);
  s.lineTo(-half, -half + corner);
  s.quadraticCurveTo(-half, -half, -half + corner, -half);

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.4, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.045,
    bevelSegments: 2, steps: 1, curveSegments: 3,
  });
  geo.rotateX(-Math.PI / 2); // extrusion axis → up
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);

  // box-projected UVs at uniform world density (1 canvas = W units); the top
  // face spans exactly 0..1 so the edge-wear band in the texture lands on the
  // slab's physical edges. Sides sample a mid-texture band (offset 0.3) so they
  // show generic strata, not the border vignette.
  const pos = geo.attributes.position!;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t); b.fromBufferAttribute(pos, t + 1); c.fromBufferAttribute(pos, t + 2);
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const vx = pos.getX(t + k), vy = pos.getY(t + k), vz = pos.getZ(t + k);
      let u: number, v: number;
      if (ay >= ax && ay >= az) { u = vx / W + 0.5; v = vz / W + 0.5; }
      else if (ax >= az) { u = vz / W + 0.5; v = 0.3 + vy / W; }
      else { u = vx / W + 0.5; v = 0.3 + vy / W; }
      uv[(t + k) * 2] = u; uv[(t + k) * 2 + 1] = v;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.deleteAttribute('normal');
  geo.computeVertexNormals(); // non-indexed → flat facets (crisp chamfer light)
  return geo;
}

const stoneSlab: LabElement = {
  name: 'Stone slab',
  describe: 'Indigo-night cracked stone floor: plate fractures, worn chamfered edges, rare amber veins.',
  build(seed: number) {
    const rnd = mulberry32(seed * 7919 + 17);
    const h = new Float32Array(SIZE * SIZE);
    const crack = new Float32Array(SIZE * SIZE);
    const vein = new Float32Array(SIZE * SIZE);
    const tone = new Float32Array(SIZE * SIZE);

    paintBlotches(h, rnd);
    // per-pixel micro-relief so the normal map has tooth (kills the plastic look)
    for (let i = 0; i < h.length; i++) h[i]! += (rnd() - 0.5) * 0.022;
    paintToneZones(tone, rnd);
    carvePrimaryCracks(h, crack, rnd, 2 + Math.floor(rnd() * 2));
    carveHairlines(h, crack, rnd, 4);
    paintVeins(h, vein, rnd, 1 + (rnd() < 0.5 ? 1 : 0));
    wearEdges(h, crack, rnd);

    const { map, normalMap, roughnessMap } = bakeTextures(h, crack, vein, tone, rnd);
    const mat = new THREE.MeshStandardMaterial({
      map, normalMap, roughnessMap,
      normalScale: new THREE.Vector2(1.0, 1.0),
      metalness: 0.0,
    });
    const slab = new THREE.Mesh(buildSlabGeometry(), mat);
    slab.castShadow = slab.receiveShadow = true;
    return { root: slab, radius: 2.4 };
  },
};

export default stoneSlab;
