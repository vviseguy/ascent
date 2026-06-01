# 06 — Art Direction & Shader Strategy (v3)

> Status: v3. Supersedes all earlier versions. Consistent with **vision bible v3**.
> Scope: visual identity, the Coalescence system, persistent floors-below treatment, physical-game VFX,
> GPU instancing, post stack, perf budget, and a per-technique confidence + fallback ladder.
> Audience: a senior graphics/gameplay engineer who will build this in **Three.js (WebGL2)**.
> Cross-refs: `01-game-design`, `02-roles-anchor-verbs`, `04-competitive-structure`,
> `05-netcode-architecture`, `07-ux-ui-gamefeel`, `08-audio`, `09-level-generation`.

---

## 0. Determinism contract (read first — this gates everything below)

**Rule: the view layer is a pure, read-only projection of sim state. Nothing rendered here feeds back into the sim.**

Per `05-netcode-architecture` the sim is a fixed-timestep **60 Hz** (`TICK_HZ = 60`, `DT = 1/60`) GGPO-style
rollback core: seeded PRNG (`xoshiro128**`, NEVER `Math.random()`), no wall-clock in the sim, a single
**tick counter** as the sim clock, AoI centered on each crew's Anchor. Art must never violate any of this:

- **No render output reaches the sim.** Raycasts for VFX placement, camera shake, particle spawns, bloom
  thresholds, fog — all derived FROM sim state, never the reverse. The sim never reads `performance.now()`,
  screen size, GPU timing, or frame delta (`performance.now()` is transport-only, per the netcode doc).
- **Animation/VFX clocks are sim-derived.** Every shader that animates (coalescence, fog drift, hazard tells)
  is driven by a uniform `uSimTick` (the shared tick counter) plus an interpolation alpha `uInterpAlpha`
  for smooth 60fps *display* between sim ticks. Wall-clock is permitted ONLY for purely-cosmetic,
  non-gameplay-readable motion (e.g. idle ambient dust) that no player decision depends on. When in doubt,
  drive from `uSimTick`.
- **Rollback is invisible to art.** On a rollback+resim, transforms snap to resimulated truth; the renderer
  re-interpolates from there. Fire-and-forget VFX (impact bursts) must be **reconstructable from sim events**,
  not stateful in the renderer — so a rolled-back-then-replayed THROW re-emits its impact deterministically
  rather than double-spawning. See §7.4 (event-sourced VFX).
