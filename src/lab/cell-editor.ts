// ============================================================================
// src/lab/cell-editor.ts — the 2u CELL structure editor.
// ============================================================================
//
// Authors the model the generator actually uses, so nothing has to be migrated on the way in.
//
// YOU ARE PAINTING THE POINT LATTICE. A w×h structure stores (w+1)×(h+1) entries, one per lattice
// POINT, which is what lets it own all four of its borders and rotate losslessly. Each point carries:
//
//     wallN     the edge running EAST from it     (exists only where px < w)
//     wallW     the edge running SOUTH from it    (exists only where py < h)
//     corner    the junction AT it                (exists everywhere)
//     floor     the ground SOUTH-EAST of it       (exists only where px < w AND py < h)
//
// The fields that do NOT exist are pinned to `none` and never drawn — the last column's `wallN` and
// the last row's `wallW` point out of the structure entirely, and drawing them put a phantom layer of
// wall and floor around every piece. The SOUTH and EAST borders are not those: they are `wallN` on the
// last ROW and `wallW` on the last COLUMN, both real and both paintable. That distinction is the whole
// reason for the padding.
//
// EVERYTHING IS A DOMAIN, not a value. A chip row is a SET: pick two and the field stays undecided and
// the generator collapses it. The difference is load-bearing —
//   pinned `none` = "this is air, and I am saying so"   → the maze cannot carve through it
//   ABSTAIN (all) = "I have no opinion"                 → the maze may do as it likes
// so leaving a field open is a real choice, not a blank. Right-click abstains.

import {
  SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES,
  type Seg, type FloorMaterial, type Corner, type WallType, type Cell,
} from '../floor/cell.ts';
import {
  fullField, collapse, settleField, domainSize, segs, floors, corners, wallTypes,
  type CellField, type Mask, type FieldKey,
} from '../floor/cell-field.ts';
import { buildCellGraph, reachableFromSet, nodeId } from '../floor/cell-graph.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildGrid, CELL } from './cell-preview.ts';

/* --------------------------------- palette ---------------------------------- */

const SEG_COLOR: Record<Seg, string> = { none: '#333a44', wall: '#e8e3da', barrier: '#7fa8c9', sloped: '#c9a87f' };
const FLOOR_COLOR: Record<FloorMaterial, string> = {
  none: '#101318', stone: '#6f6a63', dirt: '#6b5540', wood: '#8a6136', rock: '#241c14', stairs: '#b08d57',
};
const CORNER_COLOR: Record<Corner, string> = { solid: '#8a939d', column: '#e8e3da', air: '#5ad98b' };
const AMBIGUOUS = '#4a5568';
const CONFLICT = '#e0524a';

function domColor<T extends string>(m: Mask, vals: readonly T[], table: Record<T, string>): string {
  if (m === 0) return CONFLICT;
  const on = vals.filter((_, i) => (m & (1 << i)) !== 0);
  return on.length === 1 ? table[on[0]!] : AMBIGUOUS;
}

/* ---------------------------------- state ----------------------------------- */

const U = 46;   // px per cell — big enough to drag a brush across without missing targets
const PAD = 40; // room for the edge handles
let W = 6, H = 5;
const stride = (): number => W + 1;
let cells: CellField[] = [];
const undoStack: string[] = [];
let showReach = false;

type BrushMode = 'wall' | 'floor' | 'corner' | 'wallType' | 'select' | 'stamp';
/** How the PREVIEW resolves a field that is still undecided. `generator` is what actually ships. */
type Ambiguity = 'generator' | 'none' | 'wall' | 'random';

const brush = {
  mode: 'wall' as BrushMode,
  seg: new Set<Seg>(['wall']),
  floor: new Set<FloorMaterial>(['stone']),
  corner: new Set<Corner>(['solid']),
  wallType: new Set<WallType>(['solid']),
};
let ambiguity: Ambiguity = 'generator';
let selection: { x0: number; y0: number; x1: number; y1: number } | null = null;
let activeBrush: string | null = null;
let dragging = false;

