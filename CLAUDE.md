# ASCENT — contributor & agent guide

A realtime multiplayer **vertical escort brawl-race**. Browser game, TypeScript + Vite + Three.js,
**rollback netcode** over WebRTC, on a **custom deterministic fixed-point physics engine**. This
file captures the non-obvious decisions so they aren't reverted. Full design corpus in `docs/`.

## Read first
- `docs/00-master-vision.md` — the canonical spec (genre, 12 pillars, resolved tensions, data flow).
- `docs/DECISIONS-LOG.md` — how we got here + every locked decision (start here for *why*).
- `docs/ENGINE-ARCHITECTURE.md` — the custom physics engine (fixed-point; Rapier = test oracle only).
- `docs/GENERATION-SOLVABILITY.md` — floor generation + the independent solvability verifier.

## Run / prove / test
```bash
npm install
npm run dev            # vite dev server
npm run typecheck      # tsc -b --noEmit
npm test               # vitest suite

# Standalone proofs — run WITHOUT installing anything (Node 22+, type-stripping):
npm run prove:fixed    # fixed-point math vs a BigInt-exact oracle (~900k checks)
npm run prove:floor    # floor generator + verifier fuzz (once the floor module lands)
```

## THE non-negotiable rule: the simulation is deterministic
Rollback requires every peer to compute **bit-identical** results from the same inputs and to
re-simulate past frames. Therefore, inside `src/sim/` (and anything the sim touches):

- **No floats. Ever.** Use `Fixed` (Q16.16) from `src/sim/fixed/`. Floats are for the render layer only.
- **No `Math.random`.** Use the seeded sim PRNG. **No `Date`/`performance.now()`** in the sim — the sim
  is driven by an integer **tick counter**. Wall-clock lives only in the transport layer (RTT/timeouts).
- **No `Math.sin/cos/sqrt`** in sim math — use `fixed.ts` (`sqrt` is an exact deterministic floor-sqrt;
  `sin/cos` are deterministic fixed-point approximations). `Math.sqrt` is allowed *only* as the seed of
  the integer-corrected `isqrt` (its rounding can't affect the final result).
- **No `Map`/`Set` iteration on output-affecting paths.** Iterate sorted ids / packed arrays so order is
  fixed across engines.
- Everything lossy/nontrivial gets a **proof or property test** against an exact oracle (BigInt, or
  Rapier for physics correctness). See `src/sim/fixed/prove.ts` for the pattern.

The determinism discipline is also why the riskiest code is the most testable: the sim is headless and
pure, so it's provable without rendering or networking.

## Architecture (build order = bottom-up, prove each layer)
```
src/sim/        deterministic simulation (no DOM, no net)
  fixed/        ✅ PROVEN — fixed-point scalar + vector math, the bedrock
  (next) math/ body/ spatial/ collide/ charctl/ verbs/ hazards/ world/
                  per docs/ENGINE-ARCHITECTURE.md. world exposes the only API the
                  netcode needs: step(state,inputs,tick) / hash(state) / clone / restore.
src/floor/      🔨 (in progress) deterministic floor generation + INDEPENDENT verifier (pure graph)
src/net/        rollback manager, input bus (mesh|relay iface), wire format, clock sync.
                  Grafts Frequency's peer/migration patterns (c:/Users/Jacob/Documents/Projects/frequency/src/net).
src/render/     Three.js: vertical-follow camera, layered-visibility + coalescence (view-only; reads sim).
src/game/       roles, strata, hazards, boons (game-data types).
```
Path aliases: `@sim/* @net/* @render/* @game/* @floor/*` (see tsconfig + vite/vitest config).

## Conventions
- TS strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Use `import type` for types. Guard array index access.
- Standalone `prove.ts` files use **relative imports with explicit `.ts` extensions** so Node's
  `--experimental-strip-types` can run them dependency-free (`allowImportingTsExtensions` is on).
- Many small, well-named files with doc comments explaining the WHY. Quality and robustness over speed.

## Reuse from Frequency
The sibling shipped game `c:/Users/Jacob/Documents/Projects/frequency` proves the P2P/WebRTC layer:
host/peer roles, single-reducer authority, deterministic room-code→peerId, **silent host migration**
(generation ladder), PeerJS signaling + STUN/TURN. `src/net/` will adapt these for rollback.
