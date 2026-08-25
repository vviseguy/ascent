// ============================================================================
// src/lab/cell-snap.ts — headless-renderable view of the 2u cell pipeline.
// ============================================================================
//
// A VISUAL GATE for `cell-place.ts`. The unit tests prove which mesh is chosen and where it is put in
// fixed-point; they cannot tell you it looks right. This page renders the same placements to a canvas
// that `scripts/cell-snap.mjs` can screenshot, so "the staircase lands on its block" is something we
// LOOK AT rather than infer.
//
// Deliberately inert: no controls, no timers, no interaction. The camera is set from the URL and the
// page renders exactly once, so two snapshots of the same query are byte-comparable.
//
//   ?demo=<kind>               a synthetic subject, for checking a mesh choice in isolation
//   ?structure=<name>          one authored structure, on its own
//   ?floor=<w>x<h>&seed=<n>    a generated floor
//   &levels=<n>&level=<i>      ...from a real TOWER stack, so MULTI-STOREY structures can appear
//   &level=<n>                 ONE storey of a multi-level structure (default: all, stacked)
//   &turn=0..3 &flip=1         orient the structure first — the placement must survive all eight
//   &angle=<deg> &pitch=<deg>  camera around / above
//   &zoom=<f>                  distance multiplier
//   &stack=<n>&rise=<h>        n storeys h apart (default FLOOR_HEIGHT) — does a flight REACH the next?
//   &arrows=1                  draw the DECIDED climb direction over each flight, plus a compass
//
// `window.__CELL_READY` flips true when the last GLB has landed and a frame has been drawn.

import * as THREE from 'three';
import { buildCompiled, buildGrid, countMissing, loadFailures, CELL } from './cell-preview.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { previewCell } from '../floor/cell-field.ts';
import { getStructure, levelsOf, listStructures } from '../floor/cell-structures.ts';
import { stairFlight } from '../floor/cell-place.ts';
import { isStairFloor } from '../floor/cell.ts';
import { orientStructure } from '../floor/cell-orient.ts';
import { generateEmergent, generateEmergentTower } from '../floor/cell-emergent.ts';
import { resolveFloor } from '../floor/cell-defray.ts';
import { FLOOR_HEIGHT } from '../game/tower.ts';
import { toFloat } from '../sim/fixed/fixed.ts';
import { WALL_TYPES, type Cell } from '../floor/cell.ts';

declare global {
  interface Window {
    __CELL_READY?: boolean; __CELL_ERROR?: string; __CELL_WARN?: string;
    __CELL_INFO?: string; __CELL_NAMES?: string[];
  }
}

// published so the snapshot driver can enumerate subjects without re-parsing the store itself
window.__CELL_NAMES = listStructures();

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => { const v = Number(q.get(k)); return Number.isFinite(v) ? v : d; };

interface Subject {
  cells: (Cell | null)[]; w: number; h: number; extent: { w: number; h: number }; label: string;
  /** The storey directly above the BOTTOM one, for deciding stair directions — see `subject`. It is
   *  supplied even when only one storey is drawn, because the decision does not depend on the view. */
  decideAbove?: readonly (Cell | null)[];
  /** Extra storeys to draw above this one, bottom-up. A multi-level structure IS a building. */
  above?: (Cell | null)[][];
  /** Captions pinned to grid coordinates. A board that puts sixteen cases side by side is unreadable
   *  without them — "which one is the module end?" is not a question a picture should leave open. */
  notes?: { x: number; y: number; text: string }[];
}

/**
 * EVERY PLACE A WALL CAN STOP, side by side on one board.
 *
 * `wallEnds` is the authority on where a wall needs finishing, and the rule it encodes has a lot of
 * cases: which piece owns the last edge, whether anything already stands on the point, whether the end
 * is at the lattice border, whether the family has a finished piece at all. Sixteen of them fit on one
 * board, which is the only way a human can check them all in one look — and looking is the point,
 * because "does this read as a finished wall" is not a question a unit test can answer.
 *
 * Each case sits in its own 6x5 patch with at least two clear cells around it, so no two cases can
 * share a lattice point and quietly become one figure.
 *
 *   npm run cell:snap -- demo caps --angle=90 --pitch=55 --zoom=1.05
 */
