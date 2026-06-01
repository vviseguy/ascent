# 01 — Game Design Document (ASCENT, v3)

> Status: **v3 — authoritative.** Supersedes all earlier drafts of this file.
> Scope: the moment-to-moment loop, stratum design, the Anchor-escort core, the persistent
> two-way tower & falling model, pure-race pressure, win conditions + the full per-lobby knob set,
> session/macro shape, and the race-vs-co-op resolution.
>
> Sibling docs (read alongside):
> - `02-roles-traversal-combat.md` — the six identities, the four verbs (RUSH/GRAB/THROW/STRUGGLE),
>   mass hierarchy, encumbrance, struggle math, Bulwark counters.
> - `03-progression-economy.md` — boon drafts, rubber-band boon tables, currency, run economy.
> - `04-competitive-structure.md` — matchmaking, lobbies, leaderboards, seasons, win-condition rules.
> - `05-netcode-architecture.md` — rollback, AoI-on-Anchor, determinism, transport (REUSE/REPLACE of
>   `frequency/src/net/`).
> - `06-art-direction-shaders.md` — coalescence visuals, fog/desaturation, wireframe-resolve.
> - `07-ux-ui-gamefeel.md` — camera, input, readability, the "where is my Anchor" problem.
> - `08-audio.md` — flashpoint stingers, altitude/recall cues.
> - `09-level-generation.md` — how strata archetypes are seeded, tiled, and made determinism-safe.
>
> Every system in this doc is a **deterministic function of the shared tick counter** (see
> `05-netcode-architecture.md`). No wall-clock, no built-in RNG, no AI. If a design choice below
> would break that, it is flagged.

---

## 0. One-paragraph restatement

ASCENT is a **vertical escort brawl-race**. Crews of 3–5 shepherd their single **Anchor** — a heavy,
slow, fall-durable, but *active* VIP teammate — up an **endless, persistent two-way tower**. A crew's
entire standing is **their Anchor's height** — nothing else is scored. You climb cooperatively through
**strata** (floors that coalesce into existence above you and persist solidly below you), solving
traversal with the four physical verbs (RUSH, GRAB, THROW, STRUGGLE) applied to *everything* —
teammates, world objects, and rival Anchors. The antagonists are **gravity, scripted hazards, and
other players**. You win by **position**, Smash-Bros style: you don't grind enemies down with damage,
you **throw rival Anchors down the tower** while protecting your own. Mario-Kart rubber-banding keeps
the pack re-bunched so the climb stays a contest. The loop alternates **calm co-op traversal** with
**explosive brawl flashpoints** at chokes, lifts, and crew collisions.

---

## 1. The core loop (climb-first, brawl-flashpoint)

The unit of play is the **stratum cycle**. A stratum is one vertical "band" of the tower (one
archetype-instance; see §3). A full run is a stack of stratum cycles, interrupted only by **biome
transitions** and **milestone floors** (§7). One cycle has six beats:

```
   (1) APPROACH ROUTE
        scout reads the stratum, crew picks a line, calls it
            |
            v
   (2) STRATUM COALESCES  ───────────────────────────────────────────────┐
        wireframe "potential" above resolves dots->lines->panels->lit     │  view-layer only,
        as the crew nears; floor becomes a real, solid place              │  deterministic per tick
            |                                                             ─┘
            v
   (3) CO-OP TRAVERSE / CARRY THE ANCHOR        <── the CALM beat
        build ramps, bridge gaps, hand each other up, carry/throw the
        Anchor across chasms, plant/advance the RECALL BEACON
            |
            v
   (4) FLASHPOINT CLASH                          <── the PANIC beat
        chokes / lifts / crew-collisions: RUSH-GRAB-THROW fights, grab
        trains, Bulwark body-blocks, rivals try to throw your Anchor down
            |
            v
   (5) CREST
        Anchor clears the stratum's exit lip; crew's standing ticks up
            |
            v
   (6) DRAFT BOON
        a short, safe-ish landing offers a 1-of-3 draft (rubber-banded;
        see 03-progression-economy.md), then -> back to (1)
```

