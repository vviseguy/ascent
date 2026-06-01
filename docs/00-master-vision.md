# 00 — Master Vision (ASCENT) — v3

> **The one rule that generates the whole game: a crew's standing is THEIR ANCHOR'S HEIGHT, and nothing else.**
> This is the canonical top-level doc. It condenses the 12 pillars, resolves the cross-cutting tensions
> authoritatively, fixes the core data flow, and defines "fun" for the vertical slice. Where a number or
> mechanism is owned by a sibling doc, this doc cites it and does not relitigate it. Read this first, then
> the pillar docs (01–09). LEAD DESIGNER ownership; this supersedes any earlier vision file.

---

## 1. Elevator Pitch

ASCENT is a browser-based, realtime, multiplayer **vertical escort brawl-race**. Crews of 3–5 shepherd
their **Anchor** — a heavy, slow, precious-but-*active* teammate — up an endless tower of gaps, hazards,
and rival sabotage. You build routes, catch falls, carry each other across chasms, throw world objects,
and grab-and-throw the *other* crews' Anchors into the abyss. **Highest Anchor wins.** Nothing else is
scored.

Touchstones: **Gang Beasts** (physical grab/throw) × **Overcooked** (clean co-op verbs, calm→panic→calm
rhythm) × **Overwatch payload-escort** (the objective is a thing you move together) × **Mario Kart**
(rubber-band catch-up), played **climbing up** an endless tower with **Smash Bros. position-kills** (you
kill with the throw, not with damage).

## 2. The Genre, Stated Precisely

**Vertical escort brawl-race.** Decompose it:

- **Escort** — the objective is a teammate you physically move (carry / throw-across / hand-up / recall).
- **Brawl** — the only combat is the four physical verbs applied to bodies and objects; no HP, no DPS.
- **Race** — the only score axis is altitude; you win by being highest, by climbing or by throwing rivals down.
- **Vertical** — one shared shaft, climbed endlessly; two-way (you can be knocked back DOWN real floors).

The escort target being *your own most important teammate* is what makes co-op and PvP **the same shape**:
the four verbs help your Anchor up or shove a rival's Anchor down with only the *target* flipped. There is
no separate "combat system" to balance against a "traversal system" — there is one verb set and one score
axis.

## 3. The 12 Pillars (condensed; locked)

1. **THE ANCHOR IS THE GAME.** One Anchor per crew. Standing = that Anchor's height, full stop (no
   individual scoring). Co-op and competition collapse onto one axis. The Anchor is an *active* player
   "who spent skill points on being important": heavier, slower, fall-durable, gap-locked — but not
   helpless. Plants the **Recall Beacon** (rally point; recall is *to* the Anchor's height, never ahead;
   cooldown-gated). [01 §2, 04 §1]

2. **PHYSICAL, GRABBABLE WORLD.** Four Overcooked-clean verbs on *everything*: **RUSH** (dash/stagger),
   **GRAB** (latch), **THROW** (aimed release), **STRUGGLE** (mash free). A **mass hierarchy**
   Light(0.4) < Player(1.0) < Heavy(1.8) < Anchor(3.2) drives latch time, carry speed, throw force, and
   struggle resistance. World objects are grabbable/throwable. **Co-op carry is core.** Grab is a **tempo
   tool, not a control tool**, held in check by **five pressures** (§7c). [02 §0–§4]

3. **TERRAIN-FIRST, NO AI.** Antagonists are gravity, hazards, and other players. No NPCs, no behavior
   trees, no creatures. Only **light scripted hazards** that are *pure deterministic functions of the tick*
   (crushers, pattern turrets, cracking-then-reforming tiles, gusts, conveyors, spikes). A major
   determinism win. [09 §3]

