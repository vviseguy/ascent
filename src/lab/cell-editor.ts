// ============================================================================
// src/lab/cell-editor.ts — the 2u CELL structure editor.
// ============================================================================
//
// Paints the model the generator actually uses. The 4u tile editor (`tile-editor.ts`) paints the old
// nine-cell tile and its output has to be migrated; this one is native.
//
// YOU ARE PAINTING THE POINT LATTICE. A w×h structure is stored as (w+1)×(h+1) entries, one per
// lattice POINT, because that is what makes a structure symmetric — it owns all four of its borders,
// so rotating it loses nothing. Each point carries:
//
//     wallN     the edge running EAST from it       (click the horizontal line)
//     wallW     the edge running SOUTH from it      (click the vertical line)
//     corner    the junction AT it                  (click the dot)
//     wallType  which 4u module is drawn there      (click the dot, in wallType mode)
//
// and the FLOOR of the cell to its south-east (click the square).
//
// EVERYTHING IS A DOMAIN, not a value. A chip row is a SET: pick two and the cell stays undecided
// between them, and the generator collapses it. That distinction is load-bearing —
//   pinned `none`   = "this is air, and I am saying so"       → the maze cannot carve through it
//   ABSTAIN (all)   = "I have no opinion"                     → the maze may do as it likes
// so leaving a field open is a real choice, not a blank. Right-click abstains; the readout counts how
// much of the structure is still undecided.

import {
  SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES,
  type Seg, type FloorMaterial, type Corner, type WallType,
} from '../floor/cell.ts';
import {
  fullField, template, collapse, previewCell, domainSize, segs, floors, corners, wallTypes,
  segValues, floorValues, cornerValues, wallTypeValues,
  type CellField, type Mask,
} from '../floor/cell-field.ts';
import { buildCellGraph, reachableFromSet, nodeId } from '../floor/cell-graph.ts';
import type { Cell } from '../floor/cell.ts';

/* --------------------------------- palette ---------------------------------- */

const SEG_COLOR: Record<Seg, string> = {
  none: '#2b3038', wall: '#e8e3da', barrier: '#7fa8c9', sloped: '#c9a87f',
};
const FLOOR_COLOR: Record<FloorMaterial, string> = {
  none: '#101318', stone: '#6f6a63', dirt: '#6b5540', wood: '#8a6136', rock: '#2b2118',
};
const CORNER_COLOR: Record<Corner, string> = { solid: '#8a939d', column: '#e8e3da', air: '#5ad98b' };
const AMBIGUOUS = '#4a5568';
const CONFLICT = '#e0524a';

/** One colour for a DOMAIN: its own colour when decided, a muted grey when still undecided, red when
 *  nothing is left. Reading "is this decided?" at a glance is most of what the editor is for. */
function domColor<T extends string>(m: Mask, vals: readonly T[], table: Record<T, string>): string {
  if (m === 0) return CONFLICT;
  const on = vals.filter((_, i) => (m & (1 << i)) !== 0);
  return on.length === 1 ? table[on[0]!] : AMBIGUOUS;
}

/* ---------------------------------- state ----------------------------------- */

const U = 34;             // px per cell
const PAD = 26;
let W = 6, H = 5;          // FLOOR extent; the stored lattice is (W+1)x(H+1)
const stride = (): number => W + 1;
let cells: CellField[] = [];
let undoStack: string[] = [];
let showReach = false;
let serverStructures: Record<string, { w: number; h: number; cells: CellField[] }> = {};

const blankGrid = (): CellField[] => Array.from({ length: (W + 1) * (H + 1) }, fullField);

type BrushMode = 'wall' | 'floor' | 'corner' | 'wallType';
const brush = {
  mode: 'wall' as BrushMode,
  seg: new Set<Seg>(['wall']),
  floor: new Set<FloorMaterial>(['stone']),
  corner: new Set<Corner>(['solid']),
  wallType: new Set<WallType>(['solid']),
};