interface Stored { w: number; h: number; cells: CellField[] }
let structures: Record<string, Stored> = {};
let brushes: Record<string, Stored> = {};

const blankGrid = (): CellField[] => Array.from({ length: (W + 1) * (H + 1) }, fullField);
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

const pushUndo = (): void => { undoStack.push(JSON.stringify(cells)); if (undoStack.length > 80) undoStack.shift(); };

/* ------------------------------ the padding rule ----------------------------- */

const NONE_SEG = segs('none');
const NONE_FLOOR = floors('none');
const hasN = (px: number): boolean => px < W;
const hasW = (py: number): boolean => py < H;
const hasFloor = (px: number, py: number): boolean => px < W && py < H;

/**
 * A copy with every field that does not geometrically exist pinned to `none`, so the padding can never
 * contribute a phantom wall or a floor tile the structure does not own.
 *
 * A TRANSFORM, not a mutation — deliberately. Pinning the live grid looked simpler and was wrong: the
 * padding is defined RELATIVE to the current size, so growing the grid turns yesterday's padding into
 * a real cell, and a destructive pin left it stuck as a pit. (It did: `+E` then `+S` produced twelve
 * pits out of nowhere.) The editor keeps what you painted; the rule is applied on the way OUT, to the
 * preview and to what gets saved.
 */
function normalised(): CellField[] {
  return cells.map((f, i) => {
    const px = i % stride(), py = Math.floor(i / stride());
    if (hasN(px) && hasW(py) && hasFloor(px, py)) return f;
    return {
      ...f,
      wallN: hasN(px) ? f.wallN : NONE_SEG,
      wallW: hasW(py) ? f.wallW : NONE_SEG,
      floor: hasFloor(px, py) ? f.floor : NONE_FLOOR,
    };
  });
}

/* --------------------------------- resolving -------------------------------- */

/** Resolve for the PREVIEW under the chosen ambiguity rule. `generator` is the real one — literally
 *  the `settleField` the generator applies — and the rest are for seeing what else it could become. */
function resolved(): (Cell | null)[] {
  return normalised().map((f, i) => {
    if (ambiguity === 'generator') return collapse(settleField(f));
    if (ambiguity === 'none' || ambiguity === 'wall') {
      const want = ambiguity === 'none' ? segs('none') : segs('wall');
      const prefer = (m: Mask): Mask => ((m & want) !== 0 ? (m & want) : m);
      return collapse(settleField({ ...f, wallN: prefer(f.wallN), wallW: prefer(f.wallW) }));
    }
    const hash = (i * 2654435761) >>> 0; // seeded by index, so "random" still holds still to look at
    return collapse(f, (_k, opts) => hash % opts.length);
  });
}

/* --------------------------------- painting --------------------------------- */

type Paintable = 'wallN' | 'wallW' | 'floor' | 'corner' | 'wallType';

function applyAt(px: number, py: number, what: Paintable, clear: boolean): void {
  const f = cells[py * stride() + px];
  if (!f) return;
  const pick = (): Mask | null => {
    if (what === 'wallN' || what === 'wallW') return brush.seg.size ? segs(...brush.seg) : null;
    if (what === 'floor') return brush.floor.size ? floors(...brush.floor) : null;
    if (what === 'corner') return brush.corner.size ? corners(...brush.corner) : null;
    return brush.wallType.size ? wallTypes(...brush.wallType) : null;
  };
  const m = clear ? fullField()[what as FieldKey] : pick();
  if (m === null) return;
  if (f[what as FieldKey] === m) return; // no-op — keeps a drag from flooding the undo stack
  pushUndo();
  (f as unknown as Record<string, Mask>)[what] = m;
  render();
}

function stampBrush(px: number, py: number): void {
  if (!activeBrush) return;
  const b = brushes[activeBrush];
  if (!b) return;
  pushUndo();
  const bs = b.w + 1;
  for (let by = 0; by <= b.h; by++) {
    for (let bx = 0; bx <= b.w; bx++) {
      const dx = px + bx, dy = py + by;
      if (dx > W || dy > H) continue;
      const src = b.cells[by * bs + bx];
      if (src) cells[dy * stride() + dx] = { ...src };
    }
  }
  render();
}