function capsBoard(): Subject {
  const COLS = 4, PITCH_X = 6, PITCH_Y = 5;
  const W = 26, H = 22;
  const cells: (Cell | null)[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      cells.push({ floor: 'stone', ceiling: 'none', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no' });
    }
  }
  const at = (x: number, y: number): Cell => cells[y * W + x] as Cell;
  const notes: { x: number; y: number; text: string }[] = [];

  /** Cases in reading order; each is painted at the origin of its own patch. */
  const CASES: { text: string; paint: (x0: number, y0: number) => void }[] = [
    { text: 'lone edge', paint: (x, y) => { at(x, y).wallN = 'wall'; } },
    { text: 'run of 2', paint: (x, y) => { for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall'; } },
    { text: 'run of 3', paint: (x, y) => { for (let i = 0; i < 3; i++) at(x + i, y).wallN = 'wall'; } },
    { text: 'run of 4', paint: (x, y) => { for (let i = 0; i < 4; i++) at(x + i, y).wallN = 'wall'; } },

    { text: 'loose ONE end (bends east)', paint: (x, y) => {
      for (let i = 0; i < 3; i++) at(x + i, y).wallN = 'wall';
      for (let j = 0; j < 2; j++) at(x + 3, y + j).wallW = 'wall';
    } },
    { text: 'ends at a COLUMN', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      at(x + 2, y).corner = 'column';
    } },
    { text: 'ends at a T', paint: (x, y) => {
      for (let i = 0; i < 4; i++) at(x + i, y).wallN = 'wall';
      for (let j = 0; j < 2; j++) at(x + 2, y + j).wallW = 'wall';
    } },
    { text: 'bare L — two ends, no mitre', paint: (x, y) => { at(x, y).wallN = 'wall'; at(x, y).wallW = 'wall'; } },

    { text: 'L with 2-edge legs — MITRED', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      for (let j = 0; j < 2; j++) at(x, y + j).wallW = 'wall';
    } },
    { text: 'run THROUGH a doorway', paint: (x, y) => {
      for (let i = 0; i < 4; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 2, y); c.wallType = 'doorway'; c.open = 'open';
    } },
    /* THE SAME RUN, SHUT. Two pieces now — the frame plus its leaf — where it used to be one welded
       mesh, and it sits beside the open case so the difference is a thing you can see rather than a
       claim in a commit message. It is also the state that collided as a 2.00-wide hole. */
    { text: 'doorway SHUT — frame + leaf', paint: (x, y) => {
      for (let i = 0; i < 4; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 2, y); c.wallType = 'doorway'; c.open = 'closed';
    } },
    { text: 'GATE shut, then raised', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 1, y); c.wallType = 'gate'; c.open = 'closed';
      for (let i = 0; i < 2; i++) at(x + i, y + 2).wallN = 'wall';
      const o = at(x + 1, y + 2); o.wallType = 'gate'; o.open = 'open';
    } },
    { text: 'DOORWAY alone — module nubs', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 1, y); c.wallType = 'doorway'; c.open = 'open';
    } },
    { text: 'WINDOW alone — module nubs', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 1, y); c.wallType = 'window'; c.open = 'open';
    } },

    { text: 'ARCH alone — module nubs', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      const c = at(x + 1, y); c.wallType = 'arch'; c.open = 'open';
    } },
    { text: 'BARRIER — no cap in the kit', paint: (x, y) => { for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'barrier'; } },
    { text: 'ends at a BALCONY post', paint: (x, y) => {
      for (let i = 0; i < 2; i++) at(x + i, y).wallN = 'wall';
      at(x + 2, y).corner = 'balcony';
    } },
    /* Its east end is the LAST lattice point, so the edge beyond it does not exist. A bare board has
       no border wall to meet there, so that end is loose like any other — which is worth seeing,
       because it is the one case where "the wall stops" and "the world stops" are the same event. */
    { text: 'runs off the MAP EDGE', paint: (_x, y) => { for (let i = W - 4; i < W; i++) at(i, y).wallN = 'wall'; } },
  ];

  for (const [i, c] of CASES.entries()) {
    const x0 = (i % COLS) * PITCH_X + 1, y0 = Math.floor(i / COLS) * PITCH_Y + 1;
    c.paint(x0, y0);
    /* Just NORTH of the patch: a sprite always faces the camera, so a caption over its own case hides
       the thing it names as soon as the pitch drops, and one to the SOUTH reads as the title of the
       row below it. North of it is a heading. */
    notes.push({ x: x0 + 1.5, y: y0 - 1.1, text: c.text });
  }
  return { cells, w: W, h: H, extent: { w: W, h: H }, notes, label: 'demo: caps — every place a wall can stop' };
}

