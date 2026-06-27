// ============================================================================
// src/lab/world-object.ts — the WORLD-OBJECT contract (docs/15).
// ============================================================================
//
// A WorldObject is the VIEW/AUTHORING-layer model of a tangible thing in the
// world: a wall, a table, a door, a whole staircase room. It is a SUPERSET of a
// LabElement (build(seed) → { root }) with three additions that the game needs:
//
//   1. VARIANTS — named visual "modes/versions" of the same object (a Door has
//      'plain' | 'barred' | 'handled'). This is how one model carries different
//      textures/fittings (a door's handle, its metal bars) without new types.
//   2. FOOTPRINT — the collision shape, authored RIGHT NEXT TO the visual, in
//      object-local space. One definition can then feed both the renderer AND the
//      collider — docs/13 §C-bis "collision matches the visual". (The sim stays
//      AABB + fixed-point; this is just where the boxes are authored.)
//   3. LEVEL + COMPOSITION — 'object' → 'grouping' → 'room'. A grouping/room
//      build() COMPOSES other WorldObjects, so abstraction stacks.
//
// Like LabElement, a WorldObject is pure VIEW: floats + seeded randomness are
// fine, it never touches src/sim, and gameplay-affecting facts (where a door IS)
// come from the deterministic generator — only cosmetic variant picks live here.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { fitBoxesWithStats, aabbToFootprintBox, type FitStats } from './box-fit.ts';
import { presentSwatchHexes, type RetextureRule } from './retexture.ts';
import { applyRecolor, ensureTilingTextures, type ResolvedSwatch } from './recolor.ts';

/** A collision box in OBJECT-LOCAL space (centre + half-extents, metres). */
export interface FootprintBox {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
}

/** The collision shape authored alongside the visual (empty = non-colliding decor). */
export interface Footprint {
  boxes: FootprintBox[];
}

/**
 * The MESH-BASED authoring path (vs. the procedural `build`): an object IS a 1:1
 * real mesh (a KayKit GLB), re-skinned per variant by COLOUR-KEYED rules (retexture.ts)
 * — "variants are re-skins of ONE mesh" (docs/15). Its `footprint` is fitted
 * automatically from the mesh (box-fit.ts), so nothing is hand-authored.
 */
export interface MeshObjectSpec {
  /** URL of the 1:1 mesh (e.g. 'models/kaykit_dungeon/table_long.glb'). */
  meshUrl: string;
  /** Display name. */
  name: string;
  /** One-liner: what this is for in the game. */
  describe: string;
  level: WorldObjectLevel;
  /** Per-variant colour-keyed re-skin rules. First key is the default variant. */
  variants: Record<string, RetextureRule[]>;
  /** Optional box-fit knobs. Normally LEFT UNSET — the GLOBAL box-fit defaults (relative
   *  cell + grow/shrink relaxation + non-overlap) give good footprints on any mesh with
   *  ZERO per-object tuning. See box-fit.ts FitBoxesOpts for every knob. */
  fit?: {
    cell?: number;
    cellDivisor?: number;
    cellMin?: number;
    cellMax?: number;
    edgeDensity?: number;
    edgeWeight?: number;
    nonOverlap?: boolean;
    minFill?: number;
    coverageTarget?: number;
    maxBoxes?: number;
    minBoxSize?: number;
    minBox?: number;
    dilate?: number;
  };
  /** Uniform scale applied to the loaded mesh (KayKit native units → game metres). */
  scale?: number;
  /** Colour-match tolerance for retexture (sRGB distance). Tighten when two swatches
   *  on the model are close (e.g. the chest's strap-grey vs plank-grey). Default 70. */
  retextureTolerance?: number;
}

export interface WorldObjectBuild {
  /** Scene-graph root, base at local y=0 (same convention as LabElement). */
  root: THREE.Object3D;
  /** Rough ground-plane radius (u) — the viewer frames the camera from this. */
  radius?: number;
  /** Collision shape (object-local). Drives the collider when wired to the sim. */
  footprint?: Footprint;
  /** Box-fit diagnostics (coverage / fill% / box count) for the lab HUD. */
  fitStats?: FitStats;
  /** The resolved per-swatch recolor table for this object (for the lab legend). */
  recolor?: ResolvedSwatch[];
  /** Atlas swatch hexes this model actually uses (for the legend's "present" markers). */
  presentSwatches?: ReadonlySet<number>;
  /** Optional per-frame animation/reactivity (actors = nearby world-space player positions). */
  update?: (timeSec: number, actors: readonly THREE.Vector3[]) => void;
}

export type WorldObjectLevel = 'object' | 'grouping' | 'room';

/**
 * Optional build inputs that apply ACROSS objects (vs. the per-object variant).
 * Coloring itself is handled by the recolor engine (see src/lab/CLAUDE.md); these opts
 * only toggle whole-object debug/raw modes. Procedural objects ignore them (they don't
 * use the KayKit atlas); only mesh-based objects honour them.
 */