4. **PERSISTENT TWO-WAY TOWER.** Floors persist — they never fragment/fall/disappear. You climb up; you
   fall or are thrown down *real* floors that still exist. **Position-kill (Smash model):** thrown ≠ dead.
   Regular players die on big un-arrested falls; the Anchor is fall-durable (punishment = **altitude lost +
   a brief downed/vulnerable beat**), with true death only at a real **kill-plane** (into a hazard or off
   the very bottom). [01 §4, 09 §4]

5. **PURE RACE, NO CHASE.** No rising wall-of-death / no collapse. Pressure = rival Anchors climbing +
   sabotage + rubber-banding. Pacing is **climb-first with brawl flashpoints** (Overcooked rhythm:
   calm-coordination → panic-burst → calm). Anti-turtling is *structural*, not a chase (§7d). [01 §5]

6. **MARIO-KART RUBBER-BANDING.** Trailing crews draw better boons & catch-up tools; getting your Anchor
   thrown down a few floors *is* the diegetic blue-shell that re-bunches the pack. Guardrails: aids
   comebacks without punishing skill; the leader is never directly slowed. [03 §4–§6]

7. **COALESCENCE VISUALS, MAXIMAL SPECTACLE.** True 3D, slight-tilt three-quarter (Hades) view. Floors
   *above* hang as dotted/glowing wireframe "potential" and **resolve** as climbers approach
   (dots→lines→panels→lit); players emerge up through a coalescing floor. Floors *below* **persist**
   (desaturate + fog with distance but stay solid and reachable). Multiple routes per stratum. No loading
   screens. **The entire view layer is determinism-safe** (§7e). [06, 09 §0]

8. **SIX IDENTITIES, ALL IN SERVICE OF THE ANCHOR.** Runner/Scout, Bulwark/Anchor-guard, Mender/Lifeline,
   Engineer/Trickster, Breaker/Mover, and the **Anchor** itself (a distinct, active identity). Nobody gets
   the Anchor up efficiently alone. [02 §3]

9. **RIVAL INTERACTION: "LOTS OF WAYS, BUT JUST LIKE ANY OTHER PLAYER."** A rival Anchor is grabbed,
   thrown, shoved, route-sabotaged with the *same* verbs you use on anyone. You *can* drag a rival Anchor
   (person-CTF flavor), but the five grab-pressures make holding it a slow, exposed, all-in commitment —
   never a lock. Many avenues, none degenerate. [04 §2]

10. **SHARED TOWER, SOFT-SEPARATED BY PACE.** All crews climb ONE physical shaft; they spread by altitude
    and collide at flashpoints/chokes. Frequent-but-not-constant interaction — the ideal fit for the
    AoI = Anchor netcode. [04 §3]

11. **TUNABLE PER LOBBY.** Host settings: win condition (race-to-height / endless-highest /
    rounds-to-summit), lethality, Anchor-death behavior, PvP intensity, pressure knobs, crew size (3–5,
    flex for uneven lobbies). All locked at match start and **hashed into the determinism seed**. [04 §4, 04 §6]

12. **NETCODE ELEGANCE (rollback).** GGPO-style peer-symmetric rollback. AoI centers on each crew's Anchor
    → naturally bounded k≈5 tight-sync clusters → rollback stays small *without* the world deleting itself.
    Determinism: fixed 60 Hz timestep, deterministic physics, seeded PRNG (never `Math.random`),
    shared tick counter (never wall-clock), send inputs not state, redundant last-N inputs over
    unreliable/unordered channels. **#1 named risk: two-body grab constraints + throw impulses + many
    throwable rigid bodies inside the rollback sim** (§7a). [05]

## 4. Resolved Cross-Cutting Tensions (authoritative)

Each call below is a **decision**, not a menu. Sibling docs must conform; deviations must be flagged to
LEAD DESIGNER.

### (a) Grab/throw two-body physics vs. rollback determinism — THE #1 RISK

**Decision: avoid true two-body solver constraints on the hot path entirely.** Model the verbs as
*kinematic transforms over a single deterministic state vector*, not as physics joints:

