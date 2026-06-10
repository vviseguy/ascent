# Audit v2 — CAMERA, UX, HUD (doc 07, 00 §6.4)

All claims verified against current source (June 2026). Cited lines were read, not inferred from
AUDIT.md. Geometry derivations shown where the bug is numeric.

---

### aim-plane-at-deep-ground — world aim raycasts a plane 14m BELOW the tower; every aim is skewed, on every floor
- Severity: CRITICAL
- Intent: 07 §1.1 fixes yaw precisely so "throw stick = world direction" is muscle-memory; the
  renderer's own header promises "screen aim equals world direction under the tilted camera"
  (src/render/renderer.ts:22-23). Aim must resolve the cursor onto the surface the player stands on.
- Reality: the aim plane is built at `y = groundY` once (renderer.ts:138, set at renderer.ts:221-222
  from `terrain.groundY`). But for the compiled tower, `terrain.groundY` is the DEEP slab, not
  stratum 0: tower.ts:134-141 sets `terrain.groundY = deep = killPlaneY − 4`, and scene.ts:140 sets
  `killPlaneY = −10` → the aim plane sits at **y = −14**. The crew stands at y ≈ 0 (stratum 0) up to
  y ≈ 24 (stratum 4). `worldAimFrom` (renderer.ts:299-307) intersects the cursor ray with that y=−14
  plane and takes `atan2(hit − playerXZ)` with the player's x,z passed from loop.ts:53-57.
- Gap: with the camera's actual ray elevation ≈ 50.6° (see next finding), the hit point lands
  `(feetY + 14)/tan(50.6°)` ≈ **11.5u away from the cursor's true floor point at SPAWN**, growing to
  ≈ **31u on the top stratum** — displaced along camera-forward (−Z). A whole floor is only 15×15u
  (5 cells × CELL_SIZE 3, tower.ts:35), so the parallax error is 1–2× the entire playfield: nearly
  every cursor position resolves to "aim north/up-screen". Facing, throws, shoves and dash direction
  are all wrong from the first second of play and get worse as you climb. This is the single biggest
  "feel is off/askew" cause in the build.
- Fix sketch: set the plane height per query to the local player's feet: pass `originY` into
  `worldAimFrom` and do `this.groundPlane.constant = -originY` (feet = `py − halfHeight`) before
  `intersectPlane`. One line of plumbing in loop.ts:57.

### camera-pitch-framing-drift — the lookAt lift flattens the pitch to ~50.6° and frames the target at ~39.5%, not 55°/42%
- Severity: HIGH
- Intent: 07 §1.1 tilt "~55° down from horizontal"; §1.3 weighted target "42% from the bottom" of
  the frame (below center, more sky than floor).
- Reality: renderer.ts:818 offsets the camera by `(0, 0.819D, 0.574D)` — exactly 55° elevation from
  the target. But renderer.ts:819 then `lookAt(target + 0.12D up)`. View-axis pitch becomes
  `atan((0.819−0.12)/0.574) = atan(1.218) ≈ 50.6°` — **4.4° flatter than spec**. The target's
  angular offset below the axis is 55.0−50.6 = 4.38°; with FOV 40 (renderer.ts:188) the NDC offset
  is `tan(4.38°)/tan(20°) ≈ 0.21` → the target sits at **(1−0.21)/2 ≈ 39.5% from the bottom**, not
  42%. The inline comment even says "by *lowering* lookAt" while the code RAISES it — the sign
  confusion is visible in-source. (D_close is also 16 vs spec ≈14, renderer.ts:814.)
- Gap: the view is flatter than designed (more wall faces/horizon, fewer floor tops — worse route
  reading), and the subject sits ~2.5% lower than intended. The combination of "rotated-not-shifted"
  framing reads exactly as the owner described: the view box feels a bit askew, like the camera is
  looking slightly past the crew rather than holding them composed.
- Fix sketch: keep `lookAt(target)` so the pitch is a true 55°, and achieve the 42% framing by
  shifting the projection instead of rotating: `camera.setViewOffset(w, h, 0, -0.08*h, w, h)`
  (or, if rotation is acceptable, lift by 0.0925·D — that yields exactly 42% — and update the spec
  to a 51.7° pitch).

### boon-draft-invisible — boons draft and apply silently; the player can never see them
- Severity: HIGH
- Intent: 07 §2.4: a drafted boon is "a held/equipped diegetic object or aura" plus a bottom-right
  boon chip stating the boon and *why* you have it ("Trailing boon") — pillar 6's fairness guarantee
  is explicitly a UI obligation. 03 makes the draft a core progression beat.
