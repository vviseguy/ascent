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
import { fromRaw, toFloat } from '../sim/fixed/fixed.ts';
import { gridPlacements, stairFlight, type CellPlacement, type GridOptions } from '../floor/cell-place.ts';
import { cellCentre2u, cellWorldPlacements } from '../game/cell-tower.ts';
import { isStairFloor, type Cell } from '../floor/cell.ts';
import { applyOneSided } from './one-sided.ts';

/** Quarter-turn → radians, matching the authority's CCW turns (3 → −90° = 270°). */
const TURN_RAD = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * WHERE A CELL'S CENTRE IS, in world units — passed rather than assumed.
 *
 * There are two conventions in play and they differ by half a cell on an EVEN-sized grid: this file
 * centres on `(x - (w - 1) / 2)` and the compiler's `cellCentre2u` truncates that term. Whichever a
 * render is using, the STAIR CUT boxes have to use the same one or the discard rectangle lands a unit
 * off the flight it is meant to clear — a wall holed where nothing stands and intact where the
 * banister comes through. So the function is a parameter instead of a repeated expression.
 */
type CellCentre = (x: number, y: number) => [number, number];
const gridCentre = (w: number, h: number): CellCentre =>
  (x, y) => [(x - (w - 1) / 2) * CELL, (y - (h - 1) / 2) * CELL];
/** World size of one cell. The sim's cell is 2u and the meshes are authored to match. */
export const CELL = 2;

/**
 * THE DOOR LEAF IS ITS OWN ASSET NOW, and this is where the old way was.
 *
 * `wall_doorway` ships its leaf as a separate NODE — 620 of the file's 1068 triangles, a hinged panel
 * filling the aperture. The open state used to be an `…#open` url that this loader honoured by
 * deleting every node matching /_door$/i after load, keyed separately so one file could be cached
 * both ways. It drew correctly and that was the whole problem: the fragment is invisible to
 * `objIdOf`, so both states shared ONE id in the approved store, one id holds one footprint, and a
 * SHUT door therefore collided with the open one's 2.00-wide hole in it.
 *
 * `npm run assets:derive` cuts the file into `wall_doorway_open` and `wall_door`. Two files, two
 * ids, two footprints, and no load-time surgery — the placer simply does not emit a leaf for a state
 * that has none. Swinging a door on its hinge, which the old note here wanted, is now just a
 * transform on a placement the view layer can already see.
 */
/** URL → cache key. No piece carries a fragment today; this stays as the normaliser so one ever
 *  reintroduced cannot silently key a second copy of the same file. */
