// ============================================================================
// src/lab/lab.ts — the ASSET LAB page (turntable gallery + snapshot hooks).
// ============================================================================
//
// A standalone Vite page (lab.html) for designing game art with visual feedback.
// Elements are auto-discovered from src/lab/elements/*.ts (default-export a
// LabElement; the element ID is the filename without extension). WorldObjects are
// auto-discovered from src/lab/objects/*.ts the same way.
//
// URL params:
//   ?element=<id>   which element to show (default: first alphabetically)
//   ?object=<id>    which WorldObject to show (&variant=<v>); supersedes ?element
//   &seed=<n>       build seed (default 1)
//   &boxes=0        hide the green collision-box wireframe overlay (default ON)
//   &actor=1        orbit a demo capsule through the element (shows reactivity)
//   &frozen=1       no rAF loop — renders only on the snapshot hooks (headless use)
//   LIVE FIT (object mode): &edgeDensity=<0..1> &overlap=<0|1> &seedMode=<scan|cluster|
//                 random-best> &samples=<N> &beam=<B> — the fit-controls panel writes these
//                 so a tuned footprint state is shareable/screenshottable.
//
// LOOK-AROUND: mouse OrbitControls own the camera (left-drag orbit, wheel zoom,
// right/shift-drag pan). A lazy auto-turntable spins UNTIL the user first interacts.
//
// OBJECT PICKER: in object mode a dark vertical LIST down the left side (one small
// RENDERED thumbnail + name per WorldObject) lets you click to switch objects (preserves
// &variant/&seed/&boxes). The current object's row is highlighted.
//
// SNAPSHOT HOOKS (used by scripts/lab-snap.mjs through headless Chromium):
//   window.__LAB_READY   true once the first frame has rendered
//   window.__LAB_ERROR   set to a message if init failed (e.g. no WebGL)
//   window.__labSetAngle(deg)  position the camera on the orbit at this angle + re-render
//   window.__labSetTime(sec)   set scene time (wind/actor orbit) and re-render
//   window.__labList()         element ids (for tooling)
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LabElement, LabElementBuild } from './element.ts';
import type { WorldObject, WorldObjectBuild, Footprint } from './world-object.ts';
import { buildObjectPicker } from './object-picker.ts';
import { fitBoxesWithStats, aabbToFootprintBox, type FitStats } from './box-fit.ts';
import { buildFitControls, readFitStateFromParams, fitStateToOpts } from './fit-controls.ts';

type LabWindow = Window & {
  __LAB_READY?: boolean;
  __LAB_ERROR?: string;
  __labSetAngle?: (deg: number) => void;
  __labSetTime?: (sec: number) => void;
  __labList?: () => string[];
  /** The fitted footprint of the shown object (for box-fit tooling/verification). */
  __labFootprint?: Footprint | null;
};
const W = window as LabWindow;

// ---- element discovery (filename = id; no shared registry to conflict on) ----
const modules = import.meta.glob('./elements/*.ts', { eager: true }) as Record<
  string,
  { default?: LabElement }
>;
const elements = new Map<string, LabElement>();
for (const [path, mod] of Object.entries(modules)) {
  const id = path.replace('./elements/', '').replace('.ts', '');
  if (mod.default) elements.set(id, mod.default);
}

// ---- WorldObject discovery (objects/<id>.ts; same auto-discover pattern, docs/15) ----
const objectMods = import.meta.glob('./objects/*.ts', { eager: true }) as Record<
  string,
  { default?: WorldObject }
>;
const objects = new Map<string, WorldObject>();
for (const [path, mod] of Object.entries(objectMods)) {
  const id = path.replace('./objects/', '').replace('.ts', '');
  if (mod.default) objects.set(id, mod.default);
}

/** Build a WIREFRAME overlay of a footprint's collision boxes (toggle ?boxes=0). */
function buildBoxOverlay(footprint: Footprint): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x4effa1, transparent: true, opacity: 0.9, depthTest: false });
  for (const b of footprint.boxes) {
    const geo = new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
    edges.position.set(b.cx, b.cy, b.cz);
    edges.renderOrder = 999;
    g.add(edges);
  }
  return g;
}

/** Free a box-overlay group's geometries + shared material (so live re-fits don't leak). */
function disposeOverlay(g: THREE.Group): void {
  let mat: THREE.Material | undefined;
  g.traverse((o) => {
    const ls = o as THREE.LineSegments;
    if (ls.geometry) ls.geometry.dispose();
    if (ls.material) mat = ls.material as THREE.Material;
  });
  mat?.dispose();
}

