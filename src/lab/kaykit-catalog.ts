// ============================================================================
// src/lab/kaykit-catalog.ts — the FREE KayKit dungeon pack, auto-cataloged.
// ============================================================================
//
// One module that turns EVERY free KayKit dungeon GLB in
// public/models/kaykit_dungeon/ into a WorldObject so the lab can browse the
// whole pack without 60+ hand-written object files. Each entry is a `meshObject`
// (world-object.ts) with:
//   - meshUrl   = the GLB
//   - one `default` variant with NO retexture rules → keep the model's OWN
//     materials (the pack already ships its atlas; we don't re-skin here)
//   - level: 'object', scale 0.5 (KayKit native units → game metres, matching the
//     6 hand-made meshObjects), footprint auto-fitted by box-fit (zero tuning)
//   - a tidy display NAME + a CATEGORY derived from the filename
//
// SKIPPED: the 6 GLBs already covered by hand-authored objects/*.ts
// (table_long, barrel_large, chest_gold, wall, shelves, bed_frame) so the picker
// never shows a duplicate. lab.ts MERGES this catalog with objects/*.ts, with the
// hand-made files winning on any id collision.
//
// IDS: catalog ids are prefixed `kk-<filename>` so they can never collide with a
// hand-made objects/<id>.ts file (and read clearly in the URL ?object=kk-…).
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import { meshObject, type WorldObject } from './world-object.ts';

/** The side-list categories, in display order. Catalog entries land in these;
 *  the lab adds a "Featured" + "Procedural" group for the hand-made objects. */
export type Category = 'Structure' | 'Furniture' | 'Containers' | 'Decor';

/** Display order for the catalog categories (the picker renders headers in this order). */
export const CATALOG_CATEGORY_ORDER: Category[] = ['Structure', 'Furniture', 'Containers', 'Decor'];

/** The KayKit GLBs already covered by hand-made objects/*.ts — never re-catalog these. */
const COVERED_BY_HANDMADE = new Set([
  'table_long', // → objects/table.ts
  'barrel_large', // → objects/barrel.ts
  'chest_gold', // → objects/treasure-chest.ts
  'wall', // → objects/wall.ts
  'shelves', // → objects/bookshelf.ts
  'bed_frame', // → objects/bed.ts
]);

/**
 * The full file list of public/models/kaykit_dungeon/*.glb (basename, no ext).
 * Kept as a literal list (rather than a runtime dir scan) so the catalog is
 * static + tree-shakeable and the build never depends on the filesystem at boot.
 * Mirror this if the pack changes; the helper below derives name + category.
 */
const GLB_FILES = [
  'banner_blue', 'banner_red',
  'barrel_large', 'barrel_small', 'barrel_small_stack',
  'barrier', 'barrier_corner',
  'bed_decorated', 'bed_frame',
  'bottle_A_green', 'bottle_B_brown',
  'box_large', 'box_small', 'box_stacked',
  'candle_lit', 'candle_triple',
  'chair',
  'chest', 'chest_gold',
  'coin_stack_large', 'coin_stack_medium',
  'column',
  'crates_stacked',
  'floor_dirt_large', 'floor_foundation_allsides', 'floor_tile_grate',
  'floor_tile_large', 'floor_tile_small', 'floor_tile_small_decorated', 'floor_wood_large',
  'keyring_hanging',
  'pillar', 'pillar_decorated',
  'plate_stack',
  'rubble_half', 'rubble_large',
  'shelf_large', 'shelf_small', 'shelf_small_candles', 'shelves',
  'stairs', 'stairs_narrow', 'stairs_walled', 'stairs_wide',
  'sword_shield',
  'table_long', 'table_long_tablecloth', 'table_medium', 'table_small',
  'torch', 'torch_lit', 'torch_mounted',
  'wall', 'wall_Tsplit', 'wall_arched', 'wall_archedwindow_open', 'wall_broken',
  'wall_corner', 'wall_corner_small', 'wall_crossing', 'wall_doorway',
  'wall_doorway_sides', 'wall_endcap', 'wall_gated', 'wall_half',
  'wall_pillar', 'wall_window_open',
] as const;

