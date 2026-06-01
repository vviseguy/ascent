# ASCENT — floor generation & provable solvability (design note)

Status: design-locked in conversation 2026-05-31. Feeds 09-level-generation.md.
Engineering principle this doc exists to serve: **never trust the generator's claim of
solvability — prove it independently, and fuzz it.**

## The solvability invariant (the one thing that must always hold)
> A floor is "solvable" iff a SOLO, HEAVY ANCHOR — capable of the UNIVERSAL actions
> (walk, grab, throw [fists/objects], break blocks, hold buttons with own weight, struggle) —
> can reach at least one up-route (exit) from the entry **via the FALLBACK LAYER**.

The Anchor is the most-constrained traverser, so solo-Anchor-solvable ⇒ solvable for any crew.
Because ALL players share the universal action set (roles = advantage, not access), the proof
NEVER depends on which roles are present.

### The FALLBACK LAYER (decided 2026-05-31 — supersedes "static spine only")
Timed/fancy gates (sinking floors, crusher windows, two-holder doors, must-be-thrown gaps) ARE
allowed on the main/fast routes — richer required gameplay. Solvability is guaranteed not by
keeping those routes simple, but by a **universal worst-case fallback that always exists**:
- **Every block is EVENTUALLY breakable** (anyone, given enough time — specialists just faster).
- **Players can ALWAYS go around the edge/perimeter** of a floor.

So the proof obligation is: **the fallback layer connects entry → an exit.** The fallback layer =
the floor's traversal graph with (a) every breakable block treated as passable and (b) the
perimeter route included. This is a **pure static graph reachability** check — always provable,
no temporal reasoning needed — and it makes catastrophic unsolvability **structurally impossible**
no matter how the timed gates are tuned. Fast/timed routes are *optimizations layered on top* of a
guaranteed-passable fallback; if you can't make the crusher window, you can always (slowly) break
through or walk the edge.

Consequence for testing: because the fallback guarantee is structural, we **smoke-verify
periodically** (sample floors across the knob space each run/build) rather than exhaustively
fuzzing every floor. The verifier still computes route counts where we want them.

Corollary (load-bearing co-op without fragility):
- Co-op/timed gates make the FAST routes; the FALLBACK layer is the slow universal guarantee.
- Co-op carry still matters because the fast routes need it and the race rewards speed — but a lone
  surviving Anchor is never hard-stuck (break through / walk the edge).

## Generation: spine → openness → dressing (generalized maze instinct)
Coarse grid of cells (each = a room-chunk slot). Edges between adjacent cells are TRAVERSAL
EDGES tagged by how they're crossed: WALK / GAP / BREAK / BUTTON / WEIGHT.

1. **Spine (correct-by-construction).** Carve `k` edge-disjoint paths entry→exit, each
   solo-Anchor-traversable. Lock-before-key: a gate edge may be placed only if its "key"
   (button, bridge-source, throwable, break-tool — all universally usable) is already reachable
   on the correct side. This is the maze "only connect to a not-yet-connected cell" rule
   generalized to lock/key reachability.
2. **Openness (0..1).** Add extra edges/openings beyond the spines. 0 = tight maze, 1 = open
   arena, between = loopy multi-route. Adding edges can never remove the guaranteed path, so the
   invariant survives any openness. Flashpoint floors = high openness + chokepoint chunk.
3. **Dressing.** Fill each cell with an authored chunk whose furniture matches its edge tags
   (clean-ish grid, visually de-boxed). Authored-destructible only (designated breakable/
   weight-sensitive tiles & objects — NOT free-deformable terrain).

All random choices seeded from `run-seed + stratum-index` → every peer generates the identical
floor (rollback-safe).

## Generator config knobs
| knob | effect |
|---|---|
| gridSize | floor scale |
| openness (0..1) | labyrinth ↔ open arena |
| guaranteedRoutes: k | # independent good paths (see verifier) |
| gateWeights | frequency of GAP/BREAK/BUTTON/WEIGHT gates |
| biomeChunkSet | which authored chunks dress cells |

## The VERIFIER (independent proof — the anti-laziness centerpiece)
A separate module that knows nothing about how a floor was built. Given a finished floor:
1. Build the **fallback-layer** traversal graph (every breakable block passable + perimeter route).
2. Flood-fill reachability: assert ≥1 exit reachable. (kills "impossible floor".)
3. Max-flow with unit-capacity edges = count of edge-disjoint routes (Menger's theorem); assert
   flow ≥ k for the routes we asked the generator to guarantee. (confirms "number of good paths".)
Generator and verifier compute `k` by different methods and MUST agree. Static graph only — the
fallback layer never requires temporal reasoning, so the proof is always decidable.

## Robustness regime (isolate, prioritize, test — prove it)
- Verifier is PURE/headless/deterministic — no physics, no network. Buildable & provable in total
  isolation. It's a "hard task we can fully prove EARLY."
- Property/fuzz test: run the verifier on tens of thousands of generated floors across all knob
  combinations & seed ranges. Any failure = a single reproducing seed (determinism = free repro).
- Runtime safety net: if a live floor ever fails verification, regenerate from a fallback seed
  rather than ship an impossible floor.

## Roles = advantage, not access (locked)
Universal baseline for everyone: walk, grab, throw (fists or objects), break blocks (slow),
hold buttons (own weight), struggle. Specialists are faster/better/safer:
- Breaker: instant breaks, can break REINFORCED blocks (specialist-only → optional routes only).
- Engineer: sturdy bridges/blocks vs anyone's crude version.
- Bulwark: hauls heavy w/ less encumbrance, strong shove, anti-grab.
- Runner: jumps/gaps others can't (→ optional shortcut routes).
- Mender: heal/revive/catch fallers.
Anchor: full-capability, just HEAVY (and the only one whose height scores).
