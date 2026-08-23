// ============================================================================
// src/main.ts — ASCENT app entry point (playable sandbox).
// ============================================================================
//
// Wires the proven deterministic sim to the Three.js view + local input:
//   buildSandbox() → scene (arena + crew + Anchor + throwables + a crusher)
//   Renderer       → interpolated view + Anchor HUD + verb feedback (pure reader)
//   InputController → keyboard/mouse → the local player's deterministic input
//   startLoop      → fixed 60 Hz sim accumulator, render at vsync
//
// Single-player, single-machine slice exercising the ENTIRE integrated simulation
// (motion, collision, hazards, carry, all four verbs incl. JUMP, fall-damage). The
// netcode (src/net, proven headlessly) replaces the local-input frame with synced
// per-tick inputs across peers; the sim + renderer stay as-is (the determinism +
// canonicalized-input discipline is what makes that swap safe).
// ============================================================================

import { buildTower } from './game/scene.ts';
import { Renderer } from './render/renderer.ts';
import { InputController } from './render/input-controller.ts';
import { startLoop } from './render/loop.ts';
import type { GltfOpts } from './render/gltf-character.ts';
import { Role } from './sim/world/state.ts';

/**
 * The DEFAULT crew: KayKit Adventurers (CC0 chunky-stylized stocky humanoids), one model
 * per role so the crew reads distinctly. Loaded as a per-role set; the Anchor is gold-
 * tinted by the renderer. `yaw` faces the model's front to world +X.
 */
const KAYKIT_CREW: { role: number; url: string; opts?: GltfOpts }[] = [
  { role: Role.Runner, url: 'models/kaykit_rogue.glb', opts: { yaw: Math.PI / 2 } },
  { role: Role.Bulwark, url: 'models/kaykit_knight.glb', opts: { yaw: Math.PI / 2 } },
  { role: Role.Mender, url: 'models/kaykit_mage.glb', opts: { yaw: Math.PI / 2 } },
  { role: Role.Engineer, url: 'models/kaykit_knight.glb', opts: { yaw: Math.PI / 2 } },
  { role: Role.Breaker, url: 'models/kaykit_barbarian.glb', opts: { yaw: Math.PI / 2 } },
  { role: Role.Anchor, url: 'models/kaykit_knight.glb', opts: { yaw: Math.PI / 2 } },
];

/**
 * MODEL-STYLE overrides (`?model=NAME`): force the WHOLE crew to one model for comparison.
 * `?model=chibi` = the procedural stubby body. No param = the KayKit per-role crew above.
 */
