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
import { gridPlacements, stairFlight, type CellPlacement, type GridOptions } from '../floor/cell-place.ts';
import { isStairFloor, type Cell } from '../floor/cell.ts';

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
export async function preloadFor(cells: readonly (Cell | null)[], w: number, h: number, floorExtent?: { w: number; h: number }, opts: GridOptions = {}): Promise<void> {
  const urls = new Set<string>();
  for (const e of gridPlacements(cells, w, h, floorExtent, opts)) for (const p of e.placements) urls.add(p.url);
  await Promise.all([...urls].sort().map((u) => template(u).catch(() => new THREE.Object3D())));
}

/**
 * Build the group for a resolved grid. Placements are CELL-LOCAL, so each is offset by its cell's
 * world position — the same offset the tower applies when it lowers cells into the world.
 */
export async function buildGrid(cells: readonly (Cell | null)[], w: number, h: number, floorExtent?: { w: number; h: number }, opts: GridOptions = {}): Promise<THREE.Group> {
  const group = new THREE.Group();
  await preloadFor(cells, w, h, floorExtent, opts);
  const cut = stairBoxes(cells, w, h, opts);
  const patched = new Map<string, THREE.Material>();   // one patched material per URL, per DECK
  for (const { x, y, placements } of gridPlacements(cells, w, h, floorExtent, opts)) {
    // cell centre in world space, with the grid centred on the origin so orbiting feels right
    const cx = (x - (w - 1) / 2) * CELL;
    const cz = (y - (h - 1) / 2) * CELL;
    for (const p of placements) {
      const node = await instance(p, cx, cz);
      if (cut.length && cutsForStairs(p.url)) applyStairCut(node, cut, patched);
      group.add(node);
    }
  }
  return group;
}

/**
 * THE WORLD RECTANGLES A STAIRCASE OCCUPIES on this deck, in the same coordinates `buildGrid` places
 * into. Empty when there are no flights, which is the common case and costs nothing.
 */
function stairBoxes(
  cells: readonly (Cell | null)[], w: number, h: number, opts: GridOptions,
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x];
      if (!c || !isStairFloor(c.floor)) continue;
      const same = (ax: number, ay: number): boolean =>
        ax >= 0 && ay >= 0 && ax < w && ay < h && cells[ay * w + ax]?.floor === c.floor;
      if (same(x - 1, y) || same(x, y - 1)) continue;          // only the block's origin reports
      const fl = stairFlight(cells, w, h, x, y, opts.above);
      if (!fl) continue;
      /* EXACTLY THE BLOCK, not the mesh. The mesh is 5.00 across a 4.00 block, so half a unit of
         banister sits outside it — and growing the cut to cover that was tried and REJECTED on sight:
         it takes a bite out of the wall run either side of the flight, which is far more noticeable
         than the overlap it was fixing. A wall is better slightly intersected than visibly holed.
         The game's cut is the same size, so the editor and the tower agree. */
      const x0 = (fl.x - (w - 1) / 2) * CELL - CELL / 2, z0 = (fl.y - (h - 1) / 2) * CELL - CELL / 2;
      out.push([x0, z0, x0 + fl.bw * CELL, z0 + fl.bh * CELL]);
    }
  }
  return out;
}

/**
 * SHOULD THIS PIECE BE CUT WHERE A STAIRCASE STANDS? Everything except the staircase itself and the
 * ground: a flight must not clip itself, and the deck under a flight is already suppressed when the
 * placements are emitted, so cutting it again would open a hole through the storey.
 */
const cutsForStairs = (url: string): boolean => !/stairs|floor_/.test(url);

/**
 * CUT A PIECE WHERE THE STAIRCASE IS — the editor's half of the game's stair clip.
 *
 * A stair mesh is 5.00 across a 4.00 block: half a unit of banister hangs over each flank by design,
 * and a wall standing under the raised end of a flight ends up inside the same space. `discard` in
 * the fragment shader removes the wall's geometry there instead of drawing both and letting the depth
 * buffer produce a seam — the same technique as the occlusion cutaway, and for the same reason: no
 * blending, no sort order, nothing to get wrong.
 *
 * ONE PATCHED MATERIAL PER URL PER DECK. `Object3D.clone` shares materials with its template, so
 * patching in place would clip every OTHER deck by this deck's staircases; and patching per instance
 * would make a material for every wall segment on screen. Per url, per deck, is the middle.
 */
function applyStairCut(
  node: THREE.Object3D, boxes: readonly [number, number, number, number][],
  cache: Map<string, THREE.Material>,
): void {
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!src) return;
    const key = src.uuid;
    let mat = cache.get(key);
    if (!mat) {
      mat = src.clone();
      const arr = new Float32Array(16);                         // up to 4 boxes, xz min/max
      const n = Math.min(4, boxes.length);
      for (let i = 0; i < n; i++) arr.set(boxes[i]!, i * 4);
      const prev = mat.onBeforeCompile?.bind(mat);
      mat.onBeforeCompile = (shader, renderer): void => {
        prev?.(shader, renderer);
        shader.uniforms['uCutBox'] = { value: arr };
        shader.uniforms['uCutN'] = { value: n };
        shader.vertexShader = 'varying vec3 vCutW;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vCutW = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
        shader.fragmentShader = 'uniform float uCutBox[16];\nuniform int uCutN;\nvarying vec3 vCutW;\n'
          + shader.fragmentShader.replace('void main() {', `void main() {
            for (int i = 0; i < 4; i++) {
              if (i >= uCutN) break;
              if (vCutW.x > uCutBox[i * 4] && vCutW.x < uCutBox[i * 4 + 2]
                  && vCutW.z > uCutBox[i * 4 + 1] && vCutW.z < uCutBox[i * 4 + 3]) discard;
            }`);
      };
      // EXTEND the cache key, never replace it: the tiling shader sets one too, and dropping it makes
      // two materials share a compiled program that differs.
      const prevKey = mat.customProgramCacheKey?.bind(mat);
      mat.customProgramCacheKey = (): string => `${prevKey?.() ?? ''}|staircut${n}`;
      mat.needsUpdate = true;
      cache.set(key, mat);
    }
    m.material = mat;
  });
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
