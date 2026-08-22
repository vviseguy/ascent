// ============================================================================
// src/lab/sheet.ts — the CONTACT SHEET: one profile, every object, at once.
// ============================================================================
//
// The lab shows ONE object at a time. That is right for approving a footprint and wrong for judging
// a material: you tune stone on a wall, it looks great, and you find out three objects later that
// it wrecked the barrels. Every material decision is a decision about the whole SET, so the set is
// what you should be looking at while you make it.
//
// This page renders every object on one grid under the CURRENT profile. Change a texture and all of
// them re-bake together. The texture-array layer (tiling.ts) is what makes that affordable —
// materials are shared, so N objects cost one array build, not N.
//
//   ?approved=1   (default) only objects in the approved store — the set that ships
//   ?pack=<id>    a whole KayKit pack (dungeon_remastered, furniture, …)
//   ?ids=a,b,c    an explicit list
//   ?limit=<n>    cap the grid (default 48)
//   ?cols=<n>     override the column count
//
// Each cell is badged against the live profile rev, so "which approved objects have fallen behind?"
// is something you SEE rather than something you have to remember to ask.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { kaykitObjects, objectPack } from './kaykit-catalog.ts';
import type { WorldObject, WorldObjectBuild } from './world-object.ts';
import { buildTextureSettings, type TextureSettingsHandle } from './texture-settings.ts';
import { mountProfileBar, type ProfileBarHandle } from './profile-bar.ts';
import { captureCatalogDefaults, liveRev } from './material-profiles.ts';
import { setConfig, getConfig, configFromParam, setRelief, reliefFromParam, setAOStrength, aoFromParam } from './texture-catalog.ts';
import { ensureTilingTextures } from './recolor.ts';
import { APPROVED_ASSETS, approvedProfile } from '../game/approved-assets.ts';

// See lab.ts: the recolor BAKE reads atlas pixels through a 2D canvas, and drawImage is refused for
// an ImageBitmap on some backends. Must be set before any GLB loads.
(globalThis as { createImageBitmap?: unknown }).createImageBitmap = undefined;

