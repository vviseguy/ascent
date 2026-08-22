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
import { abstainUnowned, ownsFloor, ownsWallN, ownsWallW } from '../floor/cell-structures.ts';
import {
  CONFLICT, CORNER_COLOR, FLOOR_COLOR, FLOOR_HATCH, SEG_COLOR, SEG_HATCH, WALLTYPE_COLOR,
  hatchesFor, legend, maskValues, mixMask, patternDefs,
} from './cell-visual.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildGrid, CELL } from './cell-preview.ts';
import { FLOOR_HEIGHT } from '../game/tower.ts';
import { toFloat } from '../sim/fixed/fixed.ts';

/* --------------------------------- palette ---------------------------------- */
// The colours, the mixing rule and the hatches live in `cell-visual.ts`, so the grid, the legend and
// the brush indicator cannot drift apart — all three read the same tables.

const domColor = mixMask;

/* ---------------------------------- state ----------------------------------- */

const U = 46;   // px per cell — big enough to drag a brush across without missing targets
const PAD = 40; // room for the edge handles
let W = 6, H = 5;
/**
 * STOREYS. A structure is not always a floor plan: a staircase has to say something about the level
 * ABOVE it — that there is a hole in that floor to climb through, and no wall standing where you
 * arrive — and a single lattice has nowhere to put that.
 *
 * `cells` stays ONE flat array, level-major, so every existing index calculation is unchanged for
 * level 0 and the storage format stays a plain list. `L` is which level you are editing; `viewAll`
 * only affects the 3D pane.
 */
let LEVELS = 1;
let L = 0;
let viewAll = true;
const stride = (): number => W + 1;
const levelSize = (): number => (W + 1) * (H + 1);
/** Base index of the level being edited — every paint and read goes through this. */
const base = (): number => L * levelSize();
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

interface Stored { w: number; h: number; levels?: number; cells: CellField[] }
let structures: Record<string, Stored> = {};
let brushes: Record<string, Stored> = {};

const blankGrid = (): CellField[] => Array.from({ length: (W + 1) * (H + 1) * LEVELS }, fullField);
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
// the ONE definition of what a padded lattice owns lives with the lattice
const hasN = (px: number): boolean => ownsWallN(px, W);
const hasW = (py: number): boolean => ownsWallW(py, H);
const hasFloor = (px: number, py: number): boolean => ownsFloor(px, py, W, H);

/**
 * The padding, PINNED to nothing — for DISPLAY only. The schematic must not draw a phantom floor or
 * wall out where the structure owns nothing, and an abstaining floor settles to `stone`, so it would.
 *
 * This is the opposite of what gets SAVED (`abstainUnowned`), and deliberately so: drawing nothing and
 * claiming nothing are different requirements over the same slots. Saving this form would have the
 * structure stamp a void along its own south and east faces.
 *
 * A TRANSFORM, not a mutation — deliberately. Pinning the live grid looked simpler and was wrong: the
 * padding is defined RELATIVE to the current size, so growing the grid turns yesterday's padding into
 * a real cell, and a destructive pin left it stuck as a pit. (It did: `+E` then `+S` produced twelve
 * pits out of nowhere.) The editor keeps what you painted; the rule applies on the way OUT.
 */
function forDisplay(): CellField[] {
  return cells.map((f, i) => {
    const within = i % levelSize();
    const px = within % stride(), py = Math.floor(within / stride());
    if (hasN(px) && hasW(py) && hasFloor(px, py)) return f;
    return {
      ...f,
      wallN: hasN(px) ? f.wallN : NONE_SEG,
      wallW: hasW(py) ? f.wallW : NONE_SEG,
      floor: hasFloor(px, py) ? f.floor : NONE_FLOOR,
    };
  });
}

/** The padding, ABSTAINING — the form that goes to the store. See `abstainUnowned`. */
const forStore = (): CellField[] => abstainUnowned(cells, W, H);

/* --------------------------------- resolving -------------------------------- */

/** Resolve for the PREVIEW under the chosen ambiguity rule. `generator` is the real one — literally
 *  the `settleField` the generator applies — and the rest are for seeing what else it could become. */
/** The resolved cells of ONE level. */
function resolvedLevel(level: number): (Cell | null)[] {
  const all = resolvedAll();
  return all.slice(level * levelSize(), (level + 1) * levelSize());
}

function resolved(): (Cell | null)[] { return resolvedLevel(L); }