/* ------------------------------ grow and shrink ------------------------------ */

/**
 * Insert or remove a row/column at ONE edge. This is the resize AND the "slide the model" tool:
 * growing the north edge pushes the content down, so nudging right is `+west` then `−east`. One
 * control set, and it is always unambiguous WHICH edge moved — which a corner drag-handle never is.
 */
function edge(side: 'N' | 'S' | 'E' | 'W', delta: 1 | -1): void {
  const nw = side === 'E' || side === 'W' ? W + delta : W;
  const nh = side === 'N' || side === 'S' ? H + delta : H;
  if (nw < 1 || nh < 1) return;
  pushUndo();
  const old = cells, ow = stride();
  const shiftX = side === 'W' ? delta : 0;
  const shiftY = side === 'N' ? delta : 0;
  const next: CellField[] = Array.from({ length: (nw + 1) * (nh + 1) }, fullField);
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const tx = px + shiftX, ty = py + shiftY;
      if (tx < 0 || ty < 0 || tx > nw || ty > nh) continue;
      next[ty * (nw + 1) + tx] = { ...old[py * ow + px]! };
    }
  }
  W = nw; H = nh; cells = next;
  buildPanel(); frameCamera();
}

/* --------------------------------- rendering -------------------------------- */

const X = (u: number): number => PAD + u * U;
const Y = (v: number): number => PAD + v * U;
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
/** Wire an element for click AND drag painting, with right-click as abstain. */
function paintable(node: SVGElement, run: (clear: boolean) => void): void {
  node.addEventListener('mousedown', (ev) => {
    ev.preventDefault(); dragging = true; run((ev as MouseEvent).button === 2);
  });
  node.addEventListener('mouseenter', (ev) => { if (dragging) run((ev as MouseEvent).buttons === 2); });
}