const el = (id: string): HTMLElement => document.getElementById(id)!;
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

const pushUndo = (): void => {
  undoStack.push(JSON.stringify(cells));
  if (undoStack.length > 60) undoStack.shift();
};

/* --------------------------------- painting --------------------------------- */

/** Paint one field of one point. Right-click ABSTAINS — restores the full domain — because "I have no
 *  opinion" is a value you need to be able to get back to, not just a starting state. */
function paint(px: number, py: number, what: BrushMode, clear: boolean): void {
  const i = py * stride() + px;
  const f = cells[i];
  if (!f) return;
  const blank = fullField();
  pushUndo();
  if (what === 'wall') {
    const m = clear ? blank.wallN : segs(...brush.seg);
    if (brush.seg.size === 0 && !clear) return;
    // which edge was clicked is decided by the caller via `what`; see the two wrappers below
    cells[i] = { ...f, wallN: m };
  } else if (what === 'floor') {
    cells[i] = { ...f, floor: clear ? blank.floor : floors(...brush.floor) };
  } else if (what === 'corner') {
    cells[i] = { ...f, corner: clear ? blank.corner : corners(...brush.corner) };
  } else {
    cells[i] = { ...f, wallType: clear ? blank.wallType : wallTypes(...brush.wallType) };
  }
  render();
}

function paintWall(px: number, py: number, side: 'N' | 'W', clear: boolean): void {
  const i = py * stride() + px;
  const f = cells[i];
  if (!f) return;
  if (brush.seg.size === 0 && !clear) return;
  pushUndo();
  const m = clear ? fullField().wallN : segs(...brush.seg);
  cells[i] = side === 'N' ? { ...f, wallN: m } : { ...f, wallW: m };
  render();
}

/* --------------------------------- rendering -------------------------------- */

const X = (u: number): number => PAD + u * U;
const Y = (v: number): number => PAD + v * U;
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

