// ============================================================================
// src/lab/board.ts — the TILE-BOARD preview (board.html).
// ============================================================================
//
// A multi-tile patch of board: a TileGrid (src/floor/tile-grid.ts) with ROOMS stamped on as
// atomic transactions, collapsed to WallTiles, and rendered with the SAME tilePlacements() the
// single-tile view uses — one tile placed per grid cell. The buttons demonstrate the DB-style
// transaction: a non-overlapping batch commits; an overlapping batch hits a conflict and the
// WHOLE batch rolls back (nothing lands). Real KayKit meshes, no boxes.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGrid, applyBatch, collapseGrid, type TileGrid, type Region, type Stamp } from '../floor/tile-grid.ts';
import { template, fromTile, floors } from '../floor/wall-tile-field.ts';
import { tilePlacements } from './wall-tile-assets.ts';
import type { WallTile, SideSet, CornerFloors, Seg, Dir } from '../floor/wall-tile.ts';
import { meshObject, type WorldObject } from './world-object.ts';

const CELL = 4; // a tile is 4u; grid cell (gx,gy) centres at world (gx*CELL, gy*CELL)

/* ----------------------- real-asset building (cached + cloned) --------------- */

const objCache = new Map<string, WorldObject>();
const builtCache = new Map<string, Promise<THREE.Object3D>>();
function pieceObj(url: string, scale: number): WorldObject {
  const k = `${url}@${scale}`;
  let o = objCache.get(k);
  if (!o) { o = meshObject({ meshUrl: url, name: url, describe: '', level: 'object', scale, variants: { default: [] } }); objCache.set(k, o); }
  return o;
}
/** Build a piece ONCE per (url,scale); clone for each instance (shares geometry+material). */
function builtOnce(url: string, scale: number): Promise<THREE.Object3D> {
  const k = `${url}@${scale}`;
  let p = builtCache.get(k);
  if (!p) { p = pieceObj(url, scale).build('default', 0).then((b) => b.root); builtCache.set(k, p); }
  return p;
}
const instance = async (url: string, scale: number): Promise<THREE.Object3D> => (await builtOnce(url, scale)).clone();

/* ------------------------------- room templates ------------------------------ */

const allF = (m: 'stone'): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });
const side = (N: Seg, E: Seg, S: Seg, W: Seg): SideSet => ({ N, E, S, W });

/** The intended tile at local (lx,ly) of a room: floor inside, a wall ring (straights + corners). */
function roomTile(lx: number, ly: number, rw: number, rh: number): WallTile {
  const e: SideSet = side('none', 'none', 'none', 'none');
  const n: SideSet = side('none', 'none', 'none', 'none');
  const wall = (d: Dir): void => { e[d] = 'wall'; n[d] = 'wall'; };
  const onW = lx === 0, onE = lx === rw - 1, onN = ly === 0, onS = ly === rh - 1;
  if (onN && onW) { wall('E'); wall('S'); } // NW corner: arms into the N + W walls
  else if (onN && onE) { wall('S'); wall('W'); } // NE
  else if (onS && onW) { wall('N'); wall('E'); } // SW
  else if (onS && onE) { wall('N'); wall('W'); } // SE
  else if (onN || onS) { wall('E'); wall('W'); } // top/bottom run: E–W wall
  else if (onW || onE) { wall('N'); wall('S'); } // left/right run: N–S wall
  return { floor: allF('stone'), edge: e, inner: n, centre: 'none', wallType: 'solid' };
}
/** A room stamp forces each of its tiles (singleton domains) — so overlaps CONFLICT and roll back. */
const roomStamp = (rw: number, rh: number): Stamp => (lx, ly) => fromTile(roomTile(lx, ly, rw, rh));

/** A loose floor over the whole grid (only constrains floor → stone; walls stay open). */
const baseFloor = template({ floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') } });

/* ----------------------------------- scene ----------------------------------- */

const GW = 7, GH = 7;
const view = document.getElementById('view') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14141e);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(22, 30, 30);
camera.lookAt(0, 0, 0);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2); keyLight.position.set(12, 22, 8); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8899ff, 0.3); fillLight.position.set(-10, 8, -12); scene.add(fillLight);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0); controls.enableDamping = true;

let group = new THREE.Group();
scene.add(group);
let gen = 0;

function status(msg: string, cls: 'ok' | 'bad'): void {
  const el = document.getElementById('status');
  if (el) el.innerHTML = `<span class="${cls}">${msg}</span>`;
}

/** Build a grid for a scenario, then render the collapsed tiles. */
async function show(build: (g: TileGrid) => void): Promise<void> {
  gen++;
  const myGen = gen;
  scene.remove(group);
  group = new THREE.Group();
  scene.add(group);

  const grid = makeGrid(GW, GH);
  applyBatch(grid, [{ region: { x: 0, y: 0, w: GW, h: GH }, stamp: baseFloor }]); // floor everywhere
  build(grid);

  const ox = -((GW - 1) / 2) * CELL;
  const oz = -((GH - 1) / 2) * CELL;
  const tiles = collapseGrid(grid);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t) continue;
    const wx = ox + (i % GW) * CELL;
    const wz = oz + Math.floor(i / GW) * CELL;
    for (const p of tilePlacements(t)) {
      const root = await instance(p.url, p.scale);
      if (myGen !== gen) return;
      root.position.set(wx + p.x, p.y, wz + p.z);
      root.rotation.y = p.yaw;
      group.add(root);
    }
  }
}

/* --------------------------------- scenarios --------------------------------- */

const TWO_ROOMS: { region: Region; stamp: Stamp }[] = [
  { region: { x: 0, y: 0, w: 4, h: 3 }, stamp: roomStamp(4, 3) },
  { region: { x: 4, y: 3, w: 3, h: 4 }, stamp: roomStamp(3, 4) },
];
const OVERLAPPING: { region: Region; stamp: Stamp }[] = [
  { region: { x: 0, y: 0, w: 4, h: 4 }, stamp: roomStamp(4, 4) },
  { region: { x: 2, y: 2, w: 4, h: 4 }, stamp: roomStamp(4, 4) }, // overlaps the first → conflict
];

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  document.getElementById('buttons')?.appendChild(b);
}

button('two rooms (commit)', () => {
  void show((g) => {
    const r = applyBatch(g, TWO_ROOMS);
    status(r.ok ? '✓ committed 2 rooms (no conflict)' : '✗ unexpected conflict', r.ok ? 'ok' : 'bad');
  });
});
button('overlapping rooms (rollback)', () => {
  void show((g) => {
    const r = applyBatch(g, OVERLAPPING);
    status(
      r.ok ? '✓ committed (unexpected)' : `✗ conflict at ${r.conflicts.length} cell(s) → whole batch rolled back (only the floor remains)`,
      r.ok ? 'ok' : 'bad',
    );
  });
});
button('clear (floor only)', () => { void show(() => status('floor only', 'ok')); });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

type BoardWindow = Window & { __BOARD_READY?: boolean; __boardShow?: (scenario: 'two' | 'overlap' | 'clear') => void };
const Wn = window as BoardWindow;
Wn.__boardShow = (s) => {
  if (s === 'two') void show((g) => { applyBatch(g, TWO_ROOMS); });
  else if (s === 'overlap') void show((g) => { applyBatch(g, OVERLAPPING); });
  else void show(() => {});
};

void show((g) => { applyBatch(g, TWO_ROOMS); }); // initial
let first = true;
function tick(): void {
  controls.update();
  renderer.render(scene, camera);
  if (first) { first = false; Wn.__BOARD_READY = true; }
  requestAnimationFrame(tick);
}
tick();
