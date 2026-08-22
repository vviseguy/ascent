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
//   &voxels=1       show the SOLID-VOXEL diagnostic (pink cubes at each solid voxel the
//                   voxelizer marked) — to SEE what the fitter thinks is solid (default OFF)
//   &actor=1        orbit a demo capsule through the element (shows reactivity)
//   &frozen=1       no rAF loop — renders only on the snapshot hooks (headless use)
//   LIVE FIT (object mode): &edgeDensity=<0..1> &overlap=<0|1> &seedMode=<scan|cluster|
//                 random-best> &samples=<N> &beam=<B> — the fit-controls panel writes these
//                 so a tuned footprint state is shareable/screenshottable.
//
// LOOK-AROUND: mouse OrbitControls own the camera (left-drag orbit, wheel zoom,
// right/shift-drag pan). A lazy auto-turntable spins UNTIL the user first interacts.
//
// CONTENT PICKER: a dark vertical TEXT LIST down the left side, DOUBLE-NESTED into
// collapsible dropdowns — level 1 = pack (KayKit Dungeon · Furniture · … · Procedural),
// level 2 = grouping (Structure · Furniture · …), level 3 = one NAME row per entry. It is
// text-only — no thumbnails, no model loads on page load (a model loads only when picked).
// Click a row to switch (objects → ?object=, procedural elements → ?element=; preserves
// &seed/&boxes and &variant where valid); the current entry's branch is opened + highlighted.
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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LabElement, LabElementBuild } from './element.ts';
import type { WorldObject, WorldObjectBuild, Footprint, WorldObjectBuildOpts } from './world-object.ts';
import { buildObjectPicker, type PickerPack, type PickerGroup, type PickerEntry } from './object-picker.ts';
import { fitBoxesWithStats, aabbToFootprintBox, voxelGridForViz, lastStitchInfo, type FitStats } from './box-fit.ts';
import { buildFitControls, readFitStateFromParams, fitStateToOpts } from './fit-controls.ts';
import { kaykitObjects, objectPack, objectCategory, PACKS } from './kaykit-catalog.ts';
import { buildRecolorLegend } from './recolor-legend.ts';
import { buildTextureSettings, type TextureSettingsHandle } from './texture-settings.ts';
import { mountProfileBar, type ProfileBarHandle } from './profile-bar.ts';
import { captureCatalogDefaults, liveRev } from './material-profiles.ts';
import { buildApproveButton, approveObject } from './approve.ts';
import { setConfig, getConfig, configFromParam, configToParam, setRelief, getRelief, reliefFromParam, reliefToParam, setAOStrength, getAOStrength, aoFromParam, aoToParam } from './texture-catalog.ts';

// Load GLB textures as <img>, not ImageBitmap: the recolor BAKE reads the atlas pixels via a 2D
// canvas, and `drawImage` works on every backend for an <img> but is refused for an ImageBitmap by
// some (headless SwiftShader, odd drivers). Disabling createImageBitmap makes GLTFLoader use
// ImageLoader. Lab-only (this never runs in the game). Must be set before any GLB loads.
(globalThis as { createImageBitmap?: unknown }).createImageBitmap = undefined;

