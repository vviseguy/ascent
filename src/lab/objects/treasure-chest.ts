// ============================================================================
// treasure-chest — a REAL MESH-BASED WorldObject (KayKit `chest_gold.glb`).
// ============================================================================
//
// The 1:1 KayKit chest — a colour-keyed retexture showcase: the iron STRAPS read off
// their own grey atlas swatch, separable from the wood planks, so one rule re-skins ONLY
// the straps — the user's exact "change only the one-colour thing to another material"
// ask. (The straps' grey is close to the plank grey, so retextureTolerance is tightened.)
//   iron    : default — grey iron straps, as authored
//   gold    : the straps → warm metallic gold (planks + lid untouched)
//   emerald : the straps → a matte green trim — proves arbitrary recolour
//
// Footprint auto-fitted from the mesh (box-fit.ts) — ~2 boxes (body block + lid).
// ============================================================================

import { meshObject } from '../world-object.ts';

// The chest's VISIBLE swatches (on the outer shell): two greys — the iron straps and
// the wood planks both read off the grey ramp, distinguished by which column. We target
// the strap grey (col1, ~0x818180); the plank grey (col4, ~0x929291) stays wood.
const STRAP = 0x818180; // the iron-strap grey swatch (centroid average)

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/chest_gold.glb',
  name: 'Treasure chest (real mesh)',
  describe: 'The 1:1 KayKit chest. Variants re-skin ONLY the iron-strap swatch — iron · gold · emerald — leaving the wood planks untouched. Footprint auto-fitted.',
  level: 'object',
  scale: 0.5, // KayKit native → ~0.6m game chest
  fit: { cell: 0.1, maxBoxes: 5, minBox: 0.1 }, // → ~2 boxes: body block + lid
  retextureTolerance: 22, // strap-grey and plank-grey are close — keep them apart
  variants: {
    iron: [], // default — leave the iron straps grey
    // gold: recolor ONLY the strap swatch to warm metallic gold (the wood planks + lid
    // stay untouched). Tolerance is tightened so the nearby plank grey isn't caught.
    gold: [{ from: STRAP, to: { color: 0xffc34a, roughness: 0.35, metalness: 0.6 } }],
    // emerald: the straps → a matte green trim (metalness low so the albedo reads under
    // the studio lights — a high-metalness flat colour would render near-black, no env).
    emerald: [{ from: STRAP, to: { color: 0x1f9a5a, roughness: 0.4, metalness: 0.1 } }],
  },
});
