// ============================================================================
// src/lab/retexture.ts — COLOR-KEYED RETEXTURE (re-skin one palette swatch).
// ============================================================================
//
// ⚠ LEGACY for the lab. Lab assets are now colored by recolor.ts (per-pixel, gradient-
// preserving) — see src/lab/CLAUDE.md (authoritative). The game path (src/render/dungeon.ts)
// colors via recolor.ts too, so this file is kept ONLY for the `RetextureRule`/`MaterialSpec`
// types still used by MeshObjectSpec.variants, and `presentSwatchHexes` (the legend's "present"
// sampler). Don't add new lab coloring logic here.
//
// THE USER'S EXACT ASK: "change ONLY the things that are one colour, to another
// material/metalness." KayKit dungeon meshes are UV-mapped onto a single shared
// PALETTE ATLAS — a grid of flat vertical-gradient SWATCHES (grey stone, brown wood,
// gold, red…). A chest's lid band points at the gold swatch; its body at the wood
// swatch; the lock at the metal swatch. So "recolour the gold parts" = "find every
// triangle whose atlas colour is nearest the gold swatch, and give those triangles a
// new material."
//
// HOW (per object, at lab-load — floats fine):
//   1. Draw the atlas image to a canvas once, getImageData → a sampler.
//   2. For each triangle: average its 3 UVs → centroid UV → sample the atlas → its
//      base colour. Match to the NEAREST rule `from` colour (sRGB distance). If the
//      nearest is within tolerance, that triangle joins that rule's GROUP; else it
//      keeps the original material.
//   3. Re-emit the geometry as ONE non-indexed BufferGeometry split into geometry
//      GROUPS (one per rule + one "unchanged"), with a parallel material array. Each
//      rule's MaterialSpec becomes a MeshStandardMaterial (flat albedo OR a tiling
//      PBR set from materials.ts, with roughness/metalness) — so a rule can say
//      "gold swatch → metallic gold" or "grey swatch → stone PBR."
//
// VIEW-ONLY + deterministic: same mesh + same rules → same split, every run.
// ============================================================================

import * as THREE from 'three';
import { DungeonMaterials, type SurfaceKind } from '../render/materials.ts';
import { SWATCHES } from './palette.ts';

/** What a matched swatch becomes: a flat albedo, OR a tiling PBR class, + surface knobs. */
export interface MaterialSpec {
  /** Flat albedo colour (hex). Used when `pbr` is absent. */
  color?: number;
  /** Reuse a real tiling PBR set from materials.ts (stone/wood/metal/gold/floor). */
  pbr?: Exclude<SurfaceKind, 'flame'>;
  /** Override roughness (0..1). */
  roughness?: number;
  /** Override metalness (0..1) — the "to metallic gold" knob. */
  metalness?: number;
  /** Optional emissive (hex) for glowing parts. */
  emissive?: number;
  emissiveIntensity?: number;
}

/** "Recolour every triangle whose atlas colour is nearest `from` → `to`." */
export interface RetextureRule {
  /** A palette-swatch colour (hex) to target — the colour the part currently reads as. */
  from: number;
  /** The material to give matched triangles. */
  to: MaterialSpec;
}

export interface RetextureOpts {
  /**
   * Max sRGB distance (0..~441) for a triangle to count as matching a rule (default 70). THIS IS
   * THE WHOLE MODEL: each triangle is coloured SOLELY by its previous atlas colour — it takes the
   * material of the nearest rule within `tolerance`, otherwise it keeps its original atlas colour.
   * Nothing reassigns or dissolves it afterwards, so distinct-coloured parts stay distinct (a
   * banner's grey pegs → stone, its red flag → cloth) and true accents the theme doesn't map (a
   * green bottle) keep their colour. A theme passes a generous tolerance so the structural greys
   * all land on stone; a variant-only re-skin passes a tight one to recolour just its target part.
   */
  tolerance?: number;
  /** Shared DungeonMaterials (so PBR sets load once); created+loaded if omitted. */
  materials?: DungeonMaterials;
  /** How PBR materials tile: 'classic' (default) = single-plane world UV + normal map
   *  (cohesive/sharp — the boxy shell + flat props); 'triplanar' = 3-axis blend (round
   *  props: barrels/coins, no single-plane stretch). Choose per object (see isCurvedProp). */
  projection?: 'classic' | 'triplanar';
}

