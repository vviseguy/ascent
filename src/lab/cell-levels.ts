// ============================================================================
// src/lab/cell-levels.ts — storey arithmetic on the editor's flat cell array.
// ============================================================================
//
// A multi-storey structure is stored as ONE array, level-major: storey `i` occupies
// `[i * size, (i+1) * size)`. That keeps every index calculation for level 0 exactly what it was
// before storeys existed, and keeps the saved format a plain list.
//
// These are the operations that MOVE a whole storey around, kept here and pure so they can be tested
// without a DOM. They exist because a multi-storey structure is mostly the SAME structure at two
// heights — a stairwell's shaft is the hole its flight climbs into, and the walls around it usually
// stand on both floors. Repainting the second copy by hand is slow and gets it subtly wrong, which is
// worse than slow: a shaft one cell out does not read as a mistake, it reads as a structure that does
// not work.
//
// EVERY COPY IS DEEP, and that is the whole reason this file is tested. `cells` holds objects, so a
// shallow slice leaves two storeys sharing field objects — paint one and the other changes under you.
// The symptom looks like a rendering fault rather than an aliasing one, which is a bad afternoon.
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

import type { CellField } from '../floor/cell-field.ts';

/** How many storeys a flat array of `size`-sized levels holds. */
export const levelCount = (cells: readonly CellField[], size: number): number =>
  size > 0 ? Math.floor(cells.length / size) : 0;

/** Storey `i`, DEEP-copied — safe to hand to another storey. */
export function sliceLevel(cells: readonly CellField[], size: number, i: number): CellField[] {
  return cells.slice(i * size, (i + 1) * size).map((f) => ({ ...f }));
}

/** `cells` with storey `i` replaced. The block is copied again on the way in, so the caller cannot
 *  accidentally keep a live reference into the array. */
export function putLevel(
  cells: readonly CellField[], size: number, i: number, block: readonly CellField[],
): CellField[] {
  const at = i * size;
  return [...cells.slice(0, at), ...block.map((f) => ({ ...f })), ...cells.slice(at + size)];
}

/** `cells` with a copy of storey `i` inserted directly ABOVE it. */
export function duplicateLevelAt(cells: readonly CellField[], size: number, i: number): CellField[] {
  const at = (i + 1) * size;
  return [...cells.slice(0, at), ...sliceLevel(cells, size, i), ...cells.slice(at)];
}

/** `cells` with storeys `a` and `b` exchanged. */
export function swapLevels(cells: readonly CellField[], size: number, a: number, b: number): CellField[] {
  if (a === b) return [...cells];
  const A = sliceLevel(cells, size, a), B = sliceLevel(cells, size, b);
  return putLevel(putLevel(cells, size, a, B), size, b, A);
}

/** `cells` with storey `i` replaced by whatever `blank()` makes. */
export function clearLevelAt(
  cells: readonly CellField[], size: number, i: number, blank: () => CellField,
): CellField[] {
  return putLevel(cells, size, i, Array.from({ length: size }, blank));
}
