// ============================================================================
// src/render/materials.ts — REAL tiling PBR materials for the dungeon (view-only).
// ============================================================================
//
// WHY THIS EXISTS (the boss's #1 ask): the KayKit "Dungeon Remastered" GLBs do NOT
// ship stone/wood photo textures. Each model is UV-mapped onto a single shared
// PALETTE ATLAS — a grid of soft vertical GRADIENT swatches (grey for stone, brown
// for wood, gold/red/etc.). The geometry carries the shape; the "texture" is just a
// flat colour ramp. That is exactly why the earlier pass looked like "gradients in
// weird places" — it WAS gradients, straight from the source art, and a procedural
// normal map bolted on top only added faint bumps to a flat ramp.
//
// THE FIX: replace those gradient materials with genuine CC0 *tileable* PBR sets
// (albedo + normal + roughness, downloaded to public/textures/), assigned BY MATERIAL
// CLASS (stone / floor-stone / wood / metal / gold). KayKit's atlas UVs are useless
// for tiling a real texture (they all point at one swatch), so we DON'T use them: a
// tiny onBeforeCompile patch re-derives UVs from WORLD-SPACE position (box/planar
// projection). A wall then reads as real masonry, a chest as real planks, a sword as
// worn metal — at a fixed world scale — no matter how the mesh was originally unwrapped.
//
// VIEW-ONLY: nothing here touches the sim. The material a mesh gets is a pure function
// of its (classified) material name, so every peer paints the identical dungeon.
// ============================================================================

import * as THREE from 'three';

const TEX_DIR = 'textures/';

/** A material CLASS — what the surface should physically read as. */
export type SurfaceKind = 'stone' | 'floor' | 'wood' | 'metal' | 'gold' | 'flame';

/** Texture-set filenames per class (albedo / normal-GL / roughness). `nor: null` = no normal
 *  map (the derivative tangent-frame on KayKit's untangented, non-uniformly-scaled wall boxes
 *  blows up at grazing / back-lit angles and renders the surface PURE BLACK — see `stone`). */
interface TexSet {
  diff: string;
  nor: string | null;
  rough: string;
  /** World units one texture tile spans (so masonry/plank scale reads physical, not stretched). */
  worldScale: number;
  /** base metalness (overridden to 1 for metal/gold; no metal map in the CC0 sets we ship). */
  metalness: number;
  /** roughness multiplier on the sampled roughness map. */
  roughness: number;
  /** optional albedo tint (gold reuses the metal texture tinted warm). */
  tint?: number;
}

const SETS: Record<Exclude<SurfaceKind, 'flame'>, TexSet> = {
  // medieval stone blocks — walls, pillars, stairs, doorways.
  // NO normal map ON PURPOSE: walls are tall vertical boxes (non-uniformly scaled ×2 in
  // length, no vertex tangents). The standard derivative-based TBN for a tangent-space
  // normal map degenerates on those faces at grazing / back-lit angles (the camera at a
  // dungeon EDGE looks along the near-edge-on -Z wall faces), producing a NaN shading
  // normal that renders the whole wall PURE BLACK and even swallows emissive — the
  // "flickering black squares that vanish when you pan" bug. Albedo + roughness alone
  // read as real masonry; the bump was only "a touch" of relief at the play camera anyway.
  stone: { diff: 'stone_diff.jpg', nor: null, rough: 'stone_rough.jpg', worldScale: 4.0, metalness: 0, roughness: 0.95 },
  // cobblestone — the floor underfoot (denser tiling so cells read as paved)
  floor: { diff: 'floor_diff.jpg', nor: 'floor_nor.jpg', rough: 'floor_rough.jpg', worldScale: 3.2, metalness: 0, roughness: 1.0 },
  // wood planks — chests, tables, barrels, shelves, doors, crates
  wood: { diff: 'wood_diff.jpg', nor: 'wood_nor.jpg', rough: 'wood_rough.jpg', worldScale: 1.6, metalness: 0, roughness: 0.8 },
  // worn rusty iron — swords/shields, metal fittings
  metal: { diff: 'metal_diff.jpg', nor: 'metal_nor.jpg', rough: 'metal_rough.jpg', worldScale: 1.2, metalness: 0.9, roughness: 0.55 },
  // gold reuses the metal microsurface, tinted warm + full metalness (treasure/coins)
  gold: { diff: 'metal_diff.jpg', nor: 'metal_nor.jpg', rough: 'metal_rough.jpg', worldScale: 1.2, metalness: 1.0, roughness: 0.32, tint: 0xffd24a },
};

/**
 * Classify a mesh material/name into a SurfaceKind. KayKit names every dungeon material
 * "texture" (the shared atlas), so we mostly fall back to the TILE NAME the caller passes
 * (which is reliable: 'wall' → stone, 'chest' → wood, 'sword_shield' → metal, …). The
 * material/mesh name is consulted first for the rare model that names a sub-part (e.g. a
 * gold rim) so we can pick metal/gold for just that piece.
 */
export function classifySurface(tileKey: string, matName: string, meshName: string): SurfaceKind {
  const n = (matName + ' ' + meshName).toLowerCase();
  const k = tileKey.toLowerCase();
  // LIGHT SOURCES first (torch / candle): keep KayKit's material so the emissive-flame
  // boost in dungeon.ts can light them — a stone/wood swap would kill the glow + bloom.
  if (/torch|candle/.test(k) || /flame|fire|ember/.test(n)) return 'flame';
  // explicit sub-part hints win (gold trim, metal blade)
  if (/gold|coin|treasure/.test(n) || /gold|coin/.test(k)) return 'gold';
  if (/metal|iron|steel|blade|sword|shield|key/.test(n)) return 'metal';

  // otherwise classify by the TILE this mesh belongs to.
  if (/floor/.test(k)) return 'floor';
  if (/wall|pillar|stair|doorway|rubble|column/.test(k)) return 'stone';
  if (/sword|shield|key|coin/.test(k)) return 'metal';
  if (/chest|gold/.test(k)) return /gold/.test(k) ? 'gold' : 'wood';
  // wooden furniture & containers
  if (/barrel|crate|box|table|chair|shelf|shelves|bed|bottle|plate|banner|candle/.test(k)) return 'wood';
  // default structural surfaces to stone (safe for the dungeon shell)
  return 'stone';
}

