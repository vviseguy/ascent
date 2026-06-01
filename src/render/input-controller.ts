// ============================================================================
// src/render/input-controller.ts — keyboard/mouse → PlayerInput (local play).
// ============================================================================
//
// Translates raw browser input into the sim's quantized, deterministic PlayerInput
// for ONE local player. This lives in the render/IO layer, NOT the sim: it produces
// the integer input the sim consumes. (Over the network, the netcode will sample
// this once per tick and ship it; locally we sample it each tick.)
//
// Controls (Overcooked-simple, matching docs/02 §1):
//   WASD / arrows : MOVE        Space : JUMP
//   J / LMB       : RUSH        K / RMB(hold) : GRAB (release = THROW)
//   L             : STRUGGLE (mash)
//   mouse move    : AIM (angle from screen center; good enough for local testing)
// ============================================================================

import { type PlayerInput, Button, MOVE_Q } from '../sim/world/input.ts';
import { toRaw, fromFloatConst } from '../sim/fixed/fixed.ts';

export class InputController {
  private keys = new Set<string>();
  private mouseDownL = false;
  private mouseDownR = false;
  private aimRaw = 0;
  private prevGrabHeld = false;

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
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const ang = Math.atan2(e.clientY - cy, e.clientX - cx); // screen-space aim
      this.aimRaw = toRaw(fromFloatConst(ang));
    });
  }

  private has(...k: string[]): boolean {
    return k.some((s) => this.keys.has(s));
  }

  /** Sample the current input as a deterministic PlayerInput for this tick. */
  sample(): PlayerInput {
    let mx = 0, mz = 0;
    if (this.has('a', 'arrowleft')) mx -= MOVE_Q;
    if (this.has('d', 'arrowright')) mx += MOVE_Q;
    if (this.has('w', 'arrowup')) mz -= MOVE_Q;
    if (this.has('s', 'arrowdown')) mz += MOVE_Q;

    let buttons = 0;
    if (this.has('j') || this.mouseDownL) buttons |= Button.Rush;
    const grabHeld = this.has('k') || this.mouseDownR;
    if (grabHeld) buttons |= Button.Grab;
    // release of grab = throw (edge: was held, now not)
    if (this.prevGrabHeld && !grabHeld) buttons |= Button.Throw;
    this.prevGrabHeld = grabHeld;
    if (this.has('l')) buttons |= Button.Struggle;
    if (this.has(' ')) buttons |= Button.Jump;

    return { moveX: mx, moveZ: mz, aim: this.aimRaw, buttons, grabTarget: -1 };
  }
}
