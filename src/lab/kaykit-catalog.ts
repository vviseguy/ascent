// ============================================================================
// src/lab/kaykit-catalog.ts — the free KayKit asset packs, auto-cataloged.
// ============================================================================
//
// Turns EVERY free KayKit model (all CC0, from github.com/KayKit-Game-Assets) into a
// browseable `meshObject` (world-object.ts) WITHOUT hand-writing ~900 object files. The
// per-pack file lists come from the GENERATED manifest (kaykit-packs.generated.ts, written
// by scripts/fetch-kaykit.mjs) so this stays a static literal (tree-shakeable, no FS at
// boot) yet always in sync with what is on disk.
//
// A PACK REGISTRY (PACKS) drives the lab's DOUBLE-NESTED side list: level 1 = pack, level 2
// = grouping. Each PackDef knows its on-disk folder, the model extension it ships, a uniform
// scale, and a `categoryOf` that buckets a file into a grouping. Each catalog entry:
//   - meshUrl = models/<dir>/<file><ext>   (file may carry a subfolder, e.g. hexagon's
//     `tiles/base/hex_grass`, or a `.gltf` infix, e.g. remastered's `banner_blue` → .gltf.glb)
//   - one `default` variant with NO retexture → keep the pack's OWN atlas (each pack ships
//     its own texture; we don't re-skin here)
//   - level 'object', footprint auto-fitted by box-fit (zero per-object tuning)
//   - a tidy display NAME + a CATEGORY derived from the filename / subfolder
//
// SKIPPED (dungeon pack only): the 6 legacy GLBs already covered by hand-authored
// objects/*.ts (table_long, barrel_large, chest_gold, wall, shelves, bed_frame) so the
// picker never shows a duplicate. lab.ts MERGES this catalog with objects/*.ts (hand-made
// files win) and folds the 6 hand-made dungeon objects into the Dungeon pack's groups.
//
// IDS: `kk-<packId>-<slug>` so they can never collide with a hand-made objects/<id>.ts file
// nor across packs, and read clearly in the URL (?object=kk-furniture-armchair).
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import { meshObject, type WorldObject } from './world-object.ts';
import { PACK_FILES } from './kaykit-packs.generated.ts';
import { cleanKey, dungeonCategory } from './object-category.ts';

/** One asset pack: its on-disk folder, the extension its models ship, a uniform import
 *  scale, the display order of its groupings, and how a file maps to a grouping. */
export interface PackDef {
  /** Stable pack id (matches a PACK_FILES key + the id prefix). */
  id: string;
  /** Display label for the level-1 dropdown. */
  label: string;
  /** Folder under public/models/. */
  dir: string;
  /** Model file extension (meshUrl = models/<dir>/<file><ext>). */
  ext: string;
  /** Uniform scale: KayKit native units → game metres. */
  scale: number;
  /** Grouping display order (the picker renders level-2 dropdowns in this order; any
   *  grouping not listed here is appended alphabetically). */
  categories: readonly string[];
  /** Bucket a manifest file (possibly with a subfolder / `.gltf` infix) into a grouping. */
  categoryOf(file: string): string;
}

/** The 6 legacy-dungeon GLBs already covered by hand-made objects/*.ts — never re-catalog. */
const COVERED_BY_HANDMADE = new Set([
  'table_long', 'barrel_large', 'chest_gold', 'wall', 'shelves', 'bed_frame',
]);

// ---- file → model token / display name -------------------------------------------------

// cleanKey + dungeonCategory now live in object-category.ts (shared with recolor.ts's CATEGORY
// layer, so "architecture/furnishings" is classified ONE way). Imported at the top.

/** Pretty display name from a file: clean it, split on `_`, Title-Case, keep single
 *  uppercase letters (A/B model suffixes) as-is. `bottle_A_green` → "Bottle A Green". */
