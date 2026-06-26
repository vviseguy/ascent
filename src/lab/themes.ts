// ============================================================================
// src/lab/themes.ts — DUNGEON THEMES (palette → material, applied pack-wide).
// ============================================================================
//
// A THEME re-skins the WHOLE KayKit pack at once by mapping each atlas SWATCH ROLE
// (palette.ts: stone / wood / metal / gold / accents…) to a material. Because the
// atlas is shared, one theme table reskins every model uniformly — a wall, a chest,
// a barrel and a shelf all pick up the theme's stone/wood/etc. with zero per-object
// work. Authoring is therefore per-ROLE, not per-object:
//
//     stoneKeep.roles.wood = { pbr: 'wood' }   // every wood swatch → real plank PBR
//
// COMPILE: `compileTheme(id)` expands the role table over PALETTE into a flat
// RetextureRule[] — one rule per swatch whose role the theme styles. Swatches whose
// role the theme LEAVES OUT get no rule, so those triangles keep their original atlas
// material (gradient intact) — that is how a theme can recolour stone/wood/metal but
// leave the red/blue banners alone. Per-swatch `swatches` overrides beat the role map.
//
// MATCH TOLERANCE: default 28 sRGB — wide enough to cover a swatch's vertical gradient
// drift (~26), tight enough that the next swatch (≥24 away for all but the grey
// cluster) doesn't bleed in. Within the inseparable GREY CLUSTER (palette.ts) the
// nearest-match only approximates stone-vs-metal; that is inherent to the source art.
//
// `to` is a retexture.ts MaterialSpec: a flat `color`, OR a real tiling `pbr` set from
// materials.ts (stone/wood/metal/gold/floor), plus roughness / metalness / emissive.
// `color` + `pbr` together TINTS the PBR set (e.g. mossy stone = stone PBR, green tint).
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import type { MaterialSpec, RetextureRule } from './retexture.ts';
import type { SwatchName, SwatchRole } from './palette.ts';
import { SWATCHES } from './palette.ts';

/** A theme: a role→material table (+ optional per-swatch overrides) over the palette. */
export interface Theme {
  /** Display name (shown in the lab picker). */
  name: string;
  /** One-liner: the look this gives the pack. */
  describe: string;
  /** Role → material. Roles omitted here keep their original atlas swatch (untouched). */
  roles: Partial<Record<SwatchRole, MaterialSpec>>;
  /** Optional per-swatch overrides (beat the role map) for surgical control. */
  swatches?: Partial<Record<SwatchName, MaterialSpec>>;
  /** Colour-match tolerance (sRGB). Default 28 — see header. */
  tolerance?: number;
}

/** The default match tolerance if a theme doesn't set one (see header). */
export const DEFAULT_THEME_TOLERANCE = 28;

// ----------------------------------------------------------------------------
// THE THEMES. Authored per-role; `compileTheme` expands them over the palette.
// Ordered: the "realify" baseline + warm/cool/desert/obsidian SUBTLE variants of it,
// then the three strong reflavors (frost / infernal / verdant).
// ----------------------------------------------------------------------------

