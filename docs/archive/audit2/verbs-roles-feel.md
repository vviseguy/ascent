# Audit v2 — VERBS, ROLES & FEEL (docs/02, docs/07 §4)

Auditor dimension: the six identities, the four verbs + grab pressures, co-op carry intent,
and the juice/feel layer. All findings verified against current source (June 2026 build,
`main` @ 618e24f). Citations are file:line as read.

---

### roles-cast-incomplete-and-inert — only 3 of 6 identities exist in play, and only one of them is alive
- Severity: CRITICAL
- Intent: docs/02 §6 — six asymmetric identities whose interdependency web (§7) IS the game.
  docs/07 §5.2: each role learns its "signature interdependency" by doing it. Pillar 8.
- Reality: `buildTower` spawns `crewSize` players with roles `CREW_ROLES[i % 5]`
  (src/game/scene.ts:41, :154) and main.ts calls it with `crewSize: 3` (src/main.ts:32), so the
  cast is Runner, Bulwark, Mender, Anchor — **Engineer and Breaker are never spawned**. The local
  player is `playerIds[0]` = the **Runner**, permanently (src/game/scene.ts:180; no role-switch
  input exists in src/render/input-controller.ts). Every other body gets `undefined` input every
  tick (`frame.fill(undefined); frame[localPlayerId] = localInput`, src/render/loop.ts:64-65),
  which the sim reads as NEUTRAL_INPUT — teammates and the Anchor are immobile statues.
- Gap: role asymmetry is unexperiencable. You can never use the Mender revive, Bulwark Unhand,
  Engineer bridge, or Breaker shove (all implemented in src/sim/verbs/abilities.ts:148-153 but
  dispatch only on a body's own input). The "crew" is scenery you can pick up and carry.
- Fix sketch: spawn all five roles (crewSize 5) and add a debug body-swap key (Tab cycles
  localPlayerId) so each role/ability is playable solo until multiplayer lands.

### coop-vertical-verbs-unrealizable — the hand-up / gap-lock / bridge web has zero sites and zero inputs
- Severity: CRITICAL
- Intent: docs/02 §5.2 — the hand-up: "carry an ally/Anchor to a ledge and THROW upward (aim
  ≥ 50°)"; §7 — every stratum is a coordination puzzle (Engineer ramp + Bulwark throw + catch);
  §2.1 Anchor gap-lock. docs/07 §9 t=30-42: "the Anchor hits a gap it can't cross alone."
- Reality: three independent blockers, all confirmed:
  1. **No vertical aim exists.** `PlayerInput.aim` is one planar angle (src/sim/world/input.ts:50);
     `applyThrow` always launches at `THROW_ANGLE_DEFAULT` (38°) + jitter (src/sim/verbs/verbs.ts:923-924).
     "THROW upward (aim ≥ 50°)" is physically impossible to input.
  2. **No traversal sites.** The tower compiler pushes a solid slab under EVERY cell of every
     stratum (src/game/tower.ts:97-104) — the floor above is an unbroken ceiling; the header
     comment "The EXIT cell of each stratum has a ramp/opening" (tower.ts:20-22) is never
     implemented (the exit cells are read nowhere; entry is only a spawn hint, tower.ts:130-131).
     'GAP' edges add nothing (tower.ts:116) but adjacent full-cell slabs meet flush, so there are
     **no chasms within a floor either** — nothing for the Anchor to be gap-locked by.
  3. **The enablers are absent**: Engineer (bridge) isn't spawned (finding above); the
     spring-plate, wallkick, and Anchor Brace-up don't exist (next finding).
- Gap: the co-op-carry heart of the game (Pillar 1/2) cannot occur. Solo-walking isn't merely
  sufficient — it is the only verb the terrain ever asks for, and even it can't ascend.
- Fix sketch: compile a hole + ramp (or stair slabs) at each exit cell; carve real seam gaps for
  GAP edges; add aim elevation to PlayerInput (e.g. quantized pitch from cursor distance) so
  charged throws can loft.

### runner-scout-mark-is-a-no-op — the only ability the player can press does nothing perceivable
- Severity: HIGH
- Intent: docs/02 §6.1 — Mark "lights it on the crew HUD for 4 s. Scouting value."
- Reality: `tryRunnerScout` writes `w.scoutMark[r] = best` (src/sim/verbs/abilities.ts:431).
  Grep across src/: `scoutMark` is written in abilities.ts, declared/reset in
  src/sim/world/state.ts:257,332,416, asserted in abilities-prove.ts:242 — and **consumed by
  nothing**. The renderer never reads it (no occurrence in src/render/). The local player is the
  Runner, so tap-Right (ability) silently sets an invisible integer and starts a 3 s cooldown.
- Gap: the one ability the player can actually trigger has zero feedback; players will conclude
  the ability button is broken — and they'd be functionally right.
