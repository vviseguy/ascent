# 02 — Roles, the Anchor, & the Physical Verb System

> ASCENT design doc, v3. Conforms to **vision bible v3**. This is the canonical spec for the
> player-facing mechanical heart of the game: the four verbs, the mass hierarchy, the five
> grab-pressures, the world-object catalog, co-op carry, the six identities, and the down/revive/
> fall flow.
>
> **Sibling docs cross-referenced** (actual filenames in this `docs/` set):
> - `01-game-design.md` — the locked pillars/pitch; this doc builds on Pillars 1, 2, 4, 8.
> - `09-level-generation.md` — floor geometry, hazards, kill-planes, coalescence visuals, the
>   persistent two-way tower, destructibles vs. real floors.
> - `05-netcode-architecture.md` — rollback, AoI=Anchor, the grab-constraint determinism spike,
>   seeded PRNG, fixed-tick sim, sibling `frequency/src/net` reuse.
> - `03-progression-economy.md` — rubber-band catch-up boons, recall/respawn economy, trailing-crew
>   tuning.
> - `04-competitive-structure.md` — win conditions, rounds, host-tunable lobby knobs (lethality,
>   Anchor-death behavior, crew size, PvP intensity).
>
> Where this doc sets a number another doc owns (e.g. kill-plane depth), it is flagged
> **[OWNED BY 09]** (terrain/kill-planes), **[OWNED BY 05]** (netcode), **[OWNED BY 03]** (recall/
> respawn economy), **[OWNED BY 04]** (lobby/win/Anchor-death knobs). Numbers here are
> first-pass tuning targets, chosen to
> be concrete and buildable, not sacred. **There are no NPC enemies anywhere in ASCENT** — every
> antagonist is gravity, a scripted hazard, or another player. No behavior trees, no creatures, no
> aggro. If you find AI-enemy framing anywhere, it is a bug in the doc, not a feature.

---

## 0. Units, tick, and notation (read first)

All sim quantities are expressed in **sim units**, resolved on a **fixed timestep**.

- **Tick rate:** 60 Hz. `dt = 1/60 s`. One "tick" = one sim step. Time in this doc is given in
  **ticks** (and seconds for intuition). The sim is driven by the **shared tick counter**, never
  wall-clock (Pillar 12). `performance.now()` lives only in transport.
- **Distance unit `u`:** 1 u ≈ 1 meter ≈ roughly the shoulder-width of a Runner. A standard floor
  stratum is ~**12 u** tall (see `09`).
- **Mass unit:** abstract. A Runner = **1.0 mass**. Everything scales off that (the mass hierarchy,
  §3).
- **Determinism rule for everything in this doc:** all forces, impulses, ranges, and timers are
  **integer ticks** and **fixed-point or carefully-bounded float** quantities. No `Math.random()`
  — all randomness (throw spread, struggle jitter) draws from the **seeded PRNG** keyed on
  `(tick, entityId, channel)` (see `05`). No wall-clock. No per-frame `dt` variance (timestep is
  fixed). Trig in arc math is pre-tabulated / fixed-point (see `05` cross-browser trig note).

---

## 1. Control scheme (Overcooked-simple)

ASCENT is **four action buttons + a stick**, plus context. The whole point of Pillar 2 is that the
*same four verbs* apply to *everything*, so the controls never branch by target type.

| Input | Verb | Notes |
|---|---|---|
| **Left stick / WASD** | **MOVE** | 8-axis analog move. Drives facing when not aiming. |
| **A / Space** | **JUMP / CLIMB-up** | Context: jump in open space; mantle/hand-up at ledges. Disabled while hands-full (Pressure A). |
| **X / LMB** | **RUSH** | Dash in facing/aim direction. Closes distance, staggers. |
| **B / RMB (hold)** | **GRAB** | Latch onto the nearest valid target in a frontal cone. Hold to keep holding. |
| **B / RMB (release) or Y / Q** | **THROW** | Aimed release of the held thing. Aim with stick; power from hold-charge. A bare tap of THROW with empty hands = **shove** (a zero-mass micro-throw, see §2.3). |
| **Mash any face button** | **STRUGGLE** | When *you* are grabbed/held, mash to break free (§4.2). |
| **R / Right-trigger** | **ABILITY 1** | Class verb (§6). |
| **L / Left-trigger** | **ABILITY 2** | Class verb (§6). |
| **Right stick / mouse** | **AIM** | Aims RUSH and THROW; otherwise free-look-lite (camera is mostly fixed three-quarter, Pillar 7). |

