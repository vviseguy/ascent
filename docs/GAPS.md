# ASCENT — GAPS.md (intent-audit v2, authoritative)

Lead synthesis of the six dimension reports in `docs/audit2/` (traversal-tower, loop-advancement,
camera-ux-hud, verbs-roles-feel, race-multiplayer, spectacle-audio). Every CRITICAL/HIGH finding
below was **independently re-verified against current source** (June 2026, `main` @ 618e24f) by the
synthesizer; duplicates across dimensions are merged. AUDIT.md (v1) is stale — see "Fixed since
AUDIT.md" at the bottom for what NOT to re-litigate.

## Executive summary

The spec promises a multi-crew vertical escort RACE: crews climb one luminous coalescing tower,
carrying a heavy gold Anchor across gaps it cannot cross alone, under pressure from rival Anchors,
drafting boons that change how they climb. The build delivers a beautifully-proven escort *physics
toy* on a tower that **cannot be climbed** (every stratum is a sealed ceiling, every edge an
unguarded cliff), played by one live body among statues, with no rivals, no audio, no boon effects,
no results screen — and an aim system whose ground-plane sits 14 m below the floor. The engine is
~90% spec-faithful and proven; the GAME around it is missing, and most of it is wiring, not invention.

---

## PART 1 — The owner's three seeds, verified root causes

### Seed 1: "The view box is a bit askew" — THREE compounding geometric defects, all confirmed

1. **The aim plane is 14 m below the tower (the dominant cause).** `worldAimFrom` raycasts the
   cursor against `groundPlane`, whose constant is set ONCE from `terrain.groundY`
   (renderer.ts:221-222, 299-307). For the compiled tower, `terrain.groundY` is the **deep slab**:
   `deep = killPlaneY − 4` (tower.ts:136-141) with `killPlaneY = −10` (scene.ts:140) → the plane is
   at **y = −14** while the player stands at y ≈ 0..24. At the camera's actual 50.6° ray elevation,
   the cursor's hit point lands ~11.5 u up-screen of the true floor point at spawn (~31 u on the top
   stratum) — on a playfield only 15 u wide. Facing, throws, shoves, and dash direction are biased
   north/up-screen from the first second. The throw arc shares the bug (terminates at y = −14,
   renderer.ts:795-798).
2. **The camera "frames 42% up by lowering lookAt" — but the code RAISES it, rotating instead of
   shifting.** Position offset `(0, 0.819D, 0.574D)` is a true 55° (renderer.ts:818), but
   `lookAt(target + 0.12D up)` (renderer.ts:819) flattens the view pitch to
   `atan((0.819−0.12)/0.574) ≈ 50.6°` (spec: 55°, 07 §1.1) and puts the subject at ~39.4% from the
   bottom (spec: 42%, 07 §1.3). More horizon, fewer floor tops, subject slightly low — the precise
   "looking slightly past the crew" feel. (`D_close` is also 16 vs spec ≈14, renderer.ts:814.)
3. **Smoothing is per-frame, not per-second** — `lerp(target, 0.18/0.10)` and `dist*0.08` with no
   dt compensation (renderer.ts:809-815): the camera is twitchier than spec at 60 fps and twice as
   twitchy at 144 Hz, with a symmetric dolly (no §1.4 hysteresis).

### Seed 2: "No way to advance to the next level" — LITERAL, and the win is also a dead end

1. **The compiled tower has NO route up. The climb is physically impossible.** `compileTower`
   pushes a solid slab under **every** cell of **every** stratum (tower.ts:97-104, unconditional
   loop) — so each next floor is an unbroken ceiling 5.5 u up. Jump apex: 9²/(2·22) ≈ **1.84 u** for
   a Player, ≈ **0.71 u** for the Anchor (config.ts:37, 43-48; gravity −22, step.ts:39). The header
   comment promises "The EXIT cell of each stratum has a ramp/opening up to the next stratum's
   entry" (tower.ts:20-21) but **no such code exists**: `floor.exits` is read nowhere in src/game
   (grep: only src/floor), and no ramp/stair/hole/lift geometry is ever emitted. The win height is
   the top stratum's base (scene.ts:164-168) — unreachable. The project's own proof must teleport
   the Anchor to "climb" (`sc.sim.world.py[a] = y`, src/game/prove.ts:190-195).
2. **Second reading also true: winning leads nowhere.** `evaluateWin` sets `winner`/`endedTick`
   (match.ts:217-227), `stepMatch` freezes standings (match.ts:152), but the sim runs forever, the
   loop never stops (`stop()` exists at loop.ts:91, zero callers), and the only consequence is a
   permanent "YOUR CREW WINS!" string (renderer.ts:843-846, never hidden). No results, no restart,
   no next tower (main.ts:23-45 wires nothing); a new run = page reload.

### Seed 3: "No full-height walls around the outside" — correct; every edge is a kill-plane cliff

`compileTower` emits **zero** perimeter geometry: seam lips are generated only between in-bounds
cell pairs (`if (nx >= floor.width || ny >= floor.height) continue;` tower.ts:113), so the outer
boundary of every 15×15 u stratum is a sheer drop past the kill-plane at −10 (scene.ts:140) →
death (survival.ts:58-67). The spec demands the opposite twice over: 09 §4's `layoutShell` emits
"outer walls", and GENERATION-SOLVABILITY's invariant ("players can ALWAYS go around the
edge/perimeter") makes the perimeter the *safe* fallback route. Worse, an Anchor that walks off
with no beacon planted enters an **infinite invisible death loop** (see H1).

---

## PART 2 — All findings by severity (deduped, re-verified)

### CRITICAL

