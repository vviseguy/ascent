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

/** A material CLASS — what the surface should physically read as. `terracotta` and `cloth`
 *  are PROCEDURAL (canvas-generated, no files): plain neutral grains meant to be TINTED by a
 *  theme to match a colour (clay pots / bedding / banners). See genProcedural. */
export type SurfaceKind = 'stone' | 'floor' | 'wood' | 'metal' | 'gold' | 'terracotta' | 'cloth' | 'flame';

/** Texture-set filenames per class (albedo / normal-GL / roughness). `nor: null` = no normal
 *  map (the derivative tangent-frame on KayKit's untangented, non-uniformly-scaled wall boxes
 *  blows up at grazing / back-lit angles and renders the surface PURE BLACK — see `stone`). */
interface TexSet {
  diff: string;
  nor: string | null;
  rough: string;
  /** World units one texture tile spans (so masonry/plank scale reads physical, not stretched).
   *  Shared by BOTH the game path (get) and the prop/theme path (getProp): both project in
   *  WORLD space at this physical scale, so a prop tiles exactly like the dungeon shell. */
  worldScale: number;
  /** base metalness (overridden to 1 for metal/gold; no metal map in the CC0 sets we ship). */
  metalness: number;
  /** roughness multiplier on the sampled roughness map. */
  roughness: number;
  /** optional albedo tint (gold reuses the metal texture tinted warm). */
  tint?: number;
  /** PROCEDURAL set: generate the albedo+roughness on a canvas (no files). The grain is plain
   *  + NEUTRAL so a theme tint sets the colour (clay 'terracotta' / fabric 'cloth'). */
  procedural?: 'terracotta' | 'cloth';
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
  // cobblestone — the floor underfoot (committed scale; A/B baseline)
  floor: { diff: 'floor_diff.jpg', nor: 'floor_nor.jpg', rough: 'floor_rough.jpg', worldScale: 3.2, metalness: 0, roughness: 1.0 },
  // wood planks — chests, tables, barrels, shelves, doors, crates
  wood: { diff: 'wood_diff.jpg', nor: 'wood_nor.jpg', rough: 'wood_rough.jpg', worldScale: 1.6, metalness: 0, roughness: 0.8 },
  // worn rusty iron — swords/shields, metal fittings
  metal: { diff: 'metal_diff.jpg', nor: 'metal_nor.jpg', rough: 'metal_rough.jpg', worldScale: 1.2, metalness: 0.9, roughness: 0.55 },
  // gold reuses the metal microsurface, tinted warm + full metalness (treasure/coins)
  gold: { diff: 'metal_diff.jpg', nor: 'metal_nor.jpg', rough: 'metal_rough.jpg', worldScale: 1.2, metalness: 1.0, roughness: 0.32, tint: 0xffd24a },
  // PROCEDURAL, neutral + tintable (no files). terracotta = matte mottled clay (pots, tiles,
  // the copper/clay swatch); cloth = a fine woven fabric (bedding, banners, cushions). Both
  // ship NO tint — a theme tints them per swatch (e.g. `{ pbr: 'cloth', color: <bedding> }`).
  terracotta: { diff: '', nor: null, rough: '', worldScale: 1.1, metalness: 0, roughness: 0.82, procedural: 'terracotta' },
  cloth: { diff: '', nor: null, rough: '', worldScale: 0.45, metalness: 0, roughness: 0.9, procedural: 'cloth' },
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

// ---- procedural (canvas) texture sets — plain, neutral, tintable ----------------------------
// terracotta + cloth ship no files: we paint a small tileable grain so a theme can TINT them to
// any colour (clay pots, fabric bedding/banners). Seeded so every reload/peer paints identical.

/** Tiny deterministic PRNG (mulberry32) — keeps the generated grain stable across reloads. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Make a tileable CanvasTexture from a per-pixel painter (size×size). */
function canvasTex(size: number, srgb: boolean, paint: (ctx: CanvasRenderingContext2D, rnd: () => number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  paint(ctx, mulberry(0x9e3779b1));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Generate the albedo + roughness for a procedural set. NEUTRAL base (~mid-grey) so a theme
 *  tint multiplies to the target colour; only the GRAIN (weave / clay mottle) carries detail. */
function genProcedural(kind: 'terracotta' | 'cloth'): { diff: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const S = 256;
  const diff = canvasTex(S, true, (ctx, rnd) => {
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, S, S);
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    if (kind === 'cloth') {
      // BASKET WEAVE: 4px threads, over/under by cell parity → a fine fabric; + faint noise.
      const cell = 4;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const over = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
        const along = over ? (x % cell) : (y % cell);            // shade across the thread width
        const shade = 14 * Math.sin((along / cell) * Math.PI) - 7 + (over ? 8 : -10);
        const n = (rnd() - 0.5) * 10;
        const i = (y * S + x) * 4; const v = 200 + shade + n;
        d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v));
      }
    } else {
      // TERRACOTTA: smooth low-frequency clay mottle + a little fine speckle. Start from a noise
      // field, box-blur it (cheap), then speckle — reads as matte fired clay once tinted.
      const base = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) base[i] = rnd();
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let sum = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          sum += base[(((y + dy + S) % S) * S) + ((x + dx + S) % S)]!;
        }
        const mottle = (sum / 49 - 0.5) * 46;          // soft blotches
        const speckle = rnd() < 0.04 ? -22 * rnd() : 0; // sparse darker pores
        const i = (y * S + x) * 4; const v = 202 + mottle + speckle;
        d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v));
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  // roughness: near-white (so roughnessMap.g≈1, the SET's roughness scalar drives it) + micro-noise.
  const rough = canvasTex(S, false, (ctx, rnd) => {
    const img = ctx.createImageData(S, S); const d = img.data;
    for (let i = 0; i < S * S; i++) { const v = 226 + (rnd() - 0.5) * 24; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  });
  return { diff, rough };
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
  /** PROP variants (world-space TRIPLANAR) — see getProp. Built alongside the world set. */
  private readonly propCache = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
  /** The loaded texture set per kind, so TINTED variants can be built fresh (not cloned). */
  private readonly tex = new Map<Exclude<SurfaceKind, 'flame'>, { diff: THREE.Texture; nor: THREE.Texture | null; rough: THREE.Texture }>();
  /** Cache of theme-TINTED variants, keyed by kind|projection|override — built fresh (a clone
   *  would drop the onBeforeCompile world-UV shader; see specToMaterial in retexture.ts). */
  private readonly tinted = new Map<string, THREE.MeshStandardMaterial>();
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
    let diff: THREE.Texture, nor: THREE.Texture | null, rough: THREE.Texture;
    if (s.procedural) {
      // PROCEDURAL set — generate a plain, neutral, tileable grain on a canvas (no files).
      ({ diff, rough } = genProcedural(s.procedural));
      nor = null;
    } else {
      [diff, nor, rough] = await Promise.all([
        this.loadTex(s.diff, true),
        s.nor ? this.loadTex(s.nor, false) : Promise.resolve(null),
        this.loadTex(s.rough, false),
      ]);
    }
    this.tex.set(kind, { diff, nor, rough });
    // CLASSIC (single-plane world UV + normal map) — the cohesive dungeon shell + flat props.
    this.cache.set(kind, this.buildMaterial(kind, 'classic'));
    // PROP TRIPLANAR (3-axis blend, whiteout normal) — ROUND props only (barrels/coins; see
    // isCurvedProp), so a curved face never smears the way single-plane does.
    this.propCache.set(kind, this.buildMaterial(kind, 'triplanar'));
  }

  /** Material override knobs a theme applies on top of a kind's texture set. */
  private buildMaterial(
    kind: Exclude<SurfaceKind, 'flame'>,
    projection: 'classic' | 'triplanar',
    o?: { color?: number; roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number },
  ): THREE.MeshStandardMaterial {
    const s = SETS[kind];
    const t = this.tex.get(kind)!;
    const mat = new THREE.MeshStandardMaterial({
      map: t.diff,
      roughnessMap: t.rough,
      roughness: o?.roughness ?? s.roughness,
      metalness: o?.metalness ?? s.metalness,
    });
    const tint = o?.color ?? s.tint; // theme tint wins; else gold's warm tint; else none
    if (tint !== undefined) mat.color.setHex(tint);
    if (o?.emissive !== undefined) { mat.emissive = new THREE.Color(o.emissive); mat.emissiveIntensity = o.emissiveIntensity ?? 1; }
    if (t.nor) { mat.normalMap = t.nor; mat.normalScale.set(1, 1); }
    // WORLD-SPACE TILING (physical scale, ignores the atlas UVs). onBeforeCompile applied to
    // THIS fresh material (never via clone — a clone reuses the cached program and skips the
    // injection, collapsing the projection). classic = single-plane; triplanar = 3-axis blend.
    if (projection === 'triplanar') this.patchWorldTriplanar(mat, s.worldScale, !!t.nor);
    else this.patchWorldUv(mat, s.worldScale);
    return mat;
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
    // Bake the scale as a GLSL LITERAL (not a uniform): a custom uniform added in
    // onBeforeCompile is LOST when the material is cloned (three reuses the cached program and
    // skips re-running onBeforeCompile, so the clone never binds the uniform → the projection
    // collapses and the surface reads as bare faceted geometry). A literal travels with the
    // program, so clones (theme tints, per-cell copies) render identically. See retexture.ts.
    const k = (1 / worldScale).toFixed(6);
    mat.onBeforeCompile = (shader) => {
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
        .replace(
          '#include <project_vertex>',
          [
            '#include <project_vertex>',
            '{',
            `  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz * ${k};`,
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

  /**
   * Inject WORLD-SPACE TRIPLANAR tiling — the realistic projection the game's columns use
   * (patchWorldUv), upgraded from single-plane to a 3-axis blend. patchWorldUv picks ONE
   * plane per fragment from the dominant world-normal axis; that reads great on the dungeon
   * shell (axis-aligned wall/column/stair boxes) but SMEARS on any face that isn't axis-
   * aligned — a barrel's staves, a chest's domed lid, a coin's bevels. Triplanar blends all
   * three world-axis projections weighted by the (squared) world normal, so an angled face
   * is a smooth mix of two planes instead of one stretched one. Same WORLD space + same
   * `worldScale` as the game, so a prop tiles at the identical physical size as the shell
   * (physically consistent, not relative-to-object). When `withNormal`, the normal map is
   * applied via a TRIPLANAR WHITEOUT BLEND (sample the tangent-space normal on all 3 world
   * planes, fold each into the world geometric normal, blend, convert to view space) — so the
   * bump survives WITHOUT the derivative TBN that degenerates on these untangented meshes.
   * View-only; deterministic. Only ROUND props use this (isCurvedProp); the boxy shell keeps
   * the sharper classic single-plane get().
   */
  private patchWorldTriplanar(mat: THREE.MeshStandardMaterial, worldScale: number, withNormal: boolean): void {
    const k = (1 / worldScale).toFixed(6); // baked literal (survives cloning; see patchWorldUv)
    mat.onBeforeCompile = (shader) => {
      // VERTEX: carry WORLD position (scaled by 1/worldScale) + WORLD normal to the fragment.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNor;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>\n  vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz * ${k};\n  vTriNor = normalize(mat3(modelMatrix) * objectNormal);`,
        );
      // FRAGMENT: triplanar-blend the albedo + roughness from the world position.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNor;\nvec3 triWeights(){ vec3 w = pow(abs(vTriNor), vec3(4.0)); return w / (w.x + w.y + w.z + 1e-5); }')
        .replace(
          '#include <map_fragment>',
          [
            '#ifdef USE_MAP',
            '  vec3 tw = triWeights();',
            '  vec4 sampledDiffuseColor = texture2D(map, vTriPos.yz) * tw.x + texture2D(map, vTriPos.xz) * tw.y + texture2D(map, vTriPos.xy) * tw.z;',
            '  diffuseColor *= sampledDiffuseColor;',
            '#endif',
          ].join('\n'),
        )
        .replace(
          '#include <roughnessmap_fragment>',
          [
            'float roughnessFactor = roughness;',
            '#ifdef USE_ROUGHNESSMAP',
            '  vec3 twr = triWeights();',
            '  vec4 texelRoughness = texture2D(roughnessMap, vTriPos.yz) * twr.x + texture2D(roughnessMap, vTriPos.xz) * twr.y + texture2D(roughnessMap, vTriPos.xy) * twr.z;',
            '  roughnessFactor *= texelRoughness.g;',
            '#endif',
          ].join('\n'),
        );
      // FRAGMENT: triplanar WHITEOUT normal (only when a normal map is present). Replaces the
      // standard tangent-space normal application (which has no tangents here → derivative TBN).
      if (withNormal) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          [
            'vec3 gN = normalize(vTriNor);',
            'vec3 tnX = texture2D(normalMap, vTriPos.zy).xyz * 2.0 - 1.0;',
            'vec3 tnY = texture2D(normalMap, vTriPos.xz).xyz * 2.0 - 1.0;',
            'vec3 tnZ = texture2D(normalMap, vTriPos.xy).xyz * 2.0 - 1.0;',
            'tnX.xy *= normalScale; tnY.xy *= normalScale; tnZ.xy *= normalScale;',
            'tnX = vec3(tnX.xy + gN.zy, abs(tnX.z) * gN.x);',
            'tnY = vec3(tnY.xy + gN.xz, abs(tnY.z) * gN.y);',
            'tnZ = vec3(tnZ.xy + gN.xy, abs(tnZ.z) * gN.z);',
            'vec3 twn = triWeights();',
            'vec3 worldN = normalize(tnX.zyx * twn.x + tnY.xzy * twn.y + tnZ.xyz * twn.z);',
            'normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);',
          ].join('\n'),
        );
      }
    };
    mat.customProgramCacheKey = () => 'worldTriplanar' + (withNormal ? 'N' : '') + worldScale.toFixed(3);
  }

  /** The shared WORLD-tiling material for a SurfaceKind (the dungeon path; null for 'flame'). */
  get(kind: SurfaceKind): THREE.MeshStandardMaterial | null {
    if (kind === 'flame') return null;
    return this.cache.get(kind) ?? null;
  }

  /** The PROP-tiling (world-space triplanar) material for a SurfaceKind — for ROUND props /
   *  theme re-skins (null for 'flame'). See patchWorldTriplanar. */
  getProp(kind: SurfaceKind): THREE.MeshStandardMaterial | null {
    if (kind === 'flame') return null;
    return this.propCache.get(kind) ?? null;
  }

  /**
   * A theme-TINTED variant of a kind, BUILT FRESH (cached by kind|projection|override) rather
   * than cloned — a clone of a get()/getProp() material reuses the cached program and skips the
   * onBeforeCompile world-UV injection, which collapses the projection (the surface then reads
   * as bare faceted geometry). Building fresh re-runs onBeforeCompile so the projection holds.
   */
  getTinted(
    kind: SurfaceKind,
    projection: 'classic' | 'triplanar',
    o: { color?: number; roughness?: number; metalness?: number; emissive?: number; emissiveIntensity?: number },
  ): THREE.MeshStandardMaterial | null {
    if (kind === 'flame' || !this.tex.has(kind)) return null;
    const key = `${kind}|${projection}|${JSON.stringify(o)}`;
    const cached = this.tinted.get(key);
    if (cached) return cached;
    const mat = this.buildMaterial(kind as Exclude<SurfaceKind, 'flame'>, projection, o);
    this.tinted.set(key, mat);
    return mat;
  }
}