Design rule: **one button can never mean two same-frame things.** GRAB and THROW share the B/RMB
button by **hold-vs-release** (you cannot throw what you are not holding, so there is no ambiguity).
RUSH and JUMP are distinct buttons because they're both spammed in flashpoints and must not eat each
other.

**No target-type menus, ever.** You GRAB toward a target; the engine picks the highest-priority
valid grabbable in the cone (priority order in §4.1). This is what keeps it Overcooked-clean while
the *consequences* (mass, encumbrance) vary wildly.

---

## 2. The four verbs, precisely

### 2.1 RUSH

A short, fast, committed dash. Closes distance and **staggers** what it hits.

- **Distance:** 4.0 u over **9 ticks** (0.15 s), ease-out. Effective speed ~**26 u/s** peak.
- **Cooldown:** 48 ticks (0.8 s).
- **Hit effect:** any *standing* entity in the rush path takes a **stagger** — a 24-tick (0.4 s)
  state where it cannot GRAB, JUMP, or use abilities, and is pushed back **1.5 u × (rusher_mass /
  target_mass)**, clamped to [0.3, 3.0] u. Stagger **interrupts an in-progress grab attempt** but
  does **not** break an established hold (you have to STRUGGLE or get a Bulwark for that).
- **Vs. the Anchor:** the Anchor's high mass means rush knockback against it is tiny (clamp floor
  0.3 u) — you cannot rush-shove an Anchor off a ledge. You can only *throw* it (§3, §9). This is
  deliberate: kills come from **position via throw**, not from poke damage (Pillar 4, Smash model).
- **Rush while hands-full:** allowed but **encumbered** — distance scales by the carry-speed
  multiplier (§4.3). Rushing while carrying the Anchor covers ~1.0 u. (You *can* rush-carry the
  Anchor across a tiny gap; it's weak on purpose.)
- **Air-rush:** RUSH works once in the air (a recovery/gap-closer). Resets on ground contact. This
  is the main individual-traversal skill expression.

> **Determinism:** RUSH is a kinematic sweep, not an impulse into the rigid-body solver where
> possible — resolve it as a capsule cast + position set, with stagger as a state flag. Keeps it out
> of the two-body constraint hot path. See `05`.

### 2.2 GRAB

Latch onto the highest-priority valid target in a frontal cone. Establishing a grab creates a
**two-body hold** (carrier ↔ held) — *this is the determinism spike, see §10.*

- **Range:** frontal cone, **2.2 u** reach, **70° half-angle**.
- **Acquire time (latch):** depends on target mass (§3). Light obj ~3 ticks; Anchor ~22 ticks. You
  are committed during latch (can be interrupted by stagger/struggle).
- **On success:** target enters **Held** state, parented to the carrier's **carry socket** (a point
  ~1.1 u in front, slightly up). Held entities still have a collider for **train** interactions
  (Pressure D) but their movement is driven by the hold constraint.
- **Hands-full:** while you hold *anything*, you are **hands-full** (Pressure A, §4.1).
- **Self-throw note:** you cannot grab yourself; teammates grab *you* for co-op carry (§5).

### 2.3 THROW (and SHOVE)

Release the held thing along an aimed arc, imparting an impulse scaled inversely by mass.

- **Charge:** holding GRAB after latch builds **throw charge** from 0→1 over **30 ticks** (0.5 s).
  Release at charge `c ∈ [0,1]`.
- **Throw impulse:** `J = J_base × c × (1 / sqrt(mass_target)) × thrower_strength`.
  - `J_base = 14.0` (sim impulse units).
  - `thrower_strength`: Runner 1.0, Bulwark 1.6, Mender 0.9, Engineer 1.0, Breaker 1.3, Anchor 1.1.
  - The `1/sqrt(mass)` curve means heavy things go *short and hard*, light things go *far and fast*
    — see the per-mass table in §3.
- **Arc:** launch angle = aim elevation, clamped to **[10°, 60°]**. Default (no vertical aim) = 38°.
- **Spread:** a tiny seeded jitter of **±1.5°** at full charge, **±0.3°** uncharged — drawn from the
  PRNG (never `Math.random`). A *struggling* held player adds aim spoil (§4.2).
