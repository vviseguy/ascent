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
//
// THE GESTURES. Left paints every target you cross. Right abstains the one you pressed on — and a
// right press that then MOVES becomes a box instead, filled with the brush on release (Shift fills it
// with abstentions). A box spans whatever kind of thing it was anchored on, never a guess at which
// channels you meant. COPY is the odd brush out: it carries a whole lattice point rather than one
// channel of it, so it is the only way to say "make this bit look like that bit".

import {
  SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES, TORCHES, OPENS,
  isStairFloor,
  type Seg, type FloorMaterial, type Corner, type WallType, type Torch, type Open, type Cell,
} from '../floor/cell.ts';
import {
  fullField, collapse, settleField, domainSize, segs, floors, corners, wallTypes, torches, opens,
  FIELD_KEYS, type CellField, type Mask, type FieldKey,
} from '../floor/cell-field.ts';
import { buildCellGraph, reachableFromSet, nodeId } from '../floor/cell-graph.ts';
import { stairFault, stairFaultText, stairFlight } from '../floor/cell-place.ts';
import { abstainUnowned, ownsFloor, ownsWallN, ownsWallW } from '../floor/cell-structures.ts';
import {
  CASING, cornerInk, cornerStrength, floorInk, floorValueColor, floorValueHatch, legend,
  openingIsPlain, openingRings, openState, patternDefs, segInk, segValueColor,
  CORNER_SWATCH, FLOOR_SWATCH, SEG_SWATCH, WALLTYPE_SWATCH, OPEN_SWATCH, TORCH_SWATCH, TORCH_MARK, torchState,
} from './cell-visual.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildGrid, CELL } from './cell-preview.ts';
import { FLOOR_HEIGHT } from '../game/tower.ts';
import { toFloat } from '../sim/fixed/fixed.ts';

/* --------------------------------- palette ---------------------------------- */
// The channel alphabet, the hatches and the legend all live in `cell-visual.ts`, so the grid, the key
// and the brush strip cannot drift apart — all three read the same tables.

const CONFLICT = '#ff2d55';

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

type BrushMode = 'wall' | 'floor' | 'corner' | 'wallType' | 'open' | 'torch' | 'copy' | 'select' | 'stamp';
/** How the PREVIEW resolves a field that is still undecided. `generator` is what actually ships. */
type Ambiguity = 'generator' | 'none' | 'wall' | 'random';

const brush = {
  mode: 'wall' as BrushMode,
  seg: new Set<Seg>(['wall']),
  floor: new Set<FloorMaterial>(['stone']),
  corner: new Set<Corner>(['column']),
  wallType: new Set<WallType>(['solid']),
  open: new Set<Open>(['open']),
  torch: new Set<Torch>(['yes']),
};
let ambiguity: Ambiguity = 'generator';
let selection: { x0: number; y0: number; x1: number; y1: number } | null = null;
let activeBrush: string | null = null;
let dragging = false;

interface Stored { w: number; h: number; levels?: number; cells: CellField[] }
let structures: Record<string, Stored> = {};
let brushes: Record<string, Stored> = {};
// The structure this grid was LOADED from, so putting it back needs no dialog. Null means the grid is
// not (yet) any stored structure: a fresh page, or one that has been cleared.
let loadedName: string | null = null;

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

const pushUndoFrom = (snapshot: string): void => {
  undoStack.push(snapshot);
  if (undoStack.length > 80) undoStack.shift();
};
const pushUndo = (): void => pushUndoFrom(JSON.stringify(cells));

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

type Paintable = 'wallN' | 'wallW' | 'floor' | 'corner' | 'wallType' | 'open' | 'torch';

/** What this brush would lay down for `what` — null when the brush has no value picked. */
function maskFor(what: Paintable, clear: boolean): Mask | null {
  if (clear) return fullField()[what as FieldKey];
  if (what === 'wallN' || what === 'wallW') return brush.seg.size ? segs(...brush.seg) : null;
  if (what === 'floor') return brush.floor.size ? floors(...brush.floor) : null;
  if (what === 'corner') return brush.corner.size ? corners(...brush.corner) : null;
  if (what === 'torch') return brush.torch.size ? torches(...brush.torch) : null;
  if (what === 'open') return brush.open.size ? opens(...brush.open) : null;
  return brush.wallType.size ? wallTypes(...brush.wallType) : null;
}

/**
 * THE ONLY WRITER of a single channel. It does not push undo and does not redraw, because a box fill
 * writes hundreds of points and wants ONE undo entry and ONE frame for the lot. Returns whether it
 * changed anything, which is also what keeps a drag that re-crosses its own path off the undo stack.
 */