function render(): void {
  const svg = el('grid') as unknown as SVGSVGElement;
  svg.innerHTML = '';
  svg.setAttribute('width', String(PAD * 2 + W * U));
  svg.setAttribute('height', String(PAD * 2 + H * U));

  // reachability overlay, computed on the COLLAPSED cells — the same read the generator's gate uses
  let reach: boolean[] | null = null;
  if (showReach) {
    // preview with the GENERATOR'S settle defaults, not a bare collapse — otherwise the editor
    // shows a structure that is not the one the generator builds
    const resolved = cells.map((f) => previewCell(f)) as (Cell | null)[];
    const g = buildCellGraph(resolved, stride(), H + 1);
    let start = -1;
    for (let y = 0; y < H && start < 0; y++) for (let x = 0; x < W && start < 0; x++) {
      const c = resolved[y * stride() + x];
      if (c && c.floor !== 'none' && c.floor !== 'rock') start = nodeId(stride(), x, y);
    }
    if (start >= 0) reach = reachableFromSet(g, [start]);
  }

  // FLOOR squares — one per cell, i.e. per point with a cell to its south-east
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = cells[y * stride() + x]!;
      const rect = svgEl('rect', {
        x: X(x), y: Y(y), width: U, height: U,
        fill: domColor(f.floor, FLOOR_MATERIALS, FLOOR_COLOR),
        stroke: '#1b1f25', 'stroke-width': 1, cursor: 'pointer',
      });
      rect.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        if (brush.mode === 'floor') paint(x, y, 'floor', (ev as MouseEvent).button === 2);
      });
      svg.append(rect);
      if (reach && !reach[nodeId(stride(), x, y)]) {
        svg.append(svgEl('circle', { cx: X(x) + U / 2, cy: Y(y) + U / 2, r: 3, fill: CONFLICT, opacity: 0.8 }));
      }
      if (domainSize(f.floor) > 1) {
        // a number in the square = how many materials it could still be
        const t = svgEl('text', {
          x: X(x) + U / 2, y: Y(y) + U / 2 + 3, fill: '#8a939d', 'font-size': 9,
          'text-anchor': 'middle', 'font-family': 'ui-monospace,monospace', 'pointer-events': 'none',
        });
        t.textContent = String(domainSize(f.floor));
        svg.append(t);
      }
    }
  }

  // WALLS — the edge running east (wallN) and the edge running south (wallW) from each point
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[py * stride() + px]!;
      if (px < W) {
        const line = svgEl('line', {
          x1: X(px), y1: Y(py), x2: X(px + 1), y2: Y(py),
          stroke: domColor(f.wallN, SEGS, SEG_COLOR),
          'stroke-width': domainSize(f.wallN) === 1 ? 5 : 3,
          'stroke-dasharray': domainSize(f.wallN) === 1 ? '' : '4 3',
          'stroke-linecap': 'round', cursor: 'pointer',
        });
        line.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          if (brush.mode === 'wall') paintWall(px, py, 'N', (ev as MouseEvent).button === 2);
        });
        svg.append(svgEl('line', {
          x1: X(px), y1: Y(py), x2: X(px + 1), y2: Y(py), stroke: 'transparent', 'stroke-width': 12,
        }));
        svg.append(line);
      }
      if (py < H) {
        const line = svgEl('line', {
          x1: X(px), y1: Y(py), x2: X(px), y2: Y(py + 1),
          stroke: domColor(f.wallW, SEGS, SEG_COLOR),
          'stroke-width': domainSize(f.wallW) === 1 ? 5 : 3,
          'stroke-dasharray': domainSize(f.wallW) === 1 ? '' : '4 3',
          'stroke-linecap': 'round', cursor: 'pointer',
        });
        line.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          if (brush.mode === 'wall') paintWall(px, py, 'W', (ev as MouseEvent).button === 2);
        });
        svg.append(line);
      }
    }
  }

  // CORNERS — the junction at each point, and its wallType glyph
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[py * stride() + px]!;
      const decided = domainSize(f.corner) === 1;
      const dot = svgEl('circle', {
        cx: X(px), cy: Y(py), r: decided ? 4.5 : 3,
        fill: domColor(f.corner, CORNERS, CORNER_COLOR),
        stroke: '#15181c', 'stroke-width': 1, cursor: 'pointer',
      });
      dot.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const clear = (ev as MouseEvent).button === 2;
        if (brush.mode === 'corner') paint(px, py, 'corner', clear);
        else if (brush.mode === 'wallType') paint(px, py, 'wallType', clear);
      });
      svg.append(dot);
      const wt = wallTypeValues(f.wallType);
      if (domainSize(f.wallType) === 1 && wt[0] !== 'solid') {
        svg.append(svgEl('circle', { cx: X(px), cy: Y(py), r: 8, fill: 'none', stroke: '#d9c05a', 'stroke-width': 1.5 }));
      }
    }
  }

  buildReadout();
}

/* --------------------------------- readout ---------------------------------- */

/** What the generator will make of this, said plainly. The 4u editor had no equivalent, and it showed:
 *  a structure was saved whose floor was entirely `none` — a pit — without anything pointing it out. */
