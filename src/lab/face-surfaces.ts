// ============================================================================
// src/lab/face-surfaces.ts — per-TRIANGLE authoring data on a shared mesh.
// ============================================================================
//
// The recolor cascade decides a material per atlas SWATCH, which is the right grain for "what is
// this part made of" and the wrong grain for "this particular face". Some things are properties of
// a REGION of a mesh, not of a colour: the decorative bricks jutting out of a dungeon wall want to
// be gone, and a wall face wants its masonry courses to break at its own edges rather than run
// through the whole object as one slab.
//
// So: a face-group map, keyed by MESH URL rather than by lab object id — hidden geometry belongs to
// the mesh, so two catalog entries pointing at the same GLB share the edit.
//
//   { "models/kaykit_dungeon_remastered/wall.gltf.glb": { geom: "<hash>", hidden: { "0": [12,13] } } }
//
// GEOM HASH. Triangle indices mean nothing on their own — they are positions in a buffer that only
// this exact GLB produces. Re-export the model from KayKit and every stored index silently points
// somewhere else. So each entry carries a checksum of the geometry it was authored against and is
// SKIPPED with a warning on mismatch: losing the edit is recoverable, applying it to the wrong
// triangles is a corruption you would not notice until it shipped. (Same reasoning as the material
// profile `rev`.)
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
// STATIC import, deliberately: a model build is synchronous, and fetching the store afterwards meant
// the first render of every object showed the UNEDITED mesh until something forced a rebuild. The
// game has no dev middleware at all. Same pattern (and the same import attribute, which Node's
// strip-types runner requires) as src/game/approved-assets.ts.
import data from '../game/mesh-surfaces.json' with { type: 'json' };

/** Per-mesh hidden triangle lists, keyed by the mesh's index in a depth-first traverse. */
export type HiddenByMesh = Record<string, number[]>;

/**
 * A NAMED region of a mesh, saved by hand.
 *
 * The auto facet partition (face-select.ts) is a PROPOSAL — it is recomputed from the tolerance
 * every time, and moving the slider redraws it wholesale. A saved group is a DECISION. It stores
 * the triangles themselves, not the tolerance that happened to produce them, so retuning the slider
 * afterwards cannot silently redraw work someone already committed to. That distinction is the
 * whole reason this is persisted rather than derived.
 */
export interface SurfaceGroup {
  /** Stable slug — what a texture transform will key off once per-group mapping lands. */
  id: string;
  name: string;
  /** mesh index -> triangle indices, sorted. Same numbering as `hidden`: the UNFILTERED source. */
  tris: HiddenByMesh;
}

export interface SurfaceEntry {
  /** Checksum of the geometry these indices were authored against. */
  geom: string;
  hidden: HiddenByMesh;
  /** Hand-authored named regions. Absent on entries written before groups existed. */
  groups?: SurfaceGroup[];
}

export interface SurfaceStore {
  version: number;
  meshes: Record<string, SurfaceEntry>;
}

export const EMPTY_SURFACES: SurfaceStore = { version: 1, meshes: {} };

// ---- geometry identity -------------------------------------------------------------------------

/** FNV-1a over vertex/triangle counts plus a sampled sweep of positions. Cheap, deterministic, and
 *  sensitive to exactly what matters: a re-export that changes the triangle ORDER changes this. */
export function geometryHash(root: THREE.Object3D): string {
  const list: THREE.BufferGeometry[] = [];
  forEachMesh(root, (mesh) => list.push(mesh.geometry));
  return geometryHashOf(list);
}

/** Hash a specific list of geometries. Callers that have HIDDEN faces applied must pass the
 *  UNFILTERED sources: hashing what is currently on screen stores the hash of the post-edit mesh,
 *  and the next cold load then compares it against the original and refuses its own edit. */
export function geometryHashOf(list: readonly THREE.BufferGeometry[]): string {
  let h = 0x811c9dc5;
  const mix = (v: number): void => { h ^= v | 0; h = Math.imul(h, 0x01000193) >>> 0; };
  list.forEach((g, i) => {
    const pos = g.getAttribute('position');
    mix(i); mix(pos.count); mix(g.index ? g.index.count : 0);
    // ~256 samples is enough to catch a re-export while staying trivial to compute
    const step = Math.max(1, Math.floor(pos.count / 256));
    for (let v = 0; v < pos.count; v += step) {
      mix(Math.round(pos.getX(v) * 4096));
      mix(Math.round(pos.getY(v) * 4096));
      mix(Math.round(pos.getZ(v) * 4096));
    }
  });
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Depth-first mesh walk with a STABLE index — the key hidden lists are stored under. */
export function forEachMesh(root: THREE.Object3D, fn: (mesh: THREE.Mesh, index: number) => void): void {
  let i = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) fn(m, i++);
  });
}