/** Synthetic subjects. For checking a placement rule that no authored structure happens to exercise —
 *  a bare flight with open flanks, say, when every structure in the store has walled ones. */
function demo(kind: string): Subject {
  if (kind === 'caps') return capsBoard();
  const W = kind === 'walltypes' ? WALL_TYPES.length * 2 + 3 : 7, H = 7;
  const cells: (Cell | null)[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c: Cell = { floor: 'stone', ceiling: 'none', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', open: 'closed', torch: 'no' };
      const inBlock = x >= 2 && x <= 3 && y >= 2 && y <= 3;
      if (inBlock) c.floor = kind === 'stairs-wood' ? 'stairs_wood' : 'stairs';
      if (y === 2 && x >= 2 && x <= 3) c.wallN = 'wall';             // north end closed: climbs north
      if (kind === 'stairs-walled' && (y === 2 || y === 3) && (x === 2 || x === 4)) c.wallW = 'wall';
      // climbing north, WEST is on your left and EAST on your right
      if (kind === 'stairs-left' && (y === 2 || y === 3) && x === 2) c.wallW = 'wall';
      if (kind === 'stairs-right' && (y === 2 || y === 3) && x === 4) c.wallW = 'wall';

      /* CORNERS AND TORCHES. A row of wall with, left to right: a bare end (capped), a full pillar,
         a balcony post, and a torch on each — so the four pieces sit side by side at the same scale. */
      if (kind === 'corners') {
        c.floor = 'stone';
        /* Four cases side by side, each on its own so nothing is buried inside a wall run:
             row 1, x1-x2   a wall ending FREE          -> capped
             row 3, x1-x2   a wall ending at a COLUMN   -> no cap, the pillar is the end
             row 5, x1      a BALCONY post on its own   -> the short rail-height post
             row 3, x1      a TORCH on the wall                                            */
        if (y === 1 && (x === 1 || x === 2)) c.wallN = 'wall';
        if (y === 3 && (x === 1 || x === 2)) c.wallN = 'wall';
        if (y === 3 && x === 3) c.corner = 'column';     // the east end of the lower run
        if (y === 3 && x === 1) c.torch = 'yes';
        if (y === 5 && x === 1) { c.corner = 'balcony'; c.torch = 'yes'; }
      }
      /* EVERY WALL TYPE in a row, each in its own stretch of wall, so the whole catalogue can be
         compared at one glance and a mesh that does not look like its name is obvious. */
      if (kind === 'walltypes') {
        c.floor = 'stone';
        const slot = Math.floor((x - 1) / 2);
        if (y === 3 && x >= 1 && x < 1 + WALL_TYPES.length * 2) {
          c.wallN = 'wall';
          if ((x - 1) % 2 === 1 && slot < WALL_TYPES.length) c.wallType = WALL_TYPES[slot]!;
        }
      }
      if (kind === 'torch-facing') {
        c.floor = 'stone';
        // a cross of walls with a pillar in the middle: the torch has to pick an open direction
        if (y === 3 && (x === 1 || x === 2)) c.wallN = 'wall';
        if (x === 3 && (y === 1 || y === 2)) c.wallW = 'wall';
        if (x === 3 && y === 3) { c.corner = 'column'; c.torch = 'yes'; }
      }
      cells.push(c);
    }
  }
  if (kind === 'stairs-wood') {                                       // a wooden flight needs 3 cells
    for (const x of [2, 3]) { const c = cells[4 * W + x]!; c.floor = 'stairs_wood'; }
  }
  return { cells, w: W, h: H, extent: { w: W, h: H }, label: `demo: ${kind}` };
}

