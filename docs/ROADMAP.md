# ROADMAP — ASCENT (v3)

> Sequenced to **prove the #1 risk as early as honestly possible**, then build outward from a proven core.
> Each phase: **Goal · Deliverables · The ONE risk that sinks it · Demoable milestone.** Numbers and
> mechanisms are owned by the pillar docs (00–09); this is the build order, not a re-spec. See
> `00-master-vision.md` §4 for the resolved tensions this plan is built on.

---

## The single riskiest assumption — de-risk it FIRST

> **"A rollback sim can run grab + carry + throw of many physical bodies (and the occasional grab-train)
> bit-deterministically across two browsers, such that a full cross-crew flashpoint never desyncs."**

Everything downstream depends on this. If it's false, the *genre* (physical escort brawl on rollback
netcode) is not buildable as specified, and we must change the architecture (host-authoritative + lag
comp) or the fantasy (fewer/cheaper physical interactions) — a foundational pivot we want to discover in
**week 1–2, not month 6.** [00 §4a; flagged as the #1 risk in the bible, 02 §10, 05]

### The minimal spike that proves or kills it (the "Two-Browser Grab Proof")

**Scope (deliberately tiny — no game, no art, no networking topology, no AoI, no PvP balance):**

1. A headless deterministic sim module: fixed 60 Hz `step(tick, inputs)` over a single flat floor with
   ~20 free rigid bodies (crates) + 2 player capsules + 1 Anchor capsule. Seeded PRNG only
   (xoshiro/splitmix, the same family 06/09 already name); no wall-clock. Fixed-point or carefully-bounded
   float per the physics-path decision below.
2. Implement *only* the verbs as **kinematic transforms** per [00 §4a / 02 §10]: parent-socket carry,
   idempotent `(entityId, releaseTick)` throw impulse, RUSH capsule sweep, STRUGGLE resolution (seeded
   jitter, anti-autoclicker ramp). Plus **one** real two-body case: a capped 3-link grab-train (or its
   kinematic-composite fallback).
3. **Two harnesses in two browser engines** (Chromium + Firefox, ideally + WebKit via a CI runner): feed
   *identical* recorded input streams, run 10,000 ticks, compare per-tick check-frame hashes.
4. **Rollback torture test:** inject artificial misprediction (delay/perturb remote inputs), force
   rollback + resim every few ticks during an active grab/throw/train, and assert the post-resim hash
   equals the never-rolled-back reference hash. **Throw must be idempotent across a rollback that straddles
   the release tick.**

**Kill criteria (any one = the simple approach is insufficient; escalate the fallback ladder):**

- Cross-browser hashes diverge on free-body ballistic integration → escalate Rapier-fixed →
  **fixed-point** integration. [00 §4a]
- The grab-train (true constraint) can't be made deterministic/cheap → **commit to the kinematic-composite
  train** (sum-capped mass, driven by the head grabber) and forbid true solver joints on the hot path
  anywhere. [02 §4.4]
- A rollback straddling a throw release produces a non-idempotent impulse → redesign throw charge until it
  is a pure function of `(grabStartTick, releaseTick)` (no accumulator). [02 §10]

**Pass criteria:** 10k-tick bit-identical hashes across ≥2 engines, *and* identical hashes through ~1k
forced rollbacks during active grabs/throws/trains, *and* a documented decision on two forks:
**Rapier-fixed vs. fixed-point**, and **true-train vs. composite-train**. These two decisions are *inputs*
to P1/P2 and to the eventual 05 rewrite.

**Run this spike standalone, before or in parallel with P0 scaffolding.** It needs no UI, no networking
stack, no assets. Estimate: a focused engineer-week. It is the cheapest possible test of the most expensive
possible failure.

---

## P0 — Scaffold

- **Goal:** a deterministic, debuggable skeleton you can iterate in: Vite + TypeScript + Three.js boots,
  a fixed-timestep tick loop runs, the chosen physics path (from the spike) is integrated, and the
  Frequency `src/net/` reuse surface is vendored and understood.
- **Deliverables:**
  - Vite/TS/Three.js project; fixed 60 Hz tick loop with a *separate* render/interpolation loop;
    `performance.now()` confined to a transport stub. [05 §8 framing; 02 §0]
  - Seeded PRNG (splitmix64/xoshiro) threaded through sim state; a lint/CI rule that **fails the build on
    any `Math.random` or wall-clock read inside `/sim`** (mirrors 09 §0 hard contracts). [05 §0, 09 §0]
  - Snapshot ring buffer + check-frame hashing scaffold (no rollback logic yet — just hash + compare two
    local sims). Adopt 09's `contentHash` discipline for generated geometry from day one. [09 §4.2]
  - **Vendor/clone Frequency** (it is on disk at `c:/Users/Jacob/Documents/Projects/Frequency`) and write a
    one-page **REUSE vs REPLACE** note against the *real* `src/net/` files (`roomCode.ts`, `migration.ts`,
    `transport.ts`, `peer.ts`/`peerClient.ts`, `protocol.ts`, `net.ts`, `netStore.ts`, `hostServer.ts`) +
    `CLAUDE.md`. Per 05: REUSE the connection lifecycle (deterministic room-code→peerId, senior-peer silent
    migration ladder, STUN/TURN, mesh|relay transport, signaling-only); REPLACE the host-authoritative
    single-reducer game loop with peer-symmetric rollback. [05 §0/§1]
  - Determinism harness from the spike promoted into the repo as a permanent CI job.
- **The ONE risk that sinks it:** the chosen physics integration can't be deterministically built in the
  browser toolchain at all (WASM Rapier-fixed flakiness, or fixed-point too slow). *Mitigated by:* the
  spike already settled the physics path before P0 commits to it.
- **Demoable milestone:** two sim instances in one page, fed the same inputs, show **identical check-frame
  hashes for 10k ticks**; the CI determinism job is green; the REUSE/REPLACE note is merged.

## P1 — Deterministic physics sim + single-player grab/throw/carry + one coalescing stratum

- **Goal:** *offline, single-player*, the core fantasy is felt: pick up the heavy Anchor, feel encumbrance,
  throw it across a gap, fumble it into the gap — on one real, coalescing stratum with one deterministic
  hazard.
- **Deliverables:**
  - The four verbs end-to-end against the mass hierarchy Light(0.4)/Player(1.0)/Heavy(1.8)/Anchor(3.2)
    [02 §3]: auto-target cone (2.2u/70°, deterministic nearest + stable-id tiebreak), GRAB latch
    (parent-socket), THROW (mass-scaled `J=J_base·c·(1/√mass)·strength`, idempotent), RUSH sweep, STRUGGLE
    vs. a dummy grabber, empty-hand SHOVE. [02 §1–§4]
  - The Anchor as an entity: ~60% speed, gap-locked, fall-durable, carriable at 0.45×, Plant-Beacon,
    struggle_strength 1.8 (hard to hold). [01 §2, 02 §6.6]
  - One stratum from `genStratum(seed, stratumIndex)` [09 §4] including a **GAP-CROSSING** (forces
    throw-across) and one **deterministic hazard** (`f(tick)` crusher or cracking-then-reforming tile).
    Reuse 09's grid-first authoring + validator, with the v3 archetype/persistent-floor framing from 00 §4
    (do NOT implement the v2 `race-the-collapse`/`collapseY`). [09 §3–§6, 00 §4e]
  - **Coalescence as pure view-layer:** `reveal∈[0,1]` from climber distance; collision solid from
    seed-time (stand on an unresolved tile). [09 §8, 06 §2, 01 §6] — minimal art, correct *invariant*.
  - Position-kill + kill-plane: regular fall-lethal threshold (~1.5 strata un-arrested); Anchor
    altitude-loss + ~120-tick downed beat; true death only at a kill-plane. [02 §8, 01 §4]
- **The ONE risk that sinks it:** **the throw-across-a-gap verb isn't fun** — aiming feels bad, mass
  doesn't read in the hands, or fumbling feels arbitrary instead of gut-punch. This is the fantasy; if it's
  flat, re-tune verbs *now*, before any netcode/art investment rides on it. (Def-of-fun #1, [00 §6])
- **Demoable milestone:** one player carries the Anchor across a coalescing GAP-CROSSING stratum, past a
  timed hazard, and **a deliberate fumble drops the Anchor into the gap to a kill-plane** — all
  hash-stable and replayable from `(seed, input-log)`.

## P2 — Rollback + the grab/throw determinism PROOF + AoI=Anchor + one crew

- **Goal:** the P1 sim, now **networked with rollback across browsers, with the #1 risk PROVEN in the real
  engine** (not just the standalone spike), running one full crew (3–5) including a human Anchor.
- **Deliverables:**
  - GGPO-style rollback over Frequency's transport: per-peer input-delay, redundant last-N inputs over
    unreliable/unordered channels, predict→rollback→resim. (This is the work the v2 05 doc's rollback
    primitives describe; build them under the v3 AoI-on-Anchor framing.) [05, 00 §5]
  - **The grab/throw determinism proof in-engine:** two+ browsers, induced 80–120 ms RTT + loss, run a full
    carry→throw→struggle sequence between *networked* players with **zero desync** (check-frame hashes
    equal through the whole interaction, including rollbacks straddling a throw release). This is the spike,
    elevated to the real netcode. [05, 02 §10, 00 §4a]
  - **AoI = Anchor** as a *send-rate* policy (TIGHT/LOOSE/OUT), not a sim policy; sim stays global. This is
    the v3 re-keying of 05's AoI (from raw vertical proximity to the Anchor's height). [05, 04 §3, 00 §4b]
  - One crew co-op carrying the Anchor up several strata across the network.
  - `mergeClusters(onCrossCrewContact)` + the grab-eligibility gate ("target must have been TIGHT/LOOSE at
    latch tick") stubbed and tested (full exercise lands in P4). [00 §4a/§4b]
- **The ONE risk that sinks it:** rollback fan-in / resim cost blows the frame budget when carry/grab
  interactions span a rollback (the worst-peer extreme-order statistic is worse than predicted), so
  corrections become visible hitches. *Mitigated by:* kinematic verbs (cheap resim), AoI-bounded send rate,
  and the capped-train decision from the spike — but P2 is where we *measure* it under real RTT/loss.
- **Demoable milestone:** **two players in two browsers co-op-carry and throw the Anchor across a gap with
  no perceptible desync, and a forced rollback during the throw leaves both sims bit-identical.** The #1
  risk is now dead in the real engine. *(This is the project's keystone milestone.)*

## P3 — Art / coalescence spectacle

- **Goal:** the proven core wrapped in the v3 visual language, hitting the perf budget — readable under
  chaos, determinism-safe by construction.
- **Deliverables:**
  - The über-`TileMaterial` (one `reveal` scalar, 4 phases dots→gather→panel→lit, baked vertex attrs, full
    instancing); Engineer-built terrain reuses the same materialize shader; emerge-up-through-floor
    porthole over sim-defined route mouths. [06 §2, 09 §8]
  - Floors-below **persistence** stack (value-crushed desat floored ~0.8, height fog, faked god-rays,
    parallax planes, **fog-immune crew-color rim**) — explicitly NOT fragment-and-fall. [06 §3, 00 §4e]
  - **Closed-form, event-spawned, instanced particles** that re-spawn identically on rollback (consume the
    sim event list + rollback signal, never produce them). [06 §4]
  - Three color channels (architecture / crew-identity / hazard-red) + legibility hierarchy
    (silhouette > identity color > state aura > motion > particles > shake) + Anchor-centric camera
    (w_anchor=3.0, calm/flashpoint dolly) + triple-redundant Anchor status HUD. [06 §1, 07 §1–§4]
  - Perf budget enforced (≤250 draws / ≤1.2M tris / ≤12k particles / 1 dir light / ≤6 post passes) +
    the **squint-test CI check** + transparency fallback ladder. [06 §5–§6]
- **The ONE risk that sinks it:** spectacle vs. readability/perf — a worst-case 4-crew brawl drops below
  60 fps on the 2021-iGPU target, *or* the spectacle obscures "where is MY Anchor." *Mitigated by:* the §0
  determinism contract + the readability>perf>spectacle ordering + AoI-bounded render set + the
  high-confidence fallback path is the committed target, not the full spectacle. [00 §4e, 06 §0/§6]
- **Demoable milestone:** a player emerges up through a coalescing floor, climbs through a resolving
  stratum with rival silhouettes rim-lit through fog below, in a busy scene that **holds 60 fps on the
  target iGPU and passes the squint test** — with a rollback visibly re-spawning the identical particle
  burst.

## P4 — The race: multi-crew + rubber-banding + flashpoint PvP + rival-Anchor sabotage

- **Goal:** the actual *game* — multiple crews in one shaft, position-kills, flashpoints, the
  thrown-down-Anchor blue-shell, and the full non-degeneracy of grab under real PvP.
- **Deliverables:**
  - Multiple crews in one shared shaft, soft-separated by pace; structural flashpoints (lift /
    single-wide ledge / route-merge / coalescing-floor-edge / pace-collision) from levelgen, with the
    sequencing contract (no two flashpoint strata back-to-back, CONTESTED-MERGE on a fixed cadence,
    2–4 routes/stratum). [04 §3, 09 §5/§6, 01 §3]
  - **Cross-AoI flashpoint handling proven:** `mergeClusters(onCrossCrewContact)` + the
    must-have-been-TIGHT/LOOSE-to-latch eligibility gate, exercised by tight-cluster-meets-tight-cluster.
    [00 §4b]
  - Rival interaction = the *same* verb set, target flipped: grab/throw/shove/drag a rival Anchor; position
    kills; ~90-tick vuln beat; ~18-tick regrab immunity; **universal ally bump-to-break** (a successful
    RUSH onto a grabber staggers + shortens latch, so a no-Bulwark crew can still answer Anchor-theft) +
    locked Struggle anti-autoclicker ramp *shape* + the `MAX_HELPLESS` invariant. [04 §2, 02 §2/§4, 00 §4c]
  - Rubber-banding: rank-weighted boon quality + the thrown-down-Anchor blue-shell + leader-protection
    guardrails (leader / anyone within 2 floors of top never directly slowed); deficit math `d` →
    smoothstep, saturating at `DEFICIT_SCALE` (~30 floors / `min(30, 0.3·targetFloors)` in bounded modes).
    [03 §4–§6, 00 §4d]
  - Standing as the single committed scalar `H=floorIndex+fractionalProgress` (committed-vs-raw anti-yo-yo);
    altitude ribbon / crew banner / TAB sheet on the 2 Hz StandingBeacon; rival fog bands mapped 1:1 onto
    AoI bands. [04 §1, §3]
- **The ONE risk that sinks it:** **grab degenerates into a lock under real PvP** — Anchor-theft or a
  grab-train removes a player/Anchor from play and "first-grab-wins," *or* the cross-AoI merge produces
  unbounded rollback fan-in at a big collision. *Mitigated by:* the five-pressures stress-test [00 §4c]
  (with its two mandated fixes + the `MAX_HELPLESS` invariant) and the cluster-merge + eligibility-gate
  bound on fan-in [00 §4b]. P4 is where these meet live players.
- **Demoable milestone:** two crews collide at a CONTESTED-MERGE; one grabs the other's Anchor; a
  struggle/bump-break scramble erupts and **resolves in seconds by position** (thrown down, altitude lost,
  pack re-bunches via the next boon) — **no stunlock, no desync, bounded rollback.**

## P5 — Progression / meta + win-condition settings

- **Goal:** the run economy and lobby tunability that frame matches — breadth-not-power, all
  determinism-safe and host-tunable.
- **Deliverables:**
  - The 1-of-3 crew draft, **sim does not pause** (ping-vote, ~6 s timer, Anchor holds the deciding vote at
    timeout); rarity tiers 58/30/10/2; ~25 physical/escort-only boons (no DPS/anti-NPC); Momentum meter
    (reroll/bank only). All RNG = `f(seed, tick, crewState)`; drafts triggered by the Anchor crossing
    10-floor stratum boundaries, claimed-once. [03 §1–§3]
  - Three win conditions (RACE-TO-HEIGHT default ~floor 100 / ENDLESS-HIGHEST 15-min tick budget /
    ROUNDS-TO-SUMMIT best-of-3 fresh seed-per-round) + the full lobby knob set, **all locked at match start
    and hashed into the determinism check-frame seed.** Includes the ranked preset (race-to-height mid,
    rubberband off, FF off, anchorTrueDeath kill-plane-only). [01 §8, 04 §4]
  - Meta-progression: roles onboarding-gated (all six open in ~3–4 runs, host override), default-union boon
    pools (breadth not power — every boon is a tier-sidegrade), cosmetics/crew identity. [03 §7]
  - Anchor selection (volunteer-first / assign-by-connection), premade + solo-queue crew formation,
    determinism-safe ingress-only spectating after Anchor wipe. [04 §6]
  - Onboarding choreography (first-60s, one verb per moment, the aim-arc IS the throw tutorial, the
    interdependency moment, "THAT'S THE GAME" affirmation) + drop-in/reconnect on Frequency's silent
    migration (coalesce-in at beacon, no "host migrating" modal, disconnect must not cause a ring-out).
    [07 §6–§7, 05 §1]
- **The ONE risk that sinks it:** rubber-banding/draft balance makes the leader feel cheated *or* lets
  trailing crews coin-flip a win — the comeback engine becomes either toothless or unfair. *Mitigated by:*
  leader-untouched guardrail + self-canceling-at-parity continuous effects + `DEFICIT_SCALE` saturation;
  this is the most playtest-sensitive balance surface and is sequenced last on purpose. [03 §5, 00 §4d]
- **Demoable milestone:** a full match start-to-finish under a chosen win condition: crews draft boons
  without the sim pausing, a trailing crew claws back via better boons + a well-thrown rival Anchor, and the
  match ends on a clean position-decided win — **the leader never felt directly slowed, and a late joiner
  coalesced in without a host-migration modal.**

---

## Sequencing rationale (why this order)

- **The spike before everything** because the #1 risk is foundational, not incremental — a late discovery
  forces an architectural pivot.
- **P1 single-player before P2 netcode** so we prove the *fantasy is fun* (def-of-fun #1) before paying the
  netcode tax — and so P2's rollback has a known-good reference sim to hash against.
- **P3 art after P2** because spectacle is unconditionally subordinate to determinism + perf [00 §4e]; we
  wrap a proven core, we don't art-direct a moving target.
- **P4 PvP after art** because non-degeneracy of grab [00 §4c] and cross-AoI flashpoints [00 §4b] need real
  players *and* readable visuals to stress-test honestly.
- **P5 meta last** because the most balance-sensitive, most-playtest-dependent surface (rubber-banding,
  [00 §4d]) should sit on top of a fully proven, fully readable, fully fair-by-structure core.

## Doc-cleanup tasks folded into the phases (do not skip)

- **Before P2:** rewrite **`05-netcode-architecture.md`** to v3 — delete `collapseY`/collapse-as-eliminator,
  re-key AoI from raw vertical height to the Anchor's height, keep every rollback/determinism/mesh-relay/
  migration primitive verbatim, and land the tick constants 04/03 need (`VULN_BEAT`, `REGRAB_IMMUNITY`,
  `DOWN_FLOORS_MIN`, `COMMIT_WINDOW`, `GROUND_DWELL`, `MAX_HELPLESS`, `CONTACT_HOLD`). [00 §4a/§4b/§7]
- **Before P1's stratum work hardens:** rewrite **`09-level-generation.md`** to v3 — drop the
  `race-the-collapse` archetype + `collapseY`/`collapseTimeBudget`, replace floors-below "collapse" with
  persistent desaturate+fog, swap the five archetypes to the v3 set, fix the `02-roles-combat.md` cross-ref
  to `02-roles-anchor-verbs.md`. Keep the generation engine intact. [00 §7]
- **At P0:** resolve the `02-roles-traversal-combat.md` (stale v2) vs `02-roles-anchor-verbs.md` (v3)
  filename collision — canonicalize the v3 file, archive/delete the v2. [00 §7]

**Cross-cutting, every phase:** the determinism CI job (no `Math.random`/wall-clock in `/sim`, cross-engine
hash equality, stratum `contentHash` agreement) is a *merge gate* from P0 onward. The moment it can go red
silently, the whole architecture is at risk.

---
Cross-refs: 00 (resolved tensions + data flow), 01–09 (pillar specs; 05 & 09 are v2-on-disk pending the
rewrites above). Owners listed inline per deliverable.