export interface WorldObjectBuildOpts {
  /** Skip recolor and show the ORIGINAL KayKit atlas (the "Raw atlas" coloring mode). */
  raw?: boolean;
  /** DEBUG (?tintall=<hex>): force every swatch to this colour — a self-test that the bake runs. */
  tintAll?: number;
}

export interface WorldObject {
  /** Display name. The object ID is its filename (objects/<id>.ts). */
  name: string;
  /** One-liner: what this is for in the game. */
  describe: string;
  /** Abstraction level — individual object, a grouping/prefab, or a whole room. */
  level: WorldObjectLevel;
  /** Named visual modes; the first is the default. Always at least one. */
  variants: string[];
  /**
   * Build a fresh instance for (variant, seed). Unknown variant → fall back to
   * variants[0]. ASYNC across the contract: a mesh-based object loads a GLB; a
   * procedural one returns immediately (Promise.resolve). The lab awaits it.
   * `opts` carries cross-object inputs (e.g. a global theme); a procedural build may
   * simply ignore it.
   */
  build(variant: string, seed: number, opts?: WorldObjectBuildOpts): Promise<WorldObjectBuild>;
}

// ----------------------------------------------------------------------------
// Mesh-based WorldObject factory (the real-asset path). Loads the GLB once,
// re-skins per variant via colour-keyed retexture, and fits the footprint with
// box-fit. Procedural objects (e.g. the custom door) keep authoring `build`
// directly — KayKit has no door-leaf mesh.
// ----------------------------------------------------------------------------

/** One shared loader + per-URL template cache (recolor builds the material per object). */
const _loader = new GLTFLoader();
const _templates = new Map<string, Promise<THREE.Object3D>>();

function loadTemplate(url: string): Promise<THREE.Object3D> {
  let p = _templates.get(url);
  if (!p) {
    p = _loader.loadAsync(url).then((g) => g.scene);
    _templates.set(url, p);
  }
  return p;
}

/** Build a mesh-based WorldObject from a spec: load → clone → re-skin → fit boxes. */
export function meshObject(spec: MeshObjectSpec): WorldObject {
  const variantNames = Object.keys(spec.variants);
  return {
    name: spec.name,
    describe: spec.describe,
    level: spec.level,
    variants: variantNames,
    async build(variant: string, _seed: number, opts?: WorldObjectBuildOpts): Promise<WorldObjectBuild> {
      void variant; // variants are dormant under the recolor system (kept for URL/back-compat)
      const [template] = await Promise.all([loadTemplate(spec.meshUrl), ensureTilingTextures()]);
      // own copy per build (skeleton-safe even if the GLB has none)
      const model = cloneSkeleton(template);

      // SWATCH SAMPLE FIRST — presentSwatchHexes reads each triangle's ORIGINAL atlas colour, so it
      // MUST run on the RAW model: applyRecolor below replaces every material's map with a baked
      // DataTexture (image = {data,width,height}, not a drawable source), which would make the
      // sampler's drawImage throw. (See retexture.ts presentSwatchHexes' own contract note.)
      const present = presentSwatchHexes(model); // which swatches this model uses (legend markers)

      // RECOLOR: the WHOLE coloring system (recolor.ts). Per-pixel, in one shader: each pixel's
      // atlas colour → nearest swatch → that swatch's mapped tint × the baked gradient shade, with
      // its surface (rough/metal). Sets shadows + the material on every mesh. `resolved` (the
      // per-swatch table for this object) is returned for the lab legend. Null if no atlas.
      // RAW mode skips recolor → the original KayKit flat-atlas look (just ensure shadows).
      let resolved: ResolvedSwatch[] | null = null;
      if (opts?.raw) {
        model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      } else {
        resolved = applyRecolor(model, spec.meshUrl, 'position', opts?.tintAll, present);
      }

      // wrap in a scaled group, then DROP to y=0 (base on the ground, like LabElement)
      const inner = new THREE.Group();
      inner.add(model);
      inner.scale.setScalar(spec.scale ?? 1);
      const root = new THREE.Group();
      root.add(inner);
      root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(root);
      inner.position.y -= bb.min.y; // sit the lowest point on y=0
      root.updateMatrixWorld(true);

      // fit collision boxes from the FINAL placed mesh (object-local)
      const { boxes, stats } = fitBoxesWithStats(root, spec.fit ?? {});
      // frame the camera from the bounding HALF-DIAGONAL (incl. height) so tall props
      // (a barrel) and long ones (a table) are fully in frame — the lab multiplies
      // this radius for the orbit distance.
      const w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y, d = bb.max.z - bb.min.z;
      const radius = 0.5 * Math.hypot(w, h, d) || 1.5;
      return { root, radius, footprint: { boxes: boxes.map(aabbToFootprintBox) }, fitStats: stats, presentSwatches: present, ...(resolved ? { recolor: resolved } : {}) };
    },
  };
}