function buildReadout(): void {
  const resolved = cells.map((f) => previewCell(f)) as (Cell | null)[];
  const conflicts = resolved.filter((c) => c === null).length;
  let undecided = 0;
  for (const f of cells) {
    for (const m of [f.floor, f.wallN, f.wallW, f.corner, f.wallType]) if (domainSize(m) > 1) undecided++;
  }
  let pit = 0, solid = 0, walkable = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = resolved[y * stride() + x];
    if (!c) continue;
    if (c.floor === 'none') pit++;
    else if (c.floor === 'rock') solid++;
    else walkable++;
  }
  // is the walkable part one piece?
  const g = buildCellGraph(resolved, stride(), H + 1);
  let start = -1;
  for (let y = 0; y < H && start < 0; y++) for (let x = 0; x < W && start < 0; x++) {
    const c = resolved[y * stride() + x];
    if (c && c.floor !== 'none' && c.floor !== 'rock') start = nodeId(stride(), x, y);
  }
  let connected = 0;
  if (start >= 0) {
    const seen = reachableFromSet(g, [start]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = resolved[y * stride() + x];
      if (c && c.floor !== 'none' && c.floor !== 'rock' && seen[nodeId(stride(), x, y)]) connected++;
    }
  }
  const lines = [
    `${W}×${H} floor · ${(W + 1)}×${(H + 1)} stored`,
    `ground: ${walkable} walkable · ${pit} pit · ${solid} rock`,
    walkable > 0 && connected < walkable
      ? `⚠ ${walkable - connected} walkable cell(s) cut off from the rest`
      : walkable > 0 ? 'walkable area is one piece' : '⚠ no walkable ground at all',
    `${undecided} field(s) still undecided (the generator will choose)`,
    conflicts ? `⚠ ${conflicts} cell(s) have an EMPTY domain — they cannot collapse` : '',
  ].filter(Boolean);
  el('ready').textContent = lines.join('\n');
  el('ready').style.color = conflicts || (walkable > 0 && connected < walkable) || walkable === 0 ? '#e0a04a' : '#7fc8a0';
}

/* --------------------------------- controls --------------------------------- */

function chipRow<T extends string>(
  vals: readonly T[], set: Set<T>, table: Record<T, string>, after: () => void,
): HTMLElement {
  return h('div', { class: 'row' }, ...vals.map((v) =>
    h('div', {
      class: `chip${set.has(v) ? ' on' : ''}`,
      onclick: () => { if (set.has(v)) set.delete(v); else set.add(v); after(); },
    }, h('span', { class: 'sw', style: `background:${table[v]}` }), v)));
}

function buildPanel(): void {
  const p = el('panel');
  p.innerHTML = '';
  p.append(h('h1', {}, 'Cell Structure Editor · 2u'));

  p.append(h('h2', {}, 'Brush'));
  const modes: [BrushMode, string][] = [['wall', 'Wall'], ['floor', 'Floor'], ['corner', 'Corner'], ['wallType', 'Wall type']];
  p.append(h('div', { class: 'row' }, ...modes.map(([m, label]) =>
    h('div', { class: `chip${brush.mode === m ? ' on' : ''}`, onclick: () => { brush.mode = m; buildPanel(); } }, label))));

  p.append(h('h2', {}, `${brush.mode} — pick a SET`));
  if (brush.mode === 'wall') p.append(chipRow(SEGS, brush.seg, SEG_COLOR, buildPanel));
  else if (brush.mode === 'floor') p.append(chipRow(FLOOR_MATERIALS, brush.floor, FLOOR_COLOR, buildPanel));
  else if (brush.mode === 'corner') p.append(chipRow(CORNERS, brush.corner, CORNER_COLOR, buildPanel));
  else {
    p.append(h('div', { class: 'row' }, ...WALL_TYPES.map((v) =>
      h('div', {
        class: `chip${brush.wallType.has(v) ? ' on' : ''}`,
        onclick: () => { if (brush.wallType.has(v)) brush.wallType.delete(v); else brush.wallType.add(v); buildPanel(); },
      }, v))));
    p.append(h('div', { class: 'hint' }, 'door/arch need an `air` corner to be walkable; the rest stay solid.'));
  }

  p.append(h('h2', {}, 'Grid'));
  const wIn = h('input', { type: 'number', value: String(W), min: '1' }) as HTMLInputElement;
  const hIn = h('input', { type: 'number', value: String(H), min: '1' }) as HTMLInputElement;
  p.append(h('div', { class: 'row' }, wIn, h('span', {}, '×'), hIn, h('button', {
    onclick: () => {
      const nw = Math.max(1, Number(wIn.value) | 0), nh = Math.max(1, Number(hIn.value) | 0);
      pushUndo();
      const old = cells, ow = stride();
      W = nw; H = nh;
      cells = blankGrid();
      for (let y = 0; y <= Math.min(nh, old.length / ow - 1); y++) {
        for (let x = 0; x <= nw; x++) {
          const src = old[y * ow + x];
          if (src && x < ow) cells[y * stride() + x] = { ...src };
        }
      }
      buildPanel(); render();
    },
  }, 'resize')));
  p.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { onclick: () => { pushUndo(); cells = blankGrid(); render(); } }, 'clear'),
    h('button', { onclick: () => { const s = undoStack.pop(); if (s) { cells = JSON.parse(s) as CellField[]; render(); } } }, '↶ undo'),
    h('button', { onclick: () => { showReach = !showReach; render(); } }, 'connectivity')));

  p.append(h('h2', {}, 'Structures (server → game)'));
  p.append(h('div', { id: 'list' }));
  p.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { onclick: () => void save() }, '↑ Save to server')));

  p.append(h('div', { id: 'ready' }));
  p.append(h('div', { id: 'status' }));
  buildList();
}