function subject(): Subject {
  const kind = q.get('demo');
  if (kind) return demo(kind);
  const floor = q.get('floor');
  if (floor) {
    const m = /^(\d+)x(\d+)$/.exec(floor);
    if (!m) throw new Error(`bad floor size: ${floor}`);
    const w = Number(m[1]), h = Number(m[2]);
    const seed = BigInt(num('seed', 1));
    /* A SINGLE floor cannot show a multi-storey structure — the throne room is three levels, and only
       `generateEmergentTower` places across the stack. Ask for `levels` to see what really generates. */
    const levels = Math.max(1, Math.floor(num('levels', 1)));
    if (levels > 1) {
      const t = generateEmergentTower({ width: w, height: h, seed, levels });
      const i = Math.max(0, Math.min(levels - 1, Math.floor(num('level', 0))));
      const f = t.floors[i]!;
      return {
        cells: resolveFloor(f), w, h, extent: { w, h },
        label: `tower ${w}x${h} seed ${num('seed', 1)} — storey ${i + 1}/${levels}, `
          + `${f.placed.length} structures (${f.placed.map((p) => p.name).join(', ') || 'none'})`,
      };
    }
    const r = generateEmergent({ width: w, height: h, seed });
    return {
      cells: resolveFloor(r), w, h, extent: { w, h },
      label: `floor ${w}x${h} seed ${num('seed', 1)} — ${r.stats.structuresPlaced} structures`,
    };
  }

  const name = q.get('structure') ?? listStructures()[0]!;
  const base = getStructure(name);
  if (!base) throw new Error(`no such structure: ${name} (have: ${listStructures().join(', ')})`);
  const turn = num('turn', 0) as 0 | 1 | 2 | 3;
  const flip = q.get('flip') === '1';
  const st = turn === 0 && !flip ? base : orientStructure(base, { turn, flip });

  /* ONE LATTICE PER STOREY, and slicing them apart is not optional. `cells` is
     `levels * (w+1) * (h+1)` long, so handing the whole array over with `w+1` and `h+1` reads only
     the first storey and silently drops the rest — a three-storey throne room drew as its ground
     floor with nothing to say so. */
  const lw = st.w + 1, lh = st.h + 1, size = lw * lh;
  const levels = levelsOf(st);
  const slice = (i: number): (Cell | null)[] =>
    st.cells.slice(i * size, (i + 1) * size).map((f) => previewCell(f));

  const only = q.get('level');
  const pick = only === null ? null : Math.max(0, Math.min(levels - 1, Math.floor(Number(only))));
  const shown = pick === null ? levels : 1;
  const bottom = pick ?? 0;

  return {
    // the stored grid is the POINT LATTICE, so it is one wider and one taller than the floor extent
    cells: slice(bottom), w: lw, h: lh, extent: { w: st.w, h: st.h },
    ...(shown > 1 ? { above: Array.from({ length: levels - 1 }, (_, i) => slice(i + 1)) } : {}),
    /* WHAT IS KNOWN, not what is DRAWN — and they are different things.
       A stair flight's direction is decided partly by the storey above it, so a picture of ONE storey
       must still be told what sits over it or it draws a different staircase than the tower builds.
       This was silently wrong in both directions: `--level=n` dropped `above` entirely, and even a
       full multi-storey render never passed it into `gridPlacements` at all — every upper storey was
       built as an independent grid that knew nothing about the one over IT. So the visual gate on
       `cell-place.ts` has been showing flights decided without a ceiling, which is exactly the class of
       thing a screenshot is supposed to catch. */
    ...(bottom + 1 < levels ? { decideAbove: slice(bottom + 1) } : {}),
    label: `${name}  ${st.w}x${st.h}`
      + (levels > 1 ? (pick === null ? `  ${levels} storeys` : `  storey ${pick + 1}/${levels}`) : '')
      + (turn || flip ? `  turn ${turn}${flip ? ' flipped' : ''}` : ''),
  };
}

/**
 * THE ASSET BOARD — every stair mesh, UNROTATED, next to an arrow saying which way the code believes
 * it climbs when unturned.
 *
 * `STAIR_TURN` rests on one sentence: "stairs rise toward -Z natively, so N is the unturned case."
 * Every flight in the game is placed by rotating that assumption, and the assumption itself had never
 * been looked at — only reasoned about, and the reasoning is circular if the premise is what is wrong.
 * Vertex statistics do not settle it either: the walled variants are a handful of large boxes whose
 * side walls span the whole run, so "which end is tall" reads the wall, not the treads.
 *
 * So: draw them, at turn 0, with the compass. If a mesh's treads climb away from its arrow, that mesh
 * disagrees with the constant and the constant is wrong FOR THAT MESH — which the single shared turn
 * table cannot express.
 */