**Pacing contract (locked):** Overcooked rhythm — *calm-coordination → panic-burst → calm*. Tuning
target: a stratum cycle runs **45–90 s** for an even crew; **beat 3 (traverse) is ~60–70%** of that
time, **beat 4 (flashpoint) is ~15–25%**, the rest is approach/crest/draft. Flashpoints are
**frequent but not constant** (pillar 10): they happen at *built-in chokes* every stratum and at
*emergent crew-collisions* whenever two crews' altitudes overlap. A crew that is way ahead or way
behind will have *more calm and fewer flashpoints* — and rubber-banding (§5, `03`) actively pulls
altitudes back together so the median experience trends toward the intended rhythm.

> **Cross-cutting tension for `09-level-generation.md`:** beat (2) coalescence must *complete before*
> beat (3) is physically required, so the generator must resolve a stratum's collision geometry far
> enough ahead of the fastest scout that nobody ever stands on un-coalesced (non-solid) panels. The
> wireframe→solid transition is **visual**; the **collision body exists from the moment the stratum is
> seeded** (well below view distance). See §6 "the coalescence is cosmetic, the floor is real."

---

## 2. The Anchor escort core (how a crew moves a heavy, slow VIP up)

This is the heart of the game (pillar 1: *the Anchor IS the game*). Everything else is in service of
getting **one** specific heavy body to a higher number than the rival Anchors. The Anchor is **not**
a passive payload — it is a player who "spent their skill points on being important."

### 2.1 What the Anchor *is*, mechanically

| Property | Anchor | Regular player |
|---|---|---|
| Mass class (see `02` mass hierarchy) | **Heaviest grab tier** (above heavy world objects & teammates) | mid tier |
| Move speed | **~55–65%** of a Runner | 100% baseline |
| Jump / gap reach | **Cannot self-clear a "big" gap** (gap > 1.5× its own jump) | can clear normal gaps |
| Fall outcome | **Fall-DURABLE** — not instakilled by impact; loses altitude + brief downed beat | **LETHAL** big falls |
| Can it act? | **Yes** — moves, grabs, throws (slowly), struggles, *plants the Recall Beacon* | yes |
| Encumbrance when carried | **Heavy** — carrier drops to ~40–50% speed, can't climb/build/use abilities | teammate carry = ~70% |
| Recall | **Is the recall target** — crew recalls *to the Anchor's height*, never ahead | n/a |

The Anchor is **durable but slow and gap-locked**: alone it stalls at the first real chasm. That
single constraint *forces* the crew to engage (no solo-Anchor turtling, §5), and it's the source of
all interdependence (pillar 8): the crew exists to *get the Anchor across things it cannot cross
alone*.

### 2.2 The three escort primitives

**(A) CARRY.** Any teammate can GRAB the Anchor and carry it (mass hierarchy top tier). Carrying the
Anchor applies **maximum encumbrance**: carrier ~40–50% speed, hands full (can't climb/build/break/
use ability — pillar 2 pressure *a*). Two teammates can **co-carry** (a "litter") to restore ~70%
speed at the cost of *two* sets of hands — a real tempo trade. The Anchor can wriggle to *assist*
its own carry (a cooperative struggle: instead of breaking free it nudges throw aim / shifts weight to
help the carrier land a throw). Carrying is the *safe, slow* way across a small gap or up a ledge.

**(B) THROW-ACROSS-GAPS.** The signature, high-skill, high-risk verb. A teammate (or a co-throw pair
for more force) GRABs the Anchor and **THROWs it across a chasm** to a teammate (or ledge) on the far
side. This is the *only* way the Anchor clears a **big** gap.

- **Risk is real and diegetic:** a fumbled throw (bad aim, the Anchor wriggling, a rival shove
  mid-windup, falling short) sends your own VIP **down the tower** (pillar 4 punishment: altitude
  lost + downed beat). Throwing your VIP is *powerful but risky* (pillar 2).
- **Catch matters:** the receiver should GRAB-to-catch (a timed catch window) or the Anchor takes a
  hard landing (extra altitude bleed + longer downed beat). Mender's "catch fallers" kit (`02`)
  exists largely for this.
