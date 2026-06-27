// ============================================================================
// src/lab/walltile.ts — the WALL-TILE DEBUG view (walltile.html).
// ============================================================================
//
// Plug a tile's params (floor, 4 connections, centre axis/type, wallType) into the panel
// and SEE the resolved arrangement in 3D — to eyeball that every input maps to a sane output
// and catch resolver/geometry/validation errors. The STRUCTURE is drawn as schematic boxes
// (full-height = wall, low = barrier) — that is deliberate: boxes show the resolver TOPOLOGY
// clearly. The OBJECTS demo (torches, a barrel) uses the REAL KayKit catalog assets
// (kaykit-catalog.ts → world-object build → recolor + box-fit), to prove the asset system
// is consumable and to demo SIDE placement (a mounted torch on a wall face; a barrel on the
// floor against a wall).
//
// SNAPSHOT HOOKS:  __WT_READY · __wtSet(partial) · __wtState()
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  resolveWallTile,
  describeWallTile,
  validateWallTile,
  DIRS,
  type WallTile,
  type Dir,
  type Connection,
  type CentreAxis,
  type CentreType,
  type WallType,
  type FloorType,
} from '../floor/wall-tile.ts';
import { meshObject, type WorldObject } from './world-object.ts';

/* --------------------------------- constants --------------------------------- */

const STONE = 0x8a8a96; // wall
const WOOD = 0x9c6b3f; // barrier
const FLOOR = 0x33333f;

const HALF = 2; // tile is 4u → ±2 to each edge
const C = 0.7; // half-extent of the centre region
const TH = 0.5; // wall / barrier thickness
const WALL_H = 4;
const BAR_H = 1.1;

const CONN: Connection[] = ['none', 'wall', 'barrier'];
const AXES: CentreAxis[] = ['none', 'EW', 'NS', 'both'];
const CTYPES: CentreType[] = ['wall', 'barrier'];
const WTS: WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];
const FLOORS: FloorType[] = ['stone', 'none'];

// d → unit (dx,dz) in the X(=E/W) / Z(=N/S) plane. N = -Z, S = +Z, E = +X, W = -X.
const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

// REAL KayKit Dungeon Remastered assets, built through the same world-object → recolor →
// box-fit path the game uses (constructed directly rather than via the 900-entry catalog).
const TORCH: WorldObject = meshObject({ meshUrl: 'models/kaykit_dungeon_remastered/torch_mounted.gltf.glb', name: 'Torch (mounted)', describe: 'wall torch', level: 'object', scale: 0.5, variants: { default: [] } });
const BARREL: WorldObject = meshObject({ meshUrl: 'models/kaykit_dungeon_remastered/barrel_small.gltf.glb', name: 'Barrel (small)', describe: 'floor barrel', level: 'object', scale: 0.5, variants: { default: [] } });

/* --------------------------- structure (schematic boxes) ---------------------- */

const mat = (color: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });

function box(w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  me.position.set(x, y, z);
  return me;
}

const heightOf = (t: 'wall' | 'barrier'): number => (t === 'wall' ? WALL_H : BAR_H);
const colorOf = (t: 'wall' | 'barrier'): number => (t === 'wall' ? STONE : WOOD);

/** An ARM: a half-segment from the centre region (±C) out to the tile edge (±HALF) along d. */
function armMesh(d: Dir, t: 'wall' | 'barrier'): THREE.Mesh {
  const h = heightOf(t);
  const len = HALF - C;
  const mid = (HALF + C) / 2;
  const [dx, dz] = DV[d];
  return dx !== 0
    ? box(len, h, TH, dx * mid, h / 2, 0, mat(colorOf(t)))
    : box(TH, h, len, 0, h / 2, dz * mid, mat(colorOf(t)));
}

/** A single-axis centre BAR through the centre region, honouring the wall opening (wallType). */
function barMeshes(ew: boolean, h: number, m: THREE.Material, wt: WallType): THREE.Mesh[] {
  const along = C * 2;
  const slab = (y0: number, y1: number): THREE.Mesh =>
    ew ? box(along, y1 - y0, TH, 0, (y0 + y1) / 2, 0, m) : box(TH, y1 - y0, along, 0, (y0 + y1) / 2, 0, m);
  switch (wt) {
    case 'door':
    case 'arch':
      return [slab(2.4, h)];
    case 'window':
      return [slab(0, 1.2), slab(2.8, h)];
    case 'hole':
      return [slab(0, 1.6), slab(2.4, h)];
    case 'low_gate':
      return [slab(0, BAR_H)];
    case 'solid':
    default:
      return [slab(0, h)];
  }
}

/** The CENTRE block(s): a both-axis column/hub, or a single-axis bar with its opening. */
function centreMeshes(tile: WallTile): THREE.Mesh[] {
  if (tile.centre === 'none') return [];
  const t = tile.centreType;
  const h = heightOf(t);
  const m = mat(colorOf(t));
  if (tile.centre === 'both') return [box(C * 2, h, C * 2, 0, h / 2, 0, m)];
  return barMeshes(tile.centre === 'EW', h, m, t === 'wall' ? tile.wallType : 'solid');
}

/* ----------------------- objects: REAL KayKit catalog assets ------------------ */

/** Build a catalog object by id (recolor + box-fit, the same path the game uses) and scale
 *  its built root to `targetH` game-units tall so it reads against the 4u tile. */
async function buildAsset(obj: WorldObject, targetH: number): Promise<THREE.Object3D | null> {
  const built = await obj.build('default', 0); // → { root (base at y=0), footprint, … }
  const root = built.root;
  const bb = new THREE.Box3().setFromObject(root);
  const h = bb.max.y - bb.min.y || 1;
  root.scale.multiplyScalar(targetH / h);
  return root;
}

