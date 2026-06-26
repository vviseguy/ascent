# 11 — Controls & Input Modes (the input reference)

> **Status: IMPLEMENTED.** This is the canonical reference for ASCENT's **input modes** — what
> every input does and how the camera, movement, and contextual interaction are *driven*. A merge
> of the old `11-camera-movement-controls` and `12-player-interaction` docs. **The master input
> table in §1 is the source of truth**; every later section is topical detail behind a row of it.
> Implemented in `src/render/input-controller.ts`, `src/render/loop.ts`, `src/render/renderer.ts`,
> and the sim's `src/sim/interact/` system. Last feel pass: 2026-06 (drag-yaw flipped, vertical-drag
> inclination added, scroll→zoom / Shift+scroll→hotbar, Rush temporarily unbound).
>
> **Scope.** This doc owns **input** (bindings, camera/movement control, interaction *mechanics*).
> The player-facing **UI / HUD presentation** of these systems — the hotbar's look, the interaction
> prompt chips, the health pill, camera/HUD feel — lives in the UX bible **`07-ux-ui-gamefeel.md`
> §2** (UX is broader than this doc should be). Pure-UI sections below (§3.3, §5, §6) are kept as
> numbered pointers so the §-anchors that code comments reference stay stable.
>
> **DETERMINISM (non-negotiable).** Everything here is a **VIEW / IO-layer** scheme: it only
> changes how the local client *forms* its input. The sim still receives canonical
> **world-space** move + aim + `Button` bits + a selected-slot field. The camera focus yaw
> **and pitch** are view-only and never enter the sim, the hash, or the wire. Interaction
> *targeting* (what's "in front") and the *5-slot inventory* DO affect gameplay, so they are
> computed/stored in the **sim** (hashed, cloned, rollback-safe); the renderer only DRAWS the
> hint + hotbar for the locally-predicted target/inventory. See §10.

---

## 1. Master input table (source of truth)

Every input the game reads, and exactly what it does. Context-dependent rows (the contextual
PRIMARY/SECONDARY) expand in §3.2. "View-only" = never touches the sim.

| Input | Effect | Layer |
|---|---|---|
| **W A S D** / **arrows** | **Move**, relative to the camera focus — W is always "up the screen" (§2.3) | sim input |
| **Space** | **Jump** | sim input |
| **Left-click — tap** (press+release, no drag, < 250 ms) | **PRIMARY interact** on the focus target: pick up item → hotbar · grab body → carry · drop/place held · open (§3.2) | sim input |
| **Left-drag — horizontal** | **Orbit** the focus + camera yaw (Minecraft-style look). **Direction flipped** (2026-06): drag right swings the focus left (§2.4) | view-only |
| **Left-drag — vertical** | **Inclination / pitch** — tilt the camera. Drag down → more top-down, drag up → toward the horizon; clamped 40°–85° (§2.5) | view-only |
| **Right-click** (tap, or hold→release) | **SECONDARY interact** on the focus target: open · use · **throw** the carried body/held item — **hold to charge** the throw (§3.2) | sim input |
| **Wheel** | **Camera zoom** (dolly), clamped (§2.5) | view-only |
| **Shift + Wheel** | **Hotbar select** — scroll the active slot 0↔4 (wraps) (§4) | sim input |
| **1 – 5** | **Direct hotbar slot** select | sim input |
| **Shift** (alone) | **— unbound —** (Rush is disabled for now; Shift is the hotbar-scroll modifier, see §7.4) | — |
| **E** | **Role ability** (Mender revive / Bulwark body-block / Engineer build / …) | sim input |
| **L** | **Struggle** (mash to break a grab) | sim input |
| **Q** | **Recall** to beacon (crew) · **plant beacon** (Anchor) | sim input |
| **Middle-click** | **Recenter focus** — snap the camera yaw to the current movement direction ("look where I'm going"); no-op if not moving (§2.4) | view-only |

**Hidden legacy keys** (kept so existing muscle memory + the verb proofs still exercise the
raw bits): **K** = Grab (held), **F** = Throw / empty-hand shove, **J** = Secondary. These
shadow the contextual mouse mapping and are not shown in the HUD.

> No two *visible* actions share an input. Where one physical input has two meanings
> (left tap vs. left drag; wheel vs. Shift+wheel; right tap vs. right hold) the split is by a
> small drag/time/modifier discriminator, tuned in §8.

---

## 2. Camera, focus & movement

### 2.1 The "focus" heading
A single view-layer scalar **`focusYaw`** (radians) — the horizontal compass direction the
camera looks *along* (the player's "forward"). The camera orbits the player around Y at this
yaw; the player and their movement are oriented relative to it.

- Default `focusYaw = π` (look **+Z, into the dungeon**): the crew spawns at the floor's −Z
  edge with rooms extending toward +Z, so a look-(−Z) opening framed the void behind the player
  (an all-black screen). At π, "W" also walks forward into the dungeon, as expected.
- `focusYaw` is **view-only state** owned by the input layer. It never enters the sim.

### 2.2 The camera orbit
The camera orbits the local player at `focusYaw` and a now-adjustable pitch (§2.5):

```
offset      = (0, D·sin(pitch), D·cos(pitch))         // D = dolly distance
camera.pos  = playerTarget + rotateY(offset, focusYaw)
camera.lookAt(playerTarget)                           // 42%-up framing via a projection shift
```

Rotating `focusYaw` swings the camera around the player; the default pitch is ≈72° (steep,
near top-down, suited to the sparse 30×30 dungeon map). The 42%-up framing is a projection
`setViewOffset` shift, independent of pitch, so the inclination stays exact.

### 2.3 Movement — relative to focus (WASD)
WASD is interpreted in the **focus frame**, not world axes:

```
forwardDir = rotateY((0,0,-1), focusYaw)              // where the camera looks, on the ground
rightDir   = rotateY((1, 0, 0), focusYaw)
move       = forwardDir·(W − S) + rightDir·(D − A)    // normalized + quantized → sim
```

So **W always goes "up the screen"** (away from the camera) regardless of `focusYaw`. While
moving **forward or backward** (W/S), the player's **facing** (`aim`) gently lerps toward the
forward direction — the body ends up facing where it walks. **Strafing alone (A/D) does NOT
reorient** the body (v1; §7). The lerp is rate-limited so it reads as a smooth turn, not a snap.

### 2.4 Active drag-orbit + middle-click recenter
- **Left-drag horizontal** swings `focusYaw` (Minecraft active look), proportional to drag
  pixels (`DRAG_PAN_RATE` rad per screen-width). **The sign is FLIPPED** (2026-06 feel pass):
  dragging right swings the focus *left*. A left press that never passes the drag threshold
  (`DRAG_DEADZONE_PX` within `TAP_MAX_MS`) is a **PRIMARY interact tap**, not an orbit (§3).
  This **replaces** the old edge-hold infinite pan.
- **Middle-click** snaps `focusYaw` to the **current movement direction** (quick lerp), i.e.
  "look where I'm going". No-op when stationary.

### 2.5 Inclination (pitch) + zoom
- **Left-drag vertical** tilts the camera **inclination** (`focusPitch`): drag **down** → more
  top-down, drag **up** → toward the horizon. `PITCH_DRAG_RATE` rad per screen-height, clamped
  to `[PITCH_MIN, PITCH_MAX]` = 3°–85° so the view can drop to **near-horizontal (almost ground
  level)** at the low end without flipping past top-down at the high end. (Horizontal + vertical components of one drag combine, so a diagonal drag
  orbits and tilts at once.)
- **Wheel** drives an exponential **zoom** multiplier on the dolly distance, clamped to
  `[ZOOM_MIN, ZOOM_MAX]`. (Pre-2026-06 this was Ctrl+wheel; plain wheel now zooms.)
- All of the above are **view-only** — pure renderer state, never `PlayerInput`.

---

## 3. Contextual interaction (primary / secondary + hints)

The heart of the scheme. Mirrors Zelda/Souls "press X to interact" with a clear
PRIMARY/SECONDARY split and Minecraft-Dungeons-clean prompts.

### 3.1 The focus spot + target (SIM-side, deterministic)
Each tick the sim computes an **interaction spot** a fixed reach in front of the player
(`INTERACT_REACH ≈ 1.4 u` along `facing`) and picks the **single best interactable** — the
closest within range + a frontal cone (~75°, so you interact with what you face). Interactable
kinds: a **loose item/prop** (pickup), a **chest** (open), a **grabbable body** (carry), a
**breakable** (smash via the existing rush/throw, no prompt). The chosen `targetEntity` +
`targetActions` are part of sim state — deterministic + rollback-safe. Deterministic tie-break
by ascending id.

### 3.2 Primary vs secondary, by context
The two buttons mean different things by what's targeted / what you're holding:

| You are… | Target | PRIMARY (left-tap) | SECONDARY (right) |
|---|---|---|---|
| empty-handed | loose item | **pick up** → hotbar | — |
| empty-handed | grabbable body | **grab → carry** | — |
| empty-handed | chest (hand free) | **open** | open |
| carrying a body | — | **drop / place** | **throw** (hold to charge) |
| holding a hotbar item | — | **place / use** | **throw the item** |

So right-click is always "the forceful/alternate action": throw what you hold, or open a
container. Body grab/carry/throw stays in the proven **verb layer** — the IO layer routes the
contextual buttons onto the existing `Button.Grab/Throw` bits (carrying = hold Grab; a held
right charges the verb's throw, releasing fires it; a primary tap drops). The interact *system*
only owns the **item** + **open** actions. See §9.3.

### 3.3 Hint UI → see `07` §2.7
When the sim reports an available action (`targetActions`), the HUD draws a calm PRIMARY (`LMB`) +
SECONDARY (`RMB`) prompt. This doc owns only **what the buttons do** (§3.2); the **visual spec
lives in `07-ux-ui-gamefeel.md` §2.7**. The prompt is a pure reader of the sim's targeting state.

### 3.4 Doors — a special interactable ("carry the door")
Doors fit the game's physical/tactile identity (same grab-and-manipulate idiom as carrying
bodies). Two ways to open, sharing one mechanic:

- **Click = toggle.** A single PRIMARY/SECONDARY click swings the door open/shut with a short
  hinge animation. Fast + obvious; the default.
- **Hold + drag = physically swing it.** Holding interact and dragging treats the door like a
  body constrained to its **hinge**: your drag applies torque, so you swing it to any angle and
  can leave it **ajar**. Release to let it rest.

**Why:** on-theme (Gang-Beasts-ish), tactically meaningful (leave a door cracked to control
sightlines / the fog reveal), and it reuses the carry idiom so it adds no new control.
**Determinism:** the hinge angle is **sim state** (a constrained body / per-door Fixed angle);
your drag is canonical input (mouse delta → quantized angular intent), so every peer swings it
identically. The swinging leaf participates in collision (it can block/push bodies).
**Fog tie-in:** a **closed door blocks the view + keeps the next room fogged**; opening it
reveals — doors gate exploration. **Phasing:** ship **click-toggle (animated)** first; add the
**drag-swing** once the hinge-body physics land. Status: **DEFERRED hook** wired in the sim
(§9.5) — the prompt lights up "Open" the moment door entities exist.

---

## 4. Inventory — a 5-slot hotbar (Minecraft-style)

- **5 slots**, shown bottom-center. **Shift+wheel** (or **1–5**) selects the active slot; the
  selected slot is highlighted. The active slot's item is "in hand."
- **Contents = loose ITEMS/props** you pick up (bottles, keys, the old throwables, coins) —
  **NOT bodies.** Carrying a body (crew/Anchor — the core verb) is a separate, exclusive state
  and does not occupy a slot.
- **Pickup** (primary, §3.2) puts the targeted item into the first empty slot (or the active
  slot). **Throw/use** acts on the active slot's item (secondary / primary).
- This is **sim state** (a per-player 5-entry item array + selected index), hashed and
  rollback-safe — it lives in `WorldState` and the wire input gains a "selected slot" field;
  pickup/use intents flow through the contextual buttons (§9).
- **Visual presentation** (the bottom-center bar, selected ring, item icons) is owned by
  `07-ux-ui-gamefeel.md` §2.7 — this section owns only the slot-select *input* + the inventory model.

---

## 5. Health display → see `07` §2.8

The local-player health pill (the player *you're driving*, distinct from the Anchor durability arc)
is a HUD element; its spec lives in `07-ux-ui-gamefeel.md` §2.8. Kept here as a numbered pointer so
the §-anchors that code comments reference stay stable.

---

## 6. UI vibe → see `07`

The HUD look-and-feel (dark blurred-glass, crew-color accents, Minecraft-Dungeons-clean prompts) is
owned by the UX bible `07-ux-ui-gamefeel.md` (§2 HUD + §6 accessibility). Kept here as a numbered
pointer so the §-anchors below (§7–§10) stay stable for the code that references them.

---

## 7. Design decisions (resolved) + open forks

The interaction lead's calls (2026-06), with later feel-pass amendments noted.

1. **§7.1 Left tap-vs-drag.** ADOPTED the tap/drag split: left **drag past a small pixel
   threshold** = active orbit; a left **press+release under the threshold + under a short time**
   = PRIMARY interact (`DRAG_DEADZONE_PX = 6`, `TAP_MAX_MS = 250`). Keeps the mouse uncluttered,
   matches Minecraft muscle memory. *Open: the threshold may need per-device tuning.*
2. **§7.2 Charged throw.** KEPT charge-on-hold, moved to the **SECONDARY (right)** button (right
   = the forceful/alternate action). Reuses the existing sim charge machinery (`throwCharge`,
   GRAB-release throw) unchanged — the IO layer routes a held-then-released SECONDARY into the
   proven Grab-hold→release path when carrying a body, or into the item-throw intent when
   holding a hotbar item.
3. **§7.3 Pickup-able set.** Loose **Pickup**-flagged drops + **Throwable** Light props for now
   (bottles/coins/keys later reuse the same flag). Heavy throwables and bodies are NOT hotbar
   items — they remain the carry verb. A chest is an **open** target, not a pickup.
4. **§7.4 Rush + Ability keys.** **E = Ability** (first-class keyboard bit). **Rush is UNBOUND
   for now** — it was on **Shift**, but Shift became the **hotbar-scroll modifier** (§7.5), and
   a held Shift would fire accidental dashes while scrolling. Re-home Rush on a free key (or a
   double-tap-move) when it returns. The legacy right-button rush/ability resolver still exists
   but is not driven by the current scheme.
5. **§7.5 Zoom / scroll rebind.** **Plain wheel = camera zoom**; **Shift+wheel = hotbar scroll**
   (2026-06; previously plain wheel = hotbar, Ctrl+wheel = zoom). Implemented in
   `input-controller.ts`: the wheel handler routes to `wheelZoom` unless Shift is held, in which
   case it becomes a slot-scroll delta. (No keyboard zoom binding exists yet.)

**Other open forks:** body-facing source (movement-forward vs. restoring mouse free-aim for the
body/throws); strafe reorientation (A/D could later face net movement); the drag-orbit /
inclination directions + rates (both flippable in §8); restoring a middle-**drag** world-pan on
a separate chord.

---

## 8. Tunables (view-layer, in `input-controller.ts` / `renderer.ts`)

| Name | Default | Meaning |
|---|---|---|
| `DRAG_DEADZONE_PX` | 6 px | drag distance below which a left press is a TAP (interact), not an orbit |
| `TAP_MAX_MS` | 250 ms | max left-press duration that still counts as a tap |
| `DRAG_PAN_RATE` | 3.0 rad | focus **yaw** per one screen-width of horizontal drag (sign flipped in code) |
| `PITCH_DRAG_RATE` | 1.4 rad | camera **pitch** per one screen-height of vertical drag |
| `PITCH_MIN` / `PITCH_MAX` | 3° / 85° | inclination clamp (near-horizontal / near top-down) |
| `DEFAULT_PITCH` | ≈72° | shipped pitch = `atan2(CAM_SIN55, CAM_COS55)` |
| `FACE_TURN_RATE` | 7.0 /s | facing lerp toward forward when moving fwd/back |
| `FOCUS_SNAP_RATE` | 16 /s | middle-click focus-snap lerp speed |
| `ZOOM_MIN` / `ZOOM_MAX` | 0.45 / 2.6 | wheel-zoom dolly multiplier clamp (`renderer.ts`) |

To **flip** the drag-orbit or inclination direction, negate `DRAG_PAN_RATE` usage / the
`focusPitch +=` sign in `updateFocus`.

---

## 9. Implementation (AS BUILT)

### 9.1 Input fields (`src/sim/world/input.ts`, wire in `src/net/wire.ts`)
- New `Button` bits (append-only — values never reordered):
  - `Primary = 1<<8` — left-tap PRIMARY interact (pickup/place/use/open/grab).
  - `Secondary = 1<<9` — right SECONDARY interact (throw held body/item; open; hold=charge).
- New `PlayerInput.slot`: selected hotbar index `0..4`, or `NO_SLOT (-1)` = "no change this
  tick". A **level** field, canonicalized as `slot+1` in one byte (0 = unchanged), so a dropped
  packet leaves the selection unchanged. Packet grew 6 → 7 bytes/frame; `PROTO_VERSION` = 2.
- Because `buttons` is now > 8 bits, the wire `buttons` byte widened to a **uint16** (LE);
  `canonicalizeInput` masks to `0xffff`.

### 9.2 WorldState fields (`src/sim/world/state.ts`) — all hashed
- **Inventory (Int32):** `inv0..inv4` — five item slots, each an `ItemKind` id (0 = empty:
  `Empty/Bottle/Key/Coin/Generic`) — and `selSlot` (selected index `0..4`). Five flat fields so
  they fold into the per-field hash sweep with zero special-casing.
- **Targeting (Int32):** `targetEntity` (chosen interactable id, or `NO_ENTITY`),
  `targetActions` (bitfield of available `InteractAction`s: `Pickup/Grab/Open/PlaceUse/
  ThrowItem/DropBody/ThrowBody`). Recomputed every tick before intents resolve, so hashing them
  is belt-and-suspenders (re-derived on rollback anyway) but makes the HUD a pure reader.

### 9.3 The interact system (`src/sim/interact/`)
`applyInteract(w, inputs, index, tick)` runs as **SYSTEM 6.6**, AFTER verbs/breakables and
BEFORE fall-damage/game-layer. Two ordered, ascending-id phases:
1. **Targeting:** compute the interaction spot, query the index, pick the best interactable by
   fixed priority, write `targetEntity` + `targetActions` from what the player holds/carries and
   what the target is.
2. **Intent resolution:** on the `Primary`/`Secondary` press-EDGE (vs `prevButtons`, the verbs'
   edge discipline), resolve the contextual action: pick up into the first empty slot;
   place/use or throw the active item; `Open` flips the deferred door hook (§9.5). Body
   grab/carry/throw stays in the verb layer — the interact system only routes item + open
   actions and maps the contextual buttons onto existing body verbs. Selected-slot scroll is
   applied first (clamp `selSlot` to `0..4` when `inp.slot >= 0`).

### 9.4 Determinism proof (`src/sim/interact/prove.ts`, `npm run prove:interact`)
Mirrors `sim/prove.ts`: players + Pickup drops; a seeded input stream that scrolls slots and
presses Primary/Secondary. PROOF 1 two-run determinism on the hash stream; PROOF 2
rollback-torture (restore an earlier tick, re-advance, hashes must match) across
pickup/use/throw boundaries. `interact.test.ts` covers unit semantics (pickup fills a slot,
throw-item empties it + spawns a free body, slot select clamps).

### 9.5 The DOOR hook (DEFERRED, §3.4)
`InteractAction.Open` + `targetActions` already carry an Open bit, and `applyInteract` has one
`resolveOpen(w, player, target, tick)` seam that no-ops unless the target has a (future)
`BodyFlag.Door`. When generation adds door entities + a per-door hinge-angle field, fill in
`resolveOpen` (click-toggle first, drag-swing later) — no other interaction code changes.

---

## 10. Determinism (why this is safe)

The sim is fed **world-space** `moveX/moveZ`, a world-space `aim` angle, `Button` bits, and the
`slot` field — quantized through the wire codec. The camera **`focusYaw` and `focusPitch`** are
applied **client-side, in the IO layer**, to turn WASD + cursor into that canonical input.
Therefore:

- Two peers with different camera headings/pitches send identical *world-space* input for the
  same intent, and the sim stays bit-identical. `focusYaw`/`focusPitch` are never hashed, never
  sent.
- The facing-reorientation lerp (§2.3) is just the per-tick `aim` input, so it replays
  identically under rollback.
- Interaction **targeting** + **inventory** that affect gameplay live in the **sim** (hashed,
  cloned, restored), so all peers agree. The renderer only draws the locally-predicted
  target/inventory.

No sim file changes are required for the camera/movement scheme; the interaction/inventory
scheme adds the hashed sim fields above and is proven in §9.4.
