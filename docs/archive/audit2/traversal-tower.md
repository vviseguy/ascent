# Audit v2 — TRAVERSAL & THE TOWER

Dimension: how a crew actually ascends the compiled tower, per docs 09, GENERATION-SOLVABILITY,
01 §2/§4, 02 §2.1/§5.2. All claims verified against current source (June 2026); stale AUDIT.md
ignored. Read-only audit.

Key physics constants used below (verified): jump speed 9 u/s (src/sim/verbs/config.ts:37),
Anchor jump multiplier 0.62 (config.ts:47), gravity −22 u/s² (src/sim/world/step.ts:39).
→ jump apex ≈ 9²/(2·22) ≈ **1.84 u for a Player, ≈ 0.71 u for the Anchor**.

---

### no-route-up — the compiled tower has NO way to ascend between strata; the ceiling is sealed

- Severity: **CRITICAL**
- Intent: the entire game is climbing. 09 §5: between entry band and exit band "generation carves
  **2–4 routes**" — STAIR/RAMP runs, SPIRE climbs, LIFT pads, destructible shortcuts (09 §5.2);
  tile types include `RAMP`, `STAIR`, `LIFT_PAD`, `SPIRE_NODE` (09 §3). 02 §5.2: throws place
  allies "on the floor above"; Anchors go up "via lifts, ramps (Engineer), or a Bulwark-throw onto
  a mid-ledge." 01 §2 calls ascent of the heavy VIP "the heart of the game."
- Reality: `compileTower` (src/game/tower.ts:81-142) emits exactly three things: a solid slab tile
  under **every** cell of every stratum (tower.ts:98-104 — the loop is unconditional, no gap/hole
  cells), 0.6 u lip walls on some interior seams (tower.ts:109-128), and a deep ground slab
  (tower.ts:134-137). The header comment *claims* "The EXIT cell of each stratum has a
  ramp/opening up to the next stratum's entry" (tower.ts:20-21) but **no such code exists**:
  `floor.exits` is never read anywhere in src/game (grep: zero references), and no ramp, stair,
  lift, hole, or ledge geometry is ever pushed. Each stratum's full 5×5-cell slab therefore forms
  an unbroken ceiling 5.5 u above the floor below (baseY+6 − 0.5 slab, tower.ts:37-39,94).
  Player jump apex is 1.84 u; the Engineer bridge block is a single 1.2 u-tall body
  (src/sim/verbs/abilities.ts:304-341, BRIDGE_HALF 0.6 at config.ts:262); max throw lift for a
  thrown teammate is ~8-12 u per 02 §3 — but there is **no opening to pass through** even if you
  could reach it. The game's own proof had to cheat to "climb": prove.ts PROOF 6 teleports the
  Anchor by writing `sc.sim.world.py[a] = y` directly (src/game/prove.ts:190-196).
- Gap: the player spawns on stratum 0 of a 5-story tower (src/main.ts:32, scene.ts:129-181), with
  a win condition at the top floor's height (scene.ts:165-168) that is **physically unreachable**.
  The core fantasy — climb — cannot be performed at all. This is the literal cause of the owner's
  "no way to advance to the next level."
- Fix sketch: in `compileTower`, skip the slab tile for each stratum's `entry` cell (s>0) so a
  hole exists above each stratum's exit region, and emit a ramp/stair AABB run (3-4 stepped boxes)
  from stratum N's exit cell up through stratum N+1's entry hole, aligning `floors[s].exits[0]`
  with `floors[s+1].entry` (offset the entry hole to sit above the exit cell, or rotate alternate
  floors 180° so exit row N sits under entry row N+1).

### no-perimeter-containment — every stratum edge is an unguarded cliff straight to the kill-plane

- Severity: **CRITICAL**
- Intent: 09 §4 stage 2 `layoutShell` emits "footprint, **outer walls**, entry band, exit band"
  (09 line ~140). Falls into the void are a *designed* risk attached to `GAP` tiles and exposed
  routes (09 §3 `GAP (fall-through to fog/collapse)`; 01 §4.3: Anchor true-death only "off the very
  bottom of the playable shaft" or in a hazard kill-volume — deliberate ring-out plays, not
  ambient walking hazards). GENERATION-SOLVABILITY: "Players can ALWAYS go around the
  edge/perimeter of a floor" — the perimeter is the universal *safe* fallback route, which
  presupposes it is walkable, not lethal.
- Reality: `compileTower` emits **zero** wall geometry at the floor boundary — seam lips are only
  generated between in-bounds cell pairs (`if (nx >= floor.width || ny >= floor.height) continue;`
  tower.ts:113), so the outer boundary of the 15×15 u footprint is a sheer drop. Below it: the
  kill-plane at −10 (scene.ts:140) sits above the deep slab at −14 (tower.ts:135-137), so any body
  walking off any stratum edge crosses the kill-plane and dies (src/game/survival.ts:58-67).
