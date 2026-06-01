# ASCENT — Audit Report

> Read-only audit of the ASCENT codebase against the design spec (`docs/00`–`docs/09`).
> Findings are adversarially verified against the actual source and the canonical docs.
> Grouped by **severity**, then **category**. Overlapping findings across audit dimensions
> have been **de-duplicated** (e.g. the four separate "jump" findings are merged into one).

---

## Executive Summary

ASCENT is an early but architecturally serious project: the deterministic fixed-point sim,
the rollback netcode core, and the procedural floor generator are all built and proven
*headlessly*. The problem is that the **playable build exercises almost none of it**, and the
parts it does exercise have real bugs that the headless proofs structurally cannot catch.

Two themes dominate:

1. **The game's thesis is not playable yet.** There is no standing/score, no crew identity,
   no win condition, no tower (the floor generator is an unwired island), no recall beacon, and
   no death/respawn. The running app is a single flat arena with colored capsules — the
   "vertical escort brawl-race" is not yet expressible.
2. **The verbs that *are* wired have input-path bugs.** THROW always fires at ~3% power (charge
   is keyed off a button the real controller never holds), JUMP is wired end-to-end *except* the
   sim never reads it, and RUSH ignores encumbrance. The headless proofs pass only because they
   inject input combinations the real `InputController` cannot physically produce.

A third theme is **UX absence**: the spec's single most important on-screen element (the Anchor
status / altitude-is-score readout) does not exist, and there is **zero visual feedback** for any
of the four verbs (no grab leash, no throw arc, no struggle meter, no juice).

### One-line health assessment
**Mechanics:** the deterministic core is sound, but 2 of the 4 player verbs are effectively
non-functional via real input and the entire scoring/objective layer is absent.
**UX:** essentially unstarted relative to the spec — no HUD score, no verb legibility, no juice,
no climb-tuned camera.

### Counts by severity
| Severity | Count |
|---|---|
| CRITICAL | 8 |
| HIGH | 13 |
| MEDIUM | 17 |
| LOW | 11 |
| **Total** | **49** |

### Counts by category
| Category | Count |
|---|---|
| MISSING | 24 |
| BUG | 12 |
| SPEC-MISMATCH | 9 |
| UX | 3 |
| POLISH | 3 |
| **Total** | **49** |

> De-duplication: the raw audit produced 56 findings across dimensions; 7 were duplicate views
> of the same defect (throw-charge ×2, jump ×4 collapsed to 1, aim-mapping ×2, anchor-status-HUD ×2,
> health/death ×2, anchor-downed-ticks folded into the downed-beat findings). Counts above are the
> de-duplicated totals.

---

## Top 5 to Fix First
*(highest user impact, ordered)*

1. **Fix THROW charge** (`throw-charge-broken`, CRITICAL). Every throw via keyboard/mouse fires at
   ~3% power — one of the four core verbs is effectively dead. Drive charge off the **GRAB hold**
   (per spec §2.3), not the Throw bit. Highest impact-per-line-of-code fix in the report.

2. **Implement JUMP** (`jump-not-implemented`, CRITICAL). Space is advertised in the HUD and wired
   end-to-end, but the sim never reads `Button.Jump`. The whole game is a vertical climb; with no
   jump there is no vertical traversal and the Anchor's gap-lock constraint cannot exist.

3. **Add the Anchor Status HUD** (`no-anchor-status-hud`, CRITICAL). The spec's "emotional core of
   the HUD" — altitude-as-score, state word, durability — does not exist. A new player has no idea
   what their score is or whether they're winning. Even a minimal top-center readout is a huge win.

4. **Add verb visual feedback** (`no-verb-visual-feedback`, CRITICAL). Zero feedback for grab/throw/
   struggle/rush. Players can't tell when a grab lands, who holds whom, or where a throw goes. Start
   with the grab leash (red/green) and the throw aim-arc — the spec calls these "the throw tutorial."

5. **Wire standing + a win condition** (`no-standing-score-system` + `no-win-conditions`, CRITICAL).
   The Anchor's height *is* the score and the race; today nothing computes it and the match never
   ends. This is the prerequisite for the "race" half of "escort brawl-race" and unblocks drafts,
   rubber-banding, and the standings rail.

> These five turn the build from a physics sandbox into a recognizable game: two dead verbs revived,
> the score made visible, actions made legible, and an objective to play toward.

---

# CRITICAL

## BUG

### `throw-charge-broken` — THROW always fires at ~3% power
- **Location:** `src/render/input-controller.ts:62-67` + `src/sim/verbs/verbs.ts:619-639,585-588`
- **What's wrong:** Throw charge accumulates only while `Button.Throw` is held *and* hands are full
  (`verbs.ts:624`), but the input controller only ever **pulses** `Button.Throw` for a single tick on
  the GRAB-release edge (`input-controller.ts:66: if (this.prevGrabHeld && !grabHeld) buttons |= Button.Throw`).
  So during the entire grab-hold the Throw bit is 0, the charge timer never accumulates, and the throw
  fires the next tick with `timer=1` → `chargeFraction = 1/30 ≈ 0.033`. Launch impulse
  `J = THROW_J * 0.033 * invSqrtM * strength` is ~3% of full charge — a near-stationary drop. The
  headless proof passes only because `prove.ts:111-112` injects `Button.Grab | Button.Throw`
  simultaneously for 30 ticks, an input the `InputController` physically cannot emit.