#### C1 `no-route-up` — the tower cannot be ascended; the core verb does not exist
- Intent: climbing IS the game (00 pillar 1; 01 §2). 09 §5 carves 2-4 routes per stratum
  (RAMP/STAIR/LIFT/SPIRE); 02 §5.2 throws place allies "on the floor above".
- Reality: solid slab under every cell, no exit opening or ramp ever emitted (tower.ts:97-104;
  promised at tower.ts:20-21, unimplemented; `exits` unread in src/game). 5.5 u clearance vs
  1.84 u/0.71 u jump apexes. Win target unreachable (scene.ts:164-168).
- Gap: the game's single fantasy — climb — cannot be performed at all.
- Fix: in `compileTower`, skip the slab at each stratum's entry cell (s>0) and emit a 3-4-box
  stepped ramp from stratum N's exit cell through stratum N+1's entry hole (align
  `floors[s].exits[0]` with `floors[s+1].entry`).
- Cites: src/game/tower.ts:20-21, 97-104; src/game/scene.ts:164-168; src/sim/verbs/config.ts:37,
  43-48; src/sim/world/step.ts:39; src/game/prove.ts:190-195.

#### C2 `no-perimeter-containment` — every stratum edge is an unguarded cliff to the kill-plane
- Intent: 09 §4 outer walls; GENERATION-SOLVABILITY safe-perimeter invariant; 01 §4.3 ring-outs
  are *placed, deliberate* risk.
- Reality: no boundary walls (tower.ts:113 skips out-of-bounds seams); edge → kill-plane −10 →
  death (scene.ts:140; survival.ts:58-67). With mouse-first target-velocity movement, one
  overshoot kills.
- Gap: the designed universal-fallback route is instead the most lethal place in the game.
- Fix: emit a wall AABB ring (≥2 u tall) per stratum footprint in `compileTower` (4 boxes), with
  openings only where designed.
- Cites: src/game/tower.ts:109-128; src/game/scene.ts:140; src/game/survival.ts:58-67.

#### C3 `solo-time-trial` — no rival crews exist; the race, rubber-banding, and PvP are all dead code
- Intent: "PURE RACE, NO CHASE" (00 pillars 5/6/9/10); 04 §0 one shaft, every crew climbs it;
  rubber-banding "guarantees flashpoints" (04 §5.2).
- Reality: `buildTower` has no crew-count parameter and hardcodes `numCrews: 1`
  (scene.ts:129, 170); main.ts:32 calls only it (`buildSandbox`'s `numCrews` is dead code from the
  app's view). Consequently three whole proven systems are dead branches: PvP grab tier 0 "enemy
  Anchor = the prize" (verbs.ts:519-535), regrab immunity (verbs.ts:542), hostile-vs-friendly
  struggle (verbs.ts:757) have never executed against a real rival; rubber-banding is
  mathematically dead — deficit ≡ 0 with one crew (match.ts:189-197) and `catchupFactor` returns 0
  inside the 2-floor deadzone (boons.ts:75-78), so comeback pool / 4-card offers / rerolls are
  unreachable (boons.ts:99-106, 122).
- Gap: every competitive system the spec calls the game's identity is untestable by playing; the
  standings rail shows one bead — yours.
- Fix: add `numCrews` to `buildTower` (per-crew entry spawn, `crewId: c`, per-crew anchorIds);
  then a human (netcode, H12) or a deterministic ghost crew (needs a DECISIONS-LOG sign-off —
  pillar 3 bans AI; a replayed human input stream is not AI but is also not in the spec).
- Cites: src/game/scene.ts:129, 149-162, 170; src/main.ts:32; src/sim/verbs/verbs.ts:519-535,
  542, 757; src/game/match.ts:189-197; src/game/boons.ts:75-78.

#### C4 `win-is-a-dead-end` — no results, no restart, no next tower; and idling 10 minutes WINS
- Intent: 01 §7.1 `WIN → RESULTS → leaderboard`; 04 §6.3 intermission → fresh tower.
- Reality: win = permanent banner over a still-running sim (match.ts:152, 217-227;
  renderer.ts:843-846; loop.ts:91 `stop()` uncalled; main.ts:23-45 no restart path). Worse: the
  matchCap branch initializes `best = 0`, so at the invisible 10-minute cap (scene.ts:169; no HUD
  timer anywhere — loop.ts:77-83 pushes no tick, renderer.ts:896-931 has no clock element) crew 0
  is crowned **even at committed height 0** (match.ts:229-236) — doing nothing wins.
- Gap: the session has no shape, the climb no payoff, and the failure mode is absurd.
- Fix: on `winner >= 0` show a results overlay + "Climb again (R)" → `loop.stop()`, rebuild with
  `seed+1n`, restart. Make the cap a LOSS ("TOWER CLOSED") when target unreached; render mm:ss
  from tick/matchCap.
- Cites: src/game/match.ts:152, 217-236; src/render/renderer.ts:843-846; src/render/loop.ts:77-91;
  src/main.ts:23-45; src/game/scene.ts:169.

#### C5 `boon-economy-is-fiction` — boons have zero gameplay effect, and the draft is invisible & auto-picked at tick 0
- Intent: docs/03 entire: boons deepen grab/throw/carry/build/route/protect; 01 §1 beat 6 = the
  1-of-3 crew draft; 03 §2.1 first draft at floor 10, "no menu" opening minute; 07 §2.4 boon chips.
- Reality: three confirmed layers of absence. (a) **Inert**: drafting appends ids to `crew.boons`
  (match.ts:208-213) and *nothing reads them* — grep over src/sim for boon/draft/momentum: **zero
  matches**; `slipstreamBonus` (boons.ts:151-153) has zero callers; `momentum` is write-only
  (match.ts:213); boons.ts:15-17 admits "effects are applied by readers" — none exist. (b)
  **Invisible**: no render file references boons/draft (grep src/render: zero); the loop pushes no
  boon data (loop.ts:77-83). (c) **Auto-picked with no input**: highest tier auto-chosen
  (match.ts:200-211); no Pick channel exists in the input (input.ts:19-32); and with
  `lastDraftFloor = -1` (match.ts:104) + `draftEveryFloors: 1` (scene.ts:174), milestone 0 fires
  **on tick 0**.
- Gap: the entire in-run progression + comeback economy is scoreboard fiction a player cannot even
  see; beat 6 of the six-beat loop is absent end-to-end.
- Fix: wire 2-3 effects as the pattern (Strong Toss → throw impulse in verbs.ts; Sticky Boots →
  brake; Slipstream → MAX_SPEED mult via a per-crew modifier derived from hashed MatchState);
  surface `crew.offer` as a 3-card overlay with keys 1/2/3 + 6 s auto-pick fallback; skip the
  milestone-0 draft.
- Cites: src/game/match.ts:104, 184-215; src/game/boons.ts:15-17, 151-153;
  src/sim/world/input.ts:19-32; src/render/loop.ts:77-83; src/game/scene.ts:174.

#### C6 `one-live-body-among-statues` — only the Runner is driven; half the cast never spawns; struggle/recall permanently dead
- Intent: docs/02 §6-§7 six asymmetric identities whose interdependency web IS the game (pillar 8);
  02 §2.4 STRUGGLE is a core verb; the legend promises Q recall (main.ts:59).
- Reality: `buildTower` spawns `CREW_ROLES[i % 5]` with `crewSize: 3` (scene.ts:41, 149-155;
  main.ts:32) → cast = Runner, Bulwark, Mender, Anchor; **Engineer and Breaker never exist**. Only
  `frame[localPlayerId]` ever gets input (`frame.fill(undefined)`, loop.ts:64-65) — every teammate
  and the Anchor are input-less statues. Cascading consequences, all confirmed: Mender revive /
  Bulwark Unhand / Engineer bridge / Breaker shove are implemented (abilities.ts:148-155) but
  unreachable; STRUGGLE can never fire (nothing can grab you); Q is dead forever for the local
  player because only an Anchor plants the beacon (beacon.ts:52-60) and the Anchor has no input, so
  recall exits at `beaconTick < 0` (beacon.ts:63) — a third of the on-screen legend is false.
- Gap: role asymmetry, the rescue verbs, and the rally-point fantasy are unexperiencable; the
  "crew" is scenery you can pick up.
- Fix: crewSize 5 (all roles) + a debug Tab key cycling `localPlayerId`; have the inert Anchor
  auto-plant its beacon at spawn/stratum crest so Q works (also fixes H1).
- Cites: src/game/scene.ts:41, 149-162; src/main.ts:32; src/render/loop.ts:64-65;
  src/sim/verbs/abilities.ts:148-155; src/game/beacon.ts:52-63.

#### C7 `aim-plane-at-deep-ground` — every aim is skewed on every floor (see Seed 1.1)
- Fix: set `groundPlane.constant` per query to the local player's feet Y (pass originY through
  loop.ts:57 → `worldAimFrom`); terminate the throw arc against terrain AABB tops, not `groundY`.
