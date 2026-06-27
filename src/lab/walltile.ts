// ============================================================================
// src/lab/walltile.ts — the WALL-TILE DEBUG view (walltile.html).
// ============================================================================
//
// Plug a tile's params (per-corner floor, 4 connections, centre axis/type, wallType) into the
// panel and SEE the resolved arrangement built from REAL KayKit Dungeon Remastered meshes
// (no custom boxes) — to eyeball that every input maps to a sane piece + orientation and catch
// resolver/asset/validation errors. Structure pieces come from the architectural registry
// (wall-tile-assets.ts); floors are per-corner; the optional object demo (torch/barrel) shows
// side placement. Everything builds through world-object → recolor → box-fit, the game's path.
//
// SNAPSHOT HOOKS:  __WT_READY · __wtSet(partial) · __wtState()
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  resolveWallTile,
  describeWallTile,
  validateWallTile,
  FLOOR_CORNERS,
  type WallTile,
  type Connection,
  type CentreAxis,
  type CentreType,
  type WallType,
  type FloorMaterial,
  type CornerFloors,
  type FloorCorner,
} from '../floor/wall-tile.ts';
import { wallPieces, floorPieces } from './wall-tile-assets.ts';
import { meshObject, type WorldObject } from './world-object.ts';

/* --------------------------------- constants --------------------------------- */

const HALF = 2; // tile is native 4u → ±2 to each edge
const CONN: Connection[] = ['none', 'wall', 'barrier'];
const AXES: CentreAxis[] = ['none', 'EW', 'NS', 'both'];
const CTYPES: CentreType[] = ['wall', 'barrier'];
const WTS: WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];
const FLOOR_MATS: FloorMaterial[] = ['stone', 'dirt', 'wood', 'none'];

// corner → (x,z) centre of that quarter. E = +X, W = -X, N = -Z, S = +Z.
const CORNER_POS: Record<FloorCorner, readonly [number, number]> = {
  nw: [-1, -1],
  ne: [1, -1],
  sw: [-1, 1],
  se: [1, 1],
};

/* ----------------------- real-asset building (cached) ------------------------ */

// Build KayKit pieces through the real world-object path. Cache one WorldObject per (url,scale);
// the GLB template itself is cached inside world-object.ts, so repeated builds are cheap.
const objCache = new Map<string, WorldObject>();
function pieceObj(url: string, scale: number): WorldObject {
  const key = `${url}@${scale}`;
  let o = objCache.get(key);
  if (!o) {
    o = meshObject({ meshUrl: url, name: url, describe: '', level: 'object', scale, variants: { default: [] } });
    objCache.set(key, o);
  }
  return o;
}
async function buildPiece(url: string, scale = 1): Promise<THREE.Object3D> {
  return (await pieceObj(url, scale).build('default', 0)).root;
}
/** Build an asset and scale its built root to `targetH` game-units tall (for props). */
async function buildSized(url: string, targetH: number): Promise<THREE.Object3D> {
  const root = await buildPiece(url, 1);
  const bb = new THREE.Box3().setFromObject(root);
  const h = bb.max.y - bb.min.y || 1;
  root.scale.multiplyScalar(targetH / h);
  return root;
}

const TORCH = 'models/kaykit_dungeon_remastered/torch_mounted.gltf.glb';
const BARREL = 'models/kaykit_dungeon_remastered/barrel_small.gltf.glb';

/* ----------------------------------- scene ----------------------------------- */

const view = document.getElementById('view') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14141e);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(7, 7, 9);
camera.lookAt(0, 1.4, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(6, 10, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.35);
fill.position.set(-5, 4, -6);
scene.add(fill);

const grid = new THREE.GridHelper(12, 3, 0x445, 0x24243200);
grid.position.y = 0.0;
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;

let group = new THREE.Group();
scene.add(group);

/* ----------------------------------- state ----------------------------------- */

const allF = (m: FloorMaterial): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const DEFAULT: WallTile = { floor: allF('stone'), N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'solid' };
const state: WallTile = { ...DEFAULT, floor: { ...DEFAULT.floor } };
let showObjects = false;
let gen = 0;

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
    }
  });
}

function rebuild(): void {
  gen++;
  const myGen = gen;
  scene.remove(group);
  disposeGroup(group);
  group = new THREE.Group();
  scene.add(group);

  void renderTile(state, myGen);

  const a = resolveWallTile(state);
  const issues = validateWallTile(state);
  const caseEl = document.getElementById('case');
  const descEl = document.getElementById('desc');
  const warnEl = document.getElementById('warn');
  if (caseEl) caseEl.textContent = a.case;
  if (descEl) descEl.textContent = describeWallTile(state);
  if (warnEl) warnEl.textContent = issues.length ? `⚠ ${issues.map((i) => i.message).join(' · ')}` : '';
}

