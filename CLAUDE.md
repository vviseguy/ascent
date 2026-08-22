# ASCENT — contributor & agent guide

A realtime multiplayer **vertical escort brawl-race**. Browser game, TypeScript + Vite + Three.js,
**rollback netcode** over WebRTC, on a **custom deterministic fixed-point physics engine**. This
file is the map + the non-obvious rules that must not be reverted. Full design corpus in
[`docs/`](docs/) — see [`docs/README.md`](docs/README.md) for the index.

## Read first
- [`docs/00-master-vision.md`](docs/00-master-vision.md) — the canonical spec (genre, 12 pillars, resolved tensions, data flow).
- [`docs/DECISIONS-LOG.md`](docs/DECISIONS-LOG.md) — how we got here + every locked decision (start here for *why*).
- [`docs/ENGINE-ARCHITECTURE.md`](docs/ENGINE-ARCHITECTURE.md) — the custom physics engine (fixed-point; Rapier = test oracle only).
- [`docs/GENERATION-SOLVABILITY.md`](docs/GENERATION-SOLVABILITY.md) — the solvability invariant + the independent verifier.
- **Working on world generation / rendering?** → **[`docs/13-generation-architecture.md`](docs/13-generation-architecture.md) first** — the AS-BUILT map: every stage's file, output, invariant, gate, and BUILT-vs-DESIGNED status, plus a "you want to change X → touch Y" table. Then [`docs/16-generation-overhaul.md`](docs/16-generation-overhaul.md) for *why* the design is what it is (large parts of it are design-only — docs/13 §6 says which), and [`docs/14`](docs/14-terrain-puzzles-solvability.md) / [`docs/15`](docs/15-world-object-model.md) for puzzles + the WorldObject split.
- **Working on assets / colors?** → [`src/lab/CLAUDE.md`](src/lab/CLAUDE.md) (authoritative — the `recolor.ts` swatch system) + [`docs/ART-LAB.md`](docs/ART-LAB.md).
- **What to work on next** → [`BACKLOG.md`](BACKLOG.md) (the live queue) + [`docs/GAPS.md`](docs/GAPS.md) (the intent audit it draws from).

## Run / prove / test
```bash
npm install
npm run dev            # vite dev server (play the sandbox)
npm run typecheck      # tsc -b --noEmit
npm test               # vitest suite
npm run prove          # run EVERY determinism proof (14 of them; zero deps, Node 22+)
npm run build          # tsc -b && vite build (also the CI/Pages build)

# Asset Lab (browse/iterate KayKit models + colors in isolation):
npm run lab            # opens lab.html — turntable gallery + box-fit + recolor legend
npm run lab:snap -- <element>   # headless screenshot of one element (agents can see PNGs)
npm run probe:palette  # sample the real GLBs → which atlas swatch each triangle lands on

# Worldgen authoring pages (served by `npm run dev`, all under the /ascent/ base):
#   /ascent/tile-editor.html   paint a tile's 9 cells as DOMAINS + live corner-graph connectivity
#   /ascent/board.html         stamp room templates; watch commit vs rollback on overlap
#   /ascent/walltile.html      one WallTile → its tilePlacements → meshes   (4u, legacy)
#   /ascent/cell-editor.html   the 2u CELL editor: paint the point lattice + live 3D  ← author here
# NOTE: the in-app preview pane can't screenshot these (continuous rAF on a WebGL canvas).
# Use headless Playwright with --use-gl=swiftshader, like scripts/lab-snap.mjs does.

# Standalone proofs run WITHOUT installing anything (Node 22+, type-stripping):
npm run prove:fixed    # fixed-point math vs a BigInt-exact oracle
npm run prove:floor    # floor generator + solvability verifier fuzz
npm run prove:emergent # the all-emergent generator: determinism, totality, solvability, non-vacuity
# ...one prove:<layer> per sim layer; `npm run prove` chains them all. See package.json.
```

## THE non-negotiable rule: the simulation is deterministic
Rollback requires every peer to compute **bit-identical** results from the same inputs and to
re-simulate past frames. Therefore, inside `src/sim/` (and anything the sim touches — `src/floor/`
generation, `src/game/` tower compilation):

- **No floats. Ever.** Use `Fixed` (Q16.16) from `src/sim/fixed/`. Floats are for the render layer only.
- **No `Math.random`.** Use the seeded sim PRNG / coordinate hashes. **No `Date`/`performance.now()`**
  in the sim — it is driven by an integer **tick counter**. Wall-clock lives only in the transport layer.
