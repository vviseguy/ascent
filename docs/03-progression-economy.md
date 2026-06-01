# 03 — Progression, Economy & Rubber-Banding

> Status: v3. Authoritative for in-run boon economy, the Mario-Kart rubber-banding math, and
> between-run meta-progression. Built on the v3 vision bible (pillars 1, 5, 6, 8, 11). Cross-refs:
> `01-game-design.md` (loop/pacing), `02-roles-anchor-verbs.md` + `02-roles-traversal-combat.md`
> (verbs, roles, mass hierarchy), `04-competitive-structure.md` (win conditions, lobby knobs),
> `05-netcode-architecture.md` (determinism, seeded PRNG, tick clock). Any number here is a
> **tuning default**, not a constant of nature — all live in `config/tuning.ts` (see §8).

---

## 0. Design constitution (the non-negotiables this doc must honor)

These follow directly from the bible and constrain every decision below:

- **C1 — The Anchor is the only scoreboard.** A crew's standing is its Anchor's height. Therefore
  *every* progression reward and *every* rubber-band input is computed from **Anchor altitude**,
  never from kills, assists, or individual play. (Pillar 1)
- **C2 — Power is shared, never personal.** Boons are drafted *by the crew, for the crew*. There is
  no per-player loadout that travels between runs as raw stat. (Pillar 1, pillar 8 interdependency)
- **C3 — Physical/escort fantasy only.** Boons deepen grab / throw / carry / build / break / route /
  Anchor-protection / object-throw. There are **no anti-NPC, no DPS, no "damage" boons** because
  there are no NPCs and you kill with *position*, not health. (Pillars 2, 3, 4)
- **C4 — Catch-up, not handicap.** Rubber-banding aids comebacks for the *trailing* crew without
  nerfing or insulting the *leading* crew. The blue-shell is **diegetic** (a thrown-down Anchor),
  and the boon system only *complements* it. (Pillar 6)
- **C5 — Anti-grind meta.** Between runs you unlock *breadth and identity* (roles, boon variety,
  cosmetics, crew flair) — **never vertical power**. A returning veteran and a first-timer have the
  same ceiling in any given match. (Pillar 6 guardrail, free-to-play hygiene)
- **C6 — Determinism is sacred.** Every random draw uses the seeded PRNG and the shared tick
  counter; never `Math.random()`, never wall-clock. Draft resolution is a pure function of
  `(seed, tick, crewState, towerState)`. (Pillar 12, "Time/clock")

---

## 1. The currency model: there is (almost) no currency

We deliberately reject a gold/XP economy *inside a run*. A floating currency invites hoarding,
shop-camping, and per-player accumulation — all of which fight C1/C2 and add a UI surface nobody
asked for. Instead the in-run economy is a **draft economy** with exactly one soft currency that is
*spent automatically by climbing*:

- **ALTITUDE is the currency.** You do not collect coins; you *gain floors*, and floors trigger
  drafts. This keeps the only number that matters (height) identical to the only number that buys
  things. No second economy to balance against the first.
- **MOMENTUM (a tiny, visible meter) is the only other resource.** Momentum is a 0–100 per-crew bar
  that fills from forward progress and crew teamwork, drains from stalls/wipes, and is *spent* on
  one thing: **rerolling or banking a boon pick** (see §3.4). Momentum is the "skill expression" lever
  inside the draft so good crews shape their draft, while the *deficit* lever (rubber-banding, §4)
  shapes the trailing crew's draft. The two levers are orthogonal on purpose (see §4.5).

Everything else — "pickups" in the world — are **physical objects** (crates, fragments, built
blocks), and they are *not* economy; they are throwables governed by `02-roles-traversal-combat.md`.
A health pack is a Mender ability, not a shop item.

---

## 2. Boon draft — cadence & structure

### 2.1 When drafts fire (cadence at milestone floors)

The tower is divided into **STRATA of 10 floors**. A draft fires for a crew when **their Anchor**
first reaches a **stratum boundary** (floor 10, 20, 30, …). Cadence is *per-crew and Anchor-gated*,
which is the whole point — it is automatically self-balancing for pace:

- A leading crew hits boundaries sooner → drafts sooner → but from a **lower-deficit pool** (§4).
- A trailing crew hits boundaries later in wall-time → but each draft is **richer** (§4).
- A crew whose Anchor gets thrown *down* past a boundary it already claimed does **not** re-draft
  on the way back up (boundaries are claimed once, tracked as `crew.maxStratumClaimed`). This stops
  yo-yo farming and keeps drafts ~aligned with genuine progress.

