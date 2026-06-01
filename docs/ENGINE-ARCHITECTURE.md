# ASCENT — custom deterministic physics engine (architecture lock)

Status: decided in conversation 2026-05-31. Supersedes "use Rapier in production" — Rapier is now
an **oracle**, not the runtime engine. Feeds 05-netcode-architecture.md.

## The decision
Build our OWN deterministic physics engine. Use **fixed-point** integer math (determinism by
construction). Use **Rapier as a test ORACLE** (reference implementation we compare against in
tests within a tolerance), never in the shipped runtime. Goal: own the physics, control the feel,
make a name in this space. Engine must be clean, robust, composable, isolation-first, extensible.

## Why this is defensible (not the usual trap)
The "never write physics" advice assumes GENERAL rigid-body dynamics (arbitrary hulls, stacking,
friction, joints, CCD). ASCENT needs a SMALL, SPECIFIC vocabulary instead:
- Kinematic character controller (capsule/AABB move-and-slide on authored terrain) — NOT full dynamics.
- The 4 kinematic verbs (carry=parent-socket, throw=ballistic single body, rush=swept capsule, struggle=state).
- Thrown objects = simple ballistic bodies with bounce.
- Static authored terrain + authored-destructible tiles + weight-sensitive ground (trigger/timer).
- NO box-stacking, NO true ragdoll (fake the Gang-Beasts juice in the VIEW layer), grab-trains capped at 3
  as kinematic composites.
This subset is a few-months build, not a multi-year one.

## The deep win: fixed-point kills float determinism risk
Cross-browser float determinism (x87 vs SSE, FMA, trig LUTs) is an UNBOUNDED rabbit hole. Fixed-point
integer math is exact and identical across every JS engine by construction. We trade an unbounded
uncertainty for a BOUNDED, known set of gotchas (overflow/range, division precision, sqrt/trig via
deterministic methods, and the discipline that NO float ever enters the sim). Known work > unknown risk.

## Rapier as oracle (correctness vs determinism, cleanly separated)
- OUR engine guarantees DETERMINISM (fixed-point, by construction).
- RAPIER checks CORRECTNESS: a test harness builds an equivalent Rapier scene, steps both, asserts our
  trajectories match Rapier's within tolerance. Catches "our physics is wrong/unrealistic" bugs without
  importing Rapier's determinism uncertainty into production. Lives in tests/, never in the bundle.

## Module decomposition (composition + isolation; physics knows nothing of net/render)
- `fixed/`     — Fixed type (Q-format), det. add/sub/mul/div/sqrt, trig via LUT. Bedrock. 100% unit-tested.
- `math/`      — vec2/vec3, transforms over Fixed.
- `body/`      — bodies as COMPOSED components (Transform, Velocity, Shape{AABB|Capsule|Circle}, Mass, Flags);
                 struct-of-arrays for cache + deterministic (array order == iteration order).
- `spatial/`   — `SpatialIndex` interface (grid OR quadtree impl). DISJOINT per stratum. (see below)
- `collide/`   — narrowphase for the small shape-pair set; resolution = position correction (kinematic), no impulse solver.
- `charctl/`   — kinematic move-and-slide character controller.
- `verbs/`     — grab/throw/rush/struggle as systems over bodies (kinematic transforms; throw idempotent by (id,tick)).
- `hazards/`   — scripted hazards as pure functions of the tick.
- `world/`     — deterministic `step(state, inputs, tick) -> state` (fixed system order), `hash(state)`, `clone/restore`.
Netcode (rollback) only calls step/hash/clone/restore. Render only reads state. "Easily added onto" =
new shapes/verbs/hazards plug in without touching world step ordering (open-closed).

## The spatial index serves THREE consumers (one structure, three jobs)
A deterministic spatial partition does: (1) broadphase collision, (2) AREA OF INTEREST (what's near a
crew's Anchor = the tight-sync set; cluster-merge = do two Anchor regions overlap), (3) render/coalescence
cull. AoI is just a region query around each Anchor.
- DISJOINT per-stratum trees (user's instinct): bounds each tree's size, independently rebuildable,
  maps exactly onto "AoI = vertical proximity / your stratum."
- OPEN TRADEOFF (decide at build): uniform GRID / spatial-hash is simpler & arguably MORE deterministic
  (cell-by-cell insertion, no tree balancing, trivial rebuild) and likely faster for bounded floors with
  ~tens of entities; QUADTREE handles high-openness open-arena floors with clustered density better. Hide
  behind the `SpatialIndex` interface so we can swap/measure. Whatever we pick MUST have deterministic
  insertion order & subdivision.

## Discipline (the cost we accept)
- NO float in the sim, ever (lint/guard for it).
- Fixed-point overflow/range budgeting; deterministic sqrt (Newton) & trig (LUT).
- Deterministic iteration order everywhere (SoA arrays, sorted ids — never Map/Set iteration on the hot path).