async function boot(): Promise<void> {
  // BUILD-TIME clock: from boot() through the FIRST render (GLB load + box-fit + render),
  // surfaced in the HUD timing readout alongside the per-fit box-fit time.
  const buildStart = performance.now();
  const params = new URLSearchParams(location.search);
  const elIds = [...elements.keys()].sort();
  const objIds = [...objects.keys()].sort();
  const objId = params.get('object');
  const seed = Number(params.get('seed') ?? '1') || 1;
  const withActor = params.get('actor') === '1';
  const frozen = params.get('frozen') === '1';
  const showBoxes = params.get('boxes') !== '0'; // collision-box wireframe, default ON
  const hud = document.getElementById('hud');

  // Source is a WorldObject (?object=) or, by default, a LabElement (?element=).
  let built: LabElementBuild | WorldObjectBuild;
  let footprint: Footprint | undefined;
  let renderer: THREE.WebGLRenderer;
  let hudHtml: string;
  // OBJECT-MODE re-fit hooks (set only in object mode): the object's static HUD prefix and a
  // composer that appends the live fit-stats + timing readout, so a re-fit can rebuild the HUD.
  let objHudPrefix: string | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    if (objId !== null) {
      const obj = objects.get(objId);
      if (!obj) throw new Error(`unknown object "${objId}" — known: ${objIds.join(', ')}`);
      const variant = params.get('variant') ?? obj.variants[0] ?? '';
      const ob = await obj.build(variant, seed);
      built = ob;
      footprint = ob.footprint;
      objHudPrefix =
        `<b>${obj.name}</b> <span style="opacity:.6">(${objId} · ${variant} · ${obj.level} · seed ${seed})</span><br>` +
        `${obj.describe}<br>` +
        `<span style="opacity:.5">variants: ${obj.variants.join(' · ')} — ?object=${objId}&amp;variant=&lt;v&gt; (?boxes=0 off) · objects: ${objIds.join(' · ')}</span>`;
      hudHtml = objHudPrefix; // the fit-line + timing are appended after the first render
    } else {
      const id = params.get('element') ?? elIds[0] ?? '';
      const el = elements.get(id);
      if (!el) throw new Error(`unknown element "${id}" — known: ${elIds.join(', ')}`);
      built = el.build(seed);
      hudHtml =
        `<b>${el.name}</b> <span style="opacity:.6">(${id}, seed ${seed})</span><br>` +
        `${el.describe}<br>` +
        `<span style="opacity:.5">elements: ${elIds.join(' · ')} · objects: ${objIds.join(' · ')} — ?object=&lt;id&gt;&amp;variant=&lt;v&gt;</span>`;
    }
  } catch (e) {
    W.__LAB_ERROR = String(e);
    if (hud) hud.textContent = W.__LAB_ERROR;
    return;
  }

  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('lab')!.appendChild(renderer.domElement);

  // ---- studio scene: neutral dark, soft key + fill, shadowed ground disc ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14141e);
  const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
  key.position.set(4, 7, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -6;
  key.shadow.camera.right = key.shadow.camera.top = 6;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x33301f, 0.8));

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(7, 48),
    new THREE.MeshStandardMaterial({ color: 0x232330, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(built.root);

  // COLLISION-BOX OVERLAY: the fitted footprint as a green wireframe hugging the mesh.
  // Held in a mutable reference so a live re-fit (fit-controls) can swap it in place.
  W.__labFootprint = footprint ?? null;
  let overlay: THREE.Group | null = null;
  const setOverlay = (fp: Footprint | undefined): void => {
    if (overlay) { scene.remove(overlay); disposeOverlay(overlay); overlay = null; }
    if (showBoxes && fp && fp.boxes.length) { overlay = buildBoxOverlay(fp); scene.add(overlay); }
  };
  setOverlay(footprint);

  // demo actor: a capsule that orbits through the element (for reactivity shots)
  const actor = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.9, 4, 12),
    new THREE.MeshStandardMaterial({ color: 0x4ea1ff, roughness: 0.5 }),
  );
  actor.castShadow = true;
  actor.visible = withActor;
  scene.add(actor);

  // ---- camera: gentle three-quarter orbit framed from the element's radius ----
  // Frame from the BUILT object's real bounds (not just the authored radius): look at
  // its vertical CENTRE and pull back enough to fit its full height — so a tall prop
  // (a bookshelf, a wall) sits centred in frame instead of riding off the top edge.
  const cam = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  const objBox = new THREE.Box3().setFromObject(built.root);
  const objCenterY = Number.isFinite(objBox.min.y) ? (objBox.min.y + objBox.max.y) / 2 : 0.5;
  const objHeight = Number.isFinite(objBox.min.y) ? objBox.max.y - objBox.min.y : 1;
  // orbit distance: the larger of the authored-radius frame and what the height needs.
  const R = Math.max((built.radius ?? 2) * 2.6, objHeight * 1.6);
  const target = new THREE.Vector3(0, objCenterY, 0);
  let angleDeg = 30;
  let timeSec = 2.0;

  // ---- mouse OrbitControls: left-drag orbit, wheel zoom, right/shift-drag pan ----
  // The controls OWN the camera once the user grabs it. Until then the lazy turntable
  // drives the orbit through `place()`; the first user interaction stops the turntable
  // so the controls and the auto-spin never fight over the camera.
  const controls = new OrbitControls(cam, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = R * 0.2;
  controls.maxDistance = R * 4;
  controls.maxPolarAngle = Math.PI * 0.98; // don't let it go fully under the floor
  let userInteracting = false; // true once the user has grabbed the camera (kills turntable)
  controls.addEventListener('start', () => { userInteracting = true; });

  // Position the camera on the orbit at `angleDeg` (used by the turntable + the snapshot
  // hook). It also syncs the controls' internal spherical state so a later mouse-grab
  // continues smoothly from wherever the headless hook left the camera.
  const place = (): void => {
    const a = (angleDeg * Math.PI) / 180;
    cam.position.set(Math.cos(a) * R, objCenterY + R * 0.42, Math.sin(a) * R);
    cam.lookAt(target);
    controls.target.copy(target);
  };

  const tickActor = (): void => {
    // orbit that passes THROUGH the clump (radius shrinks/expands sinusoidally)
    const r = 0.45 + (Math.sin(timeSec * 0.9) * 0.5 + 0.5) * 1.1;
    actor.position.set(Math.cos(timeSec * 1.1) * r, 0.8, Math.sin(timeSec * 1.1) * r);
  };

  const renderOnce = (): void => {
    if (withActor) tickActor();
    built.update?.(timeSec, withActor ? [actor.position] : []);
    renderer.render(scene, cam);
  };

  if (hud) hud.innerHTML = hudHtml;

  // ---- LIVE FIT CONTROLS + TIMING READOUT (object mode only) ----------------------
  // The displayed footprint is RE-FITTED in the lab (not just whatever the build emitted)
  // so the URL fit-params apply on first load and every control change re-fits live. The
  // HUD shows the box-fit time per fit + the total build time (GLB load + fit + first render).
  let lastFitMs = 0;
  let lastFitStats: FitStats | undefined = (built as WorldObjectBuild).fitStats;
  // total build time is frozen at the FIRST render (set below); later re-fits keep it.
  let buildShownMs: number | undefined;
  // Compose the object-mode HUD: static prefix + live fit stats + timing readout.
  const composeObjHud = (): string => {
    if (objHudPrefix === null) return hudHtml;
    const fs = lastFitStats;
    const n = fs?.boxCount ?? footprint?.boxes.length ?? 0;
    const fitLine = fs
      ? `<b>${n} box${n === 1 ? '' : 'es'}</b> · fill ${(fs.fill * 100).toFixed(0)}% · coverage ${(fs.coverage * 100).toFixed(0)}% · cell ${fs.cell.toFixed(3)}m`
      : `${n} collision box${n === 1 ? '' : 'es'}`;
    const buildMs = buildShownMs ?? performance.now() - buildStart;
    const timing = `<b style="color:#cfe3ff">fit ${lastFitMs.toFixed(0)}ms</b> · build ${buildMs.toFixed(0)}ms`;
    return `${objHudPrefix}<br><span style="opacity:.85">${fitLine}</span><br><span style="opacity:.7">${timing}</span>`;
  };

  if (objId !== null && objHudPrefix !== null) {
    const root = built.root;
    const fitState = readFitStateFromParams(params);
    // Re-fit the displayed object with the current control state; update overlay + HUD + timing.
    const refit = (state = fitState): void => {
      const t0 = performance.now();
      const { boxes, stats } = fitBoxesWithStats(root, fitStateToOpts(state, seed));
      lastFitMs = performance.now() - t0;
      lastFitStats = stats;
      footprint = { boxes: boxes.map(aabbToFootprintBox) };
      W.__labFootprint = footprint;
      setOverlay(footprint);
      if (hud) hud.innerHTML = composeObjHud();
      renderOnce();
    };
    // Initial lab-side fit (applies any URL fit-params), THEN mount the controls.
    refit();
    buildShownMs = performance.now() - buildStart; // freeze the total build time at first fit/render
    if (hud) hud.innerHTML = composeObjHud();
    buildFitControls({ container: document.body, initial: fitState, onChange: (s) => refit(s) });
  }

  // ---- OBJECT PICKER (object mode only): clickable list of rendered thumbnails ----
  if (objId !== null) {
    void buildObjectPicker({
      container: document.body,
      objects,
      objIds,
      currentId: objId,
      params,
    });
  }

  // snapshot hooks — __labSetAngle positions the camera directly (so headless tooling
  // keeps working even though OrbitControls now owns the camera at runtime).
  W.__labSetAngle = (deg: number) => { angleDeg = deg; place(); renderOnce(); };
  W.__labSetTime = (sec: number) => { timeSec = sec; renderOnce(); };
  W.__labList = () => [...elIds, ...objIds.map((o) => 'object:' + o)];

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
    renderOnce();
  });

  place();
  renderOnce();
  W.__LAB_READY = true;

  if (!frozen) {
    const t0 = performance.now();
    const loop = (): void => {
      timeSec = 2.0 + (performance.now() - t0) / 1000;
      // Lazy turntable until the user grabs the camera; after that OrbitControls owns it.
      if (!userInteracting) { angleDeg += 0.12; place(); }
      controls.update(); // applies damping + any user drag
      renderOnce();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

void boot();
