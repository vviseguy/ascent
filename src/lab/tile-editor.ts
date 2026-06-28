// ============================================================================
// src/lab/tile-editor.ts — the 9-cell TILE PAINT EDITOR (tile-editor.html).
// ============================================================================
//
// Paint TileFields (src/floor/wall-tile-field.ts) on a grid and watch them collapse to real meshes.
//   • SECTION brush — paint any of a tile's 9 wall sections (4 edge, 4 inner, centre) with a chosen
//     set of {none, wall, barrier}. Painting OVERRIDES that cell's domain with the selected set
//     (one value = pinned; several = an ambiguous domain).
//   • WALL-TYPE brush — paint a whole tile's opening (solid / door / window / hole / arch / gate).
//   • FLOOR brush — paint floor material (whole tile or one corner).
//   • STAMP brush — drop a saved COMBO (a whole designed tile) onto tiles.
// Ambiguous cells (a domain with >1 option) are DERIVED to one value for the preview by the chosen
// rule: all→none / all→wall / all→barrier / random(seed). Combos can be saved, re-loaded onto the
// active tile to edit, and deleted; they persist in localStorage. The 2D schematic and the 3D
// preview both show the derived result, so what you paint is what the game would build.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGrid, type TileGrid } from '../floor/tile-grid.ts';
import { fullField, template, collapse, segs, centres, wallTypes, floors, domainSize, type TileField } from '../floor/wall-tile-field.ts';
import { DIRS, FLOOR_CORNERS, type Dir, type Seg, type Centre, type WallType, type FloorMaterial, type FloorCorner } from '../floor/wall-tile.ts';
import { tilePlacements } from './wall-tile-assets.ts';
import { instance } from './tile-render.ts';

/* ------------------------------- value palettes ------------------------------ */

const SEGS: Seg[] = ['none', 'wall', 'barrier'];
const WALLTYPE_LIST: WallType[] = ['solid', 'door', 'window', 'hole', 'arch', 'low_gate'];
const FLOOR_LIST: FloorMaterial[] = ['none', 'stone', 'dirt', 'wood'];
const WT_LETTER: Record<WallType, string> = { solid: '·', door: 'D', window: 'W', hole: 'H', arch: 'A', low_gate: 'G' };

// Sections are coloured by their DOMAIN as ADDITIVE RGB — none→red, wall→green, barrier→blue. A
// multi-option domain MIXES channels (none+wall = yellow, all three = white, empty = black), so the
// constraint graph reads at a glance: pure colour = pinned, mixed = ambiguous. Bit order none=1,wall=2,barrier=4.
const ON = 210, OFF = 45;
const SEG_COLOR: Record<Seg, string> = { none: `rgb(${ON},${OFF},${OFF})`, wall: `rgb(${OFF},${ON},${OFF})`, barrier: `rgb(${OFF},${OFF},${ON})` };
const segFill = (m: number): string => `rgb(${m & 1 ? ON : OFF},${m & 2 ? ON : OFF},${m & 4 ? ON : OFF})`;
// Floor keeps recognisable material colours, blended across a multi-material domain.
const FLOOR_RGB: Record<FloorMaterial, [number, number, number]> = { none: [24, 24, 34], stone: [138, 138, 147], dirt: [125, 96, 68], wood: [156, 106, 56] };
const floorColor = (v: FloorMaterial): string => `rgb(${FLOOR_RGB[v].join(',')})`;
const floorFill = (m: number): string => {
  const vs = FLOOR_LIST.filter((_, i) => m & (1 << i));
  if (!vs.length) return '#000';
  const sum: [number, number, number] = [0, 0, 0];
  for (const v of vs) { const c = FLOOR_RGB[v]; sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; }
  return `rgb(${Math.round(sum[0] / vs.length)},${Math.round(sum[1] / vs.length)},${Math.round(sum[2] / vs.length)})`;
};

type DeriveMode = 'none' | 'wall' | 'barrier' | 'random';

/* ---------------------------------- state ------------------------------------ */

