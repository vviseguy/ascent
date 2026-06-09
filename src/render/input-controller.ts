// ============================================================================
// src/render/input-controller.ts — keyboard/mouse → PlayerInput (local play).
// ============================================================================
//
// Translates raw browser input into the sim's quantized PlayerInput for ONE local
// player. CRITICAL design rule (learned from the audit): this is a PURE LEVEL
// REPORTER — it reports which buttons are currently DOWN this instant and never
// computes press/release EDGES itself. All edge detection (grab-release = throw,
// jump press-edge, etc.) happens deterministically inside the sim via `prevButtons`.
// Computing edges here would (a) couple edge semantics to frame pacing — in a
// multi-tick catch-up frame every tick would see identical live input and an edge
// would land on the wrong tick — and (b) desync the moment this feeds rollback.
//
// Controls (Overcooked-simple, docs/02 §1):
//   WASD / arrows : MOVE              Space : JUMP
//   J / LMB       : RUSH              K / RMB (hold) : GRAB → release = THROW
//   F             : SHOVE (empty-hand throw tap)
//   L             : STRUGGLE (mash)
//   mouse         : AIM — resolved to a WORLD ground-plane angle (see loop.ts)
// ============================================================================

import { type PlayerInput, Button, MOVE_Q } from '../sim/world/input.ts';

export class InputController {
  private keys = new Set<string>();
  private mouseDownL = false;
  private mouseDownR = false;
  /** Latest cursor position in screen pixels (resolved to a world aim in the loop). */
  mouseX = 0;
  mouseY = 0;
  /** The world-space aim angle (raw Fixed) the loop computes each frame and stores here. */
  aimRaw = 0;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (e.key === ' ') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDownL = true;
      if (e.button === 2) this.mouseDownR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDownL = false;
      if (e.button === 2) this.mouseDownR = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
  }

  private has(...k: string[]): boolean {
    return k.some((s) => this.keys.has(s));
  }

  /**
   * Sample current input as a PlayerInput for this tick — a pure projection of live
   * key/mouse state (no edge computation, no internal mutation that affects output).
   * `aimRaw` is set by the loop from a ground-plane raycast before this is read.
   */
  sample(): PlayerInput {
    let mx = 0, mz = 0;
    if (this.has('a', 'arrowleft')) mx -= MOVE_Q;
    if (this.has('d', 'arrowright')) mx += MOVE_Q;
    if (this.has('w', 'arrowup')) mz -= MOVE_Q;
    if (this.has('s', 'arrowdown')) mz += MOVE_Q;

    let buttons = 0;
    if (this.has('j') || this.mouseDownL) buttons |= Button.Rush;
    if (this.has('k') || this.mouseDownR) buttons |= Button.Grab; // hold to grab/charge; sim throws on release
    if (this.has('f')) buttons |= Button.Throw; // empty-hand shove tap (sim edge-detects)
    if (this.has('l')) buttons |= Button.Struggle;
    if (this.has(' ')) buttons |= Button.Jump;
    if (this.has('e')) buttons |= Button.Ability; // role ability (revive/unhand/bridge/…)
    if (this.has('q')) buttons |= Button.Recall; // Anchor: plant beacon · others: recall

    return { moveX: mx, moveZ: mz, aim: this.aimRaw, buttons, grabTarget: -1 };
  }
}
