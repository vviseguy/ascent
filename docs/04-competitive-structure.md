# 04 — Competitive Structure (v3)

> Scope: How crews compete inside ONE shared tower, soft-separated by pace. Standing
> (= your Anchor's height): live computation & display. The full rival-interaction verb
> set and why it stays non-degenerate. Flashpoints, fog-band rival visibility & info
> leak. Lobby / matchmaking / crew formation / Anchor selection. Spectating after loss or
> wipe. The three win conditions. All consistent with the bible v3 pillars and with the
> AoI=Anchor netcode model in `05-netcode-architecture.md`.
>
> Cross-refs: `05-netcode-architecture.md` (rollback, determinism, mesh|relay, migration —
> SOURCE OF TRUTH for all tick/AoI constants), `01-game-design.md` (pillars), `02-roles-
> traversal-combat.md` (RUSH/GRAB/THROW/STRUGGLE, mass hierarchy, 5 grab-pressures, roles,
> Anchor identity & RECALL BEACON), `03-progression-economy.md` (rubber-band boons /
> catch-up), `09-level-generation.md` (strata, routes, fog-bands, coalescence). Where a
> number here also lives in another doc, that doc is the source of truth and is flagged
> inline.
>
> **DEVIATION FLAG — 05 is one model-version behind this v3 doc.** The on-disk `05-netcode-
> architecture.md` (and the pre-existing `04`) are written for the *collapse / rising-
> wall-of-death + vertical-proximity AoI* model. **v3 deletes the collapse** (bible pillars
> 4 & 5: "NO rising wall-of-death", floors PERSIST, kill by POSITION not by a doom front)
> and **re-centers AoI on each crew's Anchor** instead of raw vertical proximity. This doc
> is written to the v3 bible. The two are reconcilable because v3's "AoI = the Anchor's
> vertical band" is a *special case* of 05's vertical-proximity AoI — the Anchor simply IS
> the band center. Every 05 **netcode primitive** still stands verbatim (rollback over input
> frames, 60 Hz fixed tick, fixed-point/quantization determinism, `HISTORY=128`,
> `maxRollbackFrames`/`TIGHT_SET_MAX` caps, redundancy=10, commit-reveal, check-frames,
> mesh|relay, generation-ladder migration). Where this doc references an AoI radius it maps
> to 05's `TIGHT`/`LOOSE`/`OUT` bands + `TIGHT_SET_MAX`; the *named values* below
> (`AOI_NEAR`/`AOI_FAR` in floors) are this doc's v3 proposal and must be folded into 05 when
> 05 is rewritten for v3 — flagged **[→ 05 v3]**. References to 05's collapse/`StandingBeacon`
> are re-pointed at v3 equivalents and flagged **[supersedes 05 collapse]**.

---

## 0. One-paragraph thesis

There is exactly one physical shaft. Every crew climbs it. A crew's entire standing is a
single scalar — its Anchor's altitude — so cooperation (get OUR Anchor up) and competition
(knock THEIR Anchor down) are the same verb set pointed in opposite directions. Crews
self-sort by altitude into a loose convoy; they collide only at structural pinch points
(chokes, lifts, merges) and when paces overlap. Rival interference is "everything you can
do to a teammate, done to an enemy," and the five grab-pressures (bible pillar 2) guarantee
that even the strongest interference — dragging a rival Anchor toward the abyss — is an
exposed, all-in commitment rather than a lock. This is the Smash Bros kill model (you kill
with POSITION, not damage) wrapped around an Overwatch payload (the Anchor) on a Mario-Kart
field (rubber-banding re-bunches the pack).

---

## 1. STANDING — the only score

### 1.1 Definition (locked)

Per bible pillar 1, **a crew's standing IS its Anchor's height. Full stop.** No individual
kills, assists, distance, style, or survival counts toward standing. Non-Anchor players are
pure enablers; their personal heroics matter only insofar as they move the Anchor's altitude.

This is deliberate and we do not soften it:

- It collapses intra-crew incentives to one shared number, so no teammate ever has a private
  scoreboard reason to defect. "What's good for me" literally cannot diverge from "what's
  good for our Anchor."
- It makes every rival the same shape of opposition (their Anchor is the only thing worth
  attacking for score), which is exactly what the AoI=Anchor netcode wants (§7).

### 1.2 The altitude metric `H`

Standing is measured in **floors climbed**, expressed as a deterministic, quantized value so
it is rollback-safe and bit-identical across peers (05 §8 determinism policy: seeded PRNG,
quantization, no wall-clock; 05's positions come from the pinned Rapier-WASM sim, so altitude
is derived, never injected — 05 §8.1/§9.3).

```
H_anchor = floorIndex(anchor) + fractionalProgress(anchor)
```

- `floorIndex` — integer index of the floor the Anchor's center-of-mass currently rests on
  or last *committed* to. The tower is an endless stack of floors grouped into **strata**
  (source of truth for floors-per-stratum and stratum layout: `09-level-generation.md`).
- `fractionalProgress` — `clamp01((anchorY - floorBaseY) / FLOOR_HEIGHT)`, a fixed-point
  value in `[0,1)`. Used only for the *display altitude bar and tiebreaks*, never for win
  checks (win checks compare committed integer floor index, to avoid jitter at a boundary).

**Committed vs raw height (anti-yo-yo rule).** Standing uses a *committed* altitude, not the
Anchor's instantaneous Y, so a brief launcher toss or bounce doesn't flicker the leaderboard:

```
H_committed = max over the last COMMIT_WINDOW ticks of a STABLE altitude sample,
              where "stable" = Anchor grounded/standing (not airborne, not grabbed,
              not in a downed/vulnerable beat) for >= GROUND_DWELL ticks.
COMMIT_WINDOW = 30 ticks (0.5 s @ 60 Hz)   // 05 §1: 60 Hz fixed timestep — display smoothing
GROUND_DWELL  = 12 ticks (0.2 s)
```

Key consequence, consistent with bible pillar 4 (Smash model): **being thrown DOWN
immediately lowers raw Y, but standing drops only once the Anchor *settles* lower.** You
lose standing when the sabotage actually sticks, not on the throw arc. If the crew re-catches
the Anchor before it grounds lower (Mender catch, Bulwark body-block, a built ledge), no
standing is lost — which is what makes "catch your falling Anchor" feel like a SAVE, not just
damage control. The DOWN-throw still costs *tempo* (the vulnerable beat, §3.4).

> [→ 05] `COMMIT_WINDOW`, `GROUND_DWELL` are tick-counted by design (60 Hz fixed timestep,
> 05 §1.1). They belong in 05's constants; values above are the intended behavior.

### 1.3 Tiebreaks

When two crews' Anchors share the same committed floor index:

1. Higher `fractionalProgress` (who is further into that floor).
2. If still tied: the crew that *reached* that floor index on the earlier tick (stored as
   `firstReachedTick[floorIndex]` per crew). Deterministic, tick-based, no wall-clock (05 §1).
3. Endless mode never needs a hard mid-match tiebreak (standing is just an ordering);
   race/round modes resolve summit ties by `firstReachedTick` at the summit/target floor.

### 1.4 Live display

The HUD shows standing in three nested scopes, all driven off the same `H_committed` values
the netcode already gossips for the standing broadcast — 05's `StandingBeacon` on the
unreliable gossip channel at **2 Hz** (05 §2.2: height + crew id + alive/downed, quantized,
`beaconSeq`-ordered, ~480 B/s aggregate). v3 swaps the beacon's `highWaterY`/`median` payload
for `H_committed` per-Anchor **[supersedes 05 collapse]** but the channel, cadence, and
last-write-wins convergence are 05's verbatim. No extra netcode cost. (Visual treatment owned
by `07-ux-ui-gamefeel.md`; this section specifies the *information*.)

