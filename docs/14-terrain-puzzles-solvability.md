# 14 — Terrain, Puzzles & Solvability (the "prove every level is solvable" overhaul)

> Status: spec for the GENERATION build. **Solvability is a CORE invariant**: every generated
> level must be *provably completable*, including its puzzles. The independent verifier
> (`src/floor`, per docs/GENERATION-SOLVABILITY.md) is the source of truth — it stays independent
> of the generator. This doc adds (1) richer terrain, (2) puzzle types, (3) the verifier extended
> to **lock-and-key reachability**. The 9-cell wall model has since **shipped** — see
> [`13-generation-architecture.md`](13-generation-architecture.md) for the as-built pipeline. Puzzles
> below are built on the coarse `Floor` graph's door-cell structure, which the tile layer consumes
> rather than replaces, so they carried over unchanged.

---

## 1. Terrain generation — richer floors
- **Scale up** the world from 8×8 toward **~30×30 cells/stratum** — as far as the deterministic
  sim + verifier scale *cleanly*; **measure + report** sim-step + generate + verify cost at 30×30
  (this is a real perf jump: ~900 cells/stratum). If 30 is too heavy, report the honest ceiling.
- **Large open areas** — the room-size distribution should produce some big open halls (sparse
  internal walls), not just small chambers. Open halls still get a perimeter + doorways.
- Everything stays **deterministic** (seeded) and the **verifier must still pass** at the new scale.
- (Multi-level-tall rooms — see §5, deferred to its own design pass.)

## 2. Puzzle types (deterministic, generated; each carries a solvability contract)
- **Locked door + key.** Some doorway edges are **LOCKED**; passing requires a specific **KEY**
  item. Keys are `Pickup` bodies (new `ItemKind.Key` carrying the target `doorId`) → they go in
  the hotbar; approaching/using the matching locked door **consumes the key + opens it** (this
  *fills the interaction agent's door hook* — `isOpenable`/`resolveOpen`, `InteractAction.Open`).
- **Distributed keys / dependency chains.** Place keys so key A is behind a door opened by an
  earlier key, etc. — a DAG of `key → unlocks → door → gates → region(key)`. The generator must
  only emit chains the verifier (§3) certifies solvable.
- **Rug → mat → key reveal.** A room with a **movable RUG** (an interactable prop). Moving it
  uncovers a **mat/hatch** that **pops up a KEY** (spawns the pickup) → unlocks a specific door.
  Models a "search the room" beat. (Rug = a movable/interactable body; reveal is a deterministic
  trigger, hashed.)
- Keys/doors/rugs are **sim entities in WorldState** (hashed) — no `Math.random`, fully rollback-safe.

## 3. Solvability verifier — lock-and-key reachability (THE core deliverable)
Extend the independent verifier to model **state**, not just raw connectivity:
- **Model:** keys = `(keyId, location)`; locked doors = `edge requires keyId`; reveals = `key
  obtainable at location once that cell is reached` (rug counts as reachable-then-obtainable).
- **Algorithm:** fixpoint over `state = (reachable-cell-set, keys-held)`. From entry: flood the
  currently-traversable graph (open edges + doors whose key is held), pick up every key inside the
  reachable set, unlock any door whose key is now held, repeat until **stairs-up is reachable**
  (SOLVABLE) or a full pass adds nothing (**UNSOLVABLE**). This is BFS over reachability-with-keys.
- **Bar:** fuzz **thousands of seeds → 0 unsolvable** (this is the new `prove:floor` gate).
- **Non-vacuity:** add **negative controls** — a key sealed *behind its own door*, an exit walled
  off — must be reported **UNSOLVABLE**. A verifier that passes everything is worthless.
- Keep the verifier **independent** of the generator (re-derives reachability from the compiled
  geometry/edges + the placed keys/doors; shares no "trust me" state with the placer).

## 4. Determinism (non-negotiable, per CLAUDE.md)
Placement = seeded PRNG / coordinate hashes only. Key/door/rug/lock fields live in `WorldState`
(hashed via INT32/BYTE fields, clone/restore/hash covered). The verifier is pure (no sim, no float).

## 5. Deferred — multi-level-tall rooms (answering "rooms many levels tall?")
**Yes, feasible — but it touches the stratum model**, so it gets its own pass. A tall room = omit
the floor slab between strata over the room's footprint and open the vertical void; then the climb
physics, the vertical-follow camera, and the coalescence/fog must all handle a multi-stratum open
space. Recommendation: **design + build it separately** after terrain+puzzles, because the risk is
in the *systems it touches* (physics in a tall void, camera framing, fog), not the generation.
Captured here so it isn't lost.

## 6. ✅ Done — the wall pipeline (was "the 9-cell square")
The "9 cells per square" shipped — and then shipped *again*, differently. **The current pipeline is
`Floor → TileGrid → WallTile → TileUnit → WorldPlacement[] → {render, collision}`** — see
[`13-generation-architecture.md`](13-generation-architecture.md) for the as-built map.

> **Historical note.** This section originally described a `Blueprint → Style → Placement[]` chain in
> `src/floor/{blueprint,wall-style,wall-model}.ts`. **Those three modules were deleted 2026-06-30**;
> the 9-cell TILE lattice superseded them wholesale, and the 2u half-module went with them — a tile is
> now one uniform **4u** square carrying its own walls. Reasoning preserved in
> [`archive/13-abstract-piece-pipeline.md`](archive/13-abstract-piece-pipeline.md).

What still holds, unchanged, in the tile pipeline: **walls own squares** (data layer) at **native 4u**
scale; the piece family (straight / corner / bend / tee / cross / cap / column) is real, but as
**derived labels** (`wall-tile.ts:label()`) rather than stored piece kinds; render and collision
consume **one** `WorldPlacement[]` IR, so they match by construction; break-gates become a LOW
passable arm. Doors are no longer `DOORWAY` placements — `floor-tiles.ts:reconcileDoors` clears the
room wall-ring wherever `floor.edges` actually connects. The puzzles below are unaffected: they are
built on the door-cell structure of the coarse `Floor` graph, which the tile layer consumes rather
than replaces.

---

## Decisions / forks (Jacob — react anytime; sensible defaults chosen so the build can proceed)
1. **World size** — target 30×30, or "as big as stays performant + provable"? (Default: push to 30×30, report the ceiling.)
2. **Multi-level rooms** — defer to its own pass (default, recommended) or attempt inline?
3. **Keys** — carried in the hotbar + consumed when opening the matching door (default), or auto-used on contact?
4. **Open-area size** — a few large halls per floor, or mostly large? (Default: mix, a couple of big halls.)
