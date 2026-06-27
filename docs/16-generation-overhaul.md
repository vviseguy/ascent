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

## 2. The lattice: uniform 4u + composites

**Decision: one uniform 4u lattice. No 2u sub-modules. Sub-4u detail lives inside composite units.**

The lattice is just the **4u grid**:
- **cells** — 4u floor tiles (one slot each, for floor + content);
- **edges** — one wall slot per 4u edge between adjacent cells;
- **vertices** — junction posts where edges meet.

This collapses today's `(2W+1)×(2H+1)` blueprint to its natural 4u reading and **retires the 2u
half-module**. It also resolves the "two lattices for one truth" debt (§10 / docs/13 §1): there is one
lattice, classified once.

**Composites are where richness comes from** — two kinds:
- **In-place composites** bake sub-4u detail into a *single* slot: a `wall-with-door` (a 4u edge unit
  whose footprint has a gap), a `wall-with-shelf`, a `window-wall`, a `half-wall`. A doorway narrower
  than a full edge is *authored into the unit*, not positioned in the lattice.
- **Multi-slot composites** span N adjacent slots: a 2-wide archway, a 2×2 shrine, a multi-cell
  staircase. They claim all their slots from one anchor and map onto the IR's existing `Placement.span`.

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

---

## 3. Constraints: three orthogonal axes

A slot's eligibility is decided by three things that must **never be conflated**:

1. **Sockets** — a per-face *physical mating contract* in a small **closed** alphabet (owned by the
   generator). Two adjacent slots are compatible iff their facing sockets are complementary. This is
   "WFC adjacency", named by physical meaning. *Sockets are few.*
   `WALL_FLAT | WALL_END | POST | OPEN | DOORWAY | VOID`
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

- **Phase 0 — kill dead code + un-stale the map** (no behavior change): delete `themes.ts`; fix the
  stale coloring-debt docs; remove `Cell.chunkType` + its substream. *[this commit]*
- **Phase 1 — one lattice:** port wallgrid's rules (edge-wins-over-cell-type, openCells forced-open,
  junction classification) into `blueprint` deriving directly from `floor`; cut consumers over behind an
  equivalence test; delete `wallgrid.ts`. Resolves debt #1.
- **Phase 2 — finish the coloring publish:** move recolor tables to a neutral home; delete
  `retexture.ts`; demote `materials.ts` to the flame/no-atlas fallback.
- **Phase 3 — IR extension for composable units:** extend `Placement`/`WorldPlacement` with a unit-id +
  socket/tag fields (additive; consumers ignore unknown units → no behavior change); add a unit registry
  so non-wall units emit collision via `box-fit` footprints through the *same* decompose.
- **Phase 4 — the collapse generator** behind `WallStyle.realize`; the requirement queue compiles down
  to `LockedDoor`/`KeyItem`, certified by the unchanged `verify.ts`.
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
4. **Where to start the real build** — Phase 1 (one lattice) is the natural first refactor after this
   doc + Phase 0.