- **Altitude ribbon (screen edge):** a vertical strip showing YOUR Anchor's altitude as a
  filled bar with floor ticks, plus small **rival pips** at each rival Anchor's committed
  altitude. Pips show ONLY altitude + crew color + distance class (near/mid/far band) — never
  exact position. This fuses the leaderboard and the fog-band radar into one element (§5.4).
- **Crew banner (top):** your Anchor portrait + current floor number + delta to the crew
  directly above and directly below ("+3 ▲ Crimson", "−1 ▼ Cobalt"). Deltas update on
  committed changes only, so they don't strobe during a brawl.
- **Standings sheet (hold a key):** full ordered list of crews by `H_committed` — crew color,
  Anchor name, floor, alive/downed/wiped state, and a small sparkline of their last ~10 s of
  altitude (momentum: who's surging, who's stalled). Sparkline = a ring buffer of committed
  samples the client already receives via the standing broadcast.

Design intent: a glance at the ribbon answers the only two questions that matter — *am I
winning?* and *who is close enough to fight?* — and they are literally the same axis.

---

## 2. RIVAL INTERACTION — "lots of ways, but just like any other player"

### 2.1 The principle (bible pillar 9)

There is **no rival-specific verb.** Everything you can do to a teammate, you can do to a
rival, and vice versa. The four verbs (RUSH / GRAB / THROW / STRUGGLE — `02`) plus the mass
hierarchy and world-object throwing ARE the entire PvP system. We add zero "attack"
abilities. This is the single most important consistency rule in the doc: it keeps the
codebase small, the netcode uniform (one Rapier-WASM rigid-body/constraint sim for ALL grab/
throw/object interactions — 05 §8.1; the bible's #1 determinism risk lives in exactly one
place), and the
mental model honest ("if I can throw a crate to boost my own Anchor, I can throw it to wreck
yours").

### 2.2 The full verb set applied to rivals

Targets, lightest → heaviest (mass hierarchy, bible pillar 2):

| Target | Against a rival you can… | Tempo cost / risk |
|---|---|---|
| **Light world object** (debris, hazard fragment) | THROW at a rival climber/Anchor for stagger, knock them off a ledge, spoil a built ramp | Cheap, low impact; ranged sabotage that DOESN'T tie up hands long |
| **Heavy world object** (crate, barrel, Engineer block) | THROW for big knockback/ring-out; drop to block a route; weigh down a rival lift plate | Slow wind-up, encumbers you while carried |
| **Rival climber** (Runner/Bulwark/Mender/etc.) | RUSH to stagger; GRAB then THROW off-route or into a hazard; shove off a lift; grab-chain | They STRUGGLE free; you're PREY while holding |
| **Rival Anchor** | All of the above — RUSH, GRAB, THROW down floors, drag toward a kill-plane, shove off a lift, pelt with objects, sabotage the floor under it | The all-in commitment (§4); the Anchor is fall-DURABLE so you can't instakill, you must achieve POSITION |
| **Rival *route*** (terrain) | Breaker collapses their shortcut; Engineer drops a trap / removes a bridge; Mover seals a gap; throw an object to spring a hazard onto them | Indirect, persistent, hands-mostly-free; highest-leverage low-risk interference |

The asymmetry that makes the meta interesting: **direct Anchor interference is high-risk /
high-reward; route sabotage is low-risk / medium-reward.** Good crews lean on route sabotage
to *slow* rivals and reserve direct grabs for the decisive flashpoint moment.

### 2.3 RUSH / shove vs GRAB on rivals

- **RUSH** (dash) is the safe poke: closes distance, staggers, can knock a lightly-planted
  player or even a rival Anchor off a ledge if positioned, and crucially **leaves your hands
  free.** It is the default rival-interaction tool. A RUSH into a rival Anchor near an edge is
  often better than a GRAB because it doesn't make you prey.
- **GRAB** is the committal tool: how you THROW someone a long way or drag them somewhere
  specific, but it triggers all five pressures (§2.4). You grab when you have a *plan and
  support*, not as a default.

This is the bible's "grab is a tempo tool, not a control tool," expressed competitively: the
cheap, spammable interference (RUSH, object-throw, route-sabotage) is non-locking by
construction, and the locking interference (GRAB) is self-limiting by the five pressures.

### 2.4 Why interference stays NON-DEGENERATE (the five grab-pressures, restated for PvP)

The failure mode we design against: a rival permanently neutralizes your Anchor by
holding/stunlocking it (the "control tool" degeneracy). The five pressures (bible pillar 2;
mechanics owned by `02`) make that impossible. Restated against a rival grabbing YOUR Anchor:

1. **Hands-full** — the grabber can't climb, build, break, or use abilities while holding.
   Holding your Anchor means they do nothing else; their own Anchor isn't advancing.
2. **STRUGGLE** — your Anchor (and any grabbed teammate) mashes free; break time DECREASES
   the harder they fight. The heavy Anchor is the *worst* thing to try to hold, and a
   struggling body spoils throw aim (bible pillar 2).
3. **Encumbrance** — carrying the Anchor slows the carrier *a lot* (heaviest in the mass
   hierarchy). A rival who grabs your Anchor becomes slow and obvious — trivially intercepted.
4. **Grabber is PREY** — while holding, the rival can be grabbed/shoved/thrown. Grab CHAINS
   happen: your Bulwark grabs the rival holding your Anchor and throws BOTH. (Chain resolution
   order & determinism: `02` + `05` §8.4 fixed iteration order = ascending entity id.)
5. **BULWARK hard-counter** — the Anchor-guard body-blocks grabs aimed at the Anchor and
   breaks grabs on allies. A crew that keeps its Bulwark near the Anchor makes a direct Anchor
   grab cost the attacker far more than it gains.

**Net:** rival interference is *frequent and impactful* but *never a lock.* The most a single
grab buys is a throw (a position swing) before the pressures force a release. Sustained denial
requires *team* commitment — which means that team isn't climbing. Exactly the tradeoff we
want.

---

## 3. THROWING RIVALS DOWN — the Smash kill model in competition

### 3.1 Position kills, not damage

Per bible pillar 4 there is **no HP attrition kill.** You win exchanges by achieving POSITION
— throwing a rival player into a lethal fall/hazard (regular players ARE fall-lethal), or
throwing/dragging a rival Anchor down floors / into a real kill-plane.

### 3.2 Killing a rival's CREW MEMBER (not the Anchor)

Regular rivals are fall-lethal. Throwing a rival Runner/Mender off a high ledge removes them
for a respawn beat. **This does NOT change standing** (standing is Anchor-only) — but it
strips the rival Anchor of an escort/guard for the window, which is how you *create the
opening* to then go at the Anchor. Killing the support is the setup; the Anchor is the payoff.

Respawn rule (consistent with rubber-banding, `03`): a downed regular player respawns at their
crew's **RECALL BEACON** altitude (the Anchor's rally point, bible pillar 1; semantics owned
by `02`/`03`) after `RESPAWN_DELAY`. So killing support buys a *timed* window, not a permanent
man-advantage — fights stay flashy and recoverable, not snowbally.