function render(): void {
  const svg = el('grid') as unknown as SVGSVGElement;
  svg.innerHTML = '';
  svg.setAttribute('width', String(PAD * 2 + W * U));
  svg.setAttribute('height', String(PAD * 2 + H * U));

  const res = resolved();
  let reach: boolean[] | null = null;
  if (showReach) {
    const g = buildCellGraph(res, stride(), H + 1);
    const start = firstWalkable(res);
    if (start >= 0) reach = reachableFromSet(g, [start]);
  }

  // FLOOR — only where a cell exists
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = cells[y * stride() + x]!;
      const rect = svgEl('rect', {
        x: X(x) + 3, y: Y(y) + 3, width: U - 6, height: U - 6, rx: 3,
        fill: domColor(f.floor, FLOOR_MATERIALS, FLOOR_COLOR),
        stroke: '#1b1f25', 'stroke-width': 1, cursor: 'pointer',
      });
      paintable(rect, (clear) => {
        if (brush.mode === 'floor') applyAt(x, y, 'floor', clear);
        else if (brush.mode === 'stamp') stampBrush(x, y);
        else if (brush.mode === 'select') dragSelect(x, y);
      });
      svg.append(rect);
      if (domainSize(f.floor) > 1) {
        const t = svgEl('text', {
          x: X(x) + U / 2, y: Y(y) + U / 2 + 4, fill: '#8a939d', 'font-size': 11,
          'text-anchor': 'middle', 'font-family': 'ui-monospace,monospace', 'pointer-events': 'none',
        });
        t.textContent = String(domainSize(f.floor));
        svg.append(t);
      }
      if (reach && !reach[nodeId(stride(), x, y)]) {
        svg.append(svgEl('circle', { cx: X(x) + U / 2, cy: Y(y) + U / 2, r: 4, fill: CONFLICT, opacity: 0.85 }));
      }
    }
  }

  if (selection) {
    const { x0, y0, x1, y1 } = selection;
    svg.append(svgEl('rect', {
      x: X(Math.min(x0, x1)), y: Y(Math.min(y0, y1)),
      width: (Math.abs(x1 - x0) + 1) * U, height: (Math.abs(y1 - y0) + 1) * U,
      fill: '#5ad98b18', stroke: '#5ad98b', 'stroke-width': 2, 'stroke-dasharray': '6 4',
      'pointer-events': 'none', rx: 3,
    }));
  }

  // WALLS — drawn only where the edge geometrically exists
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[py * stride() + px]!;
      const line = (x2: number, y2: number, m: Mask, what: 'wallN' | 'wallW'): void => {
        const decided = domainSize(m) === 1;
        const hit = svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2, stroke: 'transparent', 'stroke-width': 18, cursor: 'pointer',
        });
        paintable(hit, (clear) => { if (brush.mode === 'wall') applyAt(px, py, what, clear); });
        svg.append(hit);
        svg.append(svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2,
          stroke: domColor(m, SEGS, SEG_COLOR),
          'stroke-width': decided ? 7 : 4,
          'stroke-dasharray': decided ? '' : '5 4',
          'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
      };
      if (hasN(px)) line(X(px + 1), Y(py), f.wallN, 'wallN');
      if (hasW(py)) line(X(px), Y(py + 1), f.wallW, 'wallW');
    }
  }

  // CORNERS
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[py * stride() + px]!;
      const decided = domainSize(f.corner) === 1;
      const dot = svgEl('circle', {
        cx: X(px), cy: Y(py), r: decided ? 6 : 4,
        fill: domColor(f.corner, CORNERS, CORNER_COLOR), stroke: '#15181c', 'stroke-width': 1.5, cursor: 'pointer',
      });
      paintable(dot, (clear) => {
        if (brush.mode === 'corner') applyAt(px, py, 'corner', clear);
        else if (brush.mode === 'wallType') applyAt(px, py, 'wallType', clear);
      });
      svg.append(dot);
      if (domainSize(f.wallType) === 1 && f.wallType !== wallTypes('solid')) {
        svg.append(svgEl('circle', {
          cx: X(px), cy: Y(py), r: 11, fill: 'none', stroke: '#d9c05a', 'stroke-width': 2, 'pointer-events': 'none',
        }));
      }
    }
  }

  drawEdgeHandles(svg);
  buildReadout(res);
  schedule3d();
}

/** −/+ on each edge: grow, shrink and slide, from one control set. */
function drawEdgeHandles(svg: SVGSVGElement): void {
  const mk = (cx: number, cy: number, label: string, title: string, onHit: () => void): void => {
    const g = svgEl('g', { cursor: 'pointer' });
    g.append(svgEl('circle', { cx, cy, r: 12, fill: '#232830' }));
    const t = svgEl('text', {
      x: cx, y: cy + 5, fill: '#c8d0d8', 'font-size': 16, 'text-anchor': 'middle',
      'font-family': 'ui-monospace,monospace', 'pointer-events': 'none',
    });
    t.textContent = label;
    g.append(t);
    const tip = svgEl('title', {});
    tip.textContent = title;
    g.append(tip);
    g.addEventListener('click', (ev) => { ev.preventDefault(); onHit(); });
    svg.append(g);
  };
  const midX = X(W / 2), midY = Y(H / 2);
  mk(midX - 16, Y(0) - 20, '−', 'remove the top row', () => edge('N', -1));
  mk(midX + 16, Y(0) - 20, '+', 'add a row at the top (pushes content down)', () => edge('N', 1));
  mk(midX - 16, Y(H) + 20, '−', 'remove the bottom row', () => edge('S', -1));
  mk(midX + 16, Y(H) + 20, '+', 'add a row at the bottom', () => edge('S', 1));
  mk(X(0) - 20, midY - 16, '−', 'remove the left column', () => edge('W', -1));
  mk(X(0) - 20, midY + 16, '+', 'add a column on the left (pushes content right)', () => edge('W', 1));
  mk(X(W) + 20, midY - 16, '−', 'remove the right column', () => edge('E', -1));
  mk(X(W) + 20, midY + 16, '+', 'add a column on the right', () => edge('E', 1));
}

