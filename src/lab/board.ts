// ============================================================================
// src/lab/board.ts — the TILE-BOARD preview (board.html).
// ============================================================================
//
// A multi-tile patch of board: a TileGrid (src/floor/tile-grid.ts) with ROOMS (room-templates.ts)
// stamped on as atomic transactions, collapsed to WallTiles, and rendered with the SAME
// tilePlacements() the single-tile view uses — one tile per grid cell, real KayKit meshes
// (built once per url, cloned per instance).
//
// The grid starts fully OPEN (every cell unconstrained). Rooms constrain only their inside and leave
// their boundary open, so cells nothing has claimed yet show as a translucent BLUE marker — you can
// see exactly where things are still free to connect. Buttons show each room type (framed by a 1-tile
// open margin), plus the DB-style transaction demo: a non-overlapping batch commits; an overlapping
// batch hits a conflict and the WHOLE batch rolls back (the grid stays open).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGrid, applyBatch, collapseGrid, type TileGrid, type Region, type Stamp } from '../floor/tile-grid.ts';
import { isOpen } from '../floor/wall-tile-field.ts';
import { tilePlacements } from './wall-tile-assets.ts';
import { basicRoom, ROOMS } from '../floor/room-templates.ts';
import { instance } from './tile-render.ts';

const CELL = 4; // a tile is 4u; grid cell (gx,gy) centres at world (gx*CELL, gy*CELL)
const MARGIN = 1; // open border around a single room, so its open boundary is visible (blue)

// the "unconstrained cell" marker — a flat translucent blue square laid on the ground
const openGeo = new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92);
const openMat = new THREE.MeshBasicMaterial({ color: 0x3a78ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });

/* ----------------------------------- scene ----------------------------------- */

const view = document.getElementById('view') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14141e);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6, 46, 20); // steep, near-top-down — reads as a floor plan
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

/** Build a grid (gw×gh), let `build` stamp it, then render: collapsed tiles + blue OPEN markers. */
async function show(gw: number, gh: number, build: (g: TileGrid) => void): Promise<void> {
  gen++;
  const myGen = gen;
  scene.remove(group);
  group = new THREE.Group();
  scene.add(group);

  const grid = makeGrid(gw, gh);
  build(grid);

  const ox = -((gw - 1) / 2) * CELL;
  const oz = -((gh - 1) / 2) * CELL;
  const tiles = collapseGrid(grid);
  for (let i = 0; i < tiles.length; i++) {
    const wx = ox + (i % gw) * CELL;
    const wz = oz + Math.floor(i / gw) * CELL;
    if (isOpen(grid.cells[i]!)) {
      const plane = new THREE.Mesh(openGeo, openMat); // unconstrained cell → blue marker only
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(wx, 0.06, wz);
      group.add(plane);
      continue;
    }
    const t = tiles[i];
    if (!t) continue;
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
  { region: { x: 0, y: 0, w: 4, h: 4 }, stamp: basicRoom(4, 4, 'stone') },
  { region: { x: 2, y: 2, w: 4, h: 4 }, stamp: basicRoom(4, 4, 'wood') }, // demands wood where the other wants stone → conflict
];

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  document.getElementById('buttons')?.appendChild(b);
}

/** Show one room of `name`, framed by a 1-tile open (blue) margin. */
function showRoom(name: string): void {
  const r = ROOMS[name];
  if (!r) return;
  const [w, h] = r.size;
  void show(w + 2 * MARGIN, h + 2 * MARGIN, (g) => {
    applyBatch(g, [{ region: { x: MARGIN, y: MARGIN, w, h }, stamp: r.make(w, h) }]);
    status(`${name} ${w}×${h} · blue = open / unconstrained`, 'ok');
  });
}

// one button per room type
for (const name of Object.keys(ROOMS)) button(name, () => showRoom(name));

button('— two rooms (commit)', () => {
  void show(GW, GH, (g) => {
    const r = applyBatch(g, TWO_ROOMS);
    status(r.ok ? '✓ committed 2 rooms (no conflict) · blue = still open' : '✗ unexpected conflict', r.ok ? 'ok' : 'bad');
  });
});
button('— overlapping rooms (rollback)', () => {
  void show(GW, GH, (g) => {
    const r = applyBatch(g, OVERLAPPING);
    status(r.ok ? '✓ committed (unexpected)' : `✗ incompatible floors at ${r.conflicts.length} cell(s) → whole batch rolled back, grid stays open`, r.ok ? 'ok' : 'bad');
  });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

type BoardWindow = Window & { __BOARD_READY?: boolean; __boardRoom?: (name: string) => void };
const Wn = window as BoardWindow;
Wn.__boardRoom = (name) => showRoom(name);

showRoom('throne room'); // initial view

let first = true;
function tick(): void {
  controls.update();
  renderer.render(scene, camera);
  if (first) { first = false; Wn.__BOARD_READY = true; }
  requestAnimationFrame(tick);
}
tick();
