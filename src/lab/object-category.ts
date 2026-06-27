// ============================================================================
// src/lab/object-category.ts — dungeon object → CATEGORY (shared classifier).
// ============================================================================
//
// Buckets a KayKit dungeon model file into its grouping — Structure (walls/floors/stairs/pillars),
// Furniture (tables/beds/shelves), Containers (barrels/chests), or Decor. Two consumers share it
// so there's ONE source of truth (no circular import: this module imports nothing):
//   • kaykit-catalog.ts — the picker's level-2 grouping
//   • recolor.ts        — the CATEGORY layer of the swatch→preset cascade ("architecture" vs
//                         "furnishings" map materials differently — see src/lab/CLAUDE.md)
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

/** The clean model token: drop any leading subfolder and a `.gltf` infix (Dungeon Remastered ships
 *  `<name>.gltf.glb`, listed as `<name>.gltf`). */
export function cleanKey(file: string): string {
  const last = file.slice(file.lastIndexOf('/') + 1);
  return last.replace(/\.gltf$/i, '');
}

/** Dungeon family (legacy + remastered): the original Structure/Furniture/Containers/Decor. */
export function dungeonCategory(file: string): string {
  const k = cleanKey(file);
  if (/^(wall|floor|stair|pillar|barrier|arch|gate|foundation|scaffold|door)/.test(k) || k === 'column') return 'Structure';
  if (/^(table|chair|bed|shelf|shelves|bench|throne|stool)/.test(k)) return 'Furniture';
  if (/^(barrel|crate|box|chest|sack)/.test(k)) return 'Containers';
  return 'Decor';
}