- **Throw arc is deterministic:** force + aim → fixed-timestep ballistic path seeded by tick; *no*
  wall-clock, *no* RNG (determinism requirement, `05`). Wriggle modifies aim by a bounded,
  deterministic offset, not random scatter.

**(C) RECALL BEACON (the rally point).** The Anchor **plants a Recall Beacon** at its current
position (an action only the Anchor can take; cooldown-gated). Any crew member can then **recall to the
beacon** — i.e., to the **Anchor's height, never ahead** (pillar 1).

- Purpose: lets the Scout range far ahead to read routes / grab pickups without the crew permanently
  splitting; lets a thrown-down teammate rejoin fast; lets the crew re-form for a flashpoint.
- **Guardrails (so it isn't free teleport-spam):** recall is **to the Anchor, never above it** (you
  can't recall *up* to skip climbing); **cooldown-gated** (suggested 25–35 s, lobby-tunable §6);
  recall has a **short channel** (interruptible by being grabbed/hit) so it can't be used as a panic
  escape mid-grab. Re-planting the beacon is itself cooldown-gated so the Anchor can't "leapfrog"
  beacons to drag the whole crew upward for free.
- **Determinism:** beacon position and cooldowns are tick-stamped sim state, replicated as intents
  (`05`), never client-local timers.

### 2.3 The Anchor as a *threat*, not just cargo

Because the Anchor sits at the top of the mass hierarchy, a **rival Anchor** is the single most
valuable, most disruptive throwable object in the game. Grabbing and throwing a rival Anchor down the
shaft is the game's win move (§4). But the **5 grab-pressures** (`02`) make holding one a slow, exposed,
all-in commitment — you cannot simply "capture-lock" it.

> **Cross-cutting note for `02`:** the carry/throw/co-carry numbers above (speeds, encumbrance tiers,
> catch windows, wriggle-aim offset bounds) are stated here as *design intent*; `02` owns the exact
> tuning constants and the struggle/encumbrance formulas. Keep them in sync — this doc and `02` must
> not disagree on the mass hierarchy ordering: **light object < heavy object < teammate < Anchor.**

---

## 3. Stratum archetypes (traversal + hazard + flashpoint as one challenge)

A stratum is authored as a **traversal problem** wrapped around a **hazard pattern** with a **built-in
flashpoint location**. We ship **five archetypes**; the generator (`09`) seeds, themes-by-biome, and
varies them. Each is defined by *(traversal verb it stresses, hazard family, where the flashpoint
naturally forms)*.

### 3.1 GAUNTLET — "keep moving through the pattern"
- **Traversal:** a relatively continuous up-ramp/stair run with **multiple parallel lanes**.
- **Hazard:** timed crushers, pattern turrets, gusts/conveyors — all **deterministic functions of the
  tick** (pillar 3). The crew must *time the Anchor's slow body* through windows.
- **Flashpoint:** lane-merges and the *tempo* itself — rivals on adjacent lanes can RUSH-shove your
  Anchor into a crusher window. The escort tension: the Anchor is slow, so windows are tight.
- **Skill it rewards:** Scout reads the pattern phase; crew choreographs the slow Anchor through.

### 3.2 CHOKEPOINT-LIFT — "everyone funnels here"
- **Traversal:** a single (or few) **lift/elevator/spire** that carries bodies up — capacity-limited.
- **Hazard:** the lift cycle (timed), plus edge falls around the platform.
- **Flashpoint:** **the canonical brawl spot.** Crews collide at the lift mouth; whoever controls the
  platform controls who ascends. Prime spot to **throw a rival Anchor off the lift** as it rises.
- **Skill it rewards:** Bulwark zoning, grab-train denial, timing your Anchor's board so it isn't a
  sitting duck.

### 3.3 GAP-CROSSING — "the Anchor cannot do this alone"
- **Traversal:** a **big chasm** (Anchor-impassable) demanding **THROW-ACROSS** or an Engineer
  **bridge** (temporary, throwable, sabotage-able).
- **Hazard:** the void itself (the kill-plane is *right there*), gusts that perturb throw arcs (still
  deterministic).
- **Flashpoint:** the most lethal interference window in the game — a rival shoving your thrower
  mid-windup, or **collapsing your bridge** (Breaker), drops your Anchor into the gap.
- **Skill it rewards:** the throw-across primitive (§2.2-B), Bulwark protecting the thrower, Mender
  catching a short throw, Engineer/Breaker route warfare.

### 3.4 PUZZLE-ROUTE — "solve it together (calm beat anchor)"
- **Traversal:** a small environmental puzzle — **weigh a plate** with a heavy world object (or the
  Anchor itself), align conveyors, open a gate by holding two switches, build a stair out of throwable
  blocks. This is the archetype that *guarantees a calm co-op beat* in the rhythm.
- **Hazard:** light/forgiving — the puzzle *is* the friction.
- **Flashpoint:** **lower** by design (this is the rest beat), but a rival can **steal the puzzle
  object** (grab the crate off the pressure plate) to grief — emergent, optional.
- **Skill it rewards:** clean role division (Overcooked-clean verbs), object management.

### 3.5 CONTESTED-MERGE — "all routes converge, all crews collide"
- **Traversal:** multiple routes from prior strata **funnel into one shared crest**.
- **Hazard:** environmental, plus the crowd itself.
- **Flashpoint:** **the deliberate pack-collision stratum** — placed roughly every N strata (a biome's
  "arena floor", §7) to *force* inter-crew brawls and re-bunch the race. This is where
  rubber-banding's "thrown Anchor = blue shell" (§5) most often fires.
- **Skill it rewards:** team-vs-team grab combat, target prioritization (whose Anchor is highest?).

> **Generator contract (`09`):** sequence archetypes for *rhythm*, not randomness — never two
> flashpoint-heavy strata back-to-back without a PUZZLE-ROUTE/calm stretch between; place
> CONTESTED-MERGE on a fixed cadence (milestone, §7); guarantee **multiple routes per stratum**
> (pillar 7) so crews can diverge horizontally and converge upward. Difficulty (gap sizes, hazard
> density, lift capacity) scales with **altitude / biome index**, deterministically from the seed.

---

## 4. The persistent two-way tower & the position-kill (Smash) model

(Pillars 4 & 7.)

### 4.1 Floors persist — both ways

Floors **do not** fragment, fall, or disappear. The tower is a **real, persistent, two-way shaft**:
- **Up** = wireframe "potential" that **coalesces** into solid floors as the crew approaches (§6).
- **Down** = floors you've passed **remain solid and reachable**; they **desaturate and fog with
  distance** but are *real places you can be knocked back into* (pillar 7). A thrown player/Anchor
  lands on a **real lower floor**, not into a procedural void (unless thrown past a kill-plane, §4.3).

This is a deliberate rejection of the earlier "fragment-and-fall" idea. It is *also* a netcode win:
because the world doesn't delete itself, AoI can stay centered on the Anchor (`05`) without the sim
having to reconcile vanishing geometry.

### 4.2 Falling: lethal regulars, durable Anchor

| Who | Small fall | Big fall | True death |
|---|---|---|---|
| **Regular player** | stagger / minor | **LETHAL** (down/kill, respawn via recall) | n/a — they respawn |
| **Anchor** | shrug | **NOT instakilled** — **altitude lost + brief downed/vulnerable beat** | **only** at a real kill-plane (§4.3) |

The punishment for a thrown Anchor is **position, not death** (the Smash model): you *lost altitude*
(your only score) and your Anchor is briefly **downed/vulnerable** — the crew scrambles to revive/
protect it while rivals pounce. This is the most dramatic, most contested moment in the game and the
diegetic core of rubber-banding (§5).

Regular-player death is *not* a big deal by design: they respawn at the **Recall Beacon** (Anchor's
height, §2.2-C) after a short delay. The stakes live in the **Anchor**, always.

### 4.3 You kill with POSITION (ring-out), not damage

There is **no HP-attrition kill** for the Anchor. Anchor true-death happens **only** by *putting it in
a place*:
1. **Off the very bottom** of the playable shaft (the bottom kill-plane), or
2. **Into a hazard kill-volume** (a crusher's lethal phase, spike pit, the void of a GAP-CROSSING).

So the entire combat game is **"move the rival Anchor to a lethal position"** vs **"keep your Anchor
out of lethal positions and high."** Damage/stagger exist only to *create the opening for a throw*,
never to whittle a kill. (See `02` for stagger/knockback values; they feed *positioning*, not a health
bar.)

> **Cross-cutting tension for `04` & `11`:** "Anchor-death behavior" is **lobby-tunable** (§6). Some
> lobbies want true-death-respawns-low (harsh), others want *no* true death at all (the Anchor only
> ever loses altitude). `04` owns how each mode interacts with the win conditions and leaderboards;
> this doc owns the default: **true death only at a kill-plane; thrown ≠ dead.**

---

## 5. Pure-race pressure: no chase, no turtle, no wall-of-death

(Pillars 5 & 6.) There is **no rising lava / wall-of-death**. Pressure is generated **laterally and
diegetically**, by four forces, none of which is a timer chasing you up:

1. **Rival Anchors are climbing.** Standing = relative height. If you stall, the leaderboard moves
   without you. The clock is *the other crews*, not a wall.
2. **Sabotage & interference** (pillar 9): rivals collapse your routes, steal puzzle objects, grab
   your thrower mid-windup, and — the big one — **throw your Anchor down**. You cannot ignore other
   crews when paces collide.
3. **Rubber-banding pull** (pillar 6, §5.2): trailing crews get *better tools and boons*, so a lead is
   never safe; the leader feels the pack closing.
4. **The Anchor can't turtle.** This is the structural anti-turtle (see §5.1).

### 5.1 How we prevent turtling *without* a chase

A pure race with no clock invites a degenerate strategy: *hunker on a safe floor and out-position
forever.* Four interlocking design facts make turtling **strictly losing**:

- **Standing is altitude, and altitude only goes up by climbing.** Sitting still = your number is
  frozen while rivals' numbers rise. There is no defensive way to *score*. (Contrast: in an HP/kill
  game you can farm kills from a turtle. Here kills *aren't* score — only your Anchor's height is.)
- **The Anchor is gap-locked and slow** (§2.1): the crew *must* keep engaging the traversal verbs to
  advance; you can't "park" the Anchor on the far side of a chasm and defend — it didn't get there
  without active escort, and it can't hold a forward position alone.
- **Recall is *to* the Anchor, never ahead** (§2.2-C): you cannot use recall to leapfrog the crew
  upward while the Anchor camps. Progress is gated on the *Anchor's* climb, period.
- **Rubber-banding rewards the chaser, not the camper**: a stalled-but-not-leading crew gets *worse*
  draws than the trailing crews who are actively moving (boon weighting is on *altitude rank*, and a
  camper bleeds rank as others pass). See `03`.

Net: the *only* path to winning is **moving your Anchor up**. Defense exists solely to **protect that
upward motion**, never as an alternative to it.

### 5.2 Mario-Kart rubber-banding (the "blue shell is diegetic")

(Pillar 6; tables/numbers owned by `03-progression-economy.md`.)

- **Trailing crews draw better boons & catch-up tools.** Boon-draft (§1 beat 6) weighting is a
  function of **altitude rank** and **gap-to-leader**: last place sees stronger options, more often.
- **A thrown-down Anchor *is* the blue shell.** When the leader's Anchor gets thrown down a few floors,
  that single event re-bunches the pack — it's the most powerful catch-up tool in the game and it is
  *earned by a skilled throw*, not handed out by a system. This is the elegant part: the comeback
  mechanic is a **player action**, so it never feels arbitrary/unfair the way a literal blue shell can.
- **Guardrails (aid comebacks without punishing skill):**
  - Rubber-banding tunes **boon quality/odds**, not raw speed — a trailing crew gets *better tools*,
    but still has to *play well* with them. No silent stat handouts.
  - The leader is never *slowed*; they're *contested*. The pressure is "rivals have good tools," not
    "you move through molasses."
  - A **floor on the boost:** catch-up scaling caps so a crew that's grossly outplaying everyone still
    pulls ahead; rubber-banding *re-bunches*, it doesn't *equalize*.
  - Intensity is **lobby-tunable** (§6) down to zero for competitive/"pure-skill" lobbies.

> **Cross-cutting tension for `03` & `04`:** the exact rubber-band curve is the single most
> balance-sensitive number in the game (comeback-feel vs. leader-frustration). `03` owns the curve;
> `04` owns whether ranked play clamps it. This doc only locks the *shape*: **rank-weighted boon
> quality + the thrown-Anchor diegetic shell, capped, never a speed handout.**

---

## 6. The coalescence is cosmetic; the floor is real (determinism note)

(Pillar 7; details in `06` & `09`.) Worth stating in the GDD because it constrains design:

- **Above:** floors hang as dotted/glowing **wireframe "potential"** and **resolve** dots→lines→
  panels→lit as climbers approach. Players **emerge up through** a coalescing floor.
- **Below:** floors **persist**, **desaturate & fog** with distance, remain solid/reachable.
- **The collision body exists the instant the stratum is seeded** (far below view-distance, from the
  deterministic seed). The wireframe→solid animation is **pure view-layer** and **must never gate
  collision or sim** (`05`, `06`). A scout who somehow reaches an "un-resolved" floor still stands on
  solid ground; it just hasn't *visually* lit up yet (the camera/AoI makes this essentially
  impossible, but the invariant holds).

