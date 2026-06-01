# 09 — Stratum / Level Procedural Generation (v2)

> v2 — full rewrite. Aligns with the v2 vision bible: ONE SHARED ARENA (a single continuous
> vertical shaft all crews climb together), TERRAIN-FIRST tension, scripted hazards only
> (NO NPC enemies, NO AI), multiple routes up per stratum, and the coalescence visual model.
> Supersedes the v1 stub (single staircase, per-crew instances, NPC spawn tables).

This doc owns the **deterministic procedural generation of strata** and the **one shared floor
data structure** that both the simulation and the renderer (`06-art-direction-shaders.md`)
consume. Generation is a pure function of `(runSeed, stratumIndex)`. Every peer that knows
those two numbers produces a **bit-identical** stratum, with zero network traffic for level
data. This is the foundation that makes rollback over the shared arena tractable (see
`05-netcode-architecture.md`, which owns rollback + the deterministic sim + the determinism
rules this generator depends on).

> Sibling-doc shorthand used throughout: `01` = `01-game-design.md`, `02` = `02-roles-combat.md`
> (roles + the scripted-hazard catalog), `03` = `03-progression-economy.md` (boons/draft),
> `04` = `04-competitive-structure.md` (standings + rubber-banding), `05` =
> `05-netcode-architecture.md` (rollback, the deterministic sim, determinism + check-frames),
> `06` = `06-art-direction-shaders.md` (renderer / coalescence reveal), `07` =
> `07-ux-ui-gamefeel.md`, `08` = `08-audio.md`.

---

## 0. Hard contracts (read first)

1. **Generation is pure & deterministic.** `genStratum(runSeed, stratumIndex) -> StratumData`.
   No `Math.random`, no `Date.now`, no wall-clock, no DOM/canvas measurement, no floating
   non-determinism. Uses the project seeded PRNG only (§2). Same inputs → same bytes on every
   browser. This is the single most load-bearing rule in the doc.
2. **Generation runs in the SIM layer, ahead of arrival.** Strata are generated on a worker as
   pure data (§7) and handed to the sim deterministically. The renderer NEVER generates geometry
   that the sim doesn't know about; it only *reveals* (coalesces) geometry already present in
   `StratumData` (§8).
3. **One data structure, two consumers.** `StratumData` is authored once. Sim reads collision /
   hazard / route / pickup fields. Renderer reads the same fields plus *view-only* hint fields
   (coalescence anchors, theming, decoration seeds). View-only fields are namespaced under
   `.view` and the sim is FORBIDDEN from reading them (§8.4), guaranteeing VFX can never affect
   the simulation.
4. **No NPC spawns, ever.** Where v1 placed enemies, v2 places **scripted hazards** (deterministic,
   telegraphed, cheap; the hazard catalog lives in `02`) and **terrain challenges**. Generation emits hazard
   *instances with parameters and phase offsets*, never agents with behavior.
5. **Shared arena, not instances.** A stratum is generated once for the whole lobby. All crews
   climb the same geometry. There is no per-crew variation in collision/routes; only *cosmetic*
   per-viewer state (what has coalesced for YOUR camera) differs, and that lives in the view layer.

---

## 1. Vocabulary

- **Shaft** — the single endless vertical structure. Global axis `+Y` = up = progress = standing.
- **Stratum** — one room-sized horizontal slab of the shaft at integer `stratumIndex` (0,1,2,…).
  The unit of generation, drafting (a boon per cleared stratum), and AoI fog-banding. Replaces
  v1 "floor/room instance."
- **Cell** — the integer grid unit a stratum is authored on (§3). Generation is grid-first, then
  the renderer skins it into smooth geometry.
- **Route** — a sanctioned path from a stratum's entry band to its exit band (a way *up*). Each
  stratum has **2–4 routes** of differing risk/reward and sometimes role-gating (§5).