function setAt(px: number, py: number, what: Paintable, clear: boolean): boolean {
  const f = cells[base() + py * stride() + px];
  if (!f) return false;
  const m = maskFor(what, clear);
  if (m === null || f[what as FieldKey] === m) return false;
  (f as unknown as Record<string, Mask>)[what] = m;
  return true;
}

/** One target painted by hand: its own undo entry, its own redraw. */
function applyAt(px: number, py: number, what: Paintable, clear: boolean): void {
  const snapshot = JSON.stringify(cells);
  if (!setAt(px, py, what, clear)) return;
  pushUndoFrom(snapshot);
  render();
}

/* -------------------------------- the clipboard ------------------------------- */
// COPY is the only brush that carries a WHOLE lattice point — floor, the two walls that start there,
// corner, opening type, open, torch — rather than one channel of it. That is what makes it the answer
// to "make this bit look like that bit", which no single-channel brush can express.

let clip: CellField | null = null;
let clipFrom: { x: number; y: number; level: number } | null = null;
/** Picking and pasting share the left button, so the drag that FOLLOWS a pick must not paste. */
let pickedThisDrag = false;

const sameField = (a: CellField, b: CellField): boolean => FIELD_KEYS.every((k) => a[k] === b[k]);

function pickField(px: number, py: number): void {
  const f = cells[base() + py * stride() + px];
  if (!f) return;
  clip = { ...f };
  clipFrom = { x: px, y: py, level: L };
  buildPanel();
  status(`copied the cell at (${px},${py})`);
}

/** Paste the held cell, or — with `clear` — hand the whole point back to the generator. */
function setField(px: number, py: number, clear: boolean): boolean {
  const i = base() + py * stride() + px;
  const f = cells[i];
  if (!f) return false;
  const next = clear ? fullField() : clip ? { ...clip } : null;
  if (!next || sameField(f, next)) return false;
  cells[i] = next;
  return true;
}

function applyField(px: number, py: number, clear: boolean): void {
  if (!clear && !clip) { status('nothing copied yet — click a cell to pick one up'); return; }
  const snapshot = JSON.stringify(cells);
  if (!setField(px, py, clear)) return;
  pushUndoFrom(snapshot);
  render();
}

/* ----------------------------------- the box ---------------------------------- */
// RIGHT-DRAG rubber-bands a rectangle and fills it on release. A right press that never LEAVES its
// target is still the abstain it always was — the box is armed on press and only fires once the
// pointer has moved — so nothing that used to work stopped working. Shift makes the box abstain
// instead of paint, which is the swath-erase a right-drag used to be.
//
// The rectangle spans whatever kind of thing it was anchored on: start on a north wall and it fills
// north walls, start on a corner and it fills corners, start in COPY and it fills whole cells. A box
// that guessed which channels you meant would be wrong half the time, so it never guesses.

type BoxKind = Paintable | 'field';
interface Box {
  kind: BoxKind; x0: number; y0: number; x1: number; y1: number;
  clear: boolean; moved: boolean;
  /** What a press that never moved should do instead: the plain right-click abstain. */
  anchor: () => void;
}
let box: Box | null = null;

function applyBox(b: Box): void {
  if (b.kind === 'field' && !b.clear && !clip) {
    status('nothing copied yet — click a cell to pick one up');
    return;
  }
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  const snapshot = JSON.stringify(cells);   // taken BEFORE the fill: one entry undoes the whole box
  let n = 0;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      if (px > W || py > H) continue;
      if (b.kind === 'field') { if (setField(px, py, b.clear)) n++; continue; }
      // a channel that does not exist at this point is skipped, never pinned — the padding rule
      if (b.kind === 'floor' && !hasFloor(px, py)) continue;
      if (b.kind === 'wallN' && !hasN(px)) continue;
      if (b.kind === 'wallW' && !hasW(py)) continue;
      if (setAt(px, py, b.kind, b.clear)) n++;
    }
  }
  if (!n) { status('the box changed nothing'); return; }
  pushUndoFrom(snapshot);
  status(`${b.clear ? 'cleared' : 'filled'} ${n} ${n === 1 ? 'point' : 'points'}`);
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
/** One gesture on one target. `press` separates the mousedown that STARTS a drag from the rest of it. */
interface Hit { clear: boolean; alt: boolean; press: boolean }

/**
 * Wire an element for click AND drag painting.
 *
 *   LEFT           paints every target you cross
 *   RIGHT          abstains the one you pressed on
 *   RIGHT + move   rubber-bands a box and fills it on release (Shift: abstains it)
 *
 * `kind` is what a box anchored HERE would fill; null means this element does not box in the current
 * mode, and a right press on it stays a plain abstain.
 */