/** Where `applyHiddenFaces` parks the geometry it replaced. Everything that reasons in TRIANGLE
 *  INDICES has to work from this: stored indices number the ORIGINAL buffer, so a tool that reads
 *  the filtered mesh instead is off by however many triangles were dropped before it. */
export const SOURCE_GEOM = '__srcGeom';

/** The unfiltered geometry behind a mesh — itself, unless hiding has already been applied. */
export function sourceGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  return (mesh.userData[SOURCE_GEOM] as THREE.BufferGeometry | undefined) ?? mesh.geometry;
}

/** Triangle count of a mesh's geometry. */
export function triCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

// ---- applying the hidden set --------------------------------------------------------------------

// Filtered geometries are cached: the game clones a template per placement, and rebuilding the index
// buffer for each one would be pure waste. Keyed by source geometry + the exact hidden set.
const _filtered = new Map<string, THREE.BufferGeometry>();

/** Drop the hidden triangles from a mesh's geometry, returning a filtered clone (or the original if
 *  nothing is hidden). The source geometry is never mutated — clones share it by reference. */
export function filterGeometry(g: THREE.BufferGeometry, hidden: readonly number[]): THREE.BufferGeometry {
  if (!hidden.length) return g;
  const total = triCount(g);
  const drop = new Set(hidden);
  const key = `${g.uuid}|${hidden.join(',')}`;
  const hit = _filtered.get(key);
  if (hit) return hit;

  const src = g.index;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
  if (src) {
    const keep: number[] = [];
    for (let t = 0; t < total; t++) {
      if (drop.has(t)) continue;
      keep.push(src.getX(t * 3), src.getX(t * 3 + 1), src.getX(t * 3 + 2));
    }
    out.setIndex(keep);
  } else {
    // Non-indexed: build an index that simply skips the dropped triangles' vertices. Cheaper than
    // repacking every attribute, and the orphaned vertices cost nothing to leave in the buffer.
    const keep: number[] = [];
    for (let t = 0; t < total; t++) {
      if (drop.has(t)) continue;
      keep.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    out.setIndex(keep);
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  _filtered.set(key, out);
  return out;
}

/** Apply a mesh URL's stored hidden set to a freshly cloned model. No-op when nothing is stored, or
 *  when the geometry no longer matches what the edit was authored against. */
export function applyHiddenFaces(root: THREE.Object3D, meshUrl: string): void {
  const entry = _store.meshes[meshUrl];
  if (!entry || !Object.keys(entry.hidden).length) return;
  // hash the ORIGINALS: on a re-entrant call (a rebuild) some meshes may already be filtered
  const list: THREE.BufferGeometry[] = [];
  forEachMesh(root, (mesh) => list.push(sourceGeometry(mesh)));
  const now = geometryHashOf(list);
  if (entry.geom !== now) {
    console.warn(`[surfaces] "${meshUrl}" hidden faces SKIPPED — geometry changed (stored ${entry.geom}, now ${now}). Re-author the selection.`);
    return;
  }
  forEachMesh(root, (mesh, i) => {
    const hidden = entry.hidden[String(i)];
    if (!hidden?.length) return;
    mesh.userData[SOURCE_GEOM] = mesh.geometry; // so the picker can still see the original numbering
    mesh.geometry = filterGeometry(mesh.geometry, hidden);
  });
}

// ---- the dev store (GET/POST /__lab/surfaces, see vite.config.ts) --------------------------------

// Module singleton so `applyHiddenFaces` stays synchronous inside a model build. `loadSurfaces`
// only REFRESHES it from the dev endpoint, so the lab picks up an edit made in another tab.
let _store: SurfaceStore = data as SurfaceStore;

export function getSurfaceStore(): SurfaceStore { return _store; }
export function setSurfaceStore(s: SurfaceStore): void { _store = s; }
export function hiddenFor(meshUrl: string): SurfaceEntry | undefined { return _store.meshes[meshUrl]; }

export async function loadSurfaces(): Promise<SurfaceStore> {
  try {
    const res = await fetch('/__lab/surfaces');
    if (!res.ok) throw new Error(String(res.status));
    _store = (await res.json()) as SurfaceStore;
  } catch (e) {
    console.warn('[surfaces] store unavailable (dev middleware only) —', String(e));
  }
  return _store;
}

export async function saveSurfaces(meshUrl: string, entry: SurfaceEntry | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/__lab/surfaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry ? { meshUrl, entry } : { meshUrl, remove: true }),
    });
    const r = (await res.json()) as { ok: boolean; error?: string };
    if (r.ok) {
      if (entry) _store.meshes[meshUrl] = entry;
      else delete _store.meshes[meshUrl];
    }
    return r;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
