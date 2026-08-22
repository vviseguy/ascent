// ============================================================================
// src/lab/tiling.ts — the REAL-SURFACE layer: world-space tiling detail via TEXTURE ARRAYS.
// ============================================================================
//
// recolor.ts gives every atlas swatch a colour + KayKit's baked gradient. That lives on the ATLAS
// UVs, so it can never show repeating grain (masonry courses, plank runs) or react to light like a
// real surface. This module adds that on top, in ONE shader patch:
//
//   uTexArr [layer]  = the texture's ALBEDO                          (sRGB)
//   uSurfArr[layer]  = PACKED surface: R,G = normal.xy  B = roughness RATIO/2  A = ambient occlusion
//   uShade           = the baked KayKit gradient as a scalar (per atlas pixel)
//   uSlot[13]        = per material TYPE: (layer, 1/scale, 1/meanLuma, colourMode)
//
// WHY ARRAYS. The previous version bound one sampler2D per distinct texture plus a second for its
// normal map — so relief silently switched itself off past 5 distinct textures (the 16-sampler
// floor), and every object had to thread a "present presets" set through the bake just to stay
// under budget. Two sampler2DArrays hold the whole working set instead: the shader indexes by the
// SLOT already baked into ORM.r, the if/else branch chain disappears, and there is no per-object
// texture cap at all.
//
// SURFACE RESPONSE (what makes light actually catch it):
//   - normal  -> real per-texel slopes, so a grazing key light rakes across the grain
//   - rough   -> stored as a RATIO around 1 (mean-normalised at bake), so the type's authored
//                roughness stays the average and the map only adds variation
//   - AO      -> multiplies INDIRECT light only (never direct), so crevices darken without
//                flattening the key light
//
// COLOUR MODE. `grain` (default) uses the texture's LUMINANCE only — the swatch tint keeps the
// colour, so any texture sits on any type predictably. `albedo` uses the texture's OWN colour,
// re-shaded by the baked KayKit gradient (uShade) — for scanned materials (Poly Haven wood) where
// the colour variation IS the asset and a luminance-only read throws it away.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import {
  TEXTURE_BY_ID, CONFIGURABLE_PRESETS, getConfig, getRelief, getAOStrength,
  type Preset, type TextureOption,
} from './texture-catalog.ts';

/** preset -> a fixed tiling SLOT (1..12), baked into ORM.r by recolor's bake. 0 = untextured. */
export const PRESET_SLOT: Record<Preset, number> = {
  stone: 1, floor: 2, wood: 3, metal: 4, gold: 5, cloth: 6,
  terracotta: 7, dark: 8, plain: 9, smoothstone: 10, grained: 11, irondark: 12,
};
const SLOT_COUNT = 13; // slots 1..12, index 0 = "no texture"

/** Per-layer resolution of the arrays. Every layer must share one size, so sources are resampled
 *  here. 1024 keeps a 2-3 m tile crisp at gameplay distance; `?texres=` overrides for A/B. */
function layerRes(): number {
  const p = Number(new URLSearchParams(location.search).get('texres'));
  return p === 512 || p === 1024 || p === 2048 ? p : 1024;
}

// ---- decode helpers ---------------------------------------------------------------------------

/** Load one file from public/textures/ and resample it to res*res RGBA. Null if it isn't there — a
 *  missing map is not an error, it just means "this texture has no such channel". */
async function loadPixels(file: string | undefined, res: number): Promise<Uint8ClampedArray | null> {
  if (!file) return null;
  try {
    const img = new Image();
    img.src = 'textures/' + file;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, res, res);
    return g.getImageData(0, 0, res, res).data;
  } catch {
    console.warn(`[tiling] failed to load texture ${file}`);
    return null;
  }
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Mean LINEAR luminance of an albedo layer -> 1/mean, the grain normaliser (so grain averages to 1
 *  and a texture contributes PATTERN without darkening or brightening the tint). */
function meanInvLuma(px: Uint8ClampedArray): number {
  const n = px.length / 4;
  const step = Math.max(1, Math.floor(n / 4096)); // ~4k texels is plenty for a mean
  let sum = 0, count = 0;
  for (let i = 0; i < n; i += step) {
    const a = i * 4;
    sum += 0.299 * srgbToLinear(px[a]! / 255) + 0.587 * srgbToLinear(px[a + 1]! / 255) + 0.114 * srgbToLinear(px[a + 2]! / 255);
    count++;
  }
  const mean = sum / Math.max(count, 1);
  return mean > 0.001 ? 1 / mean : 1;
}