/** Side-placed object demo: a mounted torch on each wall arm's face (inward) + a floor barrel. */
async function addObjects(tile: WallTile, myGen: number): Promise<void> {
  type Job = { obj: WorldObject; target: number; place: (o: THREE.Object3D) => void };
  const jobs: Job[] = [];
  let barrel = false;
  for (const d of DIRS) {
    if (tile[d] !== 'wall') continue;
    const [dx, dz] = DV[d];
    const mid = (HALF + C) / 2;
    const faceZ = dx !== 0; // E/W arm runs along X → its broad faces point ±Z
    jobs.push({
      obj: TORCH,
      target: 1.4,
      place: (o) => {
        o.position.set(dx * mid + (faceZ ? 0 : TH / 2 + 0.05), WALL_H * 0.42, dz * mid + (faceZ ? TH / 2 + 0.05 : 0));
        o.rotation.y = faceZ ? 0 : Math.PI / 2; // approximate inward facing (refined by placement rules later)
      },
    });
    if (!barrel) {
      jobs.push({
        obj: BARREL,
        target: 1.1,
        place: (o) => {
          o.position.set(dx * mid + (dx !== 0 ? 0 : 0.85), 0, dz * mid + (dz !== 0 ? 0 : 0.85));
          o.rotation.y = 0.3; // skewed a touch, aligned-not-perfect
        },
      });
      barrel = true;
    }
  }
  for (const j of jobs) {
    const o = await buildAsset(j.obj, j.target);
    if (myGen !== gen) return; // a newer rebuild superseded us
    if (o) {
      j.place(o);
      group.add(o);
    }
  }
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

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(6, 10, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
fill.position.set(-5, 4, -6);
scene.add(fill);

const grid = new THREE.GridHelper(12, 3, 0x445, 0x2a2a3a);
grid.position.y = 0.001;
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;

let group = new THREE.Group();
scene.add(group);

/* ----------------------------------- state ----------------------------------- */

const DEFAULT: WallTile = { floor: 'stone', N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'solid' };
const state: WallTile = { ...DEFAULT };
let showObjects = false;
let gen = 0;

function rebuild(): void {
  gen++;
  const myGen = gen;
  scene.remove(group);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
  group = new THREE.Group();

  if (state.floor !== 'none') group.add(box(4, 0.1, 4, 0, -0.05, 0, mat(FLOOR))); // floor slab (none = a hole)
  for (const d of DIRS) if (state[d] !== 'none') group.add(armMesh(d, state[d] as 'wall' | 'barrier'));
  for (const m of centreMeshes(state)) group.add(m);
  scene.add(group);

  if (showObjects) void addObjects(state, myGen);

  const a = resolveWallTile(state);
  const issues = validateWallTile(state);
  const caseEl = document.getElementById('case');
  const descEl = document.getElementById('desc');
  const warnEl = document.getElementById('warn');
  if (caseEl) caseEl.textContent = a.case;
  if (descEl) descEl.textContent = describeWallTile(state);
  if (warnEl) warnEl.textContent = issues.length ? `⚠ ${issues.map((i) => i.message).join(' · ')}` : '';
}

/* ----------------------------------- panel ----------------------------------- */

function makeSelect(labelKey: keyof WallTile, opts: readonly string[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = labelKey;
  const sel = document.createElement('select');
  sel.dataset['key'] = labelKey;
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  }
  sel.value = state[labelKey];
  sel.addEventListener('change', () => {
    (state[labelKey] as string) = sel.value;
    rebuild();
  });
  row.appendChild(label);
  row.appendChild(sel);
  return row;
}

function syncControls(): void {
  document.querySelectorAll<HTMLSelectElement>('#fields select').forEach((sel) => {
    const key = sel.dataset['key'] as keyof WallTile;
    sel.value = state[key];
  });
}

const fields = document.getElementById('fields');
if (fields) {
  fields.appendChild(makeSelect('floor', FLOORS));
  fields.appendChild(makeSelect('N', CONN));
  fields.appendChild(makeSelect('E', CONN));
  fields.appendChild(makeSelect('S', CONN));
  fields.appendChild(makeSelect('W', CONN));
  fields.appendChild(makeSelect('centre', AXES));
  fields.appendChild(makeSelect('centreType', CTYPES));
  fields.appendChild(makeSelect('wallType', WTS));
}

const objChk = document.getElementById('objects') as HTMLInputElement | null;
objChk?.addEventListener('change', () => {
  showObjects = objChk.checked;
  rebuild();
});

const PRESETS: Record<string, WallTile> = {
  'straight wall': { ...DEFAULT },
  'wall + door': { floor: 'stone', N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'door' },
  corner: { floor: 'stone', N: 'wall', E: 'wall', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  tee: { floor: 'stone', N: 'none', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  cross: { floor: 'stone', N: 'wall', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  column: { floor: 'stone', N: 'none', E: 'none', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'caps (gap)': { floor: 'stone', N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'none', centreType: 'wall', wallType: 'solid' },
  'railing (E–W)': { floor: 'stone', N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'EW', centreType: 'barrier', wallType: 'solid' },
  '=‖= barrier + column': { floor: 'stone', N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'floor only': { floor: 'stone', N: 'none', E: 'none', S: 'none', W: 'none', centre: 'none', centreType: 'wall', wallType: 'solid' },
  hole: { floor: 'none', N: 'none', E: 'none', S: 'none', W: 'none', centre: 'none', centreType: 'wall', wallType: 'solid' },
};
const presets = document.getElementById('presets');
if (presets) {
  for (const [name, tile] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => {
      Object.assign(state, tile);
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
  delete (p as { objects?: boolean }).objects;
  Object.assign(state, p);
  syncControls();
  rebuild();
};
Wn.__wtState = () => ({
  tile: { ...state },
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