- Cites: src/render/renderer.ts:138, 221-222, 299-307, 795-798; src/game/tower.ts:136-141;
  src/game/scene.ts:140; src/render/loop.ts:53-57.

#### C8 `vertical-coop-verbs-have-no-input-and-no-sites` — hand-up / gap-lock / bridge / catch can never occur
- Intent: 02 §5.2 the hand-up ("THROW upward, aim ≥ 50°"); 02 §2.1 / 01 §2.1 the Anchor's gap-lock
  is "the source of all interdependence"; 07 §9 t=30-42 "the Anchor hits a gap it can't cross".
- Reality: (a) **no aim elevation exists** — `PlayerInput.aim` is one planar angle (input.ts:50);
  every throw launches at fixed 38° + jitter (verbs.ts:922-924, config.ts:96); (b) **no sites** —
  no holes between strata (C1) and no chasms within a floor: GAP edges compile to nothing while
  both adjacent cells stay fully slabbed, i.e. **GAP = flush solid floor, byte-identical to WALK**
  (tower.ts:116 + 97-104); (c) the Engineer doesn't spawn (C6). The catch-latch, train, and bridge
  systems are implemented and proven (config.ts:69-86, abilities.ts) — with nowhere to matter.
- Gap: the co-op-carry heart of the game (pillars 1/2) cannot occur; solo walking is the only verb
  the terrain ever requests, and even it can't ascend.
- Fix: C1's holes/ramps + H2's real chasms give the sites; add quantized aim elevation to
  PlayerInput (e.g. from cursor distance) so charged throws can loft ≥50°.
- Cites: src/sim/world/input.ts:47-53; src/sim/verbs/verbs.ts:922-924; src/game/tower.ts:97-104,
  116; src/sim/verbs/config.ts:96.

#### C9 `audio-zero` — the game is completely silent; half the designed readability bandwidth is absent
- Intent: 08 §0 "Sound is a HUD" — Anchor lane (never-duckable bus B0), the four verb signatures
  ("a blindfolded player should narrate the fight"), pacing score, materialization sweep (08 §7).
- Reality: zero audio anywhere. Grep src/ for AudioContext/Audio/mp3/ogg/wav/audio
  (case-insensitive): **no matches**; index.html is a bare `#app` div; package.json deps are
  exactly `three` + `peerjs` (package.json:34-37). No bus, no sample, no synthesis.