- **Spec:** §2.3 — "holding GRAB after latch builds throw charge from 0→1 over 30 ticks (0.5s)."
- **Fix:** Decouple charge from the Throw bit. In `throwSystem`'s charge pass, ramp `w.timer[i]` while
  `isDown(inp, Button.Grab) && w.holding[i] !== NO_ENTITY`, and detect the throw on the **GRAB release
  edge** when hands are full. Better still (spec §10 risk #2): derive charge from
  `(grab_start_tick, release_tick)` rather than an accumulator — this also fixes rollback-charge drift.
  Update `prove.ts` to the new protocol.
- **Confidence:** high

## MISSING

### `jump-not-implemented` — JUMP/CLIMB verb entirely unimplemented
- **Location:** `src/sim/world/step.ts` (motionPhase, 76-123) + `src/sim/verbs/verbs.ts` (whole file)
- **What's wrong:** `Button.Jump` is defined (`input.ts:24`), sent by the controller
  (`input-controller.ts:69`, Space) and packed on the wire — but **no sim code reads it**. `motionPhase`
  only ever writes `vy` via gravity (negative) and the ground clamp (to 0); there is no upward impulse,
  no mantle/ledge-catch (§8.4), no hands-full jump-disable. Pressing Space does nothing, yet the HUD
  (`main.ts:52`) advertises "Space jump." Without jump, vertical traversal is impossible for a solo
  player, the Pressure-A "hands-full disables JUMP" / carrier-can't-mantle asymmetry can't exist, and
  the Anchor's defining "cannot self-clear a big gap (>1.5× its own jump)" constraint (§2.1) is untestable.
- **Spec:** §1 lists `A / Space → JUMP / CLIMB-up` as a primary verb; §2.1 stagger blocks "GRAB, JUMP,
  or use abilities"; §4.1 "Holding anything disables JUMP/CLIMB"; §8.4 mantle is "finished with JUMP."
- **Fix:** On the `Button.Jump` press-edge (via `prevButtons`, like the other verbs) while `Grounded`,
  `w.holding[i] === NO_ENTITY` (Pressure A), and not staggered, set `w.vy` to a tuned per-mass jump
  speed (Anchor jumps lower) and clear `Grounded`. Add the §8.4 mantle/ledge-catch window as a later
  pass once real terrain exists.
- **Confidence:** high
- *(Merges: jump-verb-not-implemented, jump-button-never-consumed, jump-input-unimplemented, and the
  jump-dependency in no-anchor-gap-lock.)*

### `no-anchor-status-hud` — the Anchor Status element does not exist
- **Location:** `src/main.ts:43-55` (makeHud); `src/render/renderer.ts` (no HUD at all)
- **What's wrong:** The single most important UX element in the spec — the Anchor Status panel
  (altitude readout = the score, state word, durability arc, grab/threat escalation) — does not exist.
  The only on-screen text is a static controls cheat-sheet. A new player has no on-screen indication of
  altitude (their score), their Anchor's state, or whether they're winning. The data is available and
  unused (`state.ts` exposes `py`, `health`, `grabbedBy`, `flags`; `scene.ts` returns `anchorId`).
- **Spec:** §2.2 (07) — "Your Anchor Status (top-center, prominent)… the only element allowed to grow/
  pulse/flash aggressively… Altitude readout (the score) — large, with a delta ticker." §5.3 —
  "YOUR ANCHOR'S HEIGHT = YOUR SCORE."
- **Fix:** Add a top-center panel driven by the snapshot: large altitude readout
  (`toFloat(fromRaw(w.py[anchorId])) − groundY`) labeled "ANCHOR HEIGHT = SCORE", a state word from
  flags (SECURE / GRABBED when `grabbedBy != -1` / DOWNED on `BodyFlag.Downed`), and a durability arc
  from `health[anchorId]`. Red-pulse escalation when `grabbedBy[anchorId] != -1`. (Note: ally-CARRIED
  vs rival-GRABBED can't be distinguished until crew identity exists — see `no-crew-team-identity`.)
- **Confidence:** high
- *(Merges the UX-dimension CRITICAL and the vision-dimension MEDIUM duplicate; kept at CRITICAL.)*

### `no-verb-visual-feedback` — zero visual feedback for any of the four verbs
- **Location:** `src/render/renderer.ts:133-166` (render) — only position + flat color drawn
- **What's wrong:** No grab leash, no throw aim arc / landing reticle, no struggle meter, no RUSH trail
  or telegraph, no charge tell. The only verb-state the renderer reads is `grabbedBy` for a magenta tint
  (`colorFor`, 103-108). A player literally cannot tell when a grab succeeds, who holds whom, where a
  throw will land, or that a struggle is in progress. The sim already tracks everything needed
  (`grabbedBy`, `holding`, `struggleProgress`, `rushUntil`, `facing`).
- **Spec:** §3.2 (07) calls grab/carry/throw "the hardest read in the game": green leash = friendly
  carry, red leash = hostile grab; throw shows a dotted predicted arc + landing reticle; struggle shows
  a radial that fills toward break-free. §5.1: "The aim-arc IS the throw tutorial."
- **Fix:** For each body with `holding[id] != -1`, draw a line from holder to held (green if same crew,
  else red). While the local player holds and grab is held, draw a dotted parabolic arc from
  `facing[local]`, `THROW_ANGLE_DEFAULT`, `THROW_J*charge` with a colored landing reticle. Draw a radial
  fill above any body with `struggleProgress > 0` scaled to `STRUGGLE_BREAK`. Draw a motion streak for
  bodies with `rushUntil > tick`.
- **Confidence:** high

### `no-standing-score-system` — no standing/altitude scoring anywhere
- **Location:** `src/sim/` (entire); `src/sim/sim.ts:88-127` advance() has no standing pass
- **What's wrong:** The canonical rule — "a crew's standing IS its Anchor's height, and nothing else is
  scored" — is unimplemented. No `H = floorIndex + fractionalProgress`, no committed-vs-raw altitude
  (`COMMIT_WINDOW`/`GROUND_DWELL`), no per-crew standing, no leaderboard, no tiebreaks. The Anchor is
  just another body. Without standing there is no objective, win, race, rubber-band, or draft cadence.
- **Spec:** 00 §3 pillar 1 — "Standing = that Anchor's height, full stop." 04 §1.2 — `H_anchor =
  floorIndex + fractionalProgress`, `H_committed` over `COMMIT_WINDOW=30` / `GROUND_DWELL=12`.
- **Fix:** Add a standing module run each tick: derive `floorIndex` from `py` against the floor stack
  (needs `floor-module-not-wired`), `fractionalProgress = clamp01((anchorY − floorBaseY)/FLOOR_HEIGHT)`,
  maintain `H_committed` via a `COMMIT_WINDOW` ring of stable samples (grounded, not airborne/grabbed/
  downed). Store committed floor + frac per Anchor in hashed `WorldState`.
- **Confidence:** high

### `no-crew-team-identity` — no crew/team id on bodies
- **Location:** `src/sim/world/state.ts:82-172`; `src/sim/verbs/verbs.ts:384`
- **What's wrong:** No body carries a crew id, so the sim cannot tell a teammate from a rival. Grab
  priority literally treats "enemy Anchor == any Anchor" (`verbs.ts:384` comment). This blocks
  friendly-fire rules, per-crew standing, carry-own vs throw-rival, recall (to *your* Anchor), per-crew
  drafts, and per-crew rubber-banding. Foundational — most other missing systems depend on it.
- **Spec:** 01 §9.2 — "the four verbs you use to help your Anchor are the exact verbs you use to hurt a
  rival Anchor… with the target flipped." 04 §0 — "A crew's entire standing is a single scalar."
- **Fix:** Add a `crewId` (Uint8Array) to `WorldState` (hashed), set in `spawnBody`/`scene`, and route
  through verb target selection, standing (group anchors by crew), recall, and drafts.
- **Confidence:** high

### `no-win-conditions` — no match end, no win condition
- **Location:** `src/sim/` and `src/game/scene.ts` — no `winCondition`/`targetHeight`/`matchCap`
- **What's wrong:** None of the three lobby win conditions (RACE-TO-HEIGHT, ENDLESS-HIGHEST,
  ROUNDS-TO-SUMMIT) exist. The sim runs forever; no target-floor check, no tick-budget match clock, no
  results, no concept of a match. Without a win condition the "race" half of the game does not exist.
- **Spec:** 01 §8.1 + 04 §6 — RACE: "`H_committed.floorIndex >= TARGET_FLOOR` for any crew → that crew
  wins"; ENDLESS: "at `endTick`, order crews by `H_committed`"; `endTick = startTick + minutes*60*60`.
- **Fix:** Add a `MatchConfig` (winCondition + targetHeight/matchCap/rounds, locked at start, hashed
  into the seed) and a match evaluator after the standing pass each tick: RACE checks committed
  `floorIndex >= TARGET_FLOOR` with `firstReachedTick` tiebreak; ENDLESS compares `H_committed` at
  `endTick`; ROUNDS reseeds a new tower on summit. Depends on `no-standing-score-system`.
- **Confidence:** high

### `floor-module-not-wired` — the procedural tower is an unwired island
- **Location:** `src/floor/*` (generate/types/verify) imported by nothing; `src/game/scene.ts:69` uses
  a hand-built `makeArena` instead
- **What's wrong:** The floor generator + solvability verifier are fully built and tested but **not
  wired into the running game**. The sandbox is a single hand-built 14u arena — no tower, no floors, no
  strata, no coalescing geometry, no endless climb. The literal "endless tower" the entire game is about
  does not exist in the playable build. Worse, the `Floor` graph has no translation to sim `Terrain`
  (AABBs): `types.ts:7-8` explicitly says "authored chunk geometry is layered on later… out of scope,"
  so even if called it produces nothing collidable.
- **Spec:** 00 §6 vertical-slice fun test — escorting an Anchor up "~3-4 coalescing strata"; 01 §1 — "A
  full run is a stack of stratum cycles."
- **Fix:** Build a `Floor→Terrain` compiler (cell-grid + edges → stacked AABB boxes, gaps, lifts) and a
  `genStratum(seed, index)` tower assembler for a window of strata around the Anchor; have `buildSandbox`
  consume it instead of `makeArena`. Add `FLOOR_HEIGHT` and per-floor base Y so standing can index floors.
- **Confidence:** high

---

# HIGH

## BUG

### `timer-slot-aliased-anchor-downed-vs-throw-charge` — `w.timer` overloaded; downed beat corrupt
- **Location:** `src/sim/hazards/falldamage.ts:62-63` vs `src/sim/verbs/verbs.ts:606,610,615,625-626,629`
- **What's wrong:** The single per-body `w.timer` slot is used both for the Anchor's Downed countdown
  (`falldamage.ts:63` sets `timer = ANCHOR_DOWNED_TICKS=24`) and the throw-charge accumulator
  (`verbs.ts:625-626`). The sandbox Anchor is player-like (`scene.ts:54: Player|Anchor`), so the charge
  pass runs on it and clobbers the Downed countdown. Worse, **nothing ever decrements the countdown** or
  clears `BodyFlag.Downed` from a fall — `verbs.ts:121` clears Downed only when stagger expires. So a
  fallen Anchor's Downed beat either never ends or is silently overwritten.
- **Spec:** §8.2 — Anchor downed beat is ~120 ticks and then ends.
- **Fix:** Give the Downed countdown its own hashed field (`downedUntil: Int32Array`) instead of aliasing
  `timer`. Add a pass (in `applyVerbs` section A or `sim.ts`) that clears `BodyFlag.Downed` when
  `tick >= downedUntil`. Also set `ANCHOR_DOWNED_TICKS` to the spec's ~120 (see `anchor-downed-beat-wrong`).
- **Confidence:** high

### `carrier-death-leaves-dangling-holding` — asymmetric linkage on carrier death
- **Location:** `src/sim/world/step.ts:136-141` (carryPhase defensive drop)
- **What's wrong:** When a carrier becomes not-`Alive`, carryPhase frees the held body (clears
  `grabbedBy[i]`, restores gravity) but never clears `w.holding[carrier]`. The carrier is left "holding"
  an id whose `grabbedBy` no longer points back. While the dead body lingers (and nothing kills bodies
  anyway), grab/throw invariant checks (`verbs.ts:323-334`) operate on a stale pointer. `forceDrop`
  (`verbs.ts:485-487`) is the only path that clears both sides.