function resolvedAll(): (Cell | null)[] {
  return forDisplay().map((f, i) => {
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
  const f = cells[base() + py * stride() + px];
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
      if (src) cells[base() + dy * stride() + dx] = { ...src };
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
  const oldLevel = levelSize(), newLevel = (nw + 1) * (nh + 1);
  const next: CellField[] = Array.from({ length: newLevel * LEVELS }, fullField);
  for (let lv = 0; lv < LEVELS; lv++) {           // every storey resizes together — they are one shape
    for (let py = 0; py <= H; py++) {
      for (let px = 0; px <= W; px++) {
        const tx = px + shiftX, ty = py + shiftY;
        if (tx < 0 || ty < 0 || tx > nw || ty > nh) continue;
        next[lv * newLevel + ty * (nw + 1) + tx] = { ...old[lv * oldLevel + py * ow + px]! };
      }
    }
  }
  W = nw; H = nh; cells = next;
  buildPanel(); frameCamera();
}

/* ---------------------------------- storeys ---------------------------------- */

/** Add a storey ABOVE the current one, blank (abstaining), and move to it. */
function addLevel(): void {
  pushUndo();
  const blank = Array.from({ length: levelSize() }, fullField);
  cells = [...cells, ...blank];
  LEVELS++;
  L = LEVELS - 1;
  buildPanel();
}

/** Drop the TOP storey. Never the last one — a structure with no levels is not a structure. */
function removeLevel(): void {
  if (LEVELS <= 1) return;
  pushUndo();
  cells = cells.slice(0, (LEVELS - 1) * levelSize());
  LEVELS--;
  if (L >= LEVELS) L = LEVELS - 1;
  buildPanel();
}

function setLevel(n: number): void {
  L = Math.max(0, Math.min(LEVELS - 1, n));
  buildPanel();
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
  svg.innerHTML = patternDefs(U);   // the hatch library, re-emitted with the grid it is sized for
  svg.setAttribute('width', String(PAD * 2 + W * U));
  svg.setAttribute('height', String(PAD * 2 + H * U));

  const res = resolved();
  let reach: boolean[] | null = null;
  if (showReach) {
    const g = buildCellGraph(res, stride(), H + 1);
    const start = firstWalkable(res);
    if (start >= 0) reach = reachableFromSet(g, [start]);
  }

  /* THE STOREY BELOW, ghosted underneath. Editing an upper level blind is guesswork — the whole point
     of the level above a staircase is that its hole lines up with the flight, and you cannot line
     anything up against a blank sheet. Drawn first so everything real sits on top of it. */
  if (L > 0) {
    const below = resolvedLevel(L - 1);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = below[y * stride() + x];
        if (!c || c.floor === 'none') continue;
        svg.append(svgEl('rect', {
          x: X(x) + 3, y: Y(y) + 3, width: U - 6, height: U - 6, rx: 3,
          fill: FLOOR_COLOR[c.floor], opacity: 0.22, 'pointer-events': 'none',
        }));
      }
    }
    for (let py = 0; py <= H; py++) {
      for (let px = 0; px <= W; px++) {
        const c = below[py * stride() + px];
        if (!c) continue;
        const ghost = (x2: number, y2: number, seg: Seg): void => {
          if (seg === 'none') return;
          svg.append(svgEl('line', {
            x1: X(px), y1: Y(py), x2, y2, stroke: SEG_COLOR[seg], 'stroke-width': 6,
            opacity: 0.18, 'stroke-linecap': 'round', 'pointer-events': 'none',
          }));
        };
        if (hasN(px)) ghost(X(px + 1), Y(py), c.wallN);
        if (hasW(py)) ghost(X(px), Y(py + 1), c.wallW);
      }
    }
  }

  // FLOOR — only where a cell exists
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = cells[base() + y * stride() + x]!;
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
      // HATCH — one overlay per marked value in the domain, faint while the value is only possible
      for (const { id, opacity } of hatchesFor(f.floor, FLOOR_MATERIALS, FLOOR_HATCH)) {
        svg.append(svgEl('rect', {
          x: X(x) + 3, y: Y(y) + 3, width: U - 6, height: U - 6, rx: 3,
          fill: `url(#${id})`, opacity, 'pointer-events': 'none',
        }));
      }
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
      const f = cells[base() + py * stride() + px]!;
      const line = (x2: number, y2: number, m: Mask, what: 'wallN' | 'wallW'): void => {
        const decided = domainSize(m) === 1;
        const hit = svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2, stroke: 'transparent', 'stroke-width': 18, cursor: 'pointer',
        });
        paintable(hit, (clear) => { if (brush.mode === 'wall') applyAt(px, py, what, clear); });
        svg.append(hit);
        const wide = decided ? 7 : 4;
        svg.append(svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2,
          stroke: domColor(m, SEGS, SEG_COLOR),
          'stroke-width': wide,
          'stroke-dasharray': decided ? '' : '5 4',
          'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
        // a hatched value paints its pattern INTO the stroke, so a sloped wall is diagonally hashed
        for (const { id, opacity } of hatchesFor(m, SEGS, SEG_HATCH)) {
          svg.append(svgEl('line', {
            x1: X(px), y1: Y(py), x2, y2, stroke: `url(#${id})`, 'stroke-width': wide,
            'stroke-linecap': 'round', opacity, 'pointer-events': 'none',
          }));
        }
      };
      if (hasN(px)) line(X(px + 1), Y(py), f.wallN, 'wallN');
      if (hasW(py)) line(X(px), Y(py + 1), f.wallW, 'wallW');
    }
  }

  // CORNERS
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[base() + py * stride() + px]!;
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
      // OPENING — a ring in the opening's own colour, so door/arch/window are told apart at a glance
      // rather than all reading as "something non-solid here"
      if (f.wallType !== wallTypes('solid')) {
        const opts = maskValues(f.wallType, WALL_TYPES).filter((t) => t !== 'solid');
        if (opts.length) {
          svg.append(svgEl('circle', {
            cx: X(px), cy: Y(py), r: 11, fill: 'none',
            stroke: domColor(f.wallType, WALL_TYPES, WALLTYPE_COLOR),
            'stroke-width': 2, 'stroke-dasharray': domainSize(f.wallType) === 1 ? '' : '3 3',
            'pointer-events': 'none',
          }));
        }
      }
    }
  }

  drawEdgeHandles(svg);
  buildReadout(res);
  buildBrushBar();
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