- Fix sketch: renderer draws a pulsing ring/label on `w.scoutMark[localId]` for ~4 s
  (view-only read, like the leash/struggle FX in drawVerbFx).

### second-ability-slot-missing — every role's Ability 2 (incl. Runner Wallkick) is absent
- Severity: HIGH
- Intent: docs/02 §1 — two ability buttons (R/L triggers); §6.1 Wallkick is "the premier
  solo-traversal skill"; §6.3 Tether-shield; §6.4 Spring-plate; §6.5 Collapse-charge; §6.6
  Anchor Brace-up.
- Reality: the input has a single `Button.Ability` bit (src/sim/world/input.ts:28) and
  `applyAbilities` dispatches exactly one verb per role; Anchor/None get `default: break`
  (src/sim/verbs/abilities.ts:148-155). No wallkick, tether-shield, spring-plate,
  collapse-charge, or Brace-up exists anywhere in src/sim.
- Gap: half of every kit is missing; notably the Runner (the body you play) loses its entire
  traversal expression, and the Anchor is a pure passenger with no active co-op verb beyond
  the beacon.
- Fix sketch: add Button.Ability2 (keyboard already has free keys); implement Wallkick first —
  it's solo-testable and the Runner is the local body.

### role-stat-tables-unimplemented — speed/health/size identical across all five player roles
- Severity: HIGH
- Intent: docs/02 §6 table — Speed 1.25/0.85/1.0/0.95/0.95/0.70, Health 80/140/95/100/120/200,
  Size 0.9/1.3/1.0/1.0/1.15/1.4. "Fast/fragile" vs "slow, tanky" is the identity read.
- Reality: horizontal speed scales only by MassClass — all non-Anchor players 1.0, Anchor 0.78
  (src/sim/world/step.ts:65-70). Health defaults to 100 for every body
  (src/sim/world/state.ts:388; scene.ts never overrides). All players spawn radius 0.4 /
  halfHeight 0.9 (src/game/scene.ts:152). Only THROW_STRENGTH / STRUGGLE_STRENGTH
  (src/sim/verbs/config.ts:203-220) and the ability differ per role.
- Gap: a Runner doesn't feel fast and a Bulwark doesn't feel tanky; mechanically the roles are
  reskins with different throw arms. The visual silhouettes (character.ts:81-89) promise a
  difference the sim doesn't deliver.
- Fix sketch: add a per-role SPEED_MUL/health/size lookup at spawn (scene.ts spec fields) +
  a role-speed multiplier in step.ts SYSTEM 1.

### defensive-verbs-unreachable — STRUGGLE, revive, Unhand, and Q-recall can never fire in this build
- Severity: HIGH
- Intent: docs/02 §2.4 STRUGGLE is one of the four core verbs; docs/07 §5.1 "First time grabbed →
  teach STRUGGLE." Legend promises "Q recall/plant" (src/main.ts:59).
- Reality: nothing can ever grab the local player (all other bodies have neutral input, never
  press Grab — src/render/loop.ts:64-65), so the L/STRUGGLE path (verbs.ts:701-767) is dead code
  in play. Recall: only an Anchor plants a beacon (src/game/beacon.ts:52-60); the Anchor never
  receives input, so `cs.beaconTick` stays -1 and every non-Anchor recall press exits at
  beacon.ts:63. Q does nothing, forever. Mender revive needs a downed *bleeding* ally
  (abilities.ts:166-176) — possible only if a statue teammate falls hard, and you aren't the
  Mender anyway.
- Gap: of the advertised control surface (move, jump, grab/throw, dash, ability, struggle,
  recall), struggle + recall + ability are all silent no-ops — a third of the legend is false,
  which corrodes trust in the rest.
