// ============================================================================
// src/lab/group-anchors.ts — give every carved stone its OWN texture phase.
// ============================================================================
//
// THE PROBLEM. tiling.ts projects its textures in WORLD space, which is what makes a wall's masonry
// continue across the panel next to it instead of restarting per mesh. On a floor of octagonal
// pavers that same property is the bug: every paver in the tower shows the same patch of cobble at
// the same offset, because the pavers sit on a lattice whose spacing is commensurate with the
// texture's repeat. Eighteen thousand identical stones read as wallpaper, not as masonry.
//
// THE RULE, in one line:
//
//     phase = hash(anchor)          anchor = the group's area-weighted centroid, in WORLD space
//
// Same anchor -> coordinated. Different anchor -> differentiated. That one rule covers both cases,
// and it needs no per-instance state: the anchor is baked per VERTEX in OBJECT space and carried to
// world space by `modelMatrix` in the vertex shader, so two placements of the same tile in two
// different cells land on two different world anchors and differentiate themselves. A per-instance
// UNIFORM would have forced a material per instance and destroyed the shared program (tiling.ts).
//
// WHAT A "GROUP" IS. The carve-mode facet partition (facets.ts) at 75°: a face plus the slants that
// roll off it, bounded by the concave crease where the next piece comes back up. On
// `floor_tile_large` that is exactly one facet per paver; on a dungeon wall it is one per protruding
// brick. A hand-saved SurfaceGroup (face-surfaces.ts) REPLACES the auto facets it covers — a
// decision beats a proposal — and may carry its own `vary` override.
//
// SCOPE. Within one mesh only. Groups that abut ACROSS two placed meshes (the corner pieces of four
// floor tiles meeting to form one diamond) are deliberately NOT coordinated here: `cell-tower.ts`
// collapses aligned 2x2 blocks of matching floor into a single natively-4u mesh, conditionally and
// data-dependently, so a phase keyed on per-tile seam points would break visibly exactly at the
// merged/unmerged boundary. A group is always wholly inside one mesh, which is why this half is
// safe and that half is not.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import {
  forEachMesh, sourceGeometry, surfaceStoreRev, validSurfaceEntry, SOURCE_GEOM,
} from './face-surfaces.ts';
import { buildTopology, partitionFacets, facetCentroid, DEFAULT_TOL_DEG, type MeshTopology } from './facets.ts';
import type { VaryMode } from './texture-catalog.ts';

/** The per-vertex attribute the tiling shader reads: xyz = the group's OBJECT-space anchor,
 *  w = the vary override code below. */
export const GROUP_ANCHOR_ATTR = 'aGroupAnchor';

/**
 * The `w` channel. These are numbers because they cross into GLSL, and the assignment is not
 * arbitrary:
 *
 * **1 is INHERIT-NOTHING on purpose.** A geometry that carries no `aGroupAnchor` at all gets GL's
 * default generic vertex attribute, `(0,0,0,1)` — so w = 1, and the shader leaves that mesh exactly
 * as it renders today. The safe answer is the one you get for free when the attribute is missing.
 */
export const VARY_CODE: Record<VaryMode, number> = { none: 1, shift: 2, 'shift+rotate': 3 };
/** "Whatever this material TYPE says" — the value an auto facet gets, resolved against `uVary`. */
export const VARY_INHERIT = 0;

/** The partition this bakes against. Carve at 75° is the documented one-facet-per-paver setting
 *  (SURFACES.md: flat from 65° to 89°), so the anchors match what `show groups` tints in the lab. */
const ANCHOR_TOL_COS = Math.cos(THREE.MathUtils.degToRad(DEFAULT_TOL_DEG.carve));

// A geometry is shared by every clone of a template (the game places thousands), so the anchored
// rebuild happens ONCE per source geometry. Keyed by the store revision too: saving a group in the
// lab must change what the next build bakes, and a WeakMap keyed on geometry alone would not notice.
const _anchored = new WeakMap<THREE.BufferGeometry, { rev: number; out: THREE.BufferGeometry }>();

/**
 * Bake per-group texture anchors into every mesh of a freshly cloned model.
 *
 * RUN THIS BEFORE `applyHiddenFaces`. It replaces `mesh.geometry` with a rebuilt copy (the original
 * is parked in `userData[SOURCE_GEOM]`, so every index-shaped tool still reads the numbering it was
 * authored against), and `filterGeometry` then carries the new attribute through by reference.
 * Running it the other way round would park the REBUILT geometry as the "source" and the geometry
 * hash guard would start rejecting the store's own edits.
 */
export function applyGroupAnchors(root: THREE.Object3D, meshUrl: string): void {
  const entry = validSurfaceEntry(root, meshUrl);
  const rev = surfaceStoreRev();
  forEachMesh(root, (mesh, i) => {
    const src = sourceGeometry(mesh);
    const hit = _anchored.get(src);
    if (hit && hit.rev === rev) {
      if (mesh.userData[SOURCE_GEOM] === undefined) mesh.userData[SOURCE_GEOM] = src;
      mesh.geometry = hit.out;
      return;
    }
    const saved = entry?.groups?.filter((g) => (g.tris[String(i)]?.length ?? 0) > 0) ?? [];
    const out = anchoredGeometry(src, saved.map((g) => ({ tris: g.tris[String(i)]!, vary: g.vary })));
    _anchored.set(src, { rev, out });
    if (mesh.userData[SOURCE_GEOM] === undefined) mesh.userData[SOURCE_GEOM] = src;
    mesh.geometry = out;
  });
}