- **All view-layer randomness is baked offline from a seed** (mirroring the sim's seeded-PRNG discipline) —
  never `Math.random()` at runtime, even in cosmetic code, so two clients render an identical world.
- **Determinism-safe confirmation:** every technique below is tagged **[VS]** (View-layer, Sim-safe) where
  purely cosmetic, or **[VS-event]** where triggered by a sim event but rendered client-side only. There are
  **zero** sim-affecting techniques in this document. Confirmed.

If a future effect needs to influence gameplay (e.g. fog actually blocking targeting), that decision lives in
`02-roles-anchor-verbs`/`05-netcode-architecture` and must be computed in the sim, then *mirrored* by art —
not invented here.

---

## 1. Visual identity

### 1.1 One-line target
**"Coalescing architecture in the void"** — a luminous, hand-built tower assembling itself out of light just
ahead of the climbers, dissolving into cold fog below them, populated by chunky, physical, instantly-readable
bodies. Hades' three-quarter readability + Monument Valley's clean architectural geometry + Gang Beasts' soft
tactile bodies, rendered with maximal but *legible* spectacle.

### 1.2 Camera & projection (locked by bible pillar 7)
- **Slight-tilt top-down / Hades three-quarter.** Perspective camera, FOV ~38–45°, pitch ~35–50° from
  horizontal. Far enough back to frame a crew cluster (AoI ≈ the crew's Anchor, pillar 12) plus the immediate
  route above/below.
- **Vertical lead bias:** camera frames ~60% above the crew centroid, ~40% below — you must see the route
  resolving above more than the fog below. Camera is a **view-only smoothed follow** of the sim-truth crew
  centroid (no sim feedback). Detailed camera grammar lives in `07-ux-ui-gamefeel`; this doc only constrains
  what the camera must *reveal*.
- The tilt sells "true 3D" while keeping top-down route legibility. Floors read as stacked horizontal planes;
  the tilt reveals their thickness and the chasms between them.

### 1.3 Palette

Three orthogonal color "channels" that must never collide in hue space, so the eye can always separate them:

| Channel | Role | Hue strategy | Saturation / Value |
|---|---|---|---|
| **Tower / architecture** | The world, routes, floors | Cool desaturated neutrals: slate-blue, basalt, pewter, plus one warm "resolved-and-lit" accent (sodium-amber) | Low sat, mid value when lit; this is the *stage*, never competes with players |
| **Crew identity** | The racing crews | Maximally-separated, high-chroma hues (see 1.4) | High sat, high value — these POP |
| **Hazard / danger** | All threats | Reserved **hazard-red → white-hot** + caustic chartreuse for "toxic/zone" | Highest value, often emissive + animated; danger owns the brightest reds, crews must avoid red |

The void/background is near-black with a subtle vertical gradient (cool indigo "potential" at top, deep black
"abyss" at bottom). The single warm accent (sodium-amber) is **earned**: it only appears on *fully resolved,
lit, walkable* surfaces — so warmth literally reads as "this is solid ground you can trust."

### 1.4 Crew color identity (the race-readability spine)

Default lobbies cap at **4 crews** for color crispness (bible allows crews of 3–5 *players*; this is about how
many *crews* share a shaft before hues crowd). Four hues chosen for **maximum mutual separation and colorblind
safety** (deuter/protan/tritan tested), each with a distinct value AND a hue-independent secondary cue:

| Crew | Primary hue | Hex (sRGB) | Secondary cue (hue-independent) | Beacon glyph |
|---|---|---|---|---|
| 1 | Azure | `#2FA8FF` | Diamond chevrons | ◆ |
| 2 | Marigold | `#FFB02E` | Triangle wedge | ▲ |
| 3 | Magenta | `#FF3FA4` | Circle / dot motif | ● |
| 4 | Mint | `#36E0A0` | Square / bar motif | ■ |

- Hazard-red is deliberately *not* a crew color, so "red = danger" is never ambiguous.
- Crew color appears on: a **rim-light** on every crew member (1.5), the **Recall Beacon** column, the Anchor's
  marker on the altitude rail (UI, see `07-ux-ui-gamefeel`), thrown-object trails, and **route-claim glows**
  (a route a crew is actively using gets a faint crew-tint underlight).
- For >4 crews (lobby flex, pillar 11) extend with hue rotation + a **pattern overlay** (stripes/checks) so
  identity survives even when hues crowd; default lobbies stay at 4 for crispness.

### 1.5 Material language & lighting

**Material philosophy: "matte bodies, emissive intent."** Bodies and architecture are mostly matte/soft
(cheap, readable, avoids spec noise on a tilted camera). *Meaning* is carried by **emissive** rims, glyphs and
edges — which also survive the fog and bloom beautifully.

- **Players & Anchors:** soft cheap wrap-lambert (not full PBR — see §6), high roughness, no metalness. Each
  body gets a **crew-color Fresnel rim light** so allegiance reads from any angle, even backlit or in fog.
- **The Anchor's "importance read"** (bible pillar 1 — heavy, precious, NOT helpless). Stacked techniques:
  1. **Scale & silhouette:** ~1.6–1.8× a regular body's footprint, low and wide (a "kept" shape — 1.6).
  2. **Idle emissive pulse** on a chest/core glyph, period locked to `uSimTick` (~2s "heartbeat") — reads as a
     living, valuable core. Pulse rate doubles when the Anchor is *downed/vulnerable* (pillar 4) to scream
     "pounce / scramble."
  3. **Persistent thin ground-decal halo** in crew color under the Anchor (a "this is the precious one"
     footprint), visible even when the body is occluded or grabbed.
  4. **Recall Beacon** is a tall crew-color light column planted at the Anchor — the single brightest
     crew-color feature, visible across the shaft (the rally point, pillar 1).
- **Roles** (bible pillar 8 — Runner/Scout, Bulwark, Mender, Engineer, Breaker, Anchor): each identity gets a
  **fixed silhouette class + a role accent shape** (1.6) so role reads pre-attentively. Role accent is a
  *desaturated* tint of a role-icon emissive (NOT a second hue channel — **role is shape-led, crew is
  hue-led**, so the two never fight).
- **Lighting model:** mostly **uniform ambient + 1 key directional** (above-front, motivating "light comes
  from the resolved tower") + **emissive-as-light fakes** (bloom does the heavy lifting). We avoid many dynamic
  lights (WebGL forward-rendering cost). A *resolved/lit* floor adds a cheap **fake area-glow** via an emissive
  gradient on its panel, not a real light. Hazards self-illuminate via emissive only.

### 1.6 Silhouette & readability rules (the law)

Everything must read **at a glance, at speed, through fog, under bloom.** Enforced rules:

1. **Shape = category, color = team, motion = state.** Category (player / Anchor / role / hazard / route /
   throwable) is carried first by **silhouette**; team by **hue**; current state (grabbed, encumbered,
   charging throw, vulnerable) by **motion / emissive animation**. No category may rely on color alone.
2. **Six role silhouette classes** (distinct at 32px): Runner = lean/tall/forward-leaning; Bulwark =
   broad/squat/wide-shoulder; Mender = rounded/haloed/floaty; Engineer = angular/toolbelt-bulky; Breaker =
   heavy-armed/asymmetric-mass; Anchor = low/wide/dense "kept" mass. A blacked-out silhouette test (§9) must
   still ID all six.
3. **Throwables read by mass-tier edge-color + size** (bible pillar 2 mass hierarchy): light objects = thin
   bright edge, small; heavy objects = thick amber-hot edge, large, with a faint "weight" ground-shadow.
   Edge-emissive intensity scales with throw-impact potential — heavier = hotter edge = "this will hurt."
4. **Grabbable affordance:** anything currently grabbable gets a subtle **interactable pip** (a small
   crew-neutral emissive tick) when a hand is in range — a Coalescence-consistent "potential" dot. View-only,
   driven by sim "is-in-grab-range" state.
5. **Hazards are red and telegraphed in advance** (pillar 3 — deterministic functions of the tick). The *tell*
   (windup) is a view-layer animation keyed off the same tick math the sim uses, so visual windup and actual
   strike are frame-locked. Never a surprise; always a readable countdown (§7.5).
6. **Contrast budget (the ordering law):** at any moment the brightest things on screen, in order, are:
   active hazard strike > Recall Beacons > crew rim-lights / Anchor core > resolving-floor materialization >
   everything else. If spectacle threatens this order, **spectacle loses** (we dim ambient/bloom on the
   loser). This ordering is a tunable set of emissive multipliers, validated by a "squint test" automated
   screenshot diff in CI (§9).

---

## 2. The Coalescence system (the signature)

> Bible pillar 7: floors **above** hang as dotted/glowing wireframe "potential" and **resolve** (dots → lines
> → panels → lit) as climbers approach; **players emerge up through a coalescing floor**. Floors **below
> persist** (do NOT fragment/fall — rejected). This section is the detailed Three.js plan. All **[VS]**.

### 2.1 The materialization state machine (per floor "stratum tile")

The tower is authored (`09-level-generation`) as a stack of **strata**; each stratum is a set of **route
tiles** (ramps/stairs/spires/lifts, pillar 7) plus floor panels. The geometry **exists in the sim from the
start** (a persistent, deterministic tower — pillar 4); **Coalescence is purely a render-time reveal of
geometry that is already simulation-real.** Critical consequence: a player can stand on / collide with a floor
whose render state is still "wireframe potential" — collision is sim-truth, the dotted look is cosmetic
anticipation. We bias the reveal to slightly *lead* the climbers so the lit state arrives just-in-time and the
"potential" look is rarely stood on; correctness does not depend on it.

Each tile has a scalar **`reveal` ∈ [0,1]**, computed each frame (CPU per-tile, cheap) from sim-truth positions:

```
reveal_target = saturate( (revealRadius - distanceToNearestClimber) / revealFalloff )
reveal        = damp(reveal, reveal_target, revealLerp, dtDisplay)   // view-only smoothing, NOT sim
```

`distanceToNearestClimber` uses the crew centroid + any climber in AoI (sim-truth). `revealRadius` /
`revealFalloff` are art constants. All inputs are sim-truth and the smoothing is view-only, so clients converge
to the same look without syncing `reveal`; brief divergence is purely cosmetic. **[VS]**

`reveal` maps to four overlapping phases (cross-faded, not hard-cut):

| Phase | reveal | Look | How |
|---|---|---|---|
| **Potential** | 0.00–0.25 | Dotted glowing wireframe ghost; cool indigo; breathes | Instanced point-sprites at mesh vertices + faint wire (2.2) |
| **Assembling** | 0.25–0.65 | Dots stretch into lines/edges; fragments slide/snap inward | Edge geometry fades in; vertex "gather" displacement (2.3) |
| **Paneling** | 0.65–0.90 | Solid panels fill between edges; surface "inks in"; still cool/unlit | Surface alpha + dissolve mask sweep; emissive low |
| **Lit** | 0.90–1.00 | Fully solid, warm sodium-amber accent on walkable tops, trustworthy | Emissive gradient ramps up; warm accent enabled |

The four phases blend via a single `reveal` uniform inside ONE shader (one material per tile-type), so there
are **no material swaps mid-reveal** — important for batching (§6).

### 2.2 Potential phase — dotted wireframe (Three.js)
- **Geometry:** the tile's final mesh, but render its **vertices as instanced point sprites** (`Points`, or
  better an `InstancedMesh` of camera-facing quads for control) plus a low-alpha `LineSegments` wireframe from
  the mesh edges.
- **Shader:** point sprites are soft circular dots (radial alpha in frag), cool indigo, emissive (bloom makes
  them glow as "potential"). A per-vertex pseudo-random phase from a **baked attribute** (`aBakedPhase`, NOT
  runtime random) drives a gentle `sin(uSimTick*k + phase)` bob + brightness twinkle.
- **Why baked phase:** no PRNG in the view path; identical across clients; free.

### 2.3 Assembling phase — fragments gather & snap (the hero moment)
Two layered techniques:
1. **Vertex "gather" displacement (vertex shader):** each vertex carries a baked **`aScatterOffset`** (its
   "exploded" start) and a baked **`aScatterDelay`** (stagger). We interpolate
   `pos = mix(finalPos + aScatterOffset, finalPos, smoothstep(0.25, 0.65, reveal - aScatterDelay))`, with an
   elastic overshoot on the last ~10% to sell the "snap." Fragments arrive in a wave. Dots (2.2) cross-fade out
   as edges/panels cross-fade in.
2. **Edge ignition:** `LineSegments` emissive ramps with reveal; a thin moving **"ignition line"** band travels
   along each edge (position = `f(reveal)`) so edges look *drawn* rather than faded.

All offsets/delays are **baked vertex attributes** → deterministic, no per-frame CPU, GPU-instanced. **[VS]**

### 2.4 Paneling → Lit — the materialization dissolve
- A **dissolve mask**: a baked noise texture thresholded by `reveal`. Below threshold = transparent / edge-glow;
  at the moving threshold a thin **hot rim** (white → amber) traces the in-filling boundary (the classic
  "materialize" rim). Above threshold = solid surface.
- As `reveal → 1`, the **warm sodium accent** emissive gradient on walkable tops ramps in (the "earned warmth").
- A subtle **fake contact-AO** gradient (baked into panel vertex colors, plus optional SSAO §7.2) grounds
  bodies on the new floor.
- **Walkable-edge highlight:** route tiles get emissive edge-piping in the *route's claiming-crew tint* when a
  crew is on them (1.4), so "whose route is this right now" reads from afar.

### 2.5 Players emerging UP THROUGH a coalescing floor (pillar 7, explicit)
On the sim event `FloorCross(up)` (a body crossing upward through a floor plane) we play a
**birth-through-the-membrane** effect, view-only:
- A **radial "porthole" dissolve** opens locally in the floor panel around the body's XY (the dissolve mask is
  locally pushed open — a ripple centered on the crossing point fed by sim XY), then closes behind them. The
  floor is never actually holed in the sim; route mouths are pass-through by design in `02-roles-anchor-verbs` /
  `09-level-generation` — this is the *visual* of that pass-through.
- A **vertical light shaft** + crew-color **ring pulse** emits upward from the crossing point (instanced ring
  particles, §5), so an emerging ally/rival is dramatic and *crew-readable* the instant they appear.
- For **rivals emerging through fog** (the soft-separated shared shaft, pillar 10) this shaft + crew ring is
  often the *first* sign of an incoming rival crew — a deliberate "they're here" tell.

### 2.6 Coalescence confidence & fallback ladder
| Layer | Confidence | Fallback if over budget / breaks |
|---|---|---|
| `reveal` distance field (CPU, per-tile scalar) | **High** | Trivial; cull tiles far from any climber to `reveal=0`, skip |
| Potential dots (instanced points) | **High** | Drop to plain `LineSegments` wireframe (no dots) → still reads "potential" |
| Vertex gather/snap (vertex shader) | **Med-High** | Replace with uniform-scale + alpha "pop-in" per tile (less hero, fully safe) |
| Materialize dissolve + hot rim | **High** | Replace dissolve with a vertical alpha-wipe (cheap, still "inks in") |
| Emerge-through-floor porthole | **Medium** | Skip the porthole ripple; keep the upward light-shaft + ring (the readable part) |

---

## 3. Persistent floors-below treatment (NOT fragmenting — rejected idea)

> Bible pillars 4 & 7: floors below **persist as solid, real, reachable places**; they **desaturate & fog with
> distance**; you can be **knocked/thrown back down into them**; rival silhouettes show through fog. We
> explicitly **reject** the old fragment-and-fall idea.

### 3.1 Depth-cue stack (all view-only, all reversible)
A single `belowDepth` factor per fragment (world Y vs camera/crew Y) feeds:
1. **Desaturation + value crush:** `color = mix(color, luminance(color) * coolTint, saturate(belowDepth*kDesat))`.
   Far-below floors go cool, grey, low-contrast — *present but receded*. We **never fully hide** them (they're
   reachable): desaturation is floored at ~0.8 so a thrown-down player can still parse where they landed.
2. **Height / volumetric fog:** analytic **exponential height fog** (cheap, shared lib shader) tinted
   cool-indigo, density increasing downward. For maximal spectacle, layer a faked **volumetric god-ray/shaft**
   band (a few large additive screen-aligned quads with scrolling baked noise) drifting in the lower shaft —
   "the abyss breathes." Pure cosmetic, gameplay-irrelevant.
3. **Translucent floor planes & parallax depth (pillar 7):** floors render with slight **edge-translucency**
   (alpha falloff toward panel interiors via Fresnel) so you see *through the stack* into the depths — layered
   floor edges create real parallax as the camera tilts/moves ("look down the shaft and see history"). Sort
   back-to-front per stratum (few large planes → cheap transparency).
4. **Rival silhouettes through fog:** bodies below get an **emissive crew-color rim that is fog-immune** (the
   rim is applied *after* fog in the shader, attenuated but never fully killed). A rival crew far below reads as
   faint colored glints in the murk — atmospheric AND tactically informative (pillar 10). Anchors below keep
   their ground-halo + beacon column piercing up through fog (a far-below Anchor's beacon is a thin colored
   line rising out of the mist — gorgeous and useful).

### 3.2 "Knocked back down into" drama (Smash-Bros position-kills, pillar 4)
When a body falls / is thrown down through strata:
- A **motion-streak trail** (crew-tinted, instanced ribbon, §5) makes the fall arc read.
- **Fog punch-through:** the falling body's fog attenuation is briefly reduced (a view-only "spotlight on the
  victim") so the drama stays visible into the murk — you watch your Anchor disappear downward but stay legible
  long enough to feel the altitude loss (pillar 6 — the diegetic blue-shell).
- On the **vulnerable/downed beat** after a non-lethal Anchor impact (pillar 4): core-pulse doubles, a
  crew-color **distress ring** pulses on the ground, and the landing floor briefly **over-lits** (a "scramble
  here" stage-light) to draw the crew's eye to the rescue.
- True kill-plane (hazard / off-the-bottom): one decisive **ring-out flash** + the body's emissive blows out to
  white then cuts — clean, Smash-style, unmistakable.

### 3.3 Floors-below confidence & fallback
| Technique | Confidence | Fallback |
|---|---|---|
| Desaturation / value crush (per-frag) | **High** | n/a — trivial |
| Analytic height fog | **High** | n/a — standard |
| Faked volumetric god-rays | **Medium** | Drop additive shaft quads; keep height fog only |
| Translucent parallax floor planes | **Med-High** | Make floors opaque past N strata down (cull transparency depth) |
| Fog-immune rival rim | **High** | Keep; cheap and load-bearing for readability |
| Fall punch-through spotlight | **High** | Keep (per-body fog scalar) |

---

## 4. Physical-game VFX (the tactile read — bible pillar 2)

Every verb and grab-pressure needs an unmistakable, snappy tell. These are **[VS-event]**: triggered by sim
events, rendered client-side, reconstructable on rollback (§7.4). The four verbs are RUSH / GRAB / THROW /
STRUGGLE per `02-roles-anchor-verbs`.

| Moment | Visual tell | Notes |
|---|---|---|
| **RUSH (dash)** | Forward **speed-lines + ground-scuff dust** at launch; brief body stretch (anim); crew-tinted afterimage (2–3 ghost quads) | Reads as commitment; afterimage length ∝ dash distance |
| **GRAB (latch)** | A **snap-connect arc** (short crackling line) hand→target + a **grab-ring** clamp on the target; target gains a "held" desaturate-flicker | Arc color = grabber's crew |
| **THROW (aimed release)** | **Charge:** growing dotted aim-arc (Coalescence-consistent) + held object's edge heats up (mass tier). **Release:** muzzle-style burst + crew-tinted streak trail | Aim-arc is a *cosmetic mirror* of the sim's deterministic trajectory, not a separate calc |
| **STRUGGLE (mash-break)** | Escalating **strain shards** off the grab point; grab-ring cracks; on break, a **snap-release pop** + both bodies recoil-flash | Shard rate ∝ struggle mash rate (sim-provided) — "faster the harder you fight" (pillar 2b) |
| **ENCUMBRANCE (carrier slow)** | **Weight-sag posture** (anim), **strain aura** at feet, heavier footfall dust; carrying the **Anchor** = max effect + a crew-color **drag-furrow decal** | The "slow & exposed" read (pillar 2c) is mostly posture + furrow — legible top-down |
| **IMPACT (object/body hits)** | **Mass-tiered:** light = small spark puff; heavy = big dust-ring + screen-space shockwave ripple + camera kick (view-only); Anchor-impact = biggest, with a ground-crack decal | Camera kick is cosmetic, amplitude-capped, never affects input-frame correctness |
| **HELD-PLAYER WRIGGLE** | Held body jitters + adds spoiler "noise" to the thrower's aim-arc (the arc wobbles) | Cosmetic mirror of the sim's aim-spoil (pillar 2: wriggle spoils aim) |
| **BULWARK body-block / grab-break** (pillar 2e) | A **shield-flare** ring in Bulwark's crew color at the block point; broken grab emits the snap-release pop | The hard-counter must *look* hard — brightest defensive flash in the game |
| **MENDER heal/shield/revive** (pillar 8) | Soft crew-color **tether beam** + gentle pulsing aura; revive = upward bloom + ring | Calm, rounded — distinct from the angular combat VFX |
| **ENGINEER build** (ramps/bridges/blocks) | Built geometry uses the **Coalescence materialize shader** (§2.4) in the engineer's crew tint, fast-forwarded | Reuse! Built terrain coalesces just like the tower — unifies the language |
| **BREAKER clear** (destructibles) | Reverse-coalescence: panels **dissolve to fragments → fade** | Destructibles are explicitly breakable in `02-roles-anchor-verbs`; they MAY visually shatter — distinct from persistent tower floors (see §10.6) |

**Spectacle governance:** all of the above route through the **VFX priority/budget manager** (§5.3) so a 4-crew
chokepoint brawl can't exceed particle/draw ceilings. High-priority readable tells (grab-break, ring-out,
Anchor-impact) preempt ambient/low-priority puffs.

---

## 5. GPU instancing & particles

### 5.1 What gets instanced (and why)
- **Throwable world objects** (crates/debris/barrels/built blocks — pillar 2): one `InstancedMesh` per mesh
  archetype; per-instance attributes = transform (from sim, interpolated), crew-tint (when held/thrown),
  edge-heat (mass tier), reveal (if a built object is coalescing). A single draw call for *all* crates on
  screen.
- **Coalescence potential-dots:** instanced point quads (§2.2).
- **All particle systems:** instanced quads via one custom particle pipeline (below).

### 5.2 Particle system architecture (deterministic-safe, CPU-light)
- Particles are **fire-and-forget, event-spawned** (§7.4) and live entirely view-side. We use
  **InstancedMesh particle pools** (pre-allocated, ring-buffered) with per-instance attributes
  `(aSpawnTick, aLifetime, aPos0, aVel, aAccel, aColor, aSize0, aSizeEnd, aKind)`.
- **Sim-tick-relative animation:** a particle's age = `(uSimTick + uInterpAlpha) - aSpawnTick`; its motion is an
  **analytic (closed-form) function of age** in the vertex shader — no per-particle CPU update, no per-frame
  state. The key trick: closed-form means (a) it's cheap, (b) a rollback that re-spawns a particle yields the
  *identical* look, (c) no GC churn.
- **Pools per category** (dust, sparks, rings, shards, trails) so we can budget & preempt independently.
- **Ribbon trails** (throw streaks, fall streaks, dash afterimages) are a small instanced-strip system, also
  closed-form from `aSpawnTick` + the body's sampled (interpolated) path.

### 5.3 VFX priority / budget manager
Global ceilings (§8). Each spawn request carries a **priority** (readable-tell > drama > ambient). When a pool
nears full, low-priority requests drop first; high-priority requests evict the oldest low-priority instance.
This keeps a 4-crew melee within budget while *guaranteeing* the gameplay-critical tells (grab-break, ring-out,
Anchor-impact) always render.

### 5.4 Confidence & fallback
| Technique | Confidence | Fallback |
|---|---|---|
| InstancedMesh for throwables | **High** | n/a — core Three.js |
| Closed-form instanced particles | **Med-High** | Reduce per-emit counts via a global `particleQuality` scalar (1.0→0.3); pools auto-shrink |
| Ribbon trails | **Medium** | Replace with a short instanced-quad afterimage (cheaper, still reads) |
| Priority/budget manager | **High** | Kept even in fallback — it's the safety net |

---

## 6. Materials & shader inventory

We keep a **small set of über-shaders** (branch via `#define`/flags) to maximize batching and minimize material
count:

1. **`BodyMaterial`** — players/Anchor. Cheap wrap-lambert + crew **Fresnel rim** (fog-immune term) + emissive
   glyph channel + held-flicker + vulnerable-pulse. Driven by `uSimTick`; per-instance crew/role/state.
2. **`TileMaterial`** (the big one) — all tower/route/built geometry. Contains the **full Coalescence state
   machine** (`reveal` → potential/assemble/panel/lit) + dissolve mask + warm-accent ramp + edge piping + the
   **persistent-below depth stack** (desaturate + height-fog + edge-translucency). One material, many tiles,
   instanced/batched per archetype.
3. **`HazardMaterial`** — emissive red animated tells; windup driven by the **same deterministic tick math** the
   sim uses (§7.5), so visual and mechanical strike are frame-locked.
4. **`ParticleMaterial`** — closed-form instanced particles (§5.2), `aKind`-branched.
5. **`FogVolumeMaterial`** — additive god-ray/shaft quads (§3.1).
6. **`BeaconMaterial`** — Recall Beacon light columns + Anchor halos (crew-tinted, bloom-feeding).

All custom shaders are Three.js `ShaderMaterial` / `onBeforeCompile` patches sharing a **common GLSL chunk lib**
(`shaders/lib/`): `fog.glsl`, `crewColor.glsl`, `dissolve.glsl`, `simTime.glsl`, `rim.glsl`. **Single source of
truth** for fog/crew/time math so the look is consistent and tweakable in one place. Lighting is deliberately
cheap (1 directional + ambient + emissive-as-light) to stay in WebGL forward-rendering budget.

---

## 7. Rendering pipeline & post stack

### 7.1 Renderer
- **Three.js WebGL2**, single forward pass, `WebGLRenderer` with `powerPreference:"high-performance"`,
  hardware antialias off (we AA via post — 7.3), an HDR half-float render target so bloom & color-grade behave.
- **Render order:** opaque tower/bodies → transparent floor planes (back-to-front per stratum) → particles
  (additive, last) → post.

### 7.2 Post-processing stack (maximal-but-budgeted)
Prefer **`pmndrs/postprocessing`** over raw `EffectComposer` — it merges effects into fewer passes (fill-rate
win):

| Pass | Purpose | Confidence | Fallback |
|---|---|---|---|
| **Bloom** (selective/threshold) | The soul of the look — emissive coalescence, rims, hazards, beacons glow | **High** | Single-pass cheap bloom; fewer mips |
| **Color grade / tonemap** (ACES-ish + LUT) | Lock palette mood; cool-shadow / warm-lit split-tone | **High** | LUT-only, skip tonemap curve |
| **SSAO** | Ground bodies on floors, add architectural depth | **Medium** | Baked/vertex fake-AO (§2.4); first to cut on weak GPUs |
| **DOF** (gentle, far-below only) | Push the abyss back, focus the crew's stratum | **Low-Med** | Drop entirely; height-fog already separates depth |
| **FXAA or TAA** | Edge cleanup (esp. thin wireframes/dots) | **Med** (TAA risks ghosting in brawls) | FXAA default; TAA optional, off during high-motion |
| **Vignette + subtle chromatic fringe** | Frame focus, spectacle polish | **High** | Trivial; cut chroma on "reduce motion" |

**Tunables exposed (lobby/perf, pillar 11):** bloom intensity, `particleQuality`, SSAO on/off, DOF on/off, fog
density, `motionReduce` (kills shake/chroma/heavy trails for accessibility). All in one `RenderConfig` the
renderer reads each frame — **never the sim**. (UI/accessibility surface for these lives in `07-ux-ui-gamefeel`.)

### 7.3 Anti-aliasing note
Thin wireframe dots/lines in the Potential phase alias badly. Plan: render at a modest internal supersample
(1.25–1.5×) when budget allows + FXAA; expose a resolution-scale slider. TAA is optional and auto-disabled
during high-motion frames (motion magnitude known from sim velocities, view-only) to avoid brawl ghosting.

### 7.4 Event-sourced VFX (rollback-correct)
VFX/particles spawn from **sim events** carried in a per-frame event list (e.g. `Grabbed`, `Thrown`, `Impact`,
`FloorCross`, `GrabBroken`, `RingOut`). The renderer either (a) consumes events **for the authoritative
post-rollback frame** only, or (b) tags speculative spawns with the producing tick and **reconciles on
rollback** (discard speculative VFX whose tick was rolled back and not reproduced; keep/re-add those
reproduced). Because particles are closed-form from `aSpawnTick` (§5.2), reproduction is exact, so rollback
never causes double-bursts or ghost VFX. **Confirmed determinism-safe.** This is the one place view code must be
*rollback-aware*; it consumes the sim's event list + rollback signal, it never produces them (coordinate with
`05-netcode-architecture`).

