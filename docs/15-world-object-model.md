# 15 — World-Object Model (entity / environment / spawning, and the OO line)

> The deliberate split between the **deterministic data-oriented sim** and an **object-oriented
> view/authoring layer**, the terminology we use, the `WorldObject` abstraction (variants +
> composition), how it binds to collision, and how it layers under world generation. Companion to
> the Asset Lab (`src/lab`, docs/ART-LAB.md) which becomes the catalog viewer.

## 1. Two worlds, on purpose

| | SIM (`src/sim`, `src/game`) | VIEW / AUTHORING (`src/render`, `src/lab`) |
|---|---|---|
| unit | **Body** — a row in `WorldState` SoA arrays | **WorldObject** — a built scene-graph + variants |
| style | **data-oriented, no classes** | **object-oriented, composable** |
| why | rollback needs `clone/restore/hash` bit-identical over flat typed arrays; no float, no `Math.random`, no `Map` iteration on output paths | reads the sim; floats + seeded randomness + OO are all fine; has **no authority** |
| identity | `BodyFlag` bits + `MassClass` + `ItemKind` + `Role` | a named type + a chosen **variant** |

The sim is "un-OO" by **requirement**, not neglect: a player, the Anchor, a throwable, a breakable,
a pickup/key, a door, a rug are all the *same struct* (`spawnBody(world, spec)`), distinguished by
flags. The OO modeling the user wants lives **on the view/authoring side** and never crosses back.

## 2. Terminology (use these words in code + chat)

- **Body** — a tangible, dynamic sim thing (one `spawnBody`). NOT "entity object."
- **Environment / layout** — static, compiled: the **terrain** (immutable AABB collision solids)
  + `CompiledTower.cellGrid` (per cell: `type` ROOM/CORRIDOR/DOORWAY/WALL/VOID, `wallMask`,
  `stair`, `hole`, `roomId`) + `StairInfo` + `PuzzleSpawn`.
- **Tangible spawning** — two paths: dynamic → `spawnBody` (scene.ts wires crews + `PuzzleSpawn`
  bodies); static → the compiler (`tower.ts` emits terrain + cellGrid).
- **WorldObject** — view/authoring: a renderable type with **variants** and an optional **footprint**
  (its collision shape). The thing the dungeon renderer *instantiates* for a cell/Body.
- **Variant / mode** — a named visual version of a WorldObject (Door: `plain` / `barred` / `handled`).
- **Level** — `object` (wall, table, door) → `grouping` (table + spread) → `room` (staircase room).

## 3. The `WorldObject` abstraction (`src/lab/world-object.ts`)

```ts
interface WorldObject {
  name; describe;
  level: 'object' | 'grouping' | 'room';
  variants: string[];                       // e.g. ['plain','barred','handled']
  build(variant, seed): {
    root: THREE.Object3D;                    // base at y=0, like LabElement
    radius?: number;
    footprint?: Footprint;                   // collision boxes in object-local space
  };
}
```

It is a **superset of `LabElement`** (`build(seed) → { root }`) with three additions:
1. **variants** — the "different modes/versions of each model" (doors w/ handle + metal bars).
2. **footprint** — the collision shape *authored next to the visual*, so one definition feeds the
   renderer AND the collider. This is literally docs/13 §C-bis "collision matches the visual": when
   Layer C lands, the compiler reads a WorldObject's `footprint` to emit its AABBs instead of a
   blanket cell box.
3. **level + composition** — a `grouping`/`room` `build()` composes *other* WorldObjects (a
   stair-room places wall + stair + door objects), so abstraction stacks.

## 4. How it layers under world generation (separation of concerns)

```
GENERATION (sim, proven)                 |  REALIZATION (view, OO)
floor graph → cellGrid + roles + puzzles |  WorldObject registry: cell/role → object + variant
"WHERE + WHAT-ROLE" (deterministic)      |  "WHICH object + HOW it looks" (view-seeded)
            └──────────── interface: cellGrid / PuzzleSpawn / StairInfo ────────────┘
```

- Generation decides **where** and **role** (this cell is a DOORWAY, this is a `treasure` room, the
  key is here) — pure, deterministic, *proven* (docs/13 A–C, docs/14).
- The WorldObject layer decides **which object + variant** realizes it (docs/13 Layer D dressing),
  keyed by room theme/role.
- **Determinism boundary (hard rule):** anything gameplay-affecting (a cell *is* a door; a key's
  cell) comes from the generator. Purely-cosmetic variant choices (which door texture) are
  **view-seeded by cell hash** and never feed back into the sim or the solvability verifier.

## 5. The catalog viewer (extends the Asset Lab)

`lab.html` + `src/lab/lab.ts` already auto-discover `LabElement`s and render them on a studio
turntable with snapshot hooks. We extend the same endpoint to also browse **WorldObjects**:
`?object=<id>&variant=<name>&seed=N`. You iterate a door's handle/bars in isolation, screenshot,
review — at all three levels (object → grouping → room) — before it touches a generated floor. This
is the "endpoint for tools/tests" ask, built on what exists rather than a new harness.

## 6. Roadmap
1. **(this slice)** `WorldObject` contract + a **Door** (`plain`/`barred`/`handled`) + a `grouping`
   and a `room` example, browsable in the lab. Proves the abstraction end-to-end.
2. Port the dungeon's existing tiles (wall/floor/pillar/stairs/props) into WorldObjects with
   footprints — the renderer instantiates from the registry instead of ad-hoc in `dungeon.ts`.
3. Layer C reads WorldObject `footprint`s to emit collision (collision-matches-visual).
4. Generation Layer-D dressing chooses objects + variants by room role.
