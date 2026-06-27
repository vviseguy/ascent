// ============================================================================
// src/lab/walltile.ts — the WALL-TILE DEBUG view (walltile.html), 9-cell model.
// ============================================================================
//
// Plug the 9 cells (4 outer EDGES + 4 INNER sides + the CENTRE column) + per-corner floor +
// wallType into the panel and SEE the composed arrangement built from REAL KayKit Dungeon
// Remastered meshes (no boxes). Structure pieces come from the registry (wall-tile-assets.ts);
// the object demo (torch/barrel) shows side placement.
//
// SNAPSHOT HOOKS:  __WT_READY · __wtSet(partial) · __wtState()
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  label,
  validate,
  armOf,
  DIRS,
  FLOOR_CORNERS,
  type WallTile,
  type Seg,
  type Centre,
  type WallType,
  type FloorMaterial,
  type CornerFloors,
  type FloorCorner,
  type SideSet,
} from '../floor/wall-tile.ts';
import { tilePlacements } from './wall-tile-assets.ts';
import { meshObject, type WorldObject } from './world-object.ts';

/* --------------------------------- constants --------------------------------- */

const HALF = 2; // native 4u tile → ±2 to each edge
const SEGS: Seg[] = ['none', 'wall', 'barrier'];
const CENTRES: Centre[] = ['none', 'wall', 'barrier'];
const WTS: WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];
const FLOOR_MATS: FloorMaterial[] = ['stone', 'dirt', 'wood', 'none'];

const TORCH = 'models/kaykit_dungeon_remastered/torch_mounted.gltf.glb';
const BARREL = 'models/kaykit_dungeon_remastered/barrel_small.gltf.glb';

/* ----------------------- real-asset building (cached) ------------------------ */

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
async function buildSized(url: string, targetH: number): Promise<THREE.Object3D> {
  const root = await buildPiece(url, 1);
  const bb = new THREE.Box3().setFromObject(root);
  const h = bb.max.y - bb.min.y || 1;
  root.scale.multiplyScalar(targetH / h);
  return root;
}

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
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(6, 10, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8899ff, 0.35);
fillLight.position.set(-5, 4, -6);
scene.add(fillLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;

let group = new THREE.Group();
scene.add(group);

/* ----------------------------------- state ----------------------------------- */

const allF = (m: FloorMaterial): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const side = (N: Seg, E: Seg, S: Seg, W: Seg): SideSet => ({ N, E, S, W });

// default: a straight E–W wall (both arms full on the EW axis)
const DEFAULT: WallTile = {
  floor: allF('stone'),
  edge: side('none', 'wall', 'none', 'wall'),
  inner: side('none', 'wall', 'none', 'wall'),
  centre: 'none',
  wallType: 'solid',
};
const clone = (t: WallTile): WallTile => ({ floor: { ...t.floor }, edge: { ...t.edge }, inner: { ...t.inner }, centre: t.centre, wallType: t.wallType });
const state: WallTile = clone(DEFAULT);
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

  const caseEl = document.getElementById('case');
  const descEl = document.getElementById('desc');
  const warnEl = document.getElementById('warn');
  const issues = validate(state);
  if (caseEl) caseEl.textContent = label(state);
  if (descEl) {
    const e = state.edge;
    const i = state.inner;
    descEl.textContent = `edge ${e.N}/${e.E}/${e.S}/${e.W} · inner ${i.N}/${i.E}/${i.S}/${i.W} · centre ${state.centre}`;
  }
  if (warnEl) warnEl.textContent = issues.length ? `⚠ ${issues.map((x) => x.message).join(' · ')}` : '';
}