- Fix sketch: short-term, have the (inert) Anchor auto-plant its beacon at spawn so Q works;
  remove L/struggle from the legend until something can grab you (or add a debug "teammate
  grabs you" key).

### no-world-objects-in-tower — the "grab anything" verb sandbox shipped without any things
- Severity: HIGH
- Intent: docs/02 §3 — light/heavy object tiers ("crate, debris, barrel") teach the mass
  hierarchy; docs/07 §9 t=18-30: "a loose crate in reach teaches GRAB."
- Reality: `buildTower` spawns players + Anchor and nothing else (src/game/scene.ts:142-163).
  The 8 throwable crates exist only in `buildSandbox` (scene.ts:86-92), which main.ts no longer
  calls (src/main.ts:32). No hazards either (`hazards: []`, scene.ts:178).
- Gap: the first-GRAB teaching beat and the entire light-vs-heavy throw feel (short/hard vs
  far/fast, §2.3) are absent; the only grabbables are teammates and the VIP.
- Fix sketch: scatter a few Light/Heavy throwables per stratum in buildTower (positions derived
  from the floor seed — deterministic).

### ring-out-without-drama-plus-respawn-loop — the signature beat is a silent infinite death cycle
- Severity: HIGH
- Intent: docs/07 §4.5 — true ring-out: slow-mo ~35%, focus pull, crown-shatter VFX, klaxon;
  altitude-loss: streak + standings slam. "The signature dramatic beat."
- Reality: the renderer has no kill-plane/death/ring-out detection at all (detectEvents handles
  only landing/throw/grab/rush — src/render/renderer.ts:484-545); no slow-mo path exists. Worse:
  walk or throw the Anchor off the tower edge → below killPlane → `scheduleRespawn` → respawn:
  the Anchor can't use the anchor-fallback branch (`cs.anchorId !== id`, src/game/survival.ts:116)
  and with no beacon hits "last resort: lift to ground height" — y=1 m at the SAME off-tower x/z
  (survival.ts:119-123) → it falls below the kill-plane again → death/respawn loop every ~4 s,
  with zero on-screen feedback while the HUD reads SECURE→DOWNED forever.
- Gap: the most dramatic moment the spec defines is instead an invisible soft-lock.
- Fix sketch: respawn fallback must clamp x/z to the nearest stratum tile (or stratum-0 entry);
  add a render-pace slow-mo + banner on any kill-plane crossing (renderer already has the
  hitstop machinery to extend).

### rush-double-integration — the dash travels ~2× its spec distance
- Severity: MEDIUM
- Intent: docs/02 §2.1 — RUSH: 4.0 u over 9 ticks, ~26 u/s peak.
- Reality: each dash tick, rushSystem moves the body by the sweep step AND sets
  `vx = dx·60` "so it feels like momentum" (src/sim/verbs/verbs.ts:283-289). Next tick,
  motionPhase integrates that echoed velocity again (src/sim/world/step.ts:127) *before* the
  next sweep step is added — the brake (1.9 u/s/tick) barely dents a 48 u/s echo. Net dash
  ≈ 4.0 u (sweep) + ~3 u (echo) ≈ 7+ u at ~48 u/s peak.
- Gap: dash overshoots intent ~2×, reads floaty/teleporty, and will overshoot ledges once real
  gaps exist; also breaks the carefully-specced "rush-carry the Anchor ≈ 1.0 u" tuning.
- Fix sketch: zero vx/vz during the dash (position-sweep only) and impart exit velocity once on
  the final dash tick.

### right-button-tap-hold-latency — both flashpoint verbs gained 150 ms of input lag
- Severity: MEDIUM
- Intent: docs/02 §1 — RUSH and JUMP are distinct buttons "because they're both spammed in
  flashpoints and must not eat each other"; docs/07 §1.3 prizes snappiness.
- Reality: the mouse-first scheme overloads RIGHT: Rush fires only after the hold crosses
  RIGHT_HOLD_TICKS = 9 (~150 ms) (src/sim/verbs/verbs.ts:1043, 1071-1077), and the ability fires
  only on RELEASE of a sub-150 ms tap (verbs.ts:1079-1082). Keyboard J has the same RightHold
  path (src/render/input-controller.ts:79) — there is no zero-latency rush input at all.
- Gap: the panic verb arrives a beat late, every time; the ability arrives on release, which
  reads as "sometimes it works" (especially since the Runner ability is already invisible).
- Fix sketch: fire Rush on RIGHT press-edge immediately and reinterpret as ability only if
  released within the window (rush-cancel), or give Ability its own mouse button (e.g. MMB).

### legend-promises-tap-shove — the advertised empty-hand shove doesn't exist on mouse
- Severity: MEDIUM
- Intent: docs/02 §2.3 — "a bare tap of THROW with empty hands = shove"; legend text itself:
  "hold Left grab/carry, release Left throw (a tap = shove)" (src/main.ts:57-58).
- Reality: SHOVE fires only on a `Button.Throw` press-edge (src/sim/verbs/verbs.ts:812-817), and
  Button.Throw maps only to keyboard F (src/render/input-controller.ts:78). A bare LMB tap is a
  Grab press+release: it starts/cancels a latch and does nothing else — no shove path.
- Gap: the tempo tool the spec calls "pure tempo… contests ledges" is unreachable on the
  primary control scheme, and the on-screen legend teaches a lie.
- Fix sketch: in resolveRightButton-style logic, translate a LEFT release before any latch
  completed into Button.Throw for that tick (deterministic, mirrors the right-button resolver).

### throw-arc-misleads — no landing reticle, and the preview ignores every floor above the deep slab
- Severity: MEDIUM
- Intent: docs/07 §3.2 — thrower sees a color-coded landing reticle (green/yellow/red =
  safe/edge/void); "throwing your own Anchor is legibly risky." Struggle wriggle jitters the arc.
- Reality: throwArc draws a dashed parabola that terminates only when `py < this.groundY`
  (src/render/renderer.ts:794-798) — and groundY is the DEEP slab under the kill-plane
  (tower.ts:141: terrain.groundY = deep). On any stratum the arc happily draws through the slab
  you're standing on and far below it. No reticle, no safety color (only charge→hotter,
  renderer.ts:801), no aim-spoil jitter, and it ignores THROW_STRENGTH (Runner-baseline J for
  all roles, renderer.ts:791).
