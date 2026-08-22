# 13 — Worldgen: the AS-BUILT map

> **What this doc is.** The load-bearing reference for anyone — human or agent — picking up world
> generation mid-stream. It says, for every stage: **which file**, **what it produces**, **what
> invariant it must not break**, **which gate proves that**, and **whether it is BUILT or only
> DESIGNED**. Read this before touching `src/floor` or `src/game/tower.ts`.
>
> **§0 verified at `2e97723`; §1–§4 (the 4u pipeline) verified at `c3fab30`.** Every file path, export name, and status
> below was checked against the source, not carried forward from a previous revision.
>
> - **Why the design is what it is** → [`16-generation-overhaul.md`](16-generation-overhaul.md).
> - **The solvability contract** → [`GENERATION-SOLVABILITY.md`](GENERATION-SOLVABILITY.md).
> - **What the pipeline used to be** (Blueprint → Style → `Placement[]`, deleted 2026-06-30) →
>   [`archive/13-abstract-piece-pipeline.md`](archive/13-abstract-piece-pipeline.md). Nothing in this
>   tree imports those modules any more; if a doc or comment still mentions `blueprint.ts`,
>   `wall-style.ts`, or `wall-model.ts` as live code, it is stale — fix it.

---

## 0. THE 2u CELL MIGRATION — in progress, and it changes the substrate

> **Two substrates exist in the tree right now.** The 4u tile pipeline (§1–§4) still runs and is what
> the game renders. The 2u CELL pipeline below is complete through generation, proven, and is what
> everything moves to. Neither is deleted yet; nothing is half-converted.

**The 4u tile split each side into `inner` + `edge` and kept a `centre`, so a coarse cell could
express detail finer than itself — a sub-grid simulated inside a cell.** The 2u model just *has* the
sub-grid. A tile becomes a 2×2 block of 2u cells and carries no data of its own.

Every irregularity that cost us time traces to that simulation, and each one becomes unrepresentable:

| 4u problem | at 2u |
|---|---|
| an arm could be HALF expressed (`inner` without `edge`) — drawing a full wall while reading PASSABLE | a wall is one field: present or absent |
| the CROSS seam — three cells across two tiles describing one wall | a wall is one owned field |
| the POINT seam — four floor quadrants meeting at a lattice point | floor is one value per cell |
| `centre` as a special cell | an ordinary lattice point |
| an opening had to be inferred from `wallType` + a full wall line, so a corner could never have a door | `corner: 'air'` states it directly, and the test is two fields on ONE cell |

**A cell owns `{floor, wallN, wallW, corner, wallType}` and nothing else.** Its south wall is the south
neighbour's `wallN`; its east wall is the east neighbour's `wallW`. Single ownership is now the *only*
rule in the model, because there is nothing left two cells could disagree about.