function dragSelect(x: number, y: number): void {
  if (!selection || !dragging) selection = { x0: x, y0: y, x1: x, y1: y };
  else selection = { ...selection, x1: x, y1: y };
  render();
}

/* --------------------------------- readout ---------------------------------- */

function firstWalkable(res: (Cell | null)[]): number {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = res[y * stride() + x];
    if (c && c.floor !== 'none' && c.floor !== 'rock') return nodeId(stride(), x, y);
  }
  return -1;
}

function buildReadout(res: (Cell | null)[]): void {
  const box = document.getElementById('ready');
  if (!box) return;
  const conflicts = res.filter((c) => c === null).length;
  let undecided = 0;
  for (let py = 0; py <= H; py++) for (let px = 0; px <= W; px++) {
    const f = cells[py * stride() + px]!;
    if (hasFloor(px, py) && domainSize(f.floor) > 1) undecided++;
    if (hasN(px) && domainSize(f.wallN) > 1) undecided++;
    if (hasW(py) && domainSize(f.wallW) > 1) undecided++;
    if (domainSize(f.corner) > 1) undecided++;
    if (domainSize(f.wallType) > 1) undecided++;
  }
  let pit = 0, solid = 0, walkable = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = res[y * stride() + x];
    if (!c) continue;
    if (c.floor === 'none') pit++; else if (c.floor === 'rock') solid++; else walkable++;
  }
  let connected = 0;
  const start = firstWalkable(res);
  if (start >= 0) {
    const seen = reachableFromSet(buildCellGraph(res, stride(), H + 1), [start]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = res[y * stride() + x];
      if (c && c.floor !== 'none' && c.floor !== 'rock' && seen[nodeId(stride(), x, y)]) connected++;
    }
  }
  const warn = conflicts > 0 || walkable === 0 || connected < walkable;
  box.textContent = [
    `${W}×${H} floor · ${W + 1}×${H + 1} stored`,
    `ground: ${walkable} walkable · ${pit} pit · ${solid} rock`,
    walkable === 0 ? '⚠ no walkable ground at all'
      : connected < walkable ? `⚠ ${walkable - connected} walkable cell(s) cut off from the rest`
        : 'walkable area is one piece',
    `${undecided} field(s) undecided — the generator will choose`,
    conflicts ? `⚠ ${conflicts} cell(s) have an EMPTY domain` : '',
  ].filter(Boolean).join('\n');
  box.style.color = warn ? '#e0a04a' : '#7fc8a0';
}

/* ---------------------------------- modal ----------------------------------- */

/** Save, delete and clear all confirm. A stray click should never overwrite or destroy work. */
function ask(o: { title: string; body?: string; input?: string; ok: string; danger?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const m = el('modal');
    m.innerHTML = '';
    m.append(h('h3', {}, o.title));
    if (o.body) m.append(h('p', {}, o.body));
    let field: HTMLInputElement | null = null;
    if (o.input !== undefined) {
      field = h('input', { value: o.input, style: 'width:100%' }) as HTMLInputElement;
      m.append(field);
    }
    const close = (v: string | null): void => { el('veil').classList.remove('on'); resolve(v); };
    field?.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') close(field!.value.trim() || null);
      if ((ev as KeyboardEvent).key === 'Escape') close(null);
    });
    m.append(h('div', { class: 'acts' },
      h('button', { onclick: () => close(null) }, 'Cancel'),
      h('button', {
        class: o.danger ? 'danger' : 'primary',
        onclick: () => close(field ? (field.value.trim() || null) : 'ok'),
      }, o.ok)));
    el('veil').classList.add('on');
    field?.focus();
    field?.select();
  });
}

/* --------------------------------- controls --------------------------------- */