- Gap: grabs, throws, landings, the recall plant, materialization, the win — all mute; every
  action lands unacknowledged; the Anchor has no sonic presence.
- Fix: one AudioContext (resume on first gesture) + master limiter + ~10 synthesized one-shots
  driven from the existing `detectEvents` diff (renderer.ts:484-545 already detects
  land/throw/grab/rush); minimal set = 4 verb signatures + Anchor CLAMP variant + landing thud +
  beacon chime + win sting.
- Cites: package.json:34-37; index.html:12-15; src/render/renderer.ts:484-545; grep results.

### HIGH

#### H1 `anchor-ring-out-is-an-invisible-infinite-death-loop` — and it soft-locks the run
- Intent: 01 §4.2 Anchor true-death is the game's biggest swing but *recoverable* (beacon respawn,
  altitude penalty); 07 §4.5 ring-out gets slow-mo/klaxon drama; 01 §7.3 respawn floor never drops
  below the last milestone.
- Reality: with no beacon (the default — see C6), a kill-plane'd Anchor takes the last-resort
  respawn branch (the `anchorId !== id` guard at survival.ts:116 excludes itself): `y = 1` with
  **x/z unchanged from where it fell** (survival.ts:119-123) — necessarily off the footprint — so
  it falls past the kill-plane again and re-dies every ~4 s, forever. Crewmates then respawn "near
  the Anchor" (survival.ts:116-118), i.e. into the same void. Recall can't regroup (beacon.ts:63).
  And the renderer has **no death/ring-out detection at all** (detectEvents handles only
  land/throw/grab/rush, renderer.ts:484-545) — no slow-mo, no banner, nothing.
- Gap: the spec's most dramatic moment is a silent soft-lock; one slip off the (unwalled, C2) edge
  ends the run with zero explanation.
- Fix: auto-plant the beacon at each stratum crest (one block in `stepMatch` — gives 01 §7.3
  checkpoints for free); clamp the no-beacon fallback to the nearest stratum entry
  (`tower.entryXZ` already exists); add a render-side kill-plane event (banner + slow-mo).
- Cites: src/game/survival.ts:110-134; src/game/beacon.ts:52-63; src/render/renderer.ts:484-545.

#### H2 `gates-flattened` — GAP/BREAK/BUTTON/WEIGHT semantics did not survive compilation
- Intent: edge kinds are the floor's gameplay (src/floor/types.ts:26-46; GENERATION-SOLVABILITY);
  the Anchor "cannot self-clear a 'big' gap" — JUMP_MUL's own comment says so (config.ts:39-48).
- Reality: `if (kind === 'WALK' || kind === 'GAP') continue;` (tower.ts:116) + unconditional slabs
  → GAP compiles to flush solid floor identical to WALK. BREAK/BUTTON/WEIGHT *and absent edges*
  (maze walls) all become the same inert 0.6 u lip (tower.ts:40-41, 117-127) that even the Anchor
  (apex 0.71 u) jumps. No breakable/button/weight state exists in the sim.
- Gap: the Anchor's defining constraint has zero terrain expression — carries, throws, bridges,
  Breakers are never *needed*; the generator's proven route structure is cosmetic.
- Fix: shrink slab tiles ~1 u each side of a GAP seam so a real ≥2 u chasm exists (Player clears,
  Anchor cannot); raise BREAK/no-edge lips to ≥2.5 u walls; hook BREAK to a breakable body later.
- Cites: src/game/tower.ts:40-41, 97-104, 116-127; src/sim/verbs/config.ts:39-48.

#### H3 `verifier-promise-severed` — solvability is proven on the graph, never checked in geometry
- Intent: GENERATION-SOLVABILITY: "never trust the generator — prove it independently"; the
  invariant is a solo heavy Anchor reaching an exit *in the placed geometry*.
- Reality: the verifier (src/floor/verify.ts) runs on the Floor graph only; `compileTower` is a
  lossy unchecked projection (drops exits, flattens gates per H2, adds no vertical links). Nothing
  verifies the compiled AABBs admit the proven path — today they admit every intra-floor path and
  no inter-floor path.
- Gap: the flagship engineering promise doesn't apply to the thing the player walks on; once C1/H2
  land, a compiler bug can ship an untraversable floor with the verifier green.
- Fix: add a geometry-level BFS in src/game/prove.ts using Anchor capabilities (step height, apex
  0.71 u) from stratum-0 entry to the top, across many seeds.
- Cites: src/floor/verify.ts; src/game/tower.ts:81-142.

#### H4 `camera-pitch-framing-drift` — rotated-not-shifted framing (Seed 1.2)
- Fix: `lookAt(target)` for a true 55° + `camera.setViewOffset(w, h, 0, -0.08*h, w, h)` for the
  42% framing; D_close 16 → ~14.
- Cites: src/render/renderer.ts:814, 816-819 (the inline comment says "lowering lookAt"; the code
  raises it).

#### H5 `ability-feedback-absent` — cooldowns invisible and the player's ONE ability is a no-op
- Intent: 07 §2.4 foot-ring cooldowns ("full = ready, sweeping = on cooldown"); 02 §6.1 Runner
  Mark "lights it on the crew HUD for 4 s".
- Reality: `w.abilityCdUntil` is fully maintained in-sim (abilities.ts:89-91, 146) but **no render
  code reads it** (grep src/render: zero hits). And `tryRunnerScout` writes `w.scoutMark`
  (abilities.ts:431) which is **consumed by nothing** anywhere (grep: state.ts declarations +
  abilities-prove assertion only). The local player IS the Runner — so tap-Right either silently
  sets an invisible integer or is silently cooldown-gated; the two are indistinguishable from a
  broken button.