| # | Stage | File | Produces | Gate | Status |
|---|---|---|---|---|---|
| C1 | The cell model | `src/floor/cell.ts` | `Cell`, `blocks`, `cornerIsOpen` | `cell-grid.test.ts` | **BUILT** |
| C2 | Domains | `src/floor/cell-field.ts` | `CellField` (bitmasks), `andGate`, `collapse` | `cell-grid.test.ts` | **BUILT** |
| C3 | Transactional grid | `src/floor/cell-grid.ts` | `CellGrid`, `begin`/`stamp`/`commit`/`rollback` | `cell-grid.test.ts` (31) | **BUILT** |
| C4 | Traversal graph | `src/floor/cell-graph.ts` | `CellGraph` — cells are the nodes | `cell-grid.test.ts` | **BUILT** |
| C5 | Reachability over domains | `src/floor/cell-reach.ts` | may/must, `edgesOf`, `findRoute`, pinning | `cell-reach.test.ts` (16) | **BUILT** |
| C6 | Maze carvers | `src/floor/cell-maze.ts` | `planMaze` — kruskal / backtracker / prim / scatter | `cell-emergent.test.ts` | **BUILT** |
| C7 | Structure migration | `src/floor/structure-migrate.ts` | 4u tiles → 2u cells | `structure-migrate.test.ts` (25) | **BUILT** |
| C8 | Authored structures | `src/floor/cell-structures.json` + `.ts` | the ONLY rooms | — | **BUILT** |
| C9 | The generator | `src/floor/cell-emergent.ts` | a settled `CellGrid` | `cell-emergent.test.ts` (25), `prove:cell` | **BUILT** |
| C10 | Orientation | `src/floor/cell-orient.ts` | 8 placements per authored piece | `cell-orient.test.ts` (18) | **BUILT** |
| C11 | The 2u editor | `src/lab/cell-editor.ts` + `cell-editor.html` | authored structures, natively | driven headlessly | **BUILT** |
| C12 | Cells → meshes | `src/floor/cell-place.ts` | `CellPlacement[]` — the placement authority | `cell-place.test.ts` (15) | **BUILT** |
| C13 | 3D view adapter | `src/lab/cell-preview.ts` | Three.js group from C12 | driven headlessly | **BUILT** |
| C14 | Wiring into the game | `src/game/tower.ts` | — | — | **NOT BUILT** — the game still compiles the 4u path |

**The store can go stale, and it is guarded.** A domain is a bitmask indexed by POSITION, so appending
a value to any enum silently changes what every stored mask means — a floor mask of `15` meant "any
material" when there were four and means "any except rock" now there are five. `cell-structures.json`
records the value-set sizes it was written against and `cell-structures.test.ts` asserts they still
match. If that test fails, run `npm run migrate:structures`; never hand-edit the numbers.

**One edge enumeration.** `cell-reach.ts:edgesOf` is the single place a traversable connection comes
into existence, and both the graph and the router are built from it. That is not tidiness: in the 4u
model the two derived edges separately, one learned about openings and the other did not, and the
disagreement surfaced as a phantom "invariant broken" rather than as the mismatch it was.

**The generator's phases** — structures → route+pin → seal → maze → settle. Doors are *discovered*:
SEAL tries to close every porous perimeter wall, and the ones that refuse — because closing them would
strand a cell or break a pinned route — are the doors.

### Migration status

- **Done:** the substrate, the generator, and all three authored structures — converted cell-for-cell
  against the *old code* as oracle, and confirmed visually at matching scale.
- **Not done:** the game still compiles the **4u** path — `tower.ts` reads `floorTiles`/`tileUnits`,
  so 2u floors have meshes (`cell-place.ts`) and a preview but are not what the game draws yet. The 4u
  modules stay until that lands.
- **Known lossy point:** the old `centre: 'barrier'` (a low pillar) converts to `column`, dropping the
  low-ness. Nothing in the authored set used it.
- **Resolved:** corridors carve on a 2-cell step (`MazeParams.step`, default 2) so a hallway is 4u
  across — the width the meshes were authored for.
- **Generation cost:** 38 ms for 36×28, 189 ms for 60×48. The gate is `stillConnected` (an early-exit
  search between the endpoints of what you just walled), NOT a full reachability recompute — that was
  8× slower and was the entire runtime.

---

## 1. The pipeline, one screen