- Gap: the spec's "perimeter is the guaranteed fallback route" is inverted into "the perimeter is
  the most lethal place in the game." With mouse-first target-velocity movement, one overshoot
  near the edge kills you. Ledge risk was meant to be a *placed, readable* hazard; here it is
  ambient and total.
- Fix sketch: emit a full-height (or ≥2 u) wall AABB ring around each stratum's footprint in
  `compileTower` (4 boxes per stratum), leaving openings only where designed (future GAP ledges /
  route mouths).

### anchor-void-respawn-loop — an Anchor that falls off the edge with no beacon dies forever

- Severity: **HIGH**
- Intent: 01 §4.2: Anchor true death is "the biggest swing in the game" but is a *recoverable*
  dramatic beat — respawn at the crew beacon with an altitude penalty (survival.ts header,
  lines 15-17, states the same intent).
- Reality: `respawnAtBeacon` (src/game/survival.ts:110-134): with no beacon planted
  (`beaconTick < 0`) the Anchor falls through to the last-resort branch (the
  `cs.anchorId !== id` guard at line 116 excludes the Anchor itself) which sets `y = 1` but keeps
  the death x/z (survival.ts:120-121) — coordinates that are necessarily *off the footprint*,
  since the only way an Anchor dies is crossing the kill-plane (it cannot HP-die,
  survival.ts:70-77). It respawns in mid-air over the void, falls past the kill-plane again
  (−10 < 1 is reached in <1 s from y=1), and re-dies every RESPAWN_DELAY ticks, forever. Regular
  players then respawn "near the crew's Anchor" (survival.ts:116-118) — i.e., into the same void.
- Gap: one slip of the gold piece off the (unwalled, see above) edge before pressing Q ends the
  run in an invisible infinite death loop; the score freezes and nothing explains why.
- Fix sketch: in the no-beacon fallback, respawn at the crew's stratum-entry cell
  (`tower.entryXZ` is already computed; thread it into MatchConfig or clamp respawn x/z to the
  nearest slab AABB) instead of reusing the death x/z.

### gates-flattened — GAP/BREAK/BUTTON/WEIGHT semantics did not survive compilation; GAP is literally a solid floor

- Severity: **HIGH**
- Intent: edge kinds are the floor's *gameplay* (GENERATION-SOLVABILITY §Generation): GAP = "a
  jump/gap that must be crossed", BREAK = "a breakable block... Breaker instant", BUTTON/WEIGHT =
  held gates (src/floor/types.ts:26-46). 02 §2.1 / 01 §2.1: the Anchor is "**gap-locked**" — it
  "cannot self-clear a 'big' gap"; "alone it stalls at the first real chasm... it's the source of
  all interdependence" (01 lines 104, 110-113). JUMP_MUL's own doc comment says the Anchor jumps
  lower "so it cannot self-clear a real chasm — the crew must carry/throw it across"
  (src/sim/verbs/config.ts:39-48).
- Reality: tower.ts:116: `if (kind === 'WALK' || kind === 'GAP') continue;` — and since *every*
  cell already received a solid slab (tower.ts:98-104), a GAP edge compiles to **flush solid
  floor, byte-identical to WALK**. The "open chasm" of the comment (tower.ts:18-19, 108) never
  exists. BREAK/BUTTON/WEIGHT — and plain *absent* edges (the maze walls) — all compile to the
  same inert 0.6 u lip (tower.ts:117-127): no breakable state, no button, no weight plate exists
  anywhere in the sim (grep BUTTON/breakable/destructible in src/sim: only "future work" comments,
  e.g. abilities.ts:364-370). The 0.6 u lip is jumpable by everyone — including the Anchor
  (apex ≈ 0.71 u) — so it gates nothing.