- Reality: match.ts:184-215 (`runDrafts`) draws an offer and auto-picks the best card into
  `crew.boons` each milestone. Nothing in the render layer reads it: a grep for
  `boon|Boon|draft|Draft` over src/render returns zero hits; `CrewState.offer`/`boons`/`momentum`
  (match.ts:79-84) have no consumers outside the sim.
- Gap: the entire progression/rubber-band system is imperceptible. A player gains "Cannon Arm" or
  "Featherweight Anchor" and feels nothing change knowingly; the draft milestone beat (a designed
  dopamine moment) does not exist on screen.
- Fix sketch: on `lastDraftFloor` change, surface a 3s toast/chip (name + tier + tag one-liner) from
  the loop's standing push (loop.ts:74-83 already crosses this boundary each tick); keep a persistent
  small boon list under the standings rail.

### ability-cooldown-invisible — no cooldown ring, so a tapped ability silently does nothing
- Severity: HIGH
- Intent: 07 §2.4 foot-ring cooldowns: "full = ready, sweeping = on cooldown", readable by you and
  teammates; the hands-full state greys out ability segments.
- Reality: the sim has full cooldown truth — `w.abilityCdUntil` (state.ts:229-233), gated in
  abilities.ts:88-90,146, with 3–20s cooldowns (verbs/config.ts:245-281) — but no render code reads
  it (grep `abilityCdUntil|recallReadyAt` over src/render: zero hits). Ability is a TAP on the same
  right button whose HOLD is rush (input-controller.ts:79), so a tap during cooldown produces no
  feedback of any kind.
- Gap: the player cannot distinguish "ability on cooldown" from "the button is broken" from "I held
  too long and dashed instead". Role abilities — a headline feature — feel unreliable.
- Fix sketch: draw a foot-ring arc on the local StubbyCharacter from
  `clamp01((abilityCdUntil − tick)/CD)` (renderer already has per-body ground rings to copy:
  renderer.ts:336-339); flash the ring red on a gated press edge.

### beacon-recall-invisible — the Recall Beacon has zero world or HUD presence and recall is an instant teleport
- Severity: HIGH
- Intent: 07 §2.5: planting shows a crew-colored light-pillar visible across the shaft; a beacon
  marker on the altitude rail; recall is a hold-~0.8s radial showing destination ("RECALL ↓ −14m");
  a crew cooldown clock; recallers "coalesce in".
- Reality: beacon.ts:53-76 stores `beaconX/Y/Z` and teleports on a press edge with zero channel
  time; the only render-side "beacon" match is the Anchor's cosmetic ground ring, an unrelated
  visual (renderer.ts:335-339). No light pillar, no marker, no cooldown display, no destination
  readout — grep `beacon` over src/render confirms nothing reads `cs.beacon*`.
- Gap: pressing Q either teleports you somewhere you can't predict or (cooldown/no-beacon,
  beacon.ts:63-64) does nothing — both invisibly. The Anchor's rally-point fantasy (pillar 1) is
  mechanically present but experientially absent.
- Fix sketch: render a tall emissive cylinder at `(beaconX, beaconY, beaconZ)` when
  `beaconTick >= 0`; add a "RECALL READY in Ns" line to the HUD from `recallReadyAt`; later convert
  the teleport to the spec'd hold-radial.

### onboarding-teaches-wrong-controls — the two on-screen prompts contradict each other about the core verbs
- Severity: HIGH
- Intent: 07 §5.1 just-in-time, accurate verb teaching; the first 60 seconds are "make-or-break"
  (§9). At minimum the prompts must match the actual bindings.
- Reality: the actual scheme is mouse-first — LMB hold=grab/release=throw, RMB tap=ability/
  hold=rush (input-controller.ts:76-83). The bottom-left legend teaches this correctly
  (main.ts:57-59). But the renderer's onboarding panel — the larger, center-screen one — teaches
  "hold **K** to grab & release to throw, **E** for your role ability" (renderer.ts:926-928), the
  legacy keyboard fallbacks. The input-controller's own header comment also still documents the OLD
  scheme ("J / LMB : RUSH · K / RMB (hold) : GRAB", input-controller.ts:16).
- Gap: a new player reads two simultaneous instructions that disagree about the game's most
  important verb. Nothing is just-in-time, nothing fades-on-success (the panel fades on a 14s timer,
  renderer.ts:888-893), and no STRUGGLE/jump prompt ever appears contextually.