```
FloorConfig {seed, stratumIndex, gridSize, openness, guaranteedRoutes k, gateDensity}
      │
      ├─►  generateFloor()          src/floor/generate.ts      ──►  Floor {cells, edges, rooms, puzzles}
      │       spine carve (edge-disjoint BFS ≈ Menger) → openness → rooms → puzzles
      │
      ├─►  verifyFloor()            src/floor/verify.ts        ──►  INDEPENDENT solvability proof
      │       max-flow route count + lock-and-key fixpoint. Generator-blind. Never edit to make gen pass.
      │
      ├─►  floorToTileGrid()        src/floor/floor-tiles.ts   ──►  TileGrid  (per-cell TileField DOMAINS)
      │       each room stamps its ROLE's template over its rect; corridors get a plain floor tile
      │
      ├─►  floorTiles()             src/floor/floor-tiles.ts   ──►  (WallTile | null)[]
      │       = resolveGrid(grid, pick) then reconcileDoors(floor, tiles)
      │         resolveGrid  : collapse each domain → TileCore, then owner-resolve (E = east's W,
      │                        S = south's N, border = perimeter) into a full 9-cell WallTile
      │         reconcileDoors: clear the room wall-ring wherever floor.edges actually connects
      │
      ├─►  tileUnits(tile)          src/game/tile-units.ts     ──►  TileUnit[]
      │       tilePlacements(tile)  ×  approved-assets.json (frozen box-fit footprint + material recipe)
      │
      ├─►  buildCellGrid()          src/game/tower.ts          ──►  StratumCellGrid
      │       { cells: CellTile[]  (type, roomId, roomRole, hole, stair, wallMask)
      │       , wallPlacements: WorldPlacement[] }   ◄── THE single wall producer
      │
      ├──►  emitWallsFromSlots()    src/game/tower.ts          ──►  AABB[]  solids   (COLLISION)
      └──►  DungeonBuilder          src/render/dungeon.ts      ──►  Three.js meshes  (RENDER)
                                                                     ▲
              both branch off the SAME WorldPlacement.unit ──────────┘
              ⇒ render == collision by construction, not by re-proving
```

Then `route-check.ts` (driven by `prove:game`) re-proves solvability **on the compiled AABBs** — the
geometry actually collided against, not the graph that planned it.

---

## 2. Stage table — file · produces · invariant · gate · status

| # | Stage | File | Produces | Invariant it must not break | Gate | Status |
|---|---|---|---|---|---|---|
| 1 | Floor graph | `src/floor/generate.ts` | `Floor` | k edge-disjoint entry→exit spines exist; perimeter WALK ring always added; edges only ever ADDED | `prove:floor`, `generate.test.ts` | **BUILT** |
| 2 | Independent verifier | `src/floor/verify.ts` | solvable / route-count / lock-key verdict | Generator-blind. Own max-flow. Non-vacuous (negative controls must report UNSOLVABLE) | `prove:floor`, `verify.test.ts` | **BUILT** |
| 3 | Puzzles | `src/floor/puzzles.ts` | `PuzzleSpawn` chains | Lock-before-key: a gate is placed only once a reachable key exists on the correct side | `prove:floor` | **BUILT** |
| 4 | Tile model | `src/floor/wall-tile.ts` | `WallTile` (9-cell) | A tile owns only `edge.N` + `edge.W`; classic piece names are DERIVED (`label()`), never stored | `wall-tile.test.ts` | **BUILT** |
| 5 | Constraint layer | `src/floor/wall-tile-field.ts` | `TileField` (bitmask domains) | Pure bitwise; `collapse`'s `pick` is the ONLY entropy seam | `wall-tile-field.test.ts` | **BUILT** |
| 6 | Transactional grid | `src/floor/tile-grid.ts` | `TileGrid`, `Tx` | `commit` is all-or-nothing; a failed batch leaves the grid byte-identical; iteration index-sorted | `tile-grid.test.ts` | **BUILT** |
| 7 | Room templates | `src/floor/room-templates.ts` | `Stamp` per room kind | A room states its OWN walls AND that its inside is air; it abstains ONLY on outward-facing cells | `room-templates.test.ts` | **BUILT** |
| 8 | Room roles | `src/floor/room-roles.ts` | `RoomRole`, `roomStamp` | Role = seeded hash of (runSeed, roomId); integer-only; every peer derives the same role | ⚠️ **no test file** | **BUILT, UNGATED** |
| 9 | Floor → tiles | `src/floor/floor-tiles.ts` | `(WallTile\|null)[]` | Door reconciliation must open the ring wherever `floor.edges` connects, or the level is uncompletable | `floor-tiles.test.ts`, `prove:game` [7] | **BUILT** |
| 10 | Traversal graph | `src/floor/corner-graph.ts` | `CornerGraph` (dual of walls) | An arm blocks ⟺ `edge==='wall' && inner==='wall'`; adjacency ascending | `corner-graph.test.ts` | **BUILT, editor-only** — its only non-test importer is `src/lab/tile-editor.ts`'s connectivity overlay; the *shipping* solvability gate is `route-check.ts` on compiled AABBs |
| 11 | Placement authority | `src/floor/tile-place.ts` | `TilePlacement[]` | THE only place mesh urls + transforms are decided. Fixed-point, quarter-turns, no floats at runtime | `tile-place.test.ts` | **BUILT** |
| 12 | Unit composer | `src/game/tile-units.ts` | `TileUnit[]` | Boxes come from the FROZEN box-fit footprint — never bespoke wall geometry | `tile-units.test.ts` | **BUILT** |
| 13 | Tower compile | `src/game/tower.ts` | `StratumCellGrid`, `AABB[]` | Exactly ONE producer of `WorldPlacement[]`. Render and collision both read `unit` | `tower.test.ts`, `prove:game` | **BUILT** |
| 14 | Render | `src/render/dungeon.ts` | Three.js meshes | Reads the sim; never writes back. Cosmetic picks are view-seeded and never reach the verifier | `prove:game` [7] negative control | **BUILT** |
| 15 | Geometry re-prove | `src/game/route-check.ts` | Anchor route entry→top | Runs on the COMPILED AABBs, not the graph | `prove:game` [7] | **BUILT** |

