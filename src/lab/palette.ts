// ============================================================================
// src/lab/palette.ts — the KayKit dungeon ATLAS PALETTE (named swatches + roles).
// ============================================================================
//
// Every KayKit "Dungeon Remastered" GLB UV-maps onto ONE shared atlas image
// (`dungeon_texture`, material name "texture") — an 8×4 grid of soft VERTICAL-
// GRADIENT swatches: greys for stone, browns for wood, gold/amber, plus a ring of
// saturated accent hues (banners, bottles, gems, cloth). Because the atlas is SHARED
// across the whole pack, a given swatch is the IDENTICAL colour on every model — so a
// single swatch→material mapping reskins the ENTIRE pack at once. That is what makes
// per-SWATCH reskinning cheap: author once, not per-object (recolor.ts).
//
// The hexes + ROLES below are EVIDENCE-BASED, not eyeballed: a probe samples the atlas
// colour at the centroid UV of every triangle in the real GLBs and reports which swatch
// each lands nearest (`npm run probe:palette` → scripts/palette-probe.mjs). Re-run it if
// the pack ever changes; it also flags coverage gaps (many tris far from any swatch).
//
// TWO findings that shaped the roles:
//   • THE GREY CLUSTER IS STONE. The dungeon shell — walls, columns, stairs — is
//     dominated by the blue-greys (`ironGrey`, `steel`) PLUS the slate/neutral greys,
//     all at tiny match distances. The SAME blue-grey is also what a sword blade / chest
//     strap / torch bracket use for "metal", but those props are rare next to the shell,
//     and a pure colour map CANNOT tell shell-stone from prop-metal (they're the same
//     swatch). So the whole grey family defaults to `stone` — the common case wins. Metal
//     props default to stone; override them per-object (variant rules) when it matters.
//     (This per-swatch palette is a LAB tool; the game dungeon colors via recolor.ts —
//     per-pixel, gradient-preserving — see src/lab/CLAUDE.md.)
//   • THE NEUTRAL GREY BAND HAS A RANGE. The atlas bottom band is one white→black ramp,
//     so models sample many greys off it; we anchor it with several points (neutralLight/
//     neutralGrey/darkSteel + the warm stoneWarm/stoneDark) so shell coverage stays high.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

/** A material family a swatch belongs to — what a theme keys its remap on. */
export type SwatchRole =
  | 'stone'
  | 'trim'   // the DARK slate swatch — pillar/wall BASE & CAP (and dressed edging). KayKit
             //   authors these with a distinct dark grey, so giving it its own role lets a
             //   theme texture the plinth/capital differently from the shaft (probe-confirmed).
  | 'floor'  // no swatch defaults here — a `greyAs` TARGET for floor tiles (cobble, not wall stone)
  | 'wood'
  | 'metal'  // no swatch defaults here (see header) — a `greyAs` target for metal props (blades)
  | 'gold'
  | 'dark'   // near-black (charcoal / black iron)
  | 'light'  // near-white / cream / parchment
  | 'red'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'teal'
  | 'orange'; // burnt orange / copper

/** One atlas swatch: a stable name, its sampled mid-gradient colour, and its role. */
export interface Swatch {
  /** Stable identifier (used for per-swatch theme overrides). */
  name: string;
  /** Sampled sRGB colour the swatch reads as (hex). The retexture `from`. */
  hex: number;
  /** The material family this swatch reads as. */
  role: SwatchRole;
}

/** The known names — a string union so theme per-swatch overrides are typo-checked. */
export type SwatchName =
  // greys — the dungeon shell + neutral band (all role `stone`, EXCEPT stoneDark = `trim`)
  | 'stoneDark' | 'darkSteel' | 'steel' | 'ironGrey' | 'neutralGrey' | 'stoneWarm' | 'neutralLight'
  | 'charcoal'
  | 'woodClay' | 'woodRed' | 'woodTan'
  | 'copper'
  | 'white' | 'cream'
  | 'amber' | 'goldYellow' | 'goldOrange'
  | 'red' | 'crimson' | 'pink' | 'salmon'
  | 'purple' | 'teal' | 'tealDeep' | 'green' | 'greenGrass' | 'blue';