- **Carry = kinematic parent-socket.** The carrier *owns* the held entity's transform: each tick the held
  body is teleported to `carrier.pos + socketOffset(carrier.facing)` and its velocity is set, not solved.
  No constraint solver runs between the two bodies. Resimulating N ticks is then a pure function of the two
  bodies' inputs — trivially deterministic, trivially cheap to roll back. [02 §5, 05 §5]
- **Throw = an idempotent impulse keyed by `(entityId, releaseTick)`.** Charge is derived from
  `(grabStartTick, releaseTick)` — *never* a float accumulator that could drift across a rollback. Applying
  the same throw twice (once speculative, once after correction) is a no-op the second time. The thrown body
  then flies under ordinary single-body ballistic integration. [02 §5]
- **RUSH = a kinematic capsule sweep**, resolved as a swept query + position correction, not a solver
  impulse. [02 §5]
- **The "train" (grabber-is-prey chain) is the *only* place a real multi-body constraint may appear**, and
  it is **rare, length-capped, and the explicit content of the P2 determinism spike.** Cap chain length
  (target: ≤3 links; the anti-pile-on stand-up window in [03 §6] / regrab immunity [04 §2] bound it
  further). If a true joint train cannot be made bit-deterministic and cheap to roll back within the spike,
  **the fallback is to collapse a train into a single composite kinematic body** (sum-capped mass per
  [02 §2]) driven by the head grabber — i.e., trains use the same parent-socket trick, never a solver.
- **All grab/throw/struggle randomness comes from the seeded sim PRNG only.** [02 §5, 05 §0]

**Why this works:** the determinism risk is fundamentally "does a constraint solver produce bit-identical
results when re-run from a rollback?" By keeping the verbs kinematic, there is *no solver coupling between
bodies* to diverge. Free-flying thrown objects are single-body integration, which Rapier-fixed (or
fixed-point) already handles deterministically. **The hard case is reduced to: many independent single
bodies + occasional capped composite bodies.** That is the thing the P2 spike proves. [→ ROADMAP P2]

**Fallback ladder if even single-body float physics diverges cross-browser:** (1) Rapier WASM with the
deterministic/fixed build and fixed iteration order; (2) if cross-browser trig/float still drifts, move the
sim to **fixed-point** integration for position/velocity (the spike measures this); (3) worst case, snap
free-body simulation to a coarse deterministic grid for the rare contested airborne cases. The view layer
interpolates regardless, so visual smoothness is independent of this choice. [05 §0]

### (b) Grabs/throws that CROSS AoI boundaries at flashpoints (tight cluster meets tight cluster)

**Decision: AoI is a *send-rate* policy, never a *simulation* policy. The sim is global; AoI only governs
how often you transmit and how much remote detail you render.** A grab across crews therefore needs no
special case — but to keep rollback fan-in bounded we add a **merge rule**:

- **Two Anchors' tight clusters MERGE into one rollback group the instant any cross-crew interaction event
  fires** (a cross-crew grab latch, RUSH contact, or shove). On merge, both clusters' members upgrade each
  other to **TIGHT** send-rate for the duration of contact + a hysteresis tail (suggest `CONTACT_HOLD ≈
  VULN_BEAT = 90` ticks, [04 §2b]). [→ 05: add `mergeClusters(onCrossCrewContact)` to §4]
- **Eligibility gate (prevents teleport-grabs across the fog):** a cross-crew grab can only *latch* if the
  target was already in the grabber's **TIGHT or LOOSE** band at the latch tick. You cannot grab a body you
  are only receiving as a FAR pip — there isn't enough synced state. This is also a fairness rule: the thing
  you grab must have been visible/contestable. [→ 04 §3: codify; → 05 §4]