function paintable(node: SVGElement, px: number, py: number, kind: BoxKind | null,
                   run: (hit: Hit) => void): void {
  node.addEventListener('mousedown', (ev) => {
    const e = ev as MouseEvent;
    e.preventDefault();
    dragging = true;
    if (e.button === 2 && kind) {
      // ARMED, not fired. Nothing happens until mouseup, and that is the whole trick: a right-click
      // that never moved still resolves to the abstain it has always been.
      box = {
        kind, x0: px, y0: py, x1: px, y1: py, clear: e.shiftKey, moved: false,
        anchor: () => run({ clear: true, alt: e.altKey, press: true }),
      };
      return;
    }
    run({ clear: e.button === 2, alt: e.altKey, press: true });
  });
  node.addEventListener('mouseenter', (ev) => {
    if (!dragging) return;
    const e = ev as MouseEvent;
    if (box) {
      // only targets of the anchor's own kind stretch it — crossing a wall mid-corner-box means nothing
      if (kind === box.kind) { box.x1 = px; box.y1 = py; box.moved = true; render(); }
      return;
    }
    run({ clear: e.buttons === 2, alt: e.altKey, press: false });
  });
}

function render(): void {
  saveDraft();
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
          fill: floorValueColor(c.floor), opacity: 0.2, 'pointer-events': 'none',
        }));
        // the ghost keeps its HATCH: a staircase below is the thing you are lining a hole up with, and
        // a flat wash of colour does not tell you where it is
        const gh = floorValueHatch(c.floor);
        if (gh) {
          svg.append(svgEl('rect', {
            x: X(x) + 3, y: Y(y) + 3, width: U - 6, height: U - 6, rx: 3,
            fill: `url(#${gh})`, opacity: 0.35, 'pointer-events': 'none',
          }));
        }
      }
    }
    for (let py = 0; py <= H; py++) {
      for (let px = 0; px <= W; px++) {
        const c = below[py * stride() + px];
        if (!c) continue;
        const ghost = (x2: number, y2: number, seg: Seg): void => {
          if (seg === 'none') return;
          svg.append(svgEl('line', {
            x1: X(px), y1: Y(py), x2, y2, stroke: segValueColor(seg), 'stroke-width': 9,
            opacity: 0.18, 'stroke-linecap': 'round', 'pointer-events': 'none',
          }));
        };
        if (hasN(px)) ghost(X(px + 1), Y(py), c.wallN);
        if (hasW(py)) ghost(X(px), Y(py + 1), c.wallW);
      }
    }
  }

  // FLOOR — only where a cell exists
  const floorKind: BoxKind | null = brush.mode === 'floor' ? 'floor' : brush.mode === 'copy' ? 'field' : null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = cells[base() + y * stride() + x]!;
      const ink = floorInk(f.floor);
      // `none` allowed dims the ground rather than taking a colour of its own — absence is not a
      // material, and giving it a channel would cost one of only three.
      const rect = svgEl('rect', {
        x: X(x) + 3, y: Y(y) + 3, width: U - 6, height: U - 6, rx: 3,
        fill: ink.certainlyVoid ? '#0d1016' : ink.fill,
        // strength = how few values are still open; void dims further on top of that
        opacity: ink.certainlyVoid ? 1 : ink.strength * (ink.maybeVoid ? 0.6 : 1),
        stroke: ink.conflict ? CONFLICT : '#12161c',
        'stroke-width': ink.conflict ? 2 : 1, cursor: 'pointer',
      });
      paintable(rect, x, y, floorKind, (gest) => {
        if (brush.mode === 'floor') applyAt(x, y, 'floor', gest.clear);
        else if (brush.mode === 'copy') {
          // Alt is the eyedropper — and so is a plain click while nothing is held, which is what makes
          // the brush usable before anyone has read that Alt is the eyedropper.
          if (gest.clear) applyField(x, y, true);
          else if (gest.alt || !clip) { if (gest.press) { pickField(x, y); pickedThisDrag = true; } }
          else if (!pickedThisDrag) applyField(x, y, false);
        } else if (brush.mode === 'stamp') stampBrush(x, y);
        else if (brush.mode === 'select') dragSelect(x, y, gest.press);
      });
      svg.append(rect);
      // the two PARALLEL diagonals, riding on top of the material colour
      for (const { id, opacity } of ink.hatches) {
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
        const ink = segInk(m);
        /* The hit target EXISTS ONLY WHILE THE WALL BRUSH IS UP. It is 20px wide and sits above the
           floor squares, so leaving it in place for every mode laid a dead stripe along every cell
           border: floor paint and selection drags that strayed near an edge hit this and did nothing,
           which read as the brush being unreliable rather than as something being in the way. */
        if (brush.mode === 'wall') {
          const hit = svgEl('line', {
            x1: X(px), y1: Y(py), x2, y2, stroke: 'transparent', 'stroke-width': 20, cursor: 'pointer',
          });
          paintable(hit, px, py, what, (gest) => applyAt(px, py, what, gest.clear));
          svg.append(hit);
        }
        if (ink.certainlyGone) return;             // nothing there, and it says so by being nothing
        // a dark CASING first, so a wall never merges into ground of the same channel
        svg.append(svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2, stroke: CASING, 'stroke-width': 15,
          'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
        // DASHED means `none` is in the domain: it might not be there. Same meaning as the dimmed
        // floor — absence is shown by the drawing being less solid, never by a colour.
        svg.append(svgEl('line', {
          x1: X(px), y1: Y(py), x2, y2,
          stroke: ink.conflict ? CONFLICT : ink.stroke,
          'stroke-width': 11,
          opacity: ink.strength,
          'stroke-dasharray': ink.maybeGone ? '9 6' : '',
          'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
      };
      if (hasN(px)) line(X(px + 1), Y(py), f.wallN, 'wallN');
      if (hasW(py)) line(X(px), Y(py + 1), f.wallW, 'wallW');
    }
  }

  // CORNERS
  /* The three point brushes all aim at the same target, so which one is up is the only question the
     hit circle has to answer — and when none of them is, it must not be there at all. */
  const pointBrush: Paintable | null =
    brush.mode === 'corner' ? 'corner'
      : brush.mode === 'wallType' ? 'wallType'
        : brush.mode === 'torch' ? 'torch'
          : brush.mode === 'open' ? 'open' : null;
  for (let py = 0; py <= H; py++) {
    for (let px = 0; px <= W; px++) {
      const f = cells[base() + py * stride() + px]!;
      /* OPENING RINGS, drawn tight around the corner and BEFORE it so the dot sits on top: six values
         will not fit three channels, so they ride as two rings of three — the corner's own boundary,
         rather than a separate mark competing for the same spot. A plain solid opening draws neither,
         which keeps a board of ordinary corners quiet. */
      if (!openingIsPlain(f.wallType)) {
        /* A GAP IN THE RING is the opening; a complete ring is closed; undecided is complete and faint.
           The circumference at r is 2*pi*r, so a dash pattern of [C - gap, gap] draws exactly one
           break of `gap` px wherever the ring is. */
        const os = openState(f.open);
        openingRings(f.wallType).forEach((col, i) => {
          if (!col) return;
          const r = 11 + i * 3.5;
          const circ = 2 * Math.PI * r;
          const GAP = 7;
          svg.append(svgEl('circle', {
            cx: X(px), cy: Y(py), r, fill: 'none', stroke: col,
            'stroke-width': 2.6,
            ...(os === 'open' ? { 'stroke-dasharray': `${(circ - GAP).toFixed(1)} ${GAP}` } : {}),
            opacity: os === 'undecided' ? 0.4 : 1,
            'pointer-events': 'none',
          }));
        });
      }
      /* A GENEROUS HIT TARGET, drawn first so it sits under the dot. The corner is the smallest thing
         on the board and carries four of the brushes (corner, opening, open, torch), so hitting it
         exactly was the fiddliest part of authoring. The target is much larger than the mark — you
         aim at the junction, not at the disc — which is exactly why it may not exist while a brush
         that aims at the SQUARE is up: r=16 at every point covers the corners of every cell. */
      if (pointBrush) {
        const hit = svgEl('circle', {
          cx: X(px), cy: Y(py), r: 16, fill: 'transparent', cursor: 'pointer',
        });
        paintable(hit, px, py, pointBrush, (gest) => applyAt(px, py, pointBrush, gest.clear));
        svg.append(hit);
      }

      const dot = svgEl('circle', {
        cx: X(px), cy: Y(py), r: domainSize(f.corner) === 1 ? 8 : 6,
        fill: f.corner === 0 ? CONFLICT : cornerInk(f.corner),
        opacity: f.corner === 0 ? 1 : cornerStrength(f.corner),
        stroke: '#12161c', 'stroke-width': 2, 'pointer-events': 'none',
      });
      svg.append(dot);

      // TORCH — a small flame-coloured pip beside the junction; hollow while it is still undecided
      const ts = torchState(f.torch);
      if (ts !== 'no') {
        svg.append(svgEl('circle', {
          cx: X(px) + 9, cy: Y(py) - 9, r: 4,
          fill: ts === 'yes' ? TORCH_MARK : 'none', stroke: TORCH_MARK,
          'stroke-width': 2, 'pointer-events': 'none',
        }));
      }
    }
  }

  if (box?.moved) {
    const r = boxRect(box);
    svg.append(svgEl('rect', {
      ...r, rx: 3, 'pointer-events': 'none', 'stroke-width': 2, 'stroke-dasharray': '5 4',
      fill: box.clear ? '#ff2d5514' : '#e0a83020', stroke: box.clear ? CONFLICT : '#e0a830',
    }));
  }

  drawEdgeHandles(svg);
  buildReadout(res);
  buildBrushBar();
  schedule3d();
}

/**
 * Where the rubber band is DRAWN. It has to be honest about which targets the fill will land on, and
 * those are not all the same shape: a floor box covers squares, a corner box covers the points
 * themselves, and a wall box is a span one way and a thin band the other.
 */
function boxRect(b: Box): Record<string, number> {
  const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
  const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
  const squareX = { x: X(x0) + 3, width: (x1 - x0 + 1) * U - 6 };
  const squareY = { y: Y(y0) + 3, height: (y1 - y0 + 1) * U - 6 };
  const pointX = { x: X(x0) - 15, width: (x1 - x0) * U + 30 };
  const pointY = { y: Y(y0) - 15, height: (y1 - y0) * U + 30 };
  const spanX = { x: X(x0), width: (x1 - x0 + 1) * U };
  const spanY = { y: Y(y0), height: (y1 - y0 + 1) * U };
  if (b.kind === 'floor' || b.kind === 'field') return { ...squareX, ...squareY };
  if (b.kind === 'wallN') return { ...spanX, ...pointY };   // edges running east from a row of points
  if (b.kind === 'wallW') return { ...pointX, ...spanY };   // edges running south from a column
  return { ...pointX, ...pointY };                          // corner, opening, open, torch
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

/**
 * `press` is load-bearing. This used to re-anchor on `!dragging`, but `paintable` sets `dragging`
 * BEFORE it calls in — so once a selection existed, every new press extended the old rectangle from
 * its old corner instead of starting a fresh one, and the box could only ever grow.
 */
function dragSelect(x: number, y: number, press: boolean): void {
  if (press || !selection) selection = { x0: x, y0: y, x1: x, y1: y };
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
      return { vals: [...brush.seg], color: segInk(m).stroke, hatches: [] };
    }
    if (brush.mode === 'floor') {
      const m = brush.floor.size ? floors(...brush.floor) : 0;
      const ink = floorInk(m);
      return { vals: [...brush.floor], color: ink.certainlyVoid ? '#0d1016' : ink.fill, hatches: ink.hatches };
    }
    if (brush.mode === 'corner') {
      const m = brush.corner.size ? corners(...brush.corner) : 0;
      return { vals: [...brush.corner], color: cornerInk(m), hatches: [] };
    }
    if (brush.mode === 'wallType') {
      const m = brush.wallType.size ? wallTypes(...brush.wallType) : 0;
      return { vals: [...brush.wallType], color: openingRings(m).find(Boolean) ?? '#3b6ea5', hatches: [] };
    }
    if (brush.mode === 'copy' && clip) {
      // the held cell wears its own floor colour, so the strip says WHICH cell rather than "a cell"
      const ink = floorInk(clip.floor);
      return { vals: [], color: ink.certainlyVoid ? '#0d1016' : ink.fill, hatches: ink.hatches };
    }
    return { vals: [], color: '#3b6ea5', hatches: [] };
  };

  const { vals, color, hatches } = chosen();
  const sw = swatch(color, hatches[0]?.id, 18);
  bar.append(h('span', { class: 'bb-label' }, 'painting'));
  bar.append(sw);
  bar.append(h('span', { class: 'bb-mode' }, brush.mode === 'stamp' ? (activeBrush ?? 'stamp') : brush.mode));
  bar.append(h('span', { class: 'bb-vals' },
    brush.mode === 'copy'
      ? (clipFrom ? `the whole cell from (${clipFrom.x},${clipFrom.y})` : 'click a square to pick one up')
      : vals.length === 0 ? (brush.mode === 'select' || brush.mode === 'stamp' ? '' : 'nothing selected')
        : vals.length === 1 ? vals[0]!
          : `${vals.join(' + ')}  — a SET, left undecided`));
  bar.append(h('span', { class: 'bb-hint' }, 'right-click = abstain · right-DRAG = fill a box'));

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
      if (r.note) row.append(h('span', { class: 'lg-note' }, r.note));
      rows.append(row);
    }
    box.append(rows);
    if (group.note) box.append(h('div', { class: 'hint lg-groupnote' }, group.note));
  }
  // the whole idea, in one line
  box.append(h('div', { class: 'hint' },
    'CHANNELS ADD. Each value owns red, green or blue, and a field lights the channels of everything '
    + 'it allows — so yellow means the first two, white means all three, and you can read a mixture '
    + 'back to its members. The number in a square is how many values are still open.'));
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
  const stairs = stairReport();
  const warn = conflicts > 0 || (walkable === 0 && groundFloor) || connected < walkable
    || stairs.some((l) => l.startsWith('⚠'));
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
    ...stairs,
  ].filter(Boolean).join('\n');
  box.style.color = warn ? '#e0a04a' : '#7fc8a0';
}