const objectMods = import.meta.glob('./objects/*.ts', { eager: true }) as Record<string, { default?: WorldObject }>;
const objects = new Map<string, WorldObject>();
for (const [path, mod] of Object.entries(objectMods)) {
  if (mod.default) objects.set(path.replace('./objects/', '').replace('.ts', ''), mod.default);
}
for (const [id, obj] of Object.entries(kaykitObjects)) if (!objects.has(id)) objects.set(id, obj);

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const n = Number(params.get(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Which objects to show. Approved-only by default: that is the set that actually ships. */
function pickIds(): string[] {
  const explicit = params.get('ids');
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter((id) => objects.has(id));
  const pack = params.get('pack');
  if (pack) return Object.keys(kaykitObjects).filter((id) => objectPack[id] === pack);
  return Object.keys(APPROVED_ASSETS.objects).filter((id) => objects.has(id));
}

const CELL = 2.6;        // cell WIDTH in world units — objects are normalised into this
// Rows are spaced wider than they are tall on screen: in a front-3/4 view the front row would
// otherwise stand in front of the one behind it and you would be judging half a sheet.
const CELL_Z = CELL * 1.75;
const MARGIN = 0.82;     // fraction of the cell an object may fill (leaves a gutter)

async function main(): Promise<void> {
  const host = document.getElementById('sheet')!;
  const overlay = document.getElementById('labels')!;
  const hud = document.getElementById('hud')!;

  const ids = pickIds().slice(0, num('limit', 48));
  if (!ids.length) {
    hud.textContent = 'nothing to show — try ?pack=dungeon_remastered or ?ids=bed,barrel';
    return;
  }

  // surface state from the URL, BEFORE the first bake (same contract as the lab)
  captureCatalogDefaults();
  setConfig(configFromParam(params.get('tex')));
  setRelief(reliefFromParam(params.get('relief')));
  setAOStrength(aoFromParam(params.get('ao')));

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) {
    hud.textContent = 'WebGL unavailable: ' + String(e);
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14141e);

  // Same studio rig as the lab, so a judgement made here transfers there.
  const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x33301f, 0.8));
  const pmrem = new THREE.PMREMGenerator(renderer);
  // RoomEnvironment, matching the lab exactly — an empty scene here would give metals nothing to
  // reflect, and they would read as dark stone on the sheet but as metal in the lab.
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const lightRake = { az: 0.1, el: 0.62 };
  {
    const [az, el] = (params.get('rake') ?? '').split(':').map(Number);
    if (Number.isFinite(az)) lightRake.az = Math.min(1, Math.max(0, az! / 100));
    if (Number.isFinite(el)) lightRake.el = Math.min(1, Math.max(0, el! / 100));
  }

  // Choose columns so the grid's on-screen rectangle roughly matches the free viewport aspect. The
  // front-3/4 view compresses depth to ~0.6, so a row is "shorter" than a column is wide.
  const aspect = Math.max(1, (innerWidth - 280)) / Math.max(1, innerHeight) / 0.75;
  const cols = Math.max(1, num('cols', Math.max(1, Math.round(Math.sqrt(ids.length * aspect)))));
  const rows = Math.ceil(ids.length / cols);
  const gridW = cols * CELL, gridD = rows * CELL_Z;
  const cellPos = (i: number): THREE.Vector3 => new THREE.Vector3(
    (i % cols) * CELL - gridW / 2 + CELL / 2, 0, Math.floor(i / cols) * CELL_Z - gridD / 2 + CELL_Z / 2,
  );

  const applyRake = (): void => {
    const a = lightRake.az * Math.PI * 2;
    const e = 0.06 + lightRake.el * (Math.PI / 2 - 0.12);
    const d = Math.max(gridW, gridD) * 1.2;
    key.position.set(d * Math.cos(e) * Math.cos(a), d * Math.sin(e), d * Math.cos(e) * Math.sin(a));
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -Math.max(gridW, gridD);
    sc.right = sc.top = Math.max(gridW, gridD);
    sc.updateProjectionMatrix();
  };
  applyRake();

  // ORTHOGRAPHIC, fixed FRONT-3/4 direction: every cell is framed identically, which is the whole
  // point of a contact sheet — a perspective camera would foreshorten the far rows and you would be
  // comparing materials at different apparent scales. Front-3/4 rather than corner-on isometric so
  // the grid projects to a RECTANGLE (fills a wide viewport) and every object faces the viewer.
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  /** The panel is fixed on the left; the grid should centre in what is LEFT of the viewport, not in
   *  the window, or half the sheet hides behind the controls. */
  const PANEL_L = 12;             // the sheet puts the panel hard against the left edge
  const PANEL_W = PANEL_L + 238 + 18;

  // Fit EXACTLY: project the grid's corner points into camera space and size the ortho box to them.
  // (Estimating the on-screen span of a 3/4 view analytically is easy to get wrong — this just
  //  measures it, and stays correct if the layout or camera direction changes.)
  const fitCamera = (): void => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    const d = 160;
    cam.position.set(0, d * 0.60, d * 0.80);
    cam.lookAt(0, CELL * 0.3, 0);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    // fit to what the OBJECTS occupy, not the padded ground plane, or the sheet renders small
    const hx = gridW / 2, hz = gridD / 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, CELL * MARGIN]) {
      const v = new THREE.Vector3(sx * hx, y, sz * hz).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const availW = Math.max(240, w - PANEL_W - 24);
    const pad = 1.04;
    const unitsPerPx = Math.max((maxX - minX) * pad / availW, (maxY - minY) * pad / h);
    // centre the grid inside the free area, then widen left to cover the space under the panel
    const halfW = w * unitsPerPx / 2;
    const shift = (PANEL_W / 2) * unitsPerPx; // push the content right of the panel
    const cx = (minX + maxX) / 2 - shift, cy = (minY + maxY) / 2;
    cam.left = cx - halfW; cam.right = cx + halfW;
    cam.top = cy + h * unitsPerPx / 2; cam.bottom = cy - h * unitsPerPx / 2;
    cam.updateProjectionMatrix();
  };

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(gridW + CELL, gridD + CELL_Z),
    new THREE.MeshStandardMaterial({ color: 0x232330, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- build ---------------------------------------------------------------------------------

  interface Cell { id: string; name: string; holder: THREE.Group; label: HTMLElement; }
  const cells: Cell[] = [];

  /** Drop an object into its cell, normalised so every cell reads at the same apparent size. */
  const place = (build: WorldObjectBuild, holder: THREE.Group): void => {
    holder.clear();
    const box = new THREE.Box3().setFromObject(build.root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const k = (CELL * MARGIN) / Math.max(size.x, size.y, size.z, 1e-3);
    build.root.scale.multiplyScalar(k);
    build.root.position.x -= (box.min.x + box.max.x) / 2 * k;
    build.root.position.z -= (box.min.z + box.max.z) / 2 * k;
    build.root.position.y -= box.min.y * k;
    holder.add(build.root);
  };

  const buildOne = async (id: string, holder: THREE.Group): Promise<void> => {
    const obj = objects.get(id);
    if (!obj) return;
    try {
      place(await obj.build(obj.variants[0] ?? '', 1), holder);
    } catch (e) {
      console.warn(`[sheet] ${id} failed to build:`, e);
    }
  };

  hud.textContent = `loading ${ids.length} objects…`;
  await ensureTilingTextures();

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const holder = new THREE.Group();
    holder.position.copy(cellPos(i));
    scene.add(holder);
    const label = document.createElement('div');
    label.className = 'cellLabel';
    overlay.appendChild(label);
    cells.push({ id, name: objects.get(id)?.name ?? id, holder, label });
  }

  // Sequential, not Promise.all: 48 concurrent GLB loads + bakes stalls the main thread hard enough
  // that the page looks hung. One at a time keeps the grid filling in visibly.
  for (let i = 0; i < cells.length; i++) {
    await buildOne(cells[i]!.id, cells[i]!.holder);
    hud.textContent = `loading ${i + 1}/${cells.length}…`;
    fitCamera();
    renderer.render(scene, cam);
  }

  const rebuildAll = async (): Promise<void> => {
    hud.textContent = 're-baking…';
    await ensureTilingTextures();
    for (const c of cells) await buildOne(c.id, c.holder);
    syncLabels();
    renderer.render(scene, cam);
  };

  // ---- labels + staleness --------------------------------------------------------------------

  const syncLabels = (): void => {
    const rev = liveRev();
    let stale = 0;
    for (const c of cells) {
      const p = approvedProfile(c.id);
      const isStale = !!APPROVED_ASSETS.objects[c.id] && p?.rev !== rev;
      if (isStale) stale++;
      const badge = !APPROVED_ASSETS.objects[c.id]
        ? '<span class="b unapproved">not approved</span>'
        : isStale ? '<span class="b stale">behind</span>' : '<span class="b ok">current</span>';
      c.label.innerHTML = `<span class="n">${c.name}</span>${badge}`;
      const v = c.holder.position.clone().project(cam);
      c.label.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      c.label.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight + 6}px`;
    }
    const approved = cells.filter((c) => APPROVED_ASSETS.objects[c.id]).length;
    hud.innerHTML = `${cells.length} objects &middot; ${approved} approved &middot; ` +
      (stale ? `<b style="color:#ffc76f">${stale} behind this profile</b>` : '<span style="color:#6fe3d0">all current</span>') +
      ` &middot; rev ${rev}`;
  };

  // ---- panels ---------------------------------------------------------------------------------

  let texPanel: TextureSettingsHandle | undefined;
  let profileBar: ProfileBarHandle | undefined;
  texPanel = buildTextureSettings({
    container: document.body,
    left: `${PANEL_L}px`,
    onChange: () => { void rebuildAll(); },
    header: (mount) => {
      profileBar = mountProfileBar({
        mount,
        initial: params.get('profile'),
        onApplied: () => { texPanel?.resync(); void rebuildAll(); },
      });
    },
    extras: [
      { label: 'Light ∠', get: () => lightRake.az, set: (v) => { lightRake.az = v; applyRake(); renderer.render(scene, cam); } },
      { label: 'Light ↑', get: () => lightRake.el, set: (v) => { lightRake.el = v; applyRake(); renderer.render(scene, cam); } },
    ],
  });
  void profileBar; // read via the closure above; kept for symmetry with lab.ts

  addEventListener('resize', () => { fitCamera(); syncLabels(); renderer.render(scene, cam); });
  fitCamera();
  syncLabels();
  renderer.render(scene, cam);

  // Static page: render on demand, not on a rAF loop. Nothing animates, and a still page is what
  // lets the preview pane and Playwright screenshot it without fighting a live canvas.
  (window as { __SHEET_READY?: boolean }).__SHEET_READY = true;
  void getConfig; // (kept: handy when debugging the live config from the console)
}

void main();
