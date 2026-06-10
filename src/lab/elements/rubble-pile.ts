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
 */
function jitterWelded(geo: THREE.BufferGeometry, rnd: () => number, amp: number): void {
  const pos = geo.attributes.position!;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)}|${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`;
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
    const coreN = 10 + Math.floor(rnd() * 4);
    for (let i = 0; i < coreN; i++) {
      const x = gauss(rnd) * 0.52;
      const z = gauss(rnd) * 0.26;
      const closeness = 1 - Math.min(1, Math.hypot(x / 0.62, z / 0.34)); // 1 at center
      const s = 0.06 + closeness * (0.1 + rnd() * 0.04);
      // mostly sunk; central chunks ride up the mound a little
      const y = s * (0.04 + rnd() * 0.14) + closeness * 0.05;
      chunk(rnd() < 0.55 ? 'block' : 'rubble', s, x, z, y, 0.72 + rnd() * 0.24);
    }
    // ---- 2–3 perched chunks give the core actual pile height ----------------
    const perchN = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < perchN; i++) {
      const s = 0.08 + rnd() * 0.04;
      chunk(rnd() < 0.6 ? 'block' : 'rubble', s, gauss(rnd) * 0.16, gauss(rnd) * 0.1, 0.1 + rnd() * 0.05, 0.85);
    }
    // ---- fines: small gravel feathering the silhouette outward --------------
    const fineN = 12 + Math.floor(rnd() * 6);
    for (let i = 0; i < fineN; i++) {
      const x = Math.max(-0.95, Math.min(0.95, gauss(rnd) * 0.78));
      const z = Math.max(-0.5, Math.min(0.5, gauss(rnd) * 0.4));
      const s = 0.03 + rnd() * 0.04;
      chunk(rnd() < 0.3 ? 'block' : 'rubble', s, x, z, s * 0.05, 0.7 + rnd() * 0.3);
    }
    // ---- one leaning slab fragment gives the pile a readable silhouette -----
    {
      const s = 0.16 + rnd() * 0.05;
      const g = new THREE.BoxGeometry(s * 1.7, s * 0.32, s * 1.25).toNonIndexed();
      jitterWelded(g, rnd, s * 0.16);
      col.setHSL(0.63, 0.09, 0.13 + rnd() * 0.03);
      tint(g, col);
      const side = rnd() < 0.5 ? 1 : -1;
      e.set(0.38 + rnd() * 0.3, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.2);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(side * (0.2 + rnd() * 0.15), s * 0.3, (rnd() - 0.5) * 0.24), q, new THREE.Vector3(1, 1, 1));
      g.applyMatrix4(m);
      geos.push(g);
    }

    const merged = mergeGeometries(geos)!;
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
