// ============================================================================
// src/render/loop.ts — the fixed-timestep game loop (sim 60Hz, render at vsync).
// ============================================================================
//
// Classic accumulator: wall-clock (performance.now — allowed HERE in the IO layer,
// NEVER in the sim) accumulates and we run whole sim ticks as they come due, then
// render once with an interpolation alpha. The sim cadence stays exact and engine-
// independent regardless of display Hz.
//
// Input is sampled ONCE PER RENDERED FRAME (not per tick) and the SAME PlayerInput
// drives every tick in a multi-tick catch-up frame — so the sim's deterministic
// edge detection (prevButtons) sees clean transitions and edge semantics never
// couple to frame pacing (audit `multitick-frame-sample-couples-edges-to-pacing`).
// The local input is CANONICALIZED through the wire codec before the sim sees it,
// so the single-player path simulates exactly what a networked peer would decode
// (audit `canonicalize-missing-in-local-path`).
//
// NOTE: on a stall this caps catch-up for responsiveness in SINGLE-PLAYER only.
// A networked session must instead surrender catch-up to the rollback clock-sync
// (never silently drop owed ticks); that path lives in the netcode loop, not here.
// ============================================================================

import { TICK_HZ } from '../sim/world/step.ts';
import type { Sim } from '../sim/sim.ts';
import type { Renderer } from './renderer.ts';
import type { InputController } from './input-controller.ts';
import { canonicalizeInput } from '../net/wire.ts';
import { fromRaw, toFloat } from '../sim/fixed/fixed.ts';

const MS_PER_TICK = 1000 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 5;

export interface LoopHandle { stop(): void; readonly tick: () => number; }

export function startLoop(
  sim: Sim,
  renderer: Renderer,
  input: InputController,
  localPlayerId: number,
  anchorId: number,
): LoopHandle {
  let running = true;
  let acc = 0;
  let last = performance.now();
  const frame: (ReturnType<InputController['sample']> | undefined)[] = new Array(sim.world.capacity);

  function frameTick(now: number): void {
    if (!running) return;
    let dt = now - last; last = now;
    if (dt > 250) dt = 250;
    acc += dt;

    // Resolve world-space aim from the cursor against the LOCAL PLAYER'S floor plane
    // (their feet Y = py − halfHeight, floats fine in the view layer). Aiming against
    // terrain.groundY — the deep slab ≈ 14 u below the playfield — skewed every aim
    // up-screen by floors of height (GAPS C7).
    const w = sim.world;
    const lx = toFloat(fromRaw(w.px[localPlayerId]!)), lz = toFloat(fromRaw(w.pz[localPlayerId]!));
    const standY = toFloat(fromRaw(w.py[localPlayerId]!)) - toFloat(fromRaw(w.halfHeight[localPlayerId]!));
    input.aimRaw = renderer.worldAimFrom(input.mouseX, input.mouseY, lx, lz, standY);

    // Sample ONCE per frame; canonicalize; feed the same input to every tick this frame.
    const localInput = canonicalizeInput(input.sample());

    // USER CAMERA controls (wheel zoom / middle-drag pan / recenter-on-move): these
    // deltas + the local player's live motion feed ONLY the renderer's view rig.
    // They are deliberately outside PlayerInput — camera state is per-client
    // cosmetic and must never touch the deterministic sim.
    const vd = input.takeViewDeltas();
    renderer.setViewControls(
      vd.wheel, vd.panDX, vd.panDY,
      localInput.moveX !== 0 || localInput.moveZ !== 0,
      toFloat(fromRaw(w.facing[localPlayerId]!)),
      Math.hypot(toFloat(fromRaw(w.vx[localPlayerId]!)), toFloat(fromRaw(w.vz[localPlayerId]!))),
    );

    let steps = 0;
    while (acc >= MS_PER_TICK && steps < MAX_TICKS_PER_FRAME) {
      frame.fill(undefined);
      frame[localPlayerId] = localInput;
      sim.advance(frame);
      renderer.commitTick(w); // snapshot positions for interpolation
      acc -= MS_PER_TICK;
      steps++;
    }
    if (steps === MAX_TICKS_PER_FRAME) acc = 0; // single-player anti-spiral only

    // push live standing/win to the HUD (committed Anchor height = the score) +
    // every crew's height for the standings rail + the win target.
    const localCrew = w.crewId[anchorId]!;
    const cs = sim.match.crews[localCrew];
    renderer.standing = {
      committed: cs ? cs.committed / 65536 : 0,
      winner: sim.match.winner,
      localCrew,
      crews: sim.match.crews.map((c) => c.committed / 65536),
      target: sim.match.cfg.targetHeight / 65536,
    };

    const alpha = Math.max(0, Math.min(1, acc / MS_PER_TICK));
    renderer.render(w, alpha, localPlayerId, anchorId);
    requestAnimationFrame(frameTick);
  }
  requestAnimationFrame(frameTick);

  return { stop() { running = false; }, tick: () => sim.world.tick };
}
