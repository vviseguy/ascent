// ============================================================================
// src/lab/cell-preview.ts — the 3D view of a resolved 2u grid.
// ============================================================================
//
// A VIEW ADAPTER, nothing more. `src/floor/cell-place.ts` decides which mesh goes where, in
// fixed-point; this converts that to floats and hangs the GLBs in a Three scene. It must never decide
// placement itself — the sim owns that, and the collider composes its boxes from the same list, which
// is what keeps render and collision in agreement without either being re-proven against the other.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toFloat } from '../sim/fixed/fixed.ts';
import { gridPlacements, type CellPlacement } from '../floor/cell-place.ts';
import type { Cell } from '../floor/cell.ts';

/** Quarter-turn → radians, matching the authority's CCW turns (3 → −90° = 270°). */
const TURN_RAD = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** World size of one cell. The sim's cell is 2u and the meshes are authored to match. */
export const CELL = 2;

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

function template(url: string): Promise<THREE.Object3D> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => g.scene);
    cache.set(url, p);
  }
  return p;
}

/** Preload every mesh a grid needs, so building the scene does not pop in piece by piece. */
export async function preloadFor(cells: readonly (Cell | null)[], w: number, h: number, floorExtent?: { w: number; h: number }): Promise<void> {
  const urls = new Set<string>();
  for (const e of gridPlacements(cells, w, h, floorExtent)) for (const p of e.placements) urls.add(p.url);
  await Promise.all([...urls].sort().map((u) => template(u).catch(() => new THREE.Object3D())));
}

/**
 * Build the group for a resolved grid. Placements are CELL-LOCAL, so each is offset by its cell's
 * world position — the same offset the tower applies when it lowers cells into the world.
 */
export async function buildGrid(cells: readonly (Cell | null)[], w: number, h: number, floorExtent?: { w: number; h: number }): Promise<THREE.Group> {
  const group = new THREE.Group();
  await preloadFor(cells, w, h, floorExtent);
  for (const { x, y, placements } of gridPlacements(cells, w, h, floorExtent)) {
    // cell centre in world space, with the grid centred on the origin so orbiting feels right
    const cx = (x - (w - 1) / 2) * CELL;
    const cz = (y - (h - 1) / 2) * CELL;
    for (const p of placements) group.add(await instance(p, cx, cz));
  }
  return group;
}

async function instance(p: CellPlacement, cx: number, cz: number): Promise<THREE.Object3D> {
  const src = await template(p.url).catch(() => null);
  const node = src ? src.clone(true) : missing();
  // cell-local offsets are in HALF-CELL units (±1 is an edge), so they scale by CELL/2
  node.position.set(cx + toFloat(p.x) * (CELL / 2), 0, cz + toFloat(p.z) * (CELL / 2));
  node.rotation.y = TURN_RAD[p.turn] ?? 0;
  const s = toFloat(p.scale);
  node.scale.setScalar(s);
  return node;
}

/** A visible stand-in when a GLB is missing, so a gap in the catalog reads as a gap rather than as
 *  nothing having been placed. */
function missing(): THREE.Object3D {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.6, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xd95a5a, wireframe: true }),
  );
  m.position.y = 0.8;
  return m;
}
