# 16 — Generation Overhaul: the Constraint-Collapse Generator + Structure Editor

> Status: **DESIGN, agreed in principle 2026-06-27.** This is the canonical spec for the next-gen
> world generator and its authoring editor. It supersedes the forward-looking parts of docs/13
> (the A/B/C/D layer sketch) and folds in docs/14 (puzzles/solvability) + docs/15 (WorldObject).
> Synthesized from four parallel design passes (model / pipeline / editor / migration). Where this
> doc and docs/13 disagree about the *future*, this doc wins; docs/13 §"realized pipeline" still
> describes what's *shipped today*.

---

## 0. The vision (what we're building)

A **3D authoring editor** where humans *and AI* cheaply build reusable **structures**, each carrying
**slots that accept a set of acceptable objects** — and a **progressive, constraint-tightening
generator** that places rooms, routes paths, then fills the rest, with **decoration trailing
continuously**, keeping every level **provably solvable** via a deferred **requirement queue** (an
obstacle enqueues "needs a reachable key on a shelf"; it is resolved as soon as a valid spot is known).
Everything is authored in **4u units**; richness comes from **composite units**, not from
sub-grid resolution.

The goal is a **larger but constrained game space**: an explosion of possible dungeons, governed so it
stays cheap to author, cheap to solve, and impossible to make unsolvable.

---

## 1. The keystone (why this is an evolution, not a rewrite)

**The existing `WorldPlacement[]` IR survives untouched, and the new generator lowers *into* it.**

```
NEW: constraint-collapse generator ──┐
                                     ▼
              Placement[]  →  WorldPlacement[] IR  (src/game/tower.ts — UNCHANGED)
                                     ├──────────────► render meshes  (src/render/dungeon.ts)
                                     └──────────────► collision AABBs (src/game/tower.ts:emitWallsFromSlots)
```

Because both render and collision are projected from the **one** IR by the **one** `tower.ts`
projection, `render == collision` holds *by construction* and **never has to be re-proven**. The
independent solvability verifier (`src/floor/verify.ts`) reads only the compiled `Floor` graph + placed
keys/doors — so it is **never touched** either. Everything new sits *upstream* of these proven seams.
This is what lets the whole overhaul ship as **green, provable increments** (§10) instead of a big-bang.

**Three invariants gate every change** (they are the merge gates):
1. **Determinism** — `src/floor` + `src/game/tower.ts` stay fixed-point/integer, seeded-PRNG, no
   `Math.random`/`Date`, deterministic iteration. (`prove:floor`, `prove:game`.)
2. **Independent solvability** — `verify.ts` + the geometry re-prover `route-check.ts` remain the source
   of truth. New mechanisms must *compile down to* what they already check.
3. **`render == collision` off one IR** — never introduce a second producer of `WorldPlacement[]`.

---

## 2. The lattice and the wall-tile model

**Decision: one uniform 4u lattice — a grid of 4u TILES. Each tile carries a floor + optional wall
structure** (a plain floor square is just an all-`none` tile; a wall is part of the tile, *not* a thing
on the edge between cells). No 2u sub-modules. Per-tile variety comes from how the tile is
*parameterized*; bigger set-pieces are multi-tile composites. This resolves the "two lattices for one
truth" debt (§10 / docs/13 §1) — **one square lattice, classified once.**

### A wall tile = the 9-cell model

A tile is a **"plus" of 9 cells** that cleanly separates *what connects to the neighbour* (the EDGES)
from *what's structurally inside* (the INNER sides + the CENTRE):

```
            edge.N
            inner.N
  edge.W inner.W  ⊙  inner.E edge.E      ⊙ = centre column (none | wall | barrier)
            inner.S                       inner.* = inner sides (none | wall | barrier)
            edge.S                        edge.*  = outer edges (none | wall | barrier)
```

```ts
type Seg = 'none' | 'wall' | 'barrier';
interface SideSet { N: Seg; E: Seg; S: Seg; W: Seg; }

interface WallTile {                 // a tile and a floor square are the SAME struct
  floor: CornerFloors;               // per-corner floor material (stone/dirt/wood/none)
  edge: SideSet;                     // 4 outer cells — the connection to each neighbour
  inner: SideSet;                    // 4 inner cells — between each edge and the centre
  centre: 'none' | 'wall' | 'barrier'; // ADDITIVE centre column
  wallType: WallType;                // opening, only on a full straight line
}
```

- Each of the 8 arm-cells (an EDGE + an INNER per direction) is `none | wall | barrier`.
- The **centre column is ADDITIVE**: `none` lets walls pass through the middle *solid* (`inner.N+inner.S`
  = a continuous straight wall; `inner.N+inner.E` = a clean column-less bend); `wall`/`barrier` adds a
  pillar on top.
