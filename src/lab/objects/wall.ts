// ============================================================================
// wall — a REAL MESH-BASED WorldObject (KayKit `wall.glb`).
// ============================================================================
//
// The 1:1 KayKit dungeon wall block (native 4×4×1u → a 2×2×0.5m cell wall at
// scale 0.5). It is the structural shell the dungeon is built from, so its
// footprint is ONE chunky slab box — exactly what box-fit should produce for a
// solid block (proves the "wall ≈ 1 box" target).
//
// TEXTURING (docs/15 — variants re-skin ONE mesh): the wall's masonry lives on the
// atlas's grey STONE gradient (swatches span ~0x6f6f6d…0xdccfc1; the bulk mid-grey
// reads ~0x9d9d9c). A generous tolerance catches the whole grey ramp, so one rule
// re-skins the entire stone face — "recolour the stone swatch":
//   stone      : default — the authored grey masonry (no rule)
//   mossy      : the stone swatch → tiling STONE PBR tinted damp green (an overgrown
//                wall) — recolours the STONE aspect
//   bloodstone : the stone swatch → a dark oxblood stone (a sacrificial-chamber wall)
// ============================================================================

import { meshObject } from '../world-object.ts';

// The wall's grey masonry swatch (the bulk of the stone gradient's mid-tone).
const STONE = 0x9d9d9c;

export default meshObject({
  meshUrl: 'models/kaykit_dungeon/wall.glb',
  name: 'Wall (real mesh)',
  describe: 'The 1:1 KayKit dungeon wall. Variants re-skin the stone swatch: default stone · mossy (green-tinted stone PBR) · bloodstone (oxblood). Footprint auto-fitted (~1 slab box).',
  level: 'object',
  scale: 0.5, // KayKit native 4×4×1u → 2×2×0.5m cell wall
  // A wall is a single solid slab → one box. Coarse cell + a low edge-density brake so
  // the thin 0.5m depth still grows into one slab rather than splitting on grazing votes.
  fit: { cell: 0.12, edgeDensity: 0.4, maxBoxes: 3, minBox: 0.2 },
  // The grey stone ramp is wide; a generous tolerance recolours the whole masonry face.
  retextureTolerance: 95,
  variants: {
    stone: [], // default — the authored grey masonry
    // mossy: re-skin the stone to the tiling STONE PBR, tinted a damp green.
    mossy: [{ from: STONE, to: { pbr: 'stone', color: 0x6f8456, roughness: 0.96, metalness: 0 } }],
    // bloodstone: the masonry → a dark oxblood stone (matte, no metal).
    bloodstone: [{ from: STONE, to: { pbr: 'stone', color: 0x7a2630, roughness: 0.9, metalness: 0 } }],
  },
});
