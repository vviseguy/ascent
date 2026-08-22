// ============================================================================
// src/lab/recolor.ts — HSL swatch recolor (gradient-preserving). The whole system.
// ============================================================================
//
// See src/lab/CLAUDE.md for the full design + how to tune. In one breath:
//
// KayKit models are UV-mapped onto a shared ATLAS of ~27 flat colour SWATCHES, each a soft
// light→dark GRADIENT that bakes in cheap shading. We recolor by BAKING new textures on the CPU.
// Per atlas pixel:
//
//     1. IDENTIFY its swatch        (by atlas POSITION/grid cell, or by chroma — see SwatchIdMethod)
//     2. convert the pixel to HSL,  KEEP its Lightness  ( = the baked gradient/shading )
//     3. SET Hue + Saturation to the swatch's mapped target colour
//     4. HSL → RGB  → baked albedo;  the swatch's roughness/metalness → a baked ORM map.
//        ORM.r ALSO carries a tiling SLOT (which real texture this swatch's preset uses).
//
// Keeping Lightness is the whole trick: the gradient survives BY CONSTRUCTION (we never touch the
// channel that carries it), so there's no "shade ratio" to collapse into flat/quantized colour.
// The model keeps its silhouette AND KayKit's baked light/shadow; we only swap the hue+sat+surface.
//
// TILING DETAIL (real grain): the baked albedo is on ATLAS UVs, which can't show repeating masonry/
// planks/metal. So a SMALL shader (patchTilingDetail) samples a real tiling texture in WORLD space
// and MULTIPLIES it onto the baked albedo as a normalised detail (mean ≈ 1 → adds the PATTERN, not a
// second darkening). The texture per pixel is the SLOT baked in ORM.r — no per-pixel swatch matching
// in the shader (D3D-safe: fixed samplers, a branch on a constant-per-region int). This is the only
// custom shader; the colour+gradient+surface remain a plain CPU bake.
//
// THE MAPPING is a 3-layer cascade, most-specific wins (the "authoritative path"):
//     ③ OBJECT override  (by file token, e.g. bed_decorated)  — rare, pinpoint
//     ② FOLDER override  (by pack folder, e.g. kaykit_dungeon) — the main tuning layer
//     ① BASE             (role → surface preset, tint = the swatch's OWN colour)
// The base barely remaps (keeps colours, just adds a surface), so most objects need no
// override at all. Overrides exist for the genuinely ambiguous shared swatches — the grey
// that's masonry on a wall but bedding on a bed, or iron on a blade.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import { SWATCHES, type SwatchName, type SwatchRole } from './palette.ts';
import { type Preset, getTypeSetting } from './texture-catalog.ts';
import { dungeonCategory } from './object-category.ts';
import { PRESET_SLOT as TILING_PRESET_SLOT, patchTilingDetail, ensureTilingTextures } from './tiling.ts';

// Re-exported so world-object.ts keeps its single import from recolor.
export { ensureTilingTextures };

// The material TYPES + per-type texture/surface CONFIG live in texture-catalog.ts (shared with the
// settings menu + URL). Re-export Preset so existing importers (recolor-legend) keep working.
export type { Preset } from './texture-catalog.ts';

/** What a swatch becomes: a surface preset, an optional tint override (default = its own colour),
 *  and an optional emissive (for glows). The minimal unit an override can set. */
export interface SwatchMaterial {
  preset?: Preset;
  /** Albedo tint (hex). Omitted = keep the swatch's OWN colour (the common case). */
  tint?: number;
  emissive?: number;
}

/** A cascade layer: blanket changes by ROLE (all greys → cloth) and/or pinpoint by SWATCH. */
export interface MappingLayer {
  /** Change the preset for every swatch of a role (e.g. {stone:'cloth'} → all greys become cloth). */
  roles?: Partial<Record<SwatchRole, Preset>>;
  /** Override individual swatches (preset/tint/emissive). Beats `roles`. */
  swatches?: Partial<Record<SwatchName, SwatchMaterial>>;
}

// ----------------------------------------------------------------------------
// ① BASE — role → default surface preset. Tint stays the swatch's OWN colour, so the base
// keeps the dungeon looking like itself and only adds a believable surface. THIS is why we
// "don't have to do much remapping": colour is preserved; the gradient is preserved.
// ----------------------------------------------------------------------------