- Fix sketch: make the onboarding panel state the mouse-first bindings (copy main.ts:57-59's text);
  fix the stale header comment. Just-in-time prompts can come later.

### dolly-ignores-vertical-spread-no-offscreen-affordances — a crew split across floors never widens the frame, and off-screen members have no markers
- Severity: MEDIUM
- Intent: 07 §1.4 `extent = max(verticalSpread, horizontalSpread · aspectComp)`; §1.6 mandates
  Anchor altitude pip, scout leash, and teammate edge chevrons instead of infinite zoom; §1.2
  centers the vertical 2/3 between Anchor and local player.
- Reality: the dolly extent is `max(maxX−minX, maxZ−minZ, 0)` — X/Z only (renderer.ts:813-814).
  Vertical separation contributes nothing. None of §1.6 exists (no chevron/leash/edge-marker code
  anywhere in src/render). The vertical 2/3 Anchor-bias is also not implemented (plain weighted
  centroid, renderer.ts:460-464,807 — weights 3.0/1.5/1.0 do match §1.2).
- Gap: in THE core play pattern (you scout a floor or two up while the Anchor waits), the camera —
  anchored near the heavy-weighted Anchor — drops you off the top of the frame at ~2.5–3 floors of
  separation (at D=16, a body ~+18u maps ≈ 28.8° above axis vs ~24.4° available), with no indicator
  of where you or the Anchor are. Also no fall-follow clamp (§1.3) and Z-spread needs ~37% more
  dolly than X-spread under the tilt but is treated identically.
- Fix sketch: include `(maxY−minY) · k` in the extent (k≈1.5 to account for foreshortening), and add
  a minimal screen-edge chevron for any weighted body whose projected NDC leaves ±0.95.

### hitstop-does-not-hold-frame — "hitstop" freezes the sub-tick alpha but bodies keep moving tick-to-tick
- Severity: MEDIUM
- Intent: 07 §4.4: "on hitstop we hold the displayed snapshot frame, then catch interpolation up" —
  a visible freeze that makes big impacts hit.
- Reality: renderer.ts:419 holds only the interpolation `alpha`, but `commitTick` keeps advancing
  the interpolation endpoints every sim tick during the hold (loop.ts:63-70 calls it
  unconditionally; renderer.ts:388-399 shifts px→ppx each tick). During a 90ms "hold"
  (HITSTOP_HARD_MS, renderer.ts:74), ~5 ticks pass, so the displayed position
  `ppx + (px−ppx)·heldAlpha` keeps moving at essentially full speed — just quantized to tick steps.
- Gap: the signature impact beat reads as a 90ms frame-rate stutter, not a freeze. Anchor hard
  landings and big throws lose their designed punch.
- Fix sketch: while hitstop is active, skip applying `commitTick`'s new snapshot to the displayed
  pair (buffer it; on expiry, jump-commit and resume) — sim untouched, presentation truly held.

### throw-arc-pierces-floors-no-reticle — the aim arc terminates at y=−14 and there is no landing reticle
- Severity: MEDIUM
- Intent: 07 §3.2: the thrower sees a predicted arc with a **landing reticle color-coded** green/
  yellow/red (safe/edge/void) — explicitly "the throw tutorial" (§5.1) and the Anchor-risk read.
- Reality: the arc loop breaks only when `py < this.groundY` (renderer.ts:794-799), and
  `this.groundY` is the deep slab at −14 (see finding 1) — so on any stratum the dotted arc passes
  straight through the slab the player stands on and continues ~14m below it. No reticle, no
  safe/void color coding exists (color encodes charge only, renderer.ts:801). The struggle read is a
  bare magenta dot, not a fill-meter (renderer.ts:776-779).
- Gap: throws — the game's signature risk verb — can't be aimed by landing point; "don't throw your
  Anchor into the void" is never taught visually.
- Fix sketch: terminate the arc at the first terrain-AABB top below the sample point (the renderer
  already has `terrain.solids` at buildTerrain time — cache them) and drop a ring mesh there tinted
  by gap/edge proximity.

### camera-smoothing-framerate-dependent — per-frame lerp constants change the camera's character with display Hz
- Severity: MEDIUM
- Intent: 07 §1.3/§1.4 specify time-based smoothing (~120ms up / ~260ms down; dolly out ~180ms,
  in-lag ~500ms with hysteresis).
- Reality: `this.camTarget.lerp(target, up ? 0.18 : 0.10)` and `camDist += (want−cur)*0.08` are
  applied once per rendered frame with no dt compensation (renderer.ts:809-815). At 60fps that's
  ≈83ms/157ms (already snappier than spec); at 144Hz it halves again to ≈35ms/65ms. The dolly is
  symmetric — zoom-in snaps as fast as zoom-out, the exact "pumping" §1.4's hysteresis exists to
  prevent. The up/down branch also gates X/Z smoothing, not just vertical.
- Gap: the camera feels different on every monitor, and twitchier than designed everywhere —
  another plausible contributor to "the view feels off".
- Fix sketch: convert to exponential time constants: `k = 1 − exp(−dt/τ)` with τ_up=120ms,
  τ_down=260ms, τ_dollyOut=180ms, τ_dollyIn=500ms (dt already computed at renderer.ts:413).

### anchor-status-states-incomplete — only SECURE/GRABBED/DOWNED exist; no CARRIED/AIRBORNE/EXPOSED, no rescue CTA
- Severity: MEDIUM
- Intent: 07 §2.2: state ring with SECURE / EXPOSED / GRABBED (+struggle meter) / CARRIED (ally
  green vs rival red) / AIRBORNE (landing safety) / DOWNED countdown / DEATH warning; escalation +
  directional rescue CTA when grabbed; delta ticker on altitude.
- Reality: renderer.ts:847-852 derives exactly three states (`downed ? 'DOWNED' : grabbed ?
  'GRABBED' : 'SECURE'`), and "GRABBED" actually fires for a *friendly* carry too (it tests
  `grabbedBy !== NO_ENTITY` only) — carrying your own Anchor up the tower shows the warning color
  (orange, renderer.ts:851) while doing the game's core co-op act. No delta ticker, no CTA.
- Gap: the HUD's "emotional core" mislabels the most common good action (escort carry) with a
  threat color, and gives no read for airborne/exposed drama beats.
- Fix sketch: add CARRIED (green) when the grabber's `crewId` matches the Anchor's
  (`w.crewId` is in state — renderer.ts:318 already reads it), AIRBORNE from
  `!Grounded && !grabbedBy`, and tint by relationship.

### standings-rail-bare — an unlabeled track with one bead; no summit line, units, or motion glyphs
- Severity: LOW (single-crew today; rises to MEDIUM when crews >1)
- Intent: 07 §2.1: summit line with target readout in race mode, meter/floor readouts, motion
  glyphs (▲▬▼✕), crew shape+color redundancy, log compression.
- Reality: renderer.ts:861-885 renders color beads positioned by `committed/target` on a bare 3px
  track (renderer.ts:915-921). No summit marker or "40m" readout, no altitude numbers, no glyphs,
  no climbing/falling indication; with one crew it's a single "YOU" bead on an anonymous line.
- Gap: "how far to the win" — the race's central question — is not answerable from the rail; the
  win banner (renderer.ts:843-846) is the first time the target's existence is visible.
- Fix sketch: add a labeled summit tick ("TOP 24m") at 100% and a small "+Xm" readout beside the
  local bead; glyph by comparing committed against a 1s-ago sample.

### leash-color-ignores-crew — a teammate's friendly carry would draw the hostile leash
- Severity: LOW (latent — teammates are input-idle in the current single-player build)
- Intent: 07 §3.2: green leash = friendly carry, red = hostile, "consistent for every mass tier".
- Reality: renderer.ts:771-773: `const friendly = id === localId; // (crew identity not yet
  modeled...)` — the comment is stale; `w.crewId` exists and is read 450 lines earlier
  (renderer.ts:318). Any non-local holder (teammate, future rival or net peer) draws
  `leashHostile`.
- Gap: the moment a second human joins, every ally assist reads as an attack.
- Fix sketch: `friendly = w.crewId[id] === w.crewId[held]` (objects: crew of holder vs local crew).

### accessibility-unexposed — the shake API exists but no setting can reach it; no UI scale, colorblind, or motion options
- Severity: LOW
- Intent: 07 §6 / 00 §6.4: shake slider, reduced motion, UI scale 75–150%, colorblind redundancy,
  reachable from lobby + pause.
- Reality: `setShakeIntensity` exists (renderer.ts:212-218) but has zero callers (grep: only the
  definition); there is no settings/pause UI at all (main.ts builds canvas+HUD+legend only,
  main.ts:23-45). Crew/role identity currently relies on color + silhouette (character.ts:28-38);
  no second channel like glyphs on rings.
- Gap: none of §6 is reachable; acceptable for a sandbox, but the hitstop/shake defaults are
  un-optoutable.
- Fix sketch: a tiny pause overlay (Esc) with shake slider wired to `setShakeIntensity` is the
  smallest honest start.

---

**Dimension verdict:** The camera rig is recognizably the spec'd design (weights, dolly, asymmetric
smoothing, shake budget all present) but three real geometric defects — an aim plane 14m below the
tower, a pitch/framing rotation error, and Hz-dependent smoothing — combine to make aiming and
framing feel "askew" everywhere. The HUD covers the Anchor-score heartbeat but the build's other
systems (boons, abilities, beacon, cooldowns) are *invisible*: they run correctly in the sim and
never reach the player's eyes, which is this dimension's biggest intent gap after the aim bug.