- **Fix:** In the carryPhase defensive drop, also `w.holding[carrier] = NO_ENTITY`. Better: route
  carrier-death cleanup through `forceDrop` so both ends and regrab/struggle bookkeeping stay consistent.
- **Confidence:** high

## MISSING

### `struggle-mash-ramp-and-jitter-missing` — mash curve + anti-bot jitter absent
- **Location:** `src/sim/verbs/verbs.ts:531-567` (struggleSystem)
- **What's wrong:** §4.2 specifies a consecutive-press ramp (`press × min(1 + 0.12·(n−1), 1.8)`, ramping
  to 1.8× after ~7 presses) and a seeded ±5% micro-jitter per press — both absent. `struggleSystem`
  computes a flat `inc` (line 558) with no burst counter and no jitter; `jitter.ts` only defines
  `JitterChannel.ThrowAngle`. Consequence: the spec's tuned hold-times won't reproduce and the
  anti-autoclicker jitter is missing.
- **Spec:** §4.2 — the ramp formula and "a seeded micro-jitter of ±5% per press (PRNG, not wall-clock)."
- **Fix:** Track a per-body burst counter (reset when the gap since last press exceeds the 6-tick
  window), multiply `inc` by `clamp(1 + 0.12*(n−1), 1, 1.8)`. Add a `JitterChannel.Struggle` and multiply
  by `(1 + 0.05*jitterUnit(tick, heldId, Struggle))`. Both integer/Fixed, seeded per §10.4.
- **Confidence:** high

### `health-and-death-not-handled` — no death, kill-plane, or respawn
- **Location:** `src/sim/sim.ts:88-127` (advance pipeline); `src/sim/world/state.ts:279` `killBody` never
  called
- **What's wrong:** Health can be driven arbitrarily negative and nothing happens. Hazards
  (`apply.ts:66`) and fall damage (`falldamage.ts:66`) subtract from `health` with no clamp and no
  death/Downed-on-zero transition. `advance()` never checks `health <= 0`, never sets a regular player
  Downed at 0 HP (§8.3), never kills, never respawns at the beacon, never handles the Anchor kill-plane.
  `killBody` is dead code. The fall-damage helper's own doc says "integrator clamps/decides death"
  (`falldamage.ts:43`) — but the integrator does neither.
- **Spec:** 01 §4.2/§4.3 — regulars "LETHAL big falls, respawn via recall"; Anchor "true-death only at a
  real kill-plane." 04 §3.5 — true Anchor death triggers win handling. 02 §8.3 — 0 HP → Downed + 15s
  bleed-out → death/respawn.
- **Fix:** Add a death/downed resolution step at the end of `advance()`: regular player `health <= 0` or
  past the bottom kill-plane / a hazard kill-volume → Downed + bleed-out timer, then respawn-at-beacon
  after `RESPAWN_DELAY`; Anchor true-dies only at a kill-plane (per `anchorTrueDeath` knob), else
  altitude-loss + downed beat. Clamp health at the bleed floor. Wire `killBody`. Define the bottom
  kill-plane and lethal volumes (see `no-kill-volume-hazards`).
- **Confidence:** high
- *(Merges health-zero-never-handled-no-death + no-true-death-respawn.)*

### `no-recall-beacon` — Recall Beacon entirely absent
- **Location:** `src/sim/` (entire) — no `recall`/`beacon` anywhere
- **What's wrong:** The Recall Beacon — one of the three named escort primitives and a pillar-1 mechanic
  — is missing. No plant action, no beacon state, no recall-to-Anchor channel, no cooldowns, no
  respawn-at-beacon. It's also the structural anti-turtle ("recall is to the Anchor, never ahead") and
  the regular-player respawn point.
- **Spec:** 00 pillar 1; 01 §2.2-C (Anchor-only plant, cooldown 25-35s, 0.75s interruptible channel);
  01 §11 lists "carry, throw-across, recall" as the three primitives — only carry and throw exist.
- **Fix:** Add per-crew beacon state (position + plantedTick + cooldown, hashed), an Anchor-only plant
  intent (new Button/input field), and a tick-counted recall channel that teleports the recaller to the
  beacon's altitude (never above the Anchor), interruptible by grab/stagger. Wire the §8 knobs
  (`recallCooldown`, `beaconReplantCooldown`, `recallChannel`).
- **Confidence:** high

### `no-draft-boon-economy` — progression/economy layer absent
- **Location:** `src/sim/` (entire)
- **What's wrong:** The entire 03 layer is absent: no boon pool, no draft at stratum boundaries, no
  3-card offer, no rarity tiers, no per-crew active-boon bitset, no Momentum meter, no reroll/bank.
- **Spec:** 03 §2-§3 — 10-floor draft cadence, ~24-28 boons, `PROGRESSION_TUNING` (`STRATUM_FLOORS:10`,
  `DRAFT_CARDS_BASE:3`, `MAX_ACTIVE_BOONS:12`, `MOMENTUM_MAX:100`). §6 — "Active boons are a compact
  bitset per crew."
- **Fix:** Stage after standing+crew exist. Add per-crew `activeBoons` bitset + stack counts + Momentum
  (Uint16) to hashed state; add `drawOffer(prng(seed,'draft',crewId,stratum), tierTable)` fired when a
  crew's `maxStratumClaimed` increases; feed the pick back as a deterministic input byte. Ship a handful
  of boons first to validate the loop.