- Gap: role abilities — a headline feature — feel unreliable/broken; players will (correctly)
  conclude the button does nothing.
- Fix: renderer draws a pulsing ring/label at `w.scoutMark[localId]` for ~4 s; foot-ring cooldown
  arc from `(abilityCdUntil − tick)/CD` on the local character; red flash on a gated press.
- Cites: src/sim/verbs/abilities.ts:89-91, 146, 431; src/sim/world/state.ts:257; grep src/render.

#### H6 `beacon-invisible` — the Recall Beacon has zero world/HUD presence; recall is an unexplained teleport
- Intent: 07 §2.5 + 06 §1.5.4: a crew-color light pillar "visible across the shaft — the single
  brightest crew-color feature"; hold-radial recall with destination readout; 08 §6.3 plant chime.
- Reality: beacon.ts:54-75 writes `beaconX/Y/Z` and teleports on a press edge; grep `beacon` over
  src/render returns only comments about the Anchor's cosmetic gold ring (renderer.ts:18, 335) —
  no pillar, marker, cooldown display, or destination readout exists.
- Gap: Q either teleports you unpredictably or does nothing — both invisibly.
- Fix: a pooled additive cylinder at the beacon when `beaconTick >= 0` + a "RECALL READY in Ns"
  HUD line from `recallReadyAt`. (~20 lines; crews already cross the loop boundary.)
- Cites: src/game/beacon.ts:54-75; src/render/renderer.ts:18, 335.

#### H7 `onboarding-teaches-wrong-controls` — the two on-screen prompts contradict each other
- Intent: 07 §5.1 just-in-time accurate verb teaching; the first 60 s are make-or-break (§9).
- Reality: the center onboarding panel teaches legacy "hold **K** to grab… **E** for your role
  ability" (renderer.ts:926-928) while the bottom-left legend correctly teaches mouse-first
  (main.ts:57-59). The input-controller's own header still documents the old scheme
  (input-controller.ts:16) that its code contradicts (lines 76-83). Bonus lie: the legend promises
  "a tap = shove", but SHOVE fires only on a `Button.Throw` press-edge (verbs.ts:813-816) and
  Throw maps only to keyboard **F** (input-controller.ts:78) — an LMB tap is a grab-cancel,
  no shove (see M4).
- Fix: make the onboarding panel mirror main.ts's text; fix the stale header; remove or implement
  "tap = shove" on mouse.
- Cites: src/render/renderer.ts:926-928; src/main.ts:57-59; src/render/input-controller.ts:16,
  76-83; src/sim/verbs/verbs.ts:813-816.

#### H8 `role-stat-tables-unimplemented` — all five player roles move/tank identically
- Intent: 02 §6 table — Speed 1.25/0.85/1.0/0.95/0.95/0.70, Health 80/140/95/100/120/200, Size
  0.9/1.3/1.0/1.0/1.15/1.4; "fast/fragile vs slow/tanky" is the identity read.
- Reality: speed scales only by MassClass — all non-Anchor players 1.0, Anchor 0.78
  (step.ts:65-70); health defaults to 100 for every body (state.ts:388; scene.ts never overrides);
  all players spawn radius 0.4 / halfHeight 0.9 (scene.ts:150-152). Only THROW/STRUGGLE_STRENGTH
  and the ability differ per role.
- Gap: a Runner doesn't feel fast, a Bulwark doesn't feel tanky; the silhouettes (character.ts)
  promise a difference the sim doesn't deliver.
- Fix: per-role speed/health/size lookup at spawn + a role-speed multiplier in step.ts SYSTEM 1.
- Cites: src/sim/world/step.ts:65-70; src/sim/world/state.ts:388; src/game/scene.ts:149-162.

#### H9 `second-ability-slot-missing` — every role's Ability 2 (incl. Runner Wallkick) is absent
- Intent: 02 §1 two ability buttons; §6.1 Wallkick is "the premier solo-traversal skill".
- Reality: a single `Button.Ability` bit (input.ts:28); grep for
  wallkick/spring/tether/collapse/brace-up ability code in src/: **zero matches** (only Bulwark
  `braceUntil` bookkeeping exists). The Anchor has no active ability at all
  (abilities.ts:154 `default: break`).
- Gap: half of every kit is missing — notably the body you actually play loses its traversal
  expression.
- Fix: add `Button.Ability2`; implement Wallkick first (solo-testable, local body).
- Cites: src/sim/world/input.ts:28; src/sim/verbs/abilities.ts:148-155; grep src/.

#### H10 `tower-mode-ships-empty` — no throwables, no hazards (and no hazard render path at all)
- Intent: 09 §4 stages 4-7 (hazards keyed to chokes, pickups, a boon node per stratum); 02 §3
  object tiers teach the mass hierarchy; 07 §9 "a loose crate in reach teaches GRAB"; 06 §1.6.5
  hazards own the brightest red, always telegraphed.
- Reality: `buildTower` spawns players + Anchor and nothing else — no object loop, `hazards: []`
  (scene.ts:142-181, esp. 178). The sandbox's crusher + 8 throwables (scene.ts:86-103) are unused
  by main.ts. Even if hazards existed, **src/render has no hazard draw path** (grep: zero) — the
  sandbox crusher is already an invisible force.
- Gap: the real mode is less eventful than the throwaway sandbox: nothing to dodge, grab-teach,
  throw, or fight over; an entire palette channel (danger-red) unused.
- Fix: scatter 2-3 deterministic throwables + 1-2 crushers per stratum in `buildTower`; minimal
  hazard view = emissive red sphere at the sim-interpolated position + windup opacity ramp.
