// ============================================================================
// src/lab/walltile.ts — the WALL-TILE DEBUG view (walltile.html).
// ============================================================================
//
// Plug the WallTile params (4 connections, centre axis, centre type, wallType) into the
// panel and SEE the resolved arrangement in 3D — to eyeball that every input maps to a
// sane output and catch resolver/geometry errors. Boxes only (this is a debugger, not art):
// full-height = wall, low = barrier. Objects (torches, a floor barrel) demo SIDE placement
// (docs/16 §2 "content + the placement machine") — torches mount on a wall FACE inward, or
// on a barrier's outer KNUB; floor props sit skewed but aligned against the nearest structure.
//
// SNAPSHOT HOOKS (for headless screenshotting / driving from JS):
//   window.__WT_READY        true once the first frame has rendered
//   window.__wtSet(partial)  merge params into the tile + re-render  (e.g. {centre:'both'})
//   window.__wtState()       the current tile + resolved {case, describe}
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  resolveWallTile,
  describeWallTile,
  DIRS,
  type WallTile,
  type Dir,
  type Connection,
  type CentreAxis,
  type CentreType,
  type WallType,
  type WallArrangement,
} from '../floor/wall-tile.ts';

/* --------------------------------- constants --------------------------------- */

const STONE = 0x8a8a96; // wall
const WOOD = 0x9c6b3f; // barrier
const FLAME = 0xffae42; // object / torch
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

// d → unit (dx,dz) in the X(=E/W) / Z(=N/S) plane. N = -Z, S = +Z, E = +X, W = -X.
const DV: Record<Dir, readonly [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/* --------------------------------- geometry ---------------------------------- */

const mat = (color: number, emissive = false): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0,
    ...(emissive ? { emissive: color, emissiveIntensity: 0.9 } : {}),
  });

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
  // a slab of the bar between two heights (full width across the centre region)
  const slab = (y0: number, y1: number): THREE.Mesh =>
    ew ? box(along, y1 - y0, TH, 0, (y0 + y1) / 2, 0, m) : box(TH, y1 - y0, along, 0, (y0 + y1) / 2, 0, m);
  switch (wt) {
    case 'door':
    case 'arch':
      return [slab(2.4, h)]; // a lintel — open doorway below
    case 'window':
      return [slab(0, 1.2), slab(2.8, h)]; // sill + lintel, gap between
    case 'hole':
      return [slab(0, 1.6), slab(2.4, h)]; // a smaller knocked-through gap
    case 'low_gate':
      return [slab(0, BAR_H)]; // a low passable lip
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
  if (tile.centre === 'both') return [box(C * 2, h, C * 2, 0, h / 2, 0, m)]; // column / hub
  return barMeshes(tile.centre === 'EW', h, m, t === 'wall' ? tile.wallType : 'solid');
}

/* --------------------------- objects (side placement) ------------------------- */

/** A torch: a short bracket pointing along `out` from `(x,z)` at mid-height, with a flame tip. */
function torch(x: number, z: number, out: readonly [number, number]): THREE.Group {
  const g = new THREE.Group();
  const y = WALL_H * 0.55;
  const [ox, oz] = out;
  const reach = 0.35;
  g.add(box(0.12, 0.12, 0.12, x + ox * reach, y, z + oz * reach, mat(0x4a3a2a))); // bracket
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), mat(FLAME, true));
  flame.position.set(x + ox * (reach + 0.18), y + 0.22, z + oz * (reach + 0.18));
  g.add(flame);
  return g;
}

