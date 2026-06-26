// ============================================================================
// src/render/input-controller.ts — keyboard/mouse → PlayerInput (local play).
// ============================================================================
//
// Translates raw browser input into the sim's quantized PlayerInput for ONE local
// player. PURE LEVEL REPORTER for the buttons (no edge detection here — the sim does
// that via prevButtons). The MOVE + AIM are FOCUS-RELATIVE (docs/11): WASD is in the
// camera's focus frame, and the body facing reorients toward forward as you move. The
// focus heading is VIEW-ONLY state — it only shapes how this client forms its input;
// the sim still receives canonical WORLD-space move + aim, so determinism is intact.
//
// CONTROL SCHEME (docs/11 — the controls + interaction reference):
//   WASD / arrows  : MOVE relative to the camera focus (W = up the screen)
//   left-DRAG horiz: orbit the focus + camera yaw (Minecraft look; replaces the old
//                    edge-hold pan). Sign FLIPPED (2026-06 feel pass): drag right → focus left.
//   left-DRAG vert : tilt the camera INCLINATION (pitch); clamped (docs/11 §2)
//   left-TAP       : PRIMARY interact (contextual; sim resolves pickup/place/use/grab)
//   right          : SECONDARY interact (contextual; throw held body/item, open)
//   wheel          : camera ZOOM        Shift+wheel : hotbar slot select
//   1–5            : direct hotbar slot select
//   Shift          : (unbound — Rush disabled for now)   E : role ABILITY
//   Space jump · L struggle · Q recall/plant · middle-click recenter focus
//
// CONTEXTUAL BODY MAPPING (determinism-safe — still canonical world-space output):
// the contextual PRIMARY/SECONDARY are reported as Button.Primary/Secondary for the
// sim's interact system (items + open). For BODY carry/throw — owned by the proven
// verb layer off Button.Grab/Throw — this controller ALSO sets those bits based on the
// local player's CONTEXT (carrying a body? targeting a grabbable?), which the loop
// reads from the sim each frame and passes into sample(). That keeps the carry state
// machine in one place (verbs) while the new buttons drive it.
// ============================================================================

import { type PlayerInput, Button, MOVE_Q, NO_SLOT, NUM_SLOTS } from '../sim/world/input.ts';
import { InteractAction } from '../sim/interact/model.ts';

const TWO_PI = Math.PI * 2;
const FIXED_ONE = 65536; // Q16.16 scale: aim is a raw Fixed angle (view-layer float→raw is fine)
// --- focus-relative control tunables (docs/11 §8) ---
const DEG = Math.PI / 180;
const FACE_TURN_RATE = 7.0;    // /s facing lerp toward forward while moving fwd/back
const FOCUS_SNAP_RATE = 16.0;  // /s focus lerp toward movement on middle-click
const DRAG_DEADZONE_PX = 6;    // left-drag distance below which a press is a TAP, not a pan
const TAP_MAX_MS = 250;        // max left-press duration that still counts as a tap
const DRAG_PAN_RATE = 3.0;     // focus yaw (rad) per one screen-width of horizontal drag
const PITCH_DRAG_RATE = 1.4;   // camera pitch (rad) per one screen-height of vertical drag
const PITCH_MIN = 3 * DEG;     // shallowest inclination (near-horizontal, almost ground level)
const PITCH_MAX = 85 * DEG;    // steepest inclination (near top-down)
const DEFAULT_PITCH = Math.atan2(0.951, 0.309); // ≈72° — matches renderer CAM_SIN55/COS55

/**
 * The local player's CONTEXTUAL state, read from the sim by the loop each frame and
 * passed into sample(). Lets the IO layer map the contextual PRIMARY/SECONDARY onto the
 * existing body verbs (Grab/Throw) without duplicating the carry state machine.
 */
export interface InteractCtx {
  /** Is the local player carrying a body right now? (w.holding[local] !== NO_ENTITY) */
  carryingBody: boolean;
  /** Is an item in the active hotbar slot? */
  holdingItem: boolean;
  /** The sim's available-actions bitfield for the local player (w.targetActions[local]). */
  actions: number;
}

const NEUTRAL_CTX: InteractCtx = { carryingBody: false, holdingItem: false, actions: 0 };

