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
// Controls (mouse-first, docs/02 §1 — this block IS the source of truth; keep the
// on-screen legend in main.ts in sync with it):
//   WASD / arrows : MOVE              Space : JUMP
//   LMB (hold)    : GRAB → release = THROW        (K = keyboard fallback)
//   RMB           : hold = RUSH · short tap = ROLE ABILITY (sim splits them;
//                   J = keyboard fallback, E = explicit ability)
//   F             : SHOVE (empty-hand throw tap; keyboard only)
//   L             : STRUGGLE (mash)   Q : Anchor plants beacon · crew recalls
//   mouse         : AIM — resolved to the local player's floor plane (see loop.ts)
//   wheel / MMB-drag : camera ZOOM / PAN — VIEW-ONLY, never enters PlayerInput
// ============================================================================

import { type PlayerInput, Button, MOVE_Q } from '../sim/world/input.ts';

export class InputController {
  private keys = new Set<string>();
  private mouseDownL = false;
  private mouseDownR = false;
  // --- VIEW-ONLY camera control state (wheel zoom + middle-drag pan) ---------
  // Tracked alongside the other listeners but NEVER included in sample(): camera
  // framing is per-client cosmetic state — if it entered PlayerInput it would have
  // to be synced and would desync rollback (CLAUDE.md determinism rule). The loop
  // consumes these once per frame via takeViewDeltas() and feeds the renderer only.
  private mouseDownM = false;
  private wheelAcc = 0;
  private panAccX = 0;
  private panAccY = 0;
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
      // middle button starts a camera pan; preventDefault so the browser's
      // autoscroll icon never appears over the playfield.
      if (e.button === 1) { this.mouseDownM = true; e.preventDefault(); }
      if (e.button === 2) this.mouseDownR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDownL = false;
      if (e.button === 1) this.mouseDownM = false;
      if (e.button === 2) this.mouseDownR = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      // accumulate middle-drag pan pixels (window-level so a drag survives leaving
      // the canvas); consumed per frame by takeViewDeltas().
      if (this.mouseDownM) { this.panAccX += e.movementX; this.panAccY += e.movementY; }
    });
    // wheel ZOOM (view-only): accumulate deltaY; preventDefault stops page scroll /
    // browser pinch-zoom. passive:false is required for preventDefault to work.
    target.addEventListener('wheel', (e) => {
      this.wheelAcc += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  private has(...k: string[]): boolean {
    return k.some((s) => this.keys.has(s));
  }

  /**
   * Consume this frame's VIEW-ONLY camera deltas (wheel zoom + middle-drag pan).
   * Deliberately a separate channel from sample(): these drive the renderer's
   * camera rig and must never reach PlayerInput / the deterministic sim.
   */
  takeViewDeltas(): { wheel: number; panDX: number; panDY: number } {
    const out = { wheel: this.wheelAcc, panDX: this.panAccX, panDY: this.panAccY };
    this.wheelAcc = 0;
    this.panAccX = 0;
    this.panAccY = 0;
    return out;
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

    // Simplified mouse-first scheme (a pure level report — the SIM derives tap-vs-hold
    // from how long a button is held, so edge/duration logic stays deterministic):
    //   LEFT  = GRAB  (hold to carry & charge, release to throw; empty tap = shove/use)
    //   RIGHT = RUSH on hold, ROLE ABILITY on a short tap (sim splits them)
    // Keyboard fallbacks keep the old keys working for testing.
    let buttons = 0;
    if (this.mouseDownL || this.has('k')) buttons |= Button.Grab;
    if (this.has('f')) buttons |= Button.Throw; // explicit empty-hand shove (keyboard)
    if (this.mouseDownR || this.has('j')) buttons |= Button.RightHold; // sim: tap→ability, hold→rush
    if (this.has('l')) buttons |= Button.Struggle;
    if (this.has(' ')) buttons |= Button.Jump;
    if (this.has('e')) buttons |= Button.Ability; // explicit ability (keyboard)
    if (this.has('q')) buttons |= Button.Recall; // Anchor: plant beacon · others: recall

    return { moveX: mx, moveZ: mz, aim: this.aimRaw, buttons, grabTarget: -1 };
  }
}
