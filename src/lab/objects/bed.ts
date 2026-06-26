// ============================================================================
// bed — a REAL MESH-BASED WorldObject (KayKit `bed_frame.glb`).
// ============================================================================
//
// The 1:1 KayKit bed (native ~1.5×1.06×3u → ~0.75×0.53×1.5m at scale 0.5). We use
// `bed_frame.glb` — a CLEAN single bed — NOT `bed_decorated.glb`, which is a whole
// bedroom VIGNETTE (bed + nightstand + bottle + candles + chest) whose extra props
// confuse both the footprint and the swatch-keyed re-skin. Its footprint auto-fits to
// a frame slab + the mattress block + the headboard.
//
// PER-ASPECT TEXTURING (docs/15): the bed's LINEN and its WOOD FRAME sit on different
// atlas swatches — the bedding on a blue-grey fabric swatch (~0x575e62), the timber
// frame/headboard on the dark-wood swatch (~0x4b4b49). So the FABRIC and the FRAME
// re-skin INDEPENDENTLY:
//   red-linen  : the fabric swatch → red bedding (frame untouched)
//   blue-linen : the fabric swatch → deep blue bedding (frame untouched)
//   bare-frame : the WOOD-FRAME swatch → pale stripped oak (the linen left as-is) —
//                proves the OTHER aspect re-skins on its own
// A tightened tolerance keeps the fabric blue-grey and the dark wood apart.
// ============================================================================

import { meshObject } from '../world-object.ts';

const FABRIC = 0x575e62; // the bedding/linen blue-grey fabric swatch
const FRAME = 0x4b4b49;  // the dark-wood frame/headboard swatch

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/bed_frame.glb',
  name: 'Bed (real mesh)',
  describe: 'The 1:1 KayKit bed (clean single bed). Variants re-skin DISTINCT aspects: red-linen/blue-linen recolour the FABRIC · bare-frame recolours the WOOD FRAME. Footprint auto-fitted (frame slab + mattress + headboard).',
  level: 'object',
  scale: 0.5, // KayKit native ~1.5×1.06×3u → ~0.75×0.53×1.5m bed
  // No `fit` overrides — the GLOBAL box-fit defaults auto-separate the frame board, the
  // mattress, the pillow and the blanket (each its own non-overlapping box).
  retextureTolerance: 26, // fabric blue-grey vs dark wood are close-ish — keep apart
  variants: {
    'red-linen': [{ from: FABRIC, to: { color: 0xb02a2a, roughness: 0.7, metalness: 0 } }],
    'blue-linen': [{ from: FABRIC, to: { color: 0x2a4ea0, roughness: 0.7, metalness: 0 } }],
    // bare-frame: recolour ONLY the timber frame to a pale stripped oak (linen untouched).
    'bare-frame': [{ from: FRAME, to: { pbr: 'wood', color: 0xc8a86a, roughness: 0.85, metalness: 0 } }],
  },
});