async function renderTile(tile: WallTile, myGen: number): Promise<void> {
  // ALL structural placement comes from the one registry function; we just build + apply.
  for (const p of tilePlacements(tile)) {
    const root = await buildPiece(p.url, p.scale);
    if (myGen !== gen) return;
    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.yaw;
    group.add(root);
  }
  if (showObjects) {
    let barrel = false;
    for (const d of DIRS) {
      if (armOf(tile, d).type !== 'wall') continue;
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

function selectRow(labelText: string, value: string, opts: readonly string[], onChange: (v: string) => void, dataKey: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = labelText;
  const sel = document.createElement('select');
  sel.dataset['key'] = dataKey;
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

function valueFor(key: string): string {
  if (key.startsWith('edge.')) return state.edge[key.slice(5) as Dir];
  if (key.startsWith('inner.')) return state.inner[key.slice(6) as Dir];
  if (key.startsWith('floor.')) return state.floor[key.slice(6) as FloorCorner];
  return state[key as 'centre' | 'wallType'];
}
type Dir = 'N' | 'E' | 'S' | 'W';
function setValue(key: string, v: string): void {
  if (key.startsWith('edge.')) state.edge[key.slice(5) as Dir] = v as Seg;
  else if (key.startsWith('inner.')) state.inner[key.slice(6) as Dir] = v as Seg;
  else if (key.startsWith('floor.')) state.floor[key.slice(6) as FloorCorner] = v as FloorMaterial;
  else if (key === 'centre') state.centre = v as Centre;
  else if (key === 'wallType') state.wallType = v as WallType;
}
function syncControls(): void {
  document.querySelectorAll<HTMLSelectElement>('#fields select').forEach((sel) => {
    const k = sel.dataset['key'];
    if (k) sel.value = valueFor(k);
  });
}

const fields = document.getElementById('fields');
function group2(title: string): void {
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'color:#778;margin:8px 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.5px';
  fields?.appendChild(h);
}
if (fields) {
  const addSel = (label: string, opts: readonly string[], key: string): void => {
    fields.appendChild(selectRow(label, valueFor(key), opts, (v) => { setValue(key, v); rebuild(); }, key));
  };
  group2('edges (neighbour side)');
  for (const d of DIRS) addSel(`edge ${d}`, SEGS, `edge.${d}`);
  group2('inner (centre side)');
  for (const d of DIRS) addSel(`inner ${d}`, SEGS, `inner.${d}`);
  group2('centre + opening');
  addSel('centre col', CENTRES, 'centre');
  addSel('wallType', WTS, 'wallType');
  group2('floor (per corner)');
  for (const c of FLOOR_CORNERS) addSel(`floor ${c}`, FLOOR_MATS, `floor.${c}`);
}

const objChk = document.getElementById('objects') as HTMLInputElement | null;
objChk?.addEventListener('change', () => { showObjects = objChk.checked; rebuild(); });

const PRESETS: Record<string, WallTile> = {
  'straight wall': clone(DEFAULT),
  'wall + door': { floor: allF('stone'), edge: side('none', 'wall', 'none', 'wall'), inner: side('none', 'wall', 'none', 'wall'), centre: 'none', wallType: 'door' },
  'bend (no column)': { floor: allF('stone'), edge: side('wall', 'wall', 'none', 'none'), inner: side('wall', 'wall', 'none', 'none'), centre: 'none', wallType: 'solid' },
  'corner (column)': { floor: allF('stone'), edge: side('wall', 'wall', 'none', 'none'), inner: side('wall', 'wall', 'none', 'none'), centre: 'wall', wallType: 'solid' },
  tee: { floor: allF('stone'), edge: side('none', 'wall', 'wall', 'wall'), inner: side('none', 'wall', 'wall', 'wall'), centre: 'none', wallType: 'solid' },
  cross: { floor: allF('stone'), edge: side('wall', 'wall', 'wall', 'wall'), inner: side('wall', 'wall', 'wall', 'wall'), centre: 'none', wallType: 'solid' },
  column: { floor: allF('stone'), edge: side('none', 'none', 'none', 'none'), inner: side('none', 'none', 'none', 'none'), centre: 'wall', wallType: 'solid' },
  'edge caps only': { floor: allF('stone'), edge: side('wall', 'wall', 'none', 'none'), inner: side('none', 'none', 'none', 'none'), centre: 'none', wallType: 'solid' },
  'inner stub N': { floor: allF('stone'), edge: side('none', 'none', 'none', 'none'), inner: side('wall', 'none', 'none', 'none'), centre: 'none', wallType: 'solid' },
  'railing (E–W)': { floor: allF('stone'), edge: side('none', 'barrier', 'none', 'barrier'), inner: side('none', 'barrier', 'none', 'barrier'), centre: 'none', wallType: 'solid' },
  'dirt↔stone floor': { floor: { nw: 'stone', ne: 'stone', sw: 'dirt', se: 'dirt' }, edge: side('none', 'none', 'none', 'none'), inner: side('none', 'none', 'none', 'none'), centre: 'none', wallType: 'solid' },
  hole: { floor: allF('none'), edge: side('none', 'none', 'none', 'none'), inner: side('none', 'none', 'none', 'none'), centre: 'none', wallType: 'solid' },
};
const presets = document.getElementById('presets');
if (presets) {
  for (const [name, tile] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => { Object.assign(state, clone(tile)); syncControls(); rebuild(); });
    presets.appendChild(b);
  }
}

/* --------------------------------- hooks + loop -------------------------------- */

type WTWindow = Window & {
  __WT_READY?: boolean;
  __wtSet?: (p: Partial<WallTile> & { objects?: boolean }) => void;
  __wtState?: () => { tile: WallTile; label: string; issues: string[]; objects: boolean };
};
const Wn = window as WTWindow;
Wn.__wtSet = (p) => {
  if (typeof p.objects === 'boolean') {
    showObjects = p.objects;
    if (objChk) objChk.checked = p.objects;
  }
  if (p.edge) state.edge = { ...state.edge, ...p.edge };
  if (p.inner) state.inner = { ...state.inner, ...p.inner };
  if (p.floor) state.floor = { ...state.floor, ...p.floor };
  if (p.centre) state.centre = p.centre;
  if (p.wallType) state.wallType = p.wallType;
  syncControls();
  rebuild();
};
Wn.__wtState = () => ({ tile: clone(state), label: label(state), issues: validate(state).map((i) => i.code), objects: showObjects });

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