/** Renderer + camera + one frame, for a subject that is not a grid. Mirrors the grid path in `main`;
 *  kept separate rather than shared, because that one also frames on the union of its meshes. */
function finishBoard(scene: THREE.Scene, host: HTMLElement, centre: THREE.Vector3, radius: number): void {
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const wpx = Math.floor(host.clientWidth) || 900, hpx = Math.floor(host.clientHeight) || 620;
  r.setSize(wpx, hpx);
  host.append(r.domElement);
  const camera = new THREE.PerspectiveCamera(45, wpx / hpx, 0.1, 500);
  const dist = (radius / Math.tan((45 * Math.PI) / 360)) / num('zoom', 1.15);
  const a = (num('angle', 35) * Math.PI) / 180, pitch = (num('pitch', 38) * Math.PI) / 180;
  camera.position.set(
    centre.x + Math.cos(a) * Math.cos(pitch) * dist,
    centre.y + Math.sin(pitch) * dist,
    centre.z + Math.sin(a) * Math.cos(pitch) * dist,
  );
  camera.lookAt(centre);
  r.render(scene, camera);
  const bad = loadFailures();
  if (bad.length) window.__CELL_WARN = `${bad.length} load failure(s): ` + bad.map((b) => b.url).join(', ');
  window.__CELL_READY = true;
}

async function assetBoard(scene: THREE.Scene): Promise<{ label: string; radius: number; centre: THREE.Vector3 }> {
  const ALL = ['stairs', 'stairs_wall_left', 'stairs_wall_right', 'stairs_walled', 'stairs_wide', 'stairs_narrow'];
  const want = q.get('only');
  const picked = want ? want.split(',').map((n) => n.trim()).filter((n) => ALL.includes(n)) : ALL;
  /* `spin=<name>` repeats ONE mesh at all four quarter-turns beside the others, which is how you find
     the yaw that makes an odd asset line up with the rest instead of guessing at it. */
  const spun = q.get('spin');
  const names: string[] = spun ? [...picked, ...[0, 1, 2, 3].map((t) => `${spun}@${t}`)] : picked;
  const loader = new GLTFLoader();
  const PITCH = 9;
  const startX = -((names.length - 1) * PITCH) / 2;

  for (const [i, n] of names.entries()) {
    const x = startX + i * PITCH;
    const [file, spinTurn] = n.split('@');
    let obj: THREE.Object3D;
    try {
      obj = (await loader.loadAsync(`models/kaykit_dungeon_remastered/${file}.gltf.glb`)).scene;
    } catch {
      continue;
    }
    obj.position.set(x, 0, 0);
    // TURN 0 unless this is a `spin` copy — the same table the placer uses: [0, +90, 180, -90]
    obj.rotation.y = spinTurn === undefined ? 0 : [0, Math.PI / 2, Math.PI, -Math.PI / 2][+spinTurn]!;
    scene.add(obj);

    /* The arrow the code would draw: unturned means it believes this climbs NORTH, which is -Z. */
    scene.add(new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(x, 6.2, 3.0), 6.0, 0x2ee06a, 1.6, 1.1));
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
    foot.position.set(x, 6.2, 3.6);            // the end the code thinks you walk in at
    scene.add(foot);

    // a per-asset name plate
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const g2 = c.getContext('2d')!;
    g2.fillStyle = 'rgba(10,12,15,0.9)'; g2.fillRect(0, 0, 512, 96);
    g2.font = 'bold 40px system-ui, sans-serif'; g2.fillStyle = '#e8eef6';
    g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText(n, 256, 52);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    sp.position.set(x, -1.2, 5.2); sp.scale.set(8, 1.5, 1); sp.renderOrder = 999;
    scene.add(sp);
  }

  const span = names.length * PITCH;
  const grid = new THREE.GridHelper(span, names.length * 4, 0x3b6ea5, 0x2f3742);
  grid.position.y = -0.02;
  scene.add(grid);
  return {
    label: 'STAIR ASSETS AT TURN 0 — the arrow is where the code believes each climbs (NORTH, -Z)',
    radius: span * 0.55, centre: new THREE.Vector3(0, 2, 0),
  };
}