const MODELS: Record<string, { url: string; opts?: GltfOpts; label: string }> = {
  // STOCKY HUMANOIDS — KayKit Adventurers (CC0, chunky stylized) — the on-ask style
  knight: { url: 'models/kaykit_knight.glb', opts: { yaw: Math.PI / 2 }, label: 'Knight — stocky humanoid (KayKit)' },
  barbarian: { url: 'models/kaykit_barbarian.glb', opts: { yaw: Math.PI / 2 }, label: 'Barbarian — stocky humanoid (KayKit)' },
  mage: { url: 'models/kaykit_mage.glb', opts: { yaw: Math.PI / 2 }, label: 'Mage — stocky humanoid (KayKit)' },
  rogue: { url: 'models/kaykit_rogue.glb', opts: { yaw: Math.PI / 2 }, label: 'Rogue — stocky humanoid (KayKit)' },
  // other styles (demo grab-bag)
  robot: { url: 'models/robot.glb', label: 'chunky cute robot' },
  xbot: { url: 'models/xbot.glb', opts: { yaw: Math.PI / 2 }, label: 'clean mannequin' },
  soldier: { url: 'models/soldier.glb', opts: { yaw: Math.PI / 2 }, label: 'realistic humanoid' },
  fox: { url: 'models/fox.glb', opts: { yaw: Math.PI / 2, scale: 0.8 }, label: 'low-poly animal' },
};
async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  app.appendChild(canvas);

  const params = new URLSearchParams(location.search);
  // Fresh match seed each load → the tower differs per session (the "same each load" fix).
  // In multiplayer this is the host's seed broadcast to peers; here we pick one at boot —
  // this is the setup/IO layer, NOT the deterministic sim loop, so Math.random is fine.
  // `?seed=N` pins the tower (reproducible screenshots / debugging); no param = random.
  const seedParam = params.get('seed');
  const seed = seedParam !== null
    ? BigInt(seedParam)
    : (BigInt(Math.floor(Math.random() * 0xffffffff)) << 21n) ^ BigInt(Math.floor(Math.random() * 0x1fffff)) ^ 0x9e3779b1n;
  // `?grid=N` sizes the stratum (cells/side) — smaller is easier to eyeball generation. No param =
  // the game default (GAME_GRID_SIZE). Use `?grid=15` for a quick, legible inspection map.
  const gridRaw = params.get('grid');
  const gridParam = gridRaw !== null ? Math.floor(Number(gridRaw)) : NaN;
  const gridSize = Number.isFinite(gridParam) && gridParam >= 4 ? gridParam : undefined;
  // The tower is built from the CELL model by default — authored structures, real staircases the
  // author drew. `?substrate=4u` selects the older tile lattice; see buildTower's note.
  const substrate = params.get('substrate') === '4u' ? '4u' as const : undefined;
  /* `?props=on` restores BOTH the scattered furniture (a render-layer scatter) and the breakable
     crates (real sim bodies). They were two separate switches, which is how a "bare" tower kept
     coming up with eight crates around the spawn. */
  const props = params.get('props') === 'on';
  const scene = buildTower({
    crewSize: 3, numStrata: 5, seed, props,
    ...(gridSize ? { gridSize } : {}),
    ...(substrate ? { substrate } : {}),
  });
  const renderer = new Renderer(canvas);
  // WORLD-STYLE: default to 'clean' (preferred); `?world=NAME` overrides.
  const worldName = params.get('world') ?? 'clean';
  renderer.setWorldStyle(worldName);
  // CHARACTERS (must finish before the loop so ensureVis stays synchronous / never mid-match):
  //   default        → the KayKit per-role crew set
  //   ?model=chibi   → the procedural stubby body
  //   ?model=NAME    → force the whole crew to one model (style comparison)
  const modelName = params.get('model') ?? '';
  const overlay = makeLoading();
  app.appendChild(overlay);
  // world geometry first (per-stratum base-Y → terrain bands), then async-load the assets.
  if (scene.stratumBaseY) renderer.setStrata(scene.stratumBaseY);
  renderer.buildTerrain(scene.sim.ctx.terrain);
  try {
    // CHARACTERS: default KayKit crew set · ?model=chibi procedural · ?model=NAME single
    if (modelName === 'chibi') { /* procedural — preload nothing */ }
    else if (MODELS[modelName]) await renderer.preloadModels(MODELS[modelName]!.url, MODELS[modelName]!.opts ?? {});
    else await renderer.preloadModelSet(KAYKIT_CREW);
    // KAYKIT DUNGEON environment (default on; `?dungeon=off` keeps the abstract tower view).
    /* PROPS OFF by default — `?props=on` brings back the scattered furniture and torches.
       They are placed by a deterministic per-cell scatter that was tuned for the 4u grid, and on a 2u
       one it strews four times as much of it across a floor with four times the cells. Until placement
       is something a structure ASKS for rather than something sprinkled over the map, off is the
       honest default. */
    const dressing = props;
    const torchEvery = substrate === '4u' ? 11 : 40;
    if (scene.cellGrid && params.get('dungeon') !== 'off') {
      await renderer.buildDungeon(scene.cellGrid, scene.stairs, { dressing, torchEvery });
    }
  } catch (e) {
    console.warn('[ascent] preload failed', e);
  }
  overlay.remove();
  renderer.attachHud(app);
  renderer.attachHotbar(app, scene.localCrew); // inventory hotbar + contextual hints (docs/11)
  const input = new InputController(canvas);
  const anchorId = scene.anchorIds[scene.localCrew]!;
  // DEV: expose the renderer for headless screenshot verification (camera pose etc.).
  // Gated to ?debug so no handle leaks into a normal session. View-only.
  if (params.has('debug')) (globalThis as Record<string, unknown>)['__renderer'] = renderer;
  startLoop(scene.sim, renderer, input, scene.localPlayerId, anchorId);

  app.appendChild(makeControlsLegend());
}

/** A centered overlay shown while character models preload (the KayKit crew is ~14 MB). */
function makeLoading(): HTMLElement {
  const o = document.createElement('div');
  o.style.cssText =
    'position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;' +
    'font:600 18px system-ui;color:#cdd;background:rgba(8,8,16,0.9);letter-spacing:.14em';
  o.textContent = 'LOADING CREW…';
  return o;
}

/** A small controls legend + framing line (bottom-left). */
function makeControlsLegend(): HTMLElement {
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:12px;bottom:12px;color:#cdd;font:13px/1.6 system-ui;' +
    'background:rgba(10,10,22,0.6);padding:10px 14px;border-radius:10px;pointer-events:none;' +
    'backdrop-filter:blur(4px);max-width:320px';
  hud.innerHTML =
    '<b style="letter-spacing:.08em">ASCENT</b> — sandbox<br>' +
    '<span style="opacity:.85">Get the <b style="color:#ffd23f">gold Anchor</b> high — its height is your score.</span><br>' +
    '<span style="opacity:.6">WASD move · <b>left-drag</b> look · <b>left-tap</b> interact ' +
    '(pick up / grab) · <b>right</b> throw / use · <b>wheel</b> or <b>1–5</b> hotbar · ' +
    '<b>Shift</b> dash · <b>E</b> ability · Space jump · Q recall/plant · L struggle · ' +
    '<b>Ctrl+wheel</b> / <b>− =</b> zoom · <b>middle-click</b> recenter</span>';
  return hud;
}

boot();
