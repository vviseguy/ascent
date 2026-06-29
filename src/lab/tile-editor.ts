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
import { makeGrid, resolveGrid, type TileGrid } from '../floor/tile-grid.ts';
import { cornerGraphOf, reachableFrom, cornerId } from '../floor/corner-graph.ts';
import { fullField, template, segs, centres, wallTypes, floors, domainSize, type TileField } from '../floor/wall-tile-field.ts';
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
let showReach = false; // overlay the corner-graph reachability from the active tile's NW corner

const brush = {
  mode: 'section' as 'section' | 'wallType' | 'floor' | 'stamp',
  seg: new Set<Seg>(['wall']),
  wallType: new Set<WallType>(['door']),
  floor: new Set<FloorMaterial>(['stone']),
  floorWhole: false, // default to PER-CORNER so corners can be painted individually
  combo: null as string | null,
  rightMode: 'clear' as 'clear' | 'fill', // what a RIGHT-click writes: 'clear' → none, 'fill' → the full domain (everything)
};

// Right-click writes one of these, per target, depending on brush.rightMode. 'clear' pins the
// default value (none / solid); 'fill' opens the whole domain (every option) — handy for testing derive.
const FULL_SEG = segs('none', 'wall', 'barrier'), FULL_CENTRE = centres('none', 'wall', 'barrier');
const FULL_FLOOR = floors('none', 'stone', 'dirt', 'wood'), FULL_WT = wallTypes(...WALLTYPE_LIST);

/** A structure saved to the server (the game-loadable shape; mirrors src/game/structures.ts). */
interface ServerStructure { w: number; h: number; cells: TileField[]; derive?: string; seed?: number; savedAt?: string }
let serverStructures: Record<string, ServerStructure> = {};

const LSKEY = 'tileEditor.combos.v1';
const combos = loadCombos();

function loadCombos(): Map<string, TileField> {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(LSKEY) ?? '{}') as Record<string, TileField>)); } catch { return new Map(); }
}
function persistCombos(): void { localStorage.setItem(LSKEY, JSON.stringify(Object.fromEntries(combos))); }
const cloneField = (f: TileField): TileField => ({ floor: { ...f.floor }, edge: { ...f.edge }, inner: { ...f.inner }, centre: f.centre, wallType: f.wallType });