- **Confidence:** high

### `no-rubber-banding` — Mario-Kart comeback engine absent
- **Location:** `src/sim/` (entire)
- **What's wrong:** Pillar 6 rubber-banding is unimplemented: no normalized deficit `d`, no smoothstep
  catchup, no rarity uplift, no extra card slot, no comeback-pool, no Slipstream, no leader deadzone.
  Both halves of re-bunching are missing — the boon-math half (no boons) and the diegetic half (the
  thrown-down-Anchor swing isn't scored because there's no standing).
- **Spec:** 00 pillar 6; 03 §4 — `d = clamp(rawDeficit/DEFICIT_SCALE,0,1)`, `s = d*d*(3−2d)`,
  `RARITY_UPLIFT_MAX=0.18`, `LEAD_DEADZONE_FLOORS=2`, Slipstream `+catchup*12%` self-canceling.
- **Fix:** After standing + drafts exist, compute per-crew `d` each draft from replicated Anchor heights
  and apply the three channels (rarity uplift, 4th card at catchup≥0.5, comeback-pool at ≥0.4) as pure
  functions of catchup; implement Slipstream as a per-tick deficit-scaled climb modifier (no new netcode
  fields, §6).
- **Confidence:** high

### `no-onboarding-anchor-or-roles` — no onboarding beyond a key legend
- **Location:** `src/main.ts:43-55` (the entire HUD/onboarding surface)
- **What's wrong:** Nothing teaches the Anchor concept, explains roles, labels which gold body is the
  Anchor or that its height is the score, and there are no just-in-time verb prompts. A brand-new player
  sees colored blobs and a controls string and cannot deduce the thesis ("climb the Anchor, protect the
  Anchor, sink rival Anchors").
- **Spec:** 07 §5.3 — "YOUR ANCHOR'S HEIGHT = YOUR SCORE." §5.1 — "One verb per moment, just-in-time.
  First gap → teach RUSH… First pickup in reach → teach GRAB." §9 is a full first-60-seconds beat sheet.
- **Fix:** Minimum viable: a floating world-space "ANCHOR" label over the anchor body + a one-line
  framing; just-in-time ghost prompts near the local player when conditions match (grabbable in reach →
  "GRAB (K)"; holding + target → "THROW (release K)"), fading after first successful use.
- **Confidence:** high

## SPEC-MISMATCH

### `encumbrance-does-not-reduce-rush-distance` — RUSH ignores carried tier
- **Location:** `src/sim/verbs/verbs.ts:200-219` (rushSystem) + `:740-761` (encumbranceSystem)
- **What's wrong:** §2.1 says a hands-full rush scales distance by the carry-speed multiplier (carrying
  the Anchor covers ~1.0u). But `rushStepDistance()` (230-236) always returns the full ease-out share of
  `RUSH_DIST` (4.0u) regardless of what's held, and the position is set directly (211-213).
  `encumbranceSystem` runs *afterward* and only clamps horizontal *velocity*, not the kinematic position
  sweep — so a carrier still teleports the full 4.0u per rush.
- **Spec:** §2.1 — "Rush while hands-full… distance scales by the carry-speed multiplier (§4.3). Rushing
  while carrying the Anchor covers ~1.0u."
- **Fix:** In `rushSystem`, when `w.holding[i] !== NO_ENTITY`, multiply `stepDist` by
  `CARRY_SPEED_MUL[w.massClass[held]]` (with the Bulwark +0.15 exception once roles exist) before
  applying the position delta, and apply the same factor to the carried-velocity write.
- **Confidence:** high

### `aim-screenspace-vs-worldspace-mismatch` — mouse aim is raw screen pixels
- **Location:** `src/render/input-controller.ts:42-46`
- **What's wrong:** Aim is `atan2(clientY−cy, clientX−cx)` in raw screen pixels and fed directly to the
  sim as the world facing (consumed as cos/sin over the world X/Z plane). But the camera is pitched ~48°
  down (offset `(0,18,16)`), so the ground plane is foreshortened in Y on screen — the screen angle does
  NOT equal the world ground-plane angle. Aiming "up and to the right" on screen points at a noticeably
  different world direction, directly violating the spec's reason for locking yaw ("throw stick = world
  direction" muscle memory). Since GRAB/RUSH/THROW are all facing-driven, mis-aim makes them feel
  unpredictable. The code comment concedes it's only "good enough for local testing."
- **Spec:** 07 §1.1 — "We do not allow free camera rotation — rotation destroys the muscle-memory
  mapping of 'throw stick = world direction'."
- **Fix:** Raycast the cursor through the camera onto the ground plane (`THREE.Raycaster` + `Plane` at
  `groundY`), subtract the local player's world position, and use `atan2(worldDz, worldDx)` as the aim.
- **Confidence:** high
- *(Merges aim-screenspace-vs-worldspace-mismatch + aim-mapping-screen-space-not-world.)*

### `camera-no-vertical-climb-follow` — camera has no climb-tuned feel
- **Location:** `src/render/renderer.ts:156-163`
- **What's wrong:** The camera centers the centroid with a single symmetric `lerp(0.08)`. The spec
  requires a vertical-climb rig: target at 42% from the bottom (more sky than floor), Anchor-weighted
  vertical bias (2/3 between Anchor and player), and asymmetric smoothing (snappy ~120ms up, loose ~260ms
  down with a fall rubber-band). None exists.
- **Spec:** 07 §1.3 (42% framing, asymmetric smoothing, fall rubber-band); §1.2 (vertical bias 2/3 toward
  the Anchor).
- **Fix:** Compute the centroid with spec weights (see next finding), bias vertical center toward
  `2/3·anchor + 1/3·player`, offset `lookAt` so the target sits ~42% up the frame, and use separate lerp
  factors for ascending vs descending.
- **Confidence:** high

### `centroid-ignores-anchor-weighting` — camera centroid is unweighted
- **Location:** `src/render/renderer.ts:150-158`
- **What's wrong:** The centroid is an unweighted average of all `Player+Anchor` bodies (`cx += x` for
  each, divided by `n`). The spec mandates an Anchor-dominant weighted centroid (`w_anchor=3.0`,
  `w_localPlayer=1.5`, `w_teammate=1.0`, `w_rival=0.0`). With equal weighting the Anchor can drift to the
  frame edge while the camera centers a cluster of runners; rivals (also `BodyFlag.Player`) would even be
  pulled in.
- **Spec:** 07 §1.2 — the weighted-centroid formula and weights.
- **Fix:** Accumulate `wsum += w_i; cx += w_i*x;` with `w_i` = 3.0 for the local crew's Anchor, 1.5 for
  the local player, 1.0 for teammates, 0.0 for rivals; divide by `wsum`. (Rival weighting needs
  `no-crew-team-identity`.)
- **Confidence:** high

### `inputdelay-declared-never-applied` — `inputDelay` is inert
- **Location:** `src/net/rollback.ts:62,101-119,154-158`
- **What's wrong:** `RollbackManager` declares `inputDelay = 2` citing §2.4, but it's never read.
  `tick()` records local input at the current tick (`addLocal(selfId, cur, canon)`) and steps with
  `stepOnce(cur)` — both use `cur` with no `+ inputDelay`. The spec requires delaying *applying* your own
  input by N frames; none of that scheduling exists, so setting `inputDelay` to any value changes nothing.
- **Spec:** 05 §2.4 — "`inputDelay` (frames): locally delay applying your own input by N frames"; the
  RTT auto-tune `clamp(round(maxClusterRTT/2/DT),1,4)`.
- **Fix:** Schedule local input at `cur + inputDelay` (`addLocal(selfId, cur + inputDelay, canon)`) and
  broadcast it for that tick, while still stepping the sim at `cur` via the bus (which predicts the
  not-yet-effective local lane). Or remove the field + §2.4 comment until implemented. If kept, also
  implement the RTT auto-tune.