async function renderTile(tile: WallTile, myGen: number): Promise<void> {
  // ---- floor (full tile when uniform, else a quarter per non-none corner) ----
  for (const fp of floorPieces(tile)) {
    const root = await buildPiece(fp.url, fp.corner === 'full' ? 1 : 0.5);
    if (myGen !== gen) return;
    if (fp.corner !== 'full') {
      const [x, z] = CORNER_POS[fp.corner];
      root.position.set(x, 0, z);
    }
    group.add(root);
  }
  // ---- walls / barriers (real KayKit pieces, centred, yaw from the registry) ----
  for (const wp of wallPieces(tile)) {
    const root = await buildPiece(wp.url, 1);
    if (myGen !== gen) return;
    root.rotation.y = wp.yaw;
    root.position.x = wp.x ?? 0;
    root.position.z = wp.z ?? 0;
    group.add(root);
  }
  // ---- optional object demo: a mounted torch per wall arm + a floor barrel ----
  if (showObjects) {
    let barrel = false;
    for (const d of ['N', 'E', 'S', 'W'] as const) {
      if (tile[d] !== 'wall') continue;
      const dx = d === 'E' ? 1 : d === 'W' ? -1 : 0;
      const dz = d === 'S' ? 1 : d === 'N' ? -1 : 0;
      const t = await buildSized(TORCH, 1.4);
      if (myGen !== gen) return;
      t.position.set(dx * (HALF - 0.4), 2.0, dz * (HALF - 0.4));
      t.rotation.y = dx !== 0 ? 0 : Math.PI / 2;
      group.add(t);
      if (!barrel) {
        const b = await buildSized(BARREL, 1.1);
        if (myGen !== gen) return;
        b.position.set(dx * 0.9 + (dx !== 0 ? 0 : 1.0), 0, dz * 0.9 + (dz !== 0 ? 0 : 1.0));
        b.rotation.y = 0.3;
        group.add(b);
        barrel = true;
      }
    }
  }
}

/* ----------------------------------- panel ----------------------------------- */

function selectRow(label: string, value: string, opts: readonly string[], onChange: (v: string) => void, dataKey?: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const sel = document.createElement('select');
  if (dataKey) sel.dataset['key'] = dataKey;
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  row.appendChild(lab);
  row.appendChild(sel);
  return row;
}

function syncControls(): void {
  document.querySelectorAll<HTMLSelectElement>('#fields select').forEach((sel) => {
    const k = sel.dataset['key'];
    if (!k) return;
    if (k.startsWith('floor.')) sel.value = state.floor[k.slice(6) as FloorCorner];
    else sel.value = state[k as keyof WallTile] as string;
  });
}

const fields = document.getElementById('fields');
if (fields) {
  for (const c of FLOOR_CORNERS) {
    fields.appendChild(
      selectRow(`floor ${c}`, state.floor[c], FLOOR_MATS, (v) => { state.floor[c] = v as FloorMaterial; rebuild(); }, `floor.${c}`),
    );
  }
  const wallKeys: (keyof WallTile)[] = ['N', 'E', 'S', 'W'];
  for (const k of wallKeys) fields.appendChild(selectRow(k, state[k] as string, CONN, (v) => { (state[k] as string) = v; rebuild(); }, k));
  fields.appendChild(selectRow('centre', state.centre, AXES, (v) => { state.centre = v as CentreAxis; rebuild(); }, 'centre'));
  fields.appendChild(selectRow('centreType', state.centreType, CTYPES, (v) => { state.centreType = v as CentreType; rebuild(); }, 'centreType'));
  fields.appendChild(selectRow('wallType', state.wallType, WTS, (v) => { state.wallType = v as WallType; rebuild(); }, 'wallType'));
}

const objChk = document.getElementById('objects') as HTMLInputElement | null;
objChk?.addEventListener('change', () => { showObjects = objChk.checked; rebuild(); });

const PRESETS: Record<string, WallTile> = {
  'straight wall': { ...DEFAULT, floor: allF('stone') },
  'wall + door': { floor: allF('stone'), N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'door' },
  corner: { floor: allF('stone'), N: 'wall', E: 'wall', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'bend (no column)': { floor: allF('stone'), N: 'wall', E: 'wall', S: 'none', W: 'none', centre: 'EW', centreType: 'wall', wallType: 'solid' },
  tee: { floor: allF('stone'), N: 'none', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  cross: { floor: allF('stone'), N: 'wall', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  column: { floor: allF('stone'), N: 'none', E: 'none', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'railing (E–W)': { floor: allF('stone'), N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'EW', centreType: 'barrier', wallType: 'solid' },
  '=‖= barrier + column': { floor: allF('stone'), N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'dirt↔stone floor': { floor: { nw: 'stone', ne: 'stone', sw: 'dirt', se: 'dirt' }, N: 'none', E: 'none', S: 'none', W: 'none', centre: 'none', centreType: 'wall', wallType: 'solid' },
  hole: { floor: allF('none'), N: 'none', E: 'none', S: 'none', W: 'none', centre: 'none', centreType: 'wall', wallType: 'solid' },
};
const presets = document.getElementById('presets');
if (presets) {
  for (const [name, tile] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => {
      Object.assign(state, tile);
      state.floor = { ...tile.floor };
      syncControls();
      rebuild();
    });
    presets.appendChild(b);
  }
}

/* --------------------------------- hooks + loop -------------------------------- */

type WTWindow = Window & {
  __WT_READY?: boolean;
  __wtSet?: (p: Partial<WallTile> & { objects?: boolean }) => void;
  __wtState?: () => { tile: WallTile; case: string; describe: string; issues: string[]; objects: boolean };
};
const Wn = window as WTWindow;
Wn.__wtSet = (p) => {
  if (typeof p.objects === 'boolean') {
    showObjects = p.objects;
    if (objChk) objChk.checked = p.objects;
  }
  const { objects: _o, floor, ...rest } = p as Partial<WallTile> & { objects?: boolean };
  void _o;
  Object.assign(state, rest);
  if (floor) state.floor = { ...state.floor, ...floor };
  syncControls();
  rebuild();
};
Wn.__wtState = () => ({
  tile: { ...state, floor: { ...state.floor } },
  case: resolveWallTile(state).case,
  describe: describeWallTile(state),
  issues: validateWallTile(state).map((i) => i.code),
  objects: showObjects,
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

rebuild();
let firstFrame = true;
function tick(): void {
  controls.update();
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    Wn.__WT_READY = true;
  }
  requestAnimationFrame(tick);
}
tick();
