// ============================================================================
// stair-room — a ROOM WorldObject that COMPOSES other objects (docs/15).
// ============================================================================
//
// The top abstraction level: walls + floor + a staircase, with a real Door
// object placed in the doorway (composition — a room is built FROM objects, not
// from scratch). 'lit' adds a torch glow. Pure view-layer + seeded.
// ============================================================================

import * as THREE from 'three';
import door from './door.ts';
import type { WorldObject, WorldObjectBuild, FootprintBox } from '../world-object.ts';

const VARIANTS = ['lit', 'plain'] as const;
const ROOM = 6, WALL_H = 3, WALL_T = 0.3;

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}

const stairRoom: WorldObject = {
  name: 'Staircase room',
  describe: 'A whole room composed FROM objects: stone walls + floor + a climbable staircase + a real Door object in the doorway.',
  level: 'room',
  variants: [...VARIANTS],
  build(variant: string, seed: number): WorldObjectBuild {
    const v = (VARIANTS as readonly string[]).includes(variant) ? variant : VARIANTS[0];
    const root = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0x4a4a55, roughness: 0.92, metalness: 0 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x5a5a66, roughness: 0.95, metalness: 0 });
    const step = new THREE.MeshStandardMaterial({ color: 0x52525e, roughness: 0.9, metalness: 0 });
    const boxes: FootprintBox[] = [];
    const wall = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
      root.add(box(w, h, d, stone, x, y, z));
      boxes.push({ cx: x, cy: y, cz: z, hx: w / 2, hy: h / 2, hz: d / 2 });
    };

    root.add(box(ROOM, 0.2, ROOM, floor, 0, -0.1, 0));               // floor slab
    wall(ROOM, WALL_H, WALL_T, 0, WALL_H / 2, -ROOM / 2);            // back
    wall(WALL_T, WALL_H, ROOM, -ROOM / 2, WALL_H / 2, 0);            // left
    wall(WALL_T, WALL_H, ROOM, ROOM / 2, WALL_H / 2, 0);            // right

    // front wall with a DOORWAY gap (two jamb segments + a lintel)
    const gap = 1.7, segW = (ROOM - gap) / 2;
    wall(segW, WALL_H, WALL_T, -(gap / 2 + segW / 2), WALL_H / 2, ROOM / 2);
    wall(segW, WALL_H, WALL_T, gap / 2 + segW / 2, WALL_H / 2, ROOM / 2);
    wall(gap + 0.4, WALL_H - 2.5, WALL_T, 0, WALL_H - (WALL_H - 2.5) / 2, ROOM / 2);

    // COMPOSE: a real Door object dropped into the opening (proves the hierarchy)
    const d = door.build('handled', seed);
    d.root.position.set(0, 0, ROOM / 2);
    root.add(d.root);
    if (d.footprint) for (const b of d.footprint.boxes) boxes.push({ ...b, cz: b.cz + ROOM / 2 });

    // a staircase climbing toward the back-left corner
    const steps = 8, stepH = 0.28, stepD = 0.42;
    for (let i = 0; i < steps; i++) {
      root.add(box(1.9, stepH * (i + 1), stepD, step, -1.4, (stepH * (i + 1)) / 2, -ROOM / 2 + WALL_T + 0.3 + i * stepD));
    }

    if (v === 'lit') {
      const light = new THREE.PointLight(0xffb060, 14, 9, 2);
      light.position.set(1.6, 2.1, -1.4); root.add(light);
      const torch = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xffd27f, emissive: 0xff8a1e, emissiveIntensity: 2.4 }));
      torch.position.copy(light.position); root.add(torch);
    }

    return { root, radius: 4.6, footprint: { boxes } };
  },
};

export default stairRoom;