### 7.5 Hazard tells frame-locked to sim
Hazards are deterministic functions of the tick (pillar 3). The **windup animation phase = the same `f(tick)`**
the sim uses to decide strike timing (shared in `02-roles-anchor-verbs` / `09-level-generation`). The shader
receives the hazard's `cycleTick`/`period` and renders the telegraph so "danger imminent" and the mechanical
strike are the *same number*. Zero desync between look and rule. **[VS]**

---

## 8. Performance budget (60 fps target)

Target: **60 fps on a mid-tier 2021 laptop iGPU / discrete entry GPU**, 1080p, in a worst-case **4-crew
(≤20 players, relay ceiling per netcode doc) chokepoint brawl**. Headroom design, not max-out.

| Resource | Ceiling (worst-case scene) | Rationale / how |
|---|---|---|
| **Draw calls** | **≤ 250** | Über-materials + InstancedMesh collapse throwables/particles/tiles to a handful; bodies batched per archetype; post is fixed cost |
| **Triangles** | **≤ 1.2 M** on screen | Chunky low-poly bodies (~2–4k each, ×~24 bodies ≈ 96k); architecture is large flat panels (cheap); throwables low-poly instanced; far-below strata → impostor planes |
| **Particles (live)** | **≤ 12,000** instanced quads | Pools + priority manager (§5.3); closed-form → ~draw + vertex cost, near-zero CPU |
| **Dynamic lights** | **1 directional + ambient** | Everything else is emissive + bloom fakes |
| **Post passes** | **≤ 6**, merged where possible | `pmndrs/postprocessing` merge; SSAO/DOF first to cut |
| **Render-thread CPU/frame** | **≤ ~6 ms** | View interpolation + instance-attribute uploads only; no physics, no hot-loop allocation (pre-allocated pools) |
| **GPU/frame** | **≤ ~12 ms** | Margin under 16.6 ms; bloom + transparency fill-rate are the main spend → resolution-scale slider is the relief valve |
| **Texture / VRAM** | modest | Few large atlases (body/role/glyph, noise/dissolve, LUT); no per-object textures |