function chipRow<T extends string>(vals: readonly T[], set: Set<T>, table: Record<T, string> | null): HTMLElement {
  return h('div', { class: 'row' }, ...vals.map((v) =>
    h('div', {
      class: `chip${set.has(v) ? ' on' : ''}`,
      onclick: () => { if (set.has(v)) set.delete(v); else set.add(v); buildPanel(); },
    }, ...(table ? [h('span', { class: 'sw', style: `background:${table[v]}` })] : []), v)));
}

function listBox(store: Record<string, Stored>, onPick: (n: string) => void, onDel: (n: string) => void): HTMLElement {
  const names = Object.keys(store).sort();
  if (!names.length) return h('div', { class: 'hint', style: 'margin-top:0' }, 'none yet');
  const box = h('div', {});
  for (const n of names) {
    const s = store[n]!;
    box.append(h('div', { class: 'item' },
      h('span', { class: 'nm', onclick: () => onPick(n) }, `${n} · ${s.w}×${s.h}`),
      h('button', { class: 'danger', onclick: () => onDel(n) }, '✕')));
  }
  return box;
}

function buildPanel(): void {
  const p = el('panel');
  p.innerHTML = '';
  p.append(h('h1', {}, 'Cell Editor · 2u'));

  p.append(h('h2', {}, 'Brush'));
  const modes: [BrushMode, string][] = [
    ['wall', 'Wall'], ['floor', 'Floor'], ['corner', 'Corner'], ['wallType', 'Opening'],
    ['select', 'Select'], ['stamp', 'Stamp'],
  ];
  p.append(h('div', { class: 'row' }, ...modes.map(([m, label]) =>
    h('div', { class: `chip${brush.mode === m ? ' on' : ''}`, onclick: () => { brush.mode = m; buildPanel(); } }, label))));

  if (brush.mode === 'wall') { p.append(h('h2', {}, 'wall — a SET')); p.append(chipRow(SEGS, brush.seg, SEG_COLOR)); }
  else if (brush.mode === 'floor') { p.append(h('h2', {}, 'floor — a SET')); p.append(chipRow(FLOOR_MATERIALS, brush.floor, FLOOR_COLOR)); }
  else if (brush.mode === 'corner') { p.append(h('h2', {}, 'corner — a SET')); p.append(chipRow(CORNERS, brush.corner, CORNER_COLOR)); }
  else if (brush.mode === 'wallType') {
    p.append(h('h2', {}, 'opening — a SET'));
    p.append(chipRow(WALL_TYPES, brush.wallType, null));
    p.append(h('div', { class: 'hint' }, 'door / arch need an `air` corner to be walkable; the rest stay solid.'));
  } else if (brush.mode === 'select') {
    p.append(h('h2', {}, 'selection'));
    p.append(h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => void saveBrush() }, '＋ Save as brush'),
      h('button', { onclick: () => { selection = null; render(); } }, 'clear')));
    p.append(h('div', { class: 'hint' }, 'Drag over the floor squares to mark a region.'));
  } else {
    p.append(h('h2', {}, `stamp${activeBrush ? ` — ${activeBrush}` : ''}`));
    p.append(h('div', { class: 'hint' }, Object.keys(brushes).length
      ? 'Pick a brush below, then click to stamp it.'
      : 'No brushes yet — Select a region, then Save as brush.'));
  }

  p.append(h('h2', {}, 'Ambiguity — how the preview resolves'));
  const amb: [Ambiguity, string][] = [['generator', 'generator'], ['none', 'all none'], ['wall', 'all wall'], ['random', 'random']];
  p.append(h('div', { class: 'row' }, ...amb.map(([a, label]) =>
    h('div', { class: `chip${ambiguity === a ? ' on' : ''}`, onclick: () => { ambiguity = a; buildPanel(); } }, label))));
  p.append(h('div', { class: 'hint' }, ambiguity === 'generator'
    ? 'What actually ships: the generator’s own settle defaults.'
    : 'A what-if view — the generator still uses its own defaults.'));

  p.append(h('h2', {}, 'Grid'));
  p.append(h('div', { class: 'hint', style: 'margin-top:0' },
    'The −/+ handles around the grid grow, shrink AND slide: to nudge right, +left then −right.'));
  p.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { onclick: () => void clearAll() }, 'clear'),
    h('button', { onclick: () => { const s = undoStack.pop(); if (s) { cells = JSON.parse(s) as CellField[]; render(); } } }, '↶ undo'),
    h('button', { onclick: () => { showReach = !showReach; render(); } }, 'connectivity')));

  p.append(h('h2', {}, 'Brushes'));
  p.append(listBox(brushes, (n) => { activeBrush = n; brush.mode = 'stamp'; buildPanel(); },
    (n) => void del('cell-brushes', n, 'brush')));

  p.append(h('h2', {}, 'Structures → game'));
  p.append(listBox(structures, load, (n) => void del('cell-structures', n, 'structure')));
  p.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('button', { class: 'primary', onclick: () => void saveStructure() }, '↑ Save structure')));

  p.append(h('div', { id: 'ready' }));
  p.append(h('div', { id: 'status' }));
  render();
}