- **Confidence:** high

## UX

### `no-juice-hitstop-shake-telegraph` — entire JUICE spec absent
- **Location:** `src/render/renderer.ts` (no shake/hitstop/squash/particles); `src/render/loop.ts:63`
- **What's wrong:** All of §4 is absent: no screenshake on impacts/throws/ring-outs, no hitstop ladder,
  no squash-and-stretch, no impact rings/dust, no hazard wind-up telegraph, no ascend pop, no assist
  sparkle. In a grab/throw/impact game, actions land with zero felt weight. The trigger data exists
  (`grabbedBy`, `grabLatchUntil`, `lastThrowTick`) but nothing reads it for feel.
- **Spec:** 07 §4.2-§4.7, §1.7 (trauma decay 1.6/s, offset = trauma²·maxOffset).
- **Fix:** Add a view-layer cosmetic-PRNG trauma accumulator on the camera fed by snapshot-detected
  events (grab latch, throw release, hard landing); a render-side hitstop that holds the displayed frame
  for the ladder durations (never gating sim ticks, per §4.4); squash/stretch by scaling meshes from
  velocity. Gate all behind an accessibility shake/motion slider.
- **Confidence:** high

---

# MEDIUM

## BUG

### `throw-charge-shares-rush-bookkeeping-slot` — charge stored in shared `w.timer`
- **Location:** `src/sim/verbs/verbs.ts:603-631` vs `src/sim/world/state.ts:122`
- **What's wrong:** Throw charge lives in the general-purpose `w.timer[i]`, documented as a generic
  scratch slot "owned by the verb layer" but advertised for "downed-until tick" too. Any future system
  writing `timer[i]` for a mid-charge player silently corrupts the charge (this is exactly the
  collision in `timer-slot-aliased-…`). Reset paths are also asymmetric, so a stale charge can persist.
- **Fix:** Give throw charge its own `Int32` field (`throwChargeTicks`) appended to `INT32_FIELDS`, reset
  on every release path including aborted throws. (Resolves the same root cause as the HIGH timer-alias
  finding.)
- **Confidence:** medium