> [→ 02/03] exact `RESPAWN_DELAY` and confirm respawn is at-beacon (this doc assumes beacon).

### 3.3 Throwing the rival ANCHOR DOWN (the core competitive act)

The Anchor is **fall-DURABLE** (bible pillar 4): a thrown Anchor is NOT instakilled on impact.
The punishment is:

- **ALTITUDE LOST** — it lands on a lower *real* floor (floors persist, bible pillars 4 & 7),
  so the rival's standing drops once it settles (§1.2 committed-altitude rule).
- **A brief vulnerable / downed beat** on landing — the rival Anchor is staggered, its crew
  must scramble to it, and YOUR crew can pounce (re-grab, throw it further, pelt it).

This is the diegetic "blue shell" of bible pillar 6: a successful Anchor-throw-down both hurts
the leader's standing AND re-bunches the pack so trailing crews catch up.

### 3.4 The vulnerable beat (numbers)

On a hard landing (fell ≥ `DOWN_FLOORS_MIN` floors OR was thrown by a player):

```
VULN_BEAT       = 90 ticks (1.5 s)  Anchor downed: reduced control, can still STRUGGLE/crawl
DOWN_FLOORS_MIN = 2 floors          minimum drop to trigger a downed beat (small drops just cost altitude)
REGRAB_IMMUNITY = 18 ticks (0.3 s)  after release, Anchor can't be re-grabbed (anti-stunlock; pairs with pressure #2)
```