- **Anchor (coalescence anchor)** — a tagged point/volume where geometry materializes for the
  reveal animation (§8). View-layer only.
- **Biome** — a theming + difficulty band that changes every `N` strata (§9).
- **Archetype** — the stratum's "verb" template: gauntlet / holdout / escort / puzzle-route /
  race-the-collapse (§6).

---

## 2. Seeding & the PRNG discipline

We derive a per-stratum seed by hashing, NOT by advancing a single shared stream (a shared stream
would couple strata and make out-of-order / ahead-of-time generation order-dependent — fatal for a
shared arena where peers generate different strata in different orders).

```ts
// 64-bit splitmix-style mix; pure integer ops, identical across browsers.
function mix64(a: bigint, b: bigint): bigint {
  let z = (a ^ (b + 0x9e3779b97f4a7c15n)) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

function stratumSeed(runSeed: bigint, stratumIndex: number): bigint {
  return mix64(runSeed, BigInt(stratumIndex) * 0x100000001b3n);
}
```

Within generation we use **named sub-streams** so adding a later generation step never shifts the
output of an earlier one (decoupling = stable diffs + safe iteration):

```ts
function subStream(base: bigint, tag: number): PRNG {
  return makePRNG(mix64(base, BigInt(tag)));   // PRNG = our project xoshiro256** wrapper
}
// tags are stable constants:
const S_LAYOUT = 1, S_ROUTES = 2, S_HAZARDS = 3, S_COVER = 4,
      S_PICKUPS = 5, S_BOON = 6, S_THEME = 7, S_DECOR_VIEW = 8;
```

**Rules** (enforced; the cross-browser determinism guarantees live in `05`):
- Integer math for all gameplay-affecting generation. Where we must place things in continuous
  space, we quantize to the cell grid and to fixed-point (`Q16.16`) coordinates — never raw float.
- `S_DECOR_VIEW` is the ONLY stream the renderer may pull from, and ONLY for cosmetic decoration
  (which never feeds back into `StratumData` collision). Keeping it as a separate tagged stream
  means cosmetic churn can't perturb gameplay generation.
- Trig avoided in generation; where unavoidable (spire angles) use a precomputed fixed-point LUT
  shared by all platforms.

---

## 3. Grid-first authoring model

Each stratum is authored on a fixed integer grid, then later skinned. Grid keeps generation cheap,
collision trivial, and diffs legible.

- **Footprint:** `W x D` cells in X/Z, `W,D ∈ [24, 40]` (chosen per archetype/biome). Cell size =
  `2.0` world units. So a stratum spans ~48–80 units across — comfortably larger than the camera
  frame so routes can diverge horizontally (the "plural ascension" of the vision).
- **Height band:** each stratum occupies a vertical band `[baseY, baseY + H]`, `H ≈ 18–28` units.
  `baseY(stratumIndex)` is a deterministic running sum of prior bands (precomputable from index
  via the biome height schedule — does NOT require generating intervening strata, because band
  height is a pure function of `(biome, archetypeClass)` keyed by index; see §9).
- **Tile types** (collision-relevant, sim-visible): `EMPTY`, `FLOOR`, `WALL`, `RAMP(dir,slope)`,
  `STAIR(dir)`, `GAP` (fall-through to fog/collapse), `DESTRUCTIBLE` (Breaker can clear; HP tier),
  `LIFT_PAD`, `HAZARD_FLOOR` (tile that a hazard occupies/sweeps), `COVER_LOW`, `COVER_HIGH`,
  `SPIRE_NODE` (climb/grapple point).
- Output of the layout stage is a `Grid3` (sparse, see §10) — but logically a 3D occupancy of the
  band. Most strata are "2.5D": a dominant floor plane plus stacked sub-levels reachable by routes.

---

## 4. Generation pipeline (ordered, each stage pure)

`genStratum` runs these stages in fixed order. Each stage takes the grid-so-far + its own
sub-stream and returns a new immutable grid + emitted entity lists. Fixed order + tagged streams
= deterministic and stable.

