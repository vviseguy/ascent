// ============================================================================
// src/lab/board.ts — the TILE-BOARD preview (board.html).
// ============================================================================
//
// A multi-tile patch of board: a TileGrid (src/floor/tile-grid.ts) with ROOMS (room-templates.ts)
// stamped on as atomic transactions, collapsed to WallTiles, and rendered with the SAME
// tilePlacements() the single-tile view uses — one tile per grid cell, real KayKit meshes
// (built once per url, cloned per instance). Buttons show each room type, plus the DB-style
// transaction demo: a non-overlapping batch commits; an overlapping batch hits a conflict and
// the WHOLE batch rolls back (only the floor remains).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGrid, applyBatch, collapseGrid, type TileGrid, type Region, type Stamp } from '../floor/tile-grid.ts';
import { template, floors } from '../floor/wall-tile-field.ts';
import { tilePlacements } from './wall-tile-assets.ts';
import { basicRoom, ROOMS } from '../floor/room-templates.ts';
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

/** A loose floor over the whole grid (only constrains floor → stone; walls stay open). */
const baseFloor = template({ floor: { nw: floors('stone'), ne: floors('stone'), sw: floors('stone'), se: floors('stone') } });

/* ----------------------------------- scene ----------------------------------- */

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

/** Build a grid (gw×gh), let `build` stamp it, then render the collapsed tiles. */
async function show(gw: number, gh: number, build: (g: TileGrid) => void, withBaseFloor = true): Promise<void> {
  gen++;
  const myGen = gen;
  scene.remove(group);
  group = new THREE.Group();
  scene.add(group);

  const grid = makeGrid(gw, gh);
  if (withBaseFloor) applyBatch(grid, [{ region: { x: 0, y: 0, w: gw, h: gh }, stamp: baseFloor }]);
  build(grid);

  const ox = -((gw - 1) / 2) * CELL;
  const oz = -((gh - 1) / 2) * CELL;
  const tiles = collapseGrid(grid);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t) continue;
    const wx = ox + (i % gw) * CELL;
    const wz = oz + Math.floor(i / gw) * CELL;
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

const GW = 7, GH = 7;
const TWO_ROOMS: { region: Region; stamp: Stamp }[] = [
  { region: { x: 0, y: 0, w: 4, h: 3 }, stamp: basicRoom(4, 3) },
  { region: { x: 4, y: 3, w: 3, h: 4 }, stamp: basicRoom(3, 4) },
];
const OVERLAPPING: { region: Region; stamp: Stamp }[] = [
  { region: { x: 0, y: 0, w: 4, h: 4 }, stamp: basicRoom(4, 4) },
  { region: { x: 2, y: 2, w: 4, h: 4 }, stamp: basicRoom(4, 4) }, // overlaps → conflict
];

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  document.getElementById('buttons')?.appendChild(b);
}

// one button per room type (each sized to itself, no base floor)
for (const [name, { make, size }] of Object.entries(ROOMS)) {
  button(name, () => {
    const [w, h] = size;
    void show(w, h, (g) => { applyBatch(g, [{ region: { x: 0, y: 0, w, h }, stamp: make(w, h) }]); status(`${name} ${w}×${h}`, 'ok'); }, false);
  });
}

button('— two rooms (commit)', () => {
  void show(GW, GH, (g) => {
    const r = applyBatch(g, TWO_ROOMS);
    status(r.ok ? '✓ committed 2 rooms (no conflict)' : '✗ unexpected conflict', r.ok ? 'ok' : 'bad');
  });
});
button('— overlapping rooms (rollback)', () => {
  void show(GW, GH, (g) => {
    const r = applyBatch(g, OVERLAPPING);
    status(r.ok ? '✓ committed (unexpected)' : `✗ conflict at ${r.conflicts.length} cell(s) → whole batch rolled back (only floor remains)`, r.ok ? 'ok' : 'bad');
  });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

type BoardWindow = Window & { __BOARD_READY?: boolean; __boardRoom?: (name: string) => void };
const Wn = window as BoardWindow;
Wn.__boardRoom = (name) => {
  const r = ROOMS[name];
  if (r) void show(r.size[0], r.size[1], (g) => { applyBatch(g, [{ region: { x: 0, y: 0, w: r.size[0], h: r.size[1] }, stamp: r.make(r.size[0], r.size[1]) }]); }, false);
};

Wn.__boardRoom('throne room'); // initial view

let first = true;
function tick(): void {
  controls.update();
  renderer.render(scene, camera);
  if (first) { first = false; Wn.__BOARD_READY = true; }
  requestAnimationFrame(tick);
}
tick();