### The EMERGENT generator (a second, parallel path — not yet wired to the tower)

`src/floor/emergent.ts` builds a floor with **no coarse map at all**: the layout is whatever survives
a sequence of narrowings on the tile field. It does not replace stages 1–3 above yet; it is a
complete alternative front-end that produces the same `TileGrid` stage 9 hands to `tileUnits`.

| # | Stage | File | Produces | Invariant | Gate | Status |
|---|---|---|---|---|---|---|
| E1 | Domain reachability | `src/floor/tile-reach.ts` | `may` / `must` arm predicates, domain corner-graph, `pinRouteOpen` | `MUST ⇒ MAY` for every representable domain pair; pinning touches only tile-private inner cells | `tile-reach.test.ts` (17, incl. negative controls) | **BUILT** |
| E2 | Seams | `src/floor/seams.ts` | `crossSeam` (2 tiles) / `pointSeam` (4 tiles), `cohere` | Coherence is a TENDENCY — `cohere` narrows to the intersection only when non-empty, never overriding a decision | `seams.test.ts` (15, incl. negative controls) | **BUILT** |
| E3 | Emergent generator | `src/floor/emergent.ts` | `EmergentResult` (settled `TileGrid` + pinned routes) | Every target reachable at every moment; field fully settled at the end; rooms come ONLY from `structures.json` | `emergent.test.ts` (10), `prove:emergent` | **BUILT** |

**SEAMS — the two places the tile decomposition leaks.** Cutting the world into 4u tiles splits some
physical features across tiles, and the split parts are stored independently, so they drift. Drift is
what reads as "malformed". There are exactly two such splits:

| Seam | Spans | Cells | Drift looks like |
|---|---|---|---|
| **cross** | **2 tiles** | `A.inner.E` · the shared edge · `B.inner.W` | a wall that runs from one tile's centre and stops dead at the boundary with an end-cap — a **stub** |
| **point** | **4 tiles** | the four floor QUADRANTS meeting at a lattice point (`se`/`sw`/`ne`/`nw` of the tiles around it) | ground changing material four ways around a single point — a **checkerboard** |

A wall proposal stamps the whole cross seam, so every wall is a continuous centre-to-centre run by
construction. A `cohere` pass before settle pulls both kinds toward agreement wherever they are still
free to move. `seamDisagreements()` reports what is left — a diagnostic, not an error, since a doorway
in a wall run and a material change at a room edge are both legitimate disagreement.