/** Side-placed object demo: torches on wall faces (inward) / barrier knubs (outward) + a floor barrel. */
function objectMeshes(tile: WallTile, a: WallArrangement): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  let barrelPlaced = false;
  for (const d of DIRS) {
    const [dx, dz] = DV[d];
    const mid = (HALF + C) / 2;
    if (tile[d] === 'wall') {
      // torch on the arm's broad FACE, facing inward (perpendicular to the arm). E/W arm faces ±Z.
      const face: readonly [number, number] = dx !== 0 ? [0, 1] : [1, 0];
      out.push(torch(dx * mid, dz * mid, face));
      if (!barrelPlaced) {
        // a barrel on the floor, slid against the arm, skewed a touch (aligned-not-perfect).
        const bx = dx * mid + (dx !== 0 ? 0 : 0.7);
        const bz = dz * mid + (dz !== 0 ? 0 : 0.7);
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.8, 12), mat(0x6b4a2a));
        barrel.position.set(bx, 0.4, bz);
        barrel.rotation.y = 0.25;
        out.push(barrel);
        barrelPlaced = true;
      }
    } else if (tile[d] === 'barrier') {
      // torch on the OUTER knub of the barrier, facing outward toward the edge.
      out.push(torch(dx * HALF * 0.9, dz * HALF * 0.9, [dx, dz]));
    }
  }
  // a torch on a freestanding wall column, facing south.
  if (tile.centre === 'both' && tile.centreType === 'wall' && DIRS.every((d) => tile[d] === 'none')) {
    out.push(torch(0, C, [0, 1]));
  }
  return out;
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

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(6, 10, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
fill.position.set(-5, 4, -6);
scene.add(fill);

// reference: a 3×3 tile grid on the ground so you can read the 4u footprint + neighbours.
const grid = new THREE.GridHelper(12, 3, 0x445, 0x2a2a3a);
grid.position.y = 0.001;
scene.add(grid);
scene.add(box(4, 0.1, 4, 0, -0.05, 0, mat(FLOOR))); // the tile's own floor slab

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true;

let group = new THREE.Group();
scene.add(group);

/* ----------------------------------- state ----------------------------------- */

const DEFAULT: WallTile = { N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'solid' };
const state: WallTile = { ...DEFAULT };
let showObjects = false;

function rebuild(): void {
  scene.remove(group);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
  group = new THREE.Group();
  for (const d of DIRS) if (state[d] !== 'none') group.add(armMesh(d, state[d] as 'wall' | 'barrier'));
  for (const m of centreMeshes(state)) group.add(m);
  const a = resolveWallTile(state);
  if (showObjects) for (const o of objectMeshes(state, a)) group.add(o);
  scene.add(group);

  const caseEl = document.getElementById('case');
  const descEl = document.getElementById('desc');
  if (caseEl) caseEl.textContent = a.case;
  if (descEl) descEl.textContent = describeWallTile(state);
}

/* ----------------------------------- panel ----------------------------------- */

function makeSelect(key: keyof WallTile, opts: readonly string[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = key;
  const sel = document.createElement('select');
  sel.dataset['key'] = key;
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    sel.appendChild(opt);
  }
  sel.value = state[key];
  sel.addEventListener('change', () => {
    (state[key] as string) = sel.value;
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
  'wall + door': { N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'EW', centreType: 'wall', wallType: 'door' },
  corner: { N: 'wall', E: 'wall', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  tee: { N: 'none', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  cross: { N: 'wall', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall', wallType: 'solid' },
  column: { N: 'none', E: 'none', S: 'none', W: 'none', centre: 'both', centreType: 'wall', wallType: 'solid' },
  'caps (gap)': { N: 'none', E: 'wall', S: 'none', W: 'wall', centre: 'none', centreType: 'wall', wallType: 'solid' },
  'railing (E–W)': { N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'EW', centreType: 'barrier', wallType: 'solid' },
  '=‖= barrier + column': { N: 'none', E: 'barrier', S: 'none', W: 'barrier', centre: 'both', centreType: 'wall', wallType: 'solid' },
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
  __wtState?: () => { tile: WallTile; case: string; describe: string; objects: boolean };
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
Wn.__wtState = () => ({ tile: { ...state }, case: resolveWallTile(state).case, describe: describeWallTile(state), objects: showObjects });

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