**LOD / culling**
- **Above:** tiles at `reveal≈0` (no climber near) render as cheap dots-only or skip; full materialize cost only
  near climbers (AoI-bounded — naturally matches the per-Anchor AoI of `05-netcode-architecture`).
- **Below:** past N strata down, collapse a whole stratum to a **single fogged impostor plane** (persistent &
  reachable but not interacted-with → cheap), re-inflating if a body falls toward it.
- **Frustum + AoI cull** everything; the tilt-topdown camera sees a bounded slab of the shaft at once.

**Profiling gates (§9):** headless capture of the canonical worst-case scene asserts draw-call / triangle /
frame-time ceilings; regressions fail the build.

---

## 9. Tooling, QA & "readability is a test"
- **Squint test in CI:** render canonical scenes (crew melee, far-below rivals, hazard windup, Anchor-downed),
  apply heavy blur, assert the **contrast-priority ordering** (§1.6.6) via luminance bucketing. Catches
  "spectacle ate readability" regressions automatically.
- **Silhouette test:** black-fill all bodies; assert the six role classes + Anchor are distinguishable
  (template-match vs reference silhouettes).
- **Colorblind sim pass:** auto-run deuter/protan/tritan filters over crew-identity scenes; assert separation
  holds (this is *why* every crew has a hue-independent secondary cue, 1.4).