/** A cache of atlas image → sampler, keyed by the texture's uuid (atlas is shared). */
const samplerCache = new Map<string, AtlasSampler>();

/** Samples an atlas image's base colour at a UV (draws to a canvas once). */
class AtlasSampler {
  private readonly w: number;
  private readonly h: number;
  private readonly data: Uint8ClampedArray;
  constructor(image: TexImageSource & { width: number; height: number }) {
    this.w = image.width; this.h = image.height;
    const canvas = document.createElement('canvas');
    canvas.width = this.w; canvas.height = this.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image as CanvasImageSource, 0, 0);
    this.data = ctx.getImageData(0, 0, this.w, this.h).data;
  }
  /** Sample sRGB [r,g,b] (0..255) at a UV (wraps; canvas row 0 = atlas top).
   *  NO v-flip: glTF textures load with flipY=false, so UV v=0 is the TOP of the image
   *  — the same row a 2D-canvas getImageData() returns first. (Flipping here silently
   *  mis-read every triangle — e.g. brown planks sampled as the pink swatch — and only
   *  "worked" on greys because grey appears at many atlas rows. Verified by sampling real
   *  GLB triangle UVs: no-flip makes coins→gold, chest planks→wood, sword→metal.) */
  sample(u: number, v: number): [number, number, number] {
    const fx = ((u % 1) + 1) % 1;
    const fy = ((v % 1) + 1) % 1;
    const x = Math.min(this.w - 1, Math.floor(fx * this.w));
    const y = Math.min(this.h - 1, Math.floor(fy * this.h));
    const i = (y * this.w + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }
}

/** Build a sampler for a mesh's base-colour texture (cached by image). */
function samplerFor(map: THREE.Texture | null): AtlasSampler | null {
  if (!map || !map.image) return null;
  const key = map.uuid;
  const cached = samplerCache.get(key);
  if (cached) return cached;
  const img = map.image as TexImageSource & { width: number; height: number };
  if (!img.width || !img.height) return null;
  const s = new AtlasSampler(img);
  samplerCache.set(key, s);
  return s;
}