export class InputController {
  private keys = new Set<string>();
  private mouseDownL = false;
  private mouseDownR = false;
  /** Shift+wheel accumulator (hotbar scroll); plain wheel routes to zoom instead. */
  private wheelHotbar = 0;
  private wheelZoom = 0;
  /** Pending direct slot select from 1–5 (or NO_SLOT). Consumed once per sample. */
  private pendingSlot = NO_SLOT;
  /** Latest cursor position in screen pixels. */
  mouseX = 0;
  mouseY = 0;
  /** VIEW-ONLY camera heading (radians); WASD + the camera orbit are relative to it.
   *  Default π so the OPENING view looks +Z — INTO the dungeon. The crew spawns on the
   *  entry row at the floor's −Z edge and the rooms extend toward +Z; a focusYaw-0 (look
   *  −Z) opening framed the perimeter wall / void behind the player → an all-black screen
   *  (boss #1/#2). At π, "W" also walks the player forward INTO the dungeon, as expected. */
  focusYaw = Math.PI;
  /** VIEW-ONLY camera INCLINATION (pitch, radians); left-drag vertical tilts it (docs/11 §2).
   *  Default ≈72° matches the renderer's shipped pitch; clamped to [PITCH_MIN, PITCH_MAX]. */
  focusPitch = DEFAULT_PITCH;
  /** Smoothed body facing (world radians); turns toward forward when moving fwd/back. */
  private bodyAim = Math.PI / 2; // forward at focusYaw π (= +Z, up the screen / into the dungeon)
  /** Pending middle-click focus-snap target, or null. */
  private snapTarget: number | null = null;
  private snapPending = false;
  /** Kept for API compat (aim is now derived from movement, not a cursor raycast). */
  aimRaw = 0;