This is the discipline that keeps spectacle and determinism compatible: **all view-layer is
determinism-safe; nothing in the look of the tower feeds back into the sim.**

---

## 7. Session shape & macro goal

### 7.1 Session shape (one run)
```
LOBBY (host sets knobs, §6) -> CREW FORM (3-5; flex for uneven lobbies)
   -> SPAWN at base floor (all Anchors at height 0)
   -> [ stratum cycle x N ]  (the §1 loop, climbing)
        - BIOME every N strata (theme + difficulty shift, §7.2)
        - MILESTONE floor on a cadence (§7.3)
   -> WIN CONDITION met (§8) -> RESULTS (final Anchor heights) -> leaderboard write (04)
```
No loading screens (pillar 7) — biome/milestone transitions are *in-world* coalescence events, not
loads.

### 7.2 Biomes (every N strata)
A **biome** is a run of strata sharing theme, palette, hazard families, and a difficulty band. Suggested
default **N = 8 strata per biome** (lobby-tunable). Each biome:
- raises the difficulty band (bigger gaps, denser hazards, tighter lift capacity — deterministic from
  altitude),
- reskins the coalescence palette (`06`),
- ends on a **CONTESTED-MERGE arena floor** (§3.5) — a guaranteed pack-collision before the next biome.

### 7.3 Milestone floors
On a fixed cadence (suggested every biome boundary, and a "deep" milestone every 3 biomes):
- a wider, safer **landing** (extended boon draft, regroup, the calmest beat),
- a **checkpoint** for recall/respawn floor-raising (so a thrown player doesn't fall *forever* in long
  runs — the recall-respawn floor never drops below the last milestone),
