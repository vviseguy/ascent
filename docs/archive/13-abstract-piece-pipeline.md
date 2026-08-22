# 13 — Dungeon Generation Architecture (layered model)

> **ARCHIVED 2026-08-21 — DESCRIBES DELETED CODE.**
>
> The pipeline below (`Blueprint -> Style -> Placement[]`) lived in `src/floor/blueprint.ts`,
> `src/floor/wall-style.ts`, and `src/floor/wall-model.ts`. **All three were deleted 2026-06-30**
> when the 9-cell TILE lattice superseded them. Nothing in the tree imports them.
>
> Kept for the reasoning — the A/B/C/D layer frame, the junction-classification argument, and the
> `render == collision` case are all still live ideas. Do not read it as a description of the code.
>
> **The as-built pipeline is [`../13-generation-architecture.md`](../13-generation-architecture.md).**

---



> Status: **the wall pipeline is IMPLEMENTED end-to-end** as a layered chain:
> `Blueprint (src/floor/blueprint.ts) → Style (src/floor/wall-style.ts) → Placement[]
> (src/floor/wall-model.ts) → {render, collision}`. `src/game/tower.ts` projects the Style's
> abstract `Placement[]` to one **unified IR** (`WorldPlacement[]`) at **native KayKit 4u scale**;
> BOTH `src/render/dungeon.ts` (KayKit meshes) and the sim collision consume that same IR, so they
> match by construction. `src/floor/wallgrid.ts` remains the slot/junction classifier the blueprint
> derives from. Layers A/B/D remain the planned evolution below. Short answer to "should walls be a
> grid with alternating wall/open lines, plus higher abstractions like a *library* room, maybe a
> tree?" — **yes to all three — as distinct layers**, each a clean deterministic data structure.

---

## TL;DR — the four layers

```
A. TOPOLOGY   rooms as a GRAPH (nodes = rooms w/ a ROLE/THEME, edges = connections w/ a TYPE)
B. SPACE      realize the graph in 2D — each room gets a rectangle on the cell grid
C. STRUCTURE  the WALL/EDGE GRID — your alternating grid: explicit wall slots + corner posts + door slots
D. DRESSING   theme-driven decoration — a "library" room fills with bookshelves, etc.
```

`Graph → Space → WallGrid → Dressing`. Each layer is seeded from the run seed (deterministic).
The renderer reads the **WallGrid** (geometry) + **Dressing** (props); the existing `cellGrid`
becomes a cheap *projection* of these (back-compat).

**Why this is the right cut:** each of your three asks lives in its own layer, so they stop
fighting each other — walls/doors/corners become *first-class entities* (Layer C), themes are
decided abstractly and realized late (A→D), and solvability/choice is a graph property (A).

---

## What's REALIZED today (the canonical pipeline) vs. tracked debt

> Read this before changing the generator. The four-layer model above is the *design frame*; the
> code today realizes the **middle** of it cleanly and leaves the top a stub. Don't "fix" the debt
> items below by accident — they're known and intentional.

**The realized chain (this is the source of truth, not the A/B/C/D sketch):**

```
Floor graph        src/floor/generate.ts        → Floor (cells, edges, rooms, puzzles)
  → Blueprint      src/floor/blueprint.ts       → square lattice (CELL/LANE/CORNER, FLOOR/WALL/WALL_POSSIBLE/OPEN)
  → Style          src/floor/wall-style.ts      → Placement[]  (DefaultStyle auto-tiles squares → pieces)
  → IR             src/game/tower.ts:buildCellGrid → WorldPlacement[]  (ONE IR, native KayKit 4u)
  → render         src/render/dungeon.ts        → KayKit meshes      ┐ both off the SAME IR,
  → collision      src/game/tower.ts:emitWallsFromSlots → AABB solids ┘ so they match by construction
```

- **Native 4u / 2u modules / "walls own squares".** A KayKit floor tile is **4u**; half a cell = **2u**
  = exactly one wall module, so corners tile with no fudge. Each lattice square *owns* a wall/junction.
  Collision decomposes every placement into **1u half-segments and merges collinear runs** into minimal
  AABBs (`emitWallsFromSlots`). `CELL_SIZE = 4.0` in `tower.ts`.