  // --- left-button TAP-vs-DRAG tracking (docs/11 §7.1) ---
  /** Wall-clock ms the left button went down, or -1. */
  private lDownMs = -1;
  /** Cursor X at left-press (drag origin). */
  private lDownX = 0;
  private lDownY = 0;
  /** Accumulated drag pixels since last consumed: horizontal drives yaw, vertical drives pitch. */
  private dragDX = 0;
  private dragDY = 0;
  /** Did the current left-press exceed the drag threshold (→ it's a pan, not a tap)? */
  private isDragging = false;
  /** Latched: a completed TAP (press+release under threshold) to emit as PRIMARY for one tick. */
  private tapPending = false;
  /**
   * GRAB-HOLD window: a tap-to-grab needs Grab HELD for the verb latch (up to ~22 ticks
   * for the Anchor). On a primary tap onto a grabbable body we hold Grab for this many
   * sampled frames, cancelled early once carrying begins. ~36 frames ≈ 0.6 s covers the
   * longest latch with margin. View-only; the SIM is the authority on whether it latches.
   */
  private grabHoldFrames = 0;
  private static readonly GRAB_HOLD_WINDOW = 36;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (e.key === ' ') e.preventDefault();
      // direct hotbar slot select on 1–5 (number-row press edge).
      if (k >= '1' && k <= '5') this.pendingSlot = Math.min(NUM_SLOTS - 1, Number(k) - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDownL = true;
        this.lDownMs = nowMs();
        this.lDownX = e.clientX; this.lDownY = e.clientY;
        this.isDragging = false;
      }
      if (e.button === 1) { this.snapPending = true; e.preventDefault(); } // middle = recenter focus
      if (e.button === 2) this.mouseDownR = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        // a short press that never passed the drag deadzone is a TAP → PRIMARY interact.
        if (!this.isDragging && this.lDownMs >= 0 && nowMs() - this.lDownMs <= TAP_MAX_MS) {
          this.tapPending = true;
        }
        this.mouseDownL = false;
        this.lDownMs = -1;
        this.isDragging = false;
      }
      if (e.button === 2) this.mouseDownR = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      const px = e.clientX, py = e.clientY;
      // while the left button is held, accumulate drag; once it passes the deadzone the
      // press becomes a PAN (and can never retroactively become a tap).
      if (this.mouseDownL) {
        const totalDX = px - this.lDownX, totalDY = py - this.lDownY;
        if (!this.isDragging && Math.hypot(totalDX, totalDY) > DRAG_DEADZONE_PX) this.isDragging = true;
        if (this.isDragging) { this.dragDX += px - this.mouseX; this.dragDY += py - this.mouseY; }
      }
      this.mouseX = px; this.mouseY = py;
    });
    target.addEventListener('wheel', (e) => {
      // plain wheel = camera zoom; Shift+wheel = hotbar slot scroll (docs/11 §7.5).
      if (e.shiftKey) this.wheelHotbar += e.deltaY;
      else this.wheelZoom += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  private has(...k: string[]): boolean { return k.some((s) => this.keys.has(s)); }

  /** Raw stick intent in the focus frame: forward (W−S) and right (D−A), each in −1..1. */
  private stick(): { fwd: number; right: number } {
    let fwd = 0, right = 0;
    if (this.has('w', 'arrowup')) fwd += 1;
    if (this.has('s', 'arrowdown')) fwd -= 1;
    if (this.has('d', 'arrowright')) right += 1;
    if (this.has('a', 'arrowleft')) right -= 1;
    return { fwd, right };
  }

  /** Camera-forward / camera-right ground directions for the current focus yaw. */
  private forwardDir(): { x: number; z: number } { return { x: -Math.sin(this.focusYaw), z: -Math.cos(this.focusYaw) }; }
  private rightDir(): { x: number; z: number } { return { x: Math.cos(this.focusYaw), z: -Math.sin(this.focusYaw) }; }

  /**
   * Advance the view-layer focus heading + inclination + body-facing reorientation
   * (docs/11 §2). `dt` seconds. Call once per frame (after the cursor is current) BEFORE
   * sample(). Tilt/pan is ACTIVE-DRAG (left-drag horizontal = yaw, vertical = pitch).
   */
  updateFocus(dt: number, screenW: number, screenH: number): void {
    const { fwd, right } = this.stick();
    const f = this.forwardDir(), r = this.rightDir();
    const mx = f.x * fwd + r.x * right, mz = f.z * fwd + r.z * right;
    const moving = mx !== 0 || mz !== 0;

    // middle-click → snap focus to the current movement direction ("look where I go")
    if (this.snapPending) {
      this.snapPending = false;
      if (moving) this.snapTarget = Math.atan2(-mx, -mz); // yaw s.t. forwardDir aligns with move
    }
    if (this.snapTarget !== null) {
      this.focusYaw = lerpAngle(this.focusYaw, this.snapTarget, 1 - Math.exp(-FOCUS_SNAP_RATE * dt));
      if (Math.abs(angDiff(this.focusYaw, this.snapTarget)) < 0.01) this.snapTarget = null;
    }

    // ACTIVE DRAG-ORBIT (docs/11 §2): horizontal drag pixels swing the focus YAW, one
    // full screen-width = DRAG_PAN_RATE radians. Sign FLIPPED (2026-06 feel pass): drag
    // right swings the focus left. Consumed each frame.
    if (this.dragDX !== 0 && screenW > 0) {
      this.focusYaw -= (this.dragDX / screenW) * DRAG_PAN_RATE;
      this.dragDX = 0;
    }
    // vertical drag tilts the camera INCLINATION (pitch): drag DOWN → more top-down, drag
    // UP → toward the horizon. One full screen-height = ±PITCH_DRAG_RATE rad, clamped so
    // the view never flips past top-down or below the horizon floor.
    if (this.dragDY !== 0 && screenH > 0) {
      this.focusPitch += (this.dragDY / screenH) * PITCH_DRAG_RATE;
      if (this.focusPitch < PITCH_MIN) this.focusPitch = PITCH_MIN;
      if (this.focusPitch > PITCH_MAX) this.focusPitch = PITCH_MAX;
      this.dragDY = 0;
    }

    // body facing gently reorients toward FORWARD when moving fwd/back (not pure strafe)
    if (fwd !== 0) {
      const fwdAngle = Math.atan2(f.z, f.x);
      this.bodyAim = lerpAngle(this.bodyAim, fwdAngle, 1 - Math.exp(-FACE_TURN_RATE * dt));
    }
  }

  /** Consume this frame's VIEW-ONLY camera deltas (plain-wheel zoom only; pan/tilt is sim-free). */
  takeViewDeltas(): { wheel: number; panDX: number; panDY: number } {
    const out = { wheel: this.wheelZoom, panDX: 0, panDY: 0 };
    this.wheelZoom = 0;
    return out;
  }

  /**
   * Consume this frame's hotbar SLOT selection (a sim input field): a direct 1–5 press
   * takes precedence; otherwise a Shift+wheel scrolls the selection by ±1 (wrapping).
   * `curSlot` is the local player's current selected slot (from the sim) so wheel-scroll
   * is relative to it. Returns NO_SLOT when nothing changed this frame.
   */
  private takeSlot(curSlot: number): number {
    if (this.pendingSlot !== NO_SLOT) {
      const s = this.pendingSlot;
      this.pendingSlot = NO_SLOT;
      this.wheelHotbar = 0; // a direct press overrides any queued scroll
      return s;
    }
    if (this.wheelHotbar !== 0) {
      // each notch (~100 deltaY) = one slot step; wheel down (positive) advances forward.
      const steps = Math.trunc(this.wheelHotbar / 100) || (this.wheelHotbar > 0 ? 1 : -1);
      this.wheelHotbar -= steps * 100;
      const base = curSlot >= 0 && curSlot < NUM_SLOTS ? curSlot : 0;
      let s = (base + steps) % NUM_SLOTS;
      if (s < 0) s += NUM_SLOTS;
      return s;
    }
    return NO_SLOT;
  }

  /**
   * Sample current input as a PlayerInput — a pure projection of live key/mouse state +
   * the local player's contextual sim state (`ctx`, so a body action routes to the verb
   * layer). MOVE is the WASD stick rotated into WORLD space by the focus yaw; AIM is the
   * smoothed body facing; SLOT is the wheel/1–5 selection. All canonical world-space.
   *
   * `curSlot` is the sim's current selected slot (for relative wheel scroll). `ctx`
   * carries whether the local player is carrying a body / holding an item + the sim's
   * available actions — used ONLY to translate the contextual buttons into the proven
   * body verbs; the sim still re-derives targeting itself (this is just intent routing).
   */
  sample(curSlot = 0, ctx: InteractCtx = NEUTRAL_CTX): PlayerInput {
    const { fwd, right } = this.stick();
    const f = this.forwardDir(), r = this.rightDir();
    let mx = f.x * fwd + r.x * right, mz = f.z * fwd + r.z * right;
    const len = Math.hypot(mx, mz);
    if (len > 1e-4) { mx = (mx / len) * MOVE_Q; mz = (mz / len) * MOVE_Q; } else { mx = 0; mz = 0; }

    // PRIMARY = left TAP (one-shot, consumed) OR the K fallback held.
    const primaryTap = this.tapPending || this.has('k');
    this.tapPending = false;
    // SECONDARY = right button held OR the J fallback.
    const secondaryHeld = this.mouseDownR || this.has('j');

    let buttons = 0;
    // contextual interaction bits for the SIM's interact system (items + open).
    if (primaryTap) buttons |= Button.Primary;
    if (secondaryHeld) buttons |= Button.Secondary;

    // CONTEXTUAL BODY MAPPING → the proven verb layer (Button.Grab):
    //  - CARRYING a body: the verb layer keeps a hold only WHILE Grab is held, so we
    //    hold Grab every tick to keep carrying. A held SECONDARY (right) charges a throw
    //    (the verb's throwCharge ramps while Grab is down + hands full); RELEASING right
    //    fires the verb's Grab-release-edge throw automatically. A PRIMARY tap = DROP:
    //    we DROP the Grab bit for that one tick so the verb releases the body at ~0
    //    charge (a gentle place), then resume holding next tick if still right-held.
    //  - HANDS FREE, PRIMARY tap onto a grabbable body (actions has Grab): set Grab so
    //    the verb latches the carry. (Item pickup/open is the sim interact system's job
    //    off Button.Primary, already set above.)
    if (ctx.carryingBody) {
      this.grabHoldFrames = 0;                // latched — the carry branch owns Grab now
      buttons |= Button.Grab;                 // hold Grab to keep carrying (+ charge on right)
      if (primaryTap) buttons &= ~Button.Grab; // a primary tap drops (release-edge → verb throw@~0)
    } else {
      // arm/extend the grab-hold window on a primary tap onto a grabbable body, so the
      // verb's multi-tick latch can complete from a single tap.
      if (primaryTap && (ctx.actions & InteractAction.Grab) !== 0) {
        this.grabHoldFrames = InputController.GRAB_HOLD_WINDOW;
      }
      if (this.grabHoldFrames > 0) {
        buttons |= Button.Grab;
        this.grabHoldFrames--;
      }
    }

    // keyboard verbs (docs/11): E = Ability; plus the legacy fallbacks. RUSH is UNBOUND
    // for now — Shift is the hotbar-scroll modifier (Shift+wheel), so binding Rush to
    // Shift would fire accidental dashes while scrolling.
    if (this.has('e')) buttons |= Button.Ability;
    if (this.has('f')) buttons |= Button.Throw;      // legacy empty-hand shove
    if (this.has('l')) buttons |= Button.Struggle;
    if (this.has(' ')) buttons |= Button.Jump;
    if (this.has('q')) buttons |= Button.Recall;

    const slot = this.takeSlot(curSlot);
    return {
      moveX: Math.round(mx), moveZ: Math.round(mz),
      aim: Math.round(norm2pi(this.bodyAim) * FIXED_ONE),
      buttons, grabTarget: -1, slot,
    };
  }
}

/** Shortest-arc angle lerp by t∈[0,1]. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + angDiff(a, b) * t;
}
/** Signed shortest angular difference b−a in (−π, π]. */
function angDiff(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
  return d;
}
/** Normalize an angle into [0, 2π). */
function norm2pi(a: number): number {
  const m = a % TWO_PI;
  return m < 0 ? m + TWO_PI : m;
}
/** Wall-clock ms (IO layer only — never the sim). */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