/* ------------------------------- persistence -------------------------------- */

const status = (m: string): void => { const s = document.getElementById('status'); if (s) s.textContent = m; };

async function fetchStore(kind: string): Promise<Record<string, Stored>> {
  try {
    const r = await fetch(`/__lab/${kind}`);
    return ((await r.json()) as { structures?: Record<string, Stored> }).structures ?? {};
  } catch { return {}; }
}

async function refresh(): Promise<void> {
  structures = await fetchStore('cell-structures');
  brushes = await fetchStore('cell-brushes');
  buildPanel();
}

async function post(kind: string, name: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`/__lab/${kind}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...body }),
    });
    const res = (await r.json()) as { ok: boolean; error?: string };
    if (!res.ok) status(`failed: ${res.error}`);
    return res.ok;
  } catch (e) { status(`failed: ${String(e)}`); return false; }
}

function load(name: string): void {
  const s = structures[name];
  if (!s) return;
  pushUndo();
  W = s.w; H = s.h;
  cells = s.cells.map((f) => ({ ...f }));
  buildPanel(); frameCamera();
  status(`loaded “${name}”`);
}

async function saveStructure(): Promise<void> {
  const name = await ask({
    title: 'Save structure', input: 'new structure', ok: 'Save',
    body: `${W}×${H} floor cells. The generator places these — an existing structure of the same name is overwritten.`,
  });
  if (!name) return;
  // the padding rule is applied on the way OUT, so the store never carries phantom geometry
  if (await post('cell-structures', name, { structure: { w: W, h: H, cells: normalised() } })) {
    await refresh();
    status(`saved structure “${name}”`);
  }
}

async function saveBrush(): Promise<void> {
  if (!selection) { status('select a region first'); return; }
  const x0 = Math.min(selection.x0, selection.x1), x1 = Math.max(selection.x0, selection.x1);
  const y0 = Math.min(selection.y0, selection.y1), y1 = Math.max(selection.y0, selection.y1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const name = await ask({
    title: 'Save brush', input: 'new brush', ok: 'Save',
    body: `${bw}×${bh} region, reusable with the Stamp tool. Brushes stay in the lab — the generator never sees them.`,
  });
  if (!name) return;
  // a brush is a structure too: its own point lattice, one larger than its floor extent
  const norm = normalised();
  const out: CellField[] = [];
  for (let y = y0; y <= y1 + 1; y++) {
    for (let x = x0; x <= x1 + 1; x++) {
      out.push({ ...(norm[Math.min(y, H) * stride() + Math.min(x, W)] ?? fullField()) });
    }
  }
  if (await post('cell-brushes', name, { structure: { w: bw, h: bh, cells: out } })) {
    await refresh();
    status(`saved brush “${name}”`);
  }
}

async function del(kind: string, name: string, what: string): Promise<void> {
  const go = await ask({
    title: `Delete ${what}?`, ok: 'Delete', danger: true,
    body: `“${name}” will be removed from the store. This cannot be undone.`,
  });
  if (!go) return;
  if (await post(kind, name, { remove: true })) { await refresh(); status(`deleted “${name}”`); }
}

async function clearAll(): Promise<void> {
  const go = await ask({
    title: 'Clear the grid?', ok: 'Clear', danger: true,
    body: 'Everything painted here is discarded. Undo can bring it back.',
  });
  if (!go) return;
  pushUndo();
  cells = blankGrid();
  render();
}

/* ----------------------------------- 3D ------------------------------------- */

let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera;
let renderer3d: THREE.WebGLRenderer;
let controls3d: OrbitControls;
let built: THREE.Group | null = null;
let timer: number | undefined;

function init3d(): void {
  const host = el('view3d');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181c);
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  renderer3d = new THREE.WebGLRenderer({ antialias: true });
  host.append(renderer3d.domElement);
  controls3d = new OrbitControls(camera, renderer3d.domElement);
  controls3d.enableDamping = true;

  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 12, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899ff, 0.4); fill.position.set(-6, 5, -4); scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  // setSize's third argument must NOT be false: it leaves the canvas at its intrinsic CSS size,
  // overflowing the pane with an aspect that no longer matches, and the scene draws off screen.
  const fit = (): void => {
    const r = host.getBoundingClientRect();
    const wpx = Math.max(1, Math.floor(r.width)), hpx = Math.max(1, Math.floor(r.height));
    renderer3d.setSize(wpx, hpx);
    camera.aspect = wpx / hpx;
    camera.updateProjectionMatrix();
  };
  fit();
  new ResizeObserver(fit).observe(host); // a flex pane's size is not final at boot
  (function loop(): void { controls3d.update(); if (scene) renderer3d.render(scene, camera); requestAnimationFrame(loop); })();
  frameCamera();
}

function frameCamera(): void {
  if (!scene) return;
  const span = Math.max(W, H) * CELL;
  camera.position.set(span * 0.85, span * 0.8, span * 0.85);
  controls3d.target.set(0, 0, 0);
  controls3d.update();
}

/** Rebuilt on a short delay: painting fires per cell, and a full reload per stroke would feel stuck. */
function schedule3d(): void {
  if (!scene) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void rebuild3d(), 140);
}

async function rebuild3d(): Promise<void> {
  if (!scene) return;
  const group = await buildGrid(resolved(), stride(), H + 1, { w: W, h: H });
  if (built) scene.remove(built);
  built = group;
  scene.add(group);
}

/* --------------------------------- splitter --------------------------------- */

/**
 * Drag the divider to trade space between the schematic and the 3D. Sizes are set as flex-BASIS in
 * percent, so the split survives a window resize instead of drifting; the ResizeObserver on the 3D
 * pane picks the new size up on its own.
 */
function initSplit(): void {
  const bar = el('split'), left = el('twod'), right = el('view3d');
  bar.addEventListener('mousedown', (down) => {
    down.preventDefault();
    bar.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev: MouseEvent): void => {
      const host = left.parentElement!.getBoundingClientRect();
      const panel = el('panel').getBoundingClientRect().width;
      const avail = host.width - panel - bar.offsetWidth;
      const pct = Math.min(85, Math.max(15, ((ev.clientX - host.left - panel) / avail) * 100));
      left.style.flex = `0 0 ${pct}%`;
      right.style.flex = `1 1 ${100 - pct}%`;
    };
    const up = (): void => {
      bar.classList.remove('drag');
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

/* ---------------------------------- boot ------------------------------------ */

document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mouseup', () => { dragging = false; });
el('hint').textContent =
  'drag to paint · right-click ABSTAINS (restores the full domain) · dashed = undecided · '
  + 'the −/+ handles grow, shrink and slide the grid · the last column has no east-running edge and '
  + 'the last row no south-running one, so those are not drawn — but the SOUTH and EAST borders are, '
  + 'and they are what the padding exists for.';
cells = blankGrid();
init3d();
initSplit();
buildPanel();   // draw immediately; the store fetch only fills the two lists
void refresh();