```
1. pickArchetype + pickBiome        (S_THEME)      -> archetype, biome, difficulty D (§9)
2. layoutShell                      (S_LAYOUT)     -> footprint, outer walls, entry band, exit band
3. carveRoutes                      (S_ROUTES)     -> 2–4 Route objects + their tiles (§5)
4. placeHazards                     (S_HAZARDS)    -> HazardInstance[] keyed to routes/chokes (§4.x + 02)
5. placeCover                       (S_COVER)      -> COVER tiles in exposed lanes (§5.4)
6. placePickups                     (S_PICKUPS)    -> Pickup[] (risk-gradient) (§5.5)
7. placeBoonNode                    (S_BOON)       -> 1 boon node at/after exit band (§5.6)
8. computeAnchors + theming         (S_DECOR_VIEW) -> view.anchors[], view.theme, view.decor (§8,§9)
9. validateAndRepair                (deterministic, no rng) -> guarantees solvability (§4.1)
10. finalize                        -> freeze StratumData, compute contentHash (§4.2)
```

### 4.1 Validation & deterministic repair (guarantees the stratum is always beatable)

Procedural levels that can be *impossible* are unacceptable in a race with a rising collapse.
After placement we run a **deterministic** validator (no RNG, so it can't desync) using a flood
fill over a *traversability graph* (§5.1):

- **Reachability:** at least ONE route's exit band must be reachable from the entry band using
  only **role-agnostic** traversal moves (walk/jump/stair/ramp). If not, repair: downgrade the
  cheapest blocking `DESTRUCTIBLE`/`GAP` along the best candidate route to passable, in a fixed
  scan order (lowest cell index first). Repair is deterministic, so all peers repair identically.
- **Collapse-survivability:** the shortest reachable route must be clearable in
  `< collapseTimeBudget(D)` ticks at baseline movement speed (a static path-length check, not a
  sim). If not, widen the band or add one LIFT_PAD on the critical path (deterministic).
- **No degenerate softlocks:** every `GAP` wider than max jump distance must be spanned by at
  least one of {ramp, lift, spire chain, an Engineer-buildable bridge slot} — generation marks an
  **engineer bridge slot** rather than guaranteeing a free crossing, so the role stays valuable.
- Repairs are logged into `StratumData.genTrace` (dev builds only) for debugging desyncs.

### 4.2 Content hash

`finalize` computes `contentHash = fnv1a(serialize(StratumData_simFieldsOnly))`. Peers exchange
this lazily as a CHECK-FRAME extension (`05`): mismatched stratum hash = generation
desync, caught immediately instead of corrupting the shared arena. Only sim-visible fields feed
the hash (view fields excluded), so cosmetic differences never trip it.

---

## 5. Multiple routes up — the core of a traversal-first shared arena

A stratum's **entry band** is the strip of cells where climbers emerge from below; the **exit
band** is where they crest into the next stratum. Between them, generation carves **2–4 routes**.
Routes are first-class objects, not just tiles, because the sim, AoI, rubber-banding, and
coalescence all reason about them.

### 5.1 Traversability graph

Layout emits a sparse node/edge graph used by validation, by hazard placement, and (read-only) by
clients for route-tagging UI:

```ts
type TravNode = { id: number; cell: Cell; kind: 'ground'|'ledge'|'pad'|'spire' };
type TravEdge = {
  a: number; b: number;
  move: 'walk'|'jump'|'stair'|'ramp'|'lift'|'spire'|'destructible'|'bridge_slot';
  cost: number;                 // path/length cost in ticks at baseline speed
  gate?: RoleGate;              // null = role-agnostic (§5.3)
  risk: number;                 // 0..1, drives reward gradient (§5.5)
};
```

### 5.2 Route archetypes (the "ways up")

Generation picks a route mix from a weighted table (weights vary by biome/difficulty):

- **STAIR/RAMP run** — the safe, slow baseline. Always at least one route is *mostly* role-agnostic
  and survivable (validator-guaranteed). Lower reward.
- **SPIRE climb** — fast vertical via `SPIRE_NODE` chain; fragile, exposed, great for Runner;
  punishes mistimed jumps (fall to fog).
- **LIFT** — a moving `LIFT_PAD` platform; high throughput but **timed/telegraphed** (a hazard-class
  schedule, see `02`): miss the window and wait, costing collapse margin. Good convergence point =
  large tight-sync cluster risk (flag for netcode, §11).
- **DESTRUCTIBLE shortcut** — blocked by `DESTRUCTIBLE` tiles; opening it is the Breaker's payoff
  and creates a *shared* shortcut others can exploit (or a rival can re-collapse — PvP spice).
- **HAZARD GAUNTLET** — shortest path but threaded through crushers/turrets/sweeps; high risk,
  high reward, Bulwark body-block shines.

### 5.3 Role-gating (interdependence without hard locks)

Routes are **soft-gated**, never hard-locked (hard locks would brick a crew missing a role and
break drop-in/out). A gate makes a route *much cheaper/safer* for a role but always leaves a
worse-but-possible fallback:

```ts
type RoleGate =
  | { role: 'breaker';  effect: 'destructible_shortcut' }   // others: slow chip or detour
  | { role: 'engineer'; effect: 'bridge_slot' }             // others: long detour / spire risk
  | { role: 'bulwark';  effect: 'safe_through_hazard' }      // others: take the hits / time it
  | { role: 'runner';   effect: 'reach_distant_pad' }        // others: lift on a worse cycle
  | { role: 'mender';   effect: 'survive_attrition_lane' };  // others: bring own sustain
```

Per the vision: **nobody climbs efficiently alone**, but everybody *can* climb. Gating tunes
efficiency, not possibility. Validator (§4.1) checks the *role-agnostic* lower bound.

### 5.4 Cover

`placeCover` adds `COVER_LOW/HIGH` in lanes the hazard pass marked as **exposed** (in line of a
turret arc or a sweep). Cover is the Runner's lifeline and the readability anchor for "where is it
safe to pause." Density scales *inversely* with difficulty (higher = sparser cover). Cover never
fully blocks a route (validator).

### 5.5 Pickups & the risk/reward gradient

Reward must correlate with route risk so choices are meaningful:

```ts
expectedReward(route) = baseReward(biome,D) * (0.6 + 0.8 * route.maxRisk)
```

- Common pickups (small heal, brief speed, ammo-for-Breaker-charges) seeded along routes with
  **count ∝ risk**: the gauntlet/spire routes are paved with the good stuff; the safe stair is
  lean. This is the per-stratum micro-economy that mirrors the macro rubber-banding.
- Pickups are sim entities (deterministic, first-come-first-served; contesting them is PvP spice).
- **Rubber-band hook:** generation *tags* high-value pickups but the *actual* value is resolved by
  the sim at pickup time using live standings (see `04`). Generation
  stays standings-agnostic (it must, for determinism — standings differ per live state); it only
  places NODES and tiers. This keeps generation pure while letting rubber-banding live in the sim.

### 5.6 Boon node

Exactly one **boon node** per stratum, placed at/just past the exit band (Hades/RoR cadence:
draft on clearing a stratum). It's a sim entity; the *draft offer* (which boons) is computed by the
boon system at interaction time from standings + role (`03` boons, `04` standings), NOT by generation.
Generation only guarantees the node's existence and reachable placement. Rationale: same purity
boundary as pickups — placement is deterministic, *contents* are live-state-driven.

---

## 6. Archetype templates (the stratum "verb")

Each stratum gets one archetype that biases all later stages (route mix, hazard cadence, footprint,
band height). Picked from a biome-weighted bag with **anti-repeat** (no archetype 3× in a row;
enforced by a deterministic sliding window keyed on index, not on RNG history, so it's
order-independent).

| Archetype | Verb | Generation bias |
|---|---|---|
| **Traversal gauntlet** | cross fast through threats | shortest routes, dense telegraphed hazards, sparse cover, risk-heavy pickups |
| **Holdout-while-route-forms** | survive until a way up appears | one delayed route (LIFT cycling, or a bridge_slot the Engineer must build); ring of cover; converging hazard pressure |
| **Escort the fragile** | move a slow payload/Mender lane | one wide protected corridor + flanking exposure; Bulwark/Mender gates; checkpoint pads |
| **Puzzle-route** | figure out the order | DESTRUCTIBLE + LIFT + spire interdependencies; routes unlock each other; Breaker/Engineer synergy |
| **Race-the-collapse** | pure speed vs rising floor | tall band, faster collapse budget, multiple parallel routes, minimal hazards (the floor IS the hazard) |

Archetypes are **data-driven templates** (`ArchetypeSpec`): weight tables + parameter ranges, not
code branches, so balancing is editing JSON and tuning is reproducible.

```ts
type ArchetypeSpec = {
  id: ArchetypeId;
  footprint: Range2;            // W,D ranges
  bandHeight: Range;            // H range
  routeMix: WeightedBag<RouteKind>;
  routeCount: Range;            // 2..4
  hazardBudget: (D: number) => number;   // feeds 02's hazard catalog
  coverDensity: (D: number) => number;
  pickupRiskBias: number;
};
```

---

## 7. Where generation runs (timing & threading)

- Generation happens on a **dedicated worker** (`gen.worker.ts`), off the sim/render threads, as
  **pure data** (no Three.js objects, no Rapier handles — those are built downstream from the data).
- The sim drives a **lookahead window**: it keeps strata `[currentMin .. maxClimberStratum + LOOKAHEAD]`
  generated, `LOOKAHEAD = 3`. Because gen is pure & indexed, the worker can be asked for any index
  at any time and the result is cached by `(runSeed, index)`.
- Generation is **cheap by construction** (grid + sparse lists + a flood fill): target `< 4 ms`
  per stratum on a mid laptop. No per-frame generation; results memoized. The collapse + race keep
  climbers moving up, so lookahead of 3 is ample and bounded.
- **Determinism note:** generation order across peers will differ (leaders pull higher indices
  first). That's fine *because each index is independent* (§2). Nothing in gen depends on which
  strata were generated before it.

---

## 8. Coalescence: how the renderer keys off the data WITHOUT touching the sim

The coalescence reveal (`06`) is the visual signature: floors above are wireframe
"potential" that assemble (dots→lines→panels→lit surface) as climbers approach and crest a route.
This is **100% view-layer**, animated over the *already-deterministic* `StratumData`.

### 8.1 Anchors

`computeAnchors` (stage 8, `S_DECOR_VIEW`) tags points/volumes that drive the assembly animation:

```ts
type CoalAnchorKind = 'route_crest' | 'route_spine' | 'landmark' | 'boon' | 'hazard_marker';
interface CoalAnchor {
  kind: CoalAnchorKind;
  pos: FixedVec3;          // derived from sim geometry, but stored in .view
  radius: number;
  routeId?: number;        // for proximity-driven reveal along a route
  order: number;           // assembly sequence index (dots->...->lit)
}
```

Anchors are **derived** from the sim layout (route crests, exit band, boon node, hazard positions)
so the reveal always matches the real geometry — but they're stored under `StratumData.view` and
the sim never reads them.

### 8.2 Reveal driver (per-viewer, non-deterministic, harmless)

The renderer computes a per-stratum `revealProgress ∈ [0,1]` PER LOCAL VIEWER from local camera /
nearest-climber distance to `route_crest` anchors. Because it's per-viewer and view-only, it can
use wall-clock easing, `Math.random` sparkle, framerate-dependent lerps — none of it can desync
the sim. Different players literally see the world solidify at different moments; the collision
geometry was identical the whole time.

### 8.3 Three states, one data source

- **Above (potential):** render `StratumData` geometry as wireframe/dotted with `revealProgress`
  driving dots→panels. Geometry/collision already exist in sim; only opacity/material animate.
- **Current:** full PBR + lit, full hazard telegraphs.
- **Below (collapse):** desaturate, crack, fragment, fall into volumetric fog. Driven by the sim's
  authoritative `collapseY` (a single deterministic scalar owned by the sim in `05`), so all viewers agree on
  *what* has collapsed; the *fragmentation animation* is view-only flavor on top.

### 8.4 The firewall (enforced)

```ts
interface StratumData {
  // ---- SIM-VISIBLE (hashed, gameplay) ----
  index: number;
  seed: bigint;
  archetype: ArchetypeId;
  biome: BiomeId;
  difficulty: number;
  footprint: { w: number; d: number; cell: number };
  band: { baseY: Fixed; height: Fixed };
  grid: Grid3;                 // sparse tile occupancy (§10)
  routes: Route[];
  travGraph: { nodes: TravNode[]; edges: TravEdge[] };
  hazards: HazardInstance[];   // params + phase, NOT agents (§08)
  pickups: PickupNode[];       // nodes + tiers (value resolved live)
  boonNode: BoonNode;          // node only (offer resolved live)
  contentHash: number;

  // ---- VIEW-ONLY (NOT hashed, renderer-only) ----
  view: {
    theme: ThemeParams;        // palette, fog, material set (§9)
    anchors: CoalAnchor[];
    decor: DecorSeed[];        // cosmetic props; never collide
  };
  genTrace?: GenTrace;         // dev-only repair log (§4.1)
}
```

- Lint/type rule: the `sim/` package imports a `StratumSimView` type that **structurally omits**
  `.view`, so sim code physically cannot reference view fields. The hash function (§4.2) serializes
  only `StratumSimView`. This is the mechanical guarantee that "coalescence VFX can't affect the
  sim," which the vision demands.

---

## 9. Difficulty scaling & biome theming

### 9.1 Difficulty `D`

A smooth scalar from height, fed into hazard budget, cover density, collapse speed, gap widths:

```ts
D(stratumIndex) = clamp01( 1 - exp(-stratumIndex / 60) ) * biomeIntensity(biome)
// early strata gentle, asymptotes so it never becomes literally impossible;
// validator (§4.1) still guarantees a survivable route at any D.
```

`D` modulates (all deterministic, index-keyed):
- `hazardBudget` (count + speed/period of crushers/turrets/sweeps — catalog in `02`),
- gap widths & spire spacing (closer to/over max-jump as D rises),
- cover density (down), pickup richness on risky routes (up — keeps comebacks alive),
- `collapseTimeBudget` (down: collapse gains on you faster up high).

### 9.2 Biomes (theme + difficulty band, every `N` strata)

`N = 8` strata per biome by default. Biome is `floor(stratumIndex / N)` mapped through a fixed
ordered list (deterministic, no RNG for *which* biome — only the *contents* are seeded):

| Biome (band) | Visual signature | Mechanical twist |
|---|---|---|
| **Foundry** (0–7) | molten orange, soot, girders | timed steam-vent sweeps; many destructibles (Breaker intro) |
| **Drift** (8–15) | pale blue, ice, wind | low-friction floors; wind shoves (drift physics) toward gaps |
| **Verge** (16–23) | overgrown stone, green fog | spore cover that decays; collapsing organic platforms |
| **Spire** (24–31) | crystal, sharp light | spire-heavy verticality; turret crossfire lanes |
| **Aether** (32+) | dark void + neon wireframe | thin platforms over fog; coalescence at its most dramatic; collapse fastest |

After the list, biomes **cycle** with `biomeIntensity` ratcheting up (`+0.15` per cycle) so endless
mode keeps escalating. Theming = `ThemeParams` (palette, fog density, material set, ambient SFX id)
stored in `.view.theme` — view-only, so reskinning is determinism-free.

> Theming affects ONLY visuals + the *parameters* of already-existing hazard types. It never adds
> new collision the sim doesn't generate. A "spore cover that decays" is a normal `COVER` tile with
> a deterministic decay schedule (a hazard-class param), not a special-cased renderer object.

---

## 10. Data shapes & memory (cheap, sparse, serializable)

- `Grid3` is **sparse**: a flat `Map<cellKey, TileType>` over only non-`EMPTY` cells (most of the
  band is empty air). `cellKey = (x * D + z) * H + y` packed into a 32-bit int. A typical stratum is
  a few hundred non-empty cells → a few KB. Strata outside the AoI fog band + lookahead are evicted
  from the cache and regenerated on demand (pure & cheap), so memory stays flat even in endless mode.
- All coordinates that the sim uses are **fixed-point** (`Q16.16`), serialized as ints. `bigint`
  seeds serialize as hex strings for the worker boundary.
- `StratumData` is structurally cloneable for `postMessage` (no class instances with methods; plain
  data + a thin accessor layer built on the sim/render side).

---

## 11. Cross-cutting tensions other docs must handle

1. **Same-stratum pile-up (netcode, `05`).** Convergence features (LIFT pads, single boon node,
   choke routes) pull many climbers onto ONE stratum → a large tight-sync rollback set (the 30-player
   worst case). Generation MITIGATES by always offering 2–4 spatially separated routes and by biasing
   `routeCount` up + boon-node placement to *spread* arrivals — but it cannot solve it alone. Netcode's
   AoI fog-banding + soft same-stratum spreading must finish the job. Flag every LIFT/choke as a
   `convergenceHint` in `StratumData` (sim-visible) so netcode can weight AoI.
2. **Live-state vs pure generation (sim `05` + rubber-banding `04`).** Generation places NODES
   (pickups, boon) and TIERS but MUST stay standings-agnostic to remain deterministic. The *values
   /offers* are resolved live by sim/boon systems. Other docs must own that resolution and keep it
   itself deterministic given the live state.
3. **Engineer bridge slots (roles `02`).** Generation deliberately leaves some gaps spannable ONLY
   by an Engineer build (with a worse fallback). Roles doc must ensure the build verb is deterministic
   and that the fallback is real, or crews missing an Engineer soft-brick. Validator guards the
   role-agnostic lower bound, not the *good* path.
4. **Collapse coupling (sim `05`, hazards `02`).** `collapseY` is authoritative sim state, but its
   *budget* per stratum comes from generation (`collapseTimeBudget(D)`). The collapse owner must read
   that field; generation must guarantee (via validator) the budget is beatable on the shortest route.
5. **Coalescence firewall (render `06`, determinism in `05`).** Renderer may ONLY read `.view`-namespaced
   fields + authoritative `collapseY`; it must never feed anything back into `StratumData`. The
   `StratumSimView`-omits-`.view` type rule is the enforcement and other docs should rely on it.
6. **Hash discipline (netcode + determinism, `05`).** Stratum `contentHash` becomes a CHECK-FRAME
   field; a mismatch means a generation desync (PRNG, ordering, or float leak). `05` owns the
   cross-browser PRNG/fixed-point/trig-LUT guarantees this generator depends on.

---

## 12. Open tuning knobs (defaults given; tune in playtest)

- `LOOKAHEAD = 3`, `N (biome length) = 8`, cell size `2.0`, footprint `24–40`, band `18–28`,
  `routeCount 2–4`, anti-repeat window `3`, `biomeIntensity` step `+0.15/cycle`,
  `D` time-constant `60`. All centralized in `genConfig.ts` (one file, all magic numbers) so balance
  is reproducible and diffable.
