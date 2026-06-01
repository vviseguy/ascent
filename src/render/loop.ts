// ============================================================================
// src/render/loop.ts — the fixed-timestep game loop (sim 60Hz, render at vsync).
// ============================================================================
//
// Decouples the deterministic 60 Hz simulation from the display refresh rate using
// the classic accumulator pattern: wall-clock time (performance.now — allowed HERE,
// in the IO layer, NEVER in the sim) accumulates, and we run as many whole sim ticks
// as have "come due", then render once. This keeps the sim's tick cadence exact and
// engine-independent regardless of monitor Hz, while the renderer interpolates.
//
// A hard cap on ticks-per-frame prevents the "spiral of death" if the tab stalls
// (e.g. backgrounded): we drop simulated time rather than try to catch up forever.
// ============================================================================

import { TICK_HZ } from '../sim/world/step.ts';
import type { Sim } from '../sim/sim.ts';
import type { Renderer } from './renderer.ts';
import type { InputController } from './input-controller.ts';

const MS_PER_TICK = 1000 / TICK_HZ;
const MAX_TICKS_PER_FRAME = 5; // anti-spiral clamp

export interface LoopHandle {
  stop(): void;
  /** Ticks simulated so far (for HUD/debug). */
  readonly tick: () => number;
}

/**
 * Start the loop. `localPlayerId` is the body the local InputController drives; all
 * other player bodies receive neutral input (until the netcode supplies remotes).
 */
export function startLoop(
  sim: Sim,
  renderer: Renderer,
  input: InputController,
  localPlayerId: number,
): LoopHandle {
  let running = true;
  let acc = 0;
  let last = performance.now();
  // reusable input frame array sized to capacity (indices map to body ids)
  const frame: (ReturnType<InputController['sample']> | undefined)[] = new Array(sim.world.capacity);

  function frameTick(now: number): void {
    if (!running) return;
    let dt = now - last;
    last = now;
    if (dt > 250) dt = 250; // clamp huge gaps (tab was hidden)
    acc += dt;

    let steps = 0;
    while (acc >= MS_PER_TICK && steps < MAX_TICKS_PER_FRAME) {
      // sample local input fresh for this tick; others neutral (undefined)
      frame.fill(undefined);
      frame[localPlayerId] = input.sample();
      sim.advance(frame);
      acc -= MS_PER_TICK;
      steps++;
    }
    if (steps === MAX_TICKS_PER_FRAME) acc = 0; // shed backlog, don't spiral

    renderer.render(sim.world);
    requestAnimationFrame(frameTick);
  }
  requestAnimationFrame(frameTick);

  return {
    stop() { running = false; },
    tick: () => sim.world.tick,
  };
}