Spacing of ~10 floors targets a draft roughly **every 60–110 s** of climb at default pacing,
landing one draft inside each "calm → flashpoint → calm" macro-beat (pillar 5). First draft is at
floor 10 (not floor 0) so the opening minute is pure traversal tutorialization with no menu.

> **Determinism note:** the *offer* (which N boons appear) is drawn when the boundary is claimed,
> from `prng(seed, "draft", crewId, stratum)`. The *pick* is a crew input fed through the normal
> input pipeline. No wall-clock, no host-special-casing. See §6.

### 2.2 What a draft looks like (crew-shared, one pick)

A draft presents **3 boon cards** (rarity-weighted, §2.3) and the crew makes **ONE shared pick**.
Crew-shared, not per-player, because of C2. Resolution rule (decisive, not a menu):

- Any crew member may "nominate" a card by pinging it (lightweight, uses the existing ping verb).
- The pick **locks** when either (a) a simple majority of *living, non-downed* crew members ping the
  same card, or (b) a **6-second draft timer** (360 ticks @ 60 Hz) elapses, in which case the
  **Anchor's** current nomination wins (the Anchor literally has the deciding vote — diegetically
  fitting: it's their tower standing). If the Anchor is downed/dead at timeout, highest-nominated
  card wins; ties broken by `prng(seed,"drafttie",stratum)`.
- **Drafting does not pause the sim.** The tower keeps moving; rivals keep climbing. This preserves
  pillar 5 tension — a draft is a flashpoint decision under live pressure, not a safe timeout. The
  card UI is a diegetic overlay that does not stop physics.

One pick per draft (not pick-3-of-3) keeps decisions sharp and keeps total boons per run bounded
(~6–10 across a tall run), so power creep stays legible and the netcode state for "active boons"
stays tiny (a bitset per crew, see §6).

### 2.3 Rarity tiers & weighting

Four tiers. Weights are the **base** distribution at zero deficit; §4 *shifts* this distribution for
trailing crews. Rarity is about **swinginess and build-defining-ness**, not raw power — a Common is
not "weak," it is *reliable and narrow*; a Legendary is *rare and run-shaping*.

| Tier | Color | Base weight (per card slot) | Character |
|------|-------|-----------------------------|-----------|
| Common | Slate | 58% | Quality-of-life, single-verb buffs, low variance |
| Rare | Teal | 30% | Meaningful crew-synergy or role-deepening |
| Epic | Violet | 10% | Build-defining, changes how a verb is used |
| Legendary | Amber | 2% | Run-shaping, often with a real downside/cost |

Per draft we roll 3 independent card slots, but with a **no-dup-and-no-all-common** guarantee: dedupe
within the offer, and if all 3 land Common, the lowest-rolled slot is upgraded one tier
(deterministically via the same PRNG stream). This guarantees every draft offers at least one
"interesting" card without inflating average power.

### 2.4 Boon stacking & caps

- Boons **stack additively within the same effect family**, but each family has a **soft cap** past
  which extra copies convert to a flat fallback (e.g., a 4th "+throw force" copy gives a small flat
  bonus instead of another %). This kills degenerate single-stat snowballs (C4-adjacent: protects the
  leader's *opponents* from being lapped by a stacked leader, and protects the leader from feeling a
  trailing crew got a broken stack).
- A crew may hold at most **12 active boons**; beyond that, drafting prompts a *replace* choice. In
  practice runs rarely exceed ~10, so the cap is a safety valve.

---

## 3. The boon pool (~24 concrete boons, all v3-fit)

Organized by **intent axis** (the bible asks for role-deepening vs role-bending vs crew-synergy).
Every boon maps to a physical/escort verb (C3). Format:
`NAME (Tier) [Family] — effect. why it fits.`

Numbers reference the verb spec in `02-roles-traversal-combat.md` (grab time, throw force units = TFU,
encumbrance %, build charges, etc.). All are tuning defaults.

### 3.1 Role-DEEPENING (make your main role's verbs better)

1. **Iron Grip (Common) [grab]** — Bulwark grab-break is 25% faster; your grabs cost 1 fewer struggle
   tick to maintain. *Deepens the anti-grab specialist; pure tempo, no control-lock (pillar 2).* 