function nameOf(file: string): string {
  return cleanKey(file)
    .split('_')
    .map((p) => (p.length === 0 ? p : p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

/** URL-safe, collision-free id: includes subfolders so two same-named files in different
 *  subfolders stay distinct (e.g. hexagon `buildings/blue/...` vs `buildings/red/...`). */
function idOf(packId: string, file: string): string {
  const slug = file.replace(/\.gltf$/i, '').replace(/[^a-z0-9_]+/gi, '-').toLowerCase();
  return `kk-${packId}-${slug}`;
}

// ---- grouping schemes ------------------------------------------------------------------

/** Hexagon: the pack already buckets by subfolder (buildings / decoration / tiles). */
function hexagonCategory(file: string): string {
  const top = file.split('/')[0] ?? '';
  return top ? top.charAt(0).toUpperCase() + top.slice(1) : 'Misc';
}

/** Shared keyword categorizer for the prop packs (furniture/halloween/restaurant/city/
 *  prototype/spacebase). Ordered most-specific first; unmatched → 'Decor' (catch-all so no
 *  model is ever dropped). Substring match on the cleaned, lowercased token. */
const GENERIC_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Lighting', ['candle', 'torch', 'lantern', 'lamp', 'brazier', 'chandelier', 'sconce', 'light']],
  ['Furniture', ['table', 'chair', 'stool', 'bench', 'bed', 'couch', 'sofa', 'armchair', 'cabinet',
    'shelf', 'desk', 'dresser', 'wardrobe', 'drawer', 'counter', 'sink', 'stove', 'oven', 'fridge',
    'rug', 'pillow', 'cushion', 'pictureframe', 'mirror', 'clock', 'bookcase', 'curtain', 'cactus']],
  ['Containers', ['barrel', 'crate', 'box', 'chest', 'basket', 'sack', 'bucket', 'jar', 'pot', 'pan',
    'plate', 'bowl', 'cup', 'mug', 'bottle', 'lid', 'can', 'cargo', 'container', 'dumpster', 'pallet', 'trash', 'bin']],
  ['Vehicles', ['car', 'truck', 'van', 'bus', 'vehicle', 'cart', 'wagon', 'boat', 'ship', 'lander', 'rover']],
  ['Nature', ['tree', 'bush', 'shrub', 'grass', 'flower', 'rock', 'stone', 'log', 'mushroom', 'fern', 'vine', 'pumpkin', 'web']],
  ['Structure', ['wall', 'floor', 'stair', 'pillar', 'column', 'barrier', 'arch', 'fence', 'gate',
    'foundation', 'roof', 'ground', 'path', 'road', 'bridge', 'tile', 'hex', 'building', 'tower',
    'tunnel', 'module', 'platform', 'post', 'door', 'pavement', 'scaffold', 'windturbine', 'structure', 'terrain', 'base']],
];
function genericCategory(file: string): string {
  const k = cleanKey(file).toLowerCase();
  for (const [cat, kws] of GENERIC_RULES) if (kws.some((w) => k.includes(w))) return cat;
  return 'Decor';
}

const PROP_ORDER = ['Structure', 'Furniture', 'Containers', 'Lighting', 'Vehicles', 'Nature', 'Decor'] as const;
const DUNGEON_ORDER = ['Structure', 'Furniture', 'Containers', 'Decor'] as const;

// ---- the pack registry (display order: Dungeon → Space Base) ----------------------------

export const PACKS: readonly PackDef[] = [
  { id: 'dungeon', label: 'KayKit Dungeon', dir: 'kaykit_dungeon', ext: '.glb', scale: 0.5, categories: DUNGEON_ORDER, categoryOf: dungeonCategory },
  { id: 'dungeon_remastered', label: 'KayKit Dungeon (Remastered)', dir: 'kaykit_dungeon_remastered', ext: '.glb', scale: 0.5, categories: DUNGEON_ORDER, categoryOf: dungeonCategory },
  { id: 'furniture', label: 'KayKit Furniture', dir: 'kaykit_furniture', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
  { id: 'halloween', label: 'KayKit Halloween', dir: 'kaykit_halloween', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
  { id: 'restaurant', label: 'KayKit Restaurant', dir: 'kaykit_restaurant', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
  { id: 'hexagon', label: 'KayKit Medieval Hexagon', dir: 'kaykit_hexagon', ext: '.gltf', scale: 1, categories: ['Buildings', 'Decoration', 'Tiles'], categoryOf: hexagonCategory },
  { id: 'city', label: 'KayKit City Builder', dir: 'kaykit_city', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
  { id: 'prototype', label: 'KayKit Prototype', dir: 'kaykit_prototype', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
  { id: 'spacebase', label: 'KayKit Space Base', dir: 'kaykit_spacebase', ext: '.gltf', scale: 1, categories: PROP_ORDER, categoryOf: genericCategory },
];

// ---- the generated catalog -------------------------------------------------------------

/** id → WorldObject for every catalog model (every pack, minus the handmade-covered 6). */
export const kaykitObjects: Record<string, WorldObject> = {};
/** id → packId (for the level-1 grouping). */
export const objectPack: Record<string, string> = {};
/** id → grouping label (for the level-2 grouping). */
export const objectCategory: Record<string, string> = {};

for (const pack of PACKS) {
  for (const file of PACK_FILES[pack.id] ?? []) {
    if (pack.id === 'dungeon' && COVERED_BY_HANDMADE.has(cleanKey(file))) continue;
    const id = idOf(pack.id, file);
    kaykitObjects[id] = meshObject({
      meshUrl: `models/${pack.dir}/${file}${pack.ext}`,
      name: nameOf(file),
      describe: `${pack.label} mesh (${cleanKey(file)}), shown with its own materials. Footprint auto-fitted by box-fit.`,
      level: 'object',
      scale: pack.scale,
      variants: { default: [] }, // no retexture rules → keep the model's authored materials
    });
    objectPack[id] = pack.id;
    objectCategory[id] = pack.categoryOf(file);
  }
}
