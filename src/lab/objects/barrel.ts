// ============================================================================
// barrel — a REAL MESH-BASED WorldObject (KayKit `barrel_large.glb`).
// ============================================================================
//
// The 1:1 KayKit large barrel. Variants re-skin its swatches (docs/15):
//   oak    : default look (the authored wood + iron-hoop swatches)
//   iron   : the wood-stave swatch → tiling METAL PBR (an iron drum)
//   mossy  : the wood-stave swatch → a desaturated green (a damp, overgrown barrel)
//
// A barrel is a solid obstacle, so box-fit caps it at 2 boxes — it coarsens to ONE
// chunky drum box hugging the staves, proving the "barrel → ~1 box" target.
// ============================================================================

import { meshObject } from '../world-object.ts';

const STAVE = 0x8b8b8a; // the barrel's wood-stave atlas swatch (centroid average)

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/barrel_large.glb',
  name: 'Barrel (large, real mesh)',
  describe: 'The 1:1 KayKit large barrel. Variants re-skin the stave swatch: default oak · iron drum (metal PBR) · mossy. Footprint auto-fitted (~1 box).',
  level: 'object',
  scale: 0.5, // KayKit native ~2u tall → ~1m game barrel
  // No `fit` overrides — the GLOBAL box-fit defaults cover the solid drum in ~1 box.
  variants: {
    oak: [],
    iron: [{ from: STAVE, to: { pbr: 'metal', roughness: 0.5, metalness: 0.9 } }],
    mossy: [{ from: STAVE, to: { color: 0x4a5f3a, roughness: 0.92, metalness: 0 } }],
  },
});