/**
 * Bucket a GLB into a category from its filename prefix. Ordered most-specific to
 * least so e.g. `shelf_*` (Furniture) is decided before a generic fallback.
 */
function categoryOf(file: string): Category {
  // STRUCTURE: the built shell of the dungeon — walls, floors, stairs, pillars, barriers.
  if (
    file.startsWith('wall') ||
    file.startsWith('floor') ||
    file.startsWith('stairs') ||
    file.startsWith('pillar') ||
    file === 'column' ||
    file.startsWith('barrier')
  ) {
    return 'Structure';
  }
  // FURNITURE: things placed in a room you sit/sleep/work at.
  if (
    file.startsWith('table') ||
    file === 'chair' ||
    file.startsWith('bed') ||
    file.startsWith('shelf') ||
    file === 'shelves' ||
    file.startsWith('bench')
  ) {
    return 'Furniture';
  }
  // CONTAINERS: holdable storage props.
  if (
    file.startsWith('barrel') ||
    file.startsWith('crate') ||
    file.startsWith('box') ||
    file.startsWith('chest')
  ) {
    return 'Containers';
  }
  // DECOR: everything else (candles, banners, bottles, plates, coins, books, swords,
  // rubble, keyrings, torches, rugs). The catch-all so no GLB is ever left out.
  return 'Decor';
}

/** Pretty display name from a filename: split on `_`, Title-Case, keep single
 *  uppercase letters (A/B model suffixes) as-is. e.g. `wall_archedwindow_open` →
 *  "Wall Archedwindow Open"; `bottle_A_green` → "Bottle A Green". */
function nameOf(file: string): string {
  return file
    .split('_')
    .map((part) => {
      if (part.length === 0) return part;
      if (part.length === 1) return part.toUpperCase(); // A / B variant letters
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

/** Catalog id for a GLB (prefixed so it can't collide with a hand-made objects/<id>.ts). */
export function catalogId(file: string): string {
  return `kk-${file}`;
}

/** The category of a catalog entry by its id (so the lab can group without re-deriving). */
const _categoryById = new Map<string, Category>();

/** Build the one WorldObject for a GLB: a single `default` variant, no re-skin,
 *  scale 0.5, auto-fit footprint — the model's own materials, untouched. */
function catalogObject(file: string): WorldObject {
  return meshObject({
    meshUrl: `models/kaykit_dungeon/${file}.glb`,
    name: nameOf(file),
    describe: `KayKit dungeon pack mesh (${file}.glb), shown with its own materials. Footprint auto-fitted by box-fit.`,
    level: 'object',
    scale: 0.5, // KayKit native units → game metres (matches the hand-made meshObjects)
    variants: {
      default: [], // no retexture rules → keep the GLB's authored materials
    },
  });
}

/**
 * The generated catalog: { id → WorldObject } for every KayKit GLB NOT already
 * covered by a hand-made objects/*.ts. Categories are recorded alongside in
 * `kaykitCategories` so the picker can group rows.
 */
export const kaykitObjects: Record<string, WorldObject> = {};
/** id → Category for every entry in `kaykitObjects` (for the grouped side list). */
export const kaykitCategories: Record<string, Category> = {};

for (const file of GLB_FILES) {
  if (COVERED_BY_HANDMADE.has(file)) continue;
  const id = catalogId(file);
  const cat = categoryOf(file);
  kaykitObjects[id] = catalogObject(file);
  kaykitCategories[id] = cat;
  _categoryById.set(id, cat);
}

/** Look up a catalog entry's category (undefined for a non-catalog id). */
export function categoryForId(id: string): Category | undefined {
  return _categoryById.get(id);
}