/**
 * Loads + caches the CC0 PBR texture sets and hands out tiling MeshStandardMaterials by
 * SurfaceKind. World-space (box/planar) UV projection is injected so the tiling scale is
 * physical regardless of the model's original (atlas) UVs. Built once, shared across the
 * whole dungeon (materials are reused per kind; the world-UV patch needs no per-mesh data).
 */
export class DungeonMaterials {
  private readonly loader = new THREE.TextureLoader();
  private readonly cache = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
  private loaded = false;

  /** Preload every texture set (await before building the dungeon). */
  async load(): Promise<void> {
    if (this.loaded) return;
    const kinds = Object.keys(SETS) as Exclude<SurfaceKind, 'flame'>[];
    await Promise.all(kinds.map((k) => this.buildSet(k)));
    this.loaded = true;
  }

  private async buildSet(kind: Exclude<SurfaceKind, 'flame'>): Promise<void> {
    const s = SETS[kind];
    const [diff, nor, rough] = await Promise.all([
      this.loadTex(s.diff, true),
      s.nor ? this.loadTex(s.nor, false) : Promise.resolve(null),
      this.loadTex(s.rough, false),
    ]);
    const mat = new THREE.MeshStandardMaterial({
      map: diff,
      roughnessMap: rough,
      roughness: s.roughness,
      metalness: s.metalness,
    });
    if (nor) {
      mat.normalMap = nor;
      // a touch of normal so chunky stone/wood relief reads under the key light
      mat.normalScale.set(1.0, 1.0);
    }
    if (s.tint !== undefined) mat.color.setHex(s.tint);
    // WORLD-SPACE TILING: re-derive UVs from world position so the texture tiles at a
    // PHYSICAL scale (worldScale u per tile) and ignores KayKit's atlas-swatch UVs.
    this.patchWorldUv(mat, s.worldScale);
    this.cache.set(kind, mat);
  }

  private loadTex(file: string, srgb: boolean): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        TEX_DIR + file,
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.needsUpdate = true;
          resolve(t);
        },
        undefined,
        reject,
      );
    });
  }

  /**
   * Inject a TRIPLANAR-ish world-UV into the standard shader. We pick the projection
   * plane per-fragment from the geometry normal (XZ for up/down faces, Xded for the two
   * vertical directions), scale world position by 1/worldScale, and feed that as the UV
   * for ALL maps (albedo/normal/roughness). This makes the real stone/wood tile across
   * the box faces of KayKit geometry at a fixed physical size — the masonry never
   * stretches or smears the way the atlas swatch did. View-only; deterministic.
   */
  private patchWorldUv(mat: THREE.MeshStandardMaterial, worldScale: number): void {
    const inv = 1 / worldScale;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms['uWorldUvScale'] = { value: inv };

      // WORLD-PLANAR UV IN THE VERTEX SHADER. `onBeforeCompile` hands us the shader with
      // `#include <...>` directives STILL UNEXPANDED, so chunk-body string edits don't work;
      // instead we OVERWRITE each map's UV varying (vMapUv / vRoughnessMapUv / vNormalMapUv /
      // vUv) right after <project_vertex> with a box-projected WORLD UV: pick the plane from
      // the dominant axis of the world normal, then scale the other two world axes by
      // 1/worldScale. Feeding the SAME world UV to every map (and to vUv, which the
      // tangent-space-normal TBN derives from) makes albedo + roughness + normal all tile
      // together at a fixed PHYSICAL scale — independent of the model's (atlas-swatch) UVs
      // AND of any non-uniform mesh scale (e.g. the stretched stairs / double-length walls),
      // because the UV comes from world position, computed after the model transform.
      // KayKit tiles are axis-aligned boxes, so per-vertex face classification is exact.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWorldUvScale;')
        .replace(
          '#include <project_vertex>',
          [
            '#include <project_vertex>',
            '{',
            '  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz * uWorldUvScale;',
            '  vec3 wn = abs(normalize(mat3(modelMatrix) * objectNormal));',
            '  vec2 wuv = (wn.y >= wn.x && wn.y >= wn.z) ? wp.xz : (wn.x >= wn.z ? wp.zy : wp.xy);',
            '  #ifdef USE_MAP',
            '    vMapUv = wuv;',
            '  #endif',
            '  #ifdef USE_ROUGHNESSMAP',
            '    vRoughnessMapUv = wuv;',
            '  #endif',
            '  #ifdef USE_NORMALMAP',
            '    vNormalMapUv = wuv;',
            '  #endif',
            '  #ifdef USE_UV',
            '    vUv = wuv;',
            '  #endif',
            '}',
          ].join('\n'),
        );
    };
    // changing the program key forces a recompile with our injected chunks
    mat.customProgramCacheKey = () => 'worldUv' + worldScale.toFixed(3);
  }

  /** The shared tiling material for a SurfaceKind (null for 'flame' — keep KayKit emissive). */
  get(kind: SurfaceKind): THREE.MeshStandardMaterial | null {
    if (kind === 'flame') return null;
    return this.cache.get(kind) ?? null;
  }
}