- Gap: the single most important risk read for the escort fantasy (where will my Anchor land?)
  is wrong everywhere above stratum 0.
- Fix sketch: raycast the arc samples against terrain solids (view-side AABB test) and drop a
  colored reticle disc at the first hit; tint red when no hit above killPlaneY.

### boons-inert-and-invisible — drafts fire, change nothing, and are never shown
- Severity: MEDIUM
- Intent: docs/03 (rubber-band boons) + docs/07 §2.4 — a boon chip "icon + one-line + the input
  to use it"; boons are the climb's progression dopamine.
- Reality: stepMatch auto-drafts at milestones and stores ids in `crew.boons`
  (src/game/match.ts:184-214), but no code anywhere reads `crew.boons` for an effect (grep:
  only boons.ts/match.ts/prove.ts; `slipstreamBonus` has zero callers) and the renderer never
  displays them (no boon reference in src/render/).
- Gap: a whole progression system runs silently — the player cannot know it exists, and it
  wouldn't matter if they did. (Rubber-banding itself is moot with numCrews=1, scene.ts:171 —
  blocked on multiplayer; the visibility + effect wiring is not.)
- Fix sketch: show a toast + chip on draft (read match.crews[local].boons in updateHud); wire
  the two cheapest effects (Strong Toss → THROW_STRENGTH bonus, Sticky Boots → brake bonus)
  through a per-crew modifier the verb layer reads.

### leash-color-stale — ally carries render as hostile red
- Severity: LOW
- Intent: docs/07 §3.2 — green leash = friendly carry, red = hostile, "consistent for every
  mass tier."
- Reality: `const friendly = id === localId; // (crew identity not yet modeled…)`
  (src/render/renderer.ts:772) — but crew identity IS modeled (`w.crewId`, used by the sim's own
  isSameCrew, verbs.ts:562-566). Any non-local carrier draws the hostile leash.
- Gap: latent today (only you can grab), wrong the moment a second input source exists.
- Fix sketch: `friendly = w.crewId[id] === w.crewId[held] && w.crewId[id] !== NO_CREW`.

### throw-ring-at-thrower — release FX reads cleared linkage
- Severity: LOW
- Intent: docs/07 §4.3 — directional burst at the hands + speed-smear on the projectile.
- Reality: detectEvents runs after the sim tick, so on the release tick `w.holding[id]` is
  already NO_ENTITY (cleared in applyThrow, src/sim/verbs/verbs.ts:908) — the
  `held !== NO_ENTITY` branch (src/render/renderer.ts:522-525) never takes; the ring always
  spawns on the thrower, never the launched body, and the projectile gets no smear.
- Gap: big throws read slightly flat; the launched body (the thing you care about) is unmarked.
- Fix sketch: detect the thrown body via its grabbedBy→NO_ENTITY transition paired with a fresh
  lastThrowTick on its ex-carrier, and burst there.

---

**What's genuinely IN and working** (verified, credit where due): the four-verb sim core with
all five grab pressures incl. trains, catch-latch, friendly-dismount thresholds, charge-bleed
and aim-spoil (src/sim/verbs/verbs.ts) matches docs/02 remarkably closely; encumbrance is felt
(speed clamp verbs.ts:998-1019 + rush shortening :278 + mass-scaled carry sag/short-steps
character.ts:234-241); the §4.2-4.4 juice ladder substantially exists — trauma/shake with
squared response and roll cap (renderer.ts:61-68, 821-831), budgeted hitstop (renderer.ts:552-566),
pooled impact rings + dust (renderer.ts:694-762), landing squash, throw wind-up, stagger/downed/
grabbed-wriggle postures (character.ts:206-271), and role-shaped silhouettes (character.ts:81-89).

**Dimension verdict (3 lines):**
The verb ENGINE is excellent and spec-faithful; the verb GAME is missing — the playable build casts
one live Runner among statues, with no objects, no second abilities, no vertical inputs, and no
terrain that ever demands grab/carry/throw/bridge, so the six-role escort fantasy currently exists
only in the test suite. Juice is ~70% landed (latch/throw/land), but the drama tier (ring-out,
assists, ascend pop) is absent and the one ring-out you can cause is a silent respawn loop.
Priority: make the other roles playable + give throws/terrain a vertical dimension before any tuning.
