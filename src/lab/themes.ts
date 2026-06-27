// ============================================================================
// src/lab/themes.ts — DUNGEON THEMES (palette → material, applied pack-wide).
// ============================================================================
//
// ⚠ LEGACY for the lab. The lab now colors assets via recolor.ts (per-pixel, gradient-
// preserving) — see src/lab/CLAUDE.md, which is authoritative. This file is kept ONLY because
// the GAME renderer (src/render/dungeon.ts) still colors the in-game dungeon through it
// (migrating the game to recolor.ts is a future task). Don't add new lab coloring logic here.
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

/** The default match tolerance if a theme doesn't set one (see header). Generous (36) so the
 *  structural grey family all lands on stone in pure tolerance-match (no coalescence) — yet still
 *  below the gap to the saturated accents (≥~40), so a true accent the theme doesn't map (a teal
 *  bottle, a red gem) stays its own colour rather than bleeding into stone/wood. */
export const DEFAULT_THEME_TOLERANCE = 36;

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
      trim: { pbr: 'stone', color: 0x5c6064, roughness: 0.85 }, // darker dressed plinth/cap
      wood: { pbr: 'wood' },
      metal: { pbr: 'metal' },
      gold: { pbr: 'gold' },
      orange: { pbr: 'terracotta', color: 0xc36532 }, // clay/copper swatch → fired clay
      dark: { color: 0x1b1c20, roughness: 0.6, metalness: 0.4 }, // black iron
    },
  },

  // === STONE KEEP (WARM) — subtle: torch-lit, warmer stone & wood =============
  stoneKeepWarm: {
    name: 'Stone Keep · Warm',
    describe: 'Stone Keep with a warm torch-lit cast — sandier stone, honeyed wood. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0xc7b29a },
      trim: { pbr: 'stone', color: 0x9c8a72 }, // darker plinth/cap
      wood: { pbr: 'wood', color: 0xd9b483 },
      metal: { pbr: 'metal', color: 0xb9a892 },
      gold: { pbr: 'gold' },
      orange: { pbr: 'terracotta', color: 0xc36532 }, // clay/copper swatch → fired clay
      dark: { color: 0x241f1a, roughness: 0.6, metalness: 0.35 },
    },
  },

  // === STONE KEEP (COOL) — subtle: damp, blue-grey crypt =====================
  stoneKeepCool: {
    name: 'Stone Keep · Cool',
    describe: 'Stone Keep gone cold and damp — blue-grey masonry, greyed wood. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0x9fb0bd },
      trim: { pbr: 'stone', color: 0x6f808d }, // darker plinth/cap
      wood: { pbr: 'wood', color: 0x9aa0a2 },
      metal: { pbr: 'metal', color: 0xc2cdd4 },
      gold: { pbr: 'gold', color: 0xcdb86a },
      orange: { pbr: 'terracotta', color: 0x9a7a66 }, // cool damp clay
      dark: { color: 0x171a1e, roughness: 0.6, metalness: 0.4 },
    },
  },

  // === SANDSTONE — subtle: desert tomb ======================================
  sandstone: {
    name: 'Sandstone',
    describe: 'Sun-bleached desert tomb — pale sandstone, dry wood, brass fittings. Subtle variant.',
    roles: {
      stone: { pbr: 'stone', color: 0xd8c8a0 },
      trim: { pbr: 'stone', color: 0xb09874 }, // darker plinth/cap
      wood: { pbr: 'wood', color: 0xcdb083 },
      metal: { pbr: 'metal', color: 0xc9b27e },
      gold: { pbr: 'gold' },
      orange: { pbr: 'terracotta', color: 0xc98b4a }, // sun-baked clay
      dark: { color: 0x2a2419, roughness: 0.7, metalness: 0.3 },
    },
  },

  // === OBSIDIAN — subtle/dark: polished black-stone vault ====================
  obsidian: {
    name: 'Obsidian',
    describe: 'A polished black-stone vault — dark slate, smoked steel, gold trim that pops. Darker variant.',
    roles: {
      stone: { pbr: 'stone', color: 0x3a3d44, roughness: 0.6 },
      trim: { pbr: 'stone', color: 0x202227, roughness: 0.45 }, // polished black plinth/cap
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
      stone: { pbr: 'stone', color: 0x6aa0e0 }, // strong icy blue (tints floor + walls)
      trim: { pbr: 'stone', color: 0x3f6e9e }, // deeper ice-blue plinth/cap
      wood: { color: 0xaecadd, roughness: 0.5 }, // frosted, flat (no warm plank grain)
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
      trim: { pbr: 'stone', color: 0x241c19, roughness: 1 }, // charred plinth/cap
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
      stone: { pbr: 'stone', color: 0x6e9838 }, // strong moss green (tints floor + walls)
      trim: { pbr: 'stone', color: 0x4d6b28 }, // darker mossy plinth/cap
      wood: { pbr: 'wood', color: 0x9c8d63 }, // damp, weathered
      metal: { pbr: 'metal', color: 0x7e9079 }, // verdigris
      gold: { pbr: 'gold', color: 0xb6a35c }, // tarnished
      orange: { pbr: 'terracotta', color: 0x8a6b3e }, // mossy weathered clay
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

/** Per-object compile context (resolves the inherently-ambiguous grey cluster, see palette.ts). */
export interface ThemeContext {
  /**
   * What the grey (`stone`/`trim`-role) cluster should become for THIS object — the per-object
   * answer to "the same blue-grey is masonry on a wall, cobble on a floor, iron on a blade,
   * a frame on a bed."
   *   'stone' (default) — walls / pillars / columns / stairs → masonry.
   *   'floor'           — floor tiles → the dedicated cobblestone (NOT coarse wall stone).
   *   'metal'           — sword/key/etc. → iron.
   *   'wood'            — a bed frame (grey-painted in the atlas, but reads as a wooden frame).
   * Derive it per object with greyRoleFor().
   */
  greyAs?: SwatchRole;
  /**
   * SOFT FURNISHING — make fabric parts read as tinted CLOTH (woven, in the swatch's own colour):
   *   'accents' — only the accent + light swatches become cloth (a banner's cloth, a rug); the
   *               grey cluster stays structural (the banner's wood/metal pole → greyAs).
   *   'all'     — the GREY cluster ALSO becomes cloth — for a bed/cushion/pillow where the greys
   *               are the bedding (blanket, pillow, sheets), NOT a stone frame. The frame on these
   *               is its own wood swatch, so it still reads as wood.
   */
  fabric?: 'accents' | 'all';
}

/** SATURATED accent roles that read as FABRIC on ANY soft furnishing → tinted cloth (a banner's
 *  coloured flag, a rug). `light` (white/cream) and the grey cluster are fabric ONLY in 'all' mode
 *  (a bed's sheets/blanket) — NOT in 'accents' mode, so a banner's white/grey PEGS stay structural
 *  (the bug: white pegs were turning into white cloth). */
const CLOTH_ACCENT_ROLES: ReadonlySet<SwatchRole> = new Set(['red', 'green', 'blue', 'purple', 'pink', 'teal']);

/** The floor treatment for a theme: its explicit `floor` role, else its stone treatment
 *  re-pointed at the cobble PBR (same tint, denser floor texture) — so every theme gets a
 *  sensible cobble floor without authoring one per theme. */
function floorSpec(theme: Theme): MaterialSpec | undefined {
  if (theme.roles.floor) return theme.roles.floor;
  const s = theme.roles.stone;
  return s ? { ...s, pbr: 'floor' } : undefined;
}

/**
 * Expand a theme over the palette into per-swatch retexture rules. For each swatch we
 * take its per-swatch override if present, else its role's material; swatches whose
 * role the theme doesn't style get NO rule (their atlas material is kept untouched).
 * `ctx.greyAs` resolves the grey cluster's role per object (floor/stone/metal) — the
 * per-object answer to the shared-grey ambiguity (see ThemeContext). Returns null for an
 * unknown id (so the caller can fall back to "no theme").
 */
export function compileTheme(id: string, ctx: ThemeContext = {}): CompiledTheme | null {
  const theme = THEMES[id];
  if (!theme) return null;
  const greyAs = ctx.greyAs ?? 'stone';
  const rules: RetextureRule[] = [];
  for (const sw of SWATCHES) {
    const isGrey = sw.role === 'stone' || sw.role === 'trim';
    // 1. an explicit per-swatch override always wins (e.g. infernal's glowing red).
    let spec = theme.swatches?.[sw.name as SwatchName];
    // 2. SOFT FURNISHING → tinted cloth (woven, in the swatch's own colour). SATURATED accents in
    //    either mode; white/cream + the grey cluster ONLY in 'all' mode (a bed's sheets/blanket) —
    //    so a banner's white/grey PEGS stay structural (not turned into fabric).
    if (!spec && ctx.fabric) {
      const fabric = isGrey || sw.role === 'light' ? ctx.fabric === 'all' : CLOTH_ACCENT_ROLES.has(sw.role);
      if (fabric) spec = { pbr: 'cloth', color: sw.hex };
    }
    // 3. the GREY CLUSTER = roles 'stone' (shaft/body) + 'trim' (the dark base/cap slate). Both
    //    resolve per object via greyAs (wall stone / floor cobble / iron). Only in the 'stone'
    //    resolution does 'trim' keep its distinct dressed-stone look (plinth/cap).
    if (!spec) {
      if (isGrey) {
        spec = greyAs === 'floor' ? floorSpec(theme)
          : greyAs !== 'stone' ? (theme.roles[greyAs] ?? theme.roles.stone)
          : sw.role === 'trim' ? (theme.roles.trim ?? theme.roles.stone)
          : theme.roles.stone;
      } else {
        spec = theme.roles[sw.role];
      }
    }
    // VARIEGATE a plain gold/metal: tint to the swatch's OWN colour so the gold family reads as
    // yellow/amber/orange (not one flat gold), and steel vs iron differ in metal contexts. Themes
    // that give gold/metal an explicit colour (e.g. frostvault's silver) already differ → skipped.
    if (spec && spec.pbr && spec.color === undefined && (spec.pbr === 'gold' || spec.pbr === 'metal')) {
      spec = { ...spec, color: sw.hex };
    }
    if (spec) rules.push({ from: sw.hex, to: spec });
  }
  return { rules, tolerance: theme.tolerance ?? DEFAULT_THEME_TOLERANCE };
}

/** Names/urls that read as METAL props — their grey cluster should theme as iron, not stone.
 *  KayKit dungeon hits: sword_shield, keyring_hanging. Kept tight so the stone shell (walls,
 *  pillars, stairs — which share the same blue-grey) is never mistaken for metal. */
const METAL_PROP_RE = /sword|shield|blade|knife|dagger|axe|mace|weapon|\bkey|keyring|anvil|chain|grate|cage|bars|hook|hinge|lantern/i;
/** Names/urls that read as FLOOR — their grey should theme as cobble, not coarse wall stone. */
const FLOOR_RE = /floor|ground|pavement|cobble|tile_(large|small|grate)|foundation/i;
/** FULLY-UPHOLSTERED — the GREY here is bedding (blanket/pillow/sheet), not a stone frame, so the
 *  whole grey cluster + accents → cloth (the frame is its own wood swatch and stays wood). */
const FABRIC_ALL_RE = /\bbed\b|bed_|cushion|pillow|mattress|bedroll|cot\b|sofa|couch|armchair/i;
/** ACCENT-FABRIC — only the accent/light parts are cloth; the grey pole/rod stays structural. */
const FABRIC_ACCENT_RE = /banner|curtain|drape|\brug\b|carpet|tablecloth|tapestry|blanket|sheet|\bflag\b|towel|cloth/i;

/** Whether an object should compile with `greyAs: 'metal'` (see compileTheme). */
export function isMetalProp(name: string, url: string): boolean {
  return METAL_PROP_RE.test(name) || METAL_PROP_RE.test(url);
}

/** Soft-furnishing mode for an object (see ThemeContext.fabric): 'all' = grey is bedding too,
 *  'accents' = only accent/light is fabric, null = not a furnishing. */
export function fabricModeFor(name: string, url: string): 'accents' | 'all' | null {
  const s = `${name} ${url}`;
  if (FABRIC_ALL_RE.test(s)) return 'all';
  if (FABRIC_ACCENT_RE.test(s)) return 'accents';
  return null;
}

/** Resolve the grey-cluster target for an object from its name/url: floor cobble, iron, or
 *  (default) wall stone. (Bedding greys are handled by fabricModeFor='all', not here.) Used by
 *  the lab (per WorldObject) and the game (per tile key). */
export function greyRoleFor(name: string, url: string): SwatchRole {
  const s = `${name} ${url}`;
  if (FLOOR_RE.test(s) && !/wall|ceiling|wood/i.test(s)) return 'floor';
  if (isMetalProp(name, url)) return 'metal';
  return 'stone';
}

/** ROUND/CURVED props whose faces aren't axis-aligned — they need TRIPLANAR projection so
 *  the texture wraps without the single-plane stretch. Everything else (the boxy dungeon
 *  shell + flat-faced props) uses the CLASSIC single-plane projection, which is cohesive and
 *  sharper on flat faces. Kept to clearly-round items; the shell must NEVER match this. */
const CURVED_PROP_RE = /barrel|coin|bottle|cask|keg|pot\b|jar|vase|urn|mug|cup|bowl|plate|candle|sphere|ball|wheel|skull|gem|crystal/i;

/** Whether an object should render with triplanar (curved) vs classic single-plane (flat). */
export function isCurvedProp(name: string, url: string): boolean {
  return CURVED_PROP_RE.test(name) || CURVED_PROP_RE.test(url);
}

/** Resolve the `?theme=` param to a valid theme id, or null (= no theme / raw atlas). */
export function readThemeFromParams(params: URLSearchParams): string | null {
  const t = params.get('theme');
  return t && THEME_ORDER.includes(t) ? t : null;
}

/** The mapping applied by DEFAULT (no `?theme=`): real materials are how things SHOULD map,
 *  so the raw flat-atlas look is now opt-in (`?theme=raw`), not the default. */
export const DEFAULT_THEME_ID = 'stoneKeep';

/** Pack ids whose models UV-map onto the DUNGEON atlas this PALETTE was sampled from — the
 *  only packs a theme can map correctly. Every other KayKit pack ships its OWN colormap, so a
 *  theme would mis-read it; those keep their authored materials. (Generalizing to per-pack
 *  palettes would lift this gate.) */
export const THEMEABLE_PACKS: ReadonlySet<string> = new Set(['dungeon', 'dungeon_remastered']);

/** Whether a pack should be themed. `undefined` = a hand-made objects/*.ts (all dungeon) → yes. */
export function isThemeablePack(packId: string | undefined): boolean {
  return packId === undefined || THEMEABLE_PACKS.has(packId);
}

/**
 * Resolve `?theme=` to the EFFECTIVE theme id, applying the default:
 *   absent / unknown → DEFAULT_THEME_ID (real materials — the general default mapping),
 *   'raw' (or 'none') → null (the original flat KayKit atlas, opt-in),
 *   a valid id        → that theme.
 */
export function resolveThemeParam(params: URLSearchParams): string | null {
  const t = params.get('theme');
  if (t === 'raw' || t === 'none') return null;
  return t && THEME_ORDER.includes(t) ? t : DEFAULT_THEME_ID;
}
