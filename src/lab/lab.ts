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

type LabWindow = Window & {
  __LAB_READY?: boolean;
  __LAB_ERROR?: string;
  __labSetAngle?: (deg: number) => void;
  __labSetTime?: (sec: number) => void;
  __labList?: () => string[];
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

function boot(): void {
  const params = new URLSearchParams(location.search);
  const ids = [...elements.keys()].sort();
  const id = params.get('element') ?? ids[0] ?? '';
  const seed = Number(params.get('seed') ?? '1') || 1;
  const withActor = params.get('actor') === '1';
  const frozen = params.get('frozen') === '1';
  const el = elements.get(id);
  const hud = document.getElementById('hud');

  if (!el) {
    W.__LAB_ERROR = `unknown element "${id}" — known: ${ids.join(', ')}`;
    if (hud) hud.textContent = W.__LAB_ERROR;
    return;
  }

  let built: LabElementBuild;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    built = el.build(seed);
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

  // demo actor: a capsule that orbits through the element (for reactivity shots)
  const actor = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.9, 4, 12),
    new THREE.MeshStandardMaterial({ color: 0x4ea1ff, roughness: 0.5 }),
  );
  actor.castShadow = true;
  actor.visible = withActor;
  scene.add(actor);

  // ---- camera: gentle three-quarter orbit framed from the element's radius ----
  const cam = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  const R = (built.radius ?? 2) * 2.6;
  let angleDeg = 30;
  let timeSec = 2.0;

  const place = (): void => {
    const a = (angleDeg * Math.PI) / 180;
    cam.position.set(Math.cos(a) * R, R * 0.62, Math.sin(a) * R);
    cam.lookAt(0, Math.min(0.8, (built.radius ?? 2) * 0.3), 0);
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

  if (hud) {
    hud.innerHTML =
      `<b>${el.name}</b> <span style="opacity:.6">(${id}, seed ${seed})</span><br>` +
      `${el.describe}<br>` +
      `<span style="opacity:.5">elements: ${ids.join(' · ')} — ?element=&lt;id&gt;&amp;seed=N&amp;actor=1</span>`;
  }

  // snapshot hooks
  W.__labSetAngle = (deg: number) => { angleDeg = deg; renderOnce(); };
  W.__labSetTime = (sec: number) => { timeSec = sec; renderOnce(); };
  W.__labList = () => ids;

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

boot();
