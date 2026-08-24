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
import { forEachMesh, filterGeometry, geometryHashOf, sourceGeometry } from './face-surfaces.ts';
import { buildTopology, growFacet, partitionFacets, type GrowMode, type FacetInfo, type MeshTopology, type Partition } from './facets.ts';

// The PARTITION itself lives in facets.ts — the interactive picker and the build-time anchor
// baker (group-anchors.ts) must agree about what "one facet" is, so there is one implementation
// and both call it. Re-exported here so existing importers keep their single import.
export type { GrowMode, FacetInfo } from './facets.ts';

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

/** One mesh, plus the pure topology facets.ts computed for it. The scene-graph half (which mesh,
 *  which depth-first index) is all this layer adds — everything geometric is shared. */
type MeshInfo = MeshTopology & { mesh: THREE.Mesh; index: number };

const OVERLAY_OFFSET = -2; // polygon offset units: sit the highlight just in front of the surface

function buildInfo(mesh: THREE.Mesh, index: number): MeshInfo {
  // SOURCE, not mesh.geometry: on a cold load the build has already applied the stored hidden set,
  // so mesh.geometry is the FILTERED mesh. Numbering topology off that while the stored indices
  // number the original is exactly the "selection lands on the wrong faces" bug.
  return { ...buildTopology(sourceGeometry(mesh)), mesh, index };
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
        v.set(info.pos[t * 9 + k * 3]!, info.pos[t * 9 + k * 3 + 1]!, info.pos[t * 9 + k * 3 + 2]!).applyMatrix4(mat);
        out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
      }
    }
    overlay.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    overlay.geometry = g;
    overlay.visible = true;
  };

  // ---- grow + the exhaustive partition ---------------------------------------------------------

  // Both live in facets.ts. The picker only supplies the CURRENT mode/tolerance and caches the
  // answer, because the tolerance is not a filter over some fixed truth — it IS the definition of
  // what counts as one surface, so a change to it invalidates the partition rather than refining it.
  const grow = (info: MeshInfo, seed: number): number[] => growFacet(info, seed, mode, tolCos);

  let facetCache: { tol: number; mode: GrowMode; mesh: MeshInfo; part: Partition } | null = null;

  const partition = (info: MeshInfo): Partition => {
    if (facetCache && facetCache.tol === tolCos && facetCache.mode === mode && facetCache.mesh === info) return facetCache.part;
    const part = partitionFacets(info, mode, tolCos);
    facetCache = { tol: tolCos, mode, mesh: info, part };
    return part;
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
          v.set(info.pos[t * 9 + k * 3]!, info.pos[t * 9 + k * 3 + 1]!, info.pos[t * 9 + k * 3 + 2]!).applyMatrix4(m);
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
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(info.pos[hoverTri * 9 + k * 3]!, info.pos[hoverTri * 9 + k * 3 + 1]!, info.pos[hoverTri * 9 + k * 3 + 2]!));
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
