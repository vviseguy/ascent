// ============================================================================
// src/lab/texture-catalog.ts — the TEXTURE LIBRARY + per-type CONFIG (lab tuning).
// ============================================================================
//
// The recolor system (recolor.ts) gives every swatch a colour + gradient + surface; this file is
// where we choose WHICH real tiling texture each material TYPE wears, and its surface
// (roughness/metalness). It's the single source shared by:
//   • recolor.ts        — bakes + shaders the chosen texture per type
//   • texture-settings.ts — the in-app settings menu that mutates the config
//   • lab.ts            — reads/writes the config to the URL (shareable / screenshottable)
//
// CC0 textures live in public/textures/ (ambientCG). The recolor multiplies a NORMALISED detail
// (luminance pattern) onto the baked tint — so a texture contributes its PATTERN, the type's tint
// contributes the COLOUR. That's why any texture can sit on any type and stay predictable.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

/** The material TYPES the menu configures (= the recolor presets). Kept here so the catalog,
 *  recolor, and menu share one definition without a circular import. */
// Each preset is a CLEAN 1:1 material abstraction → one texture + surface (Hop 2). To add a
// distinction we add ANOTHER preset (e.g. planks `wood` vs `grained` dark wood), never a
// context-conditional texture. Context lives only in Hop 1 (swatch→preset; see recolor.ts).
export type Preset =
  | 'stone' | 'smoothstone' | 'floor'
  | 'wood' | 'grained'
  | 'metal' | 'irondark' | 'gold'
  | 'cloth' | 'terracotta' | 'dark' | 'plain';

/** The presets that appear as rows in the settings menu, in display order. */
export const CONFIGURABLE_PRESETS: readonly Preset[] = [
  'stone', 'smoothstone', 'floor', 'wood', 'grained', 'metal', 'irondark', 'gold', 'cloth', 'terracotta', 'dark', 'plain',
];

/** A texture the user can assign to a type. `diff` omitted ⇒ the "flat" option (no tiling grain). */
export interface TextureOption {
  id: string;
  label: string;
  /** Which type this texture is FROM (for menu grouping); any option can go on any type. */
  group: 'stone' | 'floor' | 'wood' | 'metal' | 'cloth' | 'neutral';
  /** File in public/textures/ (albedo). Omitted = flat (no tiling). */
  diff?: string;
  /** Normal map file (relief). */
  nor?: string;
  /** Greyscale roughness map (ambientCG-era separate file). Ignored when `arm` is present. */
  rough?: string;
  /** Greyscale ambient-occlusion map. Ignored when `arm` is present. */
  ao?: string;
  /** Poly Haven's PACKED map — R = AO, G = roughness, B = metalness. One file, two channels we
   *  want, so it supersedes `rough`/`ao`. */
  arm?: string;
  /** How the texture contributes to colour:
   *    'grain'  (default) — LUMINANCE only; the swatch tint keeps the colour, so any texture sits
   *                         on any type predictably. Right for masonry, concrete, brushed metal.
   *    'albedo'           — the texture's OWN colour, re-shaded by the baked KayKit gradient. Right
   *                         for scanned materials whose colour variation IS the asset (real wood). */
  color?: 'grain' | 'albedo';
  /** World tile size (metres per repeat). Poly Haven publishes this: its `dimensions` in mm. */
  scale: number;
}