- **Shove (empty-hand THROW tap):** a zero-charge micro-impulse, **J = 4.0**, range 1.6 u cone. Pure
  tempo tool — repositions, contests ledges, breaks an enemy's latch-in-progress. Cannot move an
  Anchor meaningfully (mass). Cooldown 18 ticks.
- **Throw-into-throw (the train):** you can throw a carrier *who is mid-carry*; both go (the held
  thing stays held through the flight unless impact exceeds its hold-break threshold — see §4.2).

> **Determinism:** the throw is a **single impulse applied on the release tick**, then the body is a
> free rigid body under the deterministic integrator. The risky part is that release happens inside
> rollback — the impulse must be a pure function of `(charge, mass, strength, seeded_jitter)` at the
> resim tick. No accumulated-float drift. See §10.

### 2.4 STRUGGLE

When *you* are the Held target, mash to break the hold (Pressure B, §4.2). Also used by a downed
player to crawl (§8). It is the *defensive* verb — the counter-pressure that makes grab a tempo tool
rather than a lock.

---

## 3. The mass hierarchy (the spine of everything)

Four tiers. Mass governs **latch time, carry speed, throw force/arc, and how easy you are to
struggle out of someone's hands.**

| Tier | Examples | Mass | Latch ticks | Throw dist @ full charge (Runner) | Carry-speed mult |
|---|---|---|---|---|---|
| **Light object** | crate, debris chunk, hazard fragment, small Engineer block | **0.4** | 3 | ~12 u, fast/flat | **0.92** |
| **Heavy object** | barrel, big debris, heavy Engineer block, turret-cap | **1.8** | 9 | ~5.5 u, slow/lobbed | **0.70** |
| **Teammate / regular player** | any non-Anchor crewmate or rival | **1.0** | 7 | ~8 u | **0.78** |
| **The Anchor** | the VIP | **3.2** | 22 | ~3.0 u, very short/heavy | **0.45** |

Notes:
- **Throw distance** above is horizontal range at the default 38° arc, full charge, baseline thrower
  strength (Runner 1.0). Scale by `thrower_strength` (§2.3) and by `c`. A **Bulwark (1.6)** throwing
  a teammate hits ~12.8 u; throwing an **Anchor** ~4.8 u — meaningful for a gap-boost, never a
  free yeet across the shaft.
- **Latch time** scales ~linearly with mass; grabbing the Anchor (22 ticks ≈ 0.37 s) is a visible,
  interruptible commitment — a rival cannot insta-snatch your Anchor.
- **Carry-speed mult** (§4.3) is the encumbrance tax. Carrying the Anchor at **0.45×** is brutal on
  purpose; it takes coordination (and usually a throw-hand-off) to actually move it.
- **Struggle resistance** scales **inversely** with mass: heavier held things are *harder for the
  carrier to keep aimed* but the *held player's* struggle effectiveness is normalized to their own
  body (a held Anchor struggles like an Anchor — strong, see §4.2). World objects don't struggle.

---

## 4. The five grab-pressures (with numbers)

Grab is a **tempo tool, not a control tool** (Pillar 2). Five independent pressures guarantee that.

### 4.1 Pressure A — Hands-full

Holding *anything* disables: **JUMP/CLIMB**, **build** (Engineer), **break** (Breaker), and **all
class abilities**. You can still MOVE (encumbered), RUSH (encumbered), and THROW (it's the only way
to empty your hands besides a successful STRUGGLE-by-the-victim or a Bulwark break).

