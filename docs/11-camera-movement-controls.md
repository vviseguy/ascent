# 11 — Camera & Movement Controls (focus-relative)

> Status: v1 spec (implemented in `src/render/input-controller.ts`, `src/render/loop.ts`,
> `src/render/renderer.ts`). This records the **focus-relative** control scheme requested
> 2026-06. It is a VIEW-LAYER scheme: it only changes how the local player's input is
> *formed*; the wire/sim still receive a canonical **world-space** move + aim, so it is
> determinism-safe (see §5). Tunables are in §6. Open design forks are in §7 — change them
> here and the implementation should follow.

---

## 1. The "focus" heading

A single view-layer scalar **`focusYaw`** (radians) — the horizontal compass direction the
camera looks *along* (the player's "forward"). The camera orbits the player around Y at this
yaw; the player and their movement are oriented relative to it.

- `focusYaw = 0` is the shipped default (camera on the +Z side, looking toward −Z and down).
- `focusYaw` is **view-only state** owned by the input layer. It never enters the sim.

---

## 2. Camera

The camera **orbits the local player** at `focusYaw`, keeping the existing ~55° downward
pitch and the spread/zoom dolly:

```
offset      = (0, D·sin(pitch), D·cos(pitch))         // D = dolly distance, pitch ≈ 55°
camera.pos  = playerTarget + rotateY(offset, focusYaw)
camera.lookAt(playerTarget)                           // 42%-up framing via the projection shift
```

So rotating `focusYaw` swings the camera around the player; pitch and distance are unchanged
("the camera angle [yaw] follows the focus proportionately", §3.2).

---

## 3. Controls

### 3.1 Movement — relative to focus (WASD)
WASD is interpreted in the **focus frame**, not world axes:

```
forwardDir = rotateY((0,0,-1), focusYaw)              // where the camera looks, on the ground
rightDir   = rotateY((1, 0, 0), focusYaw)
move       = forwardDir·(W − S) + rightDir·(D − A)    // then normalized + quantized → sim
```

So **W always goes "up the screen"** (away from the camera) regardless of `focusYaw`.

### 3.2 Active drag-pan — swing the focus by dragging (REPLACES edge-pan)
> **Updated 2026-06 (docs/12):** the old cursor **edge-hold infinite pan** is REMOVED. Panning
> is now **Minecraft-style active drag**: hold the LEFT button and drag horizontally to swing
> `focusYaw` (a left drag turns the focus left, right drag turns it right), proportional to the
> drag pixels (`DRAG_PAN_RATE` rad per screen-width). A left press that does NOT pass the drag
> threshold (`DRAG_DEADZONE_PX`, within `TAP_MAX_MS`) is a **PRIMARY interact tap**, not a pan
> (docs/12 §1). The camera yaw follows the focus (§2), so the world rotates around the player.
> (Vertical drag is reserved; no pitch change in v1 — see §7.)

### 3.3 Middle-click — snap focus to movement
Pressing the **middle mouse button** snaps `focusYaw` to the **current movement direction**
(quick lerp), i.e. "look where I'm going". If not moving, it's a no-op. (This replaces the old
middle-drag target-pan.)

### 3.4 Body facing — gently reorients toward forward
While moving **forward or backward** (W/S engaged), the player's **facing** (`aim` in the sim)
gently turns toward the **forward** movement direction — the body ends up facing where it
walks. **Strafing alone (A/D) does NOT reorient** the body (v1; §7). The reorientation is a
rate-limited lerp of the sent `aim`, so it reads as a smooth turn, not a snap.

---

## 4. Default key/mouse map (updated)

| Input | Action |
|---|---|
| **WASD / arrows** | move, relative to focus (§3.1) |
| **left-DRAG** | active-pan the focus + camera yaw (§3.2) — replaces edge-pan |
| **left-TAP** | PRIMARY interact (docs/12) |
| **right** | SECONDARY interact (docs/12) |
| **middle-click** | snap focus to movement direction (§3.3) |
| **wheel** | hotbar slot select (docs/12); **Ctrl+wheel / `-` `=`** = zoom dolly |
| **Shift / E** | Rush / Ability (docs/12); Space jump, L struggle, Q recall/plant |

Note: the mouse no longer free-aims the body — facing follows movement (§3.4). Throw aim uses
the body facing. The full interaction/inventory scheme is docs/12. (If free-aim is wanted
back, see §7.)

---

## 5. Determinism (why this is safe)

The sim is fed **world-space** `moveX/moveZ` and a world-space `aim` angle, quantized through
the wire codec exactly as before. `focusYaw` is applied **client-side, in the IO layer**, to
turn WASD + cursor into that canonical world-space input — the same place the old mouse→world
raycast aim already lived. Therefore:

- Two peers with different camera headings still send identical *world-space* input for the
  same intent, and the sim stays bit-identical. `focusYaw` is never hashed, never sent.
- The reorientation lerp (§3.4) produces a deterministic per-tick `aim` sequence (it's just
  the input), so it replays identically under rollback.

No sim file changes are required for this scheme.

---

## 6. Tunables (in `input-controller.ts`)

| Name | Default | Meaning |
|---|---|---|
| `DRAG_DEADZONE_PX` | 6 px | drag distance below which a left press is a TAP (interact), not a pan |
| `TAP_MAX_MS` | 250 ms | max left-press duration that still counts as a tap |
| `DRAG_PAN_RATE` | 3.0 rad | focus rotation per one screen-width of horizontal drag |
| `FACE_TURN_RATE` | 7.0 /s | how fast facing lerps toward forward when moving |
| `FOCUS_SNAP_RATE` | 16 /s | middle-click focus-snap lerp speed |

---

## 7. Open design forks (decide here)

1. **Body facing source.** v1: facing follows **movement-forward** (mouse only steers the
   camera). Alternative: keep **mouse free-aim** for the body/throws and only use focus for
   the camera. *Default chosen: movement-forward, per the request.*
2. **Strafe reorientation.** v1: A/D alone does **not** turn the body ("not side to side for
   now"). Could later face the net movement direction including strafe.
3. **Edge-pan pitch.** v1: cursor edges rotate **yaw only**; pitch fixed. Could let vertical
   edges raise/lower the camera pitch.
4. **Middle button.** v1: click = snap-to-movement. The old middle-**drag** world-pan is
   removed; restore it on a different chord if desired.
