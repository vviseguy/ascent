// ============================================================================
// src/lab/retexture.ts — COLOR-KEYED RETEXTURE (re-skin one palette swatch).
// ============================================================================
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
  /** Max sRGB distance (0..~441) for a triangle to count as matching a rule. Default 70. */
  tolerance?: number;
  /** Shared DungeonMaterials (so PBR sets load once); created+loaded if omitted. */
  materials?: DungeonMaterials;
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
  /** Sample sRGB [r,g,b] (0..255) at a UV (wraps; v flipped to match GL convention). */
  sample(u: number, v: number): [number, number, number] {
    const fx = ((u % 1) + 1) % 1;
    const fy = ((v % 1) + 1) % 1;
    const x = Math.min(this.w - 1, Math.floor(fx * this.w));
    const y = Math.min(this.h - 1, Math.floor((1 - fy) * this.h)); // GL: v=0 is bottom
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

/** Turn a MaterialSpec into a MeshStandardMaterial (flat albedo or tiling PBR). */
function specToMaterial(spec: MaterialSpec, mats?: DungeonMaterials): THREE.MeshStandardMaterial {
  let mat: THREE.MeshStandardMaterial;
  if (spec.pbr && mats) {
    const base = mats.get(spec.pbr);
    mat = base ? (base.clone() as THREE.MeshStandardMaterial)
               : new THREE.MeshStandardMaterial({ color: spec.color ?? 0x888888 });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: spec.color ?? 0x888888 });
  }
  if (spec.color !== undefined && !spec.pbr) mat.color.setHex(spec.color);
  if (spec.color !== undefined && spec.pbr) mat.color.setHex(spec.color); // tint the PBR set
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

  const ruleMats = rules.map((r) => specToMaterial(r.to, mats));
  const created: THREE.Material[] = [...ruleMats];
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

    // classify each triangle → rule index (or -1 = keep original)
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
        // nearest rule within tolerance
        let best = -1, bestD = tol;
        for (let ri = 0; ri < rules.length; ri++) {
          const c = rules[ri]!.from;
          const d = srgbDist([(c >> 16) & 255, (c >> 8) & 255, c & 255], r, g, b);
          if (d < bestD) { bestD = d; best = ri; }
        }
        triRule[t] = best;
      }
    }

    // Build a non-indexed geometry, triangles SORTED by group: rule0, rule1, …, original.
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
