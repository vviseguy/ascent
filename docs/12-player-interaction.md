# 12 — Player Interaction & Control Scheme (v1 — IMPLEMENTED 2026-06)

> Status: **IMPLEMENTED.** This is the cohesive, collision-free control + interaction
> scheme requested 2026-06. It reconciles the NEW asks (active pan, primary/secondary
> contextual interaction + hints, 5-slot scroll hotbar, health readout) with the EXISTING
> verbs (grab/carry/throw, rush, ability, struggle, recall) and the focus camera (docs/11).
> The §2/§7 decisions below are RESOLVED (see "DECISIONS — RESOLVED"). Idioms borrowed:
> Minecraft (active look, scroll hotbar), Minecraft Dungeons (clean contextual prompts),
> Zelda/Souls (single contextual "interact" with a button hint).
>
> DETERMINISM: like docs/11, the control mapping is a VIEW/IO-layer scheme — it only
> changes how the local client FORMS its input; the sim still receives canonical
> world-space move + aim + Button bits + a (new) selected-slot field. Interaction
> TARGETING (what's "in front") and INVENTORY (the 5 slots) that affect gameplay are
> computed/stored in the SIM from sim state and are hashed/cloned/restored — so all peers
> agree and it is rollback-safe. The renderer only DRAWS the hint + hotbar for the
> locally-predicted target/inventory.

## DECISIONS — RESOLVED (the interaction lead's calls, 2026-06)

These lock §2 + §7. Where I changed the proposal's default, the reason is noted.

1. **Left tap-vs-drag (§7.1).** ADOPTED the tap/drag split: left **drag past a small pixel
   threshold** = active pan (Minecraft look); a left **press+release under the threshold and
   under a short time** = PRIMARY interact. The threshold lives in `input-controller.ts`
   (`DRAG_DEADZONE_PX = 6`, `TAP_MAX_MS = 250`). Rationale: keeps the mouse uncluttered and
   matches the Minecraft muscle memory the request asked for.
2. **Charged throw (§7.2).** KEPT charge-on-hold, but moved to the **SECONDARY (right)**
   button as the spec's table dictates (right = the forceful/alternate action). The
   existing sim charge machinery (`throwCharge`, GRAB-release throw) is reused unchanged;
   the IO layer simply routes a held-then-released SECONDARY into the existing
   Grab-hold→release path **when carrying a body** (so the proven throw code is untouched),
   and into the new item-throw intent when holding a hotbar item.
3. **Pickup-able set (§7.3).** Loose **Pickup**-flagged drops + **Throwable** Light props for
   now (bottles/coins/keys later reuse the same flag). Heavy throwables and bodies are NOT
   hotbar items — they remain the carry verb. A chest is an **open** target, not a pickup.
4. **Rush + Ability keys (§7.4).** ADOPTED **Shift = Rush**, **E = Ability**. Implemented as
   first-class keyboard bits, independent of the legacy right-button tap/hold resolver
   (which still works for any remaining right-button rush/ability, but the new scheme drives
   them off Shift/E so right-click is free for SECONDARY interact).
5. **Zoom rebind (§7.5).** ADOPTED. Plain **wheel = hotbar scroll**; **Ctrl+wheel** and
   **`-`/`=`** = zoom. Implemented in `input-controller.ts` (`takeViewDeltas` only reports
   wheel as zoom when Ctrl is held; otherwise wheel becomes a slot-scroll delta).

### §2 collisions — final resolution table (implemented)

| Input | Final meaning |
|---|---|
| Left **drag** | active pan (focus look) — REPLACES edge-hold infinite pan |
| Left **tap** | PRIMARY interact (pickup item · grab body · place/use held item · open) |
| Right (tap / hold-release) | SECONDARY interact (open chest · **throw** held body/item, hold to charge) |
| Wheel | hotbar slot select (cycle 0..4) |
| `1`–`5` | direct hotbar slot select |
| Shift | Rush (dash) |
| E | Role ability |
| Space | Jump · `L` Struggle · `Q` Recall/plant |
| Ctrl+wheel, `-`/`=` | camera zoom · middle-click recenter focus |

No two actions share an input. The legacy `K`(grab)/`F`(shove)/`J`(right) keys are kept as
hidden fallbacks so existing muscle memory + the verb proofs still exercise those bits.

---

## 1. The full input map (proposed)

| Input | Action |
|---|---|
| **WASD / arrows** | Move — relative to the camera focus (docs/11) |
| **Space** | Jump |
| **Left-button + drag** | **Pan / look** — actively drag to swing the focus (Minecraft-style; **replaces the old edge-hold infinite pan**) |
| **Left-click (tap, no drag)** | **PRIMARY interact** on the focus target (pick up item → hotbar · grab a body → carry · drop/place) |
| **Right-click** | **SECONDARY interact** on the focus target (open chest · use · **throw** the carried body / held item — hold to charge) |
| **Wheel** | **Hotbar select** (cycle slots 1–5) |
| **1 – 5** | Direct hotbar slot select |
| **Shift** | **Rush** (dash) |
| **E** | **Role ability** (Mender revive / Bulwark body-block / Engineer build / …) |
| **L** | **Struggle** (mash to break a grab) |
| **Q** | **Recall** to beacon (crew) · **plant beacon** (Anchor) |
| **Ctrl + wheel**, or **− / =** | Camera **zoom** (moved off the plain wheel) |
| **Middle-click** | Recenter the focus behind the player |

---

## 2. Collisions resolved (old scheme → new) — **review these**

The current scheme (docs/11 + input-controller) collides with every new ask. Resolutions:

| Conflict | Old | New | Resolution |
|---|---|---|---|
| Left button | hold = GRAB, release = THROW | drag = pan, tap = PRIMARY interact | GRAB folds into **primary interact** (tap a body to carry); **THROW** moves to **secondary (right)**. Pan is the *drag* meaning of left. |
| Right button | tap = ABILITY, hold = RUSH | SECONDARY interact (open/use/throw) | **Rush → `Shift`**, **Ability → `E`**. Right is now the contextual secondary. |
| Wheel | camera zoom | hotbar select | **Zoom → `Ctrl+wheel` / `−`,`=`**. Wheel is the hotbar. |
| Edge of screen | hold cursor = infinite focus pan | (removed) | **Left-drag** active pan replaces it (your Minecraft ask). |

Net: left = pan + primary, right = secondary, wheel = hotbar, Shift = rush, E = ability — **no two actions share an input.**

---

## 3. Contextual interaction model (primary / secondary + hints)

The heart of the new scheme. Mirrors Zelda/Souls "press X to interact" but with a clear
PRIMARY/SECONDARY split and Minecraft-Dungeons-clean prompts.

**3.1 The focus spot + target (SIM-side, deterministic).** Each tick the sim computes an
*interaction spot* a fixed reach in front of the player (along facing, ~1.2 u out) and picks
the **single best interactable** — the closest one to that spot within range + a frontal cone.
Interactable kinds: a **loose item/prop** (pickup), a **chest** (open), a **grabbable body**
(carry), a **breakable** (smash via the existing rush/throw, no prompt needed). The chosen
target id + its available actions are part of sim state (so it's deterministic + rollback-safe).

**3.2 Primary vs secondary, by context.** The two buttons mean different things by what's
targeted / what you're holding:

| You are… | Target | PRIMARY (left-tap) | SECONDARY (right) |
|---|---|---|---|
| empty-handed | loose item | **pick up** → hotbar | — |
| empty-handed | grabbable body | **grab → carry** | — |
| empty-handed | chest (hand free) | **open** | open |
| carrying a body | — | **drop / place** | **throw** (hold to charge) |
| holding a hotbar item | — | **place / use** | **throw the item** |

(So right-click is always "the forceful/alternate action": throw what you hold, or open when
near a container.)

**3.3 Hint UI (Minecraft-Dungeons-clean).** When the sim reports an available action, the HUD
shows a small, calm prompt: a **button glyph + verb (+ item name)** — e.g. `▣ RMB  Open chest`,
`▣ LMB  Pick up  Bottle`. Placement: a single line just under/over the targeted object (or
floating above the player), fading in only while an action is available, in the app's
dark blurred-glass style with a crew-color accent. Never more than one PRIMARY + one SECONDARY
hint at a time. (See §6.)

---

### 3.4 Doors — a special interactable (the "carry the door" idea)

Doors are a distinct interactable that fits the game's **physical/tactile** identity (the same
grab-and-manipulate idiom as carrying bodies). Proposal — support **two ways to open**, sharing
one mechanic:

- **Click = toggle.** A single PRIMARY/SECONDARY click on a targeted door swings it open (or
  shut) with a short hinge animation. Fast + obvious; the default.
- **Hold + drag = physically swing it ("carry the door").** Holding the interact button and
  dragging treats the door like a body constrained to its **hinge**: your drag applies torque,
  so you swing it to ANY angle and can leave it **ajar**. Same feel as carrying — the door
  "follows your hand" but pivots on the hinge instead of floating. Release to let it rest.

**Why it's good (my take):** it's on-theme (physical, Gang-Beasts-ish), tactically meaningful
(leave a door cracked to control sightlines / the fog reveal), and it reuses the carry idiom so
it doesn't add a new control. It also gives doors a reason to exist beyond decoration.

**Determinism:** the door's **hinge angle is SIM state** (a constrained body / a per-door Fixed
angle), and your drag is canonical input (mouse delta → an angular intent, quantized like aim) —
so every peer swings it identically and it's rollback-safe. The swinging leaf participates in
collision (it can block/push bodies), which is the fun part.