type LabWindow = Window & {
  __LAB_READY?: boolean;
  __LAB_ERROR?: string;
  __labSetAngle?: (deg: number) => void;
  __labSetTime?: (sec: number) => void;
  __labList?: () => string[];
  /** The fitted footprint of the shown object (for box-fit tooling/verification). */
  __labFootprint?: Footprint | null;
  /** Headless approve (scripts/lab-approve.mjs): refit at `edgeDensity` then publish. Object mode only. */
  __labApprove?: (edgeDensity?: number) => Promise<unknown>;
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
// Hand-made objects/*.ts are discovered first; the auto-generated KayKit catalog
// (kaykit-catalog.ts — the whole free pack as meshObjects) is MERGED in after, deduped
// by id. The catalog ids are prefixed `kk-…` so a hand-made file always wins a collision.
const objectMods = import.meta.glob('./objects/*.ts', { eager: true }) as Record<
  string,
  { default?: WorldObject }
>;
const objects = new Map<string, WorldObject>();
// hand-made objects/*.ts — now all real KayKit-mesh objects with curated retexture variants
// (the procedural door/stair-room/table-spread were removed: assets only). They fold into the
// Dungeon pack's groups below (the catalog skips their GLBs via COVERED_BY_HANDMADE, no dupes).
const handmadeIds: string[] = [];
for (const [path, mod] of Object.entries(objectMods)) {
  const id = path.replace('./objects/', '').replace('.ts', '');
  if (mod.default) { objects.set(id, mod.default); handmadeIds.push(id); }
}
// MERGE the KayKit catalog (skip any id a hand-made file already claimed).
for (const [id, obj] of Object.entries(kaykitObjects)) {
  if (!objects.has(id)) objects.set(id, obj);
}

/** Which Dungeon-pack group each hand-made mesh object folds into. */
const HANDMADE_DUNGEON_CATEGORY: Record<string, string> = {
  table: 'Furniture', bed: 'Furniture', bookshelf: 'Furniture',
  barrel: 'Containers', 'treasure-chest': 'Containers', wall: 'Structure',
};
/** Level-2 grouping for the kept procedural LabElements (the "exceptions" — KayKit has no
 *  organic/material equivalents). They open via element mode (?element=). */
const PROCEDURAL_GROUP: Record<string, string> = {
  'stone-slab': 'Terrain', 'stone-wall': 'Terrain', 'rubble-pile': 'Terrain',
  'grass-clump': 'Nature', 'fern-shrub': 'Nature', 'vine-drape': 'Nature',
  'vine-wall': 'Nature', 'glow-crystal': 'Nature',
};
const PROCEDURAL_GROUP_ORDER = ['Terrain', 'Nature'] as const;

/** Order present categories by a declared order; append any extras alphabetically. */
function orderCats(present: Iterable<string>, declared: readonly string[]): string[] {
  const set = new Set(present);
  return [...declared.filter((c) => set.has(c)), ...[...set].filter((c) => !declared.includes(c)).sort()];
}

/** The DOUBLE-NESTED side list (object-picker's pack → group → entry model): one pack per
 *  KayKit PackDef (entries = catalog objects + the hand-made objects folded into the Dungeon
 *  pack), then a "Procedural" pack of the kept LabElements. Empty packs/groups drop in the picker. */
function buildPickerPacks(): PickerPack[] {
  const packs: PickerPack[] = [];

  for (const pack of PACKS) {
    const byCat = new Map<string, PickerEntry[]>();
    const add = (cat: string, e: PickerEntry): void => {
      const l = byCat.get(cat); if (l) l.push(e); else byCat.set(cat, [e]);
    };
    for (const id of Object.keys(kaykitObjects)) {
      if (objectPack[id] !== pack.id) continue;
      const obj = objects.get(id);
      if (obj) add(objectCategory[id] ?? 'Decor', { id, name: obj.name, kind: 'object' });
    }
    if (pack.id === 'dungeon') {
      for (const id of handmadeIds) {
        const cat = HANDMADE_DUNGEON_CATEGORY[id];
        const obj = objects.get(id);
        if (cat && obj) add(cat, { id, name: obj.name, kind: 'object' });
      }
    }
    const groups: PickerGroup[] = orderCats(byCat.keys(), pack.categories).map((label) => ({
      label,
      entries: (byCat.get(label) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
    packs.push({ label: pack.label, groups });
  }

  // Procedural pack = the kept LabElements (open via element mode).
  const byGroup = new Map<string, PickerEntry[]>();
  for (const id of [...elements.keys()].sort()) {
    const el = elements.get(id);
    if (!el) continue;
    const grp = PROCEDURAL_GROUP[id] ?? 'Misc';
    const e: PickerEntry = { id, name: el.name, kind: 'element' };
    const l = byGroup.get(grp); if (l) l.push(e); else byGroup.set(grp, [e]);
  }
  packs.push({
    label: 'Procedural',
    groups: orderCats(byGroup.keys(), PROCEDURAL_GROUP_ORDER).map((label) => ({
      label,
      entries: (byGroup.get(label) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    })),
  });

  return packs;
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

/** Build the VOXEL-VISUALIZATION overlay (?voxels=1): a semi-transparent InstancedMesh of small
 *  cubes at the centre of every SOLID voxel the voxelizer produced. This is the diagnostic for
 *  "what does the fitter think is solid?" — a concavity over-fill (a leg-gap / under-top reading
 *  solid) shows up as cubes floating in empty space. The cube is slightly smaller than the cell so
 *  adjacent voxels stay visually distinct. Reads the SAME grid the fit used (voxelGridForViz). */
function buildVoxelOverlay(root: THREE.Object3D, opts: Parameters<typeof voxelGridForViz>[1]): THREE.Object3D | null {
  const { cell, centers, count } = voxelGridForViz(root, opts);
  if (count === 0) return null;
  const geo = new THREE.BoxGeometry(cell * 0.82, cell * 0.82, cell * 0.82);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5aa0, transparent: true, opacity: 0.28, depthWrite: false });
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    m.makeTranslation(centers[i * 3]!, centers[i * 3 + 1]!, centers[i * 3 + 2]!);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.renderOrder = 998; // under the green box wireframe (999), over the mesh
  return inst;
}

/** Dispose a voxel InstancedMesh overlay's geometry + material. */
function disposeVoxelOverlay(o: THREE.Object3D): void {
  const inst = o as THREE.InstancedMesh;
  inst.geometry?.dispose();
  (inst.material as THREE.Material | undefined)?.dispose();
}

/** Free a previous build's BAKED material + its baked DataTextures (so a live texture-rebuild doesn't
 *  leak GPU memory). Geometry is NOT disposed — it's shared with the cached GLB template (SkeletonUtils
 *  clone shares geometry by reference); the tiling textures are shared (texture-catalog lib) too. */
function disposeBuiltMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial | undefined;
    if (!mat) return;
    mat.map?.dispose(); // baked albedo DataTexture (per build)
    mat.roughnessMap?.dispose(); // baked ORM DataTexture (== metalnessMap, per build)
    mat.dispose();
  });
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
  const showVoxels = params.get('voxels') === '1'; // solid-voxel diagnostic cubes, default OFF
  // COLORING MODE: per-pixel RECOLOR (recolor.ts) by default; ?raw=1 shows the original KayKit atlas.
  const rawColoring = params.get('raw') === '1';
  // DEBUG self-test: ?tintall=<hex> forces every swatch to one colour — if the model turns that
  // colour, the recolor bake is running on your machine (proves it's not a stale bundle).
  const tintAllParam = params.get('tintall');
  const tintAll = tintAllParam ? parseInt(tintAllParam.replace(/^#/, ''), 16) : NaN;
  const buildOpts: WorldObjectBuildOpts = rawColoring
    ? { raw: true }
    : (Number.isFinite(tintAll) ? { tintAll } : {});
  // TEXTURE CONFIG (which texture + surface per type) + RELIEF: parse the URL into the shared config
  // BEFORE the first build, so a shared/screenshotted ?tex=…&relief=… link bakes correctly on load.
  setConfig(configFromParam(params.get('tex')));
  // snapshot the catalog's out-of-the-box relief/AO BEFORE the URL overrides them, so resolving a
  // profile inherits the real defaults rather than whatever this link happened to pin.
  captureCatalogDefaults();
  setRelief(reliefFromParam(params.get('relief')));
  setAOStrength(aoFromParam(params.get('ao')));
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
      const ob = await obj.build(variant, seed, buildOpts);
      built = ob;
      footprint = ob.footprint;
      objHudPrefix =
        `<b>${obj.name}</b> <span style="opacity:.6">(${objId} · ${variant} · ${obj.level} · seed ${seed})</span><br>` +
        `${obj.describe}<br>` +
        `<span style="opacity:.5">variants: ${obj.variants.join(' · ')} — ?object=${objId}&amp;variant=&lt;v&gt; (?boxes=0 off) · ${objIds.length} objects in the side list →</span>`;
      hudHtml = objHudPrefix; // the fit-line + timing are appended after the first render
    } else {
      const id = params.get('element') ?? elIds[0] ?? '';
      const el = elements.get(id);
      if (!el) throw new Error(`unknown element "${id}" — known: ${elIds.join(', ')}`);
      built = el.build(seed);
      hudHtml =
        `<b>${el.name}</b> <span style="opacity:.6">(${id}, seed ${seed})</span><br>` +
        `${el.describe}<br>` +
        `<span style="opacity:.5">elements: ${elIds.join(' · ')} · ${objIds.length} objects — ?object=&lt;id&gt;&amp;variant=&lt;v&gt;</span>`;
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
  // RAKE: the key's direction is a control, not a constant. A normal map only shows itself when the
  // light crosses the grain at a low angle — with a fixed high frontal key, relief looks broken even
  // when it is working. Azimuth/elevation are driven from the TEXTURE SETTINGS panel (render-only,
  // no re-bake) and persist in the URL so a screenshot reproduces its own lighting.
  const KEY_DIST = 8.6;
  const lightRake = { az: 0.10, el: 0.62 }; // matches the original (4, 7, 3) placement
  {
    const [az, el] = (params.get('rake') ?? '').split(':').map(Number);
    if (Number.isFinite(az)) lightRake.az = Math.min(1, Math.max(0, az! / 100));
    if (Number.isFinite(el)) lightRake.el = Math.min(1, Math.max(0, el! / 100));
  }
  const applyRake = (): void => {
    const a = lightRake.az * Math.PI * 2;
    const e = 0.06 + lightRake.el * (Math.PI / 2 - 0.12); // never exactly horizon/zenith
    key.position.set(KEY_DIST * Math.cos(e) * Math.cos(a), KEY_DIST * Math.sin(e), KEY_DIST * Math.cos(e) * Math.sin(a));
  };
  applyRake();

  // TORCH — a warm POINT light, matching what the game actually puts on a wall
  // (dungeon.ts: PointLight 0xffa64d, decay 2, up to MAX_TORCH_LIGHTS of them). The studio key is a
  // directional light at infinity; a torch is close, decaying, and off to one side, so it rakes the
  // grain completely differently. Materials for a torch-lit dungeon should be judged under one.
  // Costs nothing at intensity 0 — three skips lights with zero intensity.
  const torch = new THREE.PointLight(0xffa64d, 0, 7, 2);
  torch.position.set(-1.75, 0.6, 0.55); // beside the wall and low, so it RAKES the face — a light
  // hitting a surface head-on barely reveals a normal map (N.L is flat near the cosine peak).
  scene.add(torch);
  const torchLevel = { v: Math.min(1, Math.max(0, Number(params.get('torch')) || 0)) };
  const applyTorch = (): void => { torch.intensity = torchLevel.v * 26; };
  applyTorch();
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -6;
  key.shadow.camera.right = key.shadow.camera.top = 6;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x33301f, 0.8));

  // IBL ENVIRONMENT — metalness is a REFLECTION property: with nothing to reflect, metal surfaces go
  // dark/flat grey and read as stone. A neutral room env (no asset needed) gives them something to
  // reflect so they read as metal. Modest intensity so matte stone/wood isn't washed out.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

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
  let boxesVisible = showBoxes; // toggled live by the "show boxes" checkbox (persists to ?boxes=)
  const setOverlay = (fp: Footprint | undefined): void => {
    if (overlay) { scene.remove(overlay); disposeOverlay(overlay); overlay = null; }
    if (boxesVisible && fp && fp.boxes.length) { overlay = buildBoxOverlay(fp); scene.add(overlay); }
  };
  setOverlay(footprint);

  // VOXEL-VIZ OVERLAY (?voxels=1): the solid-voxel diagnostic, rebuilt by the object-mode refit
  // when the fit opts change (its grid depends on the same opts). Mutable so refits swap it.
  let voxelOverlay: THREE.Object3D | null = null;
  const setVoxelOverlay = (root: THREE.Object3D, opts: Parameters<typeof voxelGridForViz>[1]): void => {
    if (voxelOverlay) { scene.remove(voxelOverlay); disposeVoxelOverlay(voxelOverlay); voxelOverlay = null; }
    if (showVoxels) { const v = buildVoxelOverlay(root, opts); if (v) { voxelOverlay = v; scene.add(v); } }
  };

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

  // ---- CONTROLS BAR (bottom, right of the picker): one tidy bar for the view toggles, so they
  // don't float separately and stack. Holds: coloring MODE (recolored / raw atlas) + show-boxes.
  {
    const bar = document.createElement('div');
    bar.id = 'lab-controls';
    Object.assign(bar.style, {
      position: 'fixed', left: '236px', bottom: '10px', zIndex: '25', display: 'flex', alignItems: 'center',
      gap: '14px', userSelect: 'none', color: '#bcd', font: '11px system-ui',
      background: 'rgba(10,10,22,.82)', border: '1px solid rgba(120,130,170,.28)', borderRadius: '9px',
      padding: '6px 11px', boxShadow: '0 4px 18px rgba(0,0,0,.45)',
    } as Partial<CSSStyleDeclaration>);

    // coloring MODE — recolored (default) vs raw atlas. Navigates (?raw=) like the picker.
    const modeWrap = document.createElement('label');
    Object.assign(modeWrap.style, { display: 'flex', alignItems: 'center', gap: '6px' } as Partial<CSSStyleDeclaration>);
    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'coloring'; modeLbl.style.opacity = '.7';
    modeWrap.appendChild(modeLbl);
    const modeSel = document.createElement('select');
    Object.assign(modeSel.style, { background: 'rgba(20,20,34,.9)', color: '#cde', border: '1px solid rgba(120,130,170,.3)', borderRadius: '6px', padding: '2px 4px' } as Partial<CSSStyleDeclaration>);
    for (const [val, label] of [['', 'Recolored'], ['1', 'Raw atlas']] as const) {
      const o = document.createElement('option'); o.value = val; o.textContent = label;
      if ((val === '1') === rawColoring) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener('change', () => {
      const next = new URLSearchParams(location.search);
      if (modeSel.value) next.set('raw', '1'); else next.delete('raw');
      location.href = `${location.pathname}?${next.toString()}`;
    });
    modeWrap.appendChild(modeSel);
    bar.appendChild(modeWrap);

    // show-boxes — live toggle of the collision-box overlay (persists to ?boxes=).
    const boxWrap = document.createElement('label');
    Object.assign(boxWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } as Partial<CSSStyleDeclaration>);
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = boxesVisible;
    Object.assign(cb.style, { accentColor: '#4effa1' } as Partial<CSSStyleDeclaration>);
    cb.addEventListener('change', () => {
      boxesVisible = cb.checked;
      setOverlay(footprint);
      const next = new URLSearchParams(location.search);
      if (boxesVisible) next.delete('boxes'); else next.set('boxes', '0');
      history.replaceState(null, '', `${location.pathname}?${next.toString()}`);
      renderOnce();
    });
    boxWrap.appendChild(cb);
    boxWrap.appendChild(Object.assign(document.createElement('span'), { textContent: 'show boxes' }));
    bar.appendChild(boxWrap);

    document.body.appendChild(bar);
  }

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
      ? `<b>${n} box${n === 1 ? '' : 'es'}</b> · fill ${(fs.fill * 100).toFixed(0)}% · coverage ${(fs.coverage * 100).toFixed(0)}% · ed ${(fs.edgeDensity * 100).toFixed(0)}% · cell ${fs.cell.toFixed(3)}m`
      : `${n} collision box${n === 1 ? '' : 'es'}`;
    const buildMs = buildShownMs ?? performance.now() - buildStart;
    const timing = `<b style="color:#cfe3ff">fit ${lastFitMs.toFixed(0)}ms</b> · build ${buildMs.toFixed(0)}ms`;
    // STITCH readout: how many boundary holes were closed; flag the ground-seal FALLBACK if any
    // loop couldn't be stitched (the mesh stayed leaky for that fit).
    const si = lastStitchInfo;
    const stitch = si.loops > 0
      ? `stitch ${si.stitched}/${si.loops} hole${si.loops === 1 ? '' : 's'}${si.failed > 0 ? ` · <b style="color:#ffb060">FALLBACK (${si.failed} unclosed)</b>` : ''}`
      : 'stitch watertight';
    return `${objHudPrefix}<br><span style="opacity:.85">${fitLine}</span><br><span style="opacity:.7">${timing} · ${stitch}</span>`;
  };

  if (objId !== null && objHudPrefix !== null) {
    const fitState = readFitStateFromParams(params);
    // Re-fit the displayed object with the current control state; update overlay + HUD + timing.
    // Reads built.root LIVE (not a captured ref) so it works after a texture rebuild swaps the root.
    const refit = (state = fitState): void => {
      const t0 = performance.now();
      const opts = fitStateToOpts(state, seed);
      const { boxes, stats } = fitBoxesWithStats(built.root, opts);
      lastFitMs = performance.now() - t0;
      lastFitStats = stats;
      footprint = { boxes: boxes.map(aabbToFootprintBox) };
      W.__labFootprint = footprint;
      setOverlay(footprint);
      setVoxelOverlay(built.root, opts); // refresh the solid-voxel diagnostic (?voxels=1) for this fit
      if (hud) hud.innerHTML = composeObjHud();
      renderOnce();
    };
    // Initial lab-side fit (applies any URL fit-params), THEN mount the controls.
    refit();
    buildShownMs = performance.now() - buildStart; // freeze the total build time at first fit/render
    if (hud) hud.innerHTML = composeObjHud();
    buildFitControls({ container: document.body, initial: fitState, onChange: (s) => refit(s) });

    // ---- TEXTURE SETTINGS: re-bake the object LIVE when a type's texture/surface changes ----
    // A change mutates the shared config (texture-catalog); we rebuild the object (re-runs the
    // recolor bake, which reads the config), swap it into the scene, re-fit, and persist to ?tex=.
    const obj = objects.get(objId)!;
    const variant = params.get('variant') ?? obj.variants[0] ?? '';
    let rebuilding = false;
    const rebuildObject = async (): Promise<void> => {
      if (rebuilding) return; // coalesce overlapping rebuilds (debounce already throttles)
      rebuilding = true;
      try {
        const next = await obj.build(variant, seed, buildOpts);
        scene.remove(built.root);
        disposeBuiltMaterials(built.root); // free the previous bake's textures (geometry is shared)
        built = next;
        footprint = next.footprint;
        scene.add(built.root);
        refit(); // re-fit boxes on the new root (also renders)
      } finally {
        rebuilding = false;
      }
      writeSurfaceUrl();
    };
    // The surface state (textures, relief, AO, light rake) all round-trips through the URL, so a
    // shared link or a screenshot script reproduces exactly what you were looking at.
    function writeSurfaceUrl(): void {
      const tex = configToParam(getConfig());
      const rel = reliefToParam(getRelief());
      const ao = aoToParam(getAOStrength());
      const u = new URLSearchParams(location.search);
      if (tex) u.set('tex', tex); else u.delete('tex');
      if (rel) u.set('relief', rel); else u.delete('relief');
      if (ao) u.set('ao', ao); else u.delete('ao');
      const prof = profileBar?.current()?.id;
      if (prof) u.set('profile', prof); else u.delete('profile');
      u.set('rake', `${Math.round(lightRake.az * 100)}:${Math.round(lightRake.el * 100)}`);
      if (torchLevel.v > 0) u.set('torch', String(torchLevel.v.toFixed(2))); else u.delete('torch');
      history.replaceState(null, '', `${location.pathname}?${u.toString()}`);
      profileBar?.refresh(); // the drift indicator is only true until the next edit
    }
    let texPanel: TextureSettingsHandle | undefined;
    let profileBar: ProfileBarHandle | undefined;
    texPanel = buildTextureSettings({
      container: document.body,
      onChange: () => { void rebuildObject(); },
      header: (mount) => {
        profileBar = mountProfileBar({
          mount,
          initial: params.get('profile'),
          // a profile REPLACES the live config wholesale, so every widget in the panel has to be
          // pulled back into line before the re-bake — otherwise the sliders lie about what is on.
          onApplied: () => { texPanel?.resync(); void rebuildObject(); },
        });
      },
      extras: [
        { label: 'Light ∠', get: () => lightRake.az, set: (v) => { lightRake.az = v; applyRake(); writeSurfaceUrl(); renderOnce(); } },
        { label: 'Light ↑', get: () => lightRake.el, set: (v) => { lightRake.el = v; applyRake(); writeSurfaceUrl(); renderOnce(); } },
        { label: 'Torch', get: () => torchLevel.v, set: (v) => { torchLevel.v = v; applyTorch(); writeSurfaceUrl(); renderOnce(); } },
      ],
    });

    // ---- APPROVE & SAVE: freeze this object's auto-fit + materials to the published store ----
    // Reads the LIVE fit/material state on click (post-refit), POSTs to the dev middleware.
    buildApproveButton({
      container: document.getElementById('lab-controls') ?? document.body,
      objectId: objId,
      getState: () => ({
        footprint,
        stats: lastFitStats,
        seedMode: fitState.seedMode,
        autoEdge: fitState.autoEdge,
        recolor: (built as WorldObjectBuild).recolor,
        present: (built as WorldObjectBuild).presentSwatches,
      // record the LIVE rev, not the profile's: if the reviewer drifted off the profile before
      // approving, what got frozen is the drift, and the store should say so.
      profile: profileBar?.current() ? { id: profileBar.current()!.id, rev: liveRev() } : undefined,
      }),
    });

    // Headless approval (scripts/lab-approve.mjs): refit at a chosen edge density, then approve —
    // so the wall pieces can be box-fit + frozen in bulk without manual clicks. autoEdge off → honour `ed`.
    W.__labApprove = (ed = 0.4): Promise<unknown> => {
      refit({ ...fitState, autoEdge: false, edgeDensity: ed });
      return approveObject(objId, {
        footprint,
        stats: lastFitStats,
        seedMode: fitState.seedMode,
        autoEdge: false,
        recolor: (built as WorldObjectBuild).recolor,
        present: (built as WorldObjectBuild).presentSwatches,
        profile: profileBar?.current() ? { id: profileBar.current()!.id, rev: liveRev() } : undefined,
      });
    };
  }

  // ---- CONTENT PICKER (both modes): TEXT-ONLY double-nested clickable list ----
  // No thumbnails, no model loads here — a model loads only when a row is picked.
  buildObjectPicker({
    container: document.body,
    objects,
    packs: buildPickerPacks(),
    currentId: objId ?? params.get('element') ?? elIds[0] ?? null,
    params,
  });

  // ---- SWATCH → MATERIAL LEGEND (object mode only) ----
  if (objId !== null) {
    const ob = built as WorldObjectBuild;
    if (ob.recolor) {
      buildRecolorLegend({
        container: document.body,
        recolor: ob.recolor,
        objectName: objects.get(objId)?.name ?? objId,
        ...(ob.presentSwatches ? { present: ob.presentSwatches } : {}),
      });
    }
  }

  // ---- HIDE-UI BUTTON (top-right corner): collapse every panel to see the bare model, and a way
  // back. State PERSISTS in the URL (?ui=0) via replaceState, so it survives a reload / the
  // coloring + boxes navigations instead of being lost. The button itself always stays visible.
  {
    const ids = ['hud', 'object-picker', 'fit-controls', 'lab-controls', 'recolor-legend', 'texture-settings'];
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      position: 'fixed', right: '10px', top: '10px', zIndex: '30', cursor: 'pointer',
      color: '#cde', font: '11px system-ui', background: 'rgba(10,10,22,.82)',
      border: '1px solid rgba(120,130,170,.4)', borderRadius: '8px', padding: '5px 9px',
      boxShadow: '0 4px 18px rgba(0,0,0,.45)',
    } as Partial<CSSStyleDeclaration>);
    let hidden = params.get('ui') === '0';
    const apply = (): void => {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (hidden) { if (el.dataset['prevDisp'] === undefined) el.dataset['prevDisp'] = el.style.display; el.style.display = 'none'; }
        else { el.style.display = el.dataset['prevDisp'] ?? ''; delete el.dataset['prevDisp']; }
      }
      btn.textContent = hidden ? '☰ show UI' : '✕ hide UI';
      const next = new URLSearchParams(location.search);
      if (hidden) next.set('ui', '0'); else next.delete('ui');
      history.replaceState(null, '', `${location.pathname}?${next.toString()}`);
    };
    btn.addEventListener('click', () => { hidden = !hidden; apply(); });
    if (hidden) apply(); // restore a persisted hidden state on load
    else btn.textContent = '✕ hide UI'; // shown: don't touch panels (keep their own display)
    document.body.appendChild(btn);
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
