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
- **Working on assets / colors / the lab?** → [`src/lab/CLAUDE.md`](src/lab/CLAUDE.md) — the area router. It points at the four deep docs: [`MATERIALS.md`](src/lab/MATERIALS.md) (authoritative for colour + surface: the swatch cascade, the tiling shader, profiles, the approval freeze), [`INSTRUMENTS.md`](src/lab/INSTRUMENTS.md) (the `calibration` / `gradient` test textures + `seam-scan.mjs` — measuring a surface rather than choosing one), [`SURFACES.md`](src/lab/SURFACES.md) (per-triangle mesh editing), [`TOOLING.md`](src/lab/TOOLING.md) (drawers, contact sheet, headless measurement). [`docs/ART-LAB.md`](docs/ART-LAB.md) covers the separate PROCEDURAL element catalog.
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
npm run sheet          # opens sheet.html — EVERY object on one grid under one material profile
npm run tex:seams      # is a texture actually tileable? scores every public/textures/*_diff
npm run stores:check   # before committing: is a tracked authoring store dirty vs HEAD?
npm run lab:snap -- <element>   # headless screenshot of one element (agents can see PNGs)
npm run probe:palette  # sample the real GLBs → which atlas swatch each triangle lands on

# Worldgen authoring pages (served by `npm run dev`, all under the /ascent/ base):
#   /ascent/tile-editor.html   paint a tile's 9 cells as DOMAINS + live corner-graph connectivity
#   /ascent/board.html         stamp room templates; watch commit vs rollback on overlap
#   /ascent/walltile.html      one WallTile → its tilePlacements → meshes   (4u, legacy)
#   /ascent/cell-editor.html   the 2u CELL editor: paint the point lattice + live 3D  ← author here
#   /ascent/cell-snap.html     the 2u pipeline rendered ONCE, for screenshots (no controls, no rAF)
#   /ascent/sheet.html         the material CONTACT SHEET (every object, one profile, live re-bake)
# NOTE: the in-app preview pane can't screenshot the EDITOR (continuous rAF on a WebGL canvas).
# cell-snap.html exists for exactly that reason — it renders one frame and stops:
npm run cell:snap -- structure "walled stairs"      # one authored structure, framed on its meshes
npm run cell:snap -- all --turns                    # every structure x all 8 orientations
npm run cell:snap -- floor 36x28 --seed=3 --focus=30,11,7   # a generated floor, zoomed on one cell
npm run cell:snap -- structure "walled stairs" --stack=3    # storeys stacked: does a flight REACH?
npm run cell:snap -- demo caps --size=1800x1250 --angle=90 --pitch=76   # EVERY place a wall can stop,
#   sixteen captioned cases on one board — the visual gate on the wall-finishing rule (`wallEnds`).
npm run editor:snap -- "walled stairs" --levels=2 --level=1 # the AUTHORING surface (needs `npm run dev`)
# --angle/--pitch/--zoom move the camera; a ground ruler shows the 2u cells so an off-by-half-a-cell
# placement is visible. It WARNS when a mesh failed to load, so a red placeholder box is never a
# mystery. Output: cell-shots/ (gitignored).

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
A **2u CELL** model (`src/floor/cell*.ts`) has replaced the 4u tile model **as the default**. It is
proven (`npm run prove:cell`), the authored structures are migrated onto it cell-for-cell, it has
meshes (`cell-place.ts`) and its own editor with a live 3D preview (`/ascent/cell-editor.html`).

**`?substrate=4u` still selects the tile lattice** and PROOF 8 still proves it — the two are complete
alternative producers of the same IR, not a half-conversion, and neither is deleted. What moved the
default was **PROOF 9**: a route check alone was never enough, because it cannot see a body wedge
somewhere the graph calls open, so PROOF 9 drives a real Anchor along the route the CHECKER found and
up the stairs. The 2u path is much heavier — ~12.5k meshes against 300, 43k solids against 5.7k — and
instancing the walls is the open lever.

A cell owns `{floor, wallN, wallW, corner, wallType, open, torch}`. **The stored grid is the lattice of POINTS**,
not of cells: a w×h structure stores (w+1)×(h+1) entries **per STOREY**, so it owns all four of its
borders and rotates losslessly. `levels` (absent = 1) stacks those lattices FLOOR_HEIGHT apart, which
is how a staircase says there is a hole in the ceiling above it. `generateEmergentTower` builds the
whole stack at once so a structure can span storeys, and **guarantees a stairwell starts on every
storey below the top** (`stats.storeysWithoutStairwell` is the alarm).

`src/game/cell-tower.ts` compiles those floors into the SAME IR the 4u compiler produces — both meet
at `StratumCellGrid.wallPlacements`. `cell-tower.test.ts` proves the 2u tower on its own terms (every
shaft open, summit route holds across seeds, plus a negative control).

