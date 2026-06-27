# Audit v2 — THE GAME LOOP & ADVANCEMENT

Dimension: session shape, stratum cycle (arrive→traverse→crest→DRAFT→climb), win/results moment,
boon draft reality, forward pressure, death/respawn loop. Specs: docs/01 (§1, §5, §7, §8),
docs/03 (§1, §2, §4), docs/04 (§6), docs/00 (§6). All claims verified against current source,
June 2026. Read-only audit; no code modified.

---

### win-is-a-dead-end — winning produces a permanent text banner over a still-running sim; no results, no restart, no next tower

- Severity: CRITICAL
- Intent: docs/01 §7.1 session shape: `WIN CONDITION met (§8) -> RESULTS (final Anchor heights) -> leaderboard write`. docs/04 §6.3 sketches the between-round moment ("short intermission… the fresh tower coalesces in"). docs/00 §6 frames the whole slice around moments that "the table reacts to out loud" — the win is the biggest one.
- Reality: when `committed >= targetHeight`, `evaluateWin` sets `winner`/`endedTick` (src/game/match.ts:217-227) and `stepMatch` thereafter early-returns, freezing standings only (src/game/match.ts:152). The world keeps simulating forever — `Sim.advance` runs the full physics/verbs pipeline unconditionally (src/sim/sim.ts:114-182) and the loop never stops or pauses (src/render/loop.ts:63-88; `LoopHandle.stop` exists at loop.ts:91 but nothing ever calls it). The only player-visible consequence is a center-screen text node set to `'YOUR CREW WINS!'` every frame, `display:block`, never hidden (src/render/renderer.ts:843-846). There is no results screen, no final-heights readout, no restart key, no next-tower flow: `main.ts` builds one scene once at boot and wires nothing else (src/main.ts:23-45). Starting a new run requires reloading the page.
- Gap: the climb has no payoff and the session has no shape. You crest the tower, a yellow string appears, and you are left wandering the same floor in a sandbox that pretends nothing happened. The "race" ends with neither ceremony nor a way to race again — the single strongest retention beat in the spec (results → go again) simply does not exist.
- Fix sketch: on `winner >= 0`, fade in a results overlay (final committed heights per crew, time-to-target) with a "Climb again (R)" prompt; `R` → `loop.stop()`, rebuild via `buildTower({seed: seed+1n})`, restart loop. ~30 lines in main.ts/renderer.ts, zero sim changes.

---

### boons-are-inert-ids — drafted boons (and Momentum) have zero gameplay effect; nothing in the sim reads them

- Severity: CRITICAL
- Intent: docs/03 is an entire doc about boons as the in-run progression: "Boons deepen grab / throw / carry / build / break / route / Anchor-protection" (§0 C3), with concrete effects (§3) and continuous effects read "each tick from already-replicated state" (§6: "Continuous effects (Slipstream, Shared Footing) … add derived modifiers in the sim step"). docs/00 §6.3: "the better boon you draw next makes the loss feel survivable."
- Reality: drafting appends an id to `crew.boons` and bumps `momentum` (src/game/match.ts:208-213) — and that is the end of the data flow. A repo-wide search for boon consumers finds only match.ts (push/clone/hash), boons.ts (definitions), and the test harness src/game/prove.ts; no file under src/sim/ references `match`, `crews`, or any boon (grep over src/sim: only an unrelated comment at src/sim/verbs/verbs.ts:557). The one implemented effect helper, `slipstreamBonus` (src/game/boons.ts:151-153), is exported but imported nowhere. `momentum` is written at match.ts:213 and never read by anything (grep: match.ts/boons.ts only) — there is no reroll/bank to spend it on. boons.ts's own header admits it: "the boon EFFECTS are applied by readers… effect wiring is intentionally small + extensible" (src/game/boons.ts:15-17) — currently zero readers exist.
- Gap: the entire progression/rubber-band economy is scoreboard fiction. Sure Grip, Cannon Arm, Featherweight Anchor, Slipstream — none changes a single sim number. Even if the draft were surfaced (next finding), choosing would be meaningless; the "stronger tools for trailing crews" comeback engine (03 §4) cannot exist because the tools do nothing.
- Fix sketch: wire 2-3 boons end-to-end as the pattern: pass `match` (or a per-crew derived modifier struct) into `applyVerbs`/`motionPhase`; e.g. Strong Toss → +15% throw impulse in verbs.ts, Slipstream → `slipstreamBonus()` multiplier on MAX_SPEED in step.ts. Derived from hashed MatchState, so determinism holds.

---

### draft-is-invisible-and-auto-picked — the DRAFT beat of the stratum cycle does not exist for the player