/* ----------------------------------- undo ------------------------------------ */
// Whole-grid snapshots (dims + cells + cursor). A paint DRAG pushes ONE snapshot at stroke start
// (markStroke, guarded by strokePushed) so Ctrl+Z undoes the entire stroke, not each cell; discrete
// actions (clear / open / resize / load / edit-combo) push their own. Cheap: cells are tiny masks.
interface Snapshot { gw: number; gh: number; cells: TileField[]; active: number }
const undoStack: Snapshot[] = [];
const UNDO_MAX = 80;
let strokePushed = false; // has THIS drag already captured an undo snapshot?
function pushUndo(): void {
  undoStack.push({ gw: GW, gh: GH, cells: grid.cells.map(cloneField), active: activeTile });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function markStroke(): void { if (!strokePushed) { pushUndo(); strokePushed = true; } }
function undo(): void {
  const s = undoStack.pop();
  if (!s) { status('nothing to undo'); return; }
  GW = s.gw; GH = s.gh; activeTile = Math.min(s.active, s.gw * s.gh - 1);
  const g = makeGrid(GW, GH); g.cells = s.cells.map(cloneField); grid = g;
  buildControls(); render();
  status(`undo · ${undoStack.length} step(s) left`);
}

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

function paint(i: number, kind: string, id: string, button: number): void {
  const f = grid.cells[i]!;
  const right = button === 2;           // right-click writes clear/everything (brush.rightMode), not the brush value
  const fill = brush.rightMode === 'fill';
  if (brush.mode === 'section' && kind === 'seg') {
    let m: number;
    if (right) m = id === 'centre' ? (fill ? FULL_CENTRE : centres('none')) : (fill ? FULL_SEG : segs('none'));
    else { if (brush.seg.size === 0) return; m = id === 'centre' ? centres(...([...brush.seg] as Centre[])) : segs(...brush.seg); }
    markStroke();
    if (id === 'centre') f.centre = m;
    else { const [grp, dir] = id.split('.') as ['edge' | 'inner', Dir]; f[grp][dir] = m; }
  } else if (brush.mode === 'floor' && kind === 'floor') {
    let m: number;
    if (right) m = fill ? FULL_FLOOR : floors('none');
    else { if (brush.floor.size === 0) return; m = floors(...brush.floor); }
    markStroke();
    if (brush.floorWhole) for (const c of FLOOR_CORNERS) f.floor[c] = m;
    else f.floor[id as FloorCorner] = m;
  } else if (brush.mode === 'wallType') {
    let m: number;
    if (right) m = fill ? FULL_WT : wallTypes('solid');
    else { if (brush.wallType.size === 0) return; m = wallTypes(...brush.wallType); }
    markStroke();
    f.wallType = m;
  } else if (brush.mode === 'stamp') {
    if (right) { markStroke(); grid.cells[i] = fill ? fullField() : blank(); }
    else { if (!brush.combo) return; const c = combos.get(brush.combo); if (!c) return; markStroke(); grid.cells[i] = cloneField(c); }
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
  // wall sections (top layer) — additive RGB of the section's domain. EDGES are single-owned (§12 #4):
  // a tile owns only N+W; its E/S are the neighbour's W/N (shown on that neighbour) — so we draw/paint
  // only edge.N + edge.W here. All 4 inner cells + centre stay per-tile.
  for (const id of Object.keys(SEG_RECT)) {
    if (id === 'edge.E' || id === 'edge.S') continue; // not owned by this tile
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
  if (showReach) s += reachOverlay();
  gridSvg.innerHTML = s;
}

/** Overlay the corner-graph: a dot at every corner node, coloured by reachability from the active
 *  tile's NW corner (blue = start, green = reachable, red = unreachable). Proves the §2 verifier on
 *  the tiles you're authoring — same resolved tiles the game/collision use. */
function reachOverlay(): string {
  const pk = picker();
  const g = cornerGraphOf(grid, (_x, _y, cell, opts) => pk(cell, opts));
  const start = cornerId(GW, activeTile % GW, Math.floor(activeTile / GW));
  const seen = reachableFrom(g, start);
  const px = (cx: number): number => (cx < GW ? cx * (T + GAP) : (GW - 1) * (T + GAP) + T);
  const py = (cy: number): number => (cy < GH ? cy * (T + GAP) : (GH - 1) * (T + GAP) + T);
  let o = '<g pointer-events="none">';
  for (let cy = 0; cy <= GH; cy++) {
    for (let cx = 0; cx <= GW; cx++) {
      const id = cornerId(GW, cx, cy);
      const isStart = id === start;
      const fill = isStart ? '#3a78ff' : seen[id] ? '#36d07a' : '#e2493f';
      o += `<circle cx="${px(cx)}" cy="${py(cy)}" r="${isStart ? 5 : 3.5}" fill="${fill}" stroke="#0009" stroke-width="0.5"/>`;
    }
  }
  return o + '</g>';
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
  // RESOLVE once (owner edges + perimeter borders) — the 3D preview now shows exactly what the game
  // builds from these tiles (§12 #4), not a per-cell view that could disagree on shared edges.
  const tiles = resolveGrid(grid, (_x, _y, cell, opts) => pick(cell, opts));
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
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

  ctrlBox.append(h('h2', { title: 'what a RIGHT-click writes (instead of the brush value)' }, 'Right-click ↦'));
  const rmodes: [typeof brush.rightMode, string][] = [['clear', 'clear (none)'], ['fill', 'everything ∗']];
  ctrlBox.append(h('div', { class: 'row' }, ...rmodes.map(([m, label]) =>
    h('div', { class: `chip${brush.rightMode === m ? ' on' : ''}`, onclick: () => { brush.rightMode = m; buildControls(); } }, label))));

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

  ctrlBox.append(h('h2', {}, 'Combos (local)'));
  ctrlBox.append(h('div', { id: 'combos' }));
  buildCombos();
  ctrlBox.append(h('button', { style: 'margin-top:6px', onclick: saveCombo }, '＋ Save active tile'));

  ctrlBox.append(h('h2', {}, 'Structures (server → game)'));
  ctrlBox.append(h('div', { id: 'structures' }));
  buildStructures();
  ctrlBox.append(h('button', { style: 'margin-top:6px', onclick: () => void saveStructure() }, '⬆ Save grid to server'));

  ctrlBox.append(h('h2', {}, 'Grid'));
  const wIn = h('input', { type: 'number', value: String(GW), min: '1', max: '14' }) as HTMLInputElement;
  const hIn = h('input', { type: 'number', value: String(GH), min: '1', max: '14' }) as HTMLInputElement;
  ctrlBox.append(h('div', { class: 'row', style: 'align-items:center' }, wIn, '×', hIn,
    h('button', { onclick: () => resizeGrid(Number(wIn.value) | 0, Number(hIn.value) | 0) }, 'resize')));
  ctrlBox.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { onclick: () => { pushUndo(); grid = blankGrid(GW, GH); activeTile = 0; render(); } }, 'clear grid'),
    h('button', { title: 'make the active tile fully ambiguous (every section open) to test the derive modes', onclick: fillActiveOpen }, 'open tile ∗'),
    h('button', { title: 'undo the last change (Ctrl+Z)', onclick: undo }, '↶ undo')));
  const reachCk = h('input', { type: 'checkbox', checked: showReach }) as HTMLInputElement;
  reachCk.addEventListener('change', () => { showReach = reachCk.checked; renderSvg(); });
  ctrlBox.append(h('label', { class: 'ck', title: 'overlay corner-graph reachability from the active tile’s NW corner — blue start, green reachable, red not (the §2 solvability check)' }, reachCk, 'show connectivity'));
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
      h('button', { title: 'load onto active tile to edit', onclick: () => { pushUndo(); grid.cells[activeTile] = cloneField(combos.get(name)!); render(); } }, 'edit'),
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

/* --- server-persisted structures (git-tracked; the game loads these) --- */

const STRUCT_URL = '/__lab/structures';
async function fetchStructures(): Promise<void> {
  try {
    const r = await fetch(STRUCT_URL);
    serverStructures = ((await r.json()) as { structures?: Record<string, ServerStructure> }).structures ?? {};
  } catch { serverStructures = {}; }
  buildStructures();
}
function buildStructures(): void {
  const box = document.getElementById('structures');
  if (!box) return;
  box.innerHTML = '';
  const names = Object.keys(serverStructures).sort();
  if (!names.length) { box.append(h('div', { style: 'color:#778' }, 'none yet')); return; }
  for (const name of names) {
    const s = serverStructures[name];
    if (!s) continue;
    box.append(h('div', { class: 'combo' },
      h('span', { class: 'name', title: `${s.w}×${s.h} — load into the editor`, onclick: () => loadStructure(name) }, `${name} · ${s.w}×${s.h}`),
      h('button', { title: 'delete from server', onclick: () => void deleteStructure(name) }, '✕')));
  }
}
async function saveStructure(): Promise<void> {
  const name = prompt('Structure name (saved to the server for the game):', `structure ${Object.keys(serverStructures).length + 1}`);
  if (!name) return;
  const structure: ServerStructure = { w: GW, h: GH, cells: grid.cells, derive, seed };
  try {
    const r = await fetch(STRUCT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, structure }) });
    const res = (await r.json()) as { ok: boolean; count?: number; error?: string };
    status(res.ok ? `saved “${name}” to server → structures.json (${res.count} total)` : `save failed: ${res.error}`);
    if (res.ok) await fetchStructures();
  } catch (e) { status(`save failed: ${String(e)}`); }
}
function loadStructure(name: string): void {
  const s = serverStructures[name];
  if (!s) return;
  pushUndo();
  const g = makeGrid(s.w, s.h);
  g.cells = s.cells.map(cloneField);
  grid = g; GW = s.w; GH = s.h; activeTile = 0;
  if (s.derive === 'none' || s.derive === 'wall' || s.derive === 'barrier' || s.derive === 'random') derive = s.derive;
  if (typeof s.seed === 'number') seed = s.seed;
  buildControls(); render();
}
async function deleteStructure(name: string): Promise<void> {
  try { await fetch(STRUCT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, remove: true }) }); } catch { /* ignore */ }
  await fetchStructures();
}