- Gap: the Anchor's defining constraint has zero terrain expression: it never needs a carry, a
  throw, an Engineer bridge, or a Breaker. The entire escort-verb suite (the game's heart, 01 §2.2)
  is mechanically pointless on this terrain; the generator's carefully proven route structure is
  cosmetic.
- Fix sketch: for GAP edges, carve the seam: shrink the two adjacent slab tiles by ~1 u each side
  of the seam line so a real ≥2 u chasm exists (Player clears with a running jump/dash, Anchor
  cannot). Raise BREAK/no-edge lips to ≥2.5 u (un-jumpable walls) and leave BREAK passable later
  via a breakable-body hook.

### verifier-promise-severed — solvability is proven on the graph but never preserved (or checked) in geometry

- Severity: **HIGH** (latent — currently masked by gates-flattened, becomes live the moment gaps/walls are real)
- Intent: GENERATION-SOLVABILITY: "never trust the generator's claim of solvability — prove it
  independently"; the invariant is a SOLO HEAVY ANCHOR reaches an exit via the fallback layer.
  09 §4.1: validate-and-repair guarantees a role-agnostic route *in the placed tile geometry*.
- Reality: the verifier (src/floor/verify.ts) operates purely on the Floor graph; `compileTower`
  is a separate lossy projection that (a) drops `exits` entirely (never read in src/game), (b)
  makes GAP=WALK and BREAK/BUTTON/WEIGHT=absent-edge (all four collapse to two geometric cases,
  tower.ts:116-127), and (c) adds no vertical link the verifier could even model. Nothing checks
  that the compiled AABBs admit the path the verifier proved — and indeed today they admit
  *every* path within a floor and *no* path between floors.
- Gap: the project's flagship engineering promise ("catastrophic unsolvability structurally
  impossible") does not currently apply to the thing the player walks on. Once real gaps/walls
  land (fixes above), an unchecked compiler bug can ship an untraversable floor with the verifier
  still green.
- Fix sketch: add a geometry-level re-verification in src/game/prove.ts: BFS over compiled slab
  tiles using Anchor movement capabilities (step height, jump apex 0.71 u, no gap > 0) from
  stratum 0 entry to top stratum, asserting reachability for a range of seeds.

### tower-mode-is-bare — no hazards, no throwables, no pickups/boon nodes placed in the compiled tower

- Severity: **MEDIUM**
- Intent: 09 §4 pipeline stages 4-7: every stratum gets hazard instances "keyed to routes/chokes",
  cover, risk-gradient pickups, and one boon node. 02 owns a hazard catalog; 01 §3 defines each
  stratum as "a traversal problem wrapped around a hazard pattern." Throwable objects are part of
  the universal fallback ("throw [fists/objects]", GENERATION-SOLVABILITY §invariant).
- Reality: `buildTower` passes `hazards: []` (src/game/scene.ts:178) and spawns zero throwable
  bodies (scene.ts:129-181 has no object spawn loop — contrast `buildSandbox`'s crusher +
  8 throwables, scene.ts:86-103). The hazard system itself works (sandbox crusher,
  src/sim/hazards/) but is unused in the mode main.ts actually boots (src/main.ts:32). Boons
  auto-draft from height milestones (src/game/match.ts:184-215) — acceptable interim — but no
  placed nodes/pickups exist.
- Gap: tower mode (the real game) is *less* eventful than the throwaway sandbox: bare identical
  slabs with nothing to dodge, pick up, throw, or fight over; no risk/reward gradient between
  routes because there is neither risk nor reward.
- Fix sketch: in `buildTower`, derive 1-2 hazards per stratum from the floor's gated seams
  (e.g. a crusher sweeping a BUTTON seam, params seeded from the floor seed) and scatter
  2-3 throwables per stratum at deterministic cell centers.

### stratum-scale-collapsed — 15 u × 6 u strata cannot host the spec's "plural ascension"

- Severity: **MEDIUM**
- Intent: 09 §3: footprint 24-40 cells at 2.0 u (≈48-80 u across, "comfortably larger than the
  camera frame so routes can diverge"); band height 18-28 u; 2-4 spatially separated routes
  (09 §11.1). 02 §5.2 tunes throws against a "full 12 u stratum".
- Reality: gridSize 5 × CELL_SIZE 3 u = **15 u** across (scene.ts:137, tower.ts:35), FLOOR_HEIGHT
  **6 u** (tower.ts:37) — one screen wide, one-third the minimum spec band height. The generator
  is asked for `guaranteedRoutes: 2` (scene.ts:137) but at this scale both "routes" are a few
  steps apart. Throw tuning (12 u teammate lift, 4.8 u Anchor lift, 02 §3/§5.2) is calibrated for
  bands 2-4× taller than these.
- Gap: even with ascent fixed, route choice, scouting (Runner SCOUT_RADIUS is 40 u — 2.7
  strata-widths), flanking, and the camera's vertical drama have no room to exist; throws
  overshoot an entire stratum.
- Fix sketch: bump to gridSize ≈ 8-10 (or CELL_SIZE 4) and FLOOR_HEIGHT 10-12 u as a first step
  toward spec scale, re-tuning camera frame and throw arcs alongside.

---

**Dimension verdict:** The tower compiles to five sealed, unwalled parking decks: there is no
geometric route from any stratum to the next (the compiler's promised exit ramp was never written,
and the next floor is an unbroken ceiling), while every floor's outer edge is an instant
kill-plane fall — the exact inversion of the spec, which demands guaranteed ascent routes and a
safe perimeter fallback. Until `compileTower` carves exit holes + ramps, walls the perimeter, and
expresses GAP/BREAK seams as real geometry, the game's single core verb — climb — does not exist
in the playable build.