const ROLE_PRESET: Record<SwatchRole, Preset> = {
  stone: 'stone',
  trim: 'stone', // the dark plinth/cap slate — still masonry by default
  floor: 'floor', // floor tiles → cobblestone grain
  wood: 'wood',
  metal: 'metal',
  gold: 'gold',
  dark: 'irondark', // near-black charcoal → dark iron (metallic), not a flat dark
  orange: 'terracotta', // burnt-orange / copper clay
  light: 'plain', // white/cream — plain unless an object says it's cloth (bedding)
  red: 'plain',
  green: 'plain',
  blue: 'plain',
  purple: 'plain',
  pink: 'plain',
  teal: 'plain',
};

// ----------------------------------------------------------------------------
// ② FOLDER overrides — per pack/atlas. Empty for the dungeon (the base is tuned for it);
// other packs ship their own atlas and will refine here. This is the layer to "hone".
// ----------------------------------------------------------------------------

const FOLDER_OVERRIDES: Record<string, MappingLayer> = {
  // kaykit_dungeon / kaykit_dungeon_remastered share the atlas the BASE is tuned for → no-op.
};

// ----------------------------------------------------------------------------
// ③ OBJECT overrides — by file token (basename, no extension). The handful of objects where
// a shared swatch means something unusual. BED is the priority: its greys are bedding (blanket/
// pillow), not a stone frame — so the grey cluster + the soft colours read as CLOTH, while the
// wood frame swatches stay wood (untouched). Blades read the grey as iron.
// ----------------------------------------------------------------------------

const OBJECT_OVERRIDES: Record<string, MappingLayer> = {
  // Bed: the grey + light + soft-colour swatches are bedding → cloth; wood frame stays wood.
  bed_decorated: { roles: { stone: 'cloth', trim: 'cloth', light: 'cloth', red: 'cloth', green: 'cloth', blue: 'cloth', purple: 'cloth', pink: 'cloth', teal: 'cloth' } },
  bed_frame: { roles: { stone: 'cloth', trim: 'cloth', light: 'cloth' } },
  // Metal props: the shared blue-grey is iron, not masonry.
  sword_shield: { roles: { stone: 'metal', trim: 'metal' } },
  keyring_hanging: { roles: { stone: 'metal', trim: 'metal' } },
};

// ----------------------------------------------------------------------------
// CATEGORY overrides — by the object's grouping (Structure = "architecture", Furniture =
// "furnishings", … via object-category.ts). This is the CONTEXT layer of Hop 1: the SAME swatch
// becomes a different PRESET depending on what kind of object it's on (a colour can't tell shell-
// stone from prop-metal, but the object's category often can). It only ever picks a preset; each
// preset stays a clean 1:1 to a texture (texture-catalog). Sits between FOLDER and OBJECT in the
// cascade (broader than a single object, narrower than a whole pack).
// ----------------------------------------------------------------------------

const CATEGORY_OVERRIDES: Record<string, MappingLayer> = {
  // Architecture: the cool dark greys read as smooth cut stone (plinths/caps/trim); architectural
  // wood (doors/scaffolds) reads as dark grained wood (vs furniture's lighter planks).
  Structure: {
    roles: { wood: 'grained' },
    swatches: { darkSteel: { preset: 'smoothstone' }, stoneDark: { preset: 'smoothstone' } },
  },
  // Furnishings: the primary blue-grey is metal fittings here (hinges/brackets), not wall stone.
  Furniture: {
    swatches: { ironGrey: { preset: 'irondark' } },
  },
};

// ----------------------------------------------------------------------------
// Resolve the cascade for an object → a per-swatch material, aligned to SWATCHES order.
// ----------------------------------------------------------------------------

/** The fully-resolved render data for one swatch (what the shader needs). */
export interface ResolvedSwatch {
  name: string;
  /** Atlas reference colour (the swatch's own hex) — the shader matches a pixel to this. */
  ref: number;
  preset: Preset;
  tint: number;
  emissive: number;
  roughness: number;
  metalness: number;
}

/** Resolve BASE ← FOLDER[folder] ← CATEGORY[category] ← OBJECT[file], most-specific wins. The
 *  category is derived from the file token for dungeon packs (Structure/Furniture/…). */