/**
 * WHAT THE STAIRS ON THIS STOREY ACTUALLY ARE.
 *
 * A stair block that is not a valid flight fails SILENTLY — the cells just draw as ordinary ground,
 * and nothing tells you the staircase you painted is not a staircase. This says so, and says why.
 *
 * It also checks the thing multi-storey structures exist FOR: that the deck above a flight is open,
 * and that no wall stands where you arrive. "Guarantee" is too strong for an editor — it warns rather
 * than refuses — but an unchecked guarantee is just a hope.
 */
function stairReport(): string[] {
  const here = resolvedLevel(L);
  const above = L + 1 < LEVELS ? resolvedLevel(L + 1) : null;
  const out: string[] = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = here[y * stride() + x];
      if (!c || !isStairFloor(c.floor)) continue;

      const flight = stairFlight(here, stride(), H + 1, x, y);
      if (!flight) {
        const fault = stairFault(here, stride(), H + 1, x, y);
        if (fault) out.push(`⚠ stairs at (${x},${y}): ${stairFaultText(fault)}`);
        continue;
      }
      const mesh = flight.url.split('/').pop()!.replace('.gltf.glb', '');
      out.push(`stairs at (${x},${y}): ${flight.bw}×${flight.bh}, climbs ${flight.up} — ${mesh}`);

      if (!above) continue;
      // THE CEILING over the whole footprint, and the arrival cell just beyond the top
      let sealed = 0;
      for (let j = 0; j < flight.bh; j++) {
        for (let i = 0; i < flight.bw; i++) {
          const up = above[(flight.y + j) * stride() + (flight.x + i)];
          if (up && up.floor !== 'none') sealed++;
        }
      }
      if (sealed) out.push(`⚠   its ceiling is closed (${sealed} cell(s) of floor on storey ${L + 1})`);

      // the cell you step onto: one past the TOP end, on the storey above
      const ax = flight.x + (flight.up === 'E' ? flight.bw : flight.up === 'W' ? -1 : 0);
      const ay = flight.y + (flight.up === 'S' ? flight.bh : flight.up === 'N' ? -1 : 0);
      const arrive = ax >= 0 && ay >= 0 && ax < W && ay < H ? above[ay * stride() + ax] : undefined;
      if (arrive && arrive.floor === 'none') {
        out.push(`⚠   nothing to step onto at the top — (${ax},${ay}) on storey ${L + 1} has no floor`);
      }
    }
  }
  return out;
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