- Cites: src/game/scene.ts:86-103, 142-181; grep src/render for `hazard`.

#### H11 `netcode-proven-but-unwired` — two browsers cannot play; the seam is bounded and known
- Intent: 05 §0-§5 rollback mesh; 04 §8.1 room-code lobby; ROADMAP P2 keystone: two browsers
  co-op-carry with no perceptible desync.
- Reality: RollbackManager is proven headlessly over a lossy loopback (net/prove.ts) and
  PeerJsMeshTransport exists — but the adapter is self-flagged "has NOT yet been live-tested"
  (transport-peerjs.ts:20-25), ICE is 2× STUN with **no TURN** (transport-peerjs.ts:32-37; symmetric
  NATs will fail — Frequency shipped STUN+TURN), `hostRoom`/`joinRoom` only open a peer with the
  roster handshake "intentionally minimal" (transport-peerjs.ts:136-153), no lobby UI exists
  (index.html bare; room-code helpers called by nothing), the render loop never touches the netcode
  (loop.ts:18-21, 63-66; 05 §11's clock.ts unbuilt), and a playerId→bodyId map is missing
  (InputBus is playerId-indexed, input-bus.ts:105-119; `sim.advance` is bodyId-indexed; the proof
  works only because it spawns players as ids 0..N-1, net/prove.ts:55-68 — a 2-crew buildTower
  breaks that).
- Gap: the only spec-legal road to a race stops one integration seam short of the app.
- Fix (order): slot→bodyId map + multi-crew buildTower → minimal `?room=` lobby → CTRL roster
  handshake → `startNetLoop` driving `RollbackManager.tick` + GGPO time-sync → live 2-browser
  test (then add TURN).
- Cites: src/net/transport-peerjs.ts:20-25, 32-37, 136-153; src/net/prove.ts:55-68;
  src/net/input-bus.ts:105-119; src/render/loop.ts:18-21, 63-66.

#### H12 `no-post-stack` — zero bloom/tonemap/grade; "the soul of the look" absent
- Intent: 06 §7.2 bloom ("the soul of the look"), ACES grade, vignette; §1.5 "matte bodies,
  emissive intent… bloom does the heavy lifting".
- Reality: plain `WebGLRenderer` + direct `render()` (renderer.ts:182, 472); no composer, no
  postprocessing dep (package.json:34-37), no toneMapping config (grep: zero). Emissives render as
  flat tinted pixels.
- Gap: the "coalescing architecture of light" identity cannot exist; the build reads as a
  grey-box.
- Fix: `pmndrs/postprocessing` BloomEffect + ACES + vignette in one EffectPass (~30 lines).
- Cites: src/render/renderer.ts:182, 472; package.json:34-37.

#### H13 `coalescence-is-an-opacity-fade` — the signature reveal is not materialization
- Intent: 06 §2 four per-TILE phases (dots → gather/snap → dissolve-rim paneling → earned amber),
  reveal from distance-to-nearest-climber; §2.5 the floor-cross emergence beat (shaft + ring).
- Reality: one scalar per stratum BAND from the **Anchor's height only** drives a dashed 2D plan's
  opacity + slab opacity/color lerp (renderer.ts:639-688); no dots, no displacement, no rim, no
  shaders, no FloorCross effect; strata 2+ above simply `visible = false` (renderer.ts:682-686),
  so the tower never reads as continuing upward.
- Gap: "architecture assembling itself out of light" is currently "a translucent floor gets less
  translucent"; crossing a floor — the hero moment — has zero ceremony.
- Fix (payoff order): (1) the §2.5 emergence beat on band-cross using the existing impact pool +
  a stretched additive quad shaft; (2) per-tile XZ reveal from nearest climber; (3) the real
  TileMaterial shader later. Also re-show strata +2/+3 as ultra-faint corner dots.
- Cites: src/render/renderer.ts:639-688, 682-686, 981-996.

#### H14 `no-crew-rim-no-anchor-pulse` — bodies don't read as allegiance or life
- Intent: 06 §1.5 fog-immune crew-color Fresnel rim on every body; Anchor idle heartbeat emissive
  (~2 s, doubled when downed); crew ground-decal halo.
- Reality: plain flat `MeshStandardMaterial`s (character.ts:125-132; no onBeforeCompile anywhere);
  emissive is a constant hex only while held (0x442266) or downed (0x551122)
  (renderer.ts:447-448) — no pulse, no rim. The Anchor's read is base gold + static ring + label.
- Gap: allegiance won't survive fog/murk when rivals land; the Anchor reads as "the yellow one
  with a label", not a living precious core.
- Fix: one onBeforeCompile Fresnel-emissive patch (~10 lines GLSL) + `sin(tick·k)` pulse on the
  existing emissive channel (tick already in AnimSample).
- Cites: src/render/character.ts:125-132; src/render/renderer.ts:447-448.

### MEDIUM

#### M1 `death-is-a-silent-glitch` — your hovering "corpse" still obeys WASD; no death feedback
- Reality: `scheduleRespawn` parks the body (zero velocity, NoGravity, Downed) but **never clears
  `Alive`** (survival.ts:97-107), so the renderer keeps drawing it and the camera keeps weighting
  it (renderer.ts:434-436, 461-464); `motionPhase` has no Downed/respawn gate — it applies stick
  input to any Alive, ungrabbed Player (step.ts:106-119) — so the dead body air-strafes in the
  void for 3 s, then silently teleports. No HUD ever reports the LOCAL player's state
  (updateHud reads only the Anchor, renderer.ts:835-855).
- Fix: skip input for `respawnAt >= 0` bodies in motionPhase; hide them + exclude from centroid;
  "DOWNED — respawning 3…2…1" HUD line.

#### M2 `rush-double-integration` — the dash travels ~2× spec (≈7 u vs 4 u; ~48 u/s echo)
- Reality: each dash tick sweeps position AND sets `vx = dx·60` (verbs.ts:283-292); motionPhase
  re-integrates that echoed velocity (step.ts:127) with only a 1.9 u/s/tick brake against it.
  Spec: 4.0 u over 9 ticks (config.ts:20-22, 02 §2.1).
- Fix: position-sweep only during the dash; impart exit velocity once on the final tick.

#### M3 `right-button-150ms-latency` — both flashpoint verbs arrive a beat late
- Reality: Rush fires only when the hold crosses RIGHT_HOLD_TICKS = 9 (~150 ms); Ability fires on
  RELEASE of a shorter tap (verbs.ts:1041-1083). Keyboard J uses the same RightHold path
  (input-controller.ts:79) — no zero-latency rush input exists.
- Fix: fire Rush on press-edge and reinterpret as ability on quick release (rush-cancel), or give
  Ability its own button (MMB).

#### M4 `shove-unreachable-on-mouse` — the advertised tap-shove doesn't exist (see H7)
- Reality: SHOVE needs a `Button.Throw` press-edge (verbs.ts:813-816); Throw maps only to keyboard
  F (input-controller.ts:78). An LMB tap starts/cancels a grab latch.
- Fix: translate an LMB release with no completed latch into Button.Throw for that tick.

#### M5 `throw-arc-misleads` — pierces floors (terminates at y=−14) with no landing reticle
- Reality: arc breaks only at `py < this.groundY` (renderer.ts:795-798) = the deep slab (C7);
  color encodes charge only (renderer.ts:801); ignores per-role THROW_STRENGTH; no green/red
  safety read (07 §3.2).
- Fix: terminate at the first terrain-AABB top below each sample; drop a tinted reticle disc;
  red when nothing above killPlaneY.

#### M6 `hitstop-stutters-instead-of-freezing`
- Reality: hitstop holds only the interpolation alpha (renderer.ts:419) while `commitTick` keeps
  shifting the endpoints every sim tick (loop.ts:67; renderer.ts:388-399) — during a 90 ms hold the
  body still advances ~5 ticks, quantized. Spec: hold the displayed snapshot (07 §4.4).
- Fix: buffer commitTick's snapshot while hitstop is active; jump-commit on expiry.

#### M7 `dolly-ignores-vertical-spread-no-offscreen-chevrons`
- Reality: extent = X/Z spread only (renderer.ts:813-814); a scout 2.5-3 floors above the
  Anchor-weighted centroid leaves the frame with no marker; none of 07 §1.6 (chevrons, altitude
  pip, leash) exists.
- Fix: include `(maxY−minY)·k` in the extent; add edge chevrons for weighted bodies past ±0.95 NDC.

#### M8 `camera-smoothing-is-framerate-dependent` (Seed 1.3)
- Fix: exponential time constants `k = 1 − exp(−dt/τ)` (τ_up 120 ms, τ_down 260 ms, dolly-out
  180 ms, dolly-in 500 ms). Cites: renderer.ts:809-815.

#### M9 `anchor-hud-mislabels-friendly-carry` — and only 3 of 7 spec states exist
- Reality: `downed ? 'DOWNED' : grabbed ? 'GRABBED' : 'SECURE'` with GRABBED testing any
  `grabbedBy` — a friendly escort carry shows threat-orange (renderer.ts:847-852). No
  CARRIED/AIRBORNE/EXPOSED, no rescue CTA, no delta ticker (07 §2.2).
- Fix: CARRIED (green) when grabber crew == Anchor crew; AIRBORNE from !Grounded.

#### M10 `stratum-scale-collapsed` — 15 u footprint / 6 u bands vs spec 48-80 u / 18-28 u
- Reality: gridSize 5 × CELL_SIZE 3 (scene.ts:137; tower.ts:35-37); two "routes" a few steps
  apart; throw tuning calibrated for bands 2-4× taller (09 §3, 02 §5.2).
- Fix: gridSize 8-10 and/or CELL_SIZE 4, FLOOR_HEIGHT 10-12 as a first step; retune camera/throws.

#### M11 `depth-stack-minimal` — uniform distance fog, flat background, abyss/potential both absent
- Reality: `THREE.Fog(0x0a0a12, 30, 70)` camera-distance fog + a darken-lerp below
  (renderer.ts:185, 658-664); no height fog, no void gradient, no god rays; strata 2+ hidden
  (H13). 06 §3.1's "the abyss breathes" and pillar 7's "potential above" are both missing.
- Fix: gradient background + FogExp2-by-depth + faint corner-dot sprites for higher strata.

#### M12 `particles-one-puff-for-everything` + per-frame FX allocation
- Reality: one pooled ring+dust archetype reused for land/throw/grab/rush (renderer.ts:506-538,
  695-719); leash/arc/dot geometry allocated and disposed **every frame** (renderer.ts:426-429,
  952-958) against 06 §8's no-hot-loop-allocation rule. No trails/afterimages/shards (06 §4).
- Fix: two more pooled archetypes (stretched-quad trail, dash ghost); persist leash/arc objects.

### LOW

- **L1 standings-rail-bare** — no summit tick/units/motion glyphs; one unlabeled bead
  (renderer.ts:861-885, 915-921). Rises to MEDIUM when crews > 1.
- **L2 leash-color-ignores-crew** — `friendly = id === localId` with a stale "(crew identity not
  yet modeled)" comment; `w.crewId` is modeled and read 450 lines up (renderer.ts:772, 318). Any
  future ally carry draws hostile red. One-line fix.