function srgbDist(a: [number, number, number], r: number, g: number, b: number): number {
  const dr = a[0] - r, dg = a[1] - g, db = a[2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Turn a MaterialSpec into a MeshStandardMaterial (flat albedo or tiling PBR).
 *  `projection` picks how the PBR tiles: 'classic' = single-plane world UV + normal map
 *  (cohesive, sharp on flat/boxy faces — the dungeon shell & flat props); 'triplanar' =
 *  3-axis blend (no stretch on round faces — barrels/coins). See materials.ts get/getProp. */
function specToMaterial(spec: MaterialSpec, mats?: DungeonMaterials, projection: 'classic' | 'triplanar' = 'classic'): THREE.MeshStandardMaterial {
  // PBR path: return a SHARED cached material from DungeonMaterials — NEVER clone (a clone of a
  // material whose onBeforeCompile injected the world-UV shader reuses the cached program and
  // skips the injection → the projection collapses and the surface reads as bare faceted
  // geometry). Untinted → get()/getProp(); tinted → getTinted() builds the variant fresh.
  if (spec.pbr && mats) {
    const needsOverride = spec.color !== undefined || spec.roughness !== undefined || spec.metalness !== undefined || spec.emissive !== undefined;
    const base = needsOverride
      ? mats.getTinted(spec.pbr, projection, spec)
      : (projection === 'triplanar' ? mats.getProp(spec.pbr) : mats.get(spec.pbr));
    if (base) return base;
  }
  // flat albedo (no pbr, or materials unavailable)
  const mat = new THREE.MeshStandardMaterial({ color: spec.color ?? 0x888888 });
  if (spec.color !== undefined) mat.color.setHex(spec.color);
  if (spec.roughness !== undefined) mat.roughness = spec.roughness;
  if (spec.metalness !== undefined) mat.metalness = spec.metalness;
  if (spec.emissive !== undefined) { mat.emissive = new THREE.Color(spec.emissive); mat.emissiveIntensity = spec.emissiveIntensity ?? 1; }
  return mat;
}

/**
 * Recolour `object` in place by atlas-colour rules. Each mesh is rebuilt as a single
 * non-indexed geometry split into per-rule groups; matched triangles get the rule's
 * material, unmatched keep the original. Returns the materials it created (so the
 * caller can dispose / inspect).
 *
 * `materials` lets a rule use a tiling PBR class; if any rule needs PBR and none is
 * supplied, a DungeonMaterials is created+loaded automatically (await-friendly).
 */
export async function retexture(
  object: THREE.Object3D,
  rules: RetextureRule[],
  opts: RetextureOpts = {},
): Promise<THREE.Material[]> {
  if (rules.length === 0) return [];
  const tol = opts.tolerance ?? 70;

  // Load PBR materials if any rule needs them and none was provided.
  let mats = opts.materials;
  if (!mats && rules.some((r) => r.to.pbr)) {
    mats = new DungeonMaterials();
    await mats.load();
  }

  // One material per DISTINCT spec (rules with the same `to` share an instance) — so a mesh
  // whose triangles all resolve to one material (the whole dungeon shell: every grey swatch →
  // the same stone/floor material) is detected as single-material and keeps its ORIGINAL
  // geometry (see the fast path below) instead of being rebuilt.
  const projection = opts.projection ?? 'classic';
  const matBySpec = new Map<string, THREE.MeshStandardMaterial>();
  const ruleMats = rules.map((r) => {
    const key = JSON.stringify(r.to);
    let m = matBySpec.get(key);
    if (!m) { m = specToMaterial(r.to, mats, projection); matBySpec.set(key, m); }
    return m;
  });
  const created: THREE.Material[] = [...matBySpec.values()];
  const meshes: THREE.Mesh[] = [];
  object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m); });

  for (const mesh of meshes) {
    const orig = mesh.material as THREE.Material;
    const map = (orig as THREE.MeshStandardMaterial).map ?? null;
    const sampler = samplerFor(map);
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const index = geo.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;

    // Classify each triangle SOLELY by its previous atlas colour → the nearest rule WITHIN `tol`
    // (else -1 = keep the original atlas material). No reassignment/dissolution afterwards, so a
    // part's material is a pure function of its own colour — distinct parts stay distinct.
    const triRule = new Int8Array(triCount).fill(-1);
    if (sampler && uv) {
      const tmp = new THREE.Vector2();
      for (let t = 0; t < triCount; t++) {
        const ia = index ? index.getX(t * 3) : t * 3;
        const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        let cu = 0, cv = 0;
        for (const i of [ia, ib, ic]) { tmp.fromBufferAttribute(uv, i); cu += tmp.x; cv += tmp.y; }
        const [r, g, b] = sampler.sample(cu / 3, cv / 3);
        let best = -1, bestD = tol;
        for (let ri = 0; ri < rules.length; ri++) {
          const c = rules[ri]!.from;
          const d = srgbDist([(c >> 16) & 255, (c >> 8) & 255, c & 255], r, g, b);
          if (d < bestD) { bestD = d; best = ri; }
        }
        triRule[t] = best;
      }
    }

    // FAST PATH — one material covers the whole mesh → keep the ORIGINAL geometry, don't
    // rebuild it. Rebuilding to non-indexed groups subtly changes shading (the floor's relief
    // then reads as faceted hexagons instead of the cobble normal-map detail); a single-material
    // mesh (the entire dungeon SHELL) never needs splitting, so we just assign the material and
    // keep the model's original normals/UVs = the cohesive classic look.
    let single: THREE.Material | null | undefined;
    let isSingle = true;
    for (let t = 0; t < triCount; t++) {
      const ri = triRule[t]!;
      const m = ri < 0 ? orig : ruleMats[ri]!;
      if (single === undefined) single = m;
      else if (single !== m) { isSingle = false; break; }
    }
    if (isSingle && single) { mesh.material = single; continue; }

    // MULTI-MATERIAL — split into per-material groups on a rebuilt non-indexed geometry.
    // Group order: ruleMats[0..n-1] then the original material last.
    const order: number[] = []; // triangle indices grouped
    const groupSizes = new Array(rules.length + 1).fill(0);
    for (let g = 0; g < rules.length; g++) for (let t = 0; t < triCount; t++) if (triRule[t] === g) { order.push(t); groupSizes[g]++; }
    for (let t = 0; t < triCount; t++) if (triRule[t] === -1) { order.push(t); groupSizes[rules.length]++; }

    const out = new THREE.BufferGeometry();
    const op = new Float32Array(order.length * 9);
    const on = nor ? new Float32Array(order.length * 9) : null;
    const ou = uv ? new Float32Array(order.length * 6) : null;
    const va = new THREE.Vector3();
    for (let k = 0; k < order.length; k++) {
      const t = order[k]!;
      const verts = index
        ? [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]
        : [t * 3, t * 3 + 1, t * 3 + 2];
      for (let j = 0; j < 3; j++) {
        const vi = verts[j]!;
        va.fromBufferAttribute(pos, vi);
        op[k * 9 + j * 3] = va.x; op[k * 9 + j * 3 + 1] = va.y; op[k * 9 + j * 3 + 2] = va.z;
        if (on && nor) { va.fromBufferAttribute(nor, vi); on[k * 9 + j * 3] = va.x; on[k * 9 + j * 3 + 1] = va.y; on[k * 9 + j * 3 + 2] = va.z; }
        if (ou && uv) { const u = uv.getX(vi), v = uv.getY(vi); ou[k * 6 + j * 2] = u; ou[k * 6 + j * 2 + 1] = v; }
      }
    }
    out.setAttribute('position', new THREE.BufferAttribute(op, 3));
    if (on) out.setAttribute('normal', new THREE.BufferAttribute(on, 3));
    else out.computeVertexNormals();
    if (ou) out.setAttribute('uv', new THREE.BufferAttribute(ou, 2));

    // geometry groups (start, count are in VERTEX units) + material array
    let start = 0;
    const matArray: THREE.Material[] = [];
    for (let g = 0; g <= rules.length; g++) {
      const count = groupSizes[g] * 3;
      if (count === 0) continue;
      out.addGroup(start, count, matArray.length);
      matArray.push(g < rules.length ? ruleMats[g]! : orig);
      start += count;
    }
    mesh.geometry = out;
    mesh.material = matArray.length === 1 ? matArray[0]! : matArray;
  }
  return created;
}

