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

import { buildSandbox } from './game/scene.ts';
import { Renderer } from './render/renderer.ts';
import { InputController } from './render/input-controller.ts';
import { startLoop } from './render/loop.ts';

function boot(): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  app.appendChild(canvas);

  const scene = buildSandbox(3);
  const renderer = new Renderer(canvas);
  renderer.buildTerrain(scene.sim.ctx.terrain);
  renderer.attachHud(app);
  const input = new InputController(canvas);
  startLoop(scene.sim, renderer, input, scene.localPlayerId, scene.anchorId);

  app.appendChild(makeControlsLegend());
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
    '<span style="opacity:.6">WASD move · mouse aim · J rush · <b>hold K</b> to grab, ' +
    '<b>release K</b> to throw (hold charges) · F shove · L struggle · Space jump</span>';
  return hud;
}

boot();