- **No `Math.sin/cos/sqrt`** in sim math — use `fixed.ts` (deterministic floor-sqrt; fixed-point
  sin/cos). `Math.sqrt` is allowed *only* as the seed of the integer-corrected `isqrt`.
- **No `Map`/`Set` iteration on output-affecting paths.** Iterate sorted ids / packed arrays so order
  is fixed across engines.
- Everything lossy/nontrivial gets a **proof or property test** against an exact oracle (BigInt, or
  Rapier for physics correctness). See `src/sim/fixed/prove.ts` for the pattern.

The determinism discipline is also why the riskiest code is the most testable: the sim is headless and
pure, so it's provable without rendering or networking.

## The two sides (the hard boundary — see docs/15)
| | **SIM** (`src/sim`, `src/floor`, `src/game`) | **VIEW / AUTHORING** (`src/render`, `src/lab`) |
|---|---|---|
| style | data-oriented, no classes; flat typed-array SoA | object-oriented, composable (`WorldObject`) |
| rules | fixed-point, no float, no `Math.random`, deterministic iteration | floats + seeded randomness + OO all fine |
| authority | **owns gameplay** (proven, hashed, rollback-safe) | **reads the sim; never writes back** |

Cosmetic choices (which door texture, which prop variant) are **view-seeded by cell hash** and must
never feed back into the sim or the solvability verifier.

## Architecture
Build order was **bottom-up, prove each layer before the next**. Path aliases:
`@sim/* @net/* @render/* @game/* @floor/*` (see tsconfig + vite/vitest config).

```
src/sim/        deterministic simulation (no DOM, no net) — each layer has a standalone proof
  fixed/        ✅ fixed-point scalar + vector math (the bedrock, proven vs BigInt oracle)
  spatial/ collide/ verbs/ hazards/ breakable/ interact/ world/ + sim.ts
                ✅ one spatial index (broadphase + AoI + cull), move-and-slide, the 4 verbs +
                   5 grab-pressures, scripted hazards, breakables, interaction, integrated step().
                   world exposes the only API netcode needs: step / hash / clone / restore.
src/floor/      ✅ deterministic floor generation + INDEPENDENT solvability verifier (pure graph),
                   PLUS the 9-cell TILE substrate: wall-tile → wall-tile-field → tile-grid
                   (transactional) → room-templates/room-roles → floor-tiles → tile-place.
src/game/       ✅ tower compiler (floor → terrain + the WorldPlacement IR), strata, scoring,
                   win conditions, crew identity, beacons, roles/abilities.
src/render/     ✅ Three.js: vertical-follow camera, fog/occlusion cutaway, dungeon mesh builder
                   (view-only; reads the sim). Colors via the lab's recolor.ts engine (src/lab/CLAUDE.md).
src/lab/        ✅ the Asset Lab: KayKit catalog, box-fit collision voxelizer, the recolor engine,
                   WorldObject viewer + headless snapshot harness. (Authoritative guide: src/lab/CLAUDE.md.)
src/net/        ✅ rollback primitives + proofs (input bus, wire format, clock sync) — NOT yet wired
                   to a live 2-browser match (that's BACKLOG "Pressure + the race"). Grafts Frequency.
```

### ⚠ TWO SUBSTRATES right now — read docs/13 §0 first
A **2u CELL** model (`src/floor/cell*.ts`) is replacing the 4u tile model. It is complete through
generation and proven (`npm run prove:cell`), the authored structures are migrated onto it
cell-for-cell, it has meshes (`cell-place.ts`) and its own editor with a live 3D preview
(`/ascent/cell-editor.html`). What is NOT done is wiring it into `tower.ts` — the game still compiles
the 4u path below, so that is what it draws. Neither is deleted; nothing is half-converted.

A cell owns `{floor, wallN, wallW, corner, wallType}`. **The stored grid is the lattice of POINTS**,
not of cells: a w×h structure stores (w+1)×(h+1) entries, so it owns all four of its borders and
rotates losslessly. `wallN` is the edge running east from a point, `wallW` the edge running south,
`corner` the junction at it; only `floor` belongs to the cell south-east of it.

Two rules that keep biting if forgotten:
- **Abstaining ≠ asserting.** A full domain says "no opinion" and every later phase reads it as
  "help yourself"; a pinned `none` says "this is air". A room must SAY its interior is air or the
  maze carves through it.