/** The texture library. Order = menu order within each group. */
export const TEXTURES: readonly TextureOption[] = [
  { id: 'none', label: '— flat (no texture) —', group: 'neutral', scale: 1 },
  // RELIEF CALIBRATION — a flat grey albedo plus a normal map whose height profile is known:
  // height RISES from the image top to the middle and FALLS after, so the crest is the midline
  // and the troughs are the top and bottom edges. Pick it on any type and the surface tells you
  // unambiguously whether the pipeline lights a ridge as a ridge. Not art — a measuring stick.
  { id: 'calibration', label: 'Relief calibration (test)', group: 'neutral', diff: 'calib_diff.png', nor: 'calib_nor.png', scale: 2.0 },
  // stone family
  { id: 'masonry', label: 'Masonry', group: 'stone', diff: 'stone_diff.jpg', nor: 'stone_nor.jpg', rough: 'stone_rough.jpg', scale: 3.0 },
  { id: 'brick', label: 'Brick', group: 'stone', diff: 'brick_diff.jpg', nor: 'brick_nor.jpg', scale: 2.2 },
  { id: 'concrete', label: 'Concrete (smooth)', group: 'stone', diff: 'concrete_diff.jpg', nor: 'concrete_nor.jpg', scale: 3.0 },
  { id: 'marble', label: 'Marble (smooth)', group: 'stone', diff: 'marble_diff.jpg', nor: 'marble_nor.jpg', scale: 3.2 },
  { id: 'cobble', label: 'Cobblestone', group: 'floor', diff: 'floor_diff.jpg', nor: 'floor_nor.jpg', rough: 'floor_rough.jpg', scale: 2.6 },
  // wood — the three Poly Haven scans are 'albedo' mode: their colour variation is the whole point,
  // and a luminance-only read throws it away. `scale` is Poly Haven's published real-world size.
  { id: 'medieval-wood', label: 'Medieval wood', group: 'wood', diff: 'wood-medieval_diff.jpg', nor: 'wood-medieval_nor.jpg', arm: 'wood-medieval_arm.jpg', color: 'albedo', scale: 2.0 },
  { id: 'rough-planks', label: 'Rough planks', group: 'wood', diff: 'wood-rough_diff.jpg', nor: 'wood-rough_nor.jpg', arm: 'wood-rough_arm.jpg', color: 'albedo', scale: 2.0 },
  { id: 'old-planks', label: 'Old planks', group: 'wood', diff: 'wood-old_diff.jpg', nor: 'wood-old_nor.jpg', arm: 'wood-old_arm.jpg', color: 'albedo', scale: 2.0 },
  // NOT TILEABLE — `wood_diff.jpg` has a hard seam every repeat (wrap delta 9.8x the image's own
  // interior gradient; `npm run tex:seams`). Kept only so old `?tex=` URLs still resolve.
  { id: 'planks', label: 'Planks (seam — legacy)', group: 'wood', diff: 'wood_diff.jpg', nor: 'wood_nor.jpg', rough: 'wood_rough.jpg', scale: 1.4 },
  { id: 'wood-dark', label: 'Dark wood', group: 'wood', diff: 'wood-dark_diff.jpg', nor: 'wood-dark_nor.jpg', scale: 1.4 },
  // metal
  { id: 'steel-brushed', label: 'Brushed steel', group: 'metal', diff: 'steel-brushed_diff.jpg', nor: 'steel-brushed_nor.jpg', scale: 1.6 },
  { id: 'iron-worn', label: 'Worn iron', group: 'metal', diff: 'metal_diff.jpg', nor: 'metal_nor.jpg', rough: 'metal_rough.jpg', scale: 1.2 },
  { id: 'iron-dark', label: 'Dark iron', group: 'metal', diff: 'iron-dark_diff.jpg', nor: 'iron-dark_nor.jpg', scale: 1.4 },
  // cloth
  { id: 'cloth-linen', label: 'Linen weave', group: 'cloth', diff: 'cloth-linen_diff.jpg', nor: 'cloth-linen_nor.jpg', scale: 1.0 },
];

export const TEXTURE_BY_ID: ReadonlyMap<string, TextureOption> = new Map(TEXTURES.map((t) => [t.id, t]));

/** Per-type choice: which texture + how the surface reads (roughness/metalness). */
export interface TypeSetting {
  texture: string; // a TextureOption id
  roughness: number; // 0..1
  metalness: number; // 0..1
}
export type RecolorConfig = Record<Preset, TypeSetting>;

/** The tuned defaults — good out of the box. Metal/gold use brushed steel + high metalness (with the
 *  lab's IBL env that's what makes them read as METAL, not stone). Stone/wood/floor keep their grain. */
export const DEFAULT_CONFIG: RecolorConfig = {
  stone: { texture: 'masonry', roughness: 0.95, metalness: 0.0 },
  smoothstone: { texture: 'concrete', roughness: 0.6, metalness: 0.0 }, // smooth cut stone (architectural trim)
  floor: { texture: 'cobble', roughness: 1.0, metalness: 0.0 },
  wood: { texture: 'medieval-wood', roughness: 0.82, metalness: 0.0 }, // regular wood = medieval planks
  grained: { texture: 'old-planks', roughness: 0.8, metalness: 0.0 }, // dark / grained wood
  metal: { texture: 'steel-brushed', roughness: 0.4, metalness: 0.9 },
  irondark: { texture: 'iron-dark', roughness: 0.5, metalness: 0.85 }, // dark iron (charcoal / furniture fittings)
  gold: { texture: 'steel-brushed', roughness: 0.32, metalness: 1.0 },
  cloth: { texture: 'cloth-linen', roughness: 0.9, metalness: 0.0 },
  terracotta: { texture: 'steel-brushed', roughness: 0.4, metalness: 0.85 }, // copper/orange → metallic
  dark: { texture: 'none', roughness: 0.55, metalness: 0.3 },
  plain: { texture: 'none', roughness: 0.7, metalness: 0.0 },
};

