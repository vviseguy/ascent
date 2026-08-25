// ============================================================================
// src/render/first-person.ts — the EYE-LEVEL INSPECTION camera (`?cam=fp`).
// ============================================================================
//
// THIS IS NOT A GAMEPLAY CAMERA, AND IT MUST NEVER BECOME ONE.
//
// `docs/06-art-direction-shaders.md` §1.2 locks the camera by bible pillar 7: a
// slight-tilt top-down / Hades three-quarter, FOV ~38-45°, pitch ~35-50°. That lock
// stands. What this file adds is an INSPECTION INSTRUMENT: a way to stand a virtual
// eye in the built world and look at a wall from 40 cm, because the only other places
// a surface can be examined are the asset lab (one object, one turntable, no context)
// and the game camera (never closer than a few metres, and always looking down).
// Relief, per-texel roughness, AO and per-group variation all have to hold up at eye
// level in the REAL world, and until now nothing could show that.
//
// So it is reachable ONLY by URL flag, it is never wired into the UI, and it does not
// change the default camera. See docs/06 §1.2's "Inspection exception" note.
//
// WHAT IT IS ALLOWED TO TOUCH
//   Nothing in the sim. This is `src/render/` — the view layer reads the sim and never
//   writes it (root CLAUDE.md, "The two sides"). Mouse-look is a view-layer input: it
//   moves where the camera SITS and where it POINTS, and nothing else. Movement is
//   untouched — no new keys, no changes to how a body walks.
//
//   The one field it writes outside itself is `InputController.focusYaw`, which is
//   already declared VIEW-ONLY there and is already written by the left-drag orbit.
//   It has to: the shipped control scheme is "WASD is relative to where the camera
//   looks", so a look direction that did NOT update focusYaw would leave the camera
//   and the control frame disagreeing — a bug introduced by the camera, not avoided
//   by it. The sim still receives canonical world-space move exactly as before.
//   PITCH is deliberately NOT shared: `focusPitch` is a top-down INCLINATION clamped
//   to [3°, 85°] and cannot look up, so the eye keeps its own pitch.
//
// GETTING IN AND OUT
//   `?cam=fp`      boot straight into the eye.
//   click the view acquire pointer lock (the click lands on our own veil, never on
//                  the canvas, so it can never become a sim interact).
//   Esc            release the pointer (browser-native). The eye stays where it is.
//   Esc again      leave the eye entirely, back to the shipped top-down rig.
//   V              toggle the eye on/off at any time (only bound when the flag is on).
// ============================================================================

import type { InputController } from './input-controller.ts';

/**
 * Where the eye looks. Radians. `yaw` shares the renderer's focus-yaw convention
 * (forward = (−sin yaw, −cos yaw), so yaw 0 looks −Z); `pitch` is 0 at the horizon and
 * positive looking UP — deliberately NOT the renderer's top-down inclination.
 */
export interface EyeCam {
  readonly yaw: number;
  readonly pitch: number;
}

const DEG = Math.PI / 180;
/** Look per pixel of pointer movement (rad/px) — a middling, unaccelerated FPS feel. */
const SENS = 0.0022;
/** Just short of straight up / straight down, so the horizon can never flip over. */
const PITCH_LIMIT = 88 * DEG;

/**
 * The eye-level inspection camera's INPUT half: pointer lock, mouse-look, and the two
 * bits of chrome that say how to get in and out. The renderer's half is `setEyeCam`.
 */
export class FirstPersonView {
  /** Is the eye the active camera? (The flag boots this true; V toggles it.) */
  private on = false;
  /** Does the pointer currently belong to us? */
  private locked = false;
  /** Eye pitch (rad, + = up). Yaw lives on `input.focusYaw` — see the header. */
  private pitch = 0;

  private readonly canvas: HTMLElement;
  private readonly input: InputController;
  /** Click-to-look catcher. Shown only while the eye is on and the pointer is free —
   *  so the click that acquires the lock never reaches the canvas, and therefore never
   *  reaches `InputController` as a PRIMARY tap. */
  private readonly veil: HTMLElement;
  private readonly badge: HTMLElement;