/**
 * Sample every textured triangle's centroid colour and return the SET of palette swatch hexes the
 * model actually uses — so the lab legend can show WHICH colours are present in the current model
 * (not the whole 26-swatch palette). Call on the RAW model BEFORE retexture (re-skinned triangles
 * lose their atlas map). Same sampler + nearest-swatch match the theme uses, so it stays in sync.
 */
export function presentSwatchHexes(object: THREE.Object3D): Set<number> {
  const present = new Set<number>();
  const tmp = new THREE.Vector2();
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const sampler = samplerFor((Array.isArray(mat) ? mat[0] : mat)?.map ?? null);
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!sampler || !uv) return;
    const index = mesh.geometry.getIndex();
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      let cu = 0, cv = 0;
      for (let j = 0; j < 3; j++) {
        const vi = index ? index.getX(t * 3 + j) : t * 3 + j;
        tmp.fromBufferAttribute(uv, vi); cu += tmp.x; cv += tmp.y;
      }
      const [r, g, b] = sampler.sample(cu / 3, cv / 3);
      let best = SWATCHES[0]!.hex, bestD = Infinity;
      for (const sw of SWATCHES) {
        const c = sw.hex;
        const d = srgbDist([(c >> 16) & 255, (c >> 8) & 255, c & 255], r, g, b);
        if (d < bestD) { bestD = d; best = c; }
      }
      present.add(best);
    }
  });
  return present;
}