/** Pack one texture's normal + roughness + AO into a single RGBA layer.
 *    R,G = normal.xy  (128 = flat)   — Z is reconstructed in the shader
 *    B   = roughness RATIO / 2       — 128 means "1.0x", i.e. leave the authored value alone
 *    A   = ambient occlusion         — 255 = unoccluded
 *  Poly Haven ships `arm` (R=AO, G=rough, B=metal), one file covering two channels; ambientCG-era
 *  entries use separate `rough`/`ao` files. Absent maps write the neutral value, so an untextured
 *  channel costs nothing and needs no shader branch. */
async function packSurface(o: TextureOption, res: number): Promise<Uint8Array> {
  const n = res * res;
  const out = new Uint8Array(n * 4);
  const [nor, arm, rough, ao] = await Promise.all([
    loadPixels(o.nor, res), loadPixels(o.arm, res), loadPixels(o.rough, res), loadPixels(o.ao, res),
  ]);

  // roughness source: arm.G if packed, else a dedicated greyscale map, else neutral.
  const roughAt = arm ? (i: number): number => arm[i * 4 + 1]! : rough ? (i: number): number => rough[i * 4]! : null;
  // mean-normalise so the map reads as a RATIO around 1 and the authored roughness is the average.
  let invMeanRough = 0;
  if (roughAt) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += roughAt(i);
    const mean = sum / n;
    invMeanRough = mean > 1 ? 1 / mean : 0;
  }
  const aoAt = arm ? (i: number): number => arm[i * 4]! : ao ? (i: number): number => ao[i * 4]! : null;

  for (let i = 0; i < n; i++) {
    const a = i * 4;
    out[a] = nor ? nor[a]! : 128;
    out[a + 1] = nor ? nor[a + 1]! : 128;
    out[a + 2] = roughAt && invMeanRough ? Math.max(0, Math.min(255, Math.round(roughAt(i) * invMeanRough * 127.5))) : 128;
    out[a + 3] = aoAt ? aoAt(i) : 255;
  }
  return out;
}

// ---- the arrays -------------------------------------------------------------------------------

interface TexArrays {
  diff: THREE.DataArrayTexture;
  surf: THREE.DataArrayTexture;
  /** texture id -> its layer index. */
  layer: Map<string, number>;
  /** texture id -> 1/mean-luminance (the grain normaliser). */
  inv: Map<string, number>;
  res: number;
}

let _arrays: TexArrays | null = null;
let _key = '';                          // the config texture-set the current arrays were built for
let _building: Promise<void> | null = null;

/** The distinct textures the CURRENT config actually references — the arrays hold only these, so
 *  the working set is ~8 layers, not the whole library. Sorted so the key is stable. */
function activeTextureIds(): string[] {
  const cfg = getConfig();
  const ids = new Set<string>();
  for (const p of CONFIGURABLE_PRESETS) {
    const o = TEXTURE_BY_ID.get(cfg[p].texture);
    if (o?.diff) ids.add(o.id);
  }
  return [...ids].sort();
}

/** Build (or rebuild) the arrays for the current config. A no-op when the config's texture set
 *  hasn't changed, so every object build can await it unconditionally. */
export function ensureTilingTextures(): Promise<void> {
  const res = layerRes();
  const ids = activeTextureIds();
  const key = res + '|' + ids.join(',');
  if (key === _key && _arrays) return Promise.resolve();
  if (key === _key && _building) return _building;

  _key = key;
  _building = (async () => {
    if (!ids.length) { _arrays = null; return; }
    const stride = res * res * 4;
    const diffBuf = new Uint8Array(stride * ids.length);
    const surfBuf = new Uint8Array(stride * ids.length);
    const layer = new Map<string, number>();
    const inv = new Map<string, number>();

    await Promise.all(ids.map(async (id, i) => {
      const o = TEXTURE_BY_ID.get(id)!;
      const [alb, surf] = await Promise.all([loadPixels(o.diff, res), packSurface(o, res)]);
      if (alb) { diffBuf.set(alb, stride * i); inv.set(id, meanInvLuma(alb)); }
      surfBuf.set(surf, stride * i);
      layer.set(id, i);
    }));

    _arrays?.diff.dispose();
    _arrays?.surf.dispose();

    const mk = (data: Uint8Array, srgb: boolean): THREE.DataArrayTexture => {
      const t = new THREE.DataArrayTexture(data, res, res, ids.length);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter; // world-space UVs alias badly at distance
      t.generateMipmaps = true;
      t.anisotropy = 8;                             // and shimmer at grazing angles without aniso
      t.needsUpdate = true;
      return t;
    };
    _arrays = { diff: mk(diffBuf, true), surf: mk(surfBuf, false), layer, inv, res };
    const mb = ((stride * ids.length * 2) / 1048576) * 1.34; // x2 arrays, +33% mips
    console.info(`[tiling] ${ids.length} layers @ ${res}^2 -> ~${mb.toFixed(0)} MB GPU (${ids.join(', ')})`);
  })();
  return _building;
}