/**
 * The KayKit dungeon atlas palette, with the colours real triangles actually sample.
 * Order is just for readability; matching is purely nearest-colour (recolor.ts).
 */
export const PALETTE: Record<SwatchName, Swatch> = {
  // --- GREYS → stone: the dungeon shell (walls/columns/stairs/floors) + neutral band. ---
  // stoneDark is the BASE & CAP of pillars/walls (probe: bottom+top bands) → its own `trim`
  // role so a theme can texture the plinth/capital distinctly from the shaft.
  stoneDark: { name: 'stoneDark', hex: 0x4a5155, role: 'trim' }, // dark slate — pillar/wall base+cap
  darkSteel: { name: 'darkSteel', hex: 0x6a7277, role: 'stone' }, // cool dark grey — heavy on walls/stairs shadow
  steel: { name: 'steel', hex: 0x7a8d9d, role: 'stone' }, // bluer grey
  ironGrey: { name: 'ironGrey', hex: 0x818c91, role: 'stone' }, // PRIMARY shell grey (also prop "metal" — see header)
  neutralGrey: { name: 'neutralGrey', hex: 0x8e8e8d, role: 'stone' }, // neutral band, mid
  stoneWarm: { name: 'stoneWarm', hex: 0x978f86, role: 'stone' }, // warm grey — floor tiles
  neutralLight: { name: 'neutralLight', hex: 0xbcbcbc, role: 'stone' }, // neutral band, light end
  // --- near-black ---
  charcoal: { name: 'charcoal', hex: 0x13191b, role: 'dark' },
  // --- WOODS → wood: clay / red / sandy browns (the real plank colours) ---
  woodClay: { name: 'woodClay', hex: 0xb16f52, role: 'wood' },
  woodRed: { name: 'woodRed', hex: 0x9b5a45, role: 'wood' },
  woodTan: { name: 'woodTan', hex: 0xdaae7d, role: 'wood' },
  // --- burnt orange / copper ---
  copper: { name: 'copper', hex: 0xc36532, role: 'orange' },
  // --- lights: near-white + cream/parchment ---
  white: { name: 'white', hex: 0xd4dbde, role: 'light' },
  cream: { name: 'cream', hex: 0xdcd0c3, role: 'light' },
  // --- golds: amber / yellow / orange (coins, chest lock, torch flame metal) ---
  amber: { name: 'amber', hex: 0xf9aa4e, role: 'gold' },
  goldYellow: { name: 'goldYellow', hex: 0xeac253, role: 'gold' },
  goldOrange: { name: 'goldOrange', hex: 0xf99e39, role: 'gold' },
  // --- accents: reds / pinks ---
  red: { name: 'red', hex: 0xd22227, role: 'red' },
  crimson: { name: 'crimson', hex: 0xa41a5a, role: 'red' },
  pink: { name: 'pink', hex: 0xf3727f, role: 'pink' },
  salmon: { name: 'salmon', hex: 0xf69372, role: 'pink' },
  // --- accents: purple / teals / greens / blue ---
  purple: { name: 'purple', hex: 0x662c8e, role: 'purple' },
  teal: { name: 'teal', hex: 0x50aaae, role: 'teal' },
  tealDeep: { name: 'tealDeep', hex: 0x38a38d, role: 'teal' }, // the "green" bottle is actually teal
  green: { name: 'green', hex: 0x55b66a, role: 'green' },
  greenGrass: { name: 'greenGrass', hex: 0x52aa48, role: 'green' },
  blue: { name: 'blue', hex: 0x62a0d0, role: 'blue' },
};

/** The swatches as a flat array (stable order = insertion order above). */
export const SWATCHES: readonly Swatch[] = Object.values(PALETTE);

/** Every swatch name that maps to a given role (for theme authoring / inspection). */
export function swatchesOfRole(role: SwatchRole): Swatch[] {
  return SWATCHES.filter((s) => s.role === role);
}