/* ------------------------------ legend + brush ------------------------------- */

/** One swatch, drawn exactly the way the grid draws that value — same colour table, same hatch. */
function swatch(color: string, hatch?: string | undefined, size = 14): SVGElement {
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.innerHTML = patternDefs(size * 3);
  svg.append(svgEl('rect', { x: 0, y: 0, width: size, height: size, rx: 3, fill: color }));
  if (hatch) svg.append(svgEl('rect', { x: 0, y: 0, width: size, height: size, rx: 3, fill: `url(#${hatch})` }));
  svg.append(svgEl('rect', { x: 0.5, y: 0.5, width: size - 1, height: size - 1, rx: 3, fill: 'none', stroke: '#0006' }));
  return svg;
}

/**
 * WHAT AM I PAINTING? The brush lived only in the panel's chip rows, which are scrolled away half the
 * time and never showed the MIX — a two-value brush looked the same as a one-value brush. This strip
 * sits above the schematic and shows the resolved swatch, so what you are about to lay down is drawn
 * in the same language as what is already on the board.
 */
function buildBrushBar(): void {
  const bar = document.getElementById('brushbar');
  if (!bar) return;
  bar.innerHTML = '';

  const chosen = (): { vals: string[]; color: string; hatches: { id: string; opacity: number }[] } => {
    if (brush.mode === 'wall') {
      const m = brush.seg.size ? segs(...brush.seg) : 0;
      return { vals: [...brush.seg], color: mixMask(m, SEGS, SEG_COLOR), hatches: hatchesFor(m, SEGS, SEG_HATCH) };
    }
    if (brush.mode === 'floor') {
      const m = brush.floor.size ? floors(...brush.floor) : 0;
      return { vals: [...brush.floor], color: mixMask(m, FLOOR_MATERIALS, FLOOR_COLOR), hatches: hatchesFor(m, FLOOR_MATERIALS, FLOOR_HATCH) };
    }
    if (brush.mode === 'corner') {
      const m = brush.corner.size ? corners(...brush.corner) : 0;
      return { vals: [...brush.corner], color: mixMask(m, CORNERS, CORNER_COLOR), hatches: [] };
    }
    if (brush.mode === 'wallType') {
      const m = brush.wallType.size ? wallTypes(...brush.wallType) : 0;
      return { vals: [...brush.wallType], color: mixMask(m, WALL_TYPES, WALLTYPE_COLOR), hatches: [] };
    }
    return { vals: [], color: '#3b6ea5', hatches: [] };
  };

  const { vals, color, hatches } = chosen();
  const sw = swatch(color, hatches[0]?.id, 18);
  bar.append(h('span', { class: 'bb-label' }, 'painting'));
  bar.append(sw);
  bar.append(h('span', { class: 'bb-mode' }, brush.mode === 'stamp' ? (activeBrush ?? 'stamp') : brush.mode));
  bar.append(h('span', { class: 'bb-vals' },
    vals.length === 0 ? (brush.mode === 'select' || brush.mode === 'stamp' ? '' : 'nothing selected')
      : vals.length === 1 ? vals[0]!
        : `${vals.join(' + ')}  — a SET, left undecided`));
  bar.append(h('span', { class: 'bb-hint' }, 'right-click = abstain'));

  /* STOREY CONTROL. Lives here rather than in the panel because it changes what the schematic MEANS —
     you need to see which level you are on in the same glance as what you are painting. */
  const lv = h('span', { class: 'bb-levels' });
  lv.append(h('span', { class: 'bb-label' }, 'storey'));
  for (let i = LEVELS - 1; i >= 0; i--) {          // highest at the left, the way a section is drawn
    lv.append(h('span', {
      class: `lvchip${i === L ? ' on' : ''}`, title: `edit storey ${i}`,
      onclick: () => setLevel(i),
    }, String(i)));
  }
  lv.append(h('button', { onclick: addLevel, title: 'add a storey above' }, '+'));
  if (LEVELS > 1) lv.append(h('button', { onclick: removeLevel, title: 'drop the top storey' }, '−'));
  if (LEVELS > 1) {
    lv.append(h('span', {
      class: `lvchip wide${viewAll ? ' on' : ''}`, title: '3D: show every storey, or only this one',
      onclick: () => { viewAll = !viewAll; buildPanel(); },
    }, viewAll ? 'all' : 'this'));
  }
  bar.append(lv);
}

