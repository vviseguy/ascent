# ASCENT — decisions log & journey

The canonical record of how we got here and every locked decision. Read this to understand
*why* the design is what it is. Newest decisions append at the bottom. (Master spec = `00-master-vision.md`.)

## Where we started
The user wanted "a realtime game for medium sized groups" and asked how low-latency P2P works.
We explored topologies (mesh / star / authoritative), then netcode models (lockstep / **rollback
(GGPO)** / authoritative+prediction), and chose **rollback** for its instant local feel + tiny
(inputs-only) bandwidth at the target size (~8, up to ~30). The sibling shipped game
**Frequency** (`c:/Users/Jacob/Documents/Projects/frequency`, a P2P WebRTC party game) is the
proven base whose `src/net/` patterns (host/peer, single-reducer authority, deterministic
room-code→peerId, silent host-migration via generation ladder, PeerJS signaling + STUN/TURN)
we reuse/extend.

## The game (arrived at iteratively)
- **v1** (rejected): NPC enemies for tension, private per-crew floor instances.
- **v2** (rejected): terrain-first, but tower *collapsed/fragmented and fell* behind you.
- **v3 (current):** a **vertical escort brawl-race**. See `00-master-vision.md`. Persistent
  two-way tower (floors never vanish; you can fall/be-thrown *down* real floors).

## Locked decisions (chronological)

### Netcode & determinism
- **Rollback (GGPO-style)**, AoI centered on each crew's **Anchor** → bounded k≈5 tight-sync
  clusters. Inputs-not-state, redundant last-N frames over unreliable/unordered channels, shared
  tick counter (never wall-clock), seeded PRNG (never `Math.random`).
- **Per-peer-resource framing** (not aggregate O(n²)): egress/ingress/connections/CPU/memory each
  scale differently; relay fixes egress+connections, AoI fixes ingress+CPU; rollback depth is the
  **worst-peer** extreme-order statistic (heavy-tailed → plan for the tail, not the mean).
- **Kinematic verbs, no solver on the hot path** (the key determinism insight): carry =
  parent-socket teleport; throw = idempotent impulse keyed by `(entityId, releaseTick)`, charge
  from tick numbers not a float accumulator; rush = swept capsule. Grab-train capped ≤3 as a
  kinematic composite (the one multi-body spike).
- **BUILD OUR OWN deterministic physics engine** with **fixed-point** integer math (determinism
  by construction; sidesteps the unbounded cross-browser float/trig rabbit hole). **Rapier = test
  ORACLE only** (correctness check in tests/, never shipped). See `ENGINE-ARCHITECTURE.md`.
- **One spatial index, three consumers**: broadphase collision + AoI region-query-around-Anchor
  + render/coalescence cull. Disjoint per-stratum. Grid-vs-quadtree left behind a `SpatialIndex`
  interface to measure.
- Light anti-cheat that fits mesh rollback: hash **check-frames**, **commit-reveal** inputs,
  **input validation**. Honest limit: **detection, not prevention** (can't stop aim/wallhacks in
  a model where every peer simulates the world). Acceptable — terrain-first lowers the stakes.

### Game design
- **The Anchor is the game**: one per crew, standing = that Anchor's height only (no individual
  score). Collapses co-op and competition onto one axis. Anchor is a **full-capability** player who
  is just **heavy** (importance lives in physics + objective, not stat-nerfs). Plants the recall
  beacon (to-Anchor-height, never ahead).
- **Four Overcooked-clean verbs**: RUSH / GRAB / THROW / STRUGGLE, applied to everything.
  **Throw empty-handed = throw a punch** (always-available knockback / ring-out tool).
- **Grab slows you ∝ carried weight** (empty = full mobility; Anchor = max slow).
- **Mass hierarchy** Light < Player < Heavy < Anchor drives latch time / carry speed / throw force
  / struggle resistance.
- **Grab is a tempo tool, not a control tool**, held in check by 5 pressures (hands-full,
  struggle, encumbrance, grabber-is-prey, Bulwark-counter). Synthesis added: universal
  **bump-to-break** so a Bulwark-less crew isn't hard-countered; `MAX_HELPLESS` invariant.
- **Roles = advantage, not access**: everyone can walk/grab/throw/break/hold-buttons/struggle;
  specialists are faster/better/safer. Keeps solvability independent of crew composition.
- **Terrain-first, NO AI / no behavior trees**. Only **light scripted hazards** (pure functions of
  the tick). Big determinism win.
- **Persistent two-way tower**; **Smash-Bros position-kill** (you kill with the throw/ring-out, not
  damage). Regulars die on big falls; Anchor is fall-durable (altitude loss + downed beat; true
  death only at a kill-plane).
- **Pure race, no chase**; anti-turtling is structural (altitude-only score + gap-locked Anchor +
  bounded win conditions + rubber-banding re-bunching + forced contested-merge cadence).
- **Mario-Kart rubber-banding**; the diegetic blue-shell is *getting your Anchor thrown down*.
- **Shared tower, soft-separated by pace** (one shaft; collide at flashpoints).
- **Tunable per lobby**, hashed into the determinism seed: win condition (race-to-height /
  endless-highest / rounds-to-summit), lethality, Anchor-death, PvP intensity, crew size 3–5.
- **Authored-destructible** only (designated, telegraphed breakable / weight-sensitive tiles &
  objects — not free-deformable terrain).
- **Anchor rotation depends on game type** (competitive = rotated; casual = volunteered).