- a **leaderboard ping** (current standings surfaced, `07`).

### 7.4 Macro goal
- **Within a run:** get your Anchor highest by the win condition (§8).
- **Across runs (meta):** **leaderboards** (highest Anchor reached, fastest-to-milestone-K, etc.) and
  **seasons** — owned by `04-competitive-structure.md`. The endless variants make "personal best
  altitude" a persistent chase. No power-progression that breaks match fairness (cosmetics/ranks only;
  `03`/`04`).

---

## 8. Win conditions (all three lobby-tunable) + the full knob set

(Pillar 11. `04` owns ranked rules / leaderboard mapping; this doc defines the modes and the knobs.)

### 8.1 The three win conditions (host picks one)

1. **RACE-TO-HEIGHT.** First crew whose Anchor crests a **target altitude H** wins. (Sprint feel;
   clean for competitive.) `04` defines H per biome/length.
2. **ENDLESS / HIGHEST-STANDING.** Play to a **time or stratum cap**; **highest Anchor** at the cap
   wins. (Marathon feel; best with rubber-banding + leaderboards.) If using a *time* cap, the timer is
   a transport-layer/wall-clock **match clock only** — it **never enters the sim**; the sim end is
   triggered by a replicated "match over" intent at a tick boundary (`05`).
3. **ROUNDS-TO-SUMMIT-THEN-NEW-TOWER.** Best-of-K short towers each capped by a **summit floor**;
   first crew to the summit wins the round; most rounds wins. (Set/match feel; good for tournaments.)

