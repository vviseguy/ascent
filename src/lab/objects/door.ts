// ============================================================================
// door — a WorldObject with three VARIANTS: 'plain' | 'barred' | 'handled'.
// ============================================================================
//
// The canonical "one model, different modes/versions" example (docs/15): a
// stone-framed wood leaf, plus per-variant ironwork —
//   plain   : iron straps + clavos (a plain reinforced door)
//   barred  : an upper window crossed by vertical METAL BARS (a cell/gate door)
//   handled : a ring HANDLE on a backplate + strap hinges (an openable room door)
//
// Pure view-layer + seeded: same (variant, seed) → same look. The `footprint` is
// the closed leaf's AABB, so the SAME definition can drive the collider later.
// Base at local y=0; hinge side is -X, the handle/opening side is +X.
// ============================================================================

import * as THREE from 'three';
import { mulberry32 } from '../element.ts';
import type { WorldObject, WorldObjectBuild } from '../world-object.ts';

const LEAF_W = 1.2, LEAF_H = 2.2, LEAF_T = 0.14;
const JAMB_W = 0.2, JAMB_D = 0.34;
const VARIANTS = ['plain', 'barred', 'handled'] as const;

/** A positioned, shadowed box. */
function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
/** A clavo / stud bolt (the iron studs that march along straps). */
function clavo(mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const c = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), mat);
  c.position.set(x, y, z); c.scale.z = 0.5; c.castShadow = true;
  return c;
}

const door: WorldObject = {
  name: 'Door',
  describe: 'Stone-framed wood door — variants swap the ironwork: plain straps · barred cell window · ring handle.',
  level: 'object',
  variants: [...VARIANTS],
  build(variant: string, seed: number): WorldObjectBuild {
    const v = (VARIANTS as readonly string[]).includes(variant) ? variant : VARIANTS[0];
    const rnd = mulberry32(seed * 2654435761 + 7);
    const root = new THREE.Group();

    // ---- materials (self-contained; slight seeded wood drift) ----
    const wood = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
    wood.color.setHSL(0.08 + (rnd() - 0.5) * 0.02, 0.42, 0.24 + (rnd() - 0.5) * 0.04);
    const woodDark = wood.clone(); woodDark.color = wood.color.clone().multiplyScalar(0.55);
    const iron = new THREE.MeshStandardMaterial({ color: 0x2c2d34, roughness: 0.42, metalness: 0.85 });
    const stone = new THREE.MeshStandardMaterial({ color: 0x4c4c58, roughness: 0.93, metalness: 0 });

    // ---- stone frame: two jambs + a lintel ----
    const half = LEAF_W / 2 + JAMB_W / 2;
    root.add(box(JAMB_W, LEAF_H + 0.2, JAMB_D, stone, -half, (LEAF_H + 0.2) / 2, 0));
    root.add(box(JAMB_W, LEAF_H + 0.2, JAMB_D, stone, half, (LEAF_H + 0.2) / 2, 0));
    root.add(box(LEAF_W + JAMB_W * 2, JAMB_W, JAMB_D, stone, 0, LEAF_H + 0.2 + JAMB_W / 2, 0));

    // ---- the wood leaf (a group so variants decorate it) ----
    const leaf = new THREE.Group();
    leaf.add(box(LEAF_W, LEAF_H, LEAF_T, wood, 0, LEAF_H / 2, 0));         // the panel
    for (let i = 1; i <= 3; i++) {                                         // 3 plank seams → 4 boards
      leaf.add(box(0.02, LEAF_H - 0.08, 0.02, woodDark, -LEAF_W / 2 + (LEAF_W * i) / 4, LEAF_H / 2, LEAF_T / 2));
    }
    const strap = (y: number): void => {
      leaf.add(box(LEAF_W - 0.06, 0.1, 0.03, iron, 0, y, LEAF_T / 2 + 0.005));
      for (let i = 0; i < 5; i++) leaf.add(clavo(iron, -LEAF_W / 2 + 0.12 + i * ((LEAF_W - 0.24) / 4), y, LEAF_T / 2 + 0.02));
    };

    if (v === 'plain') {
      strap(LEAF_H * 0.25); strap(LEAF_H * 0.72);
    } else if (v === 'barred') {
      strap(LEAF_H * 0.2);
      const winW = 0.8, winH = 0.7, winY = LEAF_H * 0.7;                   // upper window void + iron bars
      const voidMat = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 1 });
      leaf.add(box(winW, winH, 0.04, voidMat, 0, winY, LEAF_T / 2 - 0.06));
      for (let i = 0; i < 5; i++) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, winH + 0.06, 8), iron);
        bar.position.set(-winW / 2 + 0.08 + i * ((winW - 0.16) / 4), winY, LEAF_T / 2 + 0.01); bar.castShadow = true; leaf.add(bar);
      }
      const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, winW + 0.06, 8), iron);
      cross.rotation.z = Math.PI / 2; cross.position.set(0, winY, LEAF_T / 2 + 0.012); leaf.add(cross);
    } else { // handled
      strap(LEAF_H * 0.25); strap(LEAF_H * 0.72);
      const hx = LEAF_W / 2 - 0.22;                                        // ring handle on the +X side
      leaf.add(box(0.16, 0.16, 0.02, iron, hx, LEAF_H * 0.5, LEAF_T / 2 + 0.01));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 8, 18), iron);
      ring.position.set(hx, LEAF_H * 0.5 - 0.06, LEAF_T / 2 + 0.04); ring.castShadow = true; leaf.add(ring);
      for (const hy of [LEAF_H * 0.22, LEAF_H * 0.78]) {                   // strap hinges on the -X side
        leaf.add(box(0.5, 0.09, 0.03, iron, -LEAF_W / 2 + 0.22, hy, LEAF_T / 2 + 0.006));
      }
    }

    root.add(leaf);
    return {
      root, radius: 1.6,
      footprint: { boxes: [{ cx: 0, cy: LEAF_H / 2, cz: 0, hx: LEAF_W / 2, hy: LEAF_H / 2, hz: LEAF_T / 2 }] },
    };
  },
};

export default door;