- `wallType` (door/window/…) only matters when a **full straight LINE** (inner+edge on one axis) is all
  wall.

**Why two cells per side (inner + edge)?** It separates the two questions that fought each other in the
earlier "connectors + centre" model: the **edge** says how this tile connects to its neighbour; the
**inner + centre** say what's happening *inside*. A *full* arm (inner+edge) reaches the neighbour; an
*inner-only* stub caps before the boundary; an *edge-only* cell is a wall finishing **at** the boundary
(an edge cap). That edge/inner split is exactly what makes the traversal graph well-defined (§2-graph).

**The classic pieces are DERIVED labels** (`label()` in `wall-tile.ts`), never stored — straight /
corner / bend / tee / cross / cap / column fall out of the inner junction + whether there's a centre
column. A **bend** is a column-less corner (`centre:'none'`); a **corner** is the same + a pillar.

**Rendering composes per-arm pieces**, adjacent same-type cells collapsing into longer walls (a full arm
→ a half-wall; an inner stub or edge cap → a capped half; a clean full corner → one mitered piece; the
centre column appended). All placement is **ONE pure function** — `tilePlacements(tile) →
{url,x,y,z,yaw,scale}[]` (`wall-tile-assets.ts`), the single authority the renderer **and** the collision
consume, so render==collision by construction.

### Content + the placement machine

Once a tile's structure (connectors + centre) is fixed, its **content** is computed — the objects that
hang off it: a **shelf or torch on a wall face**, a **barrel on the floor** of the adjacent cell.
Content is chosen from the cell/room **role** (a library wall → bookshelf; a guard post → weapon rack),
then a **placement machine** resolves the exact transform per **object placement rule**:

- a torch's rule = *centre on a wall face*;
- a barrel's rule = *sit on the floor, slide against the nearest wall*;
- a banner's rule = *hang high, centred on a wall face*.

The machine takes **liberty within the rule** (centre / nudge-against-a-wall / pick a corner), but every
choice is a **seeded hash** of `(tile, object, run-seed)` → deterministic and rollback-safe, and content
**never changes the centre-data or connectors**, so it is invisible to the verifier (the §3 cosmetic vs
`host` split holds — a shelf `host` can carry a queued key; the rest is pure view). This is §5's gradual
decoration made concrete: content + placement run *per tile, the moment its structure commits* — no
decorate phase, just the placement machine trailing the structural front.

### Composites (multi-tile set-pieces)

A single wall tile already covers most variety through (connectors, centre, centre-data, content).
**Composites are for things bigger than one tile** — a 2-wide archway, a 2×2 shrine, a multi-cell
staircase. They claim N adjacent squares from one anchor and map onto the IR's existing
`Placement.span`.

> **The explosion is the goal, and the architecture absorbs it without an explosion of *work*:**
> - **Authoring stays linear.** You never hand-validate unit×unit pairings. Each unit declares its
>   **sockets** (small *closed* alphabet) + **tags**; compatibility is *computed*. Add a unit → it
>   instantly composes with every compatible neighbour. O(1) authoring, astronomical output.
> - **Solving stays linear.** Collapse (§4) is linear in `slots × alphabet`; a bigger catalog is a
>   linear factor, never exponential.
> - **Correctness is explosion-proof.** The never-empty fallback (§4) + the verifier mean no
>   combination can yield an empty slot or an unsolvable floor.
> - **You bound *where* it explodes** with tags: a `library` room draws only `library`-tagged units.
>   Tag-scoping *is* the "constrained game space" lever.
>
> The real cost is **curation discipline** — keep the tag vocabulary small and the socket alphabet
> closed — not a combinatorial one.

### The traversal graph — corners as nodes (the bridge to solvability) {#2-graph}

> **Predicate ✅ PINNED 2026-06-28** (before building the verifier): per-arm gating · two routes per
> corner-pair (one through each flanking tile) · **directed** edges (gravity, `RouteProbe`-gated).

The thing you pathfind and *verify* on is the **open space**, which is the dual of the walls. So make
the tile-grid **CORNERS the graph nodes** (plus an optional per-tile **centre node**):

```
o-----------o     o = corner node (shared by the 4 tiles meeting at it → a dual grid,
| \   |   / |          offset half a tile). An edge between two corners is OPEN unless
|   \ | /   |          the wall between them is FULLY walled.
+++++ o +++++     ⊙ = centre node — present only when the tile interior is subdivided.
```

- A **corner is shared by 4 tiles**, so corner-nodes form a grid offset by half a tile.
- **A corner↔corner connection crosses exactly one ARM** — the `edge` + `inner` cell on the side
  between them. It is **blocked ⟺ that arm is FULL** (`edge` *and* `inner` both wall; the centre column
  counts for corner↔centre). A **partial** arm — just the edge, or just the inner — leaves a gap you
  slip through. A clean, **local, deterministic** predicate over the 9 cells; the graph falls out of the
  tile mechanically.
