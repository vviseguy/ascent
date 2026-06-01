# ASCENT

A realtime multiplayer **vertical escort brawl-race** for the browser.

🎮 **Play:** https://vviseguy.github.io/ascent/ &nbsp;·&nbsp; *(early playable sandbox)*

Crews of ~3–5 shepherd their **Anchor** — a heavy, slow, precious-but-*active* teammate — up an
endless tower of gaps, hazards, and rival sabotage. You build routes, catch falls, carry each other
across chasms, throw world objects, and grab-and-throw the *other* crews' Anchors into the abyss.
**Highest Anchor wins.** Touchstones: *Gang Beasts × Overcooked × Overwatch payload × Mario Kart*,
played climbing a tower with *Smash Bros.* position-kills.

## Tech at a glance
- **Rollback netcode** (GGPO-style) over WebRTC data channels; AoI centered on each crew's Anchor.
- **Custom deterministic physics engine** in fixed-point integer math (no floats in the sim →
  bit-identical across browsers; Rapier is used only as a test oracle).
- **TypeScript + Vite + Three.js**; maximal-spectacle "coalescence" visuals (view-layer only).
- Builds on the proven P2P layer of its sibling, *Frequency*.

## Quick start
```bash
npm install
npm run dev          # dev server (play it locally)
npm test             # vitest unit suite
npm run typecheck    # full TypeScript check
npm run prove        # run EVERY determinism proof (zero deps, Node 22+)
npm run build        # production build
```

**Controls (sandbox):** WASD move · mouse aim · J/LMB rush · K/RMB hold-grab
(release = throw) · L struggle · Space jump.

## CI / CD
- **CI** (`.github/workflows/ci.yml`) runs on every push/PR: typecheck, unit tests,
  all eight determinism proofs, and a production build.
- **CD** (`.github/workflows/deploy.yml`) builds and publishes to GitHub Pages on
  every push to `main`. Vite `base` is `/ascent/`.

## Status
Early. Engineering bottom-up and proving each layer before building on it:
- ✅ Fixed-point math bedrock — proven exact vs a BigInt oracle (~900k checks).
- 🔨 Deterministic floor generation + independent solvability verifier.
- ⏳ Sim core (world/step/hash/rollback), netcode, renderer.

## Docs
The full design corpus lives in [`docs/`](docs/) — start with
[`docs/00-master-vision.md`](docs/00-master-vision.md) and
[`docs/DECISIONS-LOG.md`](docs/DECISIONS-LOG.md). Contributor/agent guide: [`CLAUDE.md`](CLAUDE.md).
