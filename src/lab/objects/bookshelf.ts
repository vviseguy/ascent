// ============================================================================
// bookshelf — a REAL MESH-BASED WorldObject (KayKit `shelves.glb`).
// ============================================================================
//
// The 1:1 KayKit tall shelf unit (native 2×1.95×0.5u → ~1×1×0.25m at scale 0.5),
// which reads as a bookshelf wall (the short `shelf_large` is a single board; this
// stacked unit is the bookshelf). Its footprint auto-fits to the shelf VOLUME.
//
// PER-ASPECT TEXTURING (docs/15 — the user explicitly wants to SEE this): the model is
// UV-mapped onto the grey atlas ramp, but the FRAME posts and the SHELF BOARDS sit on
// DIFFERENT swatch bands — the frame on the mid-grey bulk (~0x989897), the board faces
// on a lighter swatch (~0xd6d6d6). So we can recolour ONE aspect at a time:
//   oak            : the FRAME swatch → warm oak wood (default-ish, the timber frame)
//   walnut         : the FRAME swatch → dark walnut (a stained bookcase)
//   colorful-books : ONLY the board/contents swatch → saturated red (the "books" pop,
//                    frame untouched) — the per-aspect re-skin made visible
// A tightened tolerance keeps the two grey bands apart so each rule hits one aspect.
// ============================================================================

import { meshObject } from '../world-object.ts';

const FRAME = 0x989897; // the shelf's frame/post grey (the bulk mid-tone)
const BOARDS = 0xd6d6d6; // the lighter shelf-board / contents swatch (the "books" band)

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/shelves.glb',
  name: 'Bookshelf (shelves, real mesh)',
  describe: 'The 1:1 KayKit shelf unit as a bookshelf. Variants re-skin DISTINCT aspects: oak/walnut recolour the FRAME · colorful-books recolours only the shelf-board swatch. Footprint auto-fitted to the shelf volume.',
  level: 'object',
  scale: 0.5, // KayKit native 2×1.95×0.5u → ~1×1×0.25m bookshelf
  // A bookshelf is a mostly-solid slab with internal shelf gaps; a moderate edge-density
  // lets one box span the whole frame volume (the gaps are interior voids it grows over).
  fit: { cell: 0.06, edgeDensity: 0.45, maxBoxes: 4, minBox: 0.1 },
  // The frame grey (~152) and the lighter board grey (~214) are ~62 apart; tolerance 45
  // catches each band's gradient WITHOUT crossing into the other, so oak/walnut hit only
  // the frame and colorful-books hits only the boards.
  retextureTolerance: 45,
  variants: {
    oak: [{ from: FRAME, to: { pbr: 'wood', color: 0xb07a3c, roughness: 0.82, metalness: 0 } }],
    walnut: [{ from: FRAME, to: { pbr: 'wood', color: 0x5a3a22, roughness: 0.8, metalness: 0 } }],
    // colorful-books: recolour ONLY the board/contents swatch (the books) to a warm red,
    // leaving the frame grey — the per-aspect re-skin the user wants to SEE.
    'colorful-books': [{ from: BOARDS, to: { color: 0xc0392b, roughness: 0.6, metalness: 0 } }],
  },
});