- **Bounded fan-in is preserved** because flashpoints are *structural and rate-limited* by levelgen — "no
  two flashpoint strata back-to-back," CONTESTED-MERGE on a fixed cadence, soft pace-separation
  ([09 §2], [04 §3]). The pathological "all crews in one tight group" is a designed-against rarity, and even
  then k is bounded by total players (mesh ≤ ~8, relay toward ~20). Rollback depth is the worst-peer
  extreme-order statistic [05 §7]; the merge rule makes that statistic *measured and capped*, not
  open-ended.
- **A thrown body crossing a boundary is trivial:** it's a single ballistic body owned by the seeded sim;
  any peer recomputes its arc. The *landing* (on a real lower floor, [04 §1 committed-vs-raw]) is where
  standing settles. No cross-AoI state handoff is needed because state is global; only render fidelity and
  send-rate change.

### (c) "Lots of ways to interfere" vs. non-degenerate grab — do the 5 pressures hold up? (stress-test)

The fear: grab becomes a hard-CC lock that removes a player or pins an Anchor, collapsing the game into
"whoever grabs first wins." Stress-testing the five pressures [02 §2] against degenerate strategies:

| Degenerate strategy | Which pressure(s) defeat it | Verdict |
|---|---|---|
| **"Perma-hold the rival Anchor"** | Encumbrance (0.45× carry speed) + Struggle (Anchor `struggle_strength` 1.8 → slips free in ~0.35–0.55s) + Grabber-is-prey (you're now the slowest, juiciest target in the brawl) | **Holds.** Holding the Anchor is a knife-edge all-in, not a lock. [02 §1–§2] |
| **"Autoclicker beats Struggle"** | Struggle's anti-autoclicker ramp + debounce + seeded jitter on the 100-threshold; constant-rate input is *worse* than human bursts | **Holds**, contingent on the ramp being tuned in playtest (flagged). |
| **"Grab-train pins a whole crew"** | Length cap + sum-capped mass + mid-air hold-pop + anti-pile-on stand-up window [03 §6] + 18-tick regrab immunity [04 §2] | **Holds.** Trains are spectacle, not a stunlock; the cap is also the determinism bound (§7a). |
| **"Grab the Anchor and hands-full-disable the carrier so they can't be punished"** | Grabber-is-prey + Bulwark hard-counter (body-block latch interception, Unhand break, Brace wall) | **Holds**, but **requires a Bulwark-class answer to be present.** Risk: in a 3-player crew with no Bulwark, Anchor-theft may over-perform. |
| **"Chain-regrab the instant struggle frees them"** | 18-tick regrab immunity + the freed body gets the stand-up window | **Holds.** |

**Authoritative calls from the stress-test:**

1. **The five pressures are sufficient *in principle* but two are conditional** and must be made
   unconditional:
   - **Make a grab-break available to every role, not only the Bulwark.** The Bulwark is the *specialist*
     (cheaper/faster Unhand, body-block), but **STRUGGLE by the victim plus a basic ally "bump-to-break"
     (a successful RUSH onto a grabber staggers them and shortens their latch) must work without a
     Bulwark present.** Otherwise crews without a Bulwark are hard-countered by Anchor-theft. [→ 02 §2:
     add ally bump-break as a universal interaction; → 04: confirm crew-comp balance]
   - **The anti-autoclicker Struggle ramp is the single most playtest-sensitive curve in the verb set.**
     Lock its *shape* now (concave: each same-interval press yields diminishing progress; human-variance
     bursts yield full progress), defer its constants to playtest. [→ 02 §2]
2. **Hard invariant (non-negotiable): there is no state in which a player or Anchor can be rendered
   unable-to-act for longer than `MAX_HELPLESS` ticks by grabs alone.** Define
   `MAX_HELPLESS` so that a maximally-mashed struggle *always* frees in ≤ `MAX_HELPLESS`, regardless of
   regrab attempts, via the regrab immunity. Suggest `MAX_HELPLESS ≈ struggle-free-time + REGRAB_IMMUNITY`.
   [→ 02 + 04 to ratify the number]
3. **Held bodies are never inert:** they do light damage and **wriggle to spoil throw aim** (bounded
   offset, [04 §2 / 07 §3]). This guarantees grabbing is *interaction*, not *removal*.

**Conclusion:** non-degeneracy holds **given two fixes** (universal grab-break, locked Struggle-ramp shape)
and **one invariant** (`MAX_HELPLESS`). With those, "lots of ways to interfere" is true and none of the ways
degenerate into a lock.

### (d) Climb-first pacing vs. pure-race-no-chase anti-turtling

The fear: with no rising wall-of-death (pillar 5) and a "climb-first, ~60–70% traverse" pacing target
(pillar 1 / [01 §1]), what stops a crew from **turtling** — camping a defensible ledge, never advancing,
farming rivals who pass?

**Decision: anti-turtling is purely *structural* — three independent forces, no chase mechanic:**

1. **Score is altitude-only and the Anchor is gap-locked.** A camped crew's standing is *frozen*; every
   tick they don't climb, every other crew's potential standing rises past them. Standing pressure is
   *relative*, so "do nothing" *is* losing. [01 §5]
2. **Recall is to the Anchor's height, *never ahead*.** A turtling crew cannot use recall to leapfrog or to
   cheaply re-converge after a scatter; recall only ever pulls you *back down* to your own Anchor. Camping
   gains no positional option. [01 §2, 03]
3. **The bounded win conditions impose a clock without a chase.** ENDLESS-HIGHEST uses a **15-min tick
   budget** [04 §4]; RACE-TO-HEIGHT ends when *someone* summits, so a camper simply loses when a climber
   reaches the top. Neither is a wall-of-death; both make stasis a loss. [04 §4]
4. **Rubber-banding actively *un-rewards* a successful camp:** if your camping pushes a rival's Anchor down,
   that rival now draws better boons and the pack re-bunches *toward you* — you don't get to farm a
   thinned-out field; you get the whole pack back in your lap. [03 §4]

**Explicit anti-anti-pattern guardrail:** because there is no chase, we must ensure **a flashpoint is never
*avoidable by waiting*.** Levelgen guarantees **CONTESTED-MERGE on a fixed cadence** [09 §2] so the route
graph *forces* convergence regardless of pace — a turtling crew that wants to advance must eventually pass
through a contested mouth. Stasis is the only "safe" option, and stasis loses (forces 1–3). **No
rising-floor, no DPS timer, no chase is added.** [→ confirms 01 §5, 09 §2]

### (e) Maximal coalescence spectacle vs. perf/determinism budget

**Decision: spectacle is *unconditionally* subordinate to two hard contracts; it never negotiates with
them.**

- **Determinism contract (absolute):** the view layer NEVER writes sim state; coalescence reveal is
  *pure view-layer* driven by `reveal∈[0,1]` from sim-truth climber distance; **collision bodies exist from
  seed-time** so a player can stand on a not-yet-"resolved" tile (it is solid in sim). All "randomness" is
  *baked offline* into vertex attributes — no runtime PRNG in the view. Particles are **closed-form,
  event-spawned, instanced**, so a rollback **re-spawns the identical burst**; the view consumes the sim's
  event list + rollback signal and *never produces* either. This is the single most important levelgen rule
  and the art doc's §0. [06 §0, 06 §4, 09 §0]
- **Perf contract (hard budget):** ≤250 draw calls / ≤1.2M tris / ≤12k particles / 1 directional light /
  ≤6 merged post passes; target 60 fps on a 2021 iGPU in a worst-case 4-crew brawl. Spectacle is bounded
  *spatially* by AoI (reveal only the floors above the AoI; collapse floors below to impostor planes) so the
  rendered set is always bounded even though the tower is endless. [06 §5]
- **Conflict resolution rule:** when spectacle and readability/perf collide, **readability wins, then
  perf, then spectacle** — enforced by the "squint-test" CI check and the legibility hierarchy
  (silhouette > identity color > state aura > motion > particles > shake). [06 §6, 07 §3]
- **The one acknowledged-Medium-confidence item is transparency fill-rate** (parallax floor planes +
  god-rays + additive particles on weak GPUs). It carries a **high-confidence fallback ladder** (drop
  parallax planes → analytic fog only → reduce particle cap). The fallback path is what we *commit* to
  hitting 60 fps; the full spectacle is the *aspiration* above it. [06 §6]

**Net:** spectacle is "maximal" *within* a box it can never break out of. Because the box is enforced by a
§0 contract and a perf budget that the AoI already bounds, there is no scenario where spectacle threatens
determinism or the frame budget — at worst it degrades itself.

## 5. Core Data Flow (the determinism spine)

One direction only: **input → deterministic sim → snapshot/hash → render + VFX.** The render path is a
read-only consumer of committed (and speculatively-predicted) sim state. Nothing downstream of the sim ever
writes upstream of it.

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │                      LOCAL PEER (each frame)                  │
                         └─────────────────────────────────────────────────────────────┘

  [ INPUT ]
  Poll local controls → InputFrame {
      tick,                       # shared integer tick counter (sim time = tick·DT, DT=1/60)
      move:vec2, aim:vec2,        # stick: movement + stick-relative aim cone
      rush:bool,                  # RUSH
      grab:bool,                  # GRAB/THROW (hold=grab, release=throw; empty-hand tap=SHOVE)
      struggle:pulse,             # STRUGGLE mash (anti-autoclicker handled in sim)
      grabTarget:entityId|none    # resolved by deterministic auto-target (nearest-in-cone, stable-id tiebreak)
  }
        │  apply locally INSTANTLY (input-delay buffer per-peer RTT)
        │  broadcast InputFrame (redundant last-N) over UNRELIABLE/UNORDERED channels
        ▼
  [ DETERMINISTIC SIM ]  fixed 60 Hz timestep, seeded PRNG only, NO wall-clock, NO Math.random
     step(tick):
        1. resolve auto-target & verb intents (kinematic, no solver coupling)
        2. apply RUSH sweeps / GRAB latches (parent-socket) / THROW impulses (idempotent per (id,releaseTick))
        3. STRUGGLE resolution (seeded jitter, anti-autoclicker ramp, MAX_HELPLESS invariant)
        4. integrate single bodies + capped composite "train" bodies
        5. evaluate hazards = pure f(tick); strata geometry = gen(seed, stratumIndex)
        6. update standing H = floorIndex + fractionalProgress (committed-vs-raw)
        7. emit EVENT LIST (latch, throw-release, impact, hazard-fire, coalesce-stage, ring-out, lead-change)
        │
        │  if remote inputs for tick T present → advance
        │  else → PREDICT (repeat last remote input) + flag
        │  on mispredict → ROLLBACK to last-agreed tick, RESIM with true inputs (re-emits identical events)
        ▼
  [ SNAPSHOT + HASH ]
     ring buffer of last-N snapshots (for rollback)
     check-frame hash = H(sim state) every K ticks → compare across peers → desync alarm if divergent
     cross-crew CONTACT → mergeClusters() upgrades both clusters to TIGHT (bounded fan-in)
        │
        ▼
  [ RENDER + COALESCENCE VFX ]   (READ-ONLY consumer; never writes sim)
     interpolate between snapshots by uInterpAlpha; all view animation on uSimTick
     coalescence: reveal∈[0,1] from sim-truth climber distance (floors above: dots→lines→panels→lit)
     floors below: persist, desaturate + fog, crew-color rim stays fog-immune
     particles/audio: replay sim EVENT LIST; on rollback, retract speculative + re-emit committed
     camera: Anchor-weighted crew centroid (w_anchor=3.0); hitstop is render-only, never gates the tick
```

**Three invariants this diagram encodes (each owned by a sibling doc, restated as law here):**

1. **Sim time is the tick counter; `performance.now()` lives only at the transport layer** (RTT/timeouts).
   [05 §8]
2. **Geometry, hazards, and all randomness are pure functions of `(seed, tick, stratumIndex)`** — never
   snapshotted, never wall-clock, never `Math.random`. Any peer recomputes the world bit-identically.
   `genStratum(runSeed, stratumIndex)` uses per-stratum sub-stream PRNG (no shared advancing stream),
   fixed-point `Q16.16` coords, and a deterministic validator + content-hash check-frame. [05 §0, 09 §0/§2/§4]
3. **The view layer is a strict downstream reader.** It interpolates, reveals, and replays events; it has a
   *separate, walled view-only RNG* (audio) seeded from `(tick, eventId)` that can never touch the sim PRNG
   or the check-frame hash. [06 §0, 08 §0]

## 6. Definition of Fun — for the Vertical Slice

The vertical slice is **one crew (with one human-controlled Anchor + ≥1 teammate) escorting their Anchor up
~3–4 coalescing strata that include at least one GAP-CROSSING and one CONTESTED-MERGE, with a second crew
(or a stand-in rival Anchor) to brawl, all running on rollback netcode across at least two browsers.**

It is **fun** — and the project is *de-risked* — when *all* of the following are true:

1. **The carry-throw-across moment lands.** A teammate picks up the heavy Anchor, the encumbrance is *felt*
   (slow, committed, hands-full), the throw across a chasm is a deliberate aimed act, and **a fumble
   (Anchor thrown short, into the gap) is a gut-punch the table reacts to out loud.** This is the signature
   verb; if it doesn't produce table-talk, nothing else matters. [01 §2, 02 §1]
2. **A flashpoint produces an emergent grab-fight that nobody scripted.** Two crews hit a CONTESTED-MERGE,
   someone grabs the rival Anchor, a struggle/bump-break scramble erupts, and it **resolves in seconds**
   (calm→panic→calm), with the outcome read *purely by position* (who's higher / who got thrown down). No
   stunlock, no one removed from play. [01 §1, §4; §4c above]
3. **The thrown-down Anchor feels like a comeback engine, not a punishment spiral.** When a rival shoves
   your Anchor down two floors, you scramble, recall/recatch, and **the better boon you draw next makes the
   loss feel survivable** — the pack re-bunches and it's anyone's tower. [03 §6]
4. **It reads at a glance under chaos.** In a 2-crew brawl on a 2021 iGPU at 60 fps, a new player can
   always answer "where is MY Anchor and what's happening to it?" within one second via the triple-redundant
   Anchor status. Spectacle never costs that answer. [07 §2, §4e above]
5. **It survives the network.** Two browsers, induced 80–120 ms RTT + packet loss: local input is instant,
   rollback corrections are imperceptible in the common case, and **no grab/throw/carry interaction ever
   desyncs the two sims** (check-frame hashes stay equal through a full flashpoint). This is the proof that
   the #1 risk is dead. [05, §4a above]

If 1, 4, and 5 hold, the *core* is proven; if 2 and 3 also hold, the *game* is proven. **The slice exists to
prove #5 carries #1, and #1 is what makes 1–3 possible.** Everything in the ROADMAP is sequenced to reach
that proof as early as honestly possible.

---

## 7. Open Items Handed to Owners (tracked)

- **02:** add universal ally "bump-to-break" + lock Struggle anti-autoclicker ramp *shape*; ratify
  `MAX_HELPLESS`. (§4c)
- **04 / 05:** ratify `mergeClusters(onCrossCrewContact)` + the "must-have-been-TIGHT/LOOSE-to-latch" grab
  eligibility gate; land `VULN_BEAT/REGRAB_IMMUNITY/CONTACT_HOLD/MAX_HELPLESS` in the 05 determinism
  constants table. (§4a, §4b)
- **05:** the P2 spike must prove single-body + capped-composite physics is bit-deterministic cross-browser,
  and decide Rapier-fixed vs. fixed-point. (§4a, ROADMAP P2)
- **03 / 04:** lock the rubber-band curve constants (shape is locked; the ranked preset is 04's). (§4d)
- **Filename housekeeping:** `02-roles-traversal-combat.md` is the **stale v2** file (Maw/collapse,
  "PvP is spice," fragment-and-fall, old archetypes). `02-roles-anchor-verbs.md` is the v3 doc. **Decision:
  treat `02-roles-anchor-verbs.md` as canonical; delete or archive `02-roles-traversal-combat.md`.** (LEAD)
- **frequency reuse is code-verified.** The sibling repo IS on this machine at
  `c:/Users/Jacob/Documents/Projects/Frequency` with `src/net/` present
  (`roomCode.ts`, `migration.ts`, `net.ts`, `netStore.ts`, `peer.ts`, `peerClient.ts`, `protocol.ts`,
  `transport.ts`, `hostServer.ts`) and a `CLAUDE.md`. P0's REUSE-vs-REPLACE note can be written against
  real code, not assertions. Note the repo is host-authoritative/single-reducer; per 05, ASCENT REUSES the
  connection lifecycle (roomCode/migration/transport/signaling) and REPLACES the game-loop model with
  peer-symmetric rollback. (ROADMAP P0)

- **TWO PILLAR DOCS ARE STILL v2 ON DISK AND CONTRADICT THIS BIBLE — highest-priority cleanup:**
  - **`05-netcode-architecture.md` is v2** (collapse model: `collapseY(tick)` as an eliminator,
    vertical-*proximity* AoI rather than AoI-*on-Anchor*; plus the v2 constant names `HISTORY=128`,
    `TIGHT_SET_MAX`, `maxRollbackFrames`, `redundancy=10`, commit-reveal, check-frames). Its netcode
    *primitives* (60 Hz fixed tick, seeded PRNG, fixed-point/quantization, rollback-over-input-frames,
    mesh|relay, silent migration, check-frames) are all still valid and are the cited source of truth;
    but it must be rewritten to **delete the collapse** and **re-key AoI from raw vertical height to the
    Anchor's height**. Docs 04/06/07/08 already write to v3 and flag this; 04 calls it "the single biggest
    reconciliation."
  - **`09-level-generation.md` is v2** (references `02-roles-combat.md`; includes the `race-the-collapse`
    archetype, `collapseY`, `collapseTimeBudget(D)`, "rising collapse" framing; `collapse` as the
    floors-below treatment). It must be rewritten to the v3 five archetypes
    (gauntlet / chokepoint-lift / gap-crossing / puzzle-route / contested-merge), **persistent floors-below
    (no fragment-and-fall)**, position-kill kill-planes instead of a collapse front, and the v3 cross-refs.
    Its *generation engine* (pure `genStratum(seed, index)`, sub-stream PRNG discipline, grid-first
    authoring, the `.view` firewall, deterministic validator, content-hash check-frame) is excellent and
    fully v3-compatible — only the collapse-coupled content needs replacing.
  - **Decision:** until 05/09 are rewritten, where this doc cites a 05/09 mechanism that is v3-correct in
    principle (AoI-on-Anchor, kill-planes, persistent floors, strata geometry from `(seed, index)`,
    `.view` firewall, content-hash) treat the *v3 framing here* as authoritative and the v2 file as the
    implementation reference for the surviving primitives. The exact tick/AoI constant *names* belong to
    the rewritten 05.

---
Cross-refs: 01 (loop/feel), 02 (verbs/mass/pressures), 03 (economy/rubber-band), 04 (competitive/win/AoI
constants), 05 (netcode/determinism), 06 (art/coalescence), 07 (ux/camera/HUD), 08 (audio), 09 (levelgen).
