# 13 — Dungeon Generation Architecture (layered model — PROPOSAL)

> Status: design PROPOSAL for review. This is the answer to "should walls/scaping be a grid
> with alternating wall/open lines, plus higher abstractions like a room being a *library*,
> maybe a tree?" Short answer: **yes to all three — as four distinct layers**, each a clean
> deterministic data structure the next layer (and the renderer) consume. It *subsumes* the
> three ideas and is an evolution of the current generator, not a rewrite.

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

## C. STRUCTURE — the WALL/EDGE GRID (your alternating grid)

This is the key addition you intuited. Use a **(2W+1) × (2H+1)** lattice over the W×H cells:

```
(even, even)  = FLOOR cell            (the playable squares)
(odd, even) / (even, odd) = WALL EDGE slot   (lives BETWEEN two cells)
(odd, odd)    = CORNER POST            (where four edges meet)
```

So rows/cols **alternate** floor-lines and wall-lines — exactly your idea. Each slot has STATE,
*derived* from layers A/B:

- **Wall-edge slot** ∈ `SOLID | HALF | DOORWAY | WINDOW | OPEN`
  - edge between two GRAPH-connected rooms → `DOORWAY` (or `door`/`locked` from the edge type)
  - edge facing VOID or an unconnected neighbour → `SOLID`/`HALF`
  - edge interior to one room → `OPEN`
- **Corner post** ∈ `PILLAR | NONE` — **pillar only at a true CONVEX corner** (two perpendicular
  SOLID walls meet). A **T-junction** has 3 walls around the post → it's interior, not convex →
  **no pillar** (this fixes "no corner at T's" *structurally*, not with heuristics).

Why this layer earns its keep — it makes the things you keep hitting **first-class + unambiguous**:
- **Half-walls per side**: a `HALF` slot renders a half-wall on each adjoining room's interior
  side; a `SOLID` between room↔void renders one. No stacking, no back-faces — it's per-slot.
- **Doors**: a `DOORWAY` slot with an `openable` flag; at runtime it carries a **hinge angle**
  (sim state) → the drag-open mechanic (docs/11 §3.4). The leaf hinges on the post.
- **Corners**: posts decide pillars (see above).
- **Fog/occlusion**: walls + doors are addressable entities, so "hide the wall between camera and
  player" and "a closed door keeps the next room fogged" operate on slots, cleanly.

The current `wallMask` (per-cell 4-bit) is just a **lossy projection** of this edge grid — we keep
emitting it for back-compat, but the WallGrid is the source of truth.

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
