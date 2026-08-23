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

/**
 * OPEN THE DOORWAY. `wall_doorway` ships with its door LEAF as a separate node — 620 of the file's
 * 1068 triangles, a hinged panel filling the aperture — so a loader that keeps every node produces a
 * SOLID wall from a mesh whose whole point is the hole in it. Measured: 0% open as shipped, 32.9% and
 * a 2.00 x 2.30 floor-rooted opening with the leaf gone.
 *
 * We draw it only for wall types the graph calls walk-through, so the leaf is a lie about passability
 * and has to go. Hiding it is the blunt version; the nicer one is to swing it open on its hinge, which
 * needs the view layer to own a little state and is worth doing when doors become interactive.
 */
/** `…#open` asks for the leaf to come out. It also keys the cache separately, so the same file can be
 *  loaded once shut and once open. */
export const wantsOpen = (url: string): boolean => url.endsWith('#open');
export const stripFragment = (url: string): string => url.replace(/#.*$/, '');

export function openDoorLeaves(root: THREE.Object3D): THREE.Object3D {
  const doomed: THREE.Object3D[] = [];
  root.traverse((o) => { if (/_door$/i.test(o.name)) doomed.push(o); });
  for (const o of doomed) o.removeFromParent();
  return root;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

/**
 * URLs that failed to load, with the reason. A missing mesh draws a red wireframe box and USED TO SAY
 * NOTHING ELSE — you got a red box in the middle of a floor with no way to tell whether the file was
 * absent, the path wrong, or the GLB corrupt. Every failure is recorded here instead, so the editor and
 * the snapshot harness can both report it.
 */
const failures = new Map<string, string>();
export const loadFailures = (): { url: string; why: string }[] =>
  [...failures].sort(([a], [b]) => (a < b ? -1 : 1)).map(([url, why]) => ({ url, why }));

function template(url: string): Promise<THREE.Object3D> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(stripFragment(url)).then((g) => (wantsOpen(url) ? openDoorLeaves(g.scene) : g.scene), (e: unknown) => {
      failures.set(url, e instanceof Error ? e.message : String(e));
      throw e instanceof Error ? e : new Error(String(e));
    });
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
  // a GLB can also load "successfully" with no scene, which is not a rejection — record that too, or a
  // red box appears with nothing in `loadFailures` to explain it
  if (!src) failures.set(p.url, failures.get(p.url) ?? 'loaded but produced no scene');
  const node = src ? src.clone(true) : missing();
  // cell-local offsets are in HALF-CELL units (±1 is an edge), so they scale by CELL/2 — but `y` is
  // already in world units and must NOT be scaled with them
  node.position.set(cx + toFloat(p.x) * (CELL / 2), toFloat(p.y), cz + toFloat(p.z) * (CELL / 2));
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
  m.name = MISSING_TAG; // so a red box in a render can be COUNTED, not squinted at
  return m;
}

/** Marks the stand-in mesh. `countMissing` is the answer to "is that red thing a missing model?". */
export const MISSING_TAG = 'cell-preview:missing';
export function countMissing(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => { if (o.name === MISSING_TAG) n++; });
  return n;
}
