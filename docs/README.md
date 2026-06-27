# ASCENT — docs index

The design corpus. **Start with [`00-master-vision.md`](00-master-vision.md)** (the canonical spec)
and [`DECISIONS-LOG.md`](DECISIONS-LOG.md) (why the design is what it is). Agent/contributor guide
lives at the repo root: [`../CLAUDE.md`](../CLAUDE.md).

## Canonical — design pillars (locked vision; numbered set)

| Doc | What it covers |
|---|---|
| [00-master-vision.md](00-master-vision.md) | The spec: genre, 12 pillars, resolved tensions, data flow. **Read first.** |
| [01-game-design.md](01-game-design.md) | Moment-to-moment loop, strata, the Anchor-escort core, win conditions. |
| [02-roles-anchor-verbs.md](02-roles-anchor-verbs.md) | The 6 identities, 4 verbs, mass hierarchy, grab pressures, carry/revive. |
| [03-progression-economy.md](03-progression-economy.md) | Boon drafts, rubber-band math, run economy. |
| [04-competitive-structure.md](04-competitive-structure.md) | Lobbies, win-conditions, flashpoints, PvP tuning, crew size. |
| [05-netcode-architecture.md](05-netcode-architecture.md) | Rollback (GGPO), AoI-on-Anchor, determinism, transport. *(v2-on-disk; v3 rewrite pending — see archive/ROADMAP.)* |
| [06-art-direction-shaders.md](06-art-direction-shaders.md) | Coalescence visuals, fog/desaturation, palette, identity colors. |
| [07-ux-ui-gamefeel.md](07-ux-ui-gamefeel.md) | Camera, HUD, readability, juice, onboarding, accessibility. |
| [08-audio.md](08-audio.md) | Audio cues paired with feel beats. |
| [09-level-generation.md](09-level-generation.md) | Floor geometry, hazards, kill-planes, persistent tower, destructibles. *(v2-on-disk; v3 rewrite pending.)* |
| [11-controls-and-interaction.md](11-controls-and-interaction.md) | Camera control, input mapping, split affordance. |

*(Numbering skips 10 and 12 intentionally — never authored.)*

## Canonical — architecture & invariants

| Doc | What it covers |
|---|---|
| [DECISIONS-LOG.md](DECISIONS-LOG.md) | Chronological record of every locked decision. The **why**. |
| [ENGINE-ARCHITECTURE.md](ENGINE-ARCHITECTURE.md) | The custom fixed-point physics engine; Rapier = test oracle only. |
| [GENERATION-SOLVABILITY.md](GENERATION-SOLVABILITY.md) | The solvability invariant + the independent verifier contract. |

## Current build — the worldgen / asset overhaul (implemented)

| Doc | What it covers |
|---|---|
| [13-generation-architecture.md](13-generation-architecture.md) | **The realized dungeon pipeline** (Blueprint→Style→Placement→IR→{render,collision}) + tracked debt. |
| [14-terrain-puzzles-solvability.md](14-terrain-puzzles-solvability.md) | Richer terrain (30×30), puzzle types, lock-and-key reachability. |
| [15-world-object-model.md](15-world-object-model.md) | The sim-vs-view split; the `WorldObject` abstraction (variants + footprint). |
| [ART-LAB.md](ART-LAB.md) | The Asset Lab — catalog viewer + screenshot review loop. |
| [`../src/lab/CLAUDE.md`](../src/lab/CLAUDE.md) | **Authoritative** asset coloring guide (the `recolor.ts` swatch system). |

## Live planning

- [`../BACKLOG.md`](../BACKLOG.md) — the single live task queue (Now / Next / Later / Done).
- [GAPS.md](GAPS.md) — the v2 intent audit; BACKLOG's "Next" items cite `GAPS #4–10`.
- [PARKING-LOT.md](PARKING-LOT.md) — deferred-but-not-rejected ideas.

## archive/

Point-in-time documents, kept for history, superseded by the live docs above:

- `archive/AUDIT-v1.md` — the v1 audit; superseded by `GAPS.md` (v2).
- `archive/audit2/` — the six dimension re-audits that were synthesized into `GAPS.md`.
- `archive/ROADMAP.md` — the P0–P5 build sequencing + the netcode "Two-Browser Grab Proof" keystone. Still the reference for forward sequencing; immediate priorities now live in `BACKLOG.md`.
- `archive/STATUS-2026-06-25.md` — a point-in-time status ledger from the 2026-06-25 worldgen audit.