function resizeGrid(w: number, h: number): void {
  w = Math.max(1, Math.min(14, w)); h = Math.max(1, Math.min(14, h));
  pushUndo();
  const next = blankGrid(w, h);
  for (let y = 0; y < Math.min(h, GH); y++) for (let x = 0; x < Math.min(w, GW); x++) next.cells[y * w + x] = grid.cells[y * GW + x]!;
  GW = w; GH = h; grid = next; activeTile = Math.min(activeTile, w * h - 1);
  render();
}
function fillActiveOpen(): void { pushUndo(); grid.cells[activeTile] = fullField(); render(); }

/* --------------------------------- wiring ------------------------------------ */

let painting = false;
let strokeButton = 0; // which mouse button started the current drag (0 left = brush value, 2 right = clear/everything)
function handle(e: MouseEvent): void {
  const el = (e.target as Element).closest('[data-tile]');
  if (!el) return;
  paint(Number(el.getAttribute('data-tile')), el.getAttribute('data-kind') ?? '', el.getAttribute('data-id') ?? '', strokeButton);
}
gridSvg.addEventListener('mousedown', (e) => { painting = true; strokeButton = e.button; strokePushed = false; handle(e); });
gridSvg.addEventListener('mouseover', (e) => { if (painting) handle(e); });
window.addEventListener('mouseup', () => { painting = false; });
gridSvg.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag paints; no browser menu
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !(document.activeElement instanceof HTMLInputElement)) {
    e.preventDefault(); undo();
  }
});
window.addEventListener('resize', fit3d);

hintEl.textContent = 'left-drag paints · right-drag = clear/everything · Ctrl+Z undo · edges N+W owned (E/S = neighbour’s; 3D shows the resolved result) · colour = domain: 🔴none 🟢wall 🔵barrier';
buildControls();
void fetchStructures();
fit3d();
render();

(window as unknown as { __TE_READY?: boolean }).__TE_READY = true;
(function loop(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