`wallN` is the edge running east from a point, `wallW` the edge running south, `corner` the junction at
it; only `floor` belongs to the cell south-east of it. **`corner` says only what STANDS there**
(`none | column | balcony`) — passability comes from the wall type alone (`isOpenType`), because when
both had a say they disagreed. `torch` is a flag whose FACING is sensed from the walls, never stored.

`wallType` says WHAT A PIECE IS (arch, window, cracked…) and `open` says whether it has a hole, so
the open/closed pairs the kit ships are one type plus a bit rather than two enum entries that happen
to follow a convention.

**DRAWN and WALK-THROUGH are different questions, and conflating them cost eleven wall types.**
`moduleAt` asks whether a 4u module is drawn at a point — any non-`solid` type with wall either side
and real ground under it. `openingAt` asks whether you can walk through it, and is what `cell-graph`,
`cell-reach` and the verifier use. When one function answered both, `WALLTYPE_URL`'s only caller was
gated on passability, so painting `cracked` or `window_barred` produced a blank wall. Emission and
suppression must both ask `moduleAxis` — two hand-written conditions had already drifted apart on
`rock` cells and on points live on both axes.

**Three things are derived, never written down twice**: a stair flight's direction and mesh, an
opening's axis, and a torch's facing. Each is read from the walls at draw time. Anything that is a
fact about the walls belongs to the walls.

**WALLS ARE LAID IN A STRICT PRIORITY ORDER, and the order is what makes the rule safe.** The baseline
is one 2u half-wall on every asserted edge; everything else is an optimisation over it, taken only
where it collides with nothing already claimed:
1. **SPECIALS** — a 4u module (window / arch / doorway / cracked / gated / scaffold / pillar-wall) and
   a walled flight's own sides claim their edges first. They are irreplaceable; nothing may compete.
2. **NUBS** — `wallEnds` is the authority on where a wall actually stops. An ordinary end is
   SHORTENED (`wall_half_endcap` replaces the last half, so nothing protrudes); an end whose last
   piece cannot be shortened — a module, or a one-edge run that already spent its edge on its other
   end — is TERMINATED with `wall_endcap_short`, a 0.267 flourish, and gets no collision because it
   overhangs past what the walls assert.
3. **BENDS, then RUNS** — `wall_corner` and the 4u `wall` are merges. Drop them and the wall is still
   whole, just made of more pieces. Which is why a two-edge L comes out as two finished halves and no
   mitre: finishing an end is irreplaceable and a bend is not.

A **T-junction is a normal wall** — plain stone, no aperture — so it is just baseline edges meeting and
needs no case of its own. `wall_Tsplit` / `wall_crossing` stay unused: they consume arms the runs
through them also want, and getting that wrong leaves a GAP rather than an ugly join.

Three rules that keep biting if forgotten:
- **Abstaining ≠ asserting.** A full domain says "no opinion" and every later phase reads it as
  "help yourself"; a pinned `none` says "this is air". A room must SAY its interior is air or the
  maze carves through it.
- **"Is there a wall here?" ≠ "does THIS PASS draw it?"** `edgeDrawnBy` returns who owns each edge —
  `none` / `run` / `module` / `flight` — because when it returned a bare null for all four, the arm
  count read a run that stopped at a doorway as a run stopping in mid-air and capped it into the
  aperture. A quarter of every floor's openings had a full-height stub in them. The same four answers
  are now also the priority tiers, so "who owns this edge" and "who may claim it" is one question.
- **`SETTLE_DEFAULTS` in `cell-field.ts` is shared** by the generator and the editor preview. Never
  preview with a bare `collapse` — it takes the canonical-lowest option, and the lowest floor
  material is `none`, so an unclaimed floor previews as a pit rather than the stone it becomes.

### The 4u worldgen pipeline (NO LONGER the default — `?substrate=4u`; read docs/13 before editing it)
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

## Working alongside other sessions

This repo is routinely driven by SEVERAL concurrent Claude sessions plus a human authoring content in
the cell editor. Three things follow, and the first two are lessons the sibling `creeda-pilot` paid
for in lost work.

**ISOLATE IN A WORKTREE, BEFORE THE FIRST COMMIT.** Sessions sharing one checkout share one HEAD, and
it moves between your own consecutive git commands. In creeda-pilot a session's HEAD advanced between
its `commit` and its `push`, so the push carried another session's commit onto its PR — and when that
PR squashed first it absorbed the work and the original merged EMPTY. `git worktree add ../ascent-<slug>`
off `origin/main`, and do everything there. In a shared tree, push an explicit SHA
(`git push origin <sha>:branch`), never `HEAD:branch`.

**PULL, DO NOT JUST FETCH** — at the start of a session and again before pushing. `git fetch` updates
the remote-tracking ref and leaves your working tree behind; this session sat 5 commits behind without
noticing, two of them in the file it was editing. After ANY merge, re-run the full gate on the MERGED
result: a clean textual merge is not a working merge, especially when the incoming commits touch your
files.