### `fall-damage-misfires-on-caught-bodies` — phantom fall hit on a body grabbed mid-fall
- **Location:** `src/sim/sim.ts:115-124` (fall-damage loop)
- **What's wrong:** Fall damage fires for any alive body ending the tick `Grounded` with `preVy <
  −FALL_SAFE_SPEED`, with no check that the body is uncarried. carryPhase + grab run *before* the
  fall-damage loop, so a body caught mid-fall this tick (now carried, `grabbedBy` set) is still evaluated
  with its pre-grab fast `preVy` and can take a phantom fall hit — contradicting §5.4 ("catching a faller
  converts a lethal fall into a carry").
- **Fix:** In the loop, `if (w.grabbedBy[i] !== NO_ENTITY) continue;`. Optionally also require the body
  was NOT `Grounded` at tick start (track a `preGrounded` snapshot) so damage fires only on the
  falling→grounded transition.
- **Confidence:** medium

## MISSING

### `friendly-grab-low-struggle-threshold-missing` — no consenting-dismount threshold
- **Location:** `src/sim/verbs/verbs.ts:560` (struggleSystem) + `:465-475` (establishHold)
- **What's wrong:** §5.1 says a friendly carry lets the ally STRUGGLE out almost instantly (threshold 30,
  "let me down now"). The code uses a single `STRUGGLE_BREAK = 100` for all holds with no friendly-vs-
  hostile distinction, so co-op carry (a core Pillar-2 mechanic) can't work — an ally takes the full
  adversarial ~36+ ticks to dismount.
- **Fix:** Add team/consent data and select the break threshold per hold (30 friendly, 100 adversarial),
  set in `establishHold` from the carrier/target relationship, read in `struggleSystem`. Depends on
  `no-crew-team-identity`.
- **Confidence:** high

### `aim-spoil-and-charge-bleed-missing` — struggling victim doesn't disrupt the carrier
- **Location:** `src/sim/verbs/verbs.ts:531-567` (struggle) + `:651-687` (applyThrow)
- **What's wrong:** §4.2 "Aim-spoil": a struggling held player should wriggle the carrier's aim
  (±struggle·8°) and bleed throw charge at 0.02/tick (capping effective charge ~0.6). Neither exists — a
  struggling victim has zero effect on the carrier's aim or charge. This removes the "pin/peel before a
  clean VIP toss" counterplay.
- **Fix:** While a held body is actively struggling, bleed the carrier's `w.timer` by
  `~0.02·THROW_CHARGE_TICKS/tick` (cap ~0.6) in the charge pass, and add an aim-spoil term (±8° scaled by
  recent struggle intensity) in `applyThrow` via a new jitter channel.
- **Confidence:** high

### `no-revive-and-downed-beat-protection` — downed beat half-stubbed, no revive, no stand-up immunity
- **Location:** `src/sim/hazards/falldamage.ts:60-63`; no revive verb anywhere
- **What's wrong:** falldamage sets `BodyFlag.Downed` for a fixed 24 ticks (0.4s) on any hard landing,
  but: (1) no Mender revive/lifeline verb to shorten it; (2) no `ANCHOR_STANDUP_GRAB_IMMUNE` anti-pile-on
  stand-up window (03 tuning = 90 ticks); (3) the duration ignores `VULN_BEAT=90` / `DOWN_FLOORS_MIN=2`
  (04 §3.4). The most contested moment in the game is effectively absent, and the grab-immunity invariant
  that bounds infinite grab-trains isn't enforced after a throw-down.
- **Fix:** Drive the downed beat from `VULN_BEAT=90` only on drops ≥ `DOWN_FLOORS_MIN` floors (needs
  standing); on stand-up arm `regrabUntil = standUpTick + 90`; add a Mender revive verb. (Folds the
  separate `anchor-downed-beat-wrong` duration fix below.)
- **Confidence:** high

### `anchor-downed-beat-wrong` — `ANCHOR_DOWNED_TICKS=24` and wrong trigger
- **Location:** `src/sim/hazards/falldamage.ts:33`
- **What's wrong:** The downed beat is hard-coded to 24 ticks (0.4s) on any fast landing, but the spec's
  vulnerable beat is `VULN_BEAT = 90` ticks (1.5s), triggered only on a drop ≥ `DOWN_FLOORS_MIN = 2`
  floors or a player-throw — not on every fast landing. Both too short and the wrong condition.
- **Spec:** 04 §3.4 — `VULN_BEAT = 90`, `DOWN_FLOORS_MIN = 2`.
- **Fix:** Replace 24 with 90 and gate on drop-distance ≥ 2 floors (from standing) or a player-thrown
  flag, not raw impact speed. Reconcile with the 0.4s stagger use of `Downed` in `applyStagger` so the
  two aren't conflated on one flag. *(Closely related to `no-revive-and-downed-beat-protection` and
  `timer-slot-aliased-…`; fix together.)*
- **Confidence:** high

### `no-kill-volume-hazards` — no kill-planes or lethal hazard volumes
- **Location:** `src/sim/hazards/model.ts:30-161`; `terrain.ts` has no bottom kill-plane
- **What's wrong:** The position-kill (Smash) model needs real kill-planes and lethal kill-volumes (a
  crusher's lethal phase, a spike pit, a gap's void, the bottom of the shaft). No hazard kind nor terrain
  exposes one — spikes/crusher only subtract incremental health. So "kill with the throw, not damage" is
  impossible: there is nowhere to throw a body that kills it.
- **Spec:** 01 §4.3 / 04 §3.5 — Anchor true-death only off the bottom kill-plane or into a hazard
  kill-volume.
- **Fix:** Add a bottom kill-plane Y to the match/terrain and a lethal AABB kill-volume that, on entry,
  triggers the death/respawn pass (`health-and-death-not-handled`).
- **Confidence:** high

### `no-role-abilities-or-role-field` — roles are strength tables only
- **Location:** `src/sim/verbs/config.ts:96-124` (Role enum + tables); `state.ts` has no role field;
  `applyVerbs` takes a `RoleMap` `scene.ts` never passes
- **What's wrong:** The six identities exist only as throw/struggle multiplier tables. No role field on
  bodies, the sandbox never assigns roles (everyone defaults to Runner), and none of the role-defining
  abilities exist (Bulwark body-block/Unhand/Brace, Mender catch/revive, Engineer bridge, Breaker
  break-terrain, Runner scout/tag). Pillar 8 ("nobody gets the Anchor up alone") isn't realized — every
  player is mechanically identical.
- **Fix:** Add a role field to `WorldState`, assign in scene/lobby, and implement at minimum the
  escort-critical kits: Mender catch+revive, Bulwark body-block + ally grab-break (the spec's answer to
  Anchor-theft), Engineer one-shot bridge. Defer Breaker/Runner tags.
- **Confidence:** high

### `no-anchor-gap-lock` — the Anchor's defining constraint isn't modeled
- **Location:** `src/sim/world/step.ts:52-57` (SPEED_MUL only)
- **What's wrong:** The Anchor's "cannot self-clear a big gap (>1.5× its own jump)" constraint — the
  thing that forces the crew to engage — isn't modeled. The Anchor is only ~22% slower horizontally;
  there's no jump (see `jump-not-implemented`) and so no gap-reach limit. Without it the carry/throw-
  across core has no reason to be used.
- **Spec:** 01 §2.1/§2 — the Anchor is "gap-locked: alone it stalls at the first real chasm."
- **Fix:** After implementing jump, give the Anchor a lower `JUMP_SPEED` and author gap-crossing strata
  with gaps wider than 1.5× the Anchor's jump-reach (needs `floor-module-not-wired`).
- **Confidence:** high

### `no-anchor-status-and-standings-hud` — no in-game readability HUD
- **Location:** `src/main.ts:43-55`; `src/render/renderer.ts` (no HUD)
- **What's wrong:** Beyond the static controls string there is no in-game HUD answering "where is MY
  Anchor and what's happening to it?" — no altitude ribbon, no rival pips/Standings Rail, no crew banner
  with floor delta, no triple-redundant Anchor status. For a race game whose entire standing is Anchor
  height, the player can't see the race ("am I winning?").
- **Spec:** 00 §6.4; 04 §1.4 (altitude ribbon + rival pips + crew banner + standings sheet); 07 §2.1
  (Standings Rail, top-left, "the single most important HUD element after your own Anchor").
- **Fix:** Once standing exists, add a top-left Standings Rail (per-crew colored bead at relative Anchor
  altitude, your crew labeled YOU, redundant shape/letter channel, climbing/falling glyph from anchor
  `vy`), a crew banner with floor + delta to neighbors, and a hold-key standings sheet. Pure reader of
  sim state. *(Complements the CRITICAL `no-anchor-status-hud`; build alongside it.)*
- **Confidence:** medium

## SPEC-MISMATCH

### `train-grabber-prey-drops-instead-of-stacking` — grab-chains can't form
- **Location:** `src/sim/verbs/verbs.ts:316-320` (grabSystem C1)
- **What's wrong:** §2.3/§4.4 (the "train"): a carrier who is grabbed should keep carrying its cargo
  ("the whole stack flies"). The code does the opposite — the moment a carrier becomes held it force-
  drops (`if (grabbedBy[i] != NO_ENTITY && holding[i] != NO_ENTITY) breakHold(...)`), so trains (an
  intended spectacle and a load-bearing offensive pattern) can't form; the stack collapses immediately.
- **Fix:** Don't auto-drop when a carrier becomes held. Keep the inner linkage and have carryPhase chain
  sockets (held-of-held follows its own carrier). Compute the train's encumbrance per §4.4
  (max component mass + 0.5×others). Reserve dropping for the impact/hold-break check on throw impact.
- **Confidence:** medium

### `grab-latch-not-airborne-catch-of-faller` — can't catch a falling ally/Anchor
- **Location:** `src/sim/verbs/verbs.ts:431-462` (isGrabbable / inCone); `:375` (latch ticks)
- **What's wrong:** Catching a faller — a designed safety net (§5.4) and the alley-oop (§5.3) — works
  only by luck. `inCone` is purely 2D in plan (x,z), ignoring vertical span, and the latch always uses
  the mass-based `GRAB_LATCH_TICKS` (Anchor = 22) regardless of whether the target is airborne — during
  which a fast faller passes through the cone. No catch fast-latch (§5.3 says ~7 ticks).
- **Fix:** Add vertical reach to `inCone` (compare `|py_t − py_i|` against a catch vertical extent) and a
  catch path: if the target is falling (significant downward `vy`), use a short fixed catch latch
  (~7 ticks). Add the Mender's +40% catch cone once roles exist.
- **Confidence:** medium

### `loop-sheds-sim-ticks-on-overrun` — accumulator zeroed on stall
- **Location:** `src/render/loop.ts:61`
- **What's wrong:** On a stall the loop does `if (steps === MAX_TICKS_PER_FRAME) acc = 0;` — discarding
  owed sim ticks. §1.1 is explicit: "on a stall we drop render frames, never sim ticks — dropping sim
  ticks desyncs." Fine in single-player, but `main.ts` claims the loop is unchanged when netcode lands;
  if this loop ever drives a session it will desync the local peer.
- **Fix:** Keep the per-frame cap for responsiveness, but route networked sessions through a loop that
  surrenders catch-up to the rollback clock-sync (frame stall/skip ±1) instead of zeroing the
  accumulator. At minimum, comment that `acc = 0` is single-player-only and correct the "unchanged"
  claim.
- **Confidence:** medium

### `canonicalize-missing-in-local-path` — sandbox sims a finer input than the wire
- **Location:** `src/render/loop.ts:56-57`; `src/render/input-controller.ts:71`; `src/net/wire.ts:139-153`
- **What's wrong:** The live path feeds raw `input.sample()` straight into `sim.advance()` *without*
  `canonicalizeInput()`. The netcode path always canonicalizes first (requantizing aim to 16-bit and move
  to int8). So the sandbox simulates a different (finer) input than any networked peer would for the same
  key presses — exactly the self-desync `wire.ts:139-143` warns about. The "sim and renderer stay exactly
  as they are when netcode lands" promise (`main.ts:13-16`) is therefore false.
- **Fix:** Run `canonicalizeInput()` on the local input in the single-player path too (in
  `InputController.sample()` or in `loop.ts` before `advance`), or move canonicalization into a shared
  helper both `startLoop` and `RollbackManager` call.
- **Confidence:** high

### `camera-tilt-and-fov-off-spec` — FOV 50° / tilt ~48° out of band
- **Location:** `src/render/renderer.ts:53-54,161`
- **What's wrong:** FOV is 50° (spec wants 38-42°, a longish lens to avoid edge parallax) and tilt is
  ~48.4° down (spec wants ~55°). The wider FOV exaggerates edge distortion; the shallower tilt shows less
  of the vertical shaft/gap-depth that sells "how far is the fall."
- **Spec:** 07 §1.1 — "FOV ~38-42°… Tilt ~55° down from horizontal (35° above the floor)."
- **Fix:** FOV ≈ 40; choose the offset so the down-pitch is ~55°: for distance D, offset
  `(0, D·sin55°, D·cos55°) ≈ (0, 0.819D, 0.574D)` (with D_close≈14, ≈ `(0, 11.5, 8.0)`). Keep yaw 0.
- **Confidence:** high

### `no-spread-zoom-dolly` — camera distance is hard-coded
- **Location:** `src/render/renderer.ts:161`
- **What's wrong:** Dolly distance is fixed (`+18` up, `+16` back) regardless of crew spread. The spec's
  "breathing dolly" pulls back for a spread scrum (D_far≈30) and settles in close for calm coordination
  (D_close≈14) with asymmetric hysteresis. Without it, a spread crew overflows the frame and a lone
  climber is framed too far.
- **Spec:** 07 §1.4 — extent-driven zoom, `D_close≈14`, `D_far≈30`, out ~180ms / in ~500ms.
- **Fix:** Each frame compute the weighted-target bounding extent, map via `smoothstep` to a distance in
  `[D_close, D_far]`, apply asymmetric hysteresis, and scale the offset along the fixed view direction.
- **Confidence:** high

## UX

### `grab-throw-control-no-feedback-or-charge` — throw charge invisible; no toggle-grab
- **Location:** `src/render/input-controller.ts:63-67`
- **What's wrong:** Throw charge ramps over 30 ticks while grab is held, but the player gets no charge
  meter, no growing arc, no indication that holding longer throws farther — the throw is blind. (Note:
  with `throw-charge-broken` unfixed, charge is also always ~0.) Also, RMB-hold-to-grab has no toggle
  alternative the spec requires for accessibility.
- **Spec:** 07 §3.2 — "Arc thickness encodes throw power (charge)." §6.3 — hold/toggle options for grab
  and recall.
- **Fix:** While grab is held with something carried, render a charge-growing aim arc (thickness/length
  scaled by `ticksHeld/THROW_CHARGE_TICKS`). Add a toggle-grab option in `input-controller`.
- **Confidence:** high

### `no-render-interpolation-judder` — no interpolation alpha
- **Location:** `src/render/loop.ts:63`; `src/render/renderer.ts:128-147`
- **What's wrong:** The renderer draws authoritative sim positions with no interpolation alpha despite
  the spec mandating it and the renderer's own docstring promising it. `render(w)` ignores the accumulator
  and sets exact sim positions; on any non-60Hz display this produces visible micro-judder.
- **Spec:** 05 §1.1 — "render with `alpha = accumulator / DT` interpolation."
- **Fix:** Track per-body previous positions in the renderer, pass `alpha = acc / MS_PER_TICK` from
  `loop.ts`, and lerp render position (and shortest-arc facing) between prev and current. View-only,
  never fed back — determinism-safe.
- **Confidence:** high

### `held-color-erases-role-identity` — held tint destroys identity color
- **Location:** `src/render/renderer.ts:103-108` (colorFor)
- **What's wrong:** `colorFor` recolors any grabbed non-Anchor body to flat magenta, erasing its crew/
  role color the moment it's grabbed. The spec's legibility hierarchy puts identity color *above* state
  and solves "who is held" with a leash + limp posture, not by destroying the body's identity. A grabbed
  teammate and grabbed rival turn the same color.
- **Spec:** 07 §3 — "silhouette > identity color > state aura > motion"; §3.2 — red/green leash + limp
  posture.
- **Fix:** Keep the body's identity color; convey "held" via the leash line (per `no-verb-visual-
  feedback`) and/or an additive emissive aura, not by replacing the base color.
- **Confidence:** high

### `rivals-share-player-color-and-pull-camera` — no mine-vs-not-mine read
- **Location:** `src/render/renderer.ts:103-107` (colorFor) and `:151-153` (centroid)
- **What's wrong:** No crew concept in the renderer: every `BodyFlag.Player` body is the same blue and
  contributes equally to the centroid. Once multi-crew bodies exist, rivals are indistinguishable from
  your crew AND yank your camera (spec: `w_rival=0.0`). The "mine vs not-mine" read — the spec's single
  most important identity read — is impossible.
- **Spec:** 07 §3.1 (crew saturation + guidance glow vs desaturated rivals); §1.2 (`w_rival=0.0`).
- **Fix:** Add a crew id (per `no-crew-team-identity`), tint by crew, desaturate non-local crews, add a
  guidance glow on the local Anchor, and weight rivals at 0 in the centroid.
- **Confidence:** medium

### `multitick-frame-sample-couples-edges-to-pacing` — `sample()` mutates edge state per tick
- **Location:** `src/render/loop.ts:53-60`; `src/render/input-controller.ts:66-67`
- **What's wrong:** The accumulator calls `input.sample()` once per tick, but `sample()` reads live key
  state and mutates `prevGrabHeld` each call. In a multi-tick catch-up frame, all N ticks get identical
  live input and the THROW edge lands only on the first tick of the burst (not where the player visually
  released). Coupling input-edge semantics to frame pacing is a desync risk the moment this controller
  feeds rollback (ticks must be re-sampled deterministically, not from a stateful live reader).
- **Fix:** Make edge detection independent of call count: compute Throw/Grab edges from event-driven
  latches, and have `sample()` be a pure projection that clears one-shot latches only when a tick consumes
  them. Or sample once per rendered frame and feed the same `PlayerInput` to all N ticks.
- **Confidence:** medium

---

# LOW

## BUG

### `fall-damage-uses-prev-tick-vy-underestimate` — impact speed off by one gravity tick
- **Location:** `src/sim/sim.ts:92-93,117-124`
- **What's wrong:** Impact speed uses `preVy` captured at the *start* of the tick, before this tick's
  gravity. The true impact speed is `preVy + GRAVITY·DT`, so every landing is underestimated by one tick
  of gravity (~0.37 u/s). Inconsistent with the helper's doc claiming "pre-ground-resolve" velocity
  (`falldamage.ts:17`) — `preVy` is pre-gravity, not pre-ground-resolve.
- **Fix:** Capture impact velocity after gravity+integrate but before the ground clamp zeroes it, or add
  the one-tick gravity term when computing `impact`.
- **Confidence:** medium

### `regrab-immunity-not-armed-on-bump-break` — rush bump breaks an established hold
- **Location:** `src/sim/verbs/verbs.ts:268-278` (rushBump)
- **What's wrong:** The rush bump-to-break adds `STRUGGLE_BREAK/2` (+50) to the victim's struggle
  progress and breaks the hold if it crosses threshold — so a single rush breaks an established hold
  whenever the victim was already ≥50. §2.1 says a stagger "interrupts an in-progress grab attempt but
  does not break an established hold (you have to STRUGGLE or get a Bulwark for that)."
- **Fix:** A rush should stagger the carrier and cancel a *pending* latch but not by itself break an
  established hold. Remove the established-hold break in `rushBump`, or gate it behind the Bulwark
  "Unhand" ability. Ensure immunity arming + struggle reset are consistent on every break path.
- **Confidence:** medium

### `spatial-grid-out-of-range-cell-key-aliasing` — distant cells alias to the same key
- **Location:** `src/sim/spatial/grid.ts:37-42,62-64`
- **What's wrong:** `cellKey` offsets by `2^15` and strides by `2^16` with no clamp; a body whose cell
  coord leaves `[-32768, 32767]` (±65 km at 2m cells) aliases onto a legitimate in-range cell, so two
  distant bodies share a cell and get spuriously collision-resolved. Determinism-silent, not a crash; a
  thrown body or one falling through the world (no kill-plane yet) can reach it.
- **Fix:** Clamp cell coords into the representable range (or assert in debug), or hash `(cx,cz)` without
  fixed-stride packing so distant coords can't alias. Pair with an out-of-bounds cull / kill-plane.
- **Confidence:** medium

## MISSING

### `held-player-chip-damage-missing` — no cost-to-hold chip
- **Location:** `src/sim/verbs/verbs.ts` (hold maintenance, ~313-334)
- **What's wrong:** §4.2 "Held-player chip": a held player deals 1 HP / 12 ticks to the carrier. No code
  applies any damage to a carrier while holding a player; the cost-to-hold pressure is absent.
- **Fix:** In hold maintenance, when `holding[i]` is a Player/Anchor and `(tick − heldSince) % 12 === 0`,
  subtract 1 HP from `w.health[i]` (carrier), clamped at 0. Integer-tick for determinism.
- **Confidence:** high

### `catch-falling-and-moving-body-light-latch-not-modeled` — no light catch-latch
- **Location:** `src/sim/verbs/verbs.ts:374-378`; `config.ts:41-46`
- **What's wrong:** §5.3/§5.4: catching an in-flight/falling body uses the LIGHT latch (~7 ticks). The
  code always uses the mass-scaled `GRAB_LATCH_TICKS` (Anchor = 22) regardless of airborne/thrown state,
  so you can't catch a thrown Anchor — the catch verb is unreachable. *(Overlaps the MEDIUM
  `grab-latch-not-airborne-catch-of-faller`; resolve together.)*
- **Fix:** When the target is airborne/falling/thrown, use a fixed short catch-latch (~7 ticks). Add the
  Mender's +40% catch cone once roles exist.
- **Confidence:** medium

### `no-co-carry-litter` — two-teammate co-carry / co-throw unimplemented
- **Location:** `src/sim/verbs/verbs.ts:464-475`; `config.ts:128-133`
- **What's wrong:** The two-teammate litter (~70% speed at the cost of two sets of hands) and co-throw
  are unimplemented — `holding[]`/`grabbedBy[]` model exactly one carrier per held body, so the spec's
  slow-solo vs fast-litter tempo trade can't occur.
- **Fix:** Allow a second carrier to latch the same held body (secondary carrier id), apply a faster
  `CARRY_SPEED_MUL` for two carriers, average sockets; for co-throw, sum thrower strengths when two
  release together within a small window. Lower priority than the carry/throw core.
- **Confidence:** medium

### `no-coalescence-no-floors-above-below` — signature reveal/coalescence visuals absent
- **Location:** `src/render/renderer.ts:1-60` (single arena, flat fog)
- **What's wrong:** The signature identity — floors above as dotted/glowing wireframe "potential"
  resolving dots→lines→panels→lit as climbers approach, and floors below desaturating/fogging — is
  absent. The renderer draws one arena with a uniform `THREE.Fog`. Largely downstream of
  `floor-module-not-wired`, but it's the pillar-7 visual-identity layer.
- **Spec:** 00 pillar 7 + 06 §0; 01 §6.
- **Fix:** Defer until the tower exists. Then add a view-only `reveal∈[0,1]` driven by sim-truth Anchor
  distance to each stratum (collision exists from seed-time; reveal is cosmetic), a wireframe→solid
  shader for floors-above, and desaturate+fog for floors-below with crew-color rim staying fog-immune.
- **Confidence:** medium

## SPEC-MISMATCH

### `encumbrance-struggle-shove-penalty-missing` — no −20% hands-full penalty
- **Location:** `src/sim/verbs/verbs.ts:531-567` (struggle) + `:690-722` (shove)
- **What's wrong:** §4.3: "Encumbrance also lowers your own struggle/shove value by 20% while hands-full."
  Not implemented — `applyShove` computes `j = SHOVE_J/mass` with no hands-full check; struggle `inc` has
  no encumbrance term. The shove penalty is concretely reachable (a carrier shoving while hands-full
  should be 20% weaker).
- **Fix:** When `w.holding[i] !== NO_ENTITY`, scale the shove impulse (and reachable struggle value) by
  0.8 before applying.
- **Confidence:** medium

### `grab-priority-prompt-tier-missing` — 3 tiers instead of 4; own Anchor treated as top target
- **Location:** `src/sim/verbs/verbs.ts:422-428` (grabTier)
- **What's wrong:** §4.1 grab priority is 4 levels (enemy Anchor > prompt-able player > world object >
  player). `grabTier` implements 3 (Anchor=0, Throwable=2, Player=3) — the prompt-able/friendly-catch
  tier is missing, and "enemy Anchor" is *any* Anchor (no team data), so a crew grabbing toward its own
  Anchor treats it as the top-priority adversarial target.
- **Fix:** Once team data exists, split: enemy Anchor=0, friendly/prompt-able player=1, world object=2,
  generic player=3. Until then, don't treat the own Anchor as the highest-priority target. Depends on
  `no-crew-team-identity`.
- **Confidence:** medium

## POLISH

### `throw-nudge-uses-grab-reach-not-carry-reach` — release teleports body 2.2u, not 0.9u
- **Location:** `src/sim/verbs/verbs.ts:684-686` (applyThrow nudge)
- **What's wrong:** `applyThrow` nudges the thrown body using `GRAB_REACH` (2.2u) instead of `CARRY_REACH`
  (0.9u, the actual carry socket), so the thrown body teleports 2.2u in front on release rather than from
  the 0.9u socket — a small instantaneous position jump disagreeing with where it visually was.
- **Fix:** Use `CARRY_REACH` (+ a small clearance like the target radius) for the release nudge.
- **Confidence:** high

### `double-ground-resolve-step-and-terrain` — ground clamp runs twice; hidden coupling
- **Location:** `src/sim/world/step.ts:109-121` vs `src/sim/collide/terrain.ts:133-140`
- **What's wrong:** The ground-plane clamp runs twice per tick (motionPhase SYSTEM 4 + `resolveTerrain`),
  idempotent only because both use plane y=0 in the sandbox. It's a latent bug: any level with
  `terrain.groundY != step's hard-coded GROUND_Y (0)` gets two different floors / a wrong Grounded+friction
  surface. `collide/index.ts:42-48` already predicted this.