`REGRAB_IMMUNITY` is the explicit anti-degenerate guard for Anchor-on-Anchor abuse: you can
throw it down, but you can't *instantly* re-grab the same Anchor to chain it infinitely — you
must re-close distance, during which its crew can intervene.

> [→ 05] All three are tick-counted (60 Hz, 05 §1.1); reconcile exact values into 05's constants
> table. Behavior/intent is the contract; values are 05's to finalize.

### 3.5 TRUE Anchor death (rare, decisive)

Only at a **real kill-plane** (bible pillar 4): thrown into a lethal hazard, or off the very
bottom of the tower / below the lowest persistent floor. True death triggers the
win-condition handling for that crew (§6) — wipe/elimination or major setback per lobby
settings. Achieving a true kill is hard *by design*: you must drag a heavy, struggling,
durable VIP past its whole crew to a specific lethal location while you are prey and
encumbered. It should feel like a heist that comes off maybe once or twice a match.

---

## 4. PERSON-CTF FLAVOR — drag a rival Anchor; why it's a COMMITMENT, not a LOCK

Bible pillar 9 explicitly allows carrying/dragging a rival Anchor (true person-CTF flavor). We
support it fully and make it deliberately *expensive*:

- **You become slow and obvious.** Anchor encumbrance is the heaviest in the mass hierarchy
  (pressure #3). You crawl, telegraphed, with a clear "carrying enemy Anchor" marker visible
  across fog-bands (§5.4) — the whole shaft can see a steal in progress.
- **You can't do anything else.** Hands-full (pressure #1): no climbing the hard way, no
  abilities, no building. Your entire turn is committed to this.
- **It struggles and spoils your aim.** The Anchor mashes STRUGGLE (pressure #2); break time
  shrinks the harder it fights, and it wriggles to ruin where your THROW lands. You rarely get
  to carry far OR throw precisely.
- **You're prey, and so is your prize.** Pressures #4 + #5: the victim crew's Bulwark breaks
  the grab or grabs YOU; a Mender catches the Anchor mid-fall; a teammate chains you. Carrying
  a rival Anchor paints a target the whole enemy crew converges on.
- **Your own Anchor is unattended.** The self-balancing strategic cost: while you (and likely
  a teammate) commit to a heist, your Anchor isn't climbing and is exposed to the OTHER crews
  in a two-plus-Anchor shaft. A steal attempt is also an invitation.

**So: dragging a rival Anchor down is a powerful, legal, sometimes match-deciding play — but
it is an ALL-IN COMMITMENT (slow, blind, prey, abandoning your own objective), not a control
LOCK.** The pressures convert "I'm holding your VIP forever" into "I get one risky throw, then
I'm released and exposed." That is the exact non-degeneracy guarantee the bible demands.

The realistic high-value version of the heist is NOT a long carry — it's a **short drag to a
nearby edge / kill-plane and a throw**, or a **grab-to-shove off the lift you're both standing
on.** Distance carries are a flex, not the meta.

---

## 5. SHARED TOWER, SOFT-SEPARATED BY PACE — flashpoints & fog-bands

### 5.1 One shaft, loose convoy (bible pillars 5 & 10)

All crews climb ONE physical shaft. There is **no rising wall-of-death** (bible pillar 5) — the
only pressure is rival Anchors climbing + sabotage + rubber-banding. Crews spread by skill/luck
into a **loose vertical convoy**: a leader band, a chasing pack (re-bunched by rubber-banding),
and stragglers. Most of the time you climb among your own crew and the *terrain* is your
opponent (bible pillar 3, no AI).

### 5.2 How the soft separation actually works (mechanics)

The separation is *emergent*, not walled. Three mechanisms tune how often paces overlap:

1. **Multiple ROUTES per stratum** (bible pillar 7, `09`): ramps / stairs / spires / lifts.
   Crews at similar altitude usually pick *different* routes and pass without contact. Routes
   are the pressure valve that keeps "shared shaft" from meaning "constant melee."
2. **CHOKES & shared structures**: each stratum funnels into a few mandatory or high-value
   pinch points (the lift, the single-wide ledge, the merge where routes recombine before the
   next stratum). These are the *intended* collision sites.
3. **Rubber-banding** (`03`): trailing crews draw better boons and the leader gets blue-shelled
   (a thrown-down Anchor re-bunches the pack), so paces keep folding back together rather than
   diverging forever. This is what *guarantees* flashpoints keep happening in an endless climb.

Target cadence (bible pillar 5 rhythm: calm-coordination → panic-burst → calm):

```
Roughly one FLASHPOINT per stratum per pair of paced-adjacent crews.
Calm traversal : flashpoint  ≈  2 : 1  by time, in a healthy match.
```

This cadence is also what keeps crews inside `AOI_NEAR` (6 floors **[→ 05 v3]**; 05 §6 `TIGHT`
band) only intermittently — the soft separation and the sync-cluster boundary are the same
phenomenon (§7).

### 5.3 FLASHPOINTS — where & when crews collide

| Flashpoint type | Why it collides crews | Typical play |
|---|---|---|
| **Lift / elevator** | One slow shared platform everyone wants; you ride together | Shove rivals off; weigh it down with objects; grab-fight for the good spot; throw the rival Anchor off mid-ride |
| **Single-wide ledge / spire** | Geometry forces a queue | RUSH/grab to bump rivals off; Bulwark holds the line; Breaker collapses it behind you |
| **Route MERGE** (routes recombine before the next stratum) | Diverged crews re-converge at one panel | The classic brawl flashpoint; control the merge = control the next stratum's entrance |
| **Coalescing floor edge** (players EMERGE UP through a resolving floor, bible pillar 7) | Predictable emergence point = ambush spot | Camp the emergence; grab the Anchor as it surfaces; or defend your own emergence |
| **Pace collision** (a surging trailing crew catches a stalled leader) | Rubber-banding folds them together | The decisive late exchange; often where Anchor-steals happen |

Design rule: **flashpoints are STRUCTURAL, not scripted.** They emerge from route geometry +
pace, so they're determinism-safe (no event-spawner randomness in the sim — 05 §1) and they
respect the AoI=Anchor model (crews tightly sync only when their Anchors are altitude-adjacent,
i.e. exactly when they're at a shared flashpoint — §7).

### 5.4 Rival visibility across FOG-BANDS (info leak)

Per bible pillar 7, floors below desaturate/fog with distance and floors above hang as
wireframe "potential." Rival information *degrades with altitude distance* in three bands.
This is both the aesthetic and the **competitive information economy** — and it is the visual
twin of the netcode AoI bands (05 §6: `TIGHT` / `LOOSE` / `OUT`). The render boundaries MUST
equal the netcode band boundaries so that "I can see them clearly" ⟺ "we are in the same sync
cluster" ⟺ "we can actually fight." The three fog-bands below map 1:1 onto 05's three AoI
bands; the floor radii are v3's proposal **[→ 05 v3]** (05 today uses `TIGHT_STRATA` in stratum
units — convert at `09`'s floors-per-stratum).

| Band | Altitude distance to rival Anchor | What you see of that rival crew | Netcode band (05 §6) |
|---|---|---|---|
| **NEAR** | within `AOI_NEAR = 6` floors **[→ 05 v3]** | Full fidelity: exact positions, who's holding what, grab states, the Anchor's downed/vulnerable state | 05 `TIGHT` band: full rollback (k≈5), `hot`-channel input streams |
| **MID** (fog-band) | `6`..`AOI_FAR = 14` floors **[→ 05 v3]** | **Silhouettes**: fog-shrouded shapes; crew color, rough position, body count, and a **"carrying enemy Anchor"** banner if a steal is in progress. No precise grab/ability state | 05 `LOOSE` band: `BEACON`/`SilhouettePose` interpolation (~8 Hz), no rollback |
| **FAR** | beyond `14` floors | **Pips only**: a colored marker on the altitude ribbon (§1.4) at the rival Anchor's committed height + distance class. No silhouette, no positions | 05 `OUT` band: `StandingBeacon` only (2 Hz) |

> [→ 05 v3] `AOI_NEAR = 6` / `AOI_FAR = 14` floors are this doc's v3 proposal for 05's AoI
> band boundaries (05 today expresses them as `TIGHT_STRATA` with an "enter at ±N, leave at
> ±N+1" hysteresis, 05 §6.1 — keep the hysteresis verbatim, just re-express in floors). The
> fog-band render must track whatever 05 finalizes and move with it on retune. The *coupling*
> is non-negotiable. The MID/FAR fidelity exactly matches what 05 actually sends at each band
> (`SilhouettePose`/`BEACON` for LOOSE, `StandingBeacon` for OUT) — fog-bands never reveal
> data the netcode doesn't transmit, so the info economy and the bandwidth budget are one
> design.

Info-leak intent: you ALWAYS know your standing vs everyone (pips/ribbon are free — standing is
the one global broadcast, 05 §2.2/§5.2), you get a *silhouette warning* before a fight (MID = "someone's
closing"), and you pay full information/netcode cost only for crews you're actually engaging
(NEAR). A steal-in-progress deliberately leaks to the MID band so the shaft can react to a heist
(§4) — heists are loud by design.

---

## 6. WIN CONDITIONS (the three modes; bible pillar 11)

All three share the standing metric (§1). They differ only in the terminating condition and in
what Anchor-death means. Host picks one in the lobby (knobs owned by `01`/lobby settings).

### 6.1 RACE-TO-HEIGHT (the "esports / clean" mode)

- **Goal:** first crew whose Anchor commits to floor `TARGET_FLOOR` wins instantly.
- `TARGET_FLOOR` host-set, default **100** floors. Tunable 40–300.
- **Anchor death:** respawns the Anchor at the crew's RECALL BEACON after a heavy delay
  (`ANCHOR_DEATH_DELAY`, host-tunable) with altitude loss — a major setback, not elimination.
  Keeps the race alive and comeback-friendly.
- **Win check:** `H_committed.floorIndex >= TARGET_FLOOR` for any crew → that crew wins; if two
  qualify on the same tick, `firstReachedTick` at `TARGET_FLOOR` decides (§1.3).
- **Feel:** a defined finish line; sabotage is about *delaying* rivals past the line; the leader
  can be caught because rubber-banding + a single Anchor-throw-down can erase a near-top lead.

### 6.2 ENDLESS — HIGHEST STANDING (the "party / persistent" mode, the bible default vibe)

- **Goal:** no finish line. Runs until a host-set **time limit** (default **15 min**) or the host
  ends it. Highest `H_committed` when time expires wins.

  > Time limit is enforced as a **tick budget** (`endTick = startTick + minutes*60*60`), never a
  > wall-clock timer — 05 §1 (one clock = the tick). The HUD countdown is render-only.
- **Anchor death:** instant respawn-at-beacon, low penalty; the point is continuous brawling and
  constant lead changes. The leaderboard ribbon (§1.4) IS the experience.
- **Win check:** at `endTick`, order crews by `H_committed` then tiebreaks (§1.3).
- **Feel:** endless tower, never-ending climb-and-brawl, Mario-Kart chaos. Rubber-banding tuned
  strongest here so the pack stays bunched and trading the lead.

### 6.3 ROUNDS-TO-SUMMIT, THEN NEW TOWER (the "best-of / structured" mode)

- **Goal:** first crew to summit a *capped* tower wins the ROUND. First to `ROUNDS_TO_WIN`
  rounds (default **best of 3 → 2 wins**) wins the match.
- Each round: a fresh **seeded** tower (new PRNG seed per round — 05 §1 seeded PRNG, NEVER
  `Math.random`; seeding owned by `09`) with `SUMMIT_FLOOR` (default 60). Summit → round won →
  everyone resets to a NEW tower for the next round.
- **Anchor death:** per-round elimination is OFF by default (respawn-at-beacon) but is a host
  toggle for a hardcore "last-Anchor-standing wins the round" variant.
- **Win check:** round won on first summit commit; match won at `ROUNDS_TO_WIN`. Between rounds:
  short intermission, crews keep composition, the fresh tower coalesces in (no loading screen,
  bible pillar 7 / `09`).
- **Feel:** structured competitive cadence with seed variety; good for organized lobbies and the
  "new tower each round" novelty.

### 6.4 Shared rules across all modes

- Standing metric, tiebreaks, fog-bands, flashpoints, and the full rival verb set are identical
  in all three. Only termination + Anchor-death severity change.
- Lethality, PvP-spice, collapse/pressure knobs, crew size (3–5), and Anchor-death behavior are
  host-tunable per bible pillar 11; the win condition is just the top-level selector.

---

## 7. CONSISTENCY WITH THE AoI=ANCHOR NETCODE (`05-netcode-architecture.md`)

This section is the contract between competitive design and netcode. It must hold. (05 §6 owns
AoI; 05's "REUSE vs REPLACE" boundary at §0 owns the connection brain.)

1. **AoI centers on each crew's Anchor.** Standing IS the Anchor's altitude, so the thing we
   score and the thing we sync are the *same point*. v3 specializes 05's vertical-proximity AoI
   (05 §6) by making the **Anchor the band center** — leaderboard pips, fog-bands, and the AoI
   `TIGHT`/`LOOSE`/`OUT` bands become three views of one quantity → no extra netcode cost to
   show standing. **[→ 05 v3]** (05's `TIGHT_STRATA` window keys off the local player's height;
   v3 re-keys it to the crew's Anchor height.)
2. **Tight-sync clusters = paced-adjacent crews = flashpoints.** Two crews enter the same
   rollback cluster (05 `TIGHT` band) exactly when their Anchors are within `AOI_NEAR = 6`
   floors **[→ 05 v3]** — which is exactly when §5.3 says they collide. So heavy two-body GRAB
   constraints + THROW impulses + many throwable rigid bodies (the bible's #1 determinism risk;
   one pinned Rapier-WASM sim, 05 §8.1) only resolve *within* a small bounded cluster (k≈5, 05
   §6.1), never globally. **Competitive design must NEVER create a mechanic that forces
   interaction across band boundaries** (no "snipe a rival 30 floors up"): all direct
   interference is range-bounded to NEAR/`TIGHT`. The longest-range interference is **object-
   throw and route-sabotage, which are still local** (you must be at the rival's structure).
   This keeps worst-case rollback depth bounded (05 §2.4 `maxRollbackFrames = 8`, §6.3
   `TIGHT_SET_MAX` topology-switch fallback, §10 "rollback depth = worst-peer extreme-order
   statistic" + the demote-the-laggard rule).
3. **Standing is the one cheap global broadcast.** Each Anchor's `H_committed` (a single
   quantized scalar + crew id + alive/downed) rides 05's `StandingBeacon` at **2 Hz** to ALL
   peers for the ribbon/pips/FAR band (05 §2.2 / §5.2 `BEACON`). Tiny (~480 B/s aggregate),
   `beaconSeq`-ordered, loss-tolerant on the unreliable gossip channel → no inflation of the
   `hot` AoI input payload. **[supersedes 05 collapse]** the beacon's old `highWaterY`/median
   crew score becomes per-Anchor `H_committed`.
4. **Determinism of the kill model.** Position kills (throws, ring-outs, kill-planes) are pure
   physics + deterministic scripted hazards (bible pillar 3; 05 §1.4 closed-form hazards off the
   tick) — no random crit, no wall-clock. Anchor-down beats, regrab-immunity, respawn timers,
   and the endless-mode time limit are all **tick-counted** (05 §1.1), never `performance.now()`
   (which 05 confines to the transport layer for RTT/timeouts only). PvP verb inputs flow through
   05's standard `validate`/commit-reveal/check-frame path (05 §9) — no new anti-cheat surface.
5. **Spectator data rides existing AoI streams** (§8) — a spectator subscribes read-only to a
   chosen Anchor's `LOOSE`/`SpectateFeed` data (05 §8 `BEACON`/loose-band interpolation; the old
   04's `SpectateFeed` concept carries over); no new authority path, no new sim writer. 05's sim
   is peer-symmetric (05 §0/§7: the migrated "host" owns signaling/relay/lifecycle, not per-tick
   truth), so spectators add zero rollback load (ingress-only).
6. **Hysteresis is a gameplay feature too.** 05 §6.1's "enter `TIGHT` at ±N strata, leave at
   ±N+1" band means a fight doesn't strobe in/out of full fidelity right at the edge —
   combatants stay tightly synced through a brawl that drifts across the boundary.

---

## 8. LOBBY, MATCHMAKING, CREW FORMATION, ANCHOR SELECTION

Built on the sibling `frequency/src/net/` proven base (host/peer roles, deterministic room-code
→ peerId, PeerJS signaling + STUN/TURN, silent host migration via generation ladder). 05 §0
owns the REUSE-vs-REPLACE table and the deterministic `ascv1-<CODE>-g<gen>` room-code scheme
(`roomCode.ts`, REUSED from frequency's `freqv1-…` with the prefix rebranded — 05 §0); this
section defines the *lobby UX/structure* on top of it. Note (05 §0/§7): the migrated "host" is
a **session coordinator /
signaling pivot / relay anchor only**, NOT the simulation owner — the sim is peer-symmetric
(every peer derives state from the shared input stream), so the host choices below never make
the host a per-tick referee.

### 8.1 Lobby model

- **Room-code lobby (primary).** Host creates a room → deterministic room-code → peerId (reused
  from frequency). Friends join by code. Default for the P2P mesh (05 `mesh` topology /
  `meshBus.ts` ≈ 8 peers; `relay` topology / `relayBus.ts` scales toward ~20–30 — 05 §3/§10).
- **Quick-match (secondary, later).** Optional matchmaking that buckets solo-queuers into rooms;
  v1 ships room-code first (smaller surface, matches the P2P heritage). Flagged for a later doc.

### 8.2 Crew formation

- **Premade crews** are first-class: drag yourself into a crew slot in the lobby. A lobby holds
  N crews × 3–5 members (bible pillar 11 crew size; flex for uneven lobbies).
- **Solo-queue into a crew:** a solo joiner is auto-placed into the crew with the fewest members
  (balance-fill), or into an "open crew" the host created. Uneven lobbies flex crew size 3↔5 so
  nobody waits; a 4v3 lobby is legal and the 3-crew gets a small rubber-band bias (`03`).
- **Crew identity** = color + name, assigned on creation. Color drives pips, silhouettes, and
  fog-band markers (§5). Color assignment is **deterministic from crew index** for replay /
  determinism (no `Math.random`, 05 §1).

### 8.3 WHO IS THE ANCHOR — selection

Decision (opinionated, no hedge): **VOLUNTEER-FIRST, then ASSIGN-by-fallback.**

1. **Volunteer:** in the lobby, any crew member may claim the single Anchor slot. The Anchor is a
   desirable, distinct identity (bible pillar 8: "spent their skill points on being important"),
   so we expect volunteers — it's the "I want to be the VIP" role.
2. **Assign-fallback:** if no one volunteers by lobby-ready, the slot is assigned to the
   **most stable connection** in the crew (deterministic tiebreak by peerId). Rationale tied to
   netcode: the Anchor is the AoI center for its whole crew (05 §6 **[→ 05 v3]**), so its
   connection quality matters most — put the role on the most stable peer when there's no
   preference.

   > [→ 05] "most stable connection" must be a **deterministic, agreed** value derived from the
   > host's connection/RTT table at lobby-ready (a single agreed snapshot), NOT a per-peer
   > wall-clock guess — otherwise peers could disagree on the Anchor. 05 owns how that snapshot
   > is exposed.
3. **No mid-match Anchor swap by default.** Swapping the AoI center mid-match is a netcode hazard
   (it moves a crew's whole interest volume). The only exception is **Anchor succession on a true
   Anchor wipe in elimination variants** (§8.4 / §6.3), handled like frequency's silent
   generation-ladder migration so it "just works" with no UI ceremony (frequency/CLAUDE.md:
   migration is intentionally invisible).

### 8.4 Spectating after an Anchor loss / wipe

What happens to a player when their stake in the match ends:

- **Regular player death (any mode):** respawn at the RECALL BEACON (§3.2). Never a spectator for
  long — the brawl is recoverable. No spectator state needed.
- **Anchor death, non-elimination modes (RACE default, ENDLESS, ROUNDS default):** the Anchor
  respawns at the beacon with penalty (§6). The crew is never out; nobody spectates.
- **Anchor true-death in an ELIMINATION variant (host toggle):** the crew is OUT for the round
  (ROUNDS) or the match (hardcore RACE/ENDLESS toggle). Those players become **spectators**:
  - **Free-fly + follow-cam:** spectate any remaining Anchor's AoI cluster (rides existing
    `LOOSE`-band / `SpectateFeed` streams, §7.5 — no new authority). Default cam follows the
    *leading* crew, then cycles.
  - **Determinism-safe:** spectators send NO inputs into the sim (pure observers), so they add
    zero rollback load and cannot desync the match. Ingress-only subscribers (05 sends INPUTS
    not state, §1/§3 — a non-inputting peer simply never contributes a frame).
  - **Re-seat between rounds (ROUNDS mode):** eliminated crews return fresh on the next tower
    (§6.3), so spectating is brief.
- **Host / Anchor disconnect:** silent host migration (reused `migration.ts` generation-ladder,
  05 §0/§7; the sim is peer-symmetric so there is no authoritative state to hand over — migration
  here is *cheaper* than frequency's, 05 §7) + Anchor succession (§8.3.3) keep the match alive
  with no lobby kick and no UI ceremony.

---

## 9. OPEN TENSIONS other docs must resolve

0. **[→ 05 — MODEL VERSION]** 05 on disk is the *collapse / vertical-proximity* model; this doc
   is v3 (NO collapse; AoI re-centered on the Anchor). 05 must be rewritten for v3: delete the
   rising collapse line + `collapseY(tick)` + collapse-as-eliminator (replaced by the Smash
   POSITION-kill model, §3); re-key the AoI window from raw local height to the **crew Anchor's**
   height (still 05 §6's mechanism, new center); keep every netcode primitive verbatim. This is
   the single biggest cross-doc reconciliation.
1. **[→ 05 v3]** Fog-bands (§5.4), leaderboard-pip distance classes, and the "no cross-band
   interference" rule (§7.2) are HARD-COUPLED to `AOI_NEAR = 6` / `AOI_FAR = 14` (proposed) and
   the leave hysteresis (05 §6.1's "enter ±N, leave ±N+1"). 05 owns the final numbers; if 05
   retunes, the fog render and interaction range move with them. The coupling is non-negotiable.
2. **[→ 05]** Tick constants in §3.4 (`VULN_BEAT`, `REGRAB_IMMUNITY`, `DOWN_FLOORS_MIN`) and
   §1.2 (`COMMIT_WINDOW`, `GROUND_DWELL`) must land in 05's determinism constants table. They are
   tick-counted by design (60 Hz fixed timestep, 05 §1.1); 05 finalizes exact values.
3. **[→ 02/03]** Beacon-respawn vs Anchor-respawn semantics and `RESPAWN_DELAY` /
   `ANCHOR_DEATH_DELAY` (§3.2, §6). This doc assumes respawn-at-BEACON; 02/03 confirm. RECALL
   BEACON mechanics live in `02` (Anchor identity) — keep them the source of truth.
4. **[→ 03]** Leader-protection guardrails. This doc leans on "a thrown-down Anchor re-bunches
   the pack" as the comeback engine (§3.3, §5.2). 03 must ensure that doesn't feel unfair to a
   skilled leader (bible pillar 6 guardrail).
5. **[→ 09]** Stratum layout, floors-per-stratum, route count per stratum, choke/merge placement,
   and per-round seeding (§1.2, §5, §6.3). This doc assumes these structural sites exist; 09 lays
   them out.
6. **[→ 02]** Grab-chain (grab-train) resolution order & the "held body spoils throw aim"
   mechanic, which §2.4 / §4 depend on for non-degeneracy. Must resolve deterministically in
   fixed ascending-entity-id order (05 §8.4) inside the one Rapier-WASM sim (05 §8.1).

CROSS-CUTTING INVARIANT (the one rule no other doc may break): **Standing = Anchor altitude, and
the thing we score, sync (AoI), and reveal (fog-bands/pips) are all the SAME single point.** Any
feature that scores something other than Anchor altitude, or that lets crews interact / "see
clearly" outside their Anchor-centered AoI band, violates both bible pillar 1 and the netcode
model (05 §6) and must be rejected.