export function resolveMapping(folder: string, file: string): ResolvedSwatch[] {
  const category = folder.startsWith('kaykit_dungeon') ? dungeonCategory(file) : '';
  const layers = [FOLDER_OVERRIDES[folder], CATEGORY_OVERRIDES[category], OBJECT_OVERRIDES[file]].filter(Boolean) as MappingLayer[];
  return SWATCHES.map((sw) => {
    let preset: Preset = ROLE_PRESET[sw.role];
    let tint = sw.hex;
    let emissive = 0;
    for (const layer of layers) {
      const byRole = layer.roles?.[sw.role];
      if (byRole) preset = byRole;
      const bySwatch = layer.swatches?.[sw.name as SwatchName];
      if (bySwatch) {
        if (bySwatch.preset) preset = bySwatch.preset;
        if (bySwatch.tint !== undefined) tint = bySwatch.tint;
        if (bySwatch.emissive !== undefined) emissive = bySwatch.emissive;
      }
    }
    const s = getTypeSetting(preset); // roughness/metalness come from the live per-type config
    return { name: sw.name, ref: sw.hex, preset, tint, emissive, roughness: s.roughness, metalness: s.metalness };
  });
}

/** Parse `models/<folder>/<file><ext>` → { folder, file } (file = basename, no extension(s)). */
export function folderAndFile(meshUrl: string): { folder: string; file: string } {
  const parts = meshUrl.split('/');
  const folder = parts[parts.length - 2] ?? '';
  const base = parts[parts.length - 1] ?? '';
  const file = base.replace(/\.gltf\.glb$/i, '').replace(/\.(glb|gltf)$/i, '');
  return { folder, file };
}

// ----------------------------------------------------------------------------
// CPU BAKE — no custom shader. We recolor the atlas IMAGE into new albedo + ORM (roughness/
// metalness) textures on a canvas, then hand them to a plain MeshStandardMaterial. Standard
// textures render IDENTICALLY on every GPU/driver (no ANGLE/D3D shader-translation surprises),
// and we control the matching in JS so a swatch's whole gradient stays one swatch (no banding).
// ----------------------------------------------------------------------------

// ---- HSL (the recolor space): we KEEP a pixel's Lightness (= the baked gradient/shading) and
// only SET its Hue+Saturation to the target swatch, so the gradient survives by construction. ----

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}
function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
/** HSL → RGB (0..255). */
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-6) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

// ---- SWATCH IDENTIFICATION (abstracted + swappable) -----------------------------------------
// For each atlas pixel, which PALETTE swatch does it belong to? Two strategies; 'position' is the
// default. Both are object-independent, so the result (idx per pixel) is cached per atlas+method.

/** How a pixel is mapped to a swatch. 'position' = by atlas grid cell (layout-based, stable, fast);
 *  'chroma' = by hue (colour-based, robust to layout). */
export type SwatchIdMethod = 'position' | 'chroma';

const ATLAS_COLS = 8, ATLAS_ROWS = 4; // the KayKit dungeon atlas grid

/** Nearest swatch to an RGB by full distance (used to label each grid cell by its centre colour). */
function nearestSwatch(r: number, g: number, b: number): number {
  let best = 0, bd = 1e9;
  for (let i = 0; i < SWATCHES.length; i++) {
    const c = SWATCHES[i]!.hex; const dr = r - ((c >> 16) & 255), dg = g - ((c >> 8) & 255), db = b - (c & 255);
    const dd = dr * dr + dg * dg + db * db;
    if (dd < bd) { bd = dd; best = i; }
  }
  return best;
}

interface AtlasIndex { w: number; h: number; idx: Uint8Array; L: Float32Array; }
const _atlasIndexCache = new Map<string, AtlasIndex>();

/** Read an atlas texture's pixels (RGBA 0..255). Handles a drawable image (HTMLImageElement /
 *  ImageBitmap / canvas) AND a data-backed image ({data,width,height}); null if unreadable. (The
 *  lab loads textures as <img> — see lab.ts — so drawImage always works; this stays defensive,
 *  since some 2D backends, e.g. headless SwiftShader, refuse drawImage on an ImageBitmap.) */
function readAtlasPixels(image: unknown): { data: Uint8ClampedArray | Uint8Array; w: number; h: number } | null {
  const img = image as { width?: number; height?: number; data?: Uint8ClampedArray | Uint8Array } | null | undefined;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  if (!img || !w || !h) return null;
  if (img.data && (img.data instanceof Uint8ClampedArray || img.data instanceof Uint8Array)) return { data: img.data, w, h };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img as CanvasImageSource, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch { return null; }
}