```
makeGrid()                     every cell fullField() — a blank field is MAXIMALLY connected
  ├─ 1 ROOMS (porous ring)     claim the footprint; gate: no conflict + all targets still `may`-reachable
  ├─ 2 MAZE WALLS              only on UNCLAIMED cells; gate: all targets still `may`-reachable
  ├─ 3 CONNECT                 pin a route to each target → `may` becomes `must` (this cuts the doors)
  ├─ 4 SEAL                    finish each porous ring cell to wall; refused where a route needs it
  └─ 5 SETTLE                  narrow every unclaimed cell to `none` → the field is fully determined
```

**Why it is safe with nothing reserved.** `andGate` only removes options, so reachability is
**monotone** — it can decrease, never increase. The blank field is fully connected, and every commit
is gated on the targets still being achievable. By induction the floor is completable at every moment.
There is no scaffold and no backtracking search; the invariant does the work a reserved corridor used
to. **Corollary that shapes everything: a domain never widens, so a cell pinned to `{wall}` can never
become a door.** Rooms are therefore stamped with a *porous* ring (`{none, wall}`) and their openings
are decided later, while the choice still exists — `porousRoom` in `room-templates.ts`.

**A room states that its inside is AIR.** `room-templates.ts:cell()` pins every interior-facing arm
(and the centre) to `none`. That is not over-reach — "the inside is open" is half of what a room *is*,
so it is squarely inside the template's own business. Stating it makes trespass **structurally
impossible**: a maze wall proposed inside a room meets `{none} ∩ {wall} = ∅`, the transaction
conflicts, and it rolls back. No ownership table, no trespass check, no policing code.

The rule the templates follow, precisely:

| Cell | Template says | Why |
|---|---|---|
| the room's own wall arms | `wall` (or `{none, wall}` when porous) | its walls are its business |
| interior-facing arms + centre | `none` | its inside is its business, and its inside is air |
| **outward-facing** arms (the `outside` dirs) | **nothing — abstain** | genuinely not its business; a corridor may join there, so the junction stays free to become a tee or a cross |

Only the third row is restraint. The first two are the room saying what it is. *(An earlier revision
of this generator policed trespass with a separate claims table; it was deleted — the templates were
simply not stating the whole truth about themselves.)*

The one thing the AND-gate does **not** catch is room-on-room overlap, because a POROUS ring is
`{none, wall}` and `{none} ∩ {none, wall} = {none}` — permissive by design. `emergent.ts` rejects that
with a plain rectangle test against the rooms already placed. It is a **placement policy**, not an
authority mechanism, and it is deliberately not dressed up as one.

*Open follow-up: pushing scope into `TileField` itself — so a template declaring a cell outside its
own business is a build-time error rather than a habit — is still worth doing.*

**Not in the pipeline but still live:** `src/floor/wallgrid.ts` survives *only* as the source of
`CellTile.wallMask` (the 4-bit projection the fog BFS and decoration read). It is **not** a wall
producer any more. Folding its last role into the tile lattice is the remaining piece of the old
"two lattices" debt.

---

## 3. The three invariants that gate every worldgen change

Every change to `src/floor` or `src/game/tower.ts` is measured against these. They are the merge
gates — if a change can't keep all three, it's the wrong change.

1. **Determinism.** No floats (use `Fixed` Q16.16), no `Math.random`, no `Date`/`performance.now()`,
   no `Map`/`Set` iteration on an output-affecting path. Same seed ⇒ byte-identical floor.
   → `prove:floor`, `prove:game`.
2. **Independent solvability.** `verify.ts` (graph) and `route-check.ts` (compiled geometry) are the
   source of truth and are **generator-blind**. New mechanisms must compile down to what they already
   check. Never relax a verifier to make a generator pass.
   → `prove:floor` incl. its negative controls; `prove:game` [7].