async function main(): Promise<void> {
  const s = subject();
  window.__CELL_INFO = s.label;
  const cap = document.getElementById('cap');
  if (cap) {
    cap.textContent = s.label
      + (q.get('arrows') === '1' ? '   |   GREEN arrow = the climb direction the code chose, RED ball = its FOOT' : '')
      + '   |   compass: MAGENTA = north (-Z), CYAN = east (+X)';
  }

  const host = document.getElementById('view')!;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181c);

  // the editor's lighting exactly, so a snapshot and the editor agree about what a piece looks like
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 12, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899ff, 0.4); fill.position.set(-6, 5, -4); scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  // EACH deck is told what is over IT, so every flight is decided the way the tower decides it
  const overBottom = s.decideAbove ?? s.above?.[0];
  /* THE ASSET BOARD is a different subject entirely — raw meshes, no grid, no placement rules. */
  if (q.get('assets') === 'stairs') {
    const b = await assetBoard(scene);
    window.__CELL_INFO = b.label;
    if (cap) cap.textContent = b.label + '   |   compass: N is -Z';
    finishBoard(scene, host, b.centre, b.radius);
    return;
  }

  /* `?compiled=1` DRAWS WHAT THE GAME DRAWS, not what `cell-place.ts` emits — see `buildCompiled`.
     The difference is the 2x2 GROUND MERGE in `cell-tower.ts`, which is invisible in the default
     view, so the default view could not gate it: a merged block once drew pavers twice the size of
     its unmerged neighbour's and every screenshot in the repo looked fine. Use it whenever the thing
     you are judging is GROUND. It ignores `extent`, which is a structure concept the compiler has
     no equivalent for, so it is for generated floors. */
  const compiled = q.get('compiled') === '1';
  const deck = (cs: readonly (Cell | null)[], over?: readonly (Cell | null)[]): Promise<THREE.Group> =>
    compiled
      ? buildCompiled(cs, s.w, s.h, over ? { above: over } : {})
      : buildGrid(cs, s.w, s.h, s.extent, over ? { above: over } : {});

  const group = await deck(s.cells, overBottom);
  scene.add(group);

  // the structure's OWN upper storeys, one FLOOR_HEIGHT apart — the same spacing the tower uses
  for (const [i, up] of (s.above ?? []).entries()) {
    const over = s.above?.[i + 1];
    const g = await deck(up, over);
    g.position.y = toFloat(FLOOR_HEIGHT) * (i + 1);
    scene.add(g);
  }

  /* STACK — the same deck repeated one storey up, which is the only way to SEE whether a staircase
     actually reaches the next floor or stops short in mid-air. */
  const storeys = Math.max(1, Math.min(4, Math.floor(num('stack', 1))));
  for (let i = 1; i < storeys; i++) {
    const above = await deck(s.cells);
    above.position.y = num('rise', toFloat(FLOOR_HEIGHT)) * i;
    scene.add(above);
  }

  /* A CELL GRID at ground level, one line per 2u cell and aligned to the cell boundaries. This is the
     ruler: "the flight sits half a cell south" is invisible without it, and it is the whole reason to
     look at a picture rather than at the numbers. The lattice is (w × h) cells wide, and `buildGrid`
     centres the FULL lattice on the origin — so the ruler must be centred the same way. */
  /* WHICH WAY DOES THE CODE THINK EACH FLIGHT CLIMBS? `?arrows=1` draws it.
     Everything else here shows what got PLACED; nothing showed what was DECIDED, so a direction bug
     and a placement bug looked identical in a screenshot and the only way to tell them apart was to
     read the numbers and trust them. An arrow over each flight makes the decision visible in the same
     frame as its consequence: if the arrow and the treads disagree, the fault is downstream of the
     scoring; if they agree and both look wrong, it is the scoring.
     A COMPASS goes in regardless, because "wrong way" is unreadable without one — an isometric camera
     maps north to a screen diagonal that changes with `--angle`, and every discussion of this so far
     has foundered on which way is up in the picture. */
  const compass = (dir: THREE.Vector3, colour: number, at: THREE.Vector3, len: number): void => {
    scene.add(new THREE.ArrowHelper(dir.clone().normalize(), at, len, colour, len * 0.3, len * 0.2));
  };

  if (q.get('arrows') === '1') {
    const DIRV: Record<string, THREE.Vector3> = {
      N: new THREE.Vector3(0, 0, -1), S: new THREE.Vector3(0, 0, 1),
      W: new THREE.Vector3(-1, 0, 0), E: new THREE.Vector3(1, 0, 0),
    };
    // every level that is drawn, so a multi-storey structure shows all its flights
    const decks: { cells: readonly (Cell | null)[]; above?: readonly (Cell | null)[]; y: number }[] =
      [{ cells: s.cells, ...(overBottom ? { above: overBottom } : {}), y: 0 }];
    for (const [i, up] of (s.above ?? []).entries()) {
      const over = s.above?.[i + 1];
      decks.push({ cells: up, ...(over ? { above: over } : {}), y: toFloat(FLOOR_HEIGHT) * (i + 1) });
    }
    for (const deck of decks) {
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
        const c = deck.cells[y * s.w + x];
        if (!c || !isStairFloor(c.floor)) continue;
        const same = (cx: number, cy: number): boolean =>
          cx >= 0 && cy >= 0 && cx < s.w && cy < s.h && deck.cells[cy * s.w + cx]?.floor === c.floor;
        if (same(x - 1, y) || same(x, y - 1)) continue;            // not the block's origin
        const fl = stairFlight(deck.cells, s.w, s.h, x, y, deck.above);
        if (!fl) continue;
        const cx = (x + (fl.bw - 1) / 2 - (s.w - 1) / 2) * CELL;
        const cz = (y + (fl.bh - 1) / 2 - (s.h - 1) / 2) * CELL;
        const mid = new THREE.Vector3(cx, deck.y + 5.2, cz);
        const v = DIRV[fl.up]!;
        // GREEN points the way it climbs, from over the foot to over the head
        scene.add(new THREE.ArrowHelper(v, mid.clone().addScaledVector(v, -2.2), 4.4, 0x2ee06a, 1.3, 0.9));
        // RED ball sits over the FOOT — the end you walk in at
        const foot = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
        foot.position.copy(mid).addScaledVector(v, -3.0);
        scene.add(foot);
      }
    }
  }

  const gw = s.w * CELL, gh = s.h * CELL;
  const ruler = new THREE.GridHelper(Math.max(gw, gh), Math.max(s.w, s.h), 0x3b6ea5, 0x2f3742);
  ruler.position.y = -0.02;
  scene.add(ruler);

  /* THE COMPASS — LETTERED, one at the middle of each edge of the ruler.
     Coloured arrows alone are not enough: they need a legend, and a legend is one more thing to get
     backwards in an argument about which way is which. A literal N on the north edge cannot be
     misread. The camera yaw is a flag, so north is a different screen direction in every shot. */
  const letter = (text: string, at: THREE.Vector3, colour: string): void => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g2 = c.getContext('2d')!;
    g2.fillStyle = 'rgba(10,12,15,0.85)';
    g2.beginPath(); g2.arc(64, 64, 56, 0, Math.PI * 2); g2.fill();
    g2.font = 'bold 84px system-ui, sans-serif';
    g2.fillStyle = colour; g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.fillText(text, 64, 70);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: false, transparent: true,
    }));
    sp.position.copy(at);
    sp.scale.setScalar(Math.max(2, Math.min(gw, gh) * 0.14));
    sp.renderOrder = 999;
    scene.add(sp);
  };
  /* PER-CASE CAPTIONS. A board of sixteen variations is a puzzle without them: you can see that one
     patch differs from its neighbour and still not know which rule it is exercising. Drawn on top of
     everything (`depthTest: false`) so a caption is never swallowed by the wall it names. */
  for (const n of s.notes ?? []) {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 80;
    const g2 = c.getContext('2d')!;
    g2.fillStyle = 'rgba(10,12,15,0.88)';
    g2.fillRect(0, 0, 640, 80);
    g2.font = 'bold 40px system-ui, sans-serif';
    g2.fillStyle = '#ffd479'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.fillText(n.text, 320, 44);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c), depthTest: false, transparent: true,
    }));
    sp.position.set((n.x - (s.w - 1) / 2) * CELL, 0.35, (n.y - (s.h - 1) / 2) * CELL);
    sp.scale.set(9, 1.13, 1);
    sp.renderOrder = 998;
    scene.add(sp);
  }

  {
    const out = 2.2, y = 1.2;
    letter('N', new THREE.Vector3(0, y, -gh / 2 - out), '#ff5bd8');
    letter('S', new THREE.Vector3(0, y, gh / 2 + out), '#ff5bd8');
    letter('E', new THREE.Vector3(gw / 2 + out, y, 0), '#5bd8ff');
    letter('W', new THREE.Vector3(-gw / 2 - out, y, 0), '#5bd8ff');
    // and the arrows, so the AXES are readable as well as the edges
    const corner = new THREE.Vector3(-gw / 2 - 1.5, 0.1, -gh / 2 - 1.5);
    const len = Math.max(3, Math.min(gw, gh) * 0.22);
    compass(new THREE.Vector3(0, 0, -1), 0xff3bd0, corner, len);   // N = -Z
    compass(new THREE.Vector3(1, 0, 0), 0x3bd0ff, corner, len);    // E = +X
  }

  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const wpx = Math.floor(host.clientWidth) || 900, hpx = Math.floor(host.clientHeight) || 620;
  r.setSize(wpx, hpx);
  host.append(r.domElement);

  /* FRAME ON WHAT IS ACTUALLY THERE. Distance from the cell count alone puts the camera inside a small
     structure: a 2×2 spans 3 lattice cells but its staircase is 5 units wide and 4 tall. The union of
     the meshes and the ruler is the honest extent. */
  const camera = new THREE.PerspectiveCamera(45, wpx / hpx, 0.1, 500);
  const box = new THREE.Box3().setFromObject(group).union(
    new THREE.Box3(new THREE.Vector3(-gw / 2, 0, -gh / 2), new THREE.Vector3(gw / 2, 0, gh / 2)),
  );
  let centre = box.getCenter(new THREE.Vector3());
  let radius = box.getSize(new THREE.Vector3()).length() / 2;

  /* `focus=<x>,<y>[,<cells>]` aims at ONE cell of a big floor. Without it, inspecting a 36x28 means
     squinting at a thumbnail; the whole point of a snapshot is to be able to go and look. */
  const f = q.get('focus')?.split(',').map(Number);
  if (f && f.length >= 2 && Number.isFinite(f[0]) && Number.isFinite(f[1])) {
    const span = (f[2] && Number.isFinite(f[2]) ? f[2] : 6);
    centre = new THREE.Vector3((f[0]! - (s.w - 1) / 2) * CELL, 1, (f[1]! - (s.h - 1) / 2) * CELL);
    radius = (span * CELL) / 2;
  }
  const dist = (radius / Math.sin((45 * Math.PI) / 360)) * num('zoom', 1);

  const a = (num('angle', 35) * Math.PI) / 180, pitch = (num('pitch', 38) * Math.PI) / 180;
  camera.position.set(
    centre.x + Math.cos(a) * Math.cos(pitch) * dist,
    centre.y + Math.sin(pitch) * dist,
    centre.z + Math.sin(a) * Math.cos(pitch) * dist,
  );
  camera.lookAt(centre);

  r.render(scene, camera);

  /* A red box in the output is a mesh that did not load. Report WHICH and WHY — but as a warning, not
     an error: the shot is still worth having, and the red box is still worth looking at. */
  const bad = loadFailures();
  const boxes = countMissing(group);
  if (bad.length || boxes) {
    window.__CELL_WARN = `${boxes} placeholder box(es) drawn; ${bad.length} load failure(s)`
      + (bad.length ? ': ' + bad.map((b) => `${b.url} (${b.why})`).join('; ') : '');
  }
  window.__CELL_READY = true;
}

main().catch((e: unknown) => {
  window.__CELL_ERROR = e instanceof Error ? e.message : String(e);
  window.__CELL_READY = true;
});
