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
- **Working on world generation / rendering?** → [`docs/13-generation-architecture.md`](docs/13-generation-architecture.md) (the *realized* pipeline + its tracked debt), [`docs/14-terrain-puzzles-solvability.md`](docs/14-terrain-puzzles-solvability.md), [`docs/15-world-object-model.md`](docs/15-world-object-model.md).
- **Working on assets / colors?** → [`src/lab/CLAUDE.md`](src/lab/CLAUDE.md) (authoritative — the `recolor.ts` swatch system) + [`docs/ART-LAB.md`](docs/ART-LAB.md).
- **What to work on next** → [`BACKLOG.md`](BACKLOG.md) (the live queue) + [`docs/GAPS.md`](docs/GAPS.md) (the intent audit it draws from).

## Run / prove / test
```bash
npm install
npm run dev            # vite dev server (play the sandbox)
npm run typecheck      # tsc -b --noEmit
npm test               # vitest suite
npm run prove          # run EVERY determinism proof (13 of them; zero deps, Node 22+)
npm run build          # tsc -b && vite build (also the CI/Pages build)

# Asset Lab (browse/iterate KayKit models + colors in isolation):
npm run lab            # opens lab.html — turntable gallery + box-fit + recolor legend
npm run lab:snap -- <element>   # headless screenshot of one element (agents can see PNGs)
npm run probe:palette  # sample the real GLBs → which atlas swatch each triangle lands on

# Standalone proofs run WITHOUT installing anything (Node 22+, type-stripping):
npm run prove:fixed    # fixed-point math vs a BigInt-exact oracle
npm run prove:floor    # floor generator + solvability verifier fuzz
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
                   PLUS the realized wall pipeline: generate → blueprint → wall-style → wall-model.
src/game/       ✅ tower compiler (floor → terrain + the WorldPlacement IR), strata, scoring,
                   win conditions, crew identity, beacons, roles/abilities.
src/render/     ✅ Three.js: vertical-follow camera, fog/occlusion cutaway, dungeon mesh builder
                   (view-only; reads the sim). Colors via the LEGACY themes/materials path (see debt).
src/lab/        ✅ the Asset Lab: KayKit catalog, box-fit collision voxelizer, the recolor engine,
                   WorldObject viewer + headless snapshot harness. (Authoritative guide: src/lab/CLAUDE.md.)
src/net/        ✅ rollback primitives + proofs (input bus, wire format, clock sync) — NOT yet wired
                   to a live 2-browser match (that's BACKLOG "Pressure + the race"). Grafts Frequency.
```

### The realized worldgen pipeline (the load-bearing seam — read docs/13 before editing it)
```
Floor graph (src/floor/generate.ts)
  → Blueprint  (src/floor/blueprint.ts)      square lattice
  → Style      (src/floor/wall-style.ts)     Placement[]   (DefaultStyle auto-tiles squares → pieces)
  → IR         (src/game/tower.ts)            WorldPlacement[]  — ONE IR, native KayKit 4u / 2u modules
  → render (src/render/dungeon.ts) + collision (src/game/tower.ts)   both off the SAME IR → match by construction
```

### Tracked debt — known, intentional, don't trip on it (full detail in docs/13)
1. **Two lattices for one truth** — `wallgrid.ts` (edge/junction) and `blueprint.ts` (square) encode the
   same topology twice; junction classification lives in both. Intentional Phase-1 reuse; fold WallGrid
   into Blueprint before adding new wall logic, or it calcifies.
2. **Stub "Program" layer** — rooms-as-graph / roles / themes are still tangled in `generate.ts`
   (themes exist only render-side). Topology-roles / BSP-space / first-class dressing are aspirational.
3. **`profile` (FULL/LOW/GAP) is a 3D hook** — only collision height varies on it today; everything
   underneath is per-stratum 2D.
4. **Coloring is split** — the lab is authoritative via `recolor.ts`, but the game renderer still uses
   the legacy `themes.ts`/`materials.ts`; unifying needs the recolor tables published out of `src/lab`.

Prefer reconciling (1) + the spec before piling on new features — the duplication is the main risk.

## Conventions
- TS strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Use `import type` for types. Guard array index access.
- Standalone `prove.ts` files use **relative imports with explicit `.ts` extensions** so Node's
  `--experimental-strip-types` can run them dependency-free (`allowImportingTsExtensions` is on).
  Strip-only mode forbids TS `enum`/namespaces → use `const X = {...} as const` + a `type X` alias.
- Many small, well-named files with doc comments explaining the WHY. Quality and robustness over speed.
- Scratch/experiment files go in `tmp/` (gitignored). Don't commit them.

## Reuse from Frequency
The sibling shipped game `c:/Users/Jacob/Documents/Projects/frequency` proves the P2P/WebRTC layer:
host/peer roles, single-reducer authority, deterministic room-code→peerId, **silent host migration**
(generation ladder), PeerJS signaling + STUN/TURN. `src/net/` adapts these for rollback (REUSE the
connection lifecycle; REPLACE the host-authoritative loop with peer-symmetric rollback).
