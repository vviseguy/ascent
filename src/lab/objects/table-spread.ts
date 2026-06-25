// ============================================================================
// table-spread — a GROUPING WorldObject: a table + draped cloth (+ a set).
// ============================================================================
//
// One level up from a single object (docs/15): a composed prefab. 'feast' adds
// plates + a candle on top of the 'plain' table+cloth. Pure view-layer + seeded.
// ============================================================================

import * as THREE from 'three';
import { mulberry32 } from '../element.ts';
import type { WorldObject, WorldObjectBuild } from '../world-object.ts';

const VARIANTS = ['feast', 'plain'] as const;
const T_W = 2.2, T_D = 1.0, T_H = 0.86, TOP_T = 0.1;

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}

const tableSpread: WorldObject = {
  name: 'Table (with spread)',
  describe: 'A grouping/prefab: wood table + draped cloth; "feast" adds plates + a lit candle. Composition above a single object.',
  level: 'grouping',
  variants: [...VARIANTS],
  build(variant: string, seed: number): WorldObjectBuild {
    const v = (VARIANTS as readonly string[]).includes(variant) ? variant : VARIANTS[0];
    const rnd = mulberry32(seed * 99991 + 3);
    const root = new THREE.Group();

    const wood = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    wood.color.setHSL(0.08, 0.4, 0.22 + (rnd() - 0.5) * 0.03);
    const cloth = new THREE.MeshStandardMaterial({ color: 0x7a2b2b, roughness: 0.96, metalness: 0 });

    // table top + 4 legs
    root.add(box(T_W, TOP_T, T_D, wood, 0, T_H, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      root.add(box(0.13, T_H, 0.13, wood, sx * (T_W / 2 - 0.16), T_H / 2, sz * (T_D / 2 - 0.16)));
    }
    // cloth: a thin runner over the top, hanging over the front & back edges
    root.add(box(T_W * 0.78, 0.04, T_D + 0.34, cloth, 0, T_H + TOP_T / 2 + 0.02, 0));
    root.add(box(T_W * 0.78, 0.34, 0.03, cloth, 0, T_H - 0.13, T_D / 2 + 0.15));
    root.add(box(T_W * 0.78, 0.34, 0.03, cloth, 0, T_H - 0.13, -(T_D / 2 + 0.15)));

    if (v === 'feast') {
      const plateMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.55, metalness: 0 });
      for (let i = 0; i < 3; i++) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.03, 16), plateMat);
        p.position.set(-0.6 + i * 0.6, T_H + TOP_T / 2 + 0.04, 0); p.castShadow = true; root.add(p);
      }
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.22, 10),
        new THREE.MeshStandardMaterial({ color: 0xe8e0c0, roughness: 0.6 }));
      candle.position.set(0.72, T_H + TOP_T / 2 + 0.13, -0.24); candle.castShadow = true; root.add(candle);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 8),
        new THREE.MeshStandardMaterial({ color: 0xffd27f, emissive: 0xff8a1e, emissiveIntensity: 2.2 }));
      flame.position.set(0.72, T_H + TOP_T / 2 + 0.29, -0.24); root.add(flame);
    }

    return { root, radius: 1.9, footprint: { boxes: [{ cx: 0, cy: T_H / 2, cz: 0, hx: T_W / 2, hy: T_H / 2, hz: T_D / 2 }] } };
  },
};

export default tableSpread;
