// ============================================================================
// src/lab/face-select.ts — hover, grow, and hide triangles on a loaded mesh.
// ============================================================================
//
// Picking one triangle at a time is not a tool. What makes this usable is GROW: hover a face and it
// flood-fills across shared edges to everything within an angle tolerance of it, so a wall face or
// a brick top comes in as one click instead of forty. The tolerance is a slider because "coplanar"
// is never exactly true in an exported mesh — faces are a fraction of a degree off, and where you
// want the fill to stop differs per model.
//
// THREE THINGS ARE DRAWN, and the distinction matters more than it sounds:
//   white  — the triangle actually under the cursor, plus a normal ARROW so you can see which way
//            the face you are about to take is pointing (on a thin wall the front and back faces
//            sit a few pixels apart and are otherwise indistinguishable)
//   amber  — the PREVIEW: what grow would add at the current tolerance, before you commit
//   blue   — what is already selected
// Seeing the preview separately from the selection is what makes the tolerance slider legible: you
// drag it and watch the amber spread or retreat, rather than clicking and undoing.
//
// Left-click adds the preview, right-click removes it, and the geometry is never touched until you
// press Hide — selection is a view, hiding is an edit.
//
// A press only ARMS a click; the RELEASE decides. Move more than a few pixels in between and the
// gesture is handed back to the camera untouched, so orbit stays on left-drag and pan on right-drag
// exactly as they are outside edit mode. Edit mode does not take the mouse away from you — it adds
// a meaning to tapping, and both buttons work the same way.
//
// ADJACENCY IS BY POSITION, not by vertex index. A GLB duplicates vertices at every UV and normal
// seam, so two triangles that visually share an edge routinely have no index in common; keying on
// quantised position is what lets a fill cross those seams instead of stopping dead at them.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import { forEachMesh, triCount, filterGeometry, geometryHashOf, sourceGeometry } from './face-surfaces.ts';

export interface FaceSelectOpts {
  root: THREE.Object3D;
  scene: THREE.Scene;
  camera: THREE.Camera;
  dom: HTMLElement;
  initialHidden?: Readonly<Record<string, number[]>>;
  /** Fired whenever counts change, so the panel can redraw its readout. */
  onChange: () => void;
  render: () => void;
}

/**
 * How a hover spreads.
 *
 * - `planar` — one cone about the seed normal. Gives the flat faces themselves.
 * - `carve`  — the seed face PLUS the slants that roll down off it, stopping at the concave crease
 *              where the neighbouring tile's slant comes back up. Gives a tile the way a mason
 *              would think of one: the face and its own chamfers, fitted against the next tile.
 *
 * The difference is the SIGN of the fold, not its angle. On a KayKit floor tile the bevels off each
 * paver (convex, 20-45°) and the rut bottoms between pavers (concave, 60-65°) are both just "edges"
 * to an angle threshold; only convexity separates them.
 */
export type GrowMode = 'planar' | 'carve';

export interface FaceSelectHandle {
  setEnabled: (on: boolean) => void;
  setMode: (m: GrowMode) => void;
  setTolerance: (deg: number) => void;
  counts: () => { hover: number; preview: number; selected: number; hidden: number };
  hideSelected: () => void;
  unhideAll: () => void;
  clearSelection: () => void;
  /** Hidden triangles per mesh index, sorted — the shape the store wants. */
  hidden: () => Record<string, number[]>;
  /** Hash of the UNFILTERED source geometry — what a stored edit must be checked against. */
  sourceHash: () => string;
  /** Every facet of the primary mesh at the current tolerance, largest first. */
  facets: () => readonly FacetInfo[];
  /** Tint every facet a distinct hue, so the partition is legible as a whole rather than one hover
   *  at a time. */
  setShowGroups: (on: boolean) => void;
  /** Preview one facet from the list (null clears) — the list and the viewport share one highlight. */
  highlightFacet: (id: number | null) => void;
  /** Add or remove a whole facet, as if it had been clicked in the viewport. */
  commitFacet: (id: number, add: boolean) => void;
  /** The current selection, per mesh index, sorted — the shape a saved group stores. */
  selection: () => Record<string, number[]>;
  /** Replace the selection (restoring a saved group into it). */
  setSelection: (rec: Readonly<Record<string, number[]>>) => void;
  /** Preview an arbitrary triangle set without touching the selection (null clears). */
  highlightTris: (rec: Readonly<Record<string, number[]>> | null) => void;
  /** Paint a list of triangle sets in distinct hues, or null for nothing. The panel decides
   *  whether that is the auto partition or the saved groups; this only draws what it is given. */
  paintSets: (sets: readonly (readonly number[])[] | null) => void;
  dispose: () => void;
}