**Fog tie-in:** a **closed door blocks the view + keeps the next room fogged**; opening it (click
or drag) reveals — so doors gate exploration (§ render fog-of-war), which is why "doors not yet
opened" hides what's behind (the earlier ask).

**Phasing:** ship **click-toggle (animated)** first; add the **drag-swing** as a polish once the
hinge-body physics + input mapping are in. (Render is already told to keep door leaves as their
own hinge-able node.)

---

## 4. Inventory — a 5-slot hotbar (Minecraft-style)

- **5 slots**, shown as a hotbar **bottom-center**. **Wheel** (or `1–5`) selects the active
  slot; the selected slot is highlighted. The active slot's item is "in hand."
- **Contents = loose ITEMS/props** you pick up (bottles, keys, the old throwables, coins, etc.)
  — NOT bodies. **Carrying a body** (crew/Anchor — the core verb) is a separate, exclusive
  state and does not occupy a hotbar slot.
- **Pickup** (primary, §3.2) puts the targeted item into the first empty slot (or the active
  slot). **Throw/use** acts on the active slot's item (secondary / primary).
- This is SIM state (a small per-player 5-entry item array + selected index), hashed/rollback-
  safe — so it must live in `WorldState` and the wire input gains a "selected slot" + the
  pickup/use intents flow through the contextual buttons. (Implementation note in §8.)