  constructor(canvas: HTMLElement, input: InputController, host: HTMLElement) {
    this.canvas = canvas;
    this.input = input;

    this.veil = document.createElement('div');
    this.veil.style.cssText =
      'position:fixed;inset:0;z-index:20;display:none;align-items:flex-end;justify-content:center;'
      + 'padding-bottom:22vh;cursor:crosshair;font:600 14px/1.6 system-ui;color:#cdd;'
      + 'letter-spacing:.1em;background:transparent';
    this.veil.innerHTML =
      '<span style="background:rgba(10,10,22,.78);padding:10px 18px;border-radius:12px;'
      + 'backdrop-filter:blur(6px)">CLICK TO LOOK</span>';
    this.veil.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    this.veil.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      void (this.canvas as HTMLElement & { requestPointerLock(): unknown }).requestPointerLock();
    });
    host.appendChild(this.veil);

    this.badge = document.createElement('div');
    this.badge.style.cssText =
      'position:fixed;left:12px;top:12px;z-index:21;font:12px/1.5 system-ui;color:#ffb24f;'
      + 'background:rgba(10,10,22,.72);padding:8px 12px;border-radius:10px;pointer-events:none;'
      + 'backdrop-filter:blur(6px);display:none;max-width:280px';
    this.badge.innerHTML =
      '<b style="letter-spacing:.1em">FIRST PERSON</b> — inspection only<br>'
      + '<span style="opacity:.75;color:#cdd">click look · <b>Esc</b> release pointer · '
      + '<b>Esc</b> again or <b>V</b> back to the game camera</span>';
    host.appendChild(this.badge);

    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** The eye's current pose, or null when the shipped top-down rig should be used. */
  pose(): EyeCam | null {
    return this.on ? { yaw: this.input.focusYaw, pitch: this.pitch } : null;
  }

  /** Enter the eye. Levels the pitch, because looking at the horizon is the whole point. */
  enable(): void {
    if (this.on) return;
    this.on = true;
    this.pitch = 0;
    this.syncChrome();
  }

  /** Leave the eye; the shipped top-down rig resumes from the same focus yaw. */
  disable(): void {
    if (!this.on) return;
    this.on = false;
    if (this.locked) document.exitPointerLock();
    this.syncChrome();
  }

  toggle(): void { if (this.on) this.disable(); else this.enable(); }

  /**
   * DEV (`?debug` exposes this as `window.__fp`): aim the eye directly, in radians.
   *
   * The headless snapper has no pointer to lock and no mouse to move, so without this
   * the one thing the mode exists for — a wall at eye level, in a PNG, in CI or in an
   * agent's hands — could not be captured at all. Same view-only path as mouse-look.
   */
  look(yaw: number, pitch: number): void {
    this.input.focusYaw = yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  /** DEV: hide the mode's own chrome, so a screenshot shows the world and nothing else. */
  setChromeVisible(on: boolean): void {
    this.badge.style.visibility = on ? 'visible' : 'hidden';
    this.veil.style.visibility = on ? 'visible' : 'hidden';
  }

  /** Detach every listener + node (tests / teardown; the app itself never calls this). */
  dispose(): void {
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    this.veil.remove();
    this.badge.remove();
  }

  // --- listeners (arrow properties so removeEventListener can find them) ------

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    this.syncChrome();
  };

  /**
   * MOUSE-LOOK. `movementX/Y` is the pointer-lock delta, in pixels, already free of any
   * screen edge. Right is +X and DOWN is +Y, while yaw increases turning LEFT (forward =
   * (−sin yaw, −cos yaw), so d(forward)/d(yaw) = −right) and pitch increases looking UP —
   * hence both are subtracted, giving a conventional non-inverted feel.
   */
  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.on || !this.locked) return;
    this.input.focusYaw -= e.movementX * SENS;
    this.pitch -= e.movementY * SENS;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
  };

  /**
   * Esc and V, and nothing else.
   *
   * While the pointer is locked the browser eats Esc to release it and never dispatches
   * the keydown, so the FIRST Esc always frees the mouse and the SECOND — which does
   * reach us — leaves the mode. That is the "Escape gets out cleanly" contract: one
   * press to get your cursor back, a second to get your game camera back.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.on && !this.locked) { this.disable(); e.preventDefault(); }
      return;
    }
    if (e.key === 'v' || e.key === 'V') this.toggle();
  };

  private syncChrome(): void {
    this.badge.style.display = this.on ? 'block' : 'none';
    this.veil.style.display = this.on && !this.locked ? 'flex' : 'none';
  }
}