// ---- the ACTIVE config (mutable; the menu drives it, recolor reads it) ----------------------
let _active: RecolorConfig = structuredClone(DEFAULT_CONFIG);

export function getConfig(): RecolorConfig { return _active; }
export function getTypeSetting(p: Preset): TypeSetting { return _active[p]; }
export function setConfig(cfg: RecolorConfig): void { _active = cfg; }
export function setTypeSetting(p: Preset, s: Partial<TypeSetting>): void { _active[p] = { ..._active[p], ...s }; }
export function resetConfig(): void { _active = structuredClone(DEFAULT_CONFIG); }

// ---- URL codec (compact; only non-default types, so a default URL stays clean) --------------
// Format:  tex=stone:masonry:95:0,metal:steel-brushed:40:90   (roughness/metalness as 0..100)

export function configToParam(cfg: RecolorConfig): string {
  const parts: string[] = [];
  for (const p of CONFIGURABLE_PRESETS) {
    const s = cfg[p], d = DEFAULT_CONFIG[p];
    if (s.texture === d.texture && s.roughness === d.roughness && s.metalness === d.metalness) continue;
    parts.push(`${p}:${s.texture}:${Math.round(s.roughness * 100)}:${Math.round(s.metalness * 100)}`);
  }
  return parts.join(',');
}

// ---- RELIEF (global bump strength 0..1) — real normal maps in world space (tiling.ts) ----------
// ON by default at 0.45: the surface maps are the point of the tiling layer, and a normal map costs
// nothing extra now that every texture lives in one array (no more per-object sampler budget). 0.45
// reads as carved stone without the grain competing with the silhouette (docs/06: bold forms over
// photo-texture) — the ladder past ~0.6 starts looking noisy rather than deep.
let _relief = 0.45;
export function getRelief(): number { return _relief; }
export function setRelief(v: number): void { _relief = Math.min(1, Math.max(0, v)); }
export function reliefToParam(v: number): string { return v !== 0.45 ? String(Math.round(v * 100)) : ''; }
export function reliefFromParam(param: string | null): number {
  const n = Number(param);
  return param != null && Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0.45;
}

// ---- AMBIENT OCCLUSION (global strength 0..1) — applied to INDIRECT light only (tiling.ts) ------
// Direct light still models the form; AO only darkens what the environment/IBL fills in, so mortar
// joints and plank gaps read as recessed without muddying the key light.
let _ao = 0.7;
export function getAOStrength(): number { return _ao; }
export function setAOStrength(v: number): void { _ao = Math.min(1, Math.max(0, v)); }
export function aoToParam(v: number): string { return v !== 0.7 ? String(Math.round(v * 100)) : ''; }
export function aoFromParam(param: string | null): number {
  const n = Number(param);
  return param != null && Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0.7;
}

/**
 * Overlay a `?tex=` string onto the LIVE config instead of onto the defaults.
 *
 * `?tex=` and `?profile=` are not alternatives — the URL writes both, so a link means "this profile,
 * with these deltas on top". The profile store loads asynchronously, so its `setConfig` lands AFTER
 * the initial `configFromParam`, and rebuilding from DEFAULT_CONFIG at that point silently discards
 * every type the link did not mention. That is not a cosmetic ordering wrinkle: it made shared and
 * screenshotted `?tex=` links quietly render something other than what they say, which defeats the
 * only reason the state round-trips through the URL at all.
 */
export function overlayConfigParam(param: string | null): void {
  if (!param) return;
  const cfg = getConfig();
  for (const entry of param.split(',')) {
    const [p, tex, r, m] = entry.split(':');
    if (!p || !(p in cfg)) continue;
    const key = p as Preset;
    if (tex && TEXTURE_BY_ID.has(tex)) cfg[key].texture = tex;
    const rn = Number(r), mn = Number(m);
    if (Number.isFinite(rn)) cfg[key].roughness = Math.min(1, Math.max(0, rn / 100));
    if (Number.isFinite(mn)) cfg[key].metalness = Math.min(1, Math.max(0, mn / 100));
  }
}

export function configFromParam(param: string | null): RecolorConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (!param) return cfg;
  for (const entry of param.split(',')) {
    const [p, tex, r, m] = entry.split(':');
    if (!p || !(p in cfg)) continue;
    const key = p as Preset;
    if (tex && TEXTURE_BY_ID.has(tex)) cfg[key].texture = tex;
    const rn = Number(r), mn = Number(m);
    if (Number.isFinite(rn)) cfg[key].roughness = Math.min(1, Math.max(0, rn / 100));
    if (Number.isFinite(mn)) cfg[key].metalness = Math.min(1, Math.max(0, mn / 100));
  }
  return cfg;
}