- **`SETTLE_DEFAULTS` in `cell-field.ts` is shared** by the generator and the editor preview. Never
  preview with a bare `collapse` — it takes the canonical-lowest option, and the lowest floor
  material is `none`, so an unclaimed floor previews as a pit rather than the stone it becomes.

### The 4u worldgen pipeline (still what renders — read docs/13 before editing it)
```
Floor graph  (src/floor/generate.ts)   spines → openness → rooms → puzzles   → Floor
  → verify   (src/floor/verify.ts)     INDEPENDENT solvability proof (generator-blind)
  → tiles    (src/floor/floor-tiles.ts)  rooms stamp their ROLE's template onto a TileGrid of
                                          domains; resolveGrid collapses + owner-resolves; then
                                          reconcileDoors opens the ring where floor.edges connects
  → units    (src/game/tile-units.ts)   tilePlacements × FROZEN box-fit footprints + materials
  → IR       (src/game/tower.ts)        WorldPlacement[] — buildCellGrid is the ONE producer
  → render (src/render/dungeon.ts) + collision (src/game/tower.ts:emitWallsFromSlots)
                                        both branch off the SAME WorldPlacement.unit → match by construction
  → re-prove (src/game/route-check.ts)  Anchor route entry→top on the COMPILED AABBs (prove:game [7])
```
The 9-cell tile is the substrate: a wall owns its own 4u square as a "plus" of 9 cells
(4 outer `edge` + 4 `inner` + an additive `centre`). A tile owns only its **N + W** edges; E/S are read
from the neighbour, so adjacent tiles cannot disagree about a shared boundary. Piece names
(straight/corner/tee/cross/cap/column) are **derived labels**, never stored.

**Deleted 2026-06-30 — do not go looking for them:** `blueprint.ts`, `wall-style.ts`, `wall-model.ts`.
The abstract-piece pipeline they formed is gone; the tile lattice replaced it wholesale. History in
[`docs/archive/13-abstract-piece-pipeline.md`](docs/archive/13-abstract-piece-pipeline.md).

### Tracked debt — known, intentional, don't trip on it (full list in docs/13 §7)
1. **`room-roles.ts` has no test** — sim data (seeded hash → structure *and* dressing) with no gate.
   Highest-value next test.
2. **Interior-wall room templates are blocked** — every role lowers to a plain ring today, so tiling
   can never make a floor unsolvable. Aisles/cells/colonnades need `reconcileDoors` to carve a
   guaranteed path *through* the room interior first. Deferred on purpose, not forgotten.
3. **`wallMask` / `wallgrid.ts` still exist** — `wallgrid` is no longer a wall producer, only the
   source of the 4-bit `wallMask` the fog BFS + decoration read. Last remnant of the two-lattice debt.
4. **`profile` (FULL/LOW/GAP) is a 3D hook** — only collision height varies on it; everything
   underneath is per-stratum 2D. LOW-lip gate walls don't render as tile units yet.
5. **Frozen `unit.materials` is carried but not applied** — the renderer still recolors live by url.
6. **Recolor tables still live in `src/lab`** — the remaining `TODO(publish)` (docs/16 §10 Phase 2).

**Most of `docs/16` is DESIGN, not code** — sockets, tags, AC-3 collapse, the requirement queue, and
the Structure/Slot model are all unbuilt. `docs/13 §6` is the authoritative BUILT-vs-DESIGNED list.
Check it before assuming a mechanism exists.

## Conventions
- TS strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Use `import type` for types. Guard array index access.
- Standalone `prove.ts` files use **relative imports with explicit `.ts` extensions** so Node's
  `--experimental-strip-types` can run them dependency-free (`allowImportingTsExtensions` is on).
  Strip-only mode forbids TS `enum`/namespaces → use `const X = {...} as const` + a `type X` alias.
- Many small, well-named files with doc comments explaining the WHY. Quality and robustness over speed.
- Scratch/experiment files go in `tmp/` (gitignored). Don't commit them.

## Reuse from Frequency
The sibling shipped game `c:/Users/Jacob/Documents/Projects/frequency` proves the P2P/WebRTC layer:
host/peer roles, single-reducer authority, deterministic room-code→peerId, **silent host migration**
(generation ladder), PeerJS signaling + STUN/TURN. `src/net/` adapts these for rollback (REUSE the
connection lifecycle; REPLACE the host-authoritative loop with peer-symmetric rollback).
