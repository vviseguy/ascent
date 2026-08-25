// ============================================================================
// src/lab/one-sided.ts — a slab that is only there from the side it faces.
// ============================================================================
//
// A floor and a ceiling are the same 0.15-thick tile, one of them turned over (`CellPlacement.inverted`).
// That is the right model — one mesh, one material, normals carried round by the rotation — but it
// leaves both slabs visible from BOTH sides, and neither should be:
//
//   a FLOOR seen from the storey below   shows its underside, competing with the lid hung there
//   a CEILING seen from the storey above  shows its back, a slab lying on the deck of the room above
//
// In the editor with `all` storeys up, that is the difference between reading a section and looking at
// a stack of paving.
//
// NOT BACKFACE CULLING. `side: FrontSide` already culls backfaces, and it does nothing here: the tile
// is a solid slab whose top and bottom are both outward-facing, so both are front faces. What is
// wanted is not "drop the inside" but "drop the face pointing away from the room this tile belongs
// to", and only the WORLD NORMAL knows which that is.
//
// EDGES SURVIVE. The tile's rim has a horizontal normal, and it is what makes a floor read as a slab
// with thickness rather than a sheet of paper. Only faces pointing clearly the wrong way go, so the
// rim is kept by the same threshold that drops the back.

import * as THREE from 'three';

/** How far from horizontal a face must point before it counts as facing up or down. Generous, because
 *  a bevelled rim's normal tilts and the rim must survive. */
const FACING = 0.35;

/**
 * A copy of `src` that only draws the faces pointing the way this tile faces.
 *
 * `keepUp` is the tile's own orientation, not a preference: a floor keeps its upward faces, a ceiling
 * (which has been rotated onto its back) keeps its downward ones.
 *
 * ONE MATERIAL PER SOURCE PER SIDE, via `cache`. A floor and a ceiling of the same material share a
 * template, so patching in place would hide one of them everywhere; patching per instance would make a
 * material per tile on screen. The cache key carries the side for that reason.
 */
export function oneSided(
  src: THREE.Material, keepUp: boolean, cache: Map<string, THREE.Material>,
): THREE.Material {
  const key = `${src.uuid}|${keepUp ? 'up' : 'down'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const mat = src.clone();
  const sign = { value: keepUp ? 1 : -1 };
  const prev = mat.onBeforeCompile?.bind(mat);   // CHAIN: the tiling shader is already on here
  mat.onBeforeCompile = (shader, renderer): void => {
    prev?.(shader, renderer);
    shader.uniforms['uFaceSign'] = sign;
    shader.vertexShader = 'varying vec3 vFaceN;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      // the NORMAL MATRIX, not the model matrix: a normal is not a position, and under non-uniform
      // scale the two disagree. Every tile here is uniformly scaled, but relying on that is how a
      // scale added later breaks something nobody connects to this file.
      '#include <begin_vertex>\n  vFaceN = normalize(mat3(modelMatrix) * objectNormal);',
    );
    shader.fragmentShader = 'uniform float uFaceSign;\nvarying vec3 vFaceN;\n'
      + shader.fragmentShader.replace('void main() {', `void main() {
        // NO BACKTICKS IN HERE — this GLSL is a JS template literal and a stray one ends the string.
        if (vFaceN.y * uFaceSign < -${FACING}) discard;`);
  };
  // EXTEND the cache key, never replace it: the tiling shader sets one too, and dropping it lets two
  // materials that compile differently share one program.
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = (): string => `${prevKey?.() ?? ''}|1side${sign.value}`;
  mat.needsUpdate = true;
  cache.set(key, mat);
  return mat;
}

/** Apply it to every mesh under `node`. */
export function applyOneSided(
  node: THREE.Object3D, keepUp: boolean, cache: Map<string, THREE.Material>,
): void {
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = Array.isArray(m.material) ? m.material[0] : m.material;
    if (src) m.material = oneSided(src, keepUp, cache);
  });
}