- **`profile` (FULL / LOW / GAP) is the 3D axis** — a seam for arched/windowed/low-gate walls. Today only
  *collision height* varies on it (LOW = a passable lip for BREAK/BUTTON/WEIGHT gates); the render mesh
  doesn't branch yet.
- **Extension seams exist but are thin:** `makeStyle(id)` is a Strategy that only ever returns
  `DefaultStyle` (a ~130-line auto-tiler with one variant rule: WALL_POSSIBLE → BROKEN ~30%). New wall
  families / themes are meant to be registry rows behind these seams.

**Tracked debt — known, don't trip on it:**

1. **Two lattices for one truth.** `wallgrid.ts` (edge/junction lattice) and `blueprint.ts` (square
   lattice) encode the same topology twice — `buildBlueprint` literally calls `buildWallGrid` and
   re-wraps it, and junction classification lives in **both** `wallgrid.ts:classifyJunction` and
   `wall-style.ts:junction()`. This is **intentional Phase-1 reuse** (the square layer leans on the
   proven edge layer). The reconciliation: fold the WallGrid *into* the Blueprint so one structure owns
   classification — do this before adding new wall logic, or the duplication calcifies.
2. **Layer ⓪ "Program" is a stub.** Rooms-as-graph + roles + puzzle organization are still **tangled
   inside `generate.ts`** (only `placePuzzles` is extracted). Layers **A** (topology roles), **B** (BSP
   space), **D** (theme dressing as first-class) are aspirational. Room *themes* exist only render-side
   (`dungeon.ts`, 7 themes keyed by `roomId % 7`), not as sim/game data.
3. **`profile` is a hook, not a 3D world.** Everything underneath is per-stratum 2D.
4. **Recolor tables not yet published.** The game renderer already colors via `recolor.ts` (the split
   is closed; `themes.ts` is deleted). The only remnant: `recolor.ts`'s tables still live in `src/lab`;
   publishing them is the `TODO(publish)` (see docs/16 §10 Phase 2).

The layered model A–D below is still the right *target*; sections C / C-bis describe what shipped.
**The next-gen direction (constraint-collapse generator + structure editor) is [docs/16](../16-generation-overhaul.md).**

---

## A. TOPOLOGY — a room GRAPH (your "tree-like structure", done right)

Generate the LOGICAL dungeon first, with **no geometry**: a graph where

- **nodes = rooms**, each tagged with a **ROLE/THEME** (`entry`, `stairs-up`, `library`,
  `armory`, `dining`, `crypt`, `treasure`, `boon`, `hazard`, …) and a size hint;
- **edges = connections**, each with a **TYPE** (`arch` / `door` / `locked` / `secret`).

**Tree vs graph — the real answer:** use a **graph = a spanning TREE + a few extra edges.**
- The **spanning tree** guarantees solvability (one path reaches every room incl. the stairs-up)
  — this is your "tree."
- The **extra edges add LOOPS** → choice/shortcuts, which a *pure* tree can't give (pure trees
  make linear, backtracky dungeons). ASCENT is a *race*, so loops/alternates matter.
- Roles assigned by a tiny **grammar**: `entry` + `stairs-up` always present and far apart;
  others weighted (so most floors get 1 themed room + maybe a treasure/boon detour).

This is also where ASCENT-specific structure lives: the `stairs-up` node is the floor's "goal,"
`boon`/`treasure` rooms are optional off-the-critical-path detours, `hazard` rooms are risk
shortcuts. The graph is what `prove:floor`'s solvability verifier should ultimately check.

## B. SPACE — place the rooms

Realize the graph as rectangles on the cell grid. Two options (pick per taste, swappable):
- **Dart-throw rectangles + carved corridors** (what we have now) — simple, works.
- **BSP partition** — recursively split the floor rectangle; leaves = rooms (the *other* tree
  you hinted at). Packs space densely with no overlaps and naturally nested rooms.

Recommendation: **keep dart-throw now; BSP is a drop-in upgrade** if we want tighter, more
"architected" floors. Output = room rectangles + corridor cells on the grid (unchanged contract).

## C. STRUCTURE — the WALL/EDGE GRID (✅ IMPLEMENTED — `src/floor/wallgrid.ts`)

