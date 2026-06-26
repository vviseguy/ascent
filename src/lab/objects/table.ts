// ============================================================================
// table — a REAL MESH-BASED WorldObject (KayKit `table_long.glb`).
// ============================================================================
//
// The 1:1 KayKit long table, re-skinned per variant by COLOUR-KEYED rules
// (retexture.ts) and given an AUTO-FITTED footprint (box-fit.ts) — no boxes are
// hand-authored. Variants are pure re-skins of the SAME mesh (docs/15):
//   oak    : default look (no rule → keep the atlas-derived material)
//   walnut : the wood swatch → a warm dark wood albedo (a darker stained table)
//   stone  : the wood swatch → the tiling STONE PBR set (a stone slab table)
//
// The wood body of the table lives on the atlas's wood/grey swatch (centroid colour
// ~0x808080); a generous tolerance catches the whole gradient band. The legs+top are
// one swatch, so one rule re-skins the whole table — exactly "change the thing that
// is one colour to another material."
// ============================================================================

import { meshObject } from '../world-object.ts';

const WOOD = 0x808080; // the table's wood/grey atlas swatch (centroid average)

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/table_long.glb',
  name: 'Table (long, real mesh)',
  describe: 'The 1:1 KayKit long table. Variants re-skin its single wood swatch: default oak · stained walnut · stone slab. Footprint auto-fitted (top + legs).',
  level: 'object',
  scale: 0.5, // KayKit native ~4u long → ~2m game table
  fit: { cell: 0.13, maxBoxes: 10, minBox: 0.08 }, // → ~6-7 boxes: top slab + legs
  variants: {
    oak: [], // default — keep the original atlas-derived material
    walnut: [{ from: WOOD, to: { color: 0x5a3a22, roughness: 0.78, metalness: 0 } }],
    stone: [{ from: WOOD, to: { pbr: 'stone', roughness: 0.95, metalness: 0 } }],
  },
});