- **L3 throw-ring-at-thrower** — detectEvents runs post-tick when `holding` is already cleared
  (verbs.ts:908), so the release burst always spawns on the thrower, never the launched body
  (renderer.ts:522-525).
- **L4 accessibility-unexposed** — `setShakeIntensity` has zero callers; no pause/settings UI at
  all (renderer.ts:216-218; main.ts:23-45). 07 §6 unreachable.
- **L5 earned-warmth-leak** — amber tints ghost floors from reveal 0 (renderer.ts:671-679) vs
  06 §2.4's `reveal ≥ 0.9` gate. Gate behind smoothstep(0.9, 1.0, reveal).
- **L6 perf-per-box-meshes** — ~200+ unique meshes/materials (renderer.ts:256-263) is fine at 5
  strata but cannot batch/scale to the endless tower (06 §5/§8). Instance per band when needed.
- **L7 one-win-mode-no-macro** — rounds-to-summit (the cheapest session shape, 04 §6.3) absent;
  WinCondition has 2 of 3 entries (match.ts:27-33); nothing persists across runs. Defer until C4's
  restart exists, then it's a thin wrapper.

---

## Fixed since AUDIT.md (verified working — do not re-litigate)

- Committed-height standing + win-condition evaluation, hashed/rolled back (match.ts).
- Crew ids end-to-end + crew-aware grab tiers / friendly-struggle / regrab immunity (verbs.ts).
- Recall beacon sim logic (beacon.ts) — sim-correct; visibility is the gap (H6).
- Boon pool + deterministic rubber-band draw machinery (boons.ts) — draws correctly; effects/UI
  are the gap (C5).