function listBox(store: Record<string, Stored>, onPick: (n: string) => void, onDel: (n: string) => void,
                 cur: string | null = null): HTMLElement {
  const names = Object.keys(store).sort();
  if (!names.length) return h('div', { class: 'hint', style: 'margin-top:0' }, 'none yet');
  const box = h('div', {});
  for (const n of names) {
    const s = store[n]!;
    box.append(h('div', { class: `item${n === cur ? ' cur' : ''}` },
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
    ['open', 'Open'], ['torch', 'Torch'], ['copy', 'Copy'], ['select', 'Select'], ['stamp', 'Stamp'],
  ];
  p.append(h('div', { class: 'row' }, ...modes.map(([m, label]) =>
    h('div', { class: `chip${brush.mode === m ? ' on' : ''}`, onclick: () => { brush.mode = m; buildPanel(); } }, label))));

  if (brush.mode === 'wall') { p.append(h('h2', {}, 'wall — a SET')); p.append(chipRow(SEGS, brush.seg, SEG_SWATCH)); }
  else if (brush.mode === 'floor') { p.append(h('h2', {}, 'floor — a SET')); p.append(chipRow(FLOOR_MATERIALS, brush.floor, FLOOR_SWATCH)); }
  else if (brush.mode === 'corner') { p.append(h('h2', {}, 'corner — a SET')); p.append(chipRow(CORNERS, brush.corner, CORNER_SWATCH)); }
  else if (brush.mode === 'open') {
    p.append(h('h2', {}, 'open — a SET'));
    p.append(chipRow(OPENS, brush.open, OPEN_SWATCH));
    p.append(h('div', { class: 'hint' },
      'Whether the module at this point has a HOLE in it, separately from what it is. A doorway is a '
      + 'leaf when closed and an arch when open; a window is infilled or not. Open is not the same as '
      + 'passable — an open window is a hole at chest height — so only doorway, arch and scaffold let '
      + 'a body through, and only when open.'));
  }
  else if (brush.mode === 'torch') {
    p.append(h('h2', {}, 'torch — a SET'));
    p.append(chipRow(TORCHES, brush.torch, TORCH_SWATCH));
    p.append(h('div', { class: 'hint' },
      'A torch hangs on whatever stands at the point — a pillar, or a wall meeting there — and faces '
      + 'a direction that is not a wall and not solid rock. Which way is READ from the walls, never stored.'));
  }
  else if (brush.mode === 'wallType') {
    p.append(h('h2', {}, 'opening — a SET'));
    p.append(chipRow(WALL_TYPES, brush.wallType, WALLTYPE_SWATCH));
    p.append(h('div', { class: 'hint' }, 'door / arch need an `air` corner to be walkable; the rest stay solid.'));
  } else if (brush.mode === 'copy') {
    p.append(h('h2', {}, clip ? 'copy — holding a cell' : 'copy — nothing held'));
    if (clip && clipFrom) {
      p.append(h('div', { class: 'row' },
        h('button', { onclick: () => { clip = null; clipFrom = null; buildPanel(); } }, 'drop it')));
    }
    p.append(h('div', { class: 'hint' }, clip && clipFrom
      ? `Holding the cell from (${clipFrom.x},${clipFrom.y})`
        + `${clipFrom.level === L ? '' : ` on storey ${clipFrom.level}`}. `
        + 'Click or drag to paste it · right-drag to fill a box · Alt+click to pick up a different '
        + 'one · right-click hands a cell back to the generator, Shift+right-drag a whole box of them.'
      : 'Click a square to pick it up — ALL of it: the floor, the two walls that start at its corner, '
        + 'the corner itself, the opening, whether that opening is open, and the torch. Then click or '
        + 'drag to paste it anywhere else, or right-drag a box to fill a region with it.'));
  } else if (brush.mode === 'select') {
    p.append(h('h2', {}, 'selection'));
    p.append(h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => void saveBrush() }, '＋ Save as brush'),
      h('button', { onclick: () => { selection = null; render(); } }, 'clear')));
    p.append(h('div', { class: 'hint' },
      'Drag over the floor squares to mark a region. Each new press starts a fresh rectangle.'));
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
  const cur = loadedName;   // captured, so the handlers below close over a name and not a mutable slot
  p.append(listBox(structures, load, (n) => void del('cell-structures', n, 'structure'), cur));
  p.append(h('div', { class: 'row', style: 'margin-top:6px' },
    // The loop is paint → look → save → look again, so the common save is back onto the piece you
    // opened. Naming the target ON the button is the confirmation — no dialog to click through.
    ...(cur
      ? [h('button', {
          class: 'primary', title: `Ctrl+S — overwrite “${cur}” in place`,
          onclick: () => void saveStructure(cur),
        }, `↑ Save “${cur}”`),
        h('button', { title: 'Save under a different name', onclick: () => void saveStructure() }, 'Save as…')]
      : [h('button', { class: 'primary', onclick: () => void saveStructure() }, '↑ Save structure')])));
  if (cur) p.append(h('div', { class: 'hint', style: 'margin-top:6px' },
    `Editing “${cur}” — Save overwrites it; Save as… leaves it alone and stores a copy.`));

  p.append(h('div', { id: 'ready' }));
  p.append(h('div', { id: 'status' }, lastStatus));
  render();
}