---

## 5. Health display

- Add a **local-player health bar + number** to the HUD (the Anchor already has a health arc;
  this is the *player you're driving*). Place it near the hotbar (bottom) or a screen corner,
  in the HUD style. Driven by `w.health[localId]` (0–100). *(This one is small + is already
  delegated to the render agent.)*

---

## 6. UI vibe (match the app)

- Reuse the existing HUD language: **dark blurred-glass panels, system-ui, crew-color accents,
  soft glow** (cf. the Anchor HUD + style picker). Hotbar slots = rounded dark cells with a
  bright selected ring. Hints = one calm line, glyph + verb, fade in/out, never cluttered.
- Look-and-feel reference: **Minecraft Dungeons** (uncluttered contextual prompts, readable
  hotbar) over Minecraft-classic's denser HUD.

---

## 7. OPEN DECISIONS — **pick here before implementing**

1. **Left tap-vs-drag.** v1 makes left *drag* = pan and left *tap* = primary interact (one
   button, distinguished by a small drag threshold). Clean but the threshold needs tuning.
   *Alternative:* put primary interact on **`F`** (or `E`) and leave left purely for pan.
   **Default: tap/drag split.**
2. **Charged throw.** Keep "hold secondary to charge, release to throw" (the current power
   meter), now on right-button? Or instant throw? **Default: keep charge, on right-hold.**
3. **What's pickup-able into the hotbar?** Just the loose throwable objects + found props
   (bottles/keys/coins), or also consumables/role tools later? **Default: loose props +
   throwables for now.**
4. **Rush + Ability keys.** I moved Rush→`Shift`, Ability→`E`. OK, or you prefer other keys
   (e.g. Rush on double-tap-move, Ability on `Q` and Recall on `R`)? **Default: Shift / E.**
5. **Zoom rebind.** Wheel becomes the hotbar; zoom → `Ctrl+wheel` + `−`/`=`. OK? **Default: yes.**

---

## 8. Implementation layers (when approved)

- **Sim** (`src/sim/`): contextual TARGETING (interaction spot → best interactable id +
  available actions) computed each tick; the per-player **5-slot inventory + selected index**
  in `WorldState` (hashed); pickup / open / use / throw-item intents resolved deterministically;
  new `Button` bits or input fields for primary/secondary + slot-select. Proven + rollback-safe.
- **IO** (`input-controller.ts` / `loop.ts`): map left-tap/drag, right, wheel, Shift/E to the
  canonical input; active-pan replaces edge-pan (docs/11 updated).
- **Render** (`src/render/`): the hotbar UI, the contextual hint prompts, the health readout —
  all reading the sim's targeting/inventory state, in the app's HUD style.
- **Assets**: items/props from the KayKit Dungeon pack (already downloading).

---

## 9. Implementation reference (AS BUILT)

### 9.1 New input fields (`src/sim/world/input.ts`, wire in `src/net/wire.ts`)

- New `Button` bits (appended; bit values are append-only, never reordered):
  - `Primary = 1<<8` — left-tap PRIMARY interact (contextual; pickup/place/use/open/grab).
  - `Secondary = 1<<9` — right SECONDARY interact (throw held body/item; open; hold=charge).
- New `PlayerInput.slot` field: selected hotbar index `0..4`, or `-1` = "no change this tick".
  Canonicalized through the wire as `slot+1` in one byte (0 = unchanged). It is a LEVEL
  field (the currently-selected slot), not an edge — the sim stores `selSlot` and only
  overwrites it when `slot >= 0`, so a dropped packet just leaves the selection unchanged.
- The packet grows from 6 → 7 bytes/frame (byte 6 = `slot+1`). `PROTO_VERSION` bumped to 2.

Because the buttons field is now > 8 bits, the wire `buttons` byte widened to a **uint16**
(little-endian) so `Primary`/`Secondary` survive the round-trip. `canonicalizeInput` masks
to `0xffff`.

### 9.2 New WorldState fields (`src/sim/world/state.ts`) — all hashed

Inventory + targeting are SIM state (deterministic, rollback-safe). Per-body:

- **Inventory (Int32, appended to `INT32_FIELDS`):** `inv0..inv4` — five item slots, each an
  ITEM KIND id (`ItemKind`, 0 = empty) — and `selSlot` (selected index `0..4`). Five flat
  fields (not a packed sub-array) so they fold into the existing per-field hash sweep with
  zero special-casing. `ItemKind` is a small enum (`Empty/Bottle/Key/Coin/Generic`) so the
  hotbar can show an icon; pickups map their kind from the picked body.
- **Targeting (Int32, appended):** `targetEntity` (the chosen interactable id, or `NO_ENTITY`),
  `targetActions` (a bitfield of available `InteractAction`s: `Pickup/Grab/Open/PlaceUse/
  ThrowItem/DropBody/ThrowBody`). Both are recomputed every tick by the targeting system
  BEFORE intents resolve, so they are a pure function of state — hashing them is belt-and-
  suspenders (they'd be re-derived on rollback anyway) but makes the HUD a pure reader and
  catches any divergence in the check-frame.

`BYTE_FIELDS` is unchanged (all new fields are Int32 for uniformity).

### 9.3 New sim system (`src/sim/interact/`)

`applyInteract(w, inputs, index, tick)` runs as **SYSTEM 6.6**, AFTER verbs/breakables
(positions + grab linkage settled) and BEFORE fall-damage/game-layer. Two ordered phases,
both ascending-id:

1. **Targeting:** for each player, compute the interaction spot a fixed reach
   (`INTERACT_REACH ≈ 1.4u`) in front of `facing`, query the index, pick the single best
   interactable by a fixed priority (enemy-relevant first, then nearest within a frontal
   cone), and write `targetEntity` + `targetActions` from what the player is holding/carrying
   and what the target is. Deterministic tie-break by ascending id.
2. **Intent resolution:** on the `Primary`/`Secondary` press-EDGE (vs `prevButtons`, the same
   edge discipline the verbs use), resolve the contextual action: pick up a loose item into
   the first empty slot; place/use or throw the active item; `Open` is a stub that flips a
   door hook (see §3.4 DEFERRED). Body grab/carry/throw stays in the verb layer — the
   interact system only routes the *item* and *open* actions and maps the contextual buttons
   onto the existing body verbs where appropriate (so no verb code is duplicated).

The selected-slot scroll is applied first (clamp `selSlot` to `0..4` when `inp.slot>=0`).

### 9.4 Determinism proof (`src/sim/interact/prove.ts`, run via `prove:interact`)

Mirrors `sim/prove.ts`: a scene with players + Pickup drops; a seeded input stream that
scrolls slots and presses Primary/Secondary; PROOF 1 two-run determinism on the hash
stream, PROOF 2 rollback-torture (restore an earlier tick, re-advance, hashes must match)
across pickup/use/throw boundaries. A vitest `interact.test.ts` covers the unit semantics
(pickup fills a slot, throw-item empties it + spawns a free body, slot select clamps).

### 9.5 The DOOR hook (DEFERRED, §3.4)

`InteractAction.Open` and `targetActions` already carry an Open bit, and `applyInteract`
has a single `resolveOpen(w, player, target, tick)` seam that currently no-ops unless the
target has a (future) `BodyFlag.Door`. When the generation overhaul adds door entities +
a per-door hinge angle field, fill in `resolveOpen` (click-toggle first, drag-swing later)
— no other interaction code needs to change. The render hint already shows "Open" when the
sim reports the Open action, so the prompt lights up the moment doors exist.