3. **One IR producer.** `buildCellGrid` is the only thing that emits `WorldPlacement[]`. Render and
   collision both branch off `WorldPlacement.unit`. Introduce a second producer and `render ==
   collision` stops being structural and starts being a thing you have to test.

---

## 4. Where to make a change

The point of this table: you want to change one behaviour, and you need to know the smallest set of
files that owns it.

| You want to change… | Touch | Then re-run |
|---|---|---|
| maze tightness / loops / how open a floor feels | `generate.ts` — `addOpenness`, `carveSpines` | `prove:floor` |
| how many guaranteed routes exist | `generate.ts` — `maxSupportableRoutes`, `carveSpines` | `prove:floor` |
| gate kinds (GAP/BREAK/BUTTON/WEIGHT) and their mix | `generate.ts` — `DEFAULT_GATE_WEIGHTS`, `pickGateKind` | `prove:floor` |
| lock-and-key chains | `puzzles.ts` | `prove:floor` |
| room rectangles / where rooms land | `generate.ts` — `layoutRooms` | `prove:floor`, `floor-tiles.test.ts` |
| what a room's walls/floor look like structurally | `room-templates.ts` | `room-templates.test.ts`, `prove:game` |
| which rooms get which identity | `room-roles.ts` — `ROOM_ROLES`, `roomRoleIndex`, `roleFloor` | ⚠️ nothing yet — **write a test first** |
| where doorways get cut | `floor-tiles.ts` — `reconcileDoors` | `prove:game` [7] |
| which mesh a wall shape uses / its yaw | `tile-place.ts` — `PIECE`, `tilePlacements` | `tile-place.test.ts`, `wall-tile-assets.test.ts` |
| a wall's collider shape | **not in code** — re-run box-fit in the lab and re-approve → `approved-assets.json` | `tile-units.test.ts`, `prove:game` |
| a wall's colour/texture | the approved entry's `materials` recipe (lab), not the renderer | visual + `lab:snap` |
| room decoration / props | `render/dungeon.ts` — `decorateRoomCell`, `placeRoleFloor` (view-only) | visual |
| cell size / stratum height | `tower.ts` — `CELL_SIZE`, `FLOOR_HEIGHT`, `GAME_GRID_SIZE` | `prove:game`, `tower.test.ts` |

**Rule of thumb for the sim/view split:** if changing it can alter whether a floor is *completable*,
it belongs in `src/floor` or `src/game` and needs a gate. If it can only alter how the floor *looks*,
it belongs in `src/render` or `src/lab` and must be view-seeded.

---

## 5. Authoring surfaces (the editors)

Three standalone Vite pages, all under `base: '/ascent/'`. They are **not** part of the Asset Lab
page — they are siblings of it, each with its own html entry in `vite.config.ts`.

| Page | Source | What it does |
|---|---|---|
| `/ascent/tile-editor.html` | `src/lab/tile-editor.ts` | **Tile Paint Editor** — paint the 9 cells of a tile (edge / inner / centre) as *domains*, not values. Ambiguity controls (all none / all wall / all barrier / random) preview how a domain collapses. Shows only the OWNED edges (N+W); E/S are read from the neighbour. Live connectivity overlay = the corner-graph verifier. Saves named structures to the server. |
| `/ascent/board.html` | `src/lab/board.ts` | **Tile Board** — stamp room templates onto a grid and watch the transaction model work: "two rooms (commit)" vs "overlapping rooms (rollback)". Blue = still-open/unconstrained cells. This is the visual proof that `tile-grid.ts`'s `commit`/`rollback` behaves. |
| `/ascent/walltile.html` | `src/lab/walltile.ts` | Single-tile inspector — one `WallTile` → its `tilePlacements` → meshes. |