/** Build (and cache) the per-pixel swatch index + Lightness for an atlas, by the chosen method. */
function atlasIndexFor(atlas: THREE.Texture, method: SwatchIdMethod): AtlasIndex | null {
  const key = `${atlas.uuid}|${method}`;
  const cached = _atlasIndexCache.get(key);
  if (cached) return cached;
  const px = readAtlasPixels(atlas.image);
  if (!px) return null;
  const { data, w, h } = px;
  const n = w * h;
  const idx = new Uint8Array(n);
  const L = new Float32Array(n);

  if (method === 'position') {
    // label each grid CELL by its centre colour, then every pixel takes its cell's swatch — so a
    // whole swatch (gradient and all) is ONE swatch, no colour drift at all.
    const cell = new Uint8Array(ATLAS_COLS * ATLAS_ROWS);
    for (let row = 0; row < ATLAS_ROWS; row++) for (let col = 0; col < ATLAS_COLS; col++) {
      const cx = Math.floor((col + 0.5) * w / ATLAS_COLS), cy = Math.floor((row + 0.5) * h / ATLAS_ROWS);
      const i = (cy * w + cx) * 4;
      cell[row * ATLAS_COLS + col] = nearestSwatch(data[i]!, data[i + 1]!, data[i + 2]!);
    }
    for (let p = 0; p < n; p++) {
      const x = p % w, y = (p / w) | 0;
      const col = Math.min(ATLAS_COLS - 1, (x * ATLAS_COLS / w) | 0), row = Math.min(ATLAS_ROWS - 1, (y * ATLAS_ROWS / h) | 0);
      idx[p] = cell[row * ATLAS_COLS + col]!;
      const r = data[p * 4]!, g = data[p * 4 + 1]!, b = data[p * 4 + 2]!;
      L[p] = (Math.max(r, g, b) + Math.min(r, g, b)) / 510; // HSL lightness 0..1
    }
  } else {
    // by chroma (hue): nearest swatch with brightness removed → a gradient stays one swatch.
    const sw = SWATCHES.map((s) => {
      const r = (s.hex >> 16) & 255, g = (s.hex >> 8) & 255, b = s.hex & 255;
      const il = 1 / Math.max(0.299 * r + 0.587 * g + 0.114 * b, 1);
      return [r * il, g * il, b * il] as const;
    });
    for (let p = 0; p < n; p++) {
      const r = data[p * 4]!, g = data[p * 4 + 1]!, b = data[p * 4 + 2]!;
      const il = 1 / Math.max(0.299 * r + 0.587 * g + 0.114 * b, 1);
      const cr = r * il, cg = g * il, cb = b * il;
      let best = 0, bd = 1e9;
      for (let i = 0; i < sw.length; i++) { const s = sw[i]!; const dr = cr - s[0], dg = cg - s[1], db = cb - s[2]; const dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = i; } }
      idx[p] = best;
      L[p] = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
    }
  }
  const out: AtlasIndex = { w, h, idx, L };
  _atlasIndexCache.set(key, out);
  return out;
}

/** Copy the wrap/filter/flip from the source atlas so the baked textures sample the same way. */
function copyTexParams(src: THREE.Texture, dst: THREE.Texture): void {
  dst.wrapS = src.wrapS; dst.wrapT = src.wrapT;
  dst.magFilter = THREE.LinearFilter; dst.minFilter = THREE.LinearFilter; // smooth across boundaries
  dst.flipY = src.flipY; dst.anisotropy = src.anisotropy;
  dst.generateMipmaps = false;
}

// The world-space TILING DETAIL layer (real grain, relief, per-texel roughness, AO) lives in
// tiling.ts — it is a self-contained shader patch over the baked material, and keeping it out of
// here leaves this file about ONE thing: swatch -> colour + surface. PRESET_SLOT is its contract
// with the bake below: the slot goes into ORM.r, tiling.ts's shader indexes its arrays by it.
const PRESET_SLOT = TILING_PRESET_SLOT;

/** Bake recolored albedo + ORM textures and return a MeshStandardMaterial. The recolor is HSL —
 *  each pixel keeps its own Lightness (the gradient) and takes the target swatch's Hue+Sat — and
 *  ORM.r carries the tiling SLOT so the shader multiplies in real world-space grain (patchTilingDetail). */