2. **Sure Hands (Common) [carry]** — Carrying a teammate (not the Anchor) reduces your encumbrance
   penalty by 30%. *Mender/Bulwark carrying the wounded stays mobile.*
3. **Quarry Sense (Common) [break]** — Breaker sees destructible-terrain integrity + the fastest break
   point highlighted; breaks deal +1 hit. *Deepens shortcut-opening.*
4. **Scaffold Surplus (Rare) [build]** — Engineer holds +1 build charge and ramps last 50% longer
   before decay. *Deepens temporary-terrain identity.*
5. **Spotter's Mark (Rare) [route]** — Runner's hazard tags persist 2x longer and reveal one extra
   floor of wireframe resolution ahead (pillar 7 visual tie-in). *Deepens scouting.*
6. **Lifeline Reserve (Rare) [protect]** — Mender's revive on the **Anchor** is 40% faster and grants
   the Anchor 2 s of throw-immunity on stand-up. *Deepens the keep-the-VIP-alive job; directly serves
   the downed-Anchor vulnerable beat (pillar 4).* 
7. **Bulwark Wall (Epic) [protect]** — Bulwark can plant a 2 s **body-anchored block** that body-blocks
   grabs aimed at the Anchor in a small arc (the body-block verb, made spatial). *Build-defining for
   Anchor-guard play.*
8. **Demolition Cascade (Epic) [break]** — A Breaker break can chain to one adjacent destructible tile;
   collapsing a *rival* route segment briefly staggers anyone standing on it. *Route-sabotage, no
   damage — staggers, doesn't deal HP (C3).* 

### 3.2 Role-BENDING (gain a secondary verb / cover a gap)

9. **Improviser (Common) [object-throw]** — Any non-builder can pick up Engineer blocks and throw them
   for +20% TFU. *Lets a Runner weaponize the Engineer's output; bends toward object-throw.*
10. **Field Patch (Common) [protect]** — Non-Menders gain a single-charge shield-bump (small, slow
    recharge) usable on the Anchor only. *Bends a Bulwark/Runner toward minor lifeline duty.*
11. **Long Arms (Rare) [grab]** — +25% grab reach for whoever drafts the family-tag; turns a Runner
    into a snatch-and-yeet harasser of rival Anchors. *Bends Runner toward grab harassment (pillar 9).* 
12. **Pack Mule (Rare) [carry]** — A Runner can carry the **Anchor** at only the *teammate* encumbrance
    rate (not the heavy-Anchor rate) for 4 s, then it snaps to full. *Bends a fast role into emergency
    Anchor-ferry across one gap; the timer keeps it from being a permanent answer (pillar 2c).* 
13. **Field Forge (Epic) [build]** — Non-Engineers can place a single one-shot **bridge plank** (one
    charge, no decay management). *Bends any role toward emergency traversal so a crew without an
    Engineer isn't gap-locked.*
14. **Counter-Snare (Epic) [grab]** — When *you* are grabbed, a successful struggle-break reverses into
    an auto-grab on the attacker for 0.5 s (free counter). *Bends anyone into a grab-duelist; rewards
    timing, punishes greedy grabbers (pillar 2d, grab-as-prey).* 

### 3.3 Crew-SYNERGY (only good because teammates exist)

15. **Relay Chain (Common) [carry]** — When a teammate throws another teammate, the thrown ally gets
    +15% throw distance and lands without stagger. *Makes the hand-teammate-up combo cleaner.*
16. **Shared Footing (Common) [route]** — Standing within 4 m of your Anchor gives the whole nearby
    crew +10% climb speed. *Rewards clustering around the VIP (also tightens the AoI cluster the
    netcode wants, pillar 12 — nice alignment).* 
17. **Spotters & Movers (Rare) [route]** — A hazard tagged by the Runner that a Breaker then clears
    refunds the Breaker a partial cooldown. *Two roles, one combo loop.*
18. **Lift Sync (Rare) [build]** — When 2+ crew stand on an Engineer ramp/lift, it moves 40% faster.
    *The lift becomes a crew set-piece, not a solo tool.*
19. **Catcher's Mitt (Rare) [protect]** — Any crew member directly below a **falling teammate or the
    falling Anchor** auto-cushions the catch (no fall damage to the faller, small stagger to catcher).
    *The "catch the fall" fantasy, generalized; central to surviving the thrown-down-Anchor swing
    (pillar 4 / §5).* 