/** A blank, fully-pinned tile: floor none, all walls none, solid — a clean concrete slate. */
function blank(): TileField {
  return template({
    floor: { nw: floors('none'), ne: floors('none'), sw: floors('none'), se: floors('none') },
    edge: { N: segs('none'), E: segs('none'), S: segs('none'), W: segs('none') },
    inner: { N: segs('none'), E: segs('none'), S: segs('none'), W: segs('none') },
    centre: centres('none'), wallType: wallTypes('solid'),
  });
}
function blankGrid(w: number, h: number): TileGrid { const g = makeGrid(w, h); g.cells = g.cells.map(blank); return g; }

let GW = 6, GH = 6;
let grid: TileGrid = blankGrid(GW, GH); // cells start blank (concrete none); paint to add, "open tile" to make ambiguous
let activeTile = 0;
let derive: DeriveMode = 'none';
let seed = 1;

const brush = {
  mode: 'section' as 'section' | 'wallType' | 'floor' | 'stamp',
  seg: new Set<Seg>(['wall']),
  wallType: new Set<WallType>(['door']),
  floor: new Set<FloorMaterial>(['stone']),
  floorWhole: true,
  combo: null as string | null,
};

const LSKEY = 'tileEditor.combos.v1';
const combos = loadCombos();

function loadCombos(): Map<string, TileField> {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LSKEY) ?? '{}') as Record<string, TileField>)); } catch { return new Map(); }
}
function persistCombos(): void { localStorage.setItem(LSKEY, JSON.stringify(Object.fromEntries(combos))); }
const cloneField = (f: TileField): TileField => ({ floor: { ...f.floor }, edge: { ...f.edge }, inner: { ...f.inner }, centre: f.centre, wallType: f.wallType });

/* ----------------------------- ambiguity → value ----------------------------- */

function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Build the collapse `pick` for the current derive mode (random uses a fresh seeded rng per call). */
function picker(): (cell: string, opts: readonly string[]) => number {
  if (derive === 'random') { const rng = mulberry32(seed); return (_c, opts) => Math.floor(rng() * opts.length); }
  return (_c, opts) => { const i = opts.indexOf(derive); return i >= 0 ? i : 0; }; // prefer the target value, else canonical
}

/* ----------------------------------- paint ----------------------------------- */

function paint(i: number, kind: string, id: string): void {
  const f = grid.cells[i]!;
  if (brush.mode === 'section' && kind === 'seg') {
    if (brush.seg.size === 0) return;
    if (id === 'centre') f.centre = centres(...([...brush.seg] as Centre[]));
    else { const [grp, dir] = id.split('.') as ['edge' | 'inner', Dir]; f[grp][dir] = segs(...brush.seg); }
  } else if (brush.mode === 'floor' && kind === 'floor') {
    if (brush.floor.size === 0) return;
    const m = floors(...brush.floor);
    if (brush.floorWhole) for (const c of FLOOR_CORNERS) f.floor[c] = m;
    else f.floor[id as FloorCorner] = m;
  } else if (brush.mode === 'wallType') {
    if (brush.wallType.size === 0) return;
    f.wallType = wallTypes(...brush.wallType);
  } else if (brush.mode === 'stamp' && brush.combo) {
    const c = combos.get(brush.combo);
    if (c) grid.cells[i] = cloneField(c);
  } else return;
  activeTile = i;
  render();
}

/* ------------------------------- 2D schematic -------------------------------- */

const T = 84, GAP = 8, C = T / 2;
// each wall section as an SVG rect (x,y,w,h) in tile-local coords
const SEG_RECT: Record<string, [number, number, number, number]> = {
  'edge.N': [C - 18, 1, 36, 9], 'edge.S': [C - 18, T - 10, 36, 9], 'edge.W': [1, C - 18, 9, 36], 'edge.E': [T - 10, C - 18, 9, 36],
  'inner.N': [C - 6, 16, 12, 17], 'inner.S': [C - 6, 51, 12, 17], 'inner.W': [16, C - 6, 17, 12], 'inner.E': [51, C - 6, 17, 12],
  centre: [C - 9, C - 9, 18, 18],
};
const CORNER_RECT: Record<FloorCorner, [number, number, number, number]> = { nw: [0, 0, C, C], ne: [C, 0, C, C], sw: [0, C, C, C], se: [C, C, C, C] };

const gridSvg = document.getElementById('grid') as unknown as SVGSVGElement;