function buildList(): void {
  const box = document.getElementById('list');
  if (!box) return;
  box.innerHTML = '';
  const names = Object.keys(serverStructures).sort();
  if (!names.length) { box.append(h('div', { style: 'color:#6f7780' }, 'none yet')); return; }
  for (const n of names) {
    const s = serverStructures[n]!;
    box.append(h('div', { class: 'item' },
      h('span', { class: 'nm', title: 'load into the editor', onclick: () => load(n) }, `${n} · ${s.w}×${s.h}`),
      h('button', { title: 'delete', onclick: () => void del(n) }, '✕')));
  }
}

const URL_STORE = '/__lab/cell-structures';
const status = (m: string): void => { el('status').textContent = m; };

async function fetchList(): Promise<void> {
  try {
    const r = await fetch(URL_STORE);
    serverStructures = ((await r.json()) as { structures?: typeof serverStructures }).structures ?? {};
  } catch { serverStructures = {}; }
  buildList();
}

function load(name: string): void {
  const s = serverStructures[name];
  if (!s) return;
  pushUndo();
  W = s.w; H = s.h;
  cells = s.cells.map((f) => ({ ...f }));
  buildPanel(); render();
  status(`loaded “${name}”`);
}

async function save(): Promise<void> {
  const name = prompt('Structure name:', `structure ${Object.keys(serverStructures).length + 1}`);
  if (!name) return;
  try {
    const r = await fetch(URL_STORE, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, structure: { w: W, h: H, cells } }),
    });
    const res = (await r.json()) as { ok: boolean; count?: number; error?: string };
    status(res.ok ? `saved “${name}” → cell-structures.json (${res.count} total)` : `save failed: ${res.error}`);
    if (res.ok) await fetchList();
  } catch (e) { status(`save failed: ${String(e)}`); }
}

async function del(name: string): Promise<void> {
  if (!confirm(`Delete “${name}”?`)) return;
  await fetch(URL_STORE, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, remove: true }),
  });
  await fetchList();
  status(`deleted “${name}”`);
}

/* ---------------------------------- boot ------------------------------------ */

document.addEventListener('contextmenu', (e) => e.preventDefault());
el('hint').textContent =
  'click a LINE to paint a wall · a SQUARE for floor · a DOT for the corner / wall type · '
  + 'right-click ABSTAINS (restores the full domain) · dashed = still undecided · '
  + 'the grid is the POINT lattice, so a w×h structure stores (w+1)×(h+1)';
cells = blankGrid();
buildPanel();
render();
void fetchList();
void template;
void segValues; void floorValues; void cornerValues;