export const stripFragment = (url: string): string => url.replace(/#.*$/, '');

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
    p = loader.loadAsync(stripFragment(url)).then((g) => g.scene, (e: unknown) => {
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
  const cut = stairBoxes(cells, w, h, opts, gridCentre(w, h));
  const patched = new Map<string, THREE.Material>();   // one patched material per URL, per DECK
  for (const { x, y, placements } of gridPlacements(cells, w, h, floorExtent, opts)) {
    const [cx, cz] = gridCentre(w, h)(x, y);
    for (const p of placements) {
      const node = await instance(p, cx, cz);
      if (cut.length && cutsForStairs(p.url)) applyStairCut(node, cut, patched);
      group.add(node);
    }
  }
  return group;
}

/**
 * THE SAME GRID, BUT THROUGH THE COMPILER THE GAME ACTUALLY RUNS.
 *
 * `buildGrid` above draws `gridPlacements` — what `cell-place.ts` emits, one list per cell. The GAME
 * draws `cellWorldPlacements`, which takes that and MERGES: an aligned 2x2 block of matching ground
 * becomes one 4u mesh instead of four 2u ones. Everything else is passed straight through.
 *
 * SO THE TWO ARE NOT THE SAME PICTURE, and for a long time the visual gate could only see the first
 * one. That is how a merged block's pavers came to be twice the size of its unmerged neighbour's with
 * every screenshot in the repo looking fine: the difference lives entirely in the merge, and the
 * merge was invisible here. A gate that cannot see a stage cannot gate it.
 *
 * Cheap because it is the same loader and the same `node()`: the only difference is that a
 * `WorldPlacement` is already in world units, so there is no cell offset to add.
 *
 * NOTE the half-cell offset against `buildGrid`. `cellCentre2u` truncates its centring term
 * (`(w - 1) / 2 | 0`) and this file does not, so on an EVEN-sized grid the two modes sit one unit
 * apart in world space. Harmless on its own — everything in a given render moves together — but it
 * means a `--focus` cell frames one unit differently between the two, which is worth knowing before
 * concluding that a piece moved.
 */
export async function buildCompiled(
  cells: readonly (Cell | null)[], w: number, h: number, opts: GridOptions = {},
): Promise<THREE.Group> {
  const group = new THREE.Group();
  const placements = cellWorldPlacements(cells, w, h, opts.above);
  await Promise.all([...new Set(placements.map((p) => p.unit?.url).filter((u): u is string => !!u))]
    .sort().map((u) => template(u).catch(() => new THREE.Object3D())));
  const cut = stairBoxes(cells, w, h, opts, (x, y) => {
    const c = cellCentre2u(w, h, y * w + x);
    return [toFloat(c.x), toFloat(c.z)];
  });
  const patched = new Map<string, THREE.Material>();
  for (const wp of placements) {
    const u = wp.unit;
    if (!u) continue;
    const o = await node(u.url, toFloat(fromRaw(wp.x)), toFloat(u.y), toFloat(fromRaw(wp.z)),
      u.turn, toFloat(u.scale), u.inverted === true);
    if (cut.length && cutsForStairs(u.url)) applyStairCut(o, cut, patched);
    group.add(o);
  }
  return group;
}

/**
 * THE WORLD RECTANGLES A STAIRCASE OCCUPIES on this deck, in the same coordinates `buildGrid` places
 * into. Empty when there are no flights, which is the common case and costs nothing.
 */
function stairBoxes(
  cells: readonly (Cell | null)[], w: number, h: number, opts: GridOptions, centre: CellCentre,
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
      const [fcx, fcz] = centre(fl.x, fl.y);
      const x0 = fcx - CELL / 2, z0 = fcz - CELL / 2;
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
  // cell-local offsets are in HALF-CELL units (±1 is an edge), so they scale by CELL/2 — but `y` is
  // already in world units and must NOT be scaled with them
  return node(p.url, cx + toFloat(p.x) * (CELL / 2), toFloat(p.y), cz + toFloat(p.z) * (CELL / 2),
    p.turn, toFloat(p.scale), p.inverted === true);
}

/** One placed mesh, in WORLD units. The only place a transform is applied, so the cell-local path and
 *  the compiled-IR path below cannot drift apart on turn, scale or which way a slab faces. */
async function node(
  url: string, wx: number, wy: number, wz: number, turn: number, scale: number, inverted: boolean,
): Promise<THREE.Object3D> {
  const src = await template(url).catch(() => null);
  // a GLB can also load "successfully" with no scene, which is not a rejection — record that too, or a
  // red box appears with nothing in `loadFailures` to explain it
  if (!src) failures.set(url, failures.get(url) ?? 'loaded but produced no scene');
  const o = src ? src.clone(true) : missing();
  o.position.set(wx, wy, wz);
  o.rotation.y = TURN_RAD[((turn % 4) + 4) % 4] ?? 0;
  // a lid hangs upside down — a half-turn about X, which carries the normals round with it
  if (inverted) o.rotation.x = Math.PI;
  o.scale.setScalar(scale);
  /* A SLAB IS ONLY THERE FROM THE SIDE IT FACES. Floor and lid are the same tile, one turned over, so
     without this a floor shows its underside to the room below and a lid shows its back to the room
     above — most obvious with `all` storeys up, where a section reads as a stack of paving. */
  if (isSurfacePiece(url)) applyOneSided(o, !inverted, sideCache);
  return o;
}

/** Ground and lids — the pieces that have a side they face. Walls and dressing look right from
 *  anywhere and must not be touched. */
const isSurfacePiece = (url: string): boolean => /floor_/.test(url);
/** One material per source per side, for the lifetime of the module — templates are shared, so this
 *  cannot live per grid without making a material per storey. */
const sideCache = new Map<string, THREE.Material>();

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