/** Drop the arrays (frees GPU memory); the next ensure() rebuilds. */
export function disposeTilingTextures(): void {
  _arrays?.diff.dispose();
  _arrays?.surf.dispose();
  _arrays = null;
  _key = '';
  _building = null;
}

// ---- the shader patch ---------------------------------------------------------------------------

/** Inject world-space tiling detail into a baked MeshStandardMaterial.
 *  `shade` is the per-atlas-pixel KayKit gradient (recolor's bake); only `albedo` mode reads it. */
export function patchTilingDetail(mat: THREE.MeshStandardMaterial, shade: THREE.Texture): void {
  const arr = _arrays;
  if (!arr) return; // library not loaded -> plain baked material (colour + gradient only)

  const cfg = getConfig();
  // uSlot[slot] = (layer, 1/scale, 1/meanLuma, colourMode). y = 0 marks "this slot has no texture".
  const slots: THREE.Vector4[] = Array.from({ length: SLOT_COUNT }, () => new THREE.Vector4(0, 0, 1, 0));
  for (const p of CONFIGURABLE_PRESETS) {
    const o = TEXTURE_BY_ID.get(cfg[p].texture);
    const li = o ? arr.layer.get(o.id) : undefined;
    if (!o || li === undefined) continue;
    slots[PRESET_SLOT[p]] = new THREE.Vector4(li, 1 / o.scale, arr.inv.get(o.id) ?? 1, o.color === 'albedo' ? 1 : 0);
  }

  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uTexArr'] = { value: arr.diff };
    shader.uniforms['uSurfArr'] = { value: arr.surf };
    shader.uniforms['uShade'] = { value: shade };
    shader.uniforms['uSlot'] = { value: slots };
    shader.uniforms['uRelief'] = { value: getRelief() };
    shader.uniforms['uAOStr'] = { value: getAOStrength() };

    // VERTEX: carry world position + world normal for the per-fragment planar projection.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWNor = normalize(mat3(modelMatrix) * objectNormal);');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec3 vWPos;',
        'varying vec3 vWNor;',
        'uniform sampler2DArray uTexArr;',
        'uniform sampler2DArray uSurfArr;',
        'uniform sampler2D uShade;',
        `uniform vec4 uSlot[${SLOT_COUNT}];`,
        'uniform float uRelief;',
        'uniform float uAOStr;',
        'const vec3 TLUMA = vec3(0.299, 0.587, 0.114);',
        // Box-planar world UV + the tangent frame that UV parameterises. Plane picked from the
        // dominant world-normal axis, scaled to metres/tile; KayKit faces are axis-aligned, so one
        // plane per face is exact.
        //
        // HANDEDNESS IS NOT OPTIONAL. A tangent-space normal map assumes cross(T,B) == the OUTWARD
        // normal. Picking the plane from abs(normal) alone ignores which WAY the face points, and
        // then cross(T,B) equals -Y / -X / +Z for the three cases — so every up-facing surface, and
        // every face on the negative side of its axis, gets a mirrored frame and its bumps light as
        // dents. Flipping B fixes the frame; flipping V with it keeps the albedo sampling in the
        // same parameterisation, so grain and relief stay registered to each other.
        'void planarFrame(float inv, out vec2 uv, out vec3 T, out vec3 B, out vec3 Ng){',
        '  vec3 wn = abs(vWNor); vec3 wp = vWPos * inv; Ng = normalize(vWNor);',
        '  if ( wn.y >= wn.x && wn.y >= wn.z ) { uv = wp.xz; T = vec3(1.,0.,0.); B = vec3(0.,0.,1.); }',
        '  else if ( wn.x >= wn.z )            { uv = wp.zy; T = vec3(0.,0.,1.); B = vec3(0.,1.,0.); }',
        '  else                                { uv = wp.xy; T = vec3(1.,0.,0.); B = vec3(0.,1.,0.); }',
        '  if ( dot( cross( T, B ), Ng ) < 0.0 ) { B = -B; uv.y = -uv.y; }',
        '}',
      ].join('\n'))
      // after the baked albedo: apply grain / albedo and stash surface terms for the chunks below.
      .replace('#include <map_fragment>', [
        '#include <map_fragment>',
        'float _texRough = 1.0;',
        'float _texAO = 1.0;',
        'vec3 _bumpWN = normalize( vWNor );',
        '{',
        '  int tslot = int( texture2D( roughnessMap, vRoughnessMapUv ).r * 255.0 + 0.5 );',
        `  vec4 sd = uSlot[ clamp( tslot, 0, ${SLOT_COUNT - 1} ) ];`,
        '  if ( sd.y > 0.0 ) {',
        '    vec2 tuv; vec3 _T; vec3 _B; vec3 _Ng;',
        '    planarFrame( sd.y, tuv, _T, _B, _Ng );',
        '    vec3 tcol = texture( uTexArr, vec3( tuv, sd.x ) ).rgb;',
        '    vec4 surf = texture( uSurfArr, vec3( tuv, sd.x ) );',
        // GRAIN: normalised luminance pattern around 1, modulating the baked colour.
        '    float grain = clamp( dot( tcol, TLUMA ) * sd.z, 0.6, 1.4 );',
        // ALBEDO: the texture's own colour, wearing the baked KayKit gradient (uShade, ratio/2).
        '    float bakedShade = texture2D( uShade, vMapUv ).r * 2.0;',
        '    diffuseColor.rgb = mix( diffuseColor.rgb * grain, tcol * bakedShade, sd.w );',
        '    _texRough = surf.b * 2.0;',
        '    _texAO = mix( 1.0, surf.a, uAOStr );',
        '    if ( uRelief > 0.0 ) {',
        // uRelief scales the SLOPE, so clamp before reconstructing Z: past |nxy| = 1 the surface is
        // vertical and sqrt() would clamp to 0, flattening the strongest slopes into hard facets.
        '      vec2 nxy = ( surf.rg * 2.0 - 1.0 ) * uRelief * 2.0;',
        '      float m = length( nxy ); if ( m > 0.98 ) nxy *= 0.98 / m;',
        '      float nz = sqrt( max( 1.0 - dot( nxy, nxy ), 0.0 ) );',
        '      _bumpWN = normalize( _T * nxy.x + _B * nxy.y + _Ng * nz );',
        '    }',
        '  }',
        '}',
      ].join('\n'))
      // per-texel roughness: multiply the authored value by the map's RATIO (mean 1). Specular
      // breakup is what stops a surface reading as flat painted plastic.
      .replace('#include <roughnessmap_fragment>', [
        '#include <roughnessmap_fragment>',
        'roughnessFactor = clamp( roughnessFactor * _texRough, 0.04, 1.0 );',
      ].join('\n'))
      // relief: swap the geometry normal for the normal-mapped one (three works in view space).
      .replace('#include <normal_fragment_begin>', [
        '#include <normal_fragment_begin>',
        'if ( uRelief > 0.0 ) normal = normalize( ( viewMatrix * vec4( _bumpWN, 0.0 ) ).xyz );',
      ].join('\n'))
      // AO on INDIRECT light only — crevices darken, the key light still models the form.
      .replace('#include <aomap_fragment>', [
        '#include <aomap_fragment>',
        'reflectedLight.indirectDiffuse *= _texAO;',
        'reflectedLight.indirectSpecular *= _texAO;',
      ].join('\n'));
  };

  // SHARED cache key — one compiled program for every recolored material in the scene.
  //
  // This used to be unique per material, and had to be: the old design emitted a different sampler
  // set and a different if/else chain per object, so two materials sharing a key meant the second
  // one ran against the first one's source and its uniforms went unbound. With the arrays, every
  // material emits BYTE-IDENTICAL source and differs only in uniform VALUES (uShade, uSlot), which
  // three keeps per material. So they can share, and should: measured on the contact sheet, the
  // unique key cost one shader compile per object (5 programs at 1 object, 18 at 14) — a load-time
  // hitch that grew with the asset set for no benefit.
  //
  // If you ever make the generated SOURCE depend on the material again, this key must encode
  // whatever varies, or you will resurrect the unbound-uniform bug.
  mat.customProgramCacheKey = () => 'recolorTiled1';
}