Structures painted in the editor round-trip through `src/game/structures.json` (written by the
`/__lab/structures` Vite dev middleware; read by `src/game/structures.ts`). They are stored as
**TileFields (domains), not collapsed tiles**, so the game can collapse them with its own seeded
`pick`. Currently saved: `throne_room` (6×9), `treasure room` (6×6).

---

## 6. DESIGNED but NOT BUILT

`docs/16` reads as a coherent design. Large parts of it are **not in the tree**. Do not assume any of
the following exists:

| Concept | docs/16 § | Reality |
|---|---|---|
| **Sockets** (closed physical mating alphabet) | §3.1 | Not in code. No `Socket` type exists. |
| **Tags** (open semantic vocabulary, bitmask) | §3.2 | Not in code. No tag registry. |
| **AC-3-lite constraint collapse** | §4 | Not built *as AC-3*. What exists instead: `emergent.ts`'s propose → gate → commit/rollback loop over `andGate`, which is a coarser mechanism at placement granularity. The never-empty per-cell guarantee is provided by the settle phase, not by a solver. |
| **Scaffold / fronts dependency graph** | §5 | Superseded in practice — `emergent.ts` runs fixed phases, and the §5 scaffold turned out to be unnecessary (monotonicity gives the guarantee for free). |
| **The requirement queue** (deferred key placement, `FallbackPolicy`) | §6 | Not built. `puzzles.ts`'s propose→certify is still the mechanism. |
| **`Structure` / `Slot` / `provides` / `arity` / `role: cosmetic\|host`** | §7 | Not built. `structures.json` stores raw tile domains — no slots, no accepts-sets. |
| **Composites** (multi-tile set-pieces, `Placement.span`) | §2 | Not built. |
| **`field.pin(slot, exclude)`** routing contract | §8 | Not built. |
| **Scaffold / Rooms / Routing / Fill / Decorate fronts** | §5 | Not built as a dependency graph. Today it is a straight-line pass: generate → stamp → resolve → lower. |
| **Editor as an Asset Lab level** | §7 | Superseded — it shipped as three standalone pages (§5 above). |

What *did* ship instead of §4's solver: a **transactional stamping model** (§2 row 6). Rooms are
placed by staging templates into a `Tx` and committing atomically; conflicts roll the whole batch
back. That is a simpler, weaker mechanism than constraint collapse, and it is the one that exists.

---

## 7. Known gaps

Carried honestly; none of these are secretly done.

1. **`room-roles.ts` has no test.** It is sim data feeding both structure and dressing, derived from a
   seeded hash — exactly the kind of thing that must be gated. Highest-value next test.
2. **Interior-wall room templates can't land yet.** Every role currently lowers to a plain ring in the
   role's floor material, so tiling can never make a floor unsolvable. Aisles / cells / colonnades need
   `reconcileDoors` to *also* carve a guaranteed path through the room interior first. Deliberately
   deferred.
3. **`corner-graph.ts` is built but reaches the game only through the editor.** Its only non-test
   importer is `src/lab/tile-editor.ts` (the connectivity overlay). The tile-native solvability check
   it implements is not run during generation — `route-check.ts` on the compiled AABBs is what
   actually gates `prove:game`. Redundant, not wasted: wiring it in would catch a bad tiling *before*
   compilation instead of after.
4. **Frozen `unit.materials` is carried but not applied** — the renderer still recolours live by url.
5. **Floor pieces aren't lowered as tile units** — the per-cell slab + floor mesh stays, to avoid
   z-fighting. Only walls are units.
6. **Occlusion face-axis is approximated** from the quarter-turn.
7. **LOW-lip walls (BREAK/BUTTON/WEIGHT gates) don't render as tile units.** Passable either way, so
   solvability holds, but they're invisible.
8. **`wallMask` / `wallgrid.ts` projection still exists** — the last remnant of the two-lattice debt.
9. **`profile` (FULL/LOW/GAP) is a hook, not a 3D world.** Everything under it is per-stratum 2D.
10. **Recolor tables still live in `src/lab`** — the `TODO(publish)`.
