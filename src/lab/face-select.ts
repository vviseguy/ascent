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
  /** OrbitControls — left/right drag are taken over while editing, so they get suppressed. Typed
   *  structurally (and loosely, matching three's optional MOUSE enum) to avoid importing the
   *  controls class into a module that only needs to mute two buttons. */
  controls: { mouseButtons: { LEFT?: number | null | undefined; MIDDLE?: number | null | undefined; RIGHT?: number | null | undefined } };
  initialHidden?: Readonly<Record<string, number[]>>;
  /** Fired whenever counts change, so the panel can redraw its readout. */
  onChange: () => void;
  render: () => void;
}

export interface FaceSelectHandle {
  setEnabled: (on: boolean) => void;
  setTolerance: (deg: number) => void;
  counts: () => { hover: number; preview: number; selected: number; hidden: number };
  hideSelected: () => void;
  unhideAll: () => void;
  clearSelection: () => void;
  /** Hidden triangles per mesh index, sorted — the shape the store wants. */
  hidden: () => Record<string, number[]>;
  /** Hash of the UNFILTERED source geometry — what a stored edit must be checked against. */
  sourceHash: () => string;
  dispose: () => void;
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
  return { mesh, index, source: g, tris, verts, normals, adj, adjCount };
}

export function mountFaceSelect(opts: FaceSelectOpts): FaceSelectHandle {
  const { root, scene, camera, dom, controls, onChange, render } = opts;

  const infos: MeshInfo[] = [];
  forEachMesh(root, (mesh, i) => infos.push(buildInfo(mesh, i)));

  const selected = new Map<number, Set<number>>();  // meshIndex -> triangles
  const hidden = new Map<number, Set<number>>();
  for (const [k, list] of Object.entries(opts.initialHidden ?? {})) hidden.set(Number(k), new Set(list));

  let enabled = false;
  let tolCos = Math.cos(THREE.MathUtils.degToRad(15));
  let hoverMesh: MeshInfo | null = null;
  let hoverTri = -1;
  let preview: number[] = [];

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
        const d = sx * info.normals[u * 3]! + sy * info.normals[u * 3 + 1]! + sz * info.normals[u * 3 + 2]!;
        if (d < tolCos) continue;
        seen[u] = 1;
        stack.push(u);
      }
    }
    return out;
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

  const onDown = (ev: PointerEvent): void => {
    if (!enabled || (ev.button !== 0 && ev.button !== 2)) return;
    ev.preventDefault();
    ev.stopPropagation();
    pick(ev);
    refreshPreview();
    commit(ev.button === 0);
  };
  const onContext = (ev: Event): void => { if (enabled) ev.preventDefault(); };
  const onLeave = (): void => { if (!enabled) return; hoverMesh = null; hoverTri = -1; refreshPreview(); render(); };

  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerdown', onDown, true);
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

  const savedButtons = { ...controls.mouseButtons };

  return {
    setEnabled: (on) => {
      enabled = on;
      // left = select, right = deselect; orbit moves to the middle button while editing
      if (on) { controls.mouseButtons.LEFT = null; controls.mouseButtons.RIGHT = null; }
      else { controls.mouseButtons.LEFT = savedButtons.LEFT; controls.mouseButtons.RIGHT = savedButtons.RIGHT; }
      if (!on) { hoverMesh = null; hoverTri = -1; }
      refreshPreview();
      repaintSelection();
      selOverlay.visible = on && selOverlay.visible;
      render();
    },
    setTolerance: (deg) => { tolCos = Math.cos(THREE.MathUtils.degToRad(deg)); refreshPreview(); onChange(); render(); },
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
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerdown', onDown, true);
      dom.removeEventListener('contextmenu', onContext);
      dom.removeEventListener('pointerleave', onLeave);
      for (const o of [selOverlay, prevOverlay, hoverOverlay]) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); scene.remove(o); }
      scene.remove(arrow);
      controls.mouseButtons.LEFT = savedButtons.LEFT;
      controls.mouseButtons.RIGHT = savedButtons.RIGHT;
    },
  };
}