/* ------------------------------- persistence -------------------------------- */

let lastStatus = '';
const status = (m: string): void => {
  lastStatus = m;
  const s = document.getElementById('status');
  if (s) s.textContent = m;
};

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
  loadedName = name;
  buildPanel(); frameCamera();
  status(`loaded “${name}”${LEVELS > 1 ? ` · ${LEVELS} storeys` : ''}`);
}

/**
 * `over` is the name to overwrite outright — the grid came from it, so no dialog and no retyping.
 * Called with nothing this asks for a name, defaulting to the loaded one so Save as… starts from
 * where you are rather than from `new structure`.
 */
async function saveStructure(over?: string): Promise<void> {
  const name = over ?? (await ask({
    title: 'Save structure', input: loadedName ?? 'new structure', ok: 'Save',
    body: `${W}×${H} floor cells${LEVELS > 1 ? ` × ${LEVELS} storeys` : ''}. The generator places these — an existing `
      + `structure of the same name is overwritten.`
      + (LEVELS > 1 ? ' NOTE: the generator builds one floor at a time and will not place a multi-storey structure yet.' : ''),
  }));
  if (!name) return;
  // the padding rule is applied on the way OUT, so the store never carries phantom geometry
  if (await post('cell-structures', name, {
    structure: { w: W, h: H, ...(LEVELS > 1 ? { levels: LEVELS } : {}), cells: forStore() },
  })) {
    loadedName = name;   // saving under a new name is also a statement about what you are editing now
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
  if (await post(kind, name, { remove: true })) {
    if (kind === 'cell-structures' && name === loadedName) loadedName = null;
    await refresh();
    status(`deleted “${name}”`);
  }
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
  loadedName = null;
  buildPanel();
}

/* ---------------------------------- draft ----------------------------------- */
// A reload used to cost whatever was on the grid: a stray Ctrl+R, an HMR update, a closed tab. The
// lattice is nothing but integer masks, so the whole of it is mirrored into localStorage on a short
// delay and read back at boot.
//
// This is a DRAFT, not a save. The store under `/__lab/cell-structures` is still the only thing the
// generator ever reads, and `loadedName` rides along so the Save button still names its target.

const DRAFT_KEY = 'ascent:cell-editor:draft';
let draftTimer: number | undefined;

interface Draft { w: number; h: number; levels: number; level: number; name: string | null; cells: CellField[] }

/** Debounced: painting fires per cell, and JSON of a big lattice is not free. */
function saveDraft(): void {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const d: Draft = { w: W, h: H, levels: LEVELS, level: L, name: loadedName, cells };
    // A grid past the storage quota simply goes un-drafted. Losing the draft is a nuisance; throwing
    // in the middle of a brush stroke is not acceptable.
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* over quota — skip */ }
  }, 400);
}