- **Two routes per corner-pair — one through each flanking tile.** Adjacent corners P, Q are crossed
  *inside* the tile on either side of their shared boundary: through tile A (A's arm on that side) OR
  through tile B (B's arm). The two routes share the **one owned edge cell** (§12 #4) but have
  **separate inner cells**, so they are genuinely distinct edges — *not* a second copy of the wall data.
  Reachability takes whichever is open.
- **Edges are DIRECTED — two per route — because gravity is asymmetric.** Descending a connection is
  free; ascending it is gated by what the body can do (jump/climb height, the `profile` FULL/LOW/GAP). A
  symmetric "open/closed" would call a region you can only *fall into* "reachable" and miss the exact
  failure an escort racing *up* a tower hits. Each directed edge's passability = `(its owned edge + that
  tile's inner + the vertical profile)` — the same capability model `route-check.ts`'s `RouteProbe`
  already walks, so the corner-graph *is* the collision/movement truth, not a symmetric proxy. *(Fully
  expanded, a single P–Q boundary is up to **2 routes × 2 directions = 4 directed edges**; the data
  underneath stays **one owned cell**. The multiplicity lives only in the graph, derived from the cells.)*
- The **centre node** appears only when the interior is actually subdivided (a centre column, or
  perpendicular inner walls); its corner-spokes model going around / through.

**Three things that make it work — and break it if ignored:**

1. **Shared edge cells (the load-bearing one).** A boundary cell is owned **once**, on the shared grid
   edge — `edge.E of A` *is* `edge.W of B`, the same cell — so adjacent tiles can never disagree about
   their shared boundary, and "how it tiles" is well-defined by construction. (The inner cells + centre
   stay per-tile; only the outer ring is shared.) **Lock this into the data model first** — it's free if
   designed in, a retrofit nightmare if not. *(✅ LOCKED §12 #4: single-owner — a tile owns its `N+W`
   edges, reads its neighbour's for `E+S`, resolved through one `tileView(grid,x,y)`. Today's per-tile
   `WallTile.edge` is the schema change this needs.)*
2. **Graph == collision.** Derive **both** the traversal graph and the collision AABBs from the same
   9-cell data — `tilePlacements()` is already the single source the renderer + collision share, so the
   verifier checks the same truth the sim collides on. The graph must be the **conservative, per-direction**
   read: claim a *directed* connection only when a body actually fits the gap **and** can make that
   traversal (descend vs ascend — the `RouteProbe` capability test), never a symmetric over-claim.
3. **Conditional centre node.** Keep it out unless the interior is subdivided — keeps the graph small and
   contains the diagonal "can a body squeeze past a corner" question.

**How it layers with the rest — two resolutions of one idea.** The **coarse** floor-graph (cells/rooms,
the spine carve, the requirement queue §6) *plans* connectivity and drives generation. The **fine**
corner-graph is what the 9-cell tiles *compile to* for the final solvability proof + collision:

```
coarse floor-graph (plan)  →  9-cell tiles (realize)  →  corner-graph (verify, == collision)
```

The coarse layer never needs to know about corners; the fine corner-graph is the ground-truth check that
what the tiles actually built is still solvable — the independent verifier of GENERATION-SOLVABILITY,
run on the dual of the walls.

---

## 3. Constraints: three orthogonal axes

A slot's eligibility is decided by three things that must **never be conflated**:

1. **Sockets** — a per-side *physical mating contract* in a small **closed** alphabet (owned by the
   generator). Two adjacent slots are compatible iff their facing sockets are complementary. This is
   "WFC adjacency", named by physical meaning. *Sockets are few.* For wall tiles the socket on a side
   **is that side's connector** (§2): my `E` connector must meet your `W` connector, and the tile's
   `centreData` sets passability. `WALL_FLAT | WALL_END | POST | OPEN | DOORWAY | VOID`
2. **Tags** — a per-candidate *semantic predicate set* in an **open**, authored vocabulary (owned by the
   editor). `flat`, `junction`, `shelf`, `rubble-ok`, `opening`, `gate`, `library`, `light`… *Tags are
   many.* Stored as a bitmask for cheap, deterministic set-ops.
3. **The acceptable set** — the slot's **domain**: the surviving candidate units. "Don't-care" = the
   full set; "collapsed" = a singleton.

A candidate survives in a slot iff, for every face: its tags satisfy the slot's required-tags and avoid
its banned-tags, **and** its socket mates the neighbour's facing socket.

### The user's hardest question, decomposed (no special cases)

*"This is a flat wall on this side (so no tee), possibly with a shelf, or rubble next to it."*
- **"no tee"** → a tag **ban** (`ban |= junction`) that *deletes the entire junction-region* of the
  acceptable set. A tee can't sneak in from the side either: its face presents `POST`, which fails the
  `WALL_FLAT` socket mate.
- **"possibly a shelf"** → `wall-plain` and `wall-with-shelf` are two candidates that **share sockets**
  (both present `WALL_FLAT` on the run faces), so they are interchangeable to neighbours. The choice
  survives as a **superposition** and collapses by seeded hash at the fill stage — zero neighbour impact.
- **"rubble next to it"** → a downstream **decoration affordance** in the adjacent cell, placed in the
  decorate stage, with no blocking socket → can never touch solvability.

Three different mechanisms (tag-ban / socket-equivalent superposition / decoration affordance), **none a
special case in the solver** — the solver only ever does "prune domain by predicate + socket mate."

---

## 4. The collapse algorithm: staged narrowing, not full WFC

**Decision: staged constraint propagation (AC-3-lite) with seeded tie-breaking and a guaranteed
never-empty fallback. No backtracking, ever.**

Why not full Wave-Function-Collapse:
- WFC can hit a contradiction and must restart/backtrack — unbounded, seed-fragile, and at odds with
  "prove independently, regenerate from a fallback seed." We want contradictions to be **structurally
  impossible**, not handled.
- By the time we'd "run WFC," the upstream stages (rooms, routing) have already removed ~all the global
  entropy; what remains is local choice among socket-equivalent variants. WFC's global machinery is
  wasted.
- AC-3-lite over a 4-neighbour lattice is linear and *provably terminating* (domains only shrink).

**The never-empty guarantee (replaces WFC backtracking):** every slot's initial domain **must contain a
universal fallback candidate** per role — the plain wall / the auto-classified junction / plain floor
(exactly what `wall-style.ts` emits *today*). Fallbacks are mutually socket-compatible, so the
all-fallback assignment is always consistent → **no stage can empty a domain**; worst case is exactly
today's dungeon. Over-constraint (a genuine authoring conflict) is a **build-time error caught by a
property test**, never a runtime contradiction.

**Determinism:** every pick is a **coordinate hash**, not a stream draw —
`pick = hash(seed, col, row) % domain.size` over the domain in **ascending candidate-id order**. This is
order-independent (no `Map`/`Set`-iteration hazard, parallelizable) and integer-only. Each stage uses
its own `subStream` tag so adding a stage never shifts an earlier stage's output (the existing `rng.ts`
discipline).

The collapse lives **inside the `WallStyle.realize` seam** (`makeStyle(id)` Strategy). Today's
`DefaultStyle` auto-tiler becomes the *fallback floor* of the new solver. `Placement[]` (a collapsed
singleton *is* a Placement) and the downstream IR are unchanged.

---

## 5. The generation process: a dependency order, not rigid slices

The work below is **not a sequence of global barriers**. It is a **dependency order over constraint
decisions**, run by the same constraint-propagation work-queue as §4: each decision fires **as soon as
its inputs are ready**, never at a phase tick. The "fronts" named below are one valid *topological
execution* of that dependency graph — a way to name progress, not walls everyone waits at.

The only hard ordering is the **solvability dependency**, and it is **per-slot / per-region, not
global**:

```
scaffold (perimeter + spines)
   ├─► a region's routing committed ──► that region's walls finalized
   └─► a door's reachable-before region known ──► its key placed (on a host surface)
```

A wall slot may not collapse to `SOLID` until the routing decision for *its* edge is committed (the
`field.pin` contract, §8); a door's key may not be placed until *its* reachable-before region is known.
Because these dependencies are local, distant parts of the map advance independently and in parallel.

**Decoration is the limiting case — fully gradual.** A decoration depends only on *its own host slot
being committed*, nothing else, so it attaches the instant any slot finalizes — anywhere, at any point
in the run. There is no "decorate stage"; decoration is a **continuous trailing edge** behind the
structural front. *(This is the observation that retired the rigid slicing: decoration has the loosest
possible dependency, so a discrete phase for it was pure artifact — and once it's gradual, the other
"stages" are just fronts in the same dependency graph.)*

| Front (a dependency milestone, **not** a barrier) | Decides | Depends on |
|---|---|---|
| **Scaffold** | perimeter ring + edge-disjoint spines — the fallback route, immutable & sacred | nothing (runs first, globally) |
| **Rooms** | room rectangles + roles; stamps constraints; enqueues requirements | scaffold |
| **Routing** | which *local* edges are hallway / not "for sure"; drains the solvability queue (keys, shelves) | the local rooms + scaffold |
| **Fill** | collapse a region's remaining slots | *that region's* routing committed |
| **Decorate** | attach props / affordances to a committed slot | only that slot ⇒ **continuous** |

Scaffold-first + additive-only ⇒ **catastrophic unsolvability is structurally impossible**. A decoration
may only sit on an already-committed slot and **may never add/remove a traversal edge**, so it is
invisible to the verifier by construction — *whenever* it runs.

This also gives the stub **"Program" layer** (docs/13 Layer A) its home: a room is placed *with a role*
that generates the constraints + requirements; roles move into **sim data**, retiring the render-side
`roomId % 7` themes.

> **On solvability without clean stages:** the staged induction ("prove after each barrier") becomes a
> *local* invariant — the per-slot dependency pins guarantee no fill ever closes a committed route —
> backed by the unchanged independent `verifyFloor` end-gate (it may also sample incrementally). Harder
> to eyeball than a phase barrier, strictly more flexible, same guarantee.

---

## 6. The requirement queue (deferred, solvability-preserving placement)

An obstacle is **not allowed to exist until the things that keep it solvable are placed and proven
reachable.** This generalizes today's `placePuzzles` (propose → certify → drop) into a queue drained
across stages.

```ts
type Requirement =
  | { kind: 'KEY_REACHABLE'; doorId: number; before: { doorEdge: EdgeRef; dependsOn?: number } }
  | { kind: 'SURFACE_FOR';   doorId: number; region: RegionSpec; surface: SurfaceKind }   // a shelf to host the key
  | { kind: 'FALLBACK_AROUND'; edge: EdgeRef; fallback: 'BREAK' | 'PERIMETER' }
  | { kind: 'CONCEAL'; keyRef: KeyRef; via: 'RUG' };                                       // cosmetic, drained in stage 5

interface QueueItem {
  req: Requirement;
  seq: number;                       // deterministic drain order (never Map order)
  drainStage: 'ROUTING' | 'DECORATE';
  fallback: FallbackPolicy;          // DROP_OBSTACLE | DEGRADE_TO_BREAK | RELOCATE — the escape hatch
}
```

**Drain (in ROUTING):** topo-sort the provisional doors by `dependsOn` (a cycle = "key behind its own
door" → reject + fallback). For each door in order, compute the region reachable using only
*earlier-resolved* doors as gates; place the key (and its hosting shelf) there; **incrementally verify**
with `lockKeyReachable`; on failure apply the door's `FallbackPolicy`. Inductively, the door prefix is
always solvable, base case = the perimeter. Every door carries a fallback that degrades to a *breakable*
gate or drops the obstacle — both strictly *more* solvable. **There is no drain path that ends
unsolvable.**

**Dependency chains** (key A behind door B) fall out of `dependsOn` + the topo order — `placePuzzles`'s
consecutive-step chains generalized to a DAG over the whole route graph.

**Verifier usage:** *incrementally* during the drain (cheap, lets the fallback fire locally) **and** a
full `verifyFloor` end-gate (the authoritative, generator-blind proof). The end-gate is the source of
truth; the per-stage checks are an optimization. The "every block eventually breakable + perimeter
fallback" guarantee maps onto `FALLBACK_AROUND` + the universal `DEGRADE_TO_BREAK`.

---

## 7. The editor + authored data model

**Decision: not a new app. A `structure` level on the existing Asset Lab.** Structures are authored as
**flat declarative data** (the JSON/TS an AI emits as plain text — no Three.js, no `build()`, no
collision math), composed by one generic `buildStructure()` that **reuses** `meshObject` + `recolor` +
`box-fit` and lowers to the **existing IR + `PuzzleSpawn`**.

```ts
// Pure data, no behavior. Everything in 4u CELLS; fine offsets in metres within a cell.
interface Structure {
  id; name; describe;
  size: GridPos;            // bounding size in 4u cells
  parts: Part[];            // the fixed skeleton: object id + 4u position + recolor variant
  slots: Slot[];            // the variability: each accepts a SET of options
  provides: Tag[];          // tags the whole structure advertises (so structures fill bigger slots)
  sockets?: Socket[];       // named boundary faces with a mating tag
}
interface Slot {
  id; at: GridPos; offset?;
  accepts: Tag[];                          // the constraint — by TAG, so it abstracts
  arity: 'optional' | 'one' | { min; max };
  role: 'cosmetic' | 'host';               // cosmetic = view-seeded, never hits the verifier;
  surface?: Surface;                       // host = a place the queue may drop a required item (key on a shelf)
}
```

The **screenshot harness is the AI's review loop**: `lab:snap structure:<id> --slots
--enumerate-options` renders the structure with slot gizmos + one image per acceptable option, so an AI
verifies every option fits and reads correctly without a human.

### The OOP / flat-data boundary (the user's "good OOP" question)

| OOP / composition (encouraged) | Flat declarative data (required) |
|---|---|
| `buildStructure()`, the lab builder, the GUI inspector, recolor, box-fit | the `Structure`/`Slot`/`Part`/`Surface` an author writes; the `WorldPlacement`/`PuzzleSpawn` the sim reads |
| floats, seeded randomness, polymorphism, caching — *no authority* | hashable, verifier-readable, AI-emittable as plain text |

**The boundary is the lowering step (`buildStructure`).** Above it: composition and OOP (a `Structure`
*is-a* buildable `WorldObject`). Below it: flat data the generator treats as a constraint catalog. Slots
**declare** constraints; they **never choose** — the generator (deterministic) fills `host` slots, the
view-seed fills `cosmetic` slots. The `role` enum is the load-bearing guard that keeps cosmetic choices
out of the verifier.

---

## 8. The cross-component contracts (the seams that make it "piece together")

- **Model ↔ Editor:** a `Candidate` is the *flat sim-side projection* of a `WorldObject` — a stable
  **integer id** (registration-stable; iterated ascending — a hard determinism contract), `piece`/
  `variant` → the IR, a `TagMask`, an optional socket override, a `footprintId`, declared `obligations`.
  The generator owns the **closed** `Socket` enum; the editor owns the **open** `Tag` registry; they
  share **one** tag vocabulary.
- **Model ↔ Pipeline:** the model exposes `field.pin(slot, exclude)` so routing can forbid `SOLID` on a
  committed HALL edge *before* collapse; a **monotonicity** guarantee (domains only narrow, committed
  slots never reopen); and a **deterministic failure callback** when a domain would empty (so the
  pipeline applies a `FallbackPolicy` rather than the model picking arbitrarily).
- **Pipeline ↔ Editor:** structures are **passive surface-providers**. A `host` slot with a `surface`
  (anchor + `clear` AABB) is where the queue may drop a required key; the queue picks among host slots
  that accept the right tag and fit the item, emits a `PuzzleSpawn`, and the **unchanged** verifier
  certifies.

---

## 9. Reuse / retire (summary; full table in the migration notes)

**Reuse / evolve:** the Menger spine carve + perimeter (`generate.ts`), `layoutRooms`/`addOpenness`
(become the rooms/routing stages), `verify.ts` + `route-check.ts` (**untouched** source of truth),
`puzzles.ts` chain-then-certify (becomes the queue drain), the `WorldPlacement` IR + `emitWallsFromSlots`
(extended, not replaced), `world-object.ts`/`box-fit`/`recolor`/the KayKit catalog, the lab + snapshot
harness, `makeStyle` (hosts the collapse).

**Retire:** `wallgrid.ts` (folded into the one lattice; debt #1), the duplicate junction classifier,
`themes.ts` (**already dead — zero importers**), `retexture.ts` (shrink to nothing then delete), the
render-side `decorateRoomCell` `roomId % 7` themes (→ authored dressing), `Cell.chunkType` (a dead
dressing hook), the 2u half-module, and the `wallMask`/`cellGrid` back-compat projections once fog +
torches read the lattice directly.

**Correction (was stale debt):** the coloring split is **already migrated** in the game path —
`dungeon.ts` colors via `recolor.ts`. The only remaining work is *publishing* recolor's tables out of
`src/lab` (the `TODO(publish)`), not a migration.

---

## 10. Migration sequence (each step ships green + provable)

Gates: **T** typecheck · **U** vitest · **P** all proofs (esp. `prove:floor`/`prove:game`) · **R** lab +
in-game render parity. The solvability gates (`verify.ts`, `route-check.ts`) + `render==collision` are
the green light for every geometry step.

- **Phase 0 — kill dead code + un-stale the map** (no behavior change): ✅ **DONE** — `themes.ts` and
  `Cell.chunkType` were already deleted in earlier work; the coloring-debt docs (§9, docs/13 §debt) read
  correctly; the residual stale `themes.ts`/chunk-type code comments were swept (2026-06-28).
- **Phase 1 — one lattice:** port wallgrid's rules (edge-wins-over-cell-type, openCells forced-open,
  junction classification) into `blueprint` deriving directly from `floor`; cut consumers over directly
  (no equivalence test — decided 2026-06-28); delete `wallgrid.ts`. Resolves debt #1.
- **Phase 2 — finish the coloring publish:** move recolor tables to a neutral home; delete
  `retexture.ts`; demote `materials.ts` to the flame/no-atlas fallback.
- **Phases 3–4 — feed the live IR from tiles. ✅ LOWERING DECISION 2026-06-28: Path A (concrete units),
  carried POLYMORPHICALLY on the one IR.** The abstract `Placement` vocabulary
  (`STRAIGHT|CORNER|TEE|CROSS|CAP|PILLAR|DOORWAY` + a `dirs` mask) is **too narrow** for the 9-cell tile
  — it can't carry inner stubs, barriers (low), the additive centre column, per-corner floors, or
  arch/window/gate/broken openings. So tiles do **not** map down to abstract pieces; they lower as
  **concrete units**.
  - **Shape — keep the single IR; make `WorldPlacement` polymorphic (additive).** A `WorldPlacement` is
    EITHER an abstract piece (today) OR a concrete `unit?: { url; y; yaw; scale; boxes: AABB[] }` (its
    mesh placement **and** its collider boxes, authored together). Both the renderer and collision read
    the SAME `cellGrid.wallPlacements`, branching on `unit`: render clones `unit.url` at `(x,y,z)`,
    collision pushes `unit.boxes`. So **`render == collision` stays true by construction (one list)** —
    AND abstract DefaultStyle pieces and tile-units can coexist in one floor. DefaultStyle never sets
    `unit` → consumers that ignore it are unchanged (the additive-IR contract).
  - **A piece's `approved-assets` entry is the authoritative source for BOTH collider AND look
    (decided 2026-06-28).** A wall piece is just a KayKit GLB; its approved entry already freezes
    `footprint.boxes` (the **`box-fit`** voxelizer — the green boxes, same algorithm props use) AND
    `materials` (the **recolor + texture-settings** recipe). So **boxing and texturing are co-equal
    authoritative sources**, frozen at the one approve gate. A tile `unit` references its piece's entry
    and pulls **both**: `unit.boxes` = each placed piece's frozen footprint transformed by the placement
    (→ collision); `unit.materials` = the frozen recipe the renderer **applies** (not re-derives). So
    `render == collision` is airtight (both off the same placed pieces), there is **no bespoke
    wall-collider** (the hand-written `tileColliders` was deleted as a duplicate), and this finally
    consumes BOTH dormant frozen stores (`getApprovedFootprint` for collision; the materials recipe for
    render, the symmetric step to today's live `recolor.ts`). One source per piece, two consumers —
    the same polymorphism as the IR.
  - **Determinism seam:** `box-fit` runs offline in the lab; its footprints are FROZEN data, so the sim
    only reads constants (Fixed-converted at the seam) — deterministic. The remaining sim-side authority
    is **placement** (which piece, where, what yaw — Option A: port `tilePlacements`' geometry to
    `src/floor` fixed-point, the lab's float version becomes a view-adapter). `graph == collision ==
    render` because all three trace to the same placement + piece: corner-graph from the 9 cells, boxes
    from the piece's frozen footprint, mesh from the piece's GLB.
  - **Increments:** **3a ✅** box-fit + approve the 13 wall pieces at edge density 0.4 (`scripts/lab-approve.mjs`
    headless harness + `window.__labApprove`; frozen in `approved-assets.json`). **3c ✅** the sim-side
    placement authority (`src/floor/tile-place.ts`; lab = float adapter). **4a ✅** the composer
    `tileUnits(tile)` (`src/game/tile-units.ts`): placements × frozen footprints+materials → `TileUnit[]`
    (objId bridge + quarter-turn AABB transform; collider boxes + materials). **4a-floor ✅** the
    TileStyle seam `floorTiles(floor)` (`src/floor/floor-tiles.ts`): `Floor → TileGrid` (rooms via
    `basicRoom`, corridors a plain floor) → `resolveGrid` → concrete tiles. So the **pure data path
    Floor → tiles → units is complete + tested, no tower/dungeon edits yet.** **— remaining (4b) —**
    add `WorldPlacement.unit?`, a **flag** to select tile-mode per floor (default-off; no pack-mixing),
    and wire the branches: tower collision pushes `unit.boxes` offset by the cell centre; renderer clones
    `unit.url` + applies `unit.materials`. Then **verify in-game** (`render==collision` + the
    footprint→tile SCALE — the one thing only the running game settles). **4c** solvability gate via
    `cornerGraphOf`+`connectsSides` alongside the unchanged `verify.ts`. Richer mapping (per-room roles,
    door reconciliation vs `floor.doors`) is iterative on top.
  - **Principle:** minimal surface, one source per thing — `box-fit` is the only collider generator
    (props + walls), `tilePlacements` the only placement authority. No bespoke wall geometry, no
    speculative unit registry / socket-tag fields until a real second unit type needs them.
- **Phase 5 — authored dressing** replaces `decorateRoomCell`; the editor's `structure` level + a small
  tag vocabulary land alongside.
- **Phase 6 — retire the last projections** (`wallMask`, fold `profile` into the unit descriptor while
  *preserving* the LOW→LIP collider semantics).

At no point is `main` left with a dual IR producer, two lattices, or a broken renderer.

---

## 11. Known risks & deferred

- **Multi-slot composites** must decompose into per-slot fallbacks, or the never-empty guarantee gets
  shaky at object boundaries — needs a property test.
- **Socket alphabet must stay closed** — mis-mating is otherwise silent. Sockets = physical (few); tags
  = semantic (many).
- **"Full 3D" = structures are *authored* in 3D** (yes). Truly **vertical, cross-stratum rooms** stay a
  separate deferred pass (docs/14 §5) — the generator remains per-stratum for now.
- **Curation, not combinatorics, is the real cost** — a disciplined small tag vocabulary + closed socket
  set keep the explosion coherent. Build the tag registry deliberately.
- **Determinism leak guard:** a cosmetic slot's view-seed must never feed a host decision — enforced by
  the `role` enum + a property test (flip the *view* seed → only cosmetic fills change, never the
  `PuzzleSpawn` set).

---

## 12. Open decisions (still to make)

1. **Door look at 4u** — full-4u-edge openings vs an authored `wall-with-door` composite as the default
   crossing. (Validate with an early editor screenshot.)
2. **`hallStatus`** — a durable field on `Cell` or a generation-time scratch artifact (lean: scratch;
   `cellType` is the durable projection the blueprint already reads).
3. **Tag taxonomy** — flat strings vs a small hierarchy (lean: flat strings, for hashability).
4. **Shared edge-cell ownership** — ✅ **LOCKED 2026-06-28: single-owner, "a tile owns its N+W edges"
   (NO separate `EdgeGrid`).** Each tile owns only the two outer cells on its lower-coordinate sides
   (`edge.N`, `edge.W`); its `E`/`S` are *read* from the neighbour at +1 — `edge.E of A` **is** the
   `edge.W` of the tile east of A; `edge.S of A` **is** the `edge.N` of the tile south of A. A missing
   neighbour (grid border) resolves to the PERIMETER wall (the existing "safe shell"). The full 9-cell
   view consumers need is produced by **one resolver** — `tileView(grid, x, y) → WallTile` — so the
   asymmetry lives in exactly one place and every consumer (`tilePlacements`, the corner-graph,
   collision) stays a pure function of a *resolved* tile.
   - **Why not a separate `EdgeGrid`:** it re-introduces a parallel edge-addressed lattice — the very
     "two lattices for one truth" debt Phase 1 *deletes* (`wallgrid.ts`). "Edges are a property of the
     square cell" is the North Star; single-ownership just adds a canonical-owner rule to dedupe the
     shared ones, keeping everything in tile-space. **Disagreement becomes unrepresentable** (one cell,
     not two mirrored copies to keep in sync) — strictly stronger than enforcing two mirrors agree.
   - **The S/E *map* borders (the fencepost).** `W` interior tiles own `W` vertical edges but there are
     `W+1` boundaries, so the **east** (`x=W`) and **south** (`y=H`) outer walls have no interior owner —
     they are the resolver's **perimeter constant**. This is correct, not a gap: (a) the outer ring is
     never an opening — entries/exits pierce *vertically* via stairs, so there is nothing to author
     there; (b) an interior room connects through its **neighbours'** owned edges, so a structure only
     ever authors its own **N+W interface** — its S+E *is* the neighbour's N+W. The editor mirrors this
     (N/W outer walls owned & paintable; S/E default to the shell). A sentinel rim (to make the map
     perimeter itself *openable*) is **deferred — YAGNI** until a perimeter opening is ever needed.
   - **Ripple — ✅ DONE 2026-06-28:** `TileField` stores owned `{N,W}`; `collapse → TileCore`;
     `resolveGrid`/`tileView` mint the full `WallTile` (E=east.W, S=south.N, border=perimeter); the
     editor authors only owned edges; `structures.json` migrated (`throne_room`). Disagreement is now
     unrepresentable at the type level.
5. **Where to start the real build** — ✅ done so far (2026-06-28): Phase 0; edge ownership locked +
   the resolver (`resolveGrid`/`tileView`); the directed corner-graph + `connectsSides` solvability;
   the edge-ownership purity refactor (`TileCore`); editor wired to `resolveGrid` + connectivity overlay.
   **Next: Phases 3–4 (Path A, polymorphic IR)** — box-fit + approve the wall pieces (collider boxes
   via the one `box-fit` voxelizer, reusing `getApprovedFootprint`) → `WorldPlacement.unit?` + branches
   → sim-side placement authority → a flagged `TileStyle` builder (placements × frozen footprints →
   units) → render/collision branch on `unit` → solvability gate. (`tileColliders` was deleted — box-fit
   is the single collider generator.) Phase 1 (fold `wallgrid`) and Phase 2 (coloring publish) remain
   independent cleanups.