This is the key addition you intuited, and it shipped. The rigid "9-cell square" framing
(docs/14 §6 — 1 center + 4 edges + 4 corners) turned out to be just the **k = 1** case of a more
**general lattice**: a wall/edge grid at subdivision `k` over the W×H cells. For `k = 1` it is the
classic fence-post grid; a larger `k` subdivides each edge into finer sub-slots (one cell edge can
then be `wall | doorway | wall`, half-length caps, etc.) without changing any of the logic below —
the classification reads the four incident edges *whatever the granularity*.

```
floor cells at the lattice NODES
WALL-EDGE slot on every line BETWEEN two adjacent cells (and on the outer boundary)
CORNER POST (a JUNCTION) wherever edge lines cross
```

Stored as three dense typed arrays (vEdges / hEdges / posts) rather than a parity-checked
(2W+1)×(2H+1) array — same information, directly indexable by both consumers. Each slot has STATE,
*derived* from layers A/B + the climb's open cells:

- **Wall-edge slot** ∈ `OPEN | DOORWAY | LIP | SOLID`
  - a **traversal edge always wins over cell type** — a WALK/GAP edge → `OPEN` (or `DOORWAY` at a
    doorway cell), a BREAK/BUTTON/WEIGHT gate → `LIP` (a low passable bump). This is what keeps
    every graph route — including the perimeter FALLBACK LAYER's WALK edges through VOID cells —
    *physically* open, so collision never walls off a path the verifier proved solvable.
  - otherwise (floor↔void/wall, the boundary, or two UNCONNECTED floor cells) → `SOLID`.
  - (`HALF` / `WINDOW` from the original sketch are deferred — easy to add as new edge states.)
- **Corner post = a JUNCTION** ∈ `NONE | CAP | STRAIGHT | CORNER | TEE | CROSS`, named purely from
  which of its four incident edges are walls (this **generalises** "pillar at a convex corner"):
  `1` wall = `CAP` (dead-end), `2` collinear = `STRAIGHT`, `2` perpendicular = `CORNER`, `3` =
  `TEE`, `4` = `CROSS`. T-junctions are now first-class (not "no pillar at a T") — they get a real
  `wall_Tsplit`. The junction's `dirs` bitmask drives the piece's yaw.

Why this layer earns its keep — it makes the things you keep hitting **first-class + unambiguous**:
- **The full wall-piece family**: caps / corners / tees / crossings / columns drop straight out of
  the junction kind (the renderer places the matching KayKit piece, oriented from `dirs`). The
  straight runs between junctions are full `wall` pieces; a junction covers the near half of each
  wall it joins, so the edge fills the far half with a `wall_half` — clean tiling, no overlap.
- **Doors**: a `DOORWAY` slot (carries a `doorId` when a LockedDoor gates it) — a real gap.
- **Fog/occlusion**: walls + doors are addressable entities, so "hide the wall between camera and
  player" and "a closed door keeps the next room fogged" operate on slots, cleanly.

The per-cell `wallMask` (4-bit) is a **lossy projection** of this grid (kept for the fog BFS +
decoration). The realized pipeline goes one step further than the original sketch: the WallGrid feeds
the **Blueprint** (which classes each square FLOOR/WALL/WALL_POSSIBLE/OPEN), the **Style** auto-tiles
it into abstract `Placement[]`, and `tower.ts` projects those to **one `WorldPlacement[]` IR** at
native 4u — each lattice position is a **2u KayKit module**, so a straight wall is a sequence of 2u
segments, a turn/branch a `CORNER`/`TEE`/`CROSS`, a dead-end a `CAP`. Collision decomposes every
placement into **1u half-segments and merges collinear runs** (minimal boxes), and render places the
matching KayKit mesh — both off the **same** IR, so they match by construction (§C-bis). Each
placement carries a vertical **`profile`** (FULL / LOW / GAP) — the 3D axis: `WALL_POSSIBLE`
break-gates become a LOW passable bump (the fallback layer stays crossable), doorways a GAP, and
partial/railing/arched walls slot in here as new profiles without touching the pipeline.

### C-bis. Collision derives from the SAME grid (collision matches the visual)

Today the **sim collision** is grid-CELL AABB blocks (a wall cell ≈ a full cell-size box), while the
**visual** is thin inset half-walls + open doorways — so collision ≠ what's on screen. The fix is to
make the **WallGrid the single source of truth for BOTH** the render tiles AND the collision AABBs.
Then they match *by construction*:
- wall-edge slot → a **thin AABB along the wall line** (same position/thickness as the rendered
  half-wall), not a cell block;
