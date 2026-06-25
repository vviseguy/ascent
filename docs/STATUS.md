# STATUS — goal & critique ledger (audit 2026-06-25)

Living checklist of every goal/critique set in this build stream, with status. Legend:
**✅ done** (shipped + verified green) · **🔄 in progress** (delegated, owner + doc) ·
**📄 deferred-doc** (intentionally deferred, documented) · **⚠️ gap** (now logged).

## A. Foundations
- ✅ 3D model + animation pipeline research
- ✅ Stubby/cute ~1×1×1.25 procedural characters
- ✅ Better-graphics / AI-mesh research
- ✅ Render/animation/GLB pipeline finished + screenshot review loop
- ✅ Multiple model + world-style demos with a picker
- ✅ "Clean" default world + stocky humanoid characters from a SAFE (CC0, non-NSFW) source → KayKit

## B. World / dungeon environment
- ✅ Full KayKit Dungeon tileset cataloged + loaded; procedural rooms
- ✅ Lighting polish (emissive torches/candles + bloom)
- ✅ Chest breaks into gems (gem drops fixed)
- ✅ Map size varies per load (random seed each load); wider footprint
- ✅ 7 themed rooms with personality (library/dining/bedroom/storage/armory/treasure/shrine)
- ⚠️ **Water polish** — early "add water" ask never became a visible feature (a `water` concept exists in sim hazard/data only). Minor; logged here so it isn't silently dropped. Revisit as a render polish if wanted.

## C. Camera / movement / controls (docs/11)
- ✅ Camera centers on the local player + off-screen indicators for others
- ✅ 90° facing offset fixed
- ✅ Focus-relative movement; camera orbit; middle-click recenter; gentle facing reorient on fwd/back
- ✅ Auto step-up small steps/slopes; smoother step-up + character glide on short hops
- ✅ Movement/feel spec recorded (docs/11)
- ⚠️ **Opening view sometimes black (NEW follow-up)** — on edge-spawn seeds the default camera dolly frames the perimeter wall/void → black at default zoom (zooming out shows the dungeon fine). A camera default-distance/framing × edge-spawn interaction; flagged by W2.
- 🔄 **30×30 dungeon renders BLACK on load (regression at scale)** — render was tuned at 8×8; now the world is 135u across and the default camera/fog frames pure black (HUD fine, no JS errors → it builds). Render-polish agent fixing camera framing + fog-at-scale + build perf (+ folding in the black-opening-view above and wall D1–D3).

## D. Interaction / inventory / HUD (docs/12 — interaction agent, all green: 76/76 + prove:interact)
- ✅ Health shown (HUD pill)
- ✅ Active Minecraft-style pan (left-drag), NOT infinite edge-hold
- ✅ 5-slot scroll-select hotbar (wheel / 1–5)
- ✅ Primary/secondary contextual interaction (left-tap / right) + Minecraft-Dungeons-style hint chips
- ✅ Chest opens on right-click when hand free; pick up the item at a spot in front of the player
- ✅ Regular click = translate-pan; clean suggested-action UI matching app vibe
- ✅ Placeholder "not real" cubes removed → KayKit props
- ✅ Interaction scheme doc — cohesive, idiomatic, no input collisions (docs/12)
- ✅ Fall damage softened

## E. Walls / doors / corners / stairs
- ✅ Walls not stacked (dedupe); half-walls per side; bookshelf-on-one-side possible
- ✅ Doorways full-through (see/walk through)
- ✅ Corner pillars full-height; only at TRUE convex corners (none at T-junctions)
- ✅ Old stairs removed; KayKit straight staircase (sim: climbable, proven solvable)
- ✅ "Soft wall flow" explained (inset half-walls + corner overlap + protruding doorways) — docs/13
- ✅ **Stairs aligned to collision** — exact `StairInfo` placement; bounding boxes verified identical to the sim treads (W2)
- 🔄 **Door click-to-open (lock/key)** — interaction door hook left; generation agent (W1) filling lock+key open
- 📄 **Drag-open "carry the door"** — documented + phased (docs/12 §3.4), after hinge physics

## F. Fog / visibility
- ✅ Walls between camera and player fade (occlusion cutaway) — kept + clearly separated
- ✅ **Black-liquid-shadow redo** — grid-aligned black-cube fill + reachable-cell BFS reveal; no camera-aligned/screen-space quads (W2, both refinements addressed)

## G. Textures / materials
- ✅ **Real stone/wood/metal textures, no stretching** — root cause: KayKit ships a shared gradient *palette atlas* (that WAS the "gradients"); replaced with CC0 PBR sets + world-planar (scale-invariant) UV so nothing stretches (W2)

## H. Generation architecture (docs/13)
- 📄 Alternating wall/open grid + semantic layers (a room = "library") + tree/graph — answered as a 4-layer model (graph → space → wall-grid → dressing)
- 📄 Collision should MATCH the on-screen shape — design captured (Layer C = single source for render + collision, §C-bis)
- 📄 **9-cell-per-square** (1 center + 4 candidate walls + 4 quarter-columns) = the wall/edge grid; the eventual structural refactor (docs/13/14 §6)

## I. Terrain / puzzles / SOLVABILITY — the core (docs/14 — W1, opus 4.8) — DONE green
- ✅ **Prove every level is solvable (CORE)** — `lockKeyReachable` verifier (fixpoint over reachable-cells × keys-held); fuzz **9800 floors incl. grid-30 → 0 unsolvable**; **5 negative controls** (key-behind-own-door, walled exit, circular deps, …) all correctly UNSOLVABLE (non-vacuous)
- ✅ Puzzle types: locked doors + keys (BodyFlag.Door, ItemKind.Key), distributed-key DAG chains (chain-then-verify), rug→mat→key reveal (BodyFlag.Rug) — door hook FILLED
- ✅ Large open halls (~2.6/floor)
- ✅ World **30×30** (~900 cells/stratum) — performant: per-tick **1.78ms** via a cached uniform-grid collision broadphase (was 8.8ms), hashes byte-identical

## J. Deferred-documented (intentional)
- 📄 Rooms many levels tall (docs/14 §5 — own pass; touches stratum/physics/camera/fog)
- 📄 9-cell model / Layer C wall-edge grid (docs/13/14 §6)
- 📄 Drag-open door (docs/12 §3.4)

## K. Process
- ✅ Orchestration workflow: boss plans → delegates → continuous queue (saved to memory)
- 🔄 Todo discipline / organize + delegate — ongoing standing duty

## Bottom line
Nothing dropped. Everything is **done**, **in-progress with a named owner + doc**, or
**deferred-and-documented**. The only previously-undocumented item was **water** (§B) — now logged.
The open "reached?" questions are the two running opus-4.8 agents (W1: terrain/puzzles/solvability;
W2: textures/fog/stairs) — verified on landing.