- Severity: HIGH
- Intent: docs/01 §1 beat (6): "a short, safe-ish landing offers a 1-of-3 draft" — one of the six beats of the core loop. docs/03 §2.2: "A draft presents 3 boon cards… the crew makes ONE shared pick," nominated by pings, Anchor tiebreak, 6 s timer, "card UI is a diegetic overlay." docs/03 §2.1: "First draft is at floor 10 (not floor 0) so the opening minute is pure traversal tutorialization with no menu."
- Reality: `runDrafts` draws the offer and immediately auto-picks "the best card (highest tier; tie → lowest id)" with no input (src/game/match.ts:200-211; the doc comment at match.ts:181-183 acknowledges "a player-facing pick UI can override later"). No input channel for a pick even exists — the `Button` bitfield has Rush/Grab/Throw/Struggle/Jump/Recall/Ability/RightHold only (src/sim/world/input.ts:19-32). No UI surfaces the offer or the owned boons: the loop pushes only `{committed, winner, localCrew, crews, target}` to the renderer (src/render/loop.ts:77-83; `Renderer.standing` type at src/render/renderer.ts:404), and no render file mentions boons at all (repo grep). Worse, the first draft fires at spawn: `lastDraftFloor` starts at -1 (match.ts:104) and committed 0 → floor 0 → milestone 0 > -1 fires on tick 0 (match.ts:191-196, with `draftEveryFloors: 1` from src/game/scene.ts:174).
- Gap: a player can finish a full run never knowing boons exist. The calm "crest → choose → climb" punctuation that gives each stratum a felt reward cycle (and the only strategic decision in the run) is silently consumed by the sim on tick 0 and at each floor. Combined with the inert-effects finding, beat 6 of the six-beat loop is absent end-to-end.
- Fix sketch: surface `crew.offer` as a 3-card overlay when non-empty; map keys 1/2/3 (a new `Button.Pick`+index or a game-layer input) to the pick; keep the current auto-pick as the 6 s timeout fallback. Skip the milestone-0 draft (`if (milestone === 0) continue` or start `lastDraftFloor` at 0).

---

### zero-forward-pressure — no rivals, no visible clock, dead rubber-band: nothing pushes the crew upward

- Severity: HIGH
- Intent: docs/01 §5: pressure is "no chase" but explicitly comes from four forces — #1 "Rival Anchors are climbing. … The clock is *the other crews*"; #2 sabotage; #3 rubber-band pull; #4 the gap-locked Anchor. docs/04 §5.2: rubber-banding "*guarantees* flashpoints keep happening." docs/01 §8.1: Endless cap is surfaced as a match clock (04 §6.2: "The HUD countdown is render-only").
- Reality: the playable build spawns exactly one crew — `numCrews: 1` (src/game/scene.ts:170) — so forces #1-#3 are structurally absent. Rubber-banding is mathematically dead with one crew: `deficit = leaderFloors - floor` is always 0 (match.ts:190-198) and `catchupFactor` returns 0 inside the 2-floor deadzone (src/game/boons.ts:75-79), so the 4-card offers, free rerolls, and the entire comeback pool (boons.ts:99-106, 56-57) are unreachable code in-game. The only clock is `matchCap = 60*60*10` (scene.ts:169) which is shown nowhere — the HUD push contains no tick/cap (loop.ts:77-83) and the renderer has no timer element (renderer.ts:896-931). When the invisible 10-minute cap hits, `evaluateWin`'s cap branch initializes `best = 0` and crowns crew 0 even at committed height 0 (match.ts:229-236) — idle for ten minutes and the game declares "YOUR CREW WINS!" (renderer.ts:845).
- Gap: there is no reason to climb other than curiosity. No rival beads move on the standings rail (the rail renders one bead — yours), no countdown ticks, nothing punishes stalling, and the failure mode is absurd: doing nothing wins. The "pure race" pillar degenerates to a stroll; urgency, the emotional core of a race, is at zero.
- Fix sketch: cheapest real pressure without netcode/AI: (a) show the match clock (pass `tick`/`matchCap` through `renderer.standing`, render mm:ss) and make the cap a LOSS if target not reached (`winner = -2` "TOWER CLOSED" state) instead of an auto-win; (b) add a ghost rival: a scripted `committed` curve (pure f(tick)) for crew 1 that climbs the rail and can "win," giving the race a pace car for one line of sim-side code per tick.

---

### death-is-a-silent-glitch — dying gives no feedback; your "corpse" hovers in the void and still obeys WASD

