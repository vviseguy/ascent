// ============================================================================
// src/lab/lab.ts — the ASSET LAB page (turntable gallery + snapshot hooks).
// ============================================================================
//
// A standalone Vite page (lab.html) for designing game art with visual feedback.
// Elements are auto-discovered from src/lab/elements/*.ts (default-export a
// LabElement; the element ID is the filename without extension).
//
// URL params:
//   ?element=<id>   which element to show (default: first alphabetically)
//   &seed=<n>       build seed (default 1)
//   &actor=1        orbit a demo capsule through the element (shows reactivity)
//   &frozen=1       no rAF loop — renders only on the snapshot hooks (headless use)
//
// SNAPSHOT HOOKS (used by scripts/lab-snap.mjs through headless Chromium):
//   window.__LAB_READY   true once the first frame has rendered
//   window.__LAB_ERROR   set to a message if init failed (e.g. no WebGL)
//   window.__labSetAngle(deg)  set turntable angle and re-render
//   window.__labSetTime(sec)   set scene time (wind/actor orbit) and re-render
//   window.__labList()         element ids (for tooling)
// ============================================================================

import * as THREE from 'three';
import type { LabElement, LabElementBuild } from './element.ts';
import type { WorldObject, WorldObjectBuild, Footprint } from './world-object.ts';

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

async function boot(): Promise<void> {
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
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    if (objId !== null) {
      const obj = objects.get(objId);
      if (!obj) throw new Error(`unknown object "${objId}" — known: ${objIds.join(', ')}`);
      const variant = params.get('variant') ?? obj.variants[0] ?? '';
      const ob = await obj.build(variant, seed);
      built = ob;
      footprint = ob.footprint;
      const nBoxes = footprint?.boxes.length ?? 0;
      // box-fit diagnostics (how tightly the boxes hug): coverage of solid voxels +
      // the union's solid-fill% + cell size, so the edge-density knob is tunable by eye.
      const fs = ob.fitStats;
      const fitLine = fs
        ? ` · <b>${nBoxes} box${nBoxes === 1 ? '' : 'es'}</b> · fill ${(fs.fill * 100).toFixed(0)}% · coverage ${(fs.coverage * 100).toFixed(0)}% · cell ${fs.cell.toFixed(3)}m`
        : ` · ${nBoxes} collision box${nBoxes === 1 ? '' : 'es'}`;
      hudHtml =
        `<b>${obj.name}</b> <span style="opacity:.6">(${objId} · ${variant} · ${obj.level} · seed ${seed})</span><br>` +
        `${obj.describe}<br>` +
        `<span style="opacity:.5">variants: ${obj.variants.join(' · ')} — ?object=${objId}&amp;variant=&lt;v&gt;${fitLine} (?boxes=0 off) · objects: ${objIds.join(' · ')}</span>`;
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
  W.__labFootprint = footprint ?? null;
  if (showBoxes && footprint && footprint.boxes.length) scene.add(buildBoxOverlay(footprint));

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
  let angleDeg = 30;
  let timeSec = 2.0;

  const place = (): void => {
    const a = (angleDeg * Math.PI) / 180;
    cam.position.set(Math.cos(a) * R, objCenterY + R * 0.42, Math.sin(a) * R);
    cam.lookAt(0, objCenterY, 0);
  };

  const tickActor = (): void => {
    // orbit that passes THROUGH the clump (radius shrinks/expands sinusoidally)
    const r = 0.45 + (Math.sin(timeSec * 0.9) * 0.5 + 0.5) * 1.1;
    actor.position.set(Math.cos(timeSec * 1.1) * r, 0.8, Math.sin(timeSec * 1.1) * r);
  };

  const renderOnce = (): void => {
    if (withActor) tickActor();
    built.update?.(timeSec, withActor ? [actor.position] : []);
    place();
    renderer.render(scene, cam);
  };

  if (hud) hud.innerHTML = hudHtml;

  // snapshot hooks
  W.__labSetAngle = (deg: number) => { angleDeg = deg; renderOnce(); };
  W.__labSetTime = (sec: number) => { timeSec = sec; renderOnce(); };
  W.__labList = () => [...elIds, ...objIds.map((o) => 'object:' + o)];

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.updateProjectionMatrix();
    renderOnce();
  });

  renderOnce();
  W.__LAB_READY = true;

  if (!frozen) {
    const t0 = performance.now();
    const loop = (): void => {
      timeSec = 2.0 + (performance.now() - t0) / 1000;
      angleDeg += 0.12; // lazy turntable
      renderOnce();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

void boot();