function rect(x: number, y: number, w: number, h: number, fill: string, stroke: string, dashed: boolean, data: string): string {
  const d = dashed ? ' stroke-dasharray="3 2"' : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="${fill}" stroke="${stroke}" stroke-width="1"${d} ${data}/>`;
}

function tileSvg(i: number): string {
  const f = grid.cells[i]!;
  const gx = (i % GW) * (T + GAP), gy = Math.floor(i / GW) * (T + GAP);
  let s = `<g transform="translate(${gx},${gy})">`;
  // floor quadrants (bottom layer) — the (blended) material domain
  for (const c of FLOOR_CORNERS) {
    const [x, y, w, hh] = CORNER_RECT[c];
    s += `<rect class="floorLayer" x="${x}" y="${y}" width="${w}" height="${hh}" fill="${floorFill(f.floor[c])}" stroke="#0004" stroke-width="0.5" data-tile="${i}" data-kind="floor" data-id="${c}"/>`;
  }
  // wall sections (top layer) — additive RGB of the section's domain
  for (const id of Object.keys(SEG_RECT)) {
    const [x, y, w, hh] = SEG_RECT[id]!;
    const grp = id.split('.')[0] as 'edge' | 'inner';
    const dir = id.split('.')[1] as Dir;
    const mask = id === 'centre' ? f.centre : f[grp][dir];
    s += rect(x, y, w, hh, segFill(mask), '#0007', false, `class="wallLayer" data-tile="${i}" data-kind="seg" data-id="${id}"`);
  }
  // wall-type badge: the pinned opening letter, or ∗ when its domain is still open
  const wtVals = WALLTYPE_LIST.filter((_, k) => f.wallType & (1 << k));
  const badge = wtVals.length > 1 ? '∗' : wtVals[0] && wtVals[0] !== 'solid' ? WT_LETTER[wtVals[0]] : '';
  if (badge) s += `<text x="4" y="14" font-size="11" fill="#ffd27a" font-weight="700">${badge}</text>`;
  // tile outline + active highlight
  s += `<rect x="0" y="0" width="${T}" height="${T}" fill="none" stroke="${i === activeTile ? '#3a78ff' : '#34344e'}" stroke-width="${i === activeTile ? 2 : 1}" pointer-events="none"/>`;
  s += '</g>';
  return s;
}

function renderSvg(): void {
  gridSvg.setAttribute('width', String(GW * (T + GAP)));
  gridSvg.setAttribute('height', String(GH * (T + GAP)));
  gridSvg.setAttribute('class', `mode-${brush.mode}`);
  let s = '';
  for (let i = 0; i < grid.cells.length; i++) s += tileSvg(i);
  gridSvg.innerHTML = s;
}

/* --------------------------------- 3D preview -------------------------------- */

const CELL = 4;
const view = document.getElementById('view3d') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14141e);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
camera.position.set(6, 40, 22);
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(12, 22, 8); scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.3); fill.position.set(-10, 8, -12); scene.add(fill);
view.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
let group = new THREE.Group();
scene.add(group);
let gen3d = 0;

function fit3d(): void {
  const w = view.clientWidth || 1, h = view.clientHeight || 1;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function render3d(): Promise<void> {
  const myGen = ++gen3d;
  scene.remove(group);
  group = new THREE.Group();
  scene.add(group);
  const ox = -((GW - 1) / 2) * CELL, oz = -((GH - 1) / 2) * CELL;
  const pick = picker();
  for (let i = 0; i < grid.cells.length; i++) {
    const t = collapse(grid.cells[i]!, pick);
    if (!t) continue;
    const wx = ox + (i % GW) * CELL, wz = oz + Math.floor(i / GW) * CELL;
    for (const p of tilePlacements(t)) {
      const root = await instance(p.url, p.scale);
      if (myGen !== gen3d) return;
      root.position.set(wx + p.x, p.y, wz + p.z);
      root.rotation.y = p.yaw;
      group.add(root);
    }
  }
}

/* ----------------------------------- render ---------------------------------- */

function render(): void {
  renderSvg();
  void render3d();
  const f = grid.cells[activeTile]!;
  const amb = [...DIRS.map((d) => f.edge[d]), ...DIRS.map((d) => f.inner[d]), f.centre].filter((m) => domainSize(m) > 1).length;
  status(`tile ${activeTile % GW},${Math.floor(activeTile / GW)} · ${amb} ambiguous section(s) · derive: ${derive}`);
}
const statusEl = document.getElementById('status')!;
const hintEl = document.getElementById('hint')!;
function status(msg: string): void { statusEl.textContent = msg; }

/* -------------------------------- controls UI -------------------------------- */

function h(tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k === 'onclick') e.addEventListener('click', v as EventListener);
    else if (k === 'style') e.setAttribute('style', String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  for (const kid of kids) e.append(kid);
  return e;
}
const swatch = (color: string): HTMLElement => h('span', { class: 'swatch', style: `background:${color}` });

const ctrlBox = document.getElementById('controls')!;
function buildControls(): void {
  ctrlBox.innerHTML = '';

  ctrlBox.append(h('h2', {}, 'Brush'));
  const modes: [typeof brush.mode, string][] = [['section', 'Section'], ['wallType', 'Wall type'], ['floor', 'Floor'], ['stamp', 'Stamp combo']];
  ctrlBox.append(h('div', { class: 'row' }, ...modes.map(([m, label]) =>
    h('div', { class: `chip${brush.mode === m ? ' on' : ''}`, onclick: () => { brush.mode = m; buildControls(); renderSvg(); } }, label))));

  ctrlBox.append(h('div', { id: 'brushValues' }));
  buildBrushValues();

  ctrlBox.append(h('h2', {}, 'Ambiguity →'));
  const dmodes: [DeriveMode, string][] = [['none', 'all none'], ['wall', 'all wall'], ['barrier', 'all barrier'], ['random', 'random']];
  ctrlBox.append(h('div', { class: 'row' }, ...dmodes.map(([m, label]) =>
    h('div', { class: `chip${derive === m ? ' on' : ''}`, onclick: () => { derive = m; buildControls(); render(); } }, label))));
  if (derive === 'random') {
    const seedIn = h('input', { type: 'number', value: String(seed) }) as HTMLInputElement;
    seedIn.addEventListener('change', () => { seed = Number(seedIn.value) | 0; render(); });
    ctrlBox.append(h('div', { class: 'row', style: 'margin-top:6px;align-items:center' }, 'seed ', seedIn,
      h('button', { onclick: () => { seed = (seed + 1) | 0; buildControls(); render(); } }, 'reseed')));
  }

  ctrlBox.append(h('h2', {}, 'Combos'));
  ctrlBox.append(h('div', { id: 'combos' }));
  buildCombos();
  ctrlBox.append(h('button', { style: 'margin-top:6px', onclick: saveCombo }, '＋ Save active tile'));

  ctrlBox.append(h('h2', {}, 'Grid'));
  const wIn = h('input', { type: 'number', value: String(GW), min: '1', max: '14' }) as HTMLInputElement;
  const hIn = h('input', { type: 'number', value: String(GH), min: '1', max: '14' }) as HTMLInputElement;
  ctrlBox.append(h('div', { class: 'row', style: 'align-items:center' }, wIn, '×', hIn,
    h('button', { onclick: () => resizeGrid(Number(wIn.value) | 0, Number(hIn.value) | 0) }, 'resize')));
  ctrlBox.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { onclick: () => { grid = blankGrid(GW, GH); activeTile = 0; render(); } }, 'clear grid'),
    h('button', { title: 'make the active tile fully ambiguous (every section open) to test the derive modes', onclick: fillActiveOpen }, 'open tile ∗')));
}

function buildBrushValues(): void {
  const box = document.getElementById('brushValues')!;
  box.innerHTML = '';
  const valChip = (label: string, color: string | null, on: boolean, toggle: () => void): HTMLElement => {
    const c = h('div', { class: `chip val${on ? ' on' : ''}`, onclick: () => { toggle(); buildBrushValues(); } }, ...(color ? [swatch(color)] : []), label);
    return c;
  };
  const toggleSet = <T>(set: Set<T>, v: T) => () => { set.has(v) ? set.delete(v) : set.add(v); };

  if (brush.mode === 'section') {
    box.append(h('div', { style: 'color:#99a;margin:6px 0 4px' }, 'click a section (edge / inner / centre):'));
    box.append(h('div', { class: 'row' }, ...SEGS.map((v) => valChip(v, SEG_COLOR[v], brush.seg.has(v), toggleSet(brush.seg, v)))));
  } else if (brush.mode === 'wallType') {
    box.append(h('div', { style: 'color:#99a;margin:6px 0 4px' }, 'click a tile to set its opening:'));
    box.append(h('div', { class: 'row' }, ...WALLTYPE_LIST.map((v) => valChip(v, null, brush.wallType.has(v), toggleSet(brush.wallType, v)))));
  } else if (brush.mode === 'floor') {
    box.append(h('div', { style: 'color:#99a;margin:6px 0 4px' }, 'click a corner (or whole tile):'));
    box.append(h('div', { class: 'row' }, ...FLOOR_LIST.map((v) => valChip(v, floorColor(v), brush.floor.has(v), toggleSet(brush.floor, v)))));
    const wholeCk = h('input', { type: 'checkbox', checked: brush.floorWhole }) as HTMLInputElement;
    wholeCk.addEventListener('change', () => { brush.floorWhole = wholeCk.checked; });
    box.append(h('label', { class: 'ck' }, wholeCk, 'whole tile'));
  } else {
    box.append(h('div', { style: 'color:#99a;margin:6px 0' }, brush.combo ? `stamping “${brush.combo}” — click tiles` : 'pick a combo below, then click tiles'));
  }
}

function buildCombos(): void {
  const box = document.getElementById('combos')!;
  box.innerHTML = '';
  if (combos.size === 0) { box.append(h('div', { style: 'color:#778' }, 'none yet')); return; }
  for (const name of [...combos.keys()].sort()) {
    box.append(h('div', { class: `combo${brush.combo === name ? ' sel' : ''}` },
      h('span', { class: 'name', title: 'select for the Stamp brush', onclick: () => { brush.combo = name; brush.mode = 'stamp'; buildControls(); renderSvg(); } }, name),
      h('button', { title: 'load onto active tile to edit', onclick: () => { grid.cells[activeTile] = cloneField(combos.get(name)!); render(); } }, 'edit'),
      h('button', { title: 'delete', onclick: () => { combos.delete(name); if (brush.combo === name) brush.combo = null; persistCombos(); buildCombos(); } }, '✕')));
  }
}

function saveCombo(): void {
  const name = prompt('Combo name:', `combo ${combos.size + 1}`);
  if (!name) return;
  combos.set(name, cloneField(grid.cells[activeTile]!));
  persistCombos();
  brush.combo = name;
  buildCombos();
}

function resizeGrid(w: number, h: number): void {
  w = Math.max(1, Math.min(14, w)); h = Math.max(1, Math.min(14, h));
  const next = blankGrid(w, h);
  for (let y = 0; y < Math.min(h, GH); y++) for (let x = 0; x < Math.min(w, GW); x++) next.cells[y * w + x] = grid.cells[y * GW + x]!;
  GW = w; GH = h; grid = next; activeTile = Math.min(activeTile, w * h - 1);
  render();
}
function fillActiveOpen(): void { grid.cells[activeTile] = fullField(); render(); }

/* --------------------------------- wiring ------------------------------------ */

let painting = false;
function handle(e: Event): void {
  const el = (e.target as Element).closest('[data-tile]');
  if (!el) return;
  paint(Number(el.getAttribute('data-tile')), el.getAttribute('data-kind') ?? '', el.getAttribute('data-id') ?? '');
}
gridSvg.addEventListener('mousedown', (e) => { painting = true; handle(e); });
gridSvg.addEventListener('mouseover', (e) => { if (painting) handle(e); });
window.addEventListener('mouseup', () => { painting = false; });
window.addEventListener('resize', fit3d);

hintEl.textContent = 'drag to paint · orbit/scroll the 3D · section colour = domain: 🔴none 🟢wall 🔵barrier (mixed = ambiguous, white = any)';
buildControls();
fit3d();
render();

(window as unknown as { __TE_READY?: boolean }).__TE_READY = true;
(function loop(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