/** The key. Generated from the same tables the grid draws from, so it cannot go stale. */
function buildLegend(): void {
  const box = document.getElementById('legend');
  if (!box) return;
  box.innerHTML = '';
  for (const group of legend()) {
    box.append(h('h2', {}, group.title));
    const rows = h('div', { class: 'legend-rows' });
    for (const r of group.rows) {
      const row = h('div', { class: 'legend-row' });
      row.append(swatch(r.color, r.hatch));
      row.append(h('span', {}, r.label));
      rows.append(row);
    }
    box.append(rows);
  }
  box.append(h('div', { class: 'hint' },
    'Colours MIX: a field that allows several values shows all of them blended, and the number in the '
    + 'square is how many. A hatch means that value is possible; a solid hatch means it is certain.'));
}

function buildReadout(res: (Cell | null)[]): void {
  const box = document.getElementById('ready');
  if (!box) return;
  const conflicts = res.filter((c) => c === null).length;
  let undecided = 0;
  for (let py = 0; py <= H; py++) for (let px = 0; px <= W; px++) {
    const f = cells[base() + py * stride() + px]!;
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
  /* An upper storey with no ground is normal — that is what an open shaft over a staircase IS — so it
     is only worth warning about on the ground floor, where it means the structure has no room in it. */
  const groundFloor = L === 0;
  const warn = conflicts > 0 || (walkable === 0 && groundFloor) || connected < walkable;
  box.textContent = [
    `${W}×${H} floor · ${W + 1}×${H + 1} stored`
      + (LEVELS > 1 ? ` · storey ${L} of ${LEVELS}` : ''),
    `ground: ${walkable} walkable · ${pit} pit · ${solid} rock`,
    walkable === 0
      ? (groundFloor ? '⚠ no walkable ground at all' : 'open to the storey below — no ground on this one')
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
  buildLegend();
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
  // levels are inferred from the array when absent, so a structure saved before storeys existed loads
  // as the single-level structure it is
  LEVELS = Math.max(1, s.levels ?? (Math.round(s.cells.length / ((s.w + 1) * (s.h + 1))) || 1));
  L = 0;
  cells = s.cells.map((f) => ({ ...f }));
  framedFor = '';
  buildPanel(); frameCamera();
  status(`loaded “${name}”${LEVELS > 1 ? ` · ${LEVELS} storeys` : ''}`);
}

async function saveStructure(): Promise<void> {
  const name = await ask({
    title: 'Save structure', input: 'new structure', ok: 'Save',
    body: `${W}×${H} floor cells${LEVELS > 1 ? ` × ${LEVELS} storeys` : ''}. The generator places these — an existing `
      + `structure of the same name is overwritten.`
      + (LEVELS > 1 ? ' NOTE: the generator builds one floor at a time and will not place a multi-storey structure yet.' : ''),
  });
  if (!name) return;
  // the padding rule is applied on the way OUT, so the store never carries phantom geometry
  if (await post('cell-structures', name, {
    structure: { w: W, h: H, ...(LEVELS > 1 ? { levels: LEVELS } : {}), cells: forStore() },
  })) {
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
  const norm = forDisplay();
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
  LEVELS = 1; L = 0;
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

/**
 * Frame on WHAT IS ACTUALLY BUILT, not on the cell count. A 2x2 structure spans three lattice cells
 * but its staircase is five units wide and four tall, so a distance derived from the grid size puts
 * the camera inside the model. The union of the meshes and the ground plate is the honest extent.
 */
function frameCamera(): void {
  if (!scene) return;
  const plate = new THREE.Box3(
    new THREE.Vector3((-(W + 1) * CELL) / 2, 0, (-(H + 1) * CELL) / 2),
    new THREE.Vector3(((W + 1) * CELL) / 2, toFloat(FLOOR_HEIGHT) * (LEVELS - 1), ((H + 1) * CELL) / 2),
  );
  const box = built ? new THREE.Box3().setFromObject(built).union(plate) : plate;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
  camera.position.set(centre.x + dist * 0.62, centre.y + dist * 0.58, centre.z + dist * 0.62);
  controls3d.target.copy(centre);
  controls3d.update();
}

/** Rebuilt on a short delay: painting fires per cell, and a full reload per stroke would feel stuck. */
function schedule3d(): void {
  if (!scene) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void rebuild3d(), 140);
}

let framedFor = '';
async function rebuild3d(): Promise<void> {
  if (!scene) return;
  /* Every storey, FLOOR_HEIGHT apart — or just the one being edited. "Take off layers" is the reason
     levels are worth having at all: you cannot check that a ceiling is open from above it. */
  const shown = viewAll ? Array.from({ length: LEVELS }, (_, i) => i) : [L];
  const group = new THREE.Group();
  for (const i of shown) {
    const deck = await buildGrid(resolvedLevel(i), stride(), H + 1, { w: W, h: H });
    deck.position.y = toFloat(FLOOR_HEIGHT) * i;
    group.add(deck);
  }
  if (built) scene.remove(built);
  built = group;
  scene.add(group);
  // Re-frame when the SUBJECT changes, not on every stroke — otherwise the camera yanks back to
  // default mid-edit and you lose the angle you were inspecting from.
  const key = `${W}x${H}x${shown.length}`;
  if (key !== framedFor) { framedFor = key; frameCamera(); }
}

/* ----------------------------------- panning ---------------------------------- */

/**
 * Drag the blueprint around with the MIDDLE button, or with space held. Left-drag is taken — it paints
 * — and a big multi-storey structure does not fit the pane, so scrollbars alone made lining up an
 * upper floor with the one below it a chore. Space-drag is what every drawing tool does.
 */
function wirePan(): void {
  const pane = el('twod');
  let panning = false, sx = 0, sy = 0, sl = 0, st = 0;
  let space = false;

  const begin = (ev: MouseEvent): void => {
    panning = true; sx = ev.clientX; sy = ev.clientY; sl = pane.scrollLeft; st = pane.scrollTop;
    pane.classList.add('panning');
    ev.preventDefault();
  };
  pane.addEventListener('mousedown', (ev) => {
    if (ev.button === 1 || (space && ev.button === 0)) begin(ev);
  });
  window.addEventListener('mousemove', (ev) => {
    if (!panning) return;
    pane.scrollLeft = sl - (ev.clientX - sx);
    pane.scrollTop = st - (ev.clientY - sy);
  });
  window.addEventListener('mouseup', () => { panning = false; pane.classList.remove('panning'); });
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat) return;
    // not while typing into the save dialog
    if (document.activeElement instanceof HTMLInputElement) return;
    space = true; pane.classList.add('pannable'); ev.preventDefault();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code !== 'Space') return;
    space = false; pane.classList.remove('pannable');
  });
  // the middle button otherwise starts the browser's own autoscroll
  pane.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });
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
wirePan();