### Visual
- **Coalescence**: floors above = dotted wireframe "potential" resolving on approach
  (dots→lines→panels→lit); emerge up through floors; floors below persist (desaturate/fog, stay
  solid/reachable). Multiple routes per stratum. **Entire view layer is determinism-safe.**
- True 3D slight-tilt three-quarter (Hades). Maximal spectacle, but **readability > perf >
  spectacle**, and spectacle can never write to the sim.

### Level generation & solvability
- **Generate the guarantee, then dress it** (generalized maze-spanning-tree instinct): cell grid →
  gated traversal-edge spine → openness knob (labyrinth↔arena) → authored chunk dressing. Fully
  deterministic from `run-seed + stratum-index`. Clean-ish grid, visually de-boxed.
- **Independent VERIFIER** (don't trust the generator): pure graph reachability + max-flow route
  counting; fuzz across seeds; reproducible counterexamples. See `GENERATION-SOLVABILITY.md`.
- Config knobs: `gridSize`, `openness`, `guaranteedRoutes:k`, `gateWeights`, `biomeChunkSet`.

## Latest refinements (2026-05-31, this session — folded in)
1. **Timed gates ARE allowed on main/spine routes** (richer required gameplay), *because* of:
2. **Universal worst-case fallback guarantees solvability**: **every block is eventually breakable**
   + **players can always go around the edge/perimeter**. So the proof obligation moves to the
   **fallback layer** (treat all breakable blocks as passable + the perimeter route): that layer
   must connect entry→exit. That's still a clean *static* graph proof, always provable, and it makes
   catastrophic unsolvability **structurally impossible** regardless of timed-gate tuning. ⇒ we can
   **smoke-verify periodically** instead of exhaustively fuzzing every floor. (This supersedes the
   earlier "static spine only" call.)
3. **Co-op is a first-class main mode sometimes** (not only competitive). Track/floor **difficulty
   is tracked and tailored**; **harder tracks appear more readily at higher altitude** (difficulty
   scales with height).
4. **PvP / damage / weapons exist but are a SIDE QUEST**, not the core. The core stays physical
   grab/throw/terrain; weapons are light secondary flavor, never an "all-guns" game.

## Build progress (proven bricks)
Bottom-up; each layer has a standalone proof (`npm run prove` runs all). Proofs run
dependency-free via `node --experimental-strip-types`. (Strip-only mode forbids TS
`enum`/namespaces → use `const X = {...} as const` + a `type X` alias; use relative
`.ts` imports in `prove.ts` files.)
1. **Fixed-point bedrock** (`src/sim/fixed/`) — Q16.16 scalar+vector. PROVEN exact vs a
   BigInt oracle (~945k checks); deterministic sqrt/sin/cos.
2. **Floor gen + verifier** (`src/floor/`) — deterministic generator + INDEPENDENT
   reachability/max-flow verifier. PROVEN: 8820 floors across the knob space all solvable
   & route-counts met, byte-identical across runs.
3. **World core / rollback keystone** (`src/sim/world/`) — SoA state, FNV-1a hash,
   clone/restore, fixed-60Hz `step`. PROVEN: determinism, save/restore exactness, and
   rollback equivalence (340 forced rollbacks, 0 mismatches).
4. **Spatial index** (`src/sim/spatial/`) — one uniform grid serving broadphase +
   AoI + cull. PROVEN vs brute force.
5. **Collision / verbs / hazards** (`src/sim/{collide,verbs,hazards}/`) — terrain
   move-and-slide + body-body; the 4 verbs + 5 grab-pressures (verbs added 14 Int32
   tick-state fields to the world, wired into INT32_FIELDS); scripted hazards +
   fall-damage. Each PROVEN; built by a workflow, independently re-verified.
6. **Integrated sim** (`src/sim/sim.ts`, `src/sim/prove.ts`) — `Sim.advance()`
   composes all layers in the fixed order motion(1-4) → collision(3.5) → hazards(4.5)
   → carry(5) → verbs(6) → fall-damage. PROVEN: determinism + 300 forced rollbacks
   across grab/throw/hazards (0 mismatches) + liveliness. step.ts refactored into
   motionPhase/carryPhase (step() kept bit-identical; world proof still green).
7. **Playable slice** — `npm install` (three + dev types); full `tsc` typecheck PASSES;
   `npm test` 49/49; `vite build` succeeds. Renderer (`src/render/`, pure reader of
   the sim via toFloat), keyboard/mouse input controller, fixed-60Hz loop, a sandbox
   scene (arena + crew + Anchor + throwables + crusher), wired in `main.ts`. Run with
   `npm run dev`. Controls: WASD/mouse, J rush, K grab(release=throw), L struggle, Space.

Next: `src/net` (rollback manager, input bus mesh|relay, wire format, clock sync —
graft Frequency); wire real `src/floor` data into sim terrain; the cross-browser
"Two-Browser Grab Proof"; coalescence shaders; game rules (Anchor scoring, win
conditions, rubber-banding, boons).

## Parked (see `PARKING-LOT.md`)
- Anchor weight scaling with progress; Bulwark strength → reduced carry penalty.

## Build philosophy (the user's, adopted)
Isolate concerns; prioritize the **hard + isolatable** modules first and **prove** each before
layering on; accept some extra time for robustness. First provable bricks (high-risk +
high-isolation, independent → parallelizable):
1. **Fixed-point math bedrock** — owned directly, proven against a BigInt-exact oracle.
2. **Floor generator + verifier** — pure graph, fuzz-tested, zero deps.
3. **"Two-Browser Grab Proof"** spike — headless det. sim, identical hashes across engines + through
   forced rollbacks. (Later — proves/kills the rollback foundation.)