/** True when a draft was found AND fit the lattice it claims. A malformed one is dropped, not fixed. */
function restoreDraft(): boolean {
  let d: Draft;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    d = JSON.parse(raw) as Draft;
  } catch { return false; }
  const ok = d && d.w > 0 && d.h > 0 && d.levels > 0 && Array.isArray(d.cells)
    && d.cells.length === (d.w + 1) * (d.h + 1) * d.levels;
  if (!ok) { localStorage.removeItem(DRAFT_KEY); return false; }
  W = d.w; H = d.h; LEVELS = d.levels;
  L = Math.min(Math.max(0, d.level | 0), LEVELS - 1);
  cells = d.cells.map((f) => ({ ...f }));
  loadedName = typeof d.name === 'string' ? d.name : null;
  return true;
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
window.addEventListener('mouseup', () => {
  if (box) {
    // moved = a box; never moved = the right-click abstain it was armed over
    if (box.moved) applyBox(box); else box.anchor();
    box = null;
    render();
  }
  dragging = false;
  pickedThisDrag = false;
});
// Ctrl/Cmd+S saves back to the loaded structure, or opens the name dialog when the grid came from
// nowhere. The browser's own Save-page dialog is never what anyone wants on this screen.
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 's' || !(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  ev.preventDefault();
  if (el('veil').classList.contains('on')) return;   // a dialog is already up — let it finish
  void saveStructure(loadedName ?? undefined);
});
el('hint').textContent =
  'drag to paint · right-click ABSTAINS (restores the full domain) · right-DRAG boxes a region and '
  + 'fills it with the brush, Shift+right-drag clears it · dashed = undecided · '
  + 'the −/+ handles grow, shrink and slide the grid · the last column has no east-running edge and '
  + 'the last row no south-running one, so those are not drawn — but the SOUTH and EAST borders are, '
  + 'and they are what the padding exists for.';
cells = blankGrid();
const restored = restoreDraft();
if (restored) status(`restored your last grid${loadedName ? ` — “${loadedName}”` : ''}`);
init3d();
initSplit();
buildPanel();   // draw immediately; the store fetch only fills the two lists
void refresh();
wirePan();