/**
 * A maximal run of edge-connected triangles within the angle tolerance — the unit a texture gets
 * "ironed onto", and what a per-group transform will eventually key off.
 *
 * MESH-LOCAL by construction. Facets that abut across two placed instances — the corner pieces of
 * four floor tiles meeting to form one diamond — are separate facets here, and can only be joined
 * once world positions are known. That is a different mechanism, deliberately not this one.
 */
export interface FacetInfo {
  id: number;
  tris: number[];
  /** Local-space, area-weighted centroid. Becomes the per-group texture ANCHOR later. */
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  /** Surface area — the only honest way to sort facets. A triangle count says more about how the
   *  exporter happened to triangulate than about how big the face actually is. */
  area: number;
}

/** One mesh's precomputed topology. Built once per model load; a few hundred triangles, so cheap. */
interface MeshInfo {
  mesh: THREE.Mesh;
  index: number;
  source: THREE.BufferGeometry;   // the UNFILTERED geometry — hiding never destroys it
  tris: number;
  /** Flat [ax,ay,az, bx,by,bz, cx,cy,cz] per triangle, local space. */
  verts: Float32Array;
  /** Unit normal per triangle, local space. */
  normals: Float32Array;
  /** Centroid per triangle, local space — needed to tell a convex fold from a concave crease. */
  cents: Float32Array;
  /** triangle -> up to 3 edge-adjacent triangles. */
  adj: Int32Array;
  adjCount: Uint8Array;
}

const OVERLAY_OFFSET = -2; // polygon offset units: sit the highlight just in front of the surface

function buildInfo(mesh: THREE.Mesh, index: number): MeshInfo {
  // SOURCE, not mesh.geometry: on a cold load the build has already applied the stored hidden set,
  // so mesh.geometry is the FILTERED mesh. Numbering topology off that while the stored indices
  // number the original is exactly the "selection lands on the wrong faces" bug.
  const g = sourceGeometry(mesh);
  const pos = g.getAttribute('position');
  const idx = g.index;
  const tris = triCount(g);
  const verts = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 3);
  const cents = new Float32Array(tris * 3);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const vi = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, vi(t, 0));
    b.fromBufferAttribute(pos, vi(t, 1));
    c.fromBufferAttribute(pos, vi(t, 2));
    verts.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 9);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() > 1e-20) n.normalize(); else n.set(0, 1, 0); // degenerate tri: harmless filler
    normals.set([n.x, n.y, n.z], t * 3);
    cents.set([(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3], t * 3);
  }

  // edge -> triangles, keyed by QUANTISED endpoint positions so UV/normal seams don't split it
  const Q = 1e4;
  const key = (t: number, k: number): string => {
    const o = t * 9 + k * 3;
    return `${Math.round(verts[o]! * Q)},${Math.round(verts[o + 1]! * Q)},${Math.round(verts[o + 2]! * Q)}`;
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const p = key(t, k), q = key(t, (k + 1) % 3);
      const ek = p < q ? p + '|' + q : q + '|' + p;
      const list = edges.get(ek);
      if (list) list.push(t); else edges.set(ek, [t]);
    }
  }
  const adj = new Int32Array(tris * 3).fill(-1);
  const adjCount = new Uint8Array(tris);
  for (const list of edges.values()) {
    if (list.length < 2) continue;
    for (const t of list) {
      for (const u of list) {
        if (u === t || adjCount[t]! >= 3) continue;
        let dup = false;
        for (let k = 0; k < adjCount[t]!; k++) if (adj[t * 3 + k] === u) { dup = true; break; }
        if (!dup) { adj[t * 3 + adjCount[t]!] = u; adjCount[t]!++; }
      }
    }
  }
  return { mesh, index, source: g, tris, verts, normals, cents, adj, adjCount };
}

