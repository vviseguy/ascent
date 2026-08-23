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
//   &turn=0..3 &flip=1         orient the structure first — the placement must survive all eight
//   &angle=<deg> &pitch=<deg>  camera around / above
//   &zoom=<f>                  distance multiplier
//   &stack=<n>&rise=<h>        n storeys h apart (default FLOOR_HEIGHT) — does a flight REACH the next?
//
// `window.__CELL_READY` flips true when the last GLB has landed and a frame has been drawn.

import * as THREE from 'three';
import { buildGrid, countMissing, loadFailures, CELL } from './cell-preview.ts';
import { previewCell } from '../floor/cell-field.ts';
import { getStructure, listStructures } from '../floor/cell-structures.ts';
import { orientStructure } from '../floor/cell-orient.ts';
import { generateEmergent } from '../floor/cell-emergent.ts';
import { resolveFloor } from '../floor/cell-defray.ts';
import { FLOOR_HEIGHT } from '../game/tower.ts';
import { toFloat } from '../sim/fixed/fixed.ts';
import type { Cell } from '../floor/cell.ts';

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

interface Subject { cells: (Cell | null)[]; w: number; h: number; extent: { w: number; h: number }; label: string }

/** Synthetic subjects. For checking a placement rule that no authored structure happens to exercise —
 *  a bare flight with open flanks, say, when every structure in the store has walled ones. */
function demo(kind: string): Subject {
  const W = 7, H = 7;
  const cells: (Cell | null)[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c: Cell = { floor: 'stone', wallN: 'none', wallW: 'none', corner: 'none', wallType: 'solid', torch: 'no' };
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
    const r = generateEmergent({ width: w, height: h, seed: BigInt(num('seed', 1)) });
    return {
      cells: resolveFloor(r.grid), w, h, extent: { w, h },
      label: `floor ${w}x${h} seed ${num('seed', 1)} — ${r.stats.structuresPlaced} structures`,
    };
  }

  const name = q.get('structure') ?? listStructures()[0]!;
  const base = getStructure(name);
  if (!base) throw new Error(`no such structure: ${name} (have: ${listStructures().join(', ')})`);
  const turn = num('turn', 0) as 0 | 1 | 2 | 3;
  const flip = q.get('flip') === '1';
  const st = turn === 0 && !flip ? base : orientStructure(base, { turn, flip });
  return {
    // the stored grid is the POINT LATTICE, so it is one wider and one taller than the floor extent
    cells: st.cells.map((f) => previewCell(f)), w: st.w + 1, h: st.h + 1, extent: { w: st.w, h: st.h },
    label: `${name}  ${st.w}x${st.h}${turn || flip ? `  turn ${turn}${flip ? ' flipped' : ''}` : ''}`,
  };
}

async function main(): Promise<void> {
  const s = subject();
  window.__CELL_INFO = s.label;
  const cap = document.getElementById('cap');
  if (cap) cap.textContent = s.label;

  const host = document.getElementById('view')!;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181c);

  // the editor's lighting exactly, so a snapshot and the editor agree about what a piece looks like
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 12, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x8899ff, 0.4); fill.position.set(-6, 5, -4); scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  const group = await buildGrid(s.cells, s.w, s.h, s.extent);
  scene.add(group);

  /* STACK — the same deck repeated one storey up, which is the only way to SEE whether a staircase
     actually reaches the next floor or stops short in mid-air. */
  const storeys = Math.max(1, Math.min(4, Math.floor(num('stack', 1))));
  for (let i = 1; i < storeys; i++) {
    const above = await buildGrid(s.cells, s.w, s.h, s.extent);
    above.position.y = num('rise', toFloat(FLOOR_HEIGHT)) * i;
    scene.add(above);
  }

  /* A CELL GRID at ground level, one line per 2u cell and aligned to the cell boundaries. This is the
     ruler: "the flight sits half a cell south" is invisible without it, and it is the whole reason to
     look at a picture rather than at the numbers. The lattice is (w × h) cells wide, and `buildGrid`
     centres the FULL lattice on the origin — so the ruler must be centred the same way. */
  const gw = s.w * CELL, gh = s.h * CELL;
  const ruler = new THREE.GridHelper(Math.max(gw, gh), Math.max(s.w, s.h), 0x3b6ea5, 0x2f3742);
  ruler.position.y = -0.02;
  scene.add(ruler);

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