- Severity: MEDIUM
- Intent: docs/01 §4.2: "Regular-player death is *not* a big deal by design: they respawn at the Recall Beacon… after a short delay" — a legible, recoverable beat. docs/07's whole thesis (per 00 pillar readability) is that the player always knows what is happening to them.
- Reality: on kill-plane or bleed-out death, `scheduleRespawn` parks the body in place — zero velocity, `NoGravity`, `Downed`, respawn in 3 s (src/game/survival.ts:97-107) — but never clears `Alive`, so the renderer keeps drawing it (visibility is gated on `Alive` only, src/render/renderer.ts:434-436) and the camera centroid keeps weighting it (renderer.ts:461-464), frozen below the kill-plane mid-void. Meanwhile `motionPhase` has no Downed/respawn-pending gate — it applies the player's stick to vx/vz for any Alive, ungrabbed Player body (src/sim/world/step.ts:106-119; grep confirms no `Downed` reference in step.ts) — so the "dead" local player air-strafes their hovering body around the void for 3 seconds. No HUD element ever reports the LOCAL player's state: `updateHud` reads only the Anchor (renderer.ts:835-855). Then the body silently teleports to the beacon/Anchor (survival.ts:110-134).
- Gap: death reads as a physics bug, not a consequence. You fall, the world recedes, your character floats and slides under the tower, then you blink elsewhere — at no point does the game say "you died — respawning in 3." The punishment loop the spec designed (die → respawn at beacon → re-escort) is mechanically present (survival.ts works) but experientially illegible.
- Fix sketch: in `motionPhase`, skip input for bodies with `respawnAt >= 0` (or `Downed`); hide parked bodies in the renderer (`respawnAt >= 0` → `visible = false`, exclude from centroid); add a "DOWNED — respawning 3…2…1" line to the HUD when the local body has `respawnAt >= 0`.

---

### anchor-void-respawn-strands-the-run — with no beacon planted, a ringed-out Anchor respawns at ground level under its last x/z

- Severity: MEDIUM
- Intent: docs/01 §8.2 `anchorRespawnFloor`: default "last-milestone"; docs/01 §7.3: "the recall-respawn floor never drops below the last milestone (so a thrown player doesn't fall *forever* in long runs)." docs/04 §6.1: Anchor death respawns "at the crew's RECALL BEACON… a major setback, not elimination."
- Reality: an Anchor below the kill-plane respawns at the crew beacon if one was ever planted; otherwise (the `anchorId !== id` guard excludes itself, src/game/survival.ts:116) it takes the last resort: `y = 1` with x/z unchanged from where it fell (survival.ts:119-121). Beacon planting is a manual Anchor-only Q press (src/game/beacon.ts:52-60) that a sandbox player has likely never used; there is no auto-plant and no milestone checkpoint anywhere in the code (no other writer of `beaconX/Y/Z`). Crew recall can't help re-form either: with no beacon, recall is a no-op (`if (cs.beaconTick < 0) continue`, beacon.ts:63).
- Gap: the most dramatic moment the spec has (Anchor rung out) resolves as: the gold body reappears at altitude ~0, possibly outside the tower footprint on the deep ground slab, the crew is stranded 3-4 strata up with no recall, and the score recommits to ~0. The "major setback" becomes "restart the run by hand, minus the restart button" (see finding 1).
- Fix sketch: auto-plant the beacon at each stratum crest (when `committed` crosses a stratum boundary, write beacon = Anchor pos — one block in `stepMatch`), giving 01 §7.3's milestone-checkpoint semantics for free; make the last-resort respawn use the highest stratum entry at-or-below `committed` instead of raw y=1.

---

### one-win-mode-no-knobs — two of three win conditions exist, none selectable, no rounds/summit macro

- Severity: LOW
- Intent: docs/01 §8.1: three host-pickable win conditions (race-to-height, endless-highest, rounds-to-summit-then-new-tower) plus the full knob set; docs/04 §6.3 details rounds mode. Macro goal (01 §7.4): leaderboards/personal-best across runs.
- Reality: `WinCondition` implements RaceToHeight and Endless only (src/game/match.ts:27-33); rounds-to-summit has no representation. There is no lobby/selector — `buildTower` hard-codes RaceToHeight (scene.ts:167) and `main.ts` exposes no options. Nothing persists across page loads (no leaderboard write anywhere in src/).
- Gap: acceptable for a single-player slice (lobby = netcode work, explicitly out of scope), but rounds-to-summit is also the cheapest single-machine session shape ("best of 3 short towers") and would have absorbed findings 1's restart need; worth knowing it's absent rather than half-built.
- Fix sketch: defer until the results/restart flow (finding 1) exists; then rounds mode is a thin wrapper: K towers, `winner` per round, tally screen.

---

## Dimension verdict

The moment-to-moment escort sim is real, but the LOOP around it is hollow: the run has no ending (win = a permanent string), no next (no restart/rounds), and no middle reward (drafts fire invisibly at tick 0 and grant ids nothing reads). With one crew, no visible clock, and a do-nothing auto-win at the cap, there is no pressure axis at all — the build is a physics toy wearing a race's HUD. Priority: (1) results+restart, (2) wire 2-3 boon effects + a visible draft pick, (3) any pace-pressure source.