interface SavedRegion {
  tris: readonly number[];
  vary?: VaryMode | undefined;
}

/**
 * The rebuild: partition, anchor each group, write the attribute.
 *
 * A vertex can be shared by triangles in two different groups (a GLB duplicates at normal seams,
 * which covers most crease boundaries, but not all of them), and an attribute can only hold one
 * value per vertex. Where that happens the vertex is DUPLICATED and the index rewritten — the
 * alternative is one triangle of a paver wearing its neighbour's phase, which reads as a torn
 * texture and is exactly the kind of bug nobody traces back to a shared corner. Triangle ORDER and
 * COUNT never change, so every stored triangle index stays valid.
 */
function anchoredGeometry(g: THREE.BufferGeometry, saved: readonly SavedRegion[]): THREE.BufferGeometry {
  const topo = buildTopology(g);
  const part = partitionFacets(topo, 'carve', ANCHOR_TOL_COS);

  // group -> (anchor xyz, vary code). Auto facets first, then the saved regions that override them.
  const anchors: number[] = [];
  for (const f of part.list) anchors.push(f.centroid.x, f.centroid.y, f.centroid.z, VARY_INHERIT);
  const triGroup = part.byTri.slice();
  for (const region of saved) {
    const id = anchors.length / 4;
    const { centroid } = facetCentroid(topo, region.tris);
    anchors.push(centroid.x, centroid.y, centroid.z, region.vary ? VARY_CODE[region.vary] : VARY_INHERIT);
    for (const t of region.tris) if (t >= 0 && t < topo.tris) triGroup[t] = id;
  }

  const { index, vertGroup, added } = splitSharedVertices(topo, triGroup);

  const out = new THREE.BufferGeometry();
  const total = topo.verts + added.length;
  for (const [name, attr] of Object.entries(g.attributes)) {
    out.setAttribute(name, added.length === 0 ? attr : extendAttribute(attr, added));
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));

  const anchorArr = new Float32Array(total * 4);
  for (let v = 0; v < total; v++) {
    const gid = vertGroup[v]!;
    // An unreferenced vertex (gid < 0) can only be reached by nothing, but give it the inert code
    // rather than group 0's anchor so a stray draw can never inherit someone else's phase.
    if (gid < 0) { anchorArr[v * 4 + 3] = VARY_CODE.none; continue; }
    anchorArr[v * 4] = anchors[gid * 4]!;
    anchorArr[v * 4 + 1] = anchors[gid * 4 + 1]!;
    anchorArr[v * 4 + 2] = anchors[gid * 4 + 2]!;
    anchorArr[v * 4 + 3] = anchors[gid * 4 + 3]!;
  }
  out.setAttribute(GROUP_ANCHOR_ATTR, new THREE.BufferAttribute(anchorArr, 4));

  for (const grp of g.groups) out.addGroup(grp.start, grp.count, grp.materialIndex);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Assign each vertex to one group, duplicating any vertex two groups both want. Returns the new
 *  index buffer, the per-vertex group (including the appended duplicates), and which SOURCE vertex
 *  each duplicate copies. */
function splitSharedVertices(
  topo: MeshTopology, triGroup: Int32Array,
): { index: Uint32Array | Uint16Array; vertGroup: Int32Array; added: number[] } {
  const owner = new Int32Array(topo.verts).fill(-1);
  const idx = new Uint32Array(topo.tris * 3);
  const added: number[] = [];
  const addedGroup: number[] = [];
  const remap = new Map<string, number>();

  for (let t = 0; t < topo.tris; t++) {
    const gid = triGroup[t]!;
    for (let k = 0; k < 3; k++) {
      const v = topo.vidx[t * 3 + k]!;
      if (owner[v] === -1) { owner[v] = gid; idx[t * 3 + k] = v; continue; }
      if (owner[v] === gid) { idx[t * 3 + k] = v; continue; }
      const key = `${v}|${gid}`;
      let nv = remap.get(key);
      if (nv === undefined) {
        nv = topo.verts + added.length;
        added.push(v);
        addedGroup.push(gid);
        remap.set(key, nv);
      }
      idx[t * 3 + k] = nv;
    }
  }

  const total = topo.verts + added.length;
  const vertGroup = new Int32Array(total);
  vertGroup.set(owner, 0);
  for (let i = 0; i < addedGroup.length; i++) vertGroup[topo.verts + i] = addedGroup[i]!;
  // Uint16 while it fits — the index is the one buffer that grows with the split, and these meshes
  // are a few hundred vertices, so paying 32 bits for all of them would be silly.
  const index = total <= 65535 ? Uint16Array.from(idx) : idx;
  return { index, vertGroup, added };
}

/** A copy of `attr` with `added` extra entries, each cloned from the source vertex it duplicates. */
function extendAttribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, added: readonly number[]): THREE.BufferAttribute {
  const size = attr.itemSize;
  const out = new Float32Array((attr.count + added.length) * size);
  for (let v = 0; v < attr.count; v++) {
    for (let c = 0; c < size; c++) out[v * size + c] = attr.getComponent(v, c);
  }
  for (let i = 0; i < added.length; i++) {
    const src = added[i]!;
    for (let c = 0; c < size; c++) out[(attr.count + i) * size + c] = attr.getComponent(src, c);
  }
  const b = new THREE.BufferAttribute(out, size);
  b.normalized = false; // the copy is float regardless of how the source was packed
  return b;
}