- All five role Ability-1s implemented and proven in-sim (abilities.ts + abilities-prove.ts).
- Verb core: all five grab pressures, trains, catch-latch, charge-bleed, aim-spoil, encumbrance
  (verbs.ts) — spec-faithful per the verbs audit.
- Juice ladder ~70%: budgeted hitstop, trauma shake (squared + roll cap), pooled rings/dust,
  landing squash, carry-sag/wind-up postures, role silhouettes (renderer.ts, character.ts).
- Tower generation → terrain compilation wired into the playable app (tower.ts/scene.ts) — wired,
  but lossy (C1/C2/H2).
- Jump verb, throw charge, world-space aim raycast, tick interpolation, mouse-first scheme.
- Floor generator + independent solvability verifier proven (src/floor); netcode rollback core
  proven over lossy loopback (src/net/prove.ts).

---

## RECOMMENDED FIX ORDER (top 10, player-felt value per unit work)

1. **Carve the climb + wall the perimeter** (C1 + C2; one file, src/game/tower.ts): entry-cell
   holes above each exit, 3-4-box ramp runs, a wall ring per stratum. Unblocks literally
   everything; the game does not exist until this lands.
2. **Fix the aim plane** (C7, ~3 lines: plane constant = local player's feet Y per frame) and
   terminate the throw arc against terrain (M5). Biggest feel-per-line fix in the build.
3. **Camera true-55° + setViewOffset framing + dt-compensated smoothing** (H4 + M8) and fix the
   onboarding/legend contradictions (H7). Small, finishes Seed 1.
4. **Results + restart** (C4): win overlay with final heights, R → rebuild `seed+1n`; make the
   matchCap a loss with a visible mm:ss clock. Gives the session a shape.
5. **Safe respawn + auto-beacon + death feedback** (H1 + M1): auto-plant at stratum crests, clamp
   no-beacon respawn to stratum entry, gate motionPhase on respawn-pending, "respawning in N" HUD.
   Removes the soft-lock before fix 1 makes edges common. (Pairs with 1.)
6. **Real GAP chasms + ≥2.5 u gate lips** (H2, same file as 1; depends on 1+5): makes the Anchor
   gap-lock — the source of all interdependence — exist in terrain. Add the geometry-level
   solvability BFS (H3) in the same change so it can never regress.
7. **Full cast + objects + hazards in tower mode** (C6 + H10): crewSize 5, Tab body-swap debug
   key, 2-3 throwables + a crusher per stratum, minimal hazard render. Makes roles and the mass
   hierarchy experiencable solo.
8. **Boon draft UI + 2-3 wired effects** (C5) + **ability/cooldown/scout/beacon feedback**
   (H5 + H6): cards on 1/2/3 with auto-pick fallback, skip tick-0 draft; Strong Toss/Sticky
   Boots/Slipstream as the effect pattern; cooldown foot-ring; scout-mark ping; beacon pillar.
   The run gains a mid-loop reward and the HUD stops lying.
9. **Audio starter set** (C9): AudioContext + limiter + ~10 synthesized one-shots off
   detectEvents (verb signatures + Anchor CLAMP + landings + beacon chime + win sting). Highest
   spectacle return for a day of work; no assets needed.
10. **Pressure, then the race** (C3 + H11): show the clock (in fix 4); decide the ghost-crew
    question in DECISIONS-LOG (deterministic human-replay rival = the only single-machine bridge
    given the no-AI pillar); in parallel close the netcode seam in order — slot→bodyId map +
    multi-crew buildTower → minimal `?room=` lobby → roster handshake → netcode loop → live
    2-browser test (+ TURN server). Everything in fixes 1-9 survives unchanged underneath it.

Deferred consciously: stratum scale-up (M10) after 1/6 prove out; post stack + coalescence
upgrade + rims (H12-H14) as one "look" milestone after the game exists; rush/latency feel fixes
(M2/M3/M4) in a single tuning pass with the verb sim untouched elsewhere.