export const THEMES: Record<string, Theme> = {
  // === STONE KEEP — the "real materials" baseline ============================
  // Swap the flat gradient swatches for genuine tiling PBR by family; accents (banners,
  // bottles, gems) keep their atlas colour so the dungeon stays readable.
  stoneKeep: {
    name: 'Stone Keep',
    describe: 'The real-materials baseline: stone→masonry, wood→planks, metal→iron, gold→gold. Accents kept.',
    roles: {
      stone: { pbr: 'stone' },
      wood: { pbr: 'wood' },
      metal: { pbr: 'metal' },
      gold: { pbr: 'gold' },
      orange: { pbr: 'wood', color: 0xc36532 }, // copper/clay → warm wood-toned
      dark: { color: 0x1b1c20, roughness: 0.6, metalness: 0.4 }, // black iron
    },
  },

  // === STONE KEEP (WARM) — subtle: torch-lit, warmer stone & wood =============
  stoneKeepWarm: {
    name: 'Stone Keep · Warm',
    describe: 'Stone Keep with a warm torch-lit cast — sandier stone, honeyed wood. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0xc7b29a },
      wood: { pbr: 'wood', color: 0xd9b483 },
      metal: { pbr: 'metal', color: 0xb9a892 },
      gold: { pbr: 'gold' },
      orange: { pbr: 'wood', color: 0xc36532 },
      dark: { color: 0x241f1a, roughness: 0.6, metalness: 0.35 },
    },
  },

  // === STONE KEEP (COOL) — subtle: damp, blue-grey crypt =====================
  stoneKeepCool: {
    name: 'Stone Keep · Cool',
    describe: 'Stone Keep gone cold and damp — blue-grey masonry, greyed wood. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0x9fb0bd },
      wood: { pbr: 'wood', color: 0x9aa0a2 },
      metal: { pbr: 'metal', color: 0xc2cdd4 },
      gold: { pbr: 'gold', color: 0xcdb86a },
      orange: { pbr: 'wood', color: 0x8f7b6c },
      dark: { color: 0x171a1e, roughness: 0.6, metalness: 0.4 },
    },
  },

  // === SANDSTONE — subtle: desert tomb ======================================
  sandstone: {
    name: 'Sandstone',
    describe: 'Sun-bleached desert tomb — pale sandstone, dry wood, brass fittings. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0xd8c8a0 },
      wood: { pbr: 'wood', color: 0xcdb083 },
      metal: { pbr: 'metal', color: 0xc9b27e },
      gold: { pbr: 'gold' },
      orange: { pbr: 'wood', color: 0xc98b4a },
      dark: { color: 0x2a2419, roughness: 0.7, metalness: 0.3 },
    },
  },

  // === OBSIDIAN — subtle/dark: polished black-stone vault ====================
  obsidian: {
    name: 'Obsidian',
    describe: 'A polished black-stone vault — dark slate, smoked steel, gold trim that pops. Darker variant.',
    roles: {
      stone: { pbr: 'stone', color: 0x3a3d44, roughness: 0.6 },
      wood: { pbr: 'wood', color: 0x4a4038 },
      metal: { pbr: 'metal', color: 0x6e7378, roughness: 0.4 },
      gold: { pbr: 'gold' },
      orange: { color: 0x7a4a2c },
      dark: { color: 0x0e0f12, roughness: 0.5, metalness: 0.5 },
    },
  },

  // === FROSTVAULT — strong reflavor: ice ====================================
  frostvault: {
    name: 'Frostvault',
    describe: 'An ice tomb — pale-blue rime stone, frost-bleached wood, gold turned to cold silver.',
    tolerance: 30,
    roles: {
      stone: { pbr: 'stone', color: 0xa7c2da },
      wood: { color: 0xbcc8cf, roughness: 0.5 }, // frosted, flat (no warm plank grain)
      metal: { pbr: 'metal', color: 0xd2e2ec, roughness: 0.35 },
      gold: { pbr: 'metal', color: 0xe6eef3, roughness: 0.3, metalness: 1 }, // gold → silver
      orange: { color: 0x9fb6c4 },
      dark: { color: 0x1b2630, roughness: 0.5, metalness: 0.4 },
      light: { color: 0xeaf4ff },
    },
    swatches: {
      // a touch of cold glow on the would-be torches/gem reds so they read icy, not warm
      red: { color: 0x5f93ad },
    },
  },

  // === INFERNAL — strong reflavor: lava / charred ============================
  infernal: {
    name: 'Infernal',
    describe: 'A magma forge — charred basalt & wood, sooty iron, gold gone molten and glowing.',
    roles: {
      stone: { pbr: 'stone', color: 0x40342f, roughness: 1 },
      wood: { color: 0x1d1512, roughness: 0.9 }, // charred black
      metal: { pbr: 'metal', color: 0x6b5e57, roughness: 0.5 },
      gold: { color: 0xff7a1a, emissive: 0xff3000, emissiveIntensity: 1.3 }, // molten
      orange: { color: 0xff5a12, emissive: 0xd83000, emissiveIntensity: 1.0 },
      dark: { color: 0x0c0a0a, roughness: 0.8 },
    },
    swatches: {
      // embered reds glow; cool accents go dead/ashen
      red: { color: 0xff3010, emissive: 0xcc1500, emissiveIntensity: 0.9 },
      crimson: { color: 0xb81e16, emissive: 0x901000, emissiveIntensity: 0.6 },
    },
  },

  // === VERDANT — strong reflavor: overgrown ruin ============================
  verdant: {
    name: 'Verdant',
    describe: 'A ruin reclaimed by nature — mossy stone, weathered wood, verdigris metal, tarnished gold.',
    roles: {
      stone: { pbr: 'stone', color: 0x8a9c74 }, // moss-greened masonry
      wood: { pbr: 'wood', color: 0x9c8d63 }, // damp, weathered
      metal: { pbr: 'metal', color: 0x7e9079 }, // verdigris
      gold: { pbr: 'gold', color: 0xb6a35c }, // tarnished
      orange: { pbr: 'wood', color: 0x8a6b3e },
      dark: { color: 0x141710, roughness: 0.8 },
    },
  },
};

/** Display order for the theme picker (also gates which ids are valid). */
export const THEME_ORDER: readonly string[] = [
  'stoneKeep', 'stoneKeepWarm', 'stoneKeepCool', 'sandstone', 'obsidian',
  'frostvault', 'infernal', 'verdant',
];

/** A compiled theme: the flat rules + the tolerance to match them with. */
export interface CompiledTheme {
  rules: RetextureRule[];
  tolerance: number;
}

/**
 * Expand a theme over the palette into per-swatch retexture rules. For each swatch we
 * take its per-swatch override if present, else its role's material; swatches whose
 * role the theme doesn't style get NO rule (their atlas material is kept untouched).
 * Returns null for an unknown id (so the caller can fall back to "no theme").
 */
export function compileTheme(id: string): CompiledTheme | null {
  const theme = THEMES[id];
  if (!theme) return null;
  const rules: RetextureRule[] = [];
  for (const sw of SWATCHES) {
    const spec = theme.swatches?.[sw.name as SwatchName] ?? theme.roles[sw.role];
    if (spec) rules.push({ from: sw.hex, to: spec });
  }
  return { rules, tolerance: theme.tolerance ?? DEFAULT_THEME_TOLERANCE };
}

/** Resolve the `?theme=` param to a valid theme id, or null (= no theme / raw atlas). */
export function readThemeFromParams(params: URLSearchParams): string | null {
  const t = params.get('theme');
  return t && THEME_ORDER.includes(t) ? t : null;
}