**CHECK WHAT YOUR BRANCH TRACKS BEFORE YOU PULL** — `git branch -vv`, and expect `[origin/main]`.
Work lands on `main` here, but several local branches still track their own long-dead remote: at the
time of writing `feat/emergent-gen` sat exactly AT `origin/main` while tracking an `origin/*` ref 58
commits stale. `git pull --rebase` there does the obedient thing and rewrites all 58 onto the dead
base, silently moving you off main's line — the tree stays clean, the tests still pass, and nothing
says a word. Recovered by branching at the pre-rebase SHA from the reflog rather than resetting.
So: verify the upstream, and prefer `git pull --rebase origin main` — naming the branch you mean beats
trusting whatever the ref happens to point at.

**AND IT IS MANUFACTURED, NOT BAD LUCK.** Rebase-merge with delete-branch — the default on this repo's
PRs — produces this shape every single time you merge and keep the local branch: the remote goes away
at merge time while the branch survives pointing at it. A peer session audited itself after hitting the
above and found two live instances, both from merged PRs. Expect it, and audit with:

```
git for-each-ref --format='%(refname:short) -> %(upstream:short) %(upstream:track)' refs/heads | grep gone
```

A branch with NO upstream is the SAFE failure — `git pull` errors instead of rewriting. A branch
tracking a `[gone]` ref is the dangerous one.

When cleaning these up, PROBE FOR THE CONTENT, never trust "the PR merged" or `git cherry`: rebasing
rewrites patch-ids, so genuinely-merged work reports as unmerged. Grep `main` for the distinctive
symbol the branch added and delete only once you have found it.

**THE AUTHORING STORE MOVES UNDER YOU.** `src/floor/cell-structures.json` is written by a human through
a live dev server WHILE sessions test against it. A before/after comparison that straddles a save is
not a comparison, and it fails silently — both runs look valid and the conclusion is wrong. It has
already produced a confident, wrong attribution twice. So:
- every content-dependent proof prints `storeFingerprint()`; if two runs disagree, check the
  fingerprints before believing the difference;
- ONE session owns the editor server and the store at a time. Others treat it as read-only input.

**ONE SERVER PER WORKTREE, and you cannot restart someone else's.** `.claude/launch.json` already names
them by area with distinct ports (`ascent-main` 5191, `ascent-gen` 5183, `ascent-tex` 5192). Add an
entry for a new worktree rather than sharing a port; `preview_stop` will not touch another session's
server, and vite cannot hot-reload `vite.config.ts` anyway.

**PREFER MESSAGING TO LOCKING.** When two sessions genuinely need the same file, say so and coordinate —
do not add a lock. On 2026-08-23 two sessions both had `cell-place.ts` open; the exchange caught a real
arithmetic collision in the stair weights and an explanation function that had drifted from the decision
it explained. A lock would have prevented the contact, and the contact was worth more than the collision.

## Documentation layout
Root [CLAUDE.md](CLAUDE.md) stays GENERAL — the map, the non-negotiables, the cross-cutting rules.
Anything specific to one area lives in that area's own `CLAUDE.md`, which acts as a router when the
area is big enough to need more than one doc (see `src/lab/`). Design *rationale* that outlives any
one folder goes in [`docs/`](docs/).

**Update the area doc in the same commit as the change.** A doc that lags is worse than no doc: the
next session trusts it. Docs split on the same test as modules — a second subject, not a line count
(see Conventions) — and when one splits, the area `CLAUDE.md` stays the index.

## Conventions
- TS strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Use `import type` for types. Guard array index access.
- Standalone `prove.ts` files use **relative imports with explicit `.ts` extensions** so Node's
  `--experimental-strip-types` can run them dependency-free (`allowImportingTsExtensions` is on).
  Strip-only mode forbids TS `enum`/namespaces → use `const X = {...} as const` + a `type X` alias.
- **One subject per file — modules and docs alike.** Many small, well-named files with doc comments
  explaining the WHY; a single subject is what makes them composable and what makes the name a
  promise. **Split when a file has acquired a SECOND subject someone could need independently, not
  when it passes a line count** — a 400-line doc with one subject is fine, a 120-line one covering
  two is not. Length is a symptom, not the test: past ~250 lines, go and LOOK for the second
  subject. Quality and robustness over speed.
- Scratch/experiment files go in `tmp/` (gitignored). Don't commit them.

## Reuse from Frequency
The sibling shipped game `c:/Users/Jacob/Documents/Projects/frequency` proves the P2P/WebRTC layer:
host/peer roles, single-reducer authority, deterministic room-code→peerId, **silent host migration**
(generation ladder), PeerJS signaling + STUN/TURN. `src/net/` adapts these for rollback (REUSE the
connection lifecycle; REPLACE the host-authoritative loop with peer-symmetric rollback).