export function mountFaceSelect(opts: FaceSelectOpts): FaceSelectHandle {
  const { root, scene, camera, dom, onChange, render } = opts;

  const infos: MeshInfo[] = [];
  forEachMesh(root, (mesh, i) => infos.push(buildInfo(mesh, i)));

  const selected = new Map<number, Set<number>>();  // meshIndex -> triangles
  const hidden = new Map<number, Set<number>>();
  for (const [k, list] of Object.entries(opts.initialHidden ?? {})) hidden.set(Number(k), new Set(list));

  let enabled = false;
  let tolCos = Math.cos(THREE.MathUtils.degToRad(15));
  let mode: GrowMode = 'planar';
  let hoverMesh: MeshInfo | null = null;
  let hoverTri = -1;
  let preview: number[] = [];
  /** An armed press: where it started, and whether it has since become a drag. */
  let down: { x: number; y: number; button: number; moved: boolean } | null = null;
  const DRAG_PX = 5; // below this a press-release is a click, above it the camera had it

  // ---- highlight overlays ----------------------------------------------------------------------
  const mkOverlay = (color: number, opacity: number, depthTest: boolean): THREE.Mesh => {
    const m = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthTest, depthWrite: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: OVERLAY_OFFSET, polygonOffsetUnits: OVERLAY_OFFSET,
      }),
    );
    m.renderOrder = 999;
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const selOverlay = mkOverlay(0x4ea1ff, 0.5, true);
  const prevOverlay = mkOverlay(0xffc76f, 0.42, true);
  const hoverOverlay = mkOverlay(0xffffff, 0.85, true);

  // The normal ARROW: on a thin wall the front and back faces project a few pixels apart, so
  // "which face am I on" is genuinely ambiguous without seeing where it points.
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.45, 0xffffff, 0.16, 0.09);
  arrow.visible = false;
  scene.add(arrow);

  /** Rewrite an overlay's geometry from a set of triangles, in the mesh's world space. */
  const paint = (overlay: THREE.Mesh, info: MeshInfo | null, tris: Iterable<number>): void => {
    if (!info) { overlay.visible = false; return; }
    const list = [...tris];
    if (!list.length) { overlay.visible = false; return; }
    info.mesh.updateWorldMatrix(true, false);
    const mat = info.mesh.matrixWorld;
    const out = new Float32Array(list.length * 9);
    const v = new THREE.Vector3();
    let o = 0;
    for (const t of list) {
      for (let k = 0; k < 3; k++) {
        v.set(info.verts[t * 9 + k * 3]!, info.verts[t * 9 + k * 3 + 1]!, info.verts[t * 9 + k * 3 + 2]!).applyMatrix4(mat);
        out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
      }
    }
    overlay.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    overlay.geometry = g;
    overlay.visible = true;
  };

  // ---- grow ---------------------------------------------------------------------------------

  /** Flood across shared edges from `seed`, taking any triangle whose normal is within the
   *  tolerance OF THE SEED. Seed-relative rather than neighbour-relative on purpose: chaining
   *  neighbour-to-neighbour walks all the way around a curved surface a fraction of a degree at a
   *  time, which is never what you meant by "these faces are basically the same face". */
  /** Is the edge between two triangles a convex fold (the surface rolling AWAY) or a concave crease
   *  (the surface folding back on itself)? Convex when the neighbour's centroid sits BEHIND this
   *  face's plane. This is the whole difference between "the bevel off the top of a paver" and "the
   *  bottom of the rut where two pavers meet" — they sit at similar angles and only the sign
   *  separates them. */
  const isConvex = (info: MeshInfo, t: number, u: number): boolean => {
    const dx = info.cents[u * 3]! - info.cents[t * 3]!;
    const dy = info.cents[u * 3 + 1]! - info.cents[t * 3 + 1]!;
    const dz = info.cents[u * 3 + 2]! - info.cents[t * 3 + 2]!;
    return info.normals[t * 3]! * dx + info.normals[t * 3 + 1]! * dy + info.normals[t * 3 + 2]! * dz < 0;
  };

  /** Below this, two faces are "the same plane" and the convex/concave sign is meaningless noise —
   *  the centroid offset is nearly in-plane, so its sign is arbitrary. Always join these. */
  const FLAT_EPS_COS = Math.cos(THREE.MathUtils.degToRad(8));

  const grow = (info: MeshInfo, seed: number): number[] => {
    const sx = info.normals[seed * 3]!, sy = info.normals[seed * 3 + 1]!, sz = info.normals[seed * 3 + 2]!;
    const seen = new Uint8Array(info.tris);
    const out: number[] = [];
    const stack = [seed];
    seen[seed] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      out.push(t);
      for (let k = 0; k < info.adjCount[t]!; k++) {
        const u = info.adj[t * 3 + k]!;
        if (u < 0 || seen[u]) continue;
        const ux = info.normals[u * 3]!, uy = info.normals[u * 3 + 1]!, uz = info.normals[u * 3 + 2]!;
        const dSeed = sx * ux + sy * uy + sz * uz;          // how far off the SEED plane
        if (mode === 'carve') {
          // CARVED-TILE mode: a tile is its flat top plus the slants that roll down off it, ending
          // where the neighbouring tile's slant comes back up — that meeting is a concave crease.
          // So: always cross a near-flat edge, otherwise cross only CONVEX folds, and never a
          // crease. The seed cone still caps how far down a slant may go.
          const dLocal = info.normals[t * 3]! * ux + info.normals[t * 3 + 1]! * uy + info.normals[t * 3 + 2]! * uz;
          if (dLocal < FLAT_EPS_COS) {
            if (!isConvex(info, t, u)) continue;            // concave crease — the rut bottom
            if (dSeed < tolCos) continue;                   // rolled too far from the tile's face
          }
        } else if (dSeed < tolCos) continue;                // PLANAR mode: one cone about the seed
        seen[u] = 1;
        stack.push(u);
      }
    }
    return out;
  };

  // ---- exhaustive partition --------------------------------------------------------------------

  // The same flood the hover preview uses, run to exhaustion instead of from a single seed: every
  // triangle lands in exactly one facet. Cached against the tolerance because the tolerance is not a
  // filter over some fixed truth — it IS the definition of what counts as one surface, so a change
  // to it invalidates the whole partition rather than refining it.
  let facetCache: { tol: number; mesh: MeshInfo; list: FacetInfo[]; byTri: Int32Array } | null = null;

  const partition = (info: MeshInfo): { list: FacetInfo[]; byTri: Int32Array } => {
    if (facetCache && facetCache.tol === tolCos && facetCache.mesh === info) return facetCache;
    const byTri = new Int32Array(info.tris).fill(-1);
    const list: FacetInfo[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), mid = new THREE.Vector3();
    for (let seed = 0; seed < info.tris; seed++) {
      if (byTri[seed]! >= 0) continue;
      const tris = grow(info, seed);
      const id = list.length;
      const centroid = new THREE.Vector3();
      let area = 0;
      for (const t of tris) {
        byTri[t] = id;
        a.set(info.verts[t * 9]!, info.verts[t * 9 + 1]!, info.verts[t * 9 + 2]!);
        b.set(info.verts[t * 9 + 3]!, info.verts[t * 9 + 4]!, info.verts[t * 9 + 5]!);
        c.set(info.verts[t * 9 + 6]!, info.verts[t * 9 + 7]!, info.verts[t * 9 + 8]!);
        // AREA-WEIGHT the centroid. An exporter's fan triangulation clusters many slivers at one
        // corner of a face, and a plain per-triangle mean would drag the anchor over there instead
        // of leaving it in the middle where a texture wants to be centred.
        const w = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
        area += w;
        mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        centroid.addScaledVector(mid, w);
      }
      if (area > 1e-12) centroid.multiplyScalar(1 / area);
      list.push({
        id, tris, centroid, area,
        normal: new THREE.Vector3(info.normals[seed * 3]!, info.normals[seed * 3 + 1]!, info.normals[seed * 3 + 2]!),
      });
    }
    // biggest first — that is the order you want to read them in, so make it the id order too
    list.sort((x, y) => y.area - x.area);
    const remap = new Int32Array(list.length);
    list.forEach((f, i) => { remap[f.id] = i; f.id = i; });
    for (let t = 0; t < byTri.length; t++) byTri[t] = remap[byTri[t]!]!;
    facetCache = { tol: tolCos, mesh: info, list, byTri };
    return facetCache;
  };

  /** Which mesh the panel is talking about: whatever is hovered, else the first (these models are
   *  single-mesh in practice, so this is only a fallback for multi-mesh props). */
  const primary = (): MeshInfo | null => hoverMesh ?? infos[0] ?? null;

  // ---- the all-facets overlay ------------------------------------------------------------------

  const groupOverlay = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true,
      polygonOffsetFactor: OVERLAY_OFFSET, polygonOffsetUnits: OVERLAY_OFFSET,
    }),
  );
  groupOverlay.renderOrder = 998;
  groupOverlay.frustumCulled = false;
  groupOverlay.visible = false;
  scene.add(groupOverlay);
  let showGroups = false;

  /** Golden-ratio hue stepping: adjacent ids land far apart in hue, and adjacent facets are exactly
   *  the ones you need to tell apart. */
  const facetColor = (id: number, out: THREE.Color): THREE.Color => out.setHSL((id * 0.61803398875) % 1, 0.62, 0.55);

  /** Draw an explicit list of triangle sets. `null` hides the overlay. */
  const paintSets = (sets: readonly (readonly number[])[] | null): void => {
    const info = primary();
    if (!sets || !sets.length || !info) { groupOverlay.visible = false; return; }
    const list = sets.map((tris, id) => ({ id, tris }));
    info.mesh.updateWorldMatrix(true, false);
    const m = info.mesh.matrixWorld;
    let n = 0;
    for (const f of list) n += f.tris.length;
    const pos = new Float32Array(n * 9);
    const col = new Float32Array(n * 9);
    const v = new THREE.Vector3(), c = new THREE.Color();
    let o = 0;
    for (const f of list) {
      facetColor(f.id, c);
      for (const t of f.tris) {
        for (let k = 0; k < 3; k++) {
          v.set(info.verts[t * 9 + k * 3]!, info.verts[t * 9 + k * 3 + 1]!, info.verts[t * 9 + k * 3 + 2]!).applyMatrix4(m);
          pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
          col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
          o += 3;
        }
      }
    }
    groupOverlay.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    groupOverlay.geometry = g;
    groupOverlay.visible = true;
  };

  /** Repaint whatever the overlay is currently showing (used after the partition changes). */
  const paintGroups = (): void => {
    const info = primary();
    paintSets(showGroups && info ? partition(info).list.map((f) => f.tris) : null);
  };

  const setOf = (map: Map<number, Set<number>>, i: number): Set<number> => {
    let s = map.get(i);
    if (!s) { s = new Set(); map.set(i, s); }
    return s;
  };

  const repaintSelection = (): void => {
    // one overlay, so draw the selection of the mesh currently under the cursor (single-mesh models
    // are the norm here; on a multi-mesh model the others stay hidden until you hover them)
    const info = hoverMesh ?? infos[0] ?? null;
    paint(selOverlay, info, info ? (selected.get(info.index) ?? []) : []);
  };

  const refreshPreview = (): void => {
    if (!enabled || !hoverMesh || hoverTri < 0) {
      preview = [];
      prevOverlay.visible = false;
      hoverOverlay.visible = false;
      arrow.visible = false;
      return;
    }
    preview = grow(hoverMesh, hoverTri);
    const sel = selected.get(hoverMesh.index);
    paint(prevOverlay, hoverMesh, sel ? preview.filter((t) => !sel.has(t)) : preview);
    paint(hoverOverlay, hoverMesh, [hoverTri]);

    const info = hoverMesh;
    info.mesh.updateWorldMatrix(true, false);
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(info.verts[hoverTri * 9 + k * 3]!, info.verts[hoverTri * 9 + k * 3 + 1]!, info.verts[hoverTri * 9 + k * 3 + 2]!));
    c.multiplyScalar(1 / 3).applyMatrix4(info.mesh.matrixWorld);
    const n = new THREE.Vector3(info.normals[hoverTri * 3]!, info.normals[hoverTri * 3 + 1]!, info.normals[hoverTri * 3 + 2]!)
      .transformDirection(info.mesh.matrixWorld);
    arrow.position.copy(c);
    arrow.setDirection(n);
    arrow.visible = true;
  };

  // ---- pointer -------------------------------------------------------------------------------

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const pick = (ev: PointerEvent | MouseEvent): void => {
    const r = dom.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(root, true);
    const hit = hits.find((h) => (h.object as THREE.Mesh).isMesh && h.faceIndex !== undefined);
    if (!hit) { hoverMesh = null; hoverTri = -1; return; }
    hoverMesh = infos.find((i) => i.mesh === hit.object) ?? null;
    // faceIndex counts triangles in the CURRENT geometry; if faces are hidden that is the filtered
    // one, so map it back to a source-triangle index or every edit after the first lands wrong.
    hoverTri = hoverMesh ? sourceTriangle(hoverMesh, hit.faceIndex!) : -1;
  };

  /** Filtered geometry renumbers triangles. Walk the source order, skipping hidden, to recover the
   *  original index of the n-th visible triangle. */
  const sourceTriangle = (info: MeshInfo, visibleIdx: number): number => {
    const h = hidden.get(info.index);
    if (!h || !h.size) return visibleIdx;
    let seen = -1;
    for (let t = 0; t < info.tris; t++) {
      if (h.has(t)) continue;
      if (++seen === visibleIdx) return t;
    }
    return -1;
  };

  const onMove = (ev: PointerEvent): void => {
    if (!enabled) return;
    if (down) {
      if (!down.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > DRAG_PX) down.moved = true;
      if (down.moved) return; // the camera is moving; re-picking every frame is noise
    }
    const prevTri = hoverTri, prevMesh = hoverMesh;
    pick(ev);
    if (hoverTri === prevTri && hoverMesh === prevMesh) return;
    refreshPreview();
    repaintSelection();
    onChange();
    render();
  };

  const commit = (add: boolean): void => {
    if (!hoverMesh || !preview.length) return;
    const s = setOf(selected, hoverMesh.index);
    for (const t of preview) { if (add) s.add(t); else s.delete(t); }
    refreshPreview();
    repaintSelection();
    onChange();
    render();
  };

  // A press only ARMS a selection; the release decides. Under DRAG_PX it was a click and commits,
  // past it the gesture was a camera move and is left alone — so edit mode never takes the mouse
  // away from you, it just adds a meaning to tapping. Deliberately no preventDefault/stopPropagation
  // here: OrbitControls has to receive the same pointerdown for the fallback to exist at all.
  const onDown = (ev: PointerEvent): void => {
    if (!enabled || (ev.button !== 0 && ev.button !== 2)) return;
    down = { x: ev.clientX, y: ev.clientY, button: ev.button, moved: false };
  };

  const onUp = (ev: PointerEvent): void => {
    const d = down;
    down = null;
    if (!enabled || !d || ev.button !== d.button) return;
    const moved = d.moved || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > DRAG_PX;
    pick(ev);
    refreshPreview();
    repaintSelection();
    if (moved) { onChange(); render(); return; } // it was an orbit/pan — just refresh the hover
    commit(d.button === 0);
  };
  const onContext = (ev: Event): void => { if (enabled) ev.preventDefault(); };
  const onLeave = (): void => { if (!enabled) return; hoverMesh = null; hoverTri = -1; refreshPreview(); render(); };

  // Moving onto a PANEL stops the canvas receiving pointermove, and pointerleave is not reliable
  // across a synthetic jump — so the last highlight would sit there looking live while the cursor is
  // somewhere else entirely. Watch the window and clear whenever the pointer is off the canvas.
  const onWindowMove = (ev: PointerEvent): void => {
    if (!enabled || ev.target === dom || hoverTri < 0) return;
    hoverMesh = null; hoverTri = -1;
    refreshPreview();
    onChange();
    render();
  };
  window.addEventListener('pointermove', onWindowMove, true);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerdown', onDown, true);
  // on WINDOW: a drag that ends off the canvas must still clear the armed press
  window.addEventListener('pointerup', onUp, true);
  dom.addEventListener('contextmenu', onContext);
  dom.addEventListener('pointerleave', onLeave);

  // ---- hiding ---------------------------------------------------------------------------------

  const applyHidden = (): void => {
    for (const info of infos) {
      const h = hidden.get(info.index);
      info.mesh.geometry = h && h.size ? filterGeometry(info.source, [...h].sort((a, b) => a - b)) : info.source;
    }
    hoverTri = -1;
    refreshPreview();
    repaintSelection();
    onChange();
    render();
  };

  return {
    setEnabled: (on) => {
      enabled = on;
      // mouseButtons are left alone: orbit stays on left-drag and pan on right-drag even while
      // editing, because the click/drag split decides per gesture rather than per mode
      down = null;
      if (!on) { hoverMesh = null; hoverTri = -1; }
      refreshPreview();
      repaintSelection();
      selOverlay.visible = on && selOverlay.visible;
      render();
    },
    setMode: (m) => { mode = m; facetCache = null; paintGroups(); refreshPreview(); onChange(); render(); },
    setTolerance: (deg) => {
      tolCos = Math.cos(THREE.MathUtils.degToRad(deg));
      facetCache = null; // the tolerance IS the partition; it cannot survive a change to it
      paintGroups();
      refreshPreview();
      onChange();
      render();
    },
    facets: () => { const info = primary(); return info ? partition(info).list : []; },
    setShowGroups: (on) => { showGroups = on; paintGroups(); render(); },
    paintSets: (sets) => { showGroups = false; paintSets(sets); render(); },
    selection: () => {
      const out: Record<string, number[]> = {};
      for (const [i, set] of selected) if (set.size) out[String(i)] = [...set].sort((a, b) => a - b);
      return out;
    },
    setSelection: (rec) => {
      selected.clear();
      for (const [k, tris] of Object.entries(rec)) if (tris.length) selected.set(Number(k), new Set(tris));
      repaintSelection();
      onChange();
      render();
    },
    highlightTris: (rec) => {
      const info = primary();
      if (!info || !rec) { prevOverlay.visible = false; render(); return; }
      paint(prevOverlay, info, rec[String(info.index)] ?? []);
      render();
    },
    highlightFacet: (id) => {
      const info = primary();
      if (!info || id === null) { prevOverlay.visible = false; render(); return; }
      const f = partition(info).list[id];
      paint(prevOverlay, info, f ? f.tris : []);
      render();
    },
    commitFacet: (id, add) => {
      const info = primary();
      if (!info) return;
      const f = partition(info).list[id];
      if (!f) return;
      const set = setOf(selected, info.index);
      for (const t of f.tris) { if (add) set.add(t); else set.delete(t); }
      repaintSelection();
      onChange();
      render();
    },
    counts: () => ({
      hover: hoverTri >= 0 ? 1 : 0,
      preview: preview.length,
      selected: [...selected.values()].reduce((a, s) => a + s.size, 0),
      hidden: [...hidden.values()].reduce((a, s) => a + s.size, 0),
    }),
    hideSelected: () => {
      for (const [i, s] of selected) { const h = setOf(hidden, i); for (const t of s) h.add(t); }
      selected.clear();
      applyHidden();
    },
    unhideAll: () => { hidden.clear(); applyHidden(); },
    clearSelection: () => { selected.clear(); repaintSelection(); onChange(); render(); },
    sourceHash: () => geometryHashOf(infos.map((i) => i.source)),
    hidden: () => {
      const out: Record<string, number[]> = {};
      for (const [i, s] of hidden) if (s.size) out[String(i)] = [...s].sort((a, b) => a - b);
      return out;
    },
    dispose: () => {
      window.removeEventListener('pointermove', onWindowMove, true);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      dom.removeEventListener('contextmenu', onContext);
      dom.removeEventListener('pointerleave', onLeave);
      for (const o of [selOverlay, prevOverlay, hoverOverlay, groupOverlay]) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); scene.remove(o); }
      scene.remove(arrow);
    },
  };
}
