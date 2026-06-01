// ============================================================================
// src/main.ts — ASCENT app entry point (playable sandbox).
// ============================================================================
//
// Wires the proven deterministic sim to the Three.js view + local input:
//   buildSandbox() → a scene (arena + crew + Anchor + throwables + a crusher)
//   Renderer       → draws the sim each frame (pure reader)
//   InputController → keyboard/mouse → the local player's deterministic input
//   startLoop      → fixed 60 Hz sim accumulator, render at vsync
//
// This is the single-player, single-machine slice: it exercises the ENTIRE
// integrated simulation (motion, collision, hazards, carry, all four verbs,
// fall-damage) live and on-screen. The netcode (src/net) will later replace the
// "local input only" frame with synchronized per-tick inputs across peers — the
// sim and renderer stay exactly as they are (that's the payoff of the determinism
// discipline). See docs/ROADMAP.md.
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
  const input = new InputController(canvas);
  startLoop(scene.sim, renderer, input, scene.localPlayerId);

  app.appendChild(makeHud());
}

/** A tiny on-screen controls overlay so the sandbox is self-explanatory. */
function makeHud(): HTMLElement {
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:12px;bottom:12px;color:#cdd;font:13px/1.5 system-ui;' +
    'background:rgba(10,10,22,0.6);padding:10px 14px;border-radius:10px;pointer-events:none;' +
    'backdrop-filter:blur(4px)';
  hud.innerHTML =
    '<b style="letter-spacing:.08em">ASCENT</b> — sandbox<br>' +
    '<span style="opacity:.7">' +
    'WASD move · mouse aim · J/LMB rush · K/RMB hold grab (release = throw) · L struggle · Space jump' +
    '</span>';
  return hud;
}

boot();