function bakeMaterial(atlas: THREE.Texture, resolved: ResolvedSwatch[], method: SwatchIdMethod): THREE.MeshStandardMaterial | null {
  const ai = atlasIndexFor(atlas, method);
  if (!ai) return null;
  const { w, h, idx, L } = ai;
  const n = w * h;

  // per-swatch target Hue+Sat (from the mapped tint) + surface + tiling slot (aligned to resolved order)
  const tH: number[] = [], tS: number[] = [], rgh: number[] = [], mtl: number[] = [], slot: number[] = [];
  // ...and the swatch's OWN reference lightness. KayKit's baked gradient is exactly
  // pixelL / refL, so storing that ratio (below) lets an 'albedo' texture wear the same shading
  // instead of having its colour thrown away. Floor the reference so a near-black swatch can't
  // divide by ~0 and blow the ratio out.
  const refL: number[] = [];
  for (const s of resolved) {
    const [h0, s0] = rgb2hsl((s.tint >> 16) & 255, (s.tint >> 8) & 255, s.tint & 255);
    tH.push(h0); tS.push(s0); rgh.push(Math.round(s.roughness * 255)); mtl.push(Math.round(s.metalness * 255)); slot.push(PRESET_SLOT[s.preset]);
    refL.push(Math.max(rgb2hsl((s.ref >> 16) & 255, (s.ref >> 8) & 255, s.ref & 255)[2], 0.04));
  }

  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const shade = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const i = idx[p]!;
    const [r, g, b] = hsl2rgb(tH[i]!, tS[i]!, L[p]!); // target hue+sat, the pixel's own lightness
    const a = p * 4;
    albedo[a] = r; albedo[a + 1] = g; albedo[a + 2] = b; albedo[a + 3] = 255;
    orm[a] = slot[i]!; orm[a + 1] = rgh[i]!; orm[a + 2] = mtl[i]!; orm[a + 3] = 255; // R=tiling slot, G=rough, B=metal
    // the gradient as a RATIO/2 (128 = "unshaded"), so 0..2x fits in a byte.
    shade[a] = Math.max(0, Math.min(255, Math.round((L[p]! / refL[i]!) * 127.5)));
    shade[a + 3] = 255;
  }

  const albTex = new THREE.DataTexture(albedo, w, h, THREE.RGBAFormat);
  albTex.colorSpace = THREE.SRGBColorSpace; copyTexParams(atlas, albTex); albTex.needsUpdate = true;
  const ormTex = new THREE.DataTexture(orm, w, h, THREE.RGBAFormat);
  ormTex.colorSpace = THREE.NoColorSpace; copyTexParams(atlas, ormTex);
  // NEAREST: ORM carries per-swatch CONSTANTS (slot/rough/metal), not gradients. Linear-filtering
  // the slot (R) would average e.g. 1↔3 to 2 at a swatch seam → wrong tiling texture on the seam.
  ormTex.magFilter = ormTex.minFilter = THREE.NearestFilter;
  ormTex.needsUpdate = true;

  // SHADE map — the baked KayKit gradient on its own. LINEAR-filtered (unlike ORM) because it IS a
  // gradient; nearest would step visibly wherever an 'albedo' texture wears it.
  const shadeTex = new THREE.DataTexture(shade, w, h, THREE.RGBAFormat);
  shadeTex.colorSpace = THREE.NoColorSpace; copyTexParams(atlas, shadeTex); shadeTex.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({ map: albTex, roughnessMap: ormTex, metalnessMap: ormTex, roughness: 1, metalness: 1 });
  patchTilingDetail(mat, shadeTex); // real tiling grain + relief + per-texel roughness + AO
  return mat;
}

// ----------------------------------------------------------------------------
// Apply to a loaded model: resolve the cascade, BAKE the recolored textures from the model's atlas,
// and assign the material to every mesh (geometry/UVs untouched). Returns the resolved table (for
// the lab legend) or null if the model has no atlas (e.g. a procedural element).
// ----------------------------------------------------------------------------

export function applyRecolor(root: THREE.Object3D, meshUrl: string, method: SwatchIdMethod = 'position', tintAll?: number, present?: ReadonlySet<number>): ResolvedSwatch[] | null {
  const { folder, file } = folderAndFile(meshUrl);
  const resolved = resolveMapping(folder, file);
  // DEBUG: ?tintall=<hex> forces EVERY swatch to one colour — a self-test that the bake is running
  // (the model turns that colour). If it doesn't, the bundle is stale / the bake isn't applying.
  if (tintAll !== undefined) for (const s of resolved) s.tint = tintAll;

  // find the model's atlas (shared across its meshes)
  let atlas: THREE.Texture | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial | undefined;
    if (mat?.map) atlas = mat.map;
  });
  if (!atlas) return null; // no atlas → procedural element; caller keeps its own material (not an error)

  const baked = bakeMaterial(atlas, resolved, method);
  if (!baked) {
    // The atlas exists but couldn't be read (undrawable/0-size image, tainted canvas). Surface it —
    // otherwise the model silently keeps its raw KayKit colours and looks like the recolor "did nothing".
    console.warn(`[recolor] atlas present but unreadable for ${file} — keeping original material. Check the atlas image is a drawable <img> (createImageBitmap shim) and same-origin.`);
    return null;
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    m.castShadow = true; m.receiveShadow = true;
    m.material = baked;
  });
  return resolved;
}