- **Determinism guard for art:** a lint/test that fails if any module under `sim/` imports from `render/`, or if
  `performance.now()` / `Math.random()` appears in `sim/` (mirrors `05-netcode-architecture`'s rules; the
  seeded PRNG and tick clock live in sim only — art uses baked attributes + `uSimTick`).
- **Perf gates:** §8 ceilings asserted headlessly.

---

## 10. Open tensions & risks (honest)
1. **Spectacle vs readability** is the permanent tension. Resolution: the **contrast-priority law (§1.6.6)
   wins, enforced by the squint test (§9).** When maximal-spectacle and legibility conflict, we dim spectacle —
   a real constraint on how loud the abyss/coalescence can get during a 4-crew brawl.
2. **Transparency cost** (parallax floors + god-rays + additive particles) is the top fill-rate risk on iGPUs.
   Mitigation: stratum impostors below (§8), resolution-scale slider, transparency-depth cull. *Confidence the
   full stack hits 60fps on the weakest target: Medium* — hence the aggressive fallback ladders. The fallback
   path (opaque-below, height-fog-only, no DOF/SSAO, reduced particles) is **high-confidence 60fps** and still
   looks good.
3. **TAA ghosting vs aliasing on Potential dots.** Thin glowing dots want TAA; brawls want no ghosting.
   Resolution: supersample + FXAA default, TAA optional & motion-gated (§7.3). A slight tension we accept.