- You hold **at most one thing** at a time. No stacking. (A held player who is *themselves* holding
  something keeps holding it — that's the train, §2.3, Pressure D.)
- **Grab acquire priority** in the cone (so the engine never needs a target menu): nearest
  *enemy Anchor* in a contestable state > nearest grabbed-able player issuing a contextual prompt >
  nearest world object > nearest player. Tunable per design pass; the rule is **deterministic
  nearest-with-priority**, resolved by stable id ordering on ties (see `05`).

### 4.2 Pressure B — Struggle (mash to break free)

The held player mashes STRUGGLE. Each *valid* mash press adds **break-progress**; progress decays
when not mashing so spamming early is wasted.

- **Break threshold:** `100` progress.
- **Per-press value:** `press = 6 × struggler_strength × (target_mass_of_struggler / carrier_grip)`.
  - `struggler_strength`: Runner 1.0, Bulwark 1.4, Mender 0.9, Engineer 1.0, Breaker 1.2,
    **Anchor 1.8** (the Anchor is hard to hold!).
  - `carrier_grip`: Runner 1.0, Bulwark 1.5, Breaker 1.2, others 1.0. (Grippy classes hold longer.)
- **Mash curve (anti-autoclicker, anti-degenerate):** consecutive presses within a 6-tick window
  ramp: press *n* in a burst is worth `press × min(1 + 0.12·(n−1), 1.8)` — i.e. sustained mashing
  ramps up to **1.8×** after ~7 presses, then caps. A **seeded micro-jitter of ±5%** per press
  (PRNG, not wall-clock) stops perfect-bot timing from being optimal. Presses faster than **2
  ticks apart are ignored** (debounce) so turbo controllers gain nothing.
- **Decay:** if no press for 8 ticks, progress decays at 4/tick.
- **Resulting base hold-times** (no Bulwark, attacker is a Runner-grip carrier, victim mashes
  steadily after the ramp):
  - Held **Runner**: breaks in ~**0.6 s** (≈36 ticks).
  - Held **Bulwark**: ~**0.45 s** (strong struggle).
  - Held **Anchor**: ~**0.35 s** (the Anchor is *slippery* — you cannot casually hold a VIP; you
    must throw it almost immediately or it's gone). A **Bulwark-grip** carrier holding an Anchor
    pushes this to ~**0.55 s** — still a knife-edge, all-in commitment (Pillar 9).
- **Aim-spoil:** while struggling, the held player wriggles the carrier's **throw aim by ±(struggle
  intensity × 8°)** and **bleeds throw charge** at 0.02/tick. A fully-struggling victim caps the
  carrier's effective charge near ~0.6 and randomizes arc — so a contested throw goes *short and
  scattered*. This is why you want a **Bulwark to pin / a Mender to peel** before a clean VIP toss.
- **Held-player chip:** a held player deals **light contact damage** to the carrier, 1 HP / 12
  ticks — flavor + a tiny extra cost to holding. Never lethal alone.

### 4.3 Pressure C — Encumbrance (carry slows you)

Carrying scales your **move and rush** by the tier's **carry-speed mult** (§3 table):

- Light obj **0.92×**, heavy obj **0.70×**, teammate/rival **0.78×**, **Anchor 0.45×**.
- **Bulwark exception:** Bulwark carries at **+0.15** to the mult (so Anchor-carry 0.60×, teammate
  0.93×) — the designated mover of heavy things.
- **Encumbrance also lowers your own struggle/shove value by 20%** while hands-full (you're
  committed). And you **cannot JUMP** (Pressure A), so a carrier is grounded — terrain-trapped.

### 4.4 Pressure D — The grabber is prey (grab chains / trains)

A carrier is a fat, slow, grounded target. While you carry, **you can be grabbed, rushed, shoved,
and thrown like anyone else** — and *what you're carrying goes with you*.

- **Train rule:** if A carries the Anchor and B grabs A, B is now carrying A-(carrying-Anchor). B's
  encumbrance is the **sum-capped** mass: `effective = max(component masses) + 0.5×(others)` →
  carrying a carrier-of-Anchor ≈ mass 3.2 + 0.5 ≈ behaves at the **Anchor tier (0.45×)**. Trains
  are powerful but glacial.
- **Throwing a carrier:** the whole stack flies. On impact, each hold in the stack rolls against its
  **hold-break threshold** (impact impulse vs. remaining struggle-progress headroom). Big impacts
  pop holds apart mid-air — *grab-chain explosions* are an intended spectacle.
- This is the main reason holding a **rival** Anchor is a slow, exposed, all-in play (Pillar 9): the
  moment you latch it you become the juiciest prey on the floor, and every other crew wants you.

### 4.5 Pressure E — The Bulwark hard-counter

The Bulwark is the **anti-grab specialist** (Pillar 8, §6.2):

- **Body-block:** a Bulwark standing between a grabber and the grabber's intended Anchor **intercepts
  the latch** — the grab acquires the *Bulwark* instead (and a Bulwark is a bad thing to be holding:
  heavy-ish, grippy struggle, and it can be set to **Brace**, below).
- **Grab-break (Ability):** "**Unhand**" — instantly empties one grab within 3.5 u (frees a held
  ally or the Anchor, or strips a rival who's carrying your VIP). Cooldown 9 s. This is the crew's
  emergency VIP-rescue button.
- **Brace:** while braced, the Bulwark's `carrier_grip` and stagger-resist double, and rush
  knockback against it is halved — a movable wall in front of the Anchor.

---

## 5. Co-op carry (your own Anchor & allies)

Co-op carry is **core**, not a corner case (Pillar 2). It uses the *same* GRAB/THROW verbs; the
difference is intent and the consent model.

### 5.1 Consent & friendly grabs

- **Friendly grab is consent-light but interrupt-friendly:** grabbing an ally/your Anchor latches
  normally (it's not adversarial), but the carried ally can **STRUGGLE to dismount instantly**
  (their struggle vs. a friendly carrier uses a low threshold of 30 — basically "let me down now").
  So you can scoop a teammate to hand them up a ledge, and they can bail if you misjudge.
- The **Anchor can refuse/ dismount** the same way — the VIP is an active player, never a ragdoll
  (Pillar 1). A crew throwing its own Anchor is a *negotiated* play.

### 5.2 The hand-up (ledge boost)

The bread-and-butter traversal co-op:

- Carry an ally/Anchor to a ledge and **THROW upward** (aim ≥ 50°). The arc places them on the floor
  above. A Runner thrown by a Bulwark clears a full **12 u stratum**; a Runner-thrown Runner clears
  ~8 u (most of a stratum — usually enough with an air-rush to finish).
- **Anchor hand-up:** the Anchor is mass 3.2; even a Bulwark only lifts it ~4.8 u vertically. So
  Anchors go up via **lifts, ramps (Engineer), or a Bulwark-throw onto a mid-ledge**, then repeat —
  never a single clean toss to the top. This enforces interdependency (§7).

### 5.3 Throwing your own Anchor across a gap (powerful & risky)

- Horizontal Anchor-throw clears a gap up to the §3 range (Bulwark ~4.8 u). On the far side the
  Anchor lands in a brief **vulnerable beat** (the same downed-ish state as a fall, §8) — so a
  mistimed gap-toss hands rivals a pounce window. High risk, high reward (Pillar 2).
- **Catch hand-off:** a teammate on the far side can GRAB the in-flight Anchor (latch on a moving
  body within cone+range) to convert a throw into a safe carry — a skill-expressive "alley-oop." The
  catch latch is the *light* latch time (the body's already in your cone), ~7 ticks.

### 5.4 Catching fallers (the safety net)

- Any player can GRAB a *falling* ally/Anchor passing through their cone — converts a lethal fall
  into a carry. This is the Mender's specialty (longer cone, §6.3) but anyone can do it.
- **Recall beacon interaction:** the Anchor plants the crew's **Recall Beacon** (Pillar 1); recall
  brings the crew **to the Anchor's height, never above**. Catching/recall flow detail is **[OWNED
  BY 05]** for cooldown/economy; the *verb* of catching lives here.

---

## 6. The six identities

Base stats are relative to the Runner baseline. **Health** is a fall/hazard buffer; remember kills
are positional (Pillar 4), so HP mostly governs **how much hazard chip you can eat** and the
**downed** threshold, not a damage-race. Mass is the §3 hierarchy value.

| Class | Speed | Health | Mass | Size (u) | Role one-liner |
|---|---|---|---|---|---|
| **Runner/Scout** | 1.25× | 80 | 1.0 | 0.9 | Fast/fragile route-scout & pickup-grabber |
| **Bulwark/Guard** | 0.85× | 140 | 1.0* | 1.3 | Anti-grab wall, big thrower |
| **Mender/Lifeline** | 1.0× | 95 | 1.0 | 1.0 | Heals/shields/revives, catches fallers |
| **Engineer/Trickster** | 0.95× | 100 | 1.0 | 1.0 | Builds temp ramps/bridges/blocks & traps |
| **Breaker/Mover** | 0.95× | 120 | 1.0 | 1.15 | Clears destructible terrain, opens shortcuts |
| **ANCHOR** | 0.70× | 200 | 3.2 | 1.4 | The heavy precious active VIP |

> *Bulwark mass is the player tier (1.0) for *being thrown*, but it carries/grips/braces as if much
> heavier (the Bulwark exceptions in §4.3/§4.5). It is hard to *hold*, not hard to *throw* — keeping
> it inside the clean player-mass tier for the rollback solver.

### 6.1 Runner/Scout
Fast, fragile, the eyes of the crew. Scouts the coalescing floors above (Pillar 7), tags hazards for
the crew HUD, grabs distant pickups, harasses rival carriers (great Pressure-D prey-hunter).
- **Ability 1 — Mark (3 s cd):** ping a hazard/route/rival-Anchor; lights it on the crew HUD for
  4 s. Scouting value; zero combat.
- **Ability 2 — Wallkick (cd 1.5 s):** one extra air-rush off a vertical surface; the premier
  solo-traversal skill. Lets a Runner self-rescue from many falls (fragile but mobile).

### 6.2 Bulwark/Anchor-guard
The anti-grab specialist (Pressure E, §4.5). Slow, tanky, the body between the VIP and the world.
- **Ability 1 — Unhand (9 s cd):** instant grab-break within 3.5 u (§4.5). The VIP-rescue button.
- **Ability 2 — Brace (toggle, 2 s min, 0.5 s exit lag):** movable wall — doubles grip/stagger-
  resist, halves incoming rush knockback, body-blocks latches (§4.5). Cannot move fast while braced
  (0.6× of the Bulwark's already-slow speed).
- *Carry exception:* +0.15 carry-speed (§4.3) — the designated heavy-mover and Anchor-hauler.

### 6.3 Mender/Lifeline
Keeps the fragile crew (and the precious Anchor) alive; the falls-safety hub.
- **Ability 1 — Tether-shield (cd 7 s):** a 5 s shield on one ally absorbing **60** hazard chip;
  also **reduces their next fall's altitude-loss by one stratum** (a falling-ally insurance).
- **Ability 2 — Revive/Lift (channel):** raises a **downed** ally (§8) in 2.0 s (1.2 s if two
  Menders / a Mender + ally assist). Also: Mender has a **+40% catch cone** for catching fallers
  (§5.4) — the designated net.
- Passive: a slow heal aura (2 HP/s within 3 u) so the crew tops off between flashpoints.

### 6.4 Engineer/Trickster
Builds **temporary** terrain — the traversal enabler and route-maker. Built blocks are **grabbable/
throwable world objects** (Pillar 2) until they expire.
- **Ability 1 — Build (cd 1 s/charge, 3 charges):** place a **1×1×1 u block** (heavy-object tier,
  mass 1.8). Snaps to a grid; lasts **15 s** then dissolves (deterministic timer, see `09`/`05`).
  Stack into **ramps/steps/bridges** for the Anchor. Blocks are throwable improvised weapons once
  placed-then-grabbed.
- **Ability 2 — Spring-plate (cd 12 s):** a pad that launches whoever steps on it **+8 u up** on a
  fixed arc (a deterministic launch, not physics-random). The Anchor-friendly vertical mover — a
  spring-plate + a Bulwark mid-throw chains an Anchor up a stratum cleanly.
- *Hands-full disables Build* (Pressure A) — you can't build while carrying.

### 6.5 Breaker/Mover
Clears **destructible** terrain & blockages; opens shortcuts and **collapses rival routes**.
Destructibles are pre-authored, deterministic floor features (see `09`) — *not* the persistent
floors (Pillar 4: real floors never fragment-and-fall).
- **Ability 1 — Smash (cd 0.6 s):** break a destructible tile/blockage in front; spawns **light-
  object debris** (grabbable/throwable — instant ammo). Opens shortcuts for your crew.
- **Ability 2 — Collapse-charge (cd 18 s):** plant a 2 s fused charge on a **rival-relevant**
  destructible (e.g. a route segment a rival crew is using) — deterministic removal on the fuse
  tick. Route sabotage, never an instakill (you remove *terrain*, you don't delete *players*).
- Strong shove/throw (`thrower_strength` 1.3) — secondary heavy-thrower behind the Bulwark.

### 6.6 The ANCHOR (the VIP — an active teammate, Pillar 1)
Heavy, slow, fall-**durable**, can't cross big gaps alone — but **not helpless**. The Anchor
"spent its points on being important." It can act, carry, struggle hard, and it anchors the crew's
recall.
- **Fall-durability:** a falling/thrown Anchor is **NOT instakilled on impact** (unlike regular
  players). The punishment is **altitude lost + a brief downed/vulnerable beat** (§8). True Anchor
  death only at a real **kill-plane** (into a hazard, or off the very bottom) — **[OWNED BY 09]**
  for kill-plane geometry, **[OWNED BY 04]** for the host-tunable Anchor-death behavior.
- **Hard to hold:** struggle_strength **1.8** (§4.2) — a rival who grabs your Anchor has ~0.35–0.55 s
  before it wriggles free. Holding the VIP is always a knife-edge (Pillar 9).
- **Ability 1 — Plant Beacon (cd 25 s):** plant/move the crew **Recall Beacon** at the Anchor's
  current height (recall is *to* the Anchor, never ahead — Pillar 1). Economy/cooldown **[OWNED BY
  03]**.
- **Ability 2 — Brace-up (cd 6 s):** the Anchor sets itself as a **stable platform/handhold** for
  3 s — allies can stand/mantle on it and it resists being thrown (struggle/anti-throw spike). Turns
  the VIP into a deliberate piece of co-op terrain.
- The Anchor can **carry** (at its own brutal encumbrance) and **throw** (strength 1.1) — it is a
  real participant, e.g. it can shove a rival off the lift it's riding.

---

## 7. The interdependency web (escorting the Anchor)

Nobody gets the Anchor up efficiently alone. The Anchor is too heavy to self-traverse big gaps
(§3, §5.2) and too slow to flee, so every stratum is a little coordination puzzle:

- **Vertical (up a stratum):** Engineer **ramp/spring-plate** + Bulwark **Anchor-throw** + Runner
  **catch hand-off** (§5.3). Or a **lift** (terrain) the Bulwark guards while the Mender shields.
- **Horizontal (across a gap):** Engineer **bridge-block**, or a Bulwark **gap-throw** with a
  far-side **catch** (§5.3) — risky, fast.
- **Defense (rival flashpoint):** Bulwark **body-blocks/Unhands** grabs on the VIP (Pressure E);
  Mender **Tether-shields** the Anchor & peels; Runner hunts the rival **carrier** (Pressure D);
  Breaker **collapses** the rival's escape route.
- **Recovery (Anchor thrown down):** Mender **revives** the downed Anchor and shaves the altitude
  loss (§6.3); crew **recalls to the Anchor** (Pillar 1) to re-bunch; rubber-band boons flow to the
  now-trailing crew **[OWNED BY 03]**.
- **Sabotage (offense on rivals):** anyone can grab/throw a rival Anchor (same verbs, Pillar 9), but
  it takes a *coordinated* peel-pin-throw (Mender peel + Bulwark pin + Breaker route-cut) to
  actually ring a defended VIP out — a single grabber just becomes prey (Pressure D).

The web is *symmetric* (Pillar 1): every lever a crew uses to lift *its* Anchor is a lever to throw
*a rival's* down.

---

## 8. Downed / revive / ledge-catch / fall flow

This is the **Smash-Bros positional-kill** model (Pillar 4): you kill with *position* (ring-out /
the throw), not with a damage bar.

### 8.1 Falls — regular players
- A fall exceeding **~1.5 strata (~18 u)** of un-arrested drop is **lethal** for regular players →
  they **die** and respawn at the crew **Recall Beacon** height (never ahead) after a respawn timer
  **[OWNED BY 03]**. Smaller falls just cost altitude + a hard landing (8-tick stun).
- A fall can be **arrested** at any point by: a teammate **catch** (§5.4), a **wallkick** (Runner),
  an **air-rush** onto a ledge, or landing on **terrain/Engineer-block**. Arrest resets the lethal
  counter.
- **Off the very bottom kill-plane** = death regardless (the floor of the shaft) — **[OWNED BY 09]**.

### 8.2 Falls — the Anchor (durable)
- The Anchor does **not** die from impact. A thrown/fallen Anchor:
  1. **Loses altitude** (the real cost — it's the diegetic blue-shell, Pillar 6).
  2. Enters a **Downed/Vulnerable beat**: ~**2.0 s** (120 ticks) prone, can only **STRUGGLE-crawl**
     (slow drag, ~1.5 u/s) and **mash to self-recover faster** (shaves up to 0.8 s). During this
     beat it can be **re-grabbed/re-thrown** — rivals pounce, crew scrambles (the panic-burst of the
     Overcooked rhythm).
- **True Anchor death** only at a **hazard kill-plane** or **off the bottom** → the host-tunable
  Anchor-death behavior fires **[OWNED BY 04]** (e.g. respawn-at-beacon with a height penalty, or a
  longer downed beat — *not* a hard game-over by default; an Anchor is too central to delete
  casually).

### 8.3 Downed & revive (regular players)
- Reaching **0 HP from hazard chip** (rare — hazards mostly threaten *position*) puts a regular
  player **Downed** rather than dead: prone, STRUGGLE-crawl only, a **15 s bleed-out**, revivable by
  a **Mender (2.0 s channel)** or any ally (4.0 s slow channel). Bleed-out → death/respawn at beacon.
- A **Downed** player can still be **grabbed and thrown** (a downed ally is cargo to be hauled to
  safety, or a downed *rival* is cargo to be thrown into a hazard — positional kill).

### 8.4 Ledge-catch (mantle)
- Reaching a ledge edge while falling/jumping with a near miss auto-snaps to a **mantle-hang** (12
  ticks) you finish with JUMP — a small forgiveness window so traversal feels generous (Overcooked-
  clean). Disabled while hands-full (Pressure A) — a carrier can't mantle, so carriers need the
  hand-up (§5.2). That asymmetry *is* the co-op pressure.

---

## 9. Worked example (one flashpoint, end to end)

Crew Blue's Anchor rides a lift up stratum 14. Crew Red collides at the lift choke:
1. Red **Runner** rushes in (stagger) and **GRABs** Blue's Anchor (22-tick latch — visible; Blue
   reacts).
2. Blue **Bulwark** is braced beside the VIP; it **body-blocks** the next grabber and **Unhands** the
   Runner (Pressure E) — Anchor freed, Runner now empty-handed and staggered.
3. Red **Bulwark** **gap-throws** Red's *own* Anchor onto the lift platform (offense via traversal),
   Red **Mender** shields it.
4. Blue **Breaker** **Collapse-charges** the lift's far rail (route sabotage) and **shoves** Red's
   Anchor toward the open edge.
5. Red's Anchor, shoved past the edge, **falls 2 strata** → not dead (durable), **loses altitude**,
   enters the **downed beat** below. Red crew **recalls to it** and re-bunches; rubber-band boons now
   favor Red **[OWNED BY 03]**.
6. Calm returns; both crews resume cooperative climbing. (calm → panic-burst → calm, Pillar 5.)

Every step used only the four verbs + class abilities. No NPCs. Kills were positional.

---

## 10. Determinism risks (flag list for `05`)

The verb system is where rollback gets hardest. Ranked by risk:

1. **Two-body GRAB constraints inside rollback (HIGHEST — the first de-risk spike, per bible).**
   A latch creates a persistent carrier↔held constraint that must **survive rollback+resim
   bit-identically** across peers. Risks: constraint solve order, warm-starting the solver
   (accumulated impulses are *state* that must be checkpointed or recomputed deterministically),
   and **grab make/break events landing on different ticks after misprediction**. *Mitigations:*
   prefer modeling carry as a **kinematic parent-socket** (carrier drives held position directly)
   rather than a soft physics joint wherever the gameplay allows — kinematic parenting is trivially
   deterministic and dodges the solver entirely. Reserve true constraints only for the *train*
   stack (§4.4) and treat that as the explicit spike. Checkpoint hold-state (carrier, held,
   break-progress, charge) in the rollback snapshot.

2. **THROW impulses on the release tick.** The impulse must be a pure function of `(charge, mass,
   strength, seeded_jitter@tick)` and applied exactly once even when the release tick is re-simmed.
   Risks: double-applying on resim, or charge value differing post-rollback. *Mitigation:* derive
   charge from `(grab_start_tick, release_tick)` not an accumulator; make impulse application
   idempotent per `(entityId, releaseTick)`.

3. **Many throwable rigid bodies in the sim at once** (debris, blocks, barrels). Risks: pairwise
   contact solve order, sleeping/waking thresholds (a body that sleeps on one peer but not another
   diverges). *Mitigation:* deterministic island ordering by stable id; disable or fully-determinize
   sleep; cap concurrent free rigid bodies per stratum and expire Engineer blocks/debris on fixed
   timers (§6.4/§6.5).

4. **Struggle mash + seeded jitter.** All struggle randomness draws from the PRNG keyed on
   `(tick, heldEntityId, "struggle")`; presses are sampled from the **buffered input stream** at the
   sim tick, never from wall-clock input timestamps. Debounce (§4.2) is tick-based.

5. **Rush as impulse vs. kinematic sweep.** Resolve RUSH as a deterministic kinematic capsule sweep
   + state flags (§2.1) to keep it out of the constraint/impulse hot path entirely.

> Net guidance to `05`: **kinematic-parent carry by default, constrained physics only for the train
> stack**, all impulses idempotent-per-(entity,tick), all randomness seeded, all timers in integer
> ticks. The grab/throw subsystem should be the **first thing put on the deterministic-replay test
> harness** before any class abilities are built on top of it.
