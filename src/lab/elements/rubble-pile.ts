// ============================================================================
// rubble-pile — quiet stone-debris scatter for wall bases and stair corners.
// ============================================================================
//
// GROUNDING decoration, deliberately non-distracting: a low elongated drift of
// broken masonry (jittered box fragments) and rounded rubble (jittered icosa),
// half-sunk, biggest chunks at the core, fines feathering the edges. All chunks
// merge into ONE draw call; per-chunk value variation rides vertex colors so a
// single flat-shaded material still reads hand-placed. Palette is the slab's
// desaturated cool gray with a rare faint moss tint — it must recede, never pop.
//
// Static (no update). Footprint is elongated along X so placement code can yaw
// it parallel to a wall or tuck it into a stair corner.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type LabElement, mulberry32 } from '../element.ts';

/**
 * Displace vertices by a hash of their (quantized) position so coincident
 * vertices move together — irregular silhouettes without cracking the mesh.
 * NB: quantize via Math.round (+0 to kill -0), NOT toFixed — near-zero seam
 * vertices can differ by ~1e-16 and toFixed(3) renders them as "0.000" vs
 * "-0.000" → different keys → the seam tears open into a slit.
 */
const q3 = (v: number): number => Math.round(v * 1000) + 0;
function jitterWelded(geo: THREE.BufferGeometry, rnd: () => number, amp: number): void {
  const pos = geo.attributes.position!;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${q3(pos.getX(i))}|${q3(pos.getY(i))}|${q3(pos.getZ(i))}`;
    let d = seen.get(k);
    if (!d) {
      d = [(rnd() - 0.5) * amp, (rnd() - 0.5) * amp, (rnd() - 0.5) * amp];
      seen.set(k, d);
    }
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
}

/** Paint one flat color into a geometry's `color` attribute (for vertexColors). */
function tint(geo: THREE.BufferGeometry, c: THREE.Color): void {
  const count = geo.attributes.position!.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Approx-gaussian in [-1,1] (sum of 2 uniforms, centered). */
function gauss(rnd: () => number): number {
  return rnd() + rnd() - 1;
}

const rubblePile: LabElement = {
  name: 'Rubble pile',
  describe:
    'Merged stone-debris drift (one draw call) for grounding wall bases & stair corners — quiet by design.',
  build(seed: number) {
    const rnd = mulberry32(seed * 24593 + 101);
    const geos: THREE.BufferGeometry[] = [];
    const col = new THREE.Color();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();

    const chunk = (
      kind: 'block' | 'rubble',
      s: number,
      x: number,
      z: number,
      y: number,
      squash: number,
    ): void => {
      let g: THREE.BufferGeometry;
      if (kind === 'block') {
        // cut-masonry fragment: oblong box, lightly battered
        // (.toNonIndexed() so it merges with the non-indexed icosahedra)
        g = new THREE.BoxGeometry(s * (1.1 + rnd() * 0.9), s * (0.55 + rnd() * 0.4), s * (0.7 + rnd() * 0.5)).toNonIndexed();
        jitterWelded(g, rnd, s * 0.22);
      } else {
        g = new THREE.IcosahedronGeometry(s * 0.62, 0);
        jitterWelded(g, rnd, s * 0.3);
      }
      // cool desaturated gray, DARK (must recede against indigo walls);
      // rare moss is a whisper of a hue shift, not a green chunk
      const mossy = rnd() < 0.1;
      col.setHSL(mossy ? 0.34 : 0.63, mossy ? 0.05 : 0.09 + rnd() * 0.04, mossy ? 0.1 + rnd() * 0.04 : 0.1 + rnd() * 0.07);
      tint(g, col);
      e.set(rnd() * Math.PI, rnd() * Math.PI * 2, rnd() * Math.PI);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, squash, 1));
      g.applyMatrix4(m);
      geos.push(g);
    };

    // ---- core: a tight, settled drift — size strictly falls off outward -----
    const coreN = 11 + Math.floor(rnd() * 4);
    for (let i = 0; i < coreN; i++) {
      const x = gauss(rnd) * 0.46;
      const z = gauss(rnd) * 0.24;
      const closeness = 1 - Math.min(1, Math.hypot(x / 0.58, z / 0.32)); // 1 at center
      const s = 0.06 + closeness * (0.1 + rnd() * 0.04);
      // SUNK into the ground (lowest third buried) so the drift reads settled
      const y = s * (rnd() * 0.1 - 0.06) + closeness * 0.045;
      chunk(rnd() < 0.55 ? 'block' : 'rubble', s, x, z, y, 0.72 + rnd() * 0.24);
    }
    // ---- 2–3 perched chunks give the core actual pile height ----------------
    const perchN = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < perchN; i++) {
      const s = 0.08 + rnd() * 0.04;
      chunk(rnd() < 0.6 ? 'block' : 'rubble', s, gauss(rnd) * 0.16, gauss(rnd) * 0.1, 0.09 + rnd() * 0.05, 0.85);
    }
    // ---- fines: small gravel feathering the edge — KEPT ON the drift apron.
    //      Outliers are FOLDED back inside (clamping to the rim just piles
    //      them on the rim with a gap → reads as floating litter) -------------
    const fineN = 10 + Math.floor(rnd() * 5);
    for (let i = 0; i < fineN; i++) {
      let x = gauss(rnd) * 0.56;
      let z = gauss(rnd) * 0.28;
      const d = Math.hypot(x / 0.64, z / 0.34);
      if (d > 0.85) {
        const f = (0.45 + 0.35 * rnd()) / d; // redistribute into the apron body
        x *= f;
        z *= f;
      }
      const s = 0.03 + rnd() * 0.04;
      chunk(rnd() < 0.3 ? 'block' : 'rubble', s, x, z, s * 0.02, 0.7 + rnd() * 0.3);
    }
    // ---- one leaning slab fragment gives the pile a readable silhouette -----
    // (battered, dark, tipped well past 30° and half-buried so it reads as a
    //  fallen fragment, never a clean bright paving tile)
    {
      const s = 0.15 + rnd() * 0.04;
      const g = new THREE.BoxGeometry(s * 1.5, s * 0.28, s * 1.1).toNonIndexed();
      jitterWelded(g, rnd, s * 0.24);
      col.setHSL(0.63, 0.08, 0.105 + rnd() * 0.025);
      tint(g, col);
      const side = rnd() < 0.5 ? 1 : -1;
      e.set(0.55 + rnd() * 0.35, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.25);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(side * (0.18 + rnd() * 0.14), s * 0.16, (rnd() - 0.5) * 0.22), q, new THREE.Vector3(1, 1, 1));
      g.applyMatrix4(m);
      geos.push(g);
    }

    const merged = mergeGeometries(geos)!;
    // contact-AO bake: darken vertices near the ground plane so the drift sits
    // INTO the floor (fake occlusion — the single biggest "grounded" cue)
    {
      const pos = merged.attributes.position!;
      const colors = merged.attributes.color!;
      for (let i = 0; i < pos.count; i++) {
        const k = 0.5 + 0.5 * Math.max(0, Math.min(1, pos.getY(i) / 0.14));
        colors.setXYZ(i, colors.getX(i) * k, colors.getY(i) * k, colors.getZ(i) * k);
      }
    }
    for (const g of geos) g.dispose();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mesh.receiveShadow = true;

    return { root: mesh, radius: 1.15 };
  },
};

export default rubblePile;