### 8.2 The full per-lobby knob set

Grouped; defaults in **bold**. `04` validates which combinations are legal for ranked.

**Match / win**
- `winCondition`: **race-to-height** | endless-highest | rounds-to-summit
- `targetHeight H` (race mode): low(~24 strata) | **mid(~40)** | high(~64)
- `matchCap` (endless): time(8/**12**/20 min) | strata(**40**/64/100)
- `rounds` (rounds mode): **3** | 5 | 7; `summitFloor` per round: short | **mid** | tall

**Crew**
- `crewSize`: 3 | 4 | **5**; `flexUneven`: **on** (auto-balance ±1 for odd lobbies) | off
- `crewCount`: **2** | 3 | 4 (mesh ≤ ~8 players total → see `05` transport caps)

**Lethality & Anchor death** (pillar 4 / §4)
- `regularFallLethal`: **on** | off(stagger-only)
- `anchorTrueDeath`: kill-plane-only **(default)** | on-big-fall(harsh) | never(altitude-only)
- `anchorRespawnFloor` (if true-death on): last-milestone **(default)** | base | dropN
- `downedBeatLength`: short | **mid** | long (how long a thrown Anchor stays vulnerable)

**PvP spice** (pillar 9)
- `pvpIntensity`: low | **mid** | high (scales sabotage availability, grab durations, throw force on
  rival Anchors — *not* on your own crew's escort)
- `friendlyFire`: **off** | on (your own throws can still fumble your Anchor regardless — that's
  escort risk, not FF)

**Collapse / pressure knobs** (pillar 5/6)
- `rubberband`: off | **mid** | high (boon-quality curve & gap-to-leader weighting; `03`)
- `hazardDensity`: low | **mid** | high; `liftCapacity`: tight | **mid** | loose
- `gapScale`: small | **mid** | large (Anchor-impassable threshold severity)

**Anchor / recall**
- `recallCooldown`: 20 | **30** | 45 s; `beaconReplantCooldown`: **45** | 60 s
- `recallChannel`: **0.75 s** | 1.5 s (interrupt window)
- `anchorSpeedPct`: 55 | **60** | 65; `anchorCarryEncumbrancePct`: 40 | **45** | 50

**Tower / generation** (`09`)
- `biomeLength N`: 6 | **8** | 12 strata; `seed`: **random** | fixed(for rematches/tournaments)
- `routesPerStratum`: 2 | **3** | 4

> **Cross-cutting note for `04`:** every knob here is **replicated lobby config**, locked at match
> start and hashed into the determinism check-frame seed (`05`). No knob may change mid-match. `04`
> defines the **ranked preset** (a single locked combination: race-to-height mid, rubberband off,
> friendlyFire off, anchorTrueDeath kill-plane-only) so ladder games are comparable.

---

## 9. Resolving "race vs. co-op": the Anchor rule already does it

The central design risk in any escort-race is that **racing** (compete) and **co-op** (cooperate) pull
players in opposite directions and the game splits into two incoherent halves. **The Anchor rule
(pillar 1) collapses the two into one shape.** Why it works:

1. **Intra-crew, the objective is singular and shared.** A crew's *entire* standing is *their Anchor's
   height* — there is **no individual score** to chase. A Runner cannot "pad stats," a Bulwark cannot
   "farm kills" for personal credit. The *only* thing any crew member can do to win is **raise the same
   Anchor**. So co-op isn't a *mode* layered on a competitive game; it's the *only* rational behavior.
   Everyone on the crew literally wants the same number to go up. (Overcooked-clean: one shared goal,
   four clean verbs.)

2. **Inter-crew, competition is the *same verb set* aimed outward.** The four verbs you use to *help*
   your Anchor (RUSH/GRAB/THROW/STRUGGLE) are the *exact* verbs you use to *hurt* a rival Anchor
   (pillar 9: "lots of ways, but just like any other player"). Co-op and competition are **mechanically
   identical operations with the target flipped.** There's no context-switch, no separate "PvP mode" —
   you're always doing the same thing, just deciding *which Anchor* you're acting on.

3. **The win move is positional, not attritional** (§4). Because you win by *throwing the rival Anchor
   down*, aggression is **about altitude** — the same currency as cooperation. Helping your Anchor up
   and knocking theirs down are **two faces of one scoreboard**. There is never a moment where
   "playing the objective" and "fighting rivals" diverge: both are *"change relative Anchor heights in
   my favor."*

4. **Rubber-banding keeps both alive late.** Because a thrown-down Anchor re-bunches the pack (§5.2),
   the *cooperative* phase (re-escorting your downed Anchor) and the *competitive* phase (defending it
   from pouncing rivals) happen **simultaneously, on the same body** — the climax of the rhythm is
   co-op and competition fused.

So we do **not** need a separate mechanic to "balance" race against co-op. The Anchor rule makes them
the **same axis**. The risk is *not* that they conflict; the risk is purely *execution* — keeping the
flashpoint rhythm (§1) frequent-but-not-constant so neither phase starves the other. That is a
*pacing/generation* problem (`09`), already addressed in §3's sequencing contract — not a fundamental
design tension.

---

## 10. Open questions / things downstream docs must decide

- **Co-throw windup vs. solo-throw:** does a 2-person co-throw of the Anchor warrant its own timing
  mini-interaction, or just a force multiplier? (→ `02`, `07`.)
- **Catch-window feel:** is the receiver's catch an active timed GRAB or an auto-catch with a quality
  gradient? (→ `02`, `07`.) GDD intent: **active timed GRAB** (more skill, more drama).
- **Rubber-band curve shape:** linear vs. eased on gap-to-leader. (→ `03`.)
- **Anchor-as-puzzle-weight legality:** can the Anchor *itself* be the heavy object on a pressure plate
  in PUZZLE-ROUTE (§3.4)? GDD intent: **yes**, it's a great calm-beat use — but it parks the Anchor,
  so `09` must ensure it's never the *only* solution (anti-turtle, §5.1).
- **Grab-train / chain limits:** how long can a grab train get before STRUGGLE/Bulwark guarantees a
  break? (→ `02`.)

---

## 11. Summary of locked decisions (quick reference)

- **Standing = your Anchor's height; nothing else is scored.** Co-op and competition are one axis (§9).
- **Anchor = heavy, slow, gap-locked, fall-durable, *active*; plants the Recall Beacon (to-Anchor,
  never ahead).** Escort primitives: **carry, throw-across, recall** (§2).
- **Loop:** approach → coalesce → co-op traverse/carry → flashpoint clash → crest → draft boon, at
  **45–90 s/stratum**, calm→panic→calm (§1).
- **Five stratum archetypes:** gauntlet, chokepoint-lift, gap-crossing, puzzle-route, contested-merge —
  each = traversal + deterministic hazard + a built-in flashpoint (§3).
- **Persistent two-way tower; position-kill (Smash) model:** thrown ≠ dead; Anchor true-death only at a
  kill-plane; regulars lethal-fall + recall-respawn (§4).
- **Pure race, no chase, no turtle:** pressure = rival climb + sabotage + rubber-banding; anti-turtle
  is structural (altitude-only score + gap-locked Anchor + to-Anchor recall) (§5).
- **Three lobby-tunable win conditions + full knob set, locked at match start & hashed into the
  determinism seed** (§8).
- **All view-layer (coalescence/fog) is determinism-safe; collision bodies exist from seed-time** (§6).