- **Fix:** Remove the ground-clamp half of `step.ts` SYSTEM 4 now that `resolveTerrain` runs every
  `advance()`, keeping only the friction read of the Grounded flag; make `terrain.groundY` the single
  source of truth. Keep `step()` self-sufficient for the motion-only proof via a shared parameterized
  ground-resolve.
- **Confidence:** high

## NETCODE-POLISH

### `verifiedThrough-checkframe-double-hash-and-gap` — check-frames can stride past their multiple
- **Location:** `src/net/rollback.ts:121-129`
- **What's wrong:** The periodic check-frame hashes the same snapshot twice (wasteful) and only fires when
  `verifiedThrough()` lands exactly on a multiple of `CHECK_PERIOD`. Because `verifiedThrough()` can jump
  by >1 when a redundant input batch arrives after loss, the frontier can skip the exact multiple and emit
  no check-frame for that window — weakening desync detection precisely during the lossy conditions
  check-frames exist to catch.
- **Fix:** Track `lastCheckTick` and emit a check-frame for every crossed multiple since the last one
  (loop `lastCheckTick+CHECK_PERIOD..verified`), hashing each ring snapshot once into a local const reused
  for broadcast and `compareChecks`.
- **Confidence:** medium

---

## Appendix: known-but-expected gaps (informational, not scored as defects)

These are real facts about the build, but the codebase already documents them as intended P1-vs-later
staging, so they are *not* counted as findings above:

- **Netcode not wired into the playable app** (`src/net/*` is reachable only from `prove.ts`). This is
  explicitly stated in `main.ts:11-16`, `transport-peerjs.ts` ("VERIFICATION STATUS / integration-pending"),
  and `docs/ROADMAP.md` (rollback-over-transport is the P2 keystone). "Netcode core proven headlessly"
  ≠ "multiplayer is reachable" — worth keeping that distinction explicit in user-facing notes, but it is
  a documented phase, not a defect.