4. **Rollback + event-sourced VFX** must be wired so speculative bursts reconcile (§7.4). Closed-form particles
   make this tractable, but it's the one place view code must be rollback-aware. Flagged for
   `05-netcode-architecture` coordination — the view consumes the sim's event list + rollback signal; it never
   produces them. **Determinism-safe by construction, but needs an integration test.**
5. **"Earned warmth" relies on disciplined emissive budgeting** — if too many things glow warm, the "solid
   ground = amber" semantic collapses. Enforced by reserving sodium-amber exclusively for `reveal≥0.9` walkable
   tops (1.3, 2.4).
6. **Deviation flag:** none from the bible. All four rejected ideas (fragment-and-fall floors, NPC/AI, rising
   wall-of-death, color-only identity) are explicitly avoided. **Built objects (Engineer) and designated
   destructibles (Breaker) DO visually assemble/shatter** — this is consistent with the bible (they are not
   persistent tower floors) and is called out in §4 to avoid confusion with the no-fragment-floors rule.

---

## Appendix A — Uniform / attribute conventions (for the implementing engineer)
- **Global uniforms** (set once/frame, view-only): `uSimTick` (int, shared tick), `uInterpAlpha` (0..1 between
  ticks), `uCameraY`, `uFogParams`, `uBloomConfig`, `uRenderConfig` (quality scalars).
- **Per-instance (bodies):** `aCrewColor`, `aRoleId`, `aStateBits` (held / encumbered / charging / vulnerable /
  downed), `aEmissivePulsePhase` (baked).
- **Per-vertex (tiles):** `aScatterOffset`, `aScatterDelay`, `aBakedPhase`, `aWalkableMask`.
- **Per-instance (particles):** `aSpawnTick`, `aLifetime`, `aPos0`, `aVel`, `aAccel`, `aColor`, `aSize0`,
  `aSizeEnd`, `aKind`.
- **All view-layer randomness is baked offline from a seed** (matching the sim's seeded-PRNG discipline) —
  never `Math.random()` at runtime.

## Appendix B — Build order (de-risk first)
1. `TileMaterial` Coalescence state machine on static geometry (proves the signature look).
2. `BodyMaterial` + crew rim + Anchor importance read (proves race readability).
3. Persistent below: desaturate + height-fog + fog-immune rival rim (proves the depth fantasy).
4. Closed-form instanced particle system + priority manager (proves brawl spectacle within budget).
5. Event-sourced VFX wired to sim events + rollback reconciliation (proves determinism integration —
   coordinate w/ `05-netcode-architecture`).
6. Post stack + perf gates + readability CI tests (locks the budget & the law).