- `DOORWAY`/`OPEN` slot → **no collider** (a real gap you walk through);
- corner post `PILLAR` → a small **post AABB**;
- stairs → the **tread boxes** (the sim already does this for the straight staircase);
- props → optional per-prop AABB (barrels/crates block, clutter doesn't).
All still AABBs (the sim stays AABB-only + fixed-point + deterministic) — just *placed to match the
shapes on screen*, simplified. Solvability is re-checked on the new colliders (thinner walls + real
doorway gaps keep routes open). **This is the strongest reason to build Layer C:** "organize the
walls" (render) and "collision matches the visual" (sim) become the same job, off one grid.

### Note — the "soft flow" the walls have right now
It's an **emergent artifact**, not designed (so we can keep it on purpose later if we like it):
- The render insets each half-wall **into its room by ~half the wall depth** (so the wall's *outer*
  face lands on the cell boundary). So walls "stick out a bit" into the room.
- At a corner, two perpendicular inset walls **overlap near the vertex**, and the KayKit wall end-caps
  bevel where they meet → the **rounded** look. A **pillar** (placed only at true convex corners)
  sits exactly on the vertex at full size and **caps the join cleanly** → columns "don't stick out."
- **Doorways** are placed full-thickness **on the edge (not inset)**, so they **protrude past** the
  inset half-walls → doorways "stick out a bit."
Once Layer C owns wall/post/door placement, the inset + overlap become **tunable** — we can
deliberately keep a controlled bevel/round at corners (the look you liked) or square it up.

## D. DRESSING — theme-driven decoration (your "an area being a library")

Each room's ROLE/THEME (Layer A) drives a deterministic prop pass:

| Theme | Fills with |
|---|---|
| library | bookshelves along walls, reading tables, candles |
| dining | long table + chairs + plates/bottles |
| armory | weapon racks, crates, a sword-shield |
| crypt | tombs, rubble, cobwebs, few candles |
| treasure | chest(s), coin stacks, banners |
| (any) | ambient clutter — rubble/webs/candles — seeded by cell coords |

Placement is a **deterministic hash of (roomId, cell, theme)** (never `Math.random` — docs/06 §0),
so every peer paints the identical room. This is the layer the Render-CoS is *prototyping now*
(props per roomId); promoting room-THEME into Layer A makes it principled instead of ad-hoc.

---

## How this maps onto what we have TODAY (evolution, not rewrite)

The current generator already contains pieces of every layer:
- `src/floor/generate.ts` has a cell **graph with edges** (walk-seams) ≈ a weak Layer C, plus
  **rooms as rectangles** (Layer B) + `roomId` + cell `type` (partial A/D).
- `tower.ts`'s `cellGrid` + `wallMask` is a *projection* we keep for the renderer.

The evolution path (each a self-contained, agent-sized step):
1. **Layer C first** (highest payoff): add the explicit **wall/edge grid** (slots + posts + door
   slots) as a new deterministic structure in `src/floor`/`tower`, derived from the existing edge
   graph; keep emitting `wallMask`/`cellGrid` as projections. Unlocks half-walls, real doors,
   correct corners — and the renderer reads slots directly.
2. **Layer A**: promote rooms to a **graph with ROLES** (+ connection types); the solvability
   verifier checks the graph. Wire `entry`/`stairs-up`/`treasure`/etc.
3. **Layer D**: theme→decoration pass keyed off the Layer-A role (replaces the render-side ad-hoc
   theming with a principled one).
4. **Layer B (optional)**: swap dart-throw for BSP if we want denser floors.

---

## Open decisions — react here

1. **Graph = tree + loops?** I recommend yes (spanning tree for solvability + a few loop edges
   for choice). Or keep it pure-tree (simpler, more linear)?
2. **Build Layer C (wall/edge grid) as the next big step?** It's the one that structurally fixes
   walls/doors/corners (vs the renderer patching wallMask). I recommend yes.
3. **Where do ROLES/THEMES live** — in the sim floor data (so gameplay can read "this is a
   treasure room") or render-only (decoration only)? I recommend **sim** (roles will drive boons/
   hazards/loot, not just looks).
4. **BSP vs dart-throw** for spatial layout — keep dart-throw now, BSP later? (recommend yes.)
