# 13 — Worldgen: the AS-BUILT map

> **What this doc is.** The load-bearing reference for anyone — human or agent — picking up world
> generation mid-stream. It says, for every stage: **which file**, **what it produces**, **what
> invariant it must not break**, **which gate proves that**, and **whether it is BUILT or only
> DESIGNED**. Read this before touching `src/floor` or `src/game/tower.ts`.
>
> **Verified against the tree at `c3fab30` (2026-07-01).** Every file path, export name, and status
> below was checked against the source, not carried forward from a previous revision.
>
> - **Why the design is what it is** → [`16-generation-overhaul.md`](16-generation-overhaul.md).
> - **The solvability contract** → [`GENERATION-SOLVABILITY.md`](GENERATION-SOLVABILITY.md).
> - **What the pipeline used to be** (Blueprint → Style → `Placement[]`, deleted 2026-06-30) →
>   [`archive/13-abstract-piece-pipeline.md`](archive/13-abstract-piece-pipeline.md). Nothing in this
>   tree imports those modules any more; if a doc or comment still mentions `blueprint.ts`,
>   `wall-style.ts`, or `wall-model.ts` as live code, it is stale — fix it.

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
| 7 | Room templates | `src/floor/room-templates.ts` | `Stamp` per room kind | A room constrains ONLY its interior + its own arms; everything else stays open | `room-templates.test.ts` | **BUILT** |
| 8 | Room roles | `src/floor/room-roles.ts` | `RoomRole`, `roomStamp` | Role = seeded hash of (runSeed, roomId); integer-only; every peer derives the same role | ⚠️ **no test file** | **BUILT, UNGATED** |
| 9 | Floor → tiles | `src/floor/floor-tiles.ts` | `(WallTile\|null)[]` | Door reconciliation must open the ring wherever `floor.edges` connects, or the level is uncompletable | `floor-tiles.test.ts`, `prove:game` [7] | **BUILT** |
| 10 | Traversal graph | `src/floor/corner-graph.ts` | `CornerGraph` (dual of walls) | An arm blocks ⟺ `edge==='wall' && inner==='wall'`; adjacency ascending | `corner-graph.test.ts` | **BUILT, editor-only** — its only non-test importer is `src/lab/tile-editor.ts`'s connectivity overlay; the *shipping* solvability gate is `route-check.ts` on compiled AABBs |
| 11 | Placement authority | `src/floor/tile-place.ts` | `TilePlacement[]` | THE only place mesh urls + transforms are decided. Fixed-point, quarter-turns, no floats at runtime | `tile-place.test.ts` | **BUILT** |
| 12 | Unit composer | `src/game/tile-units.ts` | `TileUnit[]` | Boxes come from the FROZEN box-fit footprint — never bespoke wall geometry | `tile-units.test.ts` | **BUILT** |
| 13 | Tower compile | `src/game/tower.ts` | `StratumCellGrid`, `AABB[]` | Exactly ONE producer of `WorldPlacement[]`. Render and collision both read `unit` | `tower.test.ts`, `prove:game` | **BUILT** |
| 14 | Render | `src/render/dungeon.ts` | Three.js meshes | Reads the sim; never writes back. Cosmetic picks are view-seeded and never reach the verifier | `prove:game` [7] negative control | **BUILT** |
| 15 | Geometry re-prove | `src/game/route-check.ts` | Anchor route entry→top | Runs on the COMPILED AABBs, not the graph | `prove:game` [7] | **BUILT** |

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
| **AC-3-lite constraint collapse** | §4 | Not built. `collapse()` picks the canonical lowest option unless a `pick` is supplied; `andGate` intersection is the only propagation. |
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