20. **Convoy Doctrine (Epic) [protect]** — While **all living crew** are within 8 m of the Anchor, the
    Anchor gains +30% fall-durability and shrugs the first grab attempt each second. *A rolling
    fortress — strong, but demands the *whole* crew bunch up and stop doing anything else (real
    opportunity cost; pillar 5).* 
21. **Throw Line (Epic) [object-throw]** — When two crew throw objects at the same target within 0.5 s,
    the second hit's knockback is doubled (combo'd shove). *Coordinated sabotage of a rival Anchor near
    a ledge; pure position-kill, no damage (C3, pillar 9).* 

### 3.4 ECONOMY / DRAFT-shaping boons (rare, touch the meta-layer)

22. **Momentum Engine (Rare) [economy]** — Crew Momentum (§1) fills 25% faster. *Buys more rerolls/banks
    over a run; a "draft build."*
23. **Bankroll (Epic) [economy]** — The crew may **bank one drafted card** to a "reserve slot" and play
    it later instead of picking now. *Adds a real timing/strategy layer to the draft; one reserve max.*

### 3.5 Legendaries (rare, run-shaping, always with a cost) — 2 examples

24. **The Tether (Legendary) [protect/route]** — A permanent soft-link between two chosen crew (often a
    carrier + the Anchor): they share a small velocity assist (the trailing one is gently pulled along
    a gap) **but** also share fall-fate — if one is thrown off, the linked partner takes a brief stagger.
    *Run-shaping convoy tech with a genuine downside (pillar 6's "downside" mandate).* 
25. **Second Summit (Legendary) [economy/comeback]** — Once per run, when your **Anchor is downed**, the
    crew may instantly recall the *entire crew* to the Anchor and grant 3 s of group throw-immunity.
    *The ultimate scramble-saver around the most dangerous beat; one-shot, Anchor-gated, and only
    *useful* when you're already in trouble — comeback-flavored without being a leader-punish.* 

> Pool size & growth: ship with **~28 boons** (the 25 above plus 3 held back for variety), unlocking
> *more pool variety* via meta-progression (§7), never more *power*. Target a deployed pool of ~40 by
> content-complete, drawn from the same intent axes.

---

## 4. Mario-Kart rubber-banding — the math

This is the heart of the doc. We make the *trailing* crew's draft richer and hand them gentle catch-up
tools, with hard guardrails so it (a) never nerfs the leader and (b) never lets a worse crew faceroll a
better one. The diegetic blue-shell (a thrown-down Anchor, §5) does the *violent* re-bunching; the boon
math does the *gentle, continuous* re-bunching.

### 4.1 The one input: normalized deficit `d`

Everything keys off a single scalar per crew, recomputed each draft (and continuously for the meters):

```
leadHeight   = max over all crews of crew.anchorHeight          // floors
crewHeight   = this crew's anchorHeight
rawDeficit   = leadHeight - crewHeight                          // floors behind the leader, >= 0
spread       = max(leadHeight - lowestAnchorHeight, 1)          // current pack spread, >=1 to avoid /0
d            = clamp(rawDeficit / DEFICIT_SCALE, 0, 1)          // normalized 0..1
```

- `DEFICIT_SCALE` (default **30 floors** = 3 strata) is the deficit at which catch-up saturates. Beyond
  3 strata behind, you get the *max* help — but not more, so a hopeless crew can't snowball boons into
  a runaway (anti-degenerate).
- We normalize by an **absolute scale**, not by `spread`, on purpose: normalizing by spread would make
  help *vanish as the leader pulls away*, which is backwards. Absolute scale means "30 behind = max help"
  regardless of how the rest of the pack is doing. The leader's own draft always uses `d = 0`.

### 4.2 The curve: gentle then firm (smoothstep, not linear)

We map `d` through a **smoothstep** so small deficits give *almost no* help (you're basically tied —
help would feel unfair to the leader, C4) and large deficits give meaningful help, but it flattens at
the top (no runaway):

```
// classic smoothstep 3d^2 - 2d^3, then a floor/ceiling on the catch-up factor
s        = d * d * (3 - 2 * d)                  // 0..1, S-curved
catchup  = CATCHUP_MIN + (CATCHUP_MAX - CATCHUP_MIN) * s
```

Defaults: `CATCHUP_MIN = 0.0`, `CATCHUP_MAX = 1.0`. So `catchup` is itself 0..1, but S-shaped: at
`d=0.1` (3 floors behind) `catchup≈0.028` (negligible); at `d=0.5` (15 behind) `catchup=0.5`; at
`d≥1.0` (30+ behind) `catchup=1.0` (saturated).

This `catchup` scalar drives **three** outputs (§4.3). The S-curve is the key guardrail: the leader and
near-peers (small `d`) experience an essentially *flat, fair* draft; only genuinely-behind crews see the
swing.

### 4.3 What `catchup` actually buys (three channels, all "draws better boons")

The bible says rubber-banding = "trailing crews draw better boons & catch-up tools." We split that into
three knobs, each a pure function of `catchup`:

**(A) Rarity uplift — the trailing crew draws from a better-weighted pool.** We shift the §2.3 base
weights toward higher tiers proportional to `catchup`:

```
// move probability mass upward by `uplift` = catchup * RARITY_UPLIFT_MAX
uplift = catchup * 0.18                                  // default max +18% mass shift
P(Common)    = base.Common    - uplift                   // 0.58 -> as low as 0.40
P(Rare)      = base.Rare      + uplift * 0.55            // 0.30 -> up to ~0.40
P(Epic)      = base.Epic      + uplift * 0.35            // 0.10 -> up to ~0.16
P(Legendary) = base.Legendary + uplift * 0.10            // 0.02 -> up to ~0.04
// renormalize, clamp each to [0,1]
```

So a crew 30+ floors behind roughly *doubles* its Epic odds and *doubles* its Legendary odds, while a
near-tied crew sees the normal table. Note Legendary tops out around 4% even at max deficit — comebacks
are *enabled*, not *handed* (C4).

**(B) Extra card slot.** At `catchup ≥ 0.5`, the draft shows **4 cards instead of 3** (more selection =
softer help, the most "fair-feeling" channel because the crew still has to *choose well*). At
`catchup ≥ 0.85`, the crew also gets **one free reroll** of the offer that draft.

**(C) Catch-up boon eligibility.** A small set of boons is tagged `comeback`. These are **only offered
when `catchup ≥ 0.4`** and are weighted up by `catchup`. They are the "tools," e.g.:

- **Updraft (comeback Rare) [route]** — for 20 s, the crew's *next* climb/jump per person gets a free
  vertical boost (one big assisted move). *Re-close a vertical gap fast.*
- **Slipstream (comeback Rare) [route]** — the crew gains climb speed scaled by *live* deficit (recomputed
  each tick: `+ catchup * 12%`), decaying to 0 as you catch up. *Self-extinguishing — it literally turns
  off when you're no longer behind, the cleanest anti-snowball.*
- **Grapnel Recall (comeback Epic) [protect]** — reduces RECALL-BEACON cooldown by 40% while behind.
  *More frequent rally to the Anchor when scrambling.*
- `Second Summit` (§3.5 #25) is also `comeback`-tagged.

`Slipstream` is the model we prefer for all continuous catch-up: **deficit-scaled and self-canceling**,
so it is mathematically impossible for it to push a crew *ahead* of the leader on its own.

### 4.4 Guardrails (explicit, because this is where rubber-banding earns hate)

1. **Never touch the leader.** The leader (and anyone within `LEAD_DEADZONE = 2` floors of the top)
   computes `d=0`, gets the base table, 3 cards, no comeback pool. The leader is *never* slowed,
   debuffed, or shelled by the system. All pressure on the leader comes from *other players*, per
   pillar 5 ("no rising wall-of-death"). The leader can *feel* great about leading.
2. **Self-extinguishing continuous effects.** Any *always-on* catch-up effect (Slipstream, Shared
   Footing-style) scales by *live* `catchup` and hits 0 at parity. One-shot tools (Updraft) are
   spent, not permanent. So catch-up can *close* a gap but cannot *open* one.
3. **Skill still dominates within a tier.** Catch-up shifts *odds and selection*, not *execution*. A
   trailing crew that drafts a Legendary still has to grab, throw, and climb well to use it. The math
   gives *opportunity*, not *outcome* (C4). Empirically tune so that catch-up alone closes at most
   ~40–50% of a gap per stratum if the trailing crew plays *as well* as the leader; if the leader keeps
   outplaying, the gap holds.
4. **Saturation cap.** `d` clamps at 1.0 (`DEFICIT_SCALE`). A crew 80 floors behind gets exactly the
   same help as one 30 behind — no exponential pity that turns a blowout into a coin-flip.
5. **No deficit-farming.** Because `d` reads *current* Anchor height and drafts are claimed-once
   (§2.1), you cannot intentionally fall to juice your draft then recover — falling *also* loses you
   the altitude that is the literal scoreboard. The cost always exceeds the boon edge.
6. **Lobby-tunable intensity.** `RUBBERBAND_INTENSITY ∈ {off, mild, default, spicy}` scales
   `RARITY_UPLIFT_MAX`, the comeback-pool weight, and the `Slipstream` coefficient (the host knob from
   pillar 11). `off` = pure-skill mode (drafts identical for all). `spicy` ≈ 1.6× the multipliers for
   party lobbies. The *guardrails* (leader untouched, self-extinguishing) hold at every setting.

### 4.5 Why two orthogonal levers (Momentum vs Deficit)

Momentum (§1, skill/teamwork-driven) and Deficit (this section, standing-driven) are **independent
axes** so they don't double-count:

- A **leading crew playing well** has high Momentum (good drafts via rerolls/banks) but `d=0` (no
  catch-up). They earn draft *control*, not draft *power*.
- A **trailing crew playing well** has high Momentum *and* high `catchup` — the strongest drafts in the
  game, which is correct: they're behind *and* skilled, exactly the crew a comeback system should
  reward.
- A **trailing crew playing badly** has low Momentum but high `catchup` — they get richer *offers* but
  little ability to *shape* them, so they still can't faceroll. The system helps the hopeless without
  rewarding the careless.

This separation is the precise answer to "aids comebacks without punishing skill": skill lives in the
Momentum axis (and in execution), pity lives in the Deficit axis, and they multiply, they don't cancel.

---

## 5. The diegetic blue-shell: thrown-down Anchor as natural rubber-banding

Per pillar 6, the *primary* re-bunching mechanism is **not** a boon — it's the act of throwing a rival
Anchor down the tower. This section states how that already rubber-bands and how §3–4 *complement* it
rather than duplicating it.

### 5.1 Why a thrown-down Anchor is the blue-shell

- The scoreboard **is** Anchor height (C1), so knocking an Anchor down N floors is *directly* a score
  swing of N — no abstraction, no item. The leader is most exposed precisely *because* they're highest
  and most isolated from the pack (pillar 10 soft-separation): leading puts your Anchor out front where
  rivals who *do* catch up at a flashpoint can yeet it.
- It's **lethality-bounded** by pillar 4: the Anchor is fall-durable, so a throw costs *altitude + a
  vulnerable downed beat*, not an instakill (unless rung-out into a true kill-plane). So the swing is
  big but recoverable — exactly the Mario-Kart "blue shell re-bunches, doesn't eliminate" feel.
- It is **earned, not random.** Unlike a literal blue shell, it requires a crew to *physically reach,
  grab, and throw* a heavy Anchor against the 5 grab-pressures (pillar 2). High skill floor → it never
  feels arbitrary to the leader ("I got out-coordinated at the chokepoint" beats "the game shelled me").

### 5.2 How the boon system complements (not duplicates) it

- **Defense against the shell is draftable, on the leader's side too:** `Convoy Doctrine`, `Bulwark
  Wall`, `Catcher's Mitt`, `Lifeline Reserve` all *blunt* the thrown-down swing. The leader isn't
  helpless against re-bunching — they can *invest* their (base-rate) drafts in Anchor protection. This
  is the leader's counter-play, and it keeps leading a *skill* expression.
- **Offense toward the shell is draftable, on the trailing side:** `Long Arms`, `Throw Line`,
  `Counter-Snare`, `Pack Mule` make it *easier to set up* the grab-and-throw on a rival Anchor. Trailing
  crews (higher `catchup`) draw these more, so the system *amplifies the diegetic shell* instead of
  replacing it with a magic item.
- **Recovery from being shelled is draftable:** `Second Summit`, `Grapnel Recall`, `Catcher's Mitt`
  shorten the vulnerable downed beat and re-rally the crew. Again, weighted toward trailing crews.

So the three-card draft *feeds the physical blue-shell loop* from both sides: the gentle boon math (§4)
sets the table, and the violent physical throw (§5) is the payoff. They are the same loop at two
timescales.

### 5.3 Anti-pile-on guardrail (so the shelled crew isn't griefed to oblivion)

When an Anchor is downed by a throw, it gets a short **invulnerable-to-grab window on stand-up**
(default 1.5 s, extended by `Lifeline Reserve`) and a small recall-cooldown refund. This prevents an
infinite grab-train on a single Anchor (also a netcode mercy — bounds the grab-constraint chain length,
pillar 12). Rival crews get the altitude swing, not a free kill-loop.

---

## 6. Determinism & netcode shape of the economy

(Consistency check with `05-netcode-architecture.md` / pillar 12.)

- **Draft offers** are pure: `offer = drawOffer(prng(seed,"draft",crewId,stratum), tier-table(d,intensity))`.
  Because `d` is computed from replicated Anchor heights and `intensity` is a lobby constant, every peer
  derives the identical offer with no message — only the *pick input* travels (one byte: card index +
  reroll/bank flag), through the normal input pipeline.
- **Active boons** are a compact **bitset per crew** (≤ ~40 boons → a `Uint64` or two), plus a tiny
  struct for stack-counts (one `Uint8` per family) and one-shot/charge counters. Trivial to checksum in
  the per-frame state hash and to roll back.
- **Continuous effects** (Slipstream, Shared Footing) read `catchup`/distance each tick from already-
  replicated state — they add *no* new replicated fields, just derived modifiers in the sim step. This
  is critical: catch-up must not introduce a non-deterministic or out-of-band data path.
- **Momentum** is a single replicated `Uint16` per crew, integrated deterministically from sim events
  (floors gained, catches made, wipes) — never from wall-clock or local FPS.
- **No host-special-casing:** drafts resolve identically on host and peers; the host does not "roll for"
  anyone. This matches the frequency reuse note (host-authoritative *reducer*, but here the draw is a
  pure function so even host migration mid-draft is safe — the new host recomputes the same offer).

---

## 7. Meta-progression (between runs) — anti-grind, breadth not power

Hard rule (C5): **nothing unlocked between runs makes you numerically stronger in a match.** Two
veterans and two first-timers in the same lobby have the same power ceiling. What you unlock is
*breadth, identity, and expression*. Progress is driven by **Ascent Marks** (a cosmetic XP), earned per
run from *participation and height milestones*, with a flat curve (no exponential grind; see §7.4).

### 7.1 Unlock: ROLES (breadth, gated then free)

- New players start with **Runner, Bulwark, Mender** + **Anchor** available (covers the core escort
  loop). **Engineer** and **Breaker** unlock at the first and second meta-tiers (a couple of runs each).
  This is *onboarding pacing*, not a power gate — all six are equally strong; we just don't dump six
  identities on a first-timer. After ~3–4 runs every role is open.
- **Lobby override:** the host can flip "all roles unlocked" for any lobby (pillar 11), so unlock pacing
  *never* blocks a friend group. Meta-locks are personal-account onboarding only.

### 7.2 Unlock: BOON-POOL VARIETY (breadth, never power)

- You begin with a **core boon pool** (~16 of the ~28). Additional boons unlock into *your personal
  offer pool* as you play. **Key fairness rule:** a *match* uses the **intersection-or-union** of crew
  pools per the lobby setting; default is **union** (the crew collectively can draw any boon *any*
  member has unlocked), so a veteran *broadens* the crew's variety but grants **no power** (every boon is
  balanced to be a sidegrade in its tier). Unlocking boon #20 doesn't make #20 stronger than #1 — it
  just adds *another flavor* of the same-tier choice. This is the anti-grind crux: more pool = more
  *variety of decisions*, identical *power envelope*.

### 7.3 Unlock: COSMETICS & CREW IDENTITY (pure expression)

- **Cosmetics:** Anchor "totem" skins, crew banners, throw-trail VFX, recall-beacon glyphs, emotes,
  the coalescing-floor resolve color (ties to pillar 7 visuals — your crew literally tints the tower as
  you climb). All cosmetic, all determinism-safe (view-layer only).
- **Crew identity (persistent crews):** a crew can register a name, banner, motto, and a shared
  **Crew Codex** (lifetime highest floor, runs together, signature boon picks). This is the social
  retention hook — you level the *crew*, not the *character*. Crew Marks unlock crew-wide banners/titles.
- **Title/track cosmetics** from height milestones ("Reached Floor 100", "Summited the New Tower") —
  bragging rights, zero stat impact.

### 7.4 The curve (anti-grind, explicitly flat)

- Ascent Marks per run ≈ `BASE + k * sqrt(maxAnchorFloor)` (sublinear in height so a marathon run isn't
  required) `+ flat participation bonus` (so a stomped crew still earns). No daily-login power, no
  energy/stamina, no FOMO timers.
- Unlock costs are **front-loaded and finite**: roles + the full boon pool are *all* obtainable within
  ~15–20 runs of normal play, after which Marks only buy cosmetics. There is **no infinite power
  treadmill** because there is *no power to buy*. Once you've unlocked the toolbox, you're done
  grinding — the game becomes purely about play (the explicit anti-grind goal).
- **No purchasable power, ever.** Monetization (if any; out of scope for design but stated for the
  constraint) is cosmetic-only by construction, because power literally does not exist as an unlockable.

---

## 8. Tuning surface (everything above, in one config)

All defaults centralize in `config/tuning.ts` so balance is data, not code, and so the netcode can hash
the config version into the match seed (so all peers agree on the economy constants):

```ts
export const PROGRESSION_TUNING = {
  STRATUM_FLOORS: 10,          // draft cadence
  DRAFT_CARDS_BASE: 3,
  DRAFT_TIMER_TICKS: 360,      // 6s @ 60Hz; Anchor breaks ties
  RARITY_BASE: { common: 0.58, rare: 0.30, epic: 0.10, legendary: 0.02 },
  BOON_FAMILY_SOFTCAP: 3,
  MAX_ACTIVE_BOONS: 12,

  // rubber-banding
  DEFICIT_SCALE_FLOORS: 30,    // d saturates at 3 strata behind
  CATCHUP_MIN: 0.0,
  CATCHUP_MAX: 1.0,
  RARITY_UPLIFT_MAX: 0.18,     // mass shifted toward higher tiers at max deficit
  EXTRA_CARD_AT_CATCHUP: 0.5,  // 4th card threshold
  FREE_REROLL_AT_CATCHUP: 0.85,
  COMEBACK_POOL_AT_CATCHUP: 0.4,
  SLIPSTREAM_MAX_CLIMB_BONUS: 0.12,
  LEAD_DEADZONE_FLOORS: 2,     // leader & near-peers get base table
  RUBBERBAND_INTENSITY: "default", // off | mild | default | spicy  (host knob)

  // momentum
  MOMENTUM_MAX: 100,
  MOMENTUM_REROLL_COST: 35,
  MOMENTUM_BANK_COST: 50,

  // anchor-shell mercy
  ANCHOR_STANDUP_GRAB_IMMUNE_TICKS: 90, // 1.5s
} as const;
```

---

## 9. Open tensions (flagged for 01/04 + playtest)

1. **Draft-without-pause vs decision quality.** Not pausing the sim (§2.2) preserves tension but may
   make complex Epic/Legendary reads hard mid-fight. *Mitigation:* card text is terse + iconographic;
   the 6 s timer + Anchor-tiebreak means a silent crew still gets a sane pick. Needs playtest;
   coordinate with `07-ux-ui-gamefeel.md` on the diegetic card overlay.
2. **Union boon pool vs balance.** Default-union pools (§7.2) maximize variety but mean balance must
   hold across the *entire* deployed pool, not just the core. *Mitigation:* strict tier-sidegrade
   discipline; any boon that tests >1 tier above its slot gets renumbered or nerfed. (Owner: this doc +
   `04-competitive-structure.md`.)
3. **Rubber-band feel for the leader.** Even with the leader untouched (§4.4 #1), a *perception* of
   unfairness can arise if a trailing crew's Legendary swings a flashpoint. *Mitigation:* Legendaries
   cap ~4% even at max deficit, and the leader has draftable counters (§5.2). Validate with the
   `off`/`mild`/`spicy` knobs in ranked vs party contexts (defer the exact ranked default to `04`).
4. **`DEFICIT_SCALE = 30` vs tower height variance.** On very tall endless runs, 30 floors may be too
   small a saturation window; on race-to-100, it may be too large. *Mitigation:* express
   `DEFICIT_SCALE` as `min(30, 0.3 * targetFloors)` for bounded win-conditions; keep flat 30 for
   endless. Confirm with `04`'s win-condition matrix.
5. **Momentum legibility.** A second meter risks clutter against the "Overcooked-clean" goal. *Mitigation:*
   render it *on the recall beacon* / Anchor totem, not as a separate HUD bar — it lives where the crew
   already looks. (Owner: `07-ux-ui-gamefeel.md`.)
```
