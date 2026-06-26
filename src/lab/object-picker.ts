// ============================================================================
// src/lab/object-picker.ts — the OBJECT PICKER (vertical side LIST of thumbnails).
// ============================================================================
//
// Shown in object mode (?object=…): a dark HUD LIST down the LEFT side, one ROW per
// auto-discovered WorldObject (door, table, barrel, chest, wall, bookshelf, bed,
// stair-room, …) = a small rendered thumbnail + the object's NAME. Clicking a row
// navigates to ?object=<id> while PRESERVING the current &variant / &seed / &boxes
// params, so you can flip between objects without losing your view settings. The
// current object's row is highlighted.
//
// HOW THE THUMBNAILS ARE MADE: each WorldObject is an async GLB load, so we build the
// icons on load. ONE tiny shared offscreen WebGLRenderer (96×96) renders every object
// in turn — build it, frame a three-quarter camera from its bounds, snap a data-URL,
// then dispose its scene-graph + GPU buffers before the next. The data-URL is dropped
// straight onto each icon's <img>. Lightweight: one renderer, one object in memory at
// a time, sequential. Placeholder icons show immediately; thumbnails fill in as they
// render so the strip is usable before all the GLBs have loaded.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import * as THREE from 'three';
import type { WorldObject } from './world-object.ts';

const ICON_PX = 96; // offscreen render resolution (kept low — these are tiny chips)

export interface ObjectPickerOpts {
  /** Where to mount the strip (typically document.body). */
  container: HTMLElement;
  /** All discovered WorldObjects, keyed by id. */
  objects: Map<string, WorldObject>;
  /** Sorted object ids (display order). */
  objIds: string[];
  /** The currently shown object id (highlighted). */
  currentId: string;
  /** Current URL params, so a click can PRESERVE variant/seed/boxes. */
  params: URLSearchParams;
}

/**
 * Mount the picker strip and asynchronously fill in each icon's rendered thumbnail.
 * Returns once the strip DOM is mounted (thumbnails keep rendering in the background).
 */
export async function buildObjectPicker(opts: ObjectPickerOpts): Promise<void> {
  const { container, objects, objIds, currentId, params } = opts;

  // ---- the list shell (dark HUD, left side, vertical, scrolls if tall) ----
  const strip = document.createElement('div');
  strip.id = 'object-picker';
  Object.assign(strip.style, {
    position: 'fixed',
    left: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '156px',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    padding: '8px',
    background: 'rgba(10,10,22,.72)',
    border: '1px solid rgba(120,130,170,.22)',
    borderRadius: '12px',
    zIndex: '20',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)',
  } as Partial<CSSStyleDeclaration>);

  // build a chip per object (placeholder first, thumbnail fills in async)
  const imgs = new Map<string, HTMLImageElement>();
  for (const id of objIds) {
    const obj = objects.get(id);
    const current = id === currentId;

    const chip = document.createElement('a');
    // PRESERVE variant/seed/boxes; switch only the object id (and only keep variant if it
    // exists on the target object — otherwise it falls back to that object's first variant).
    const next = new URLSearchParams(params);
    next.set('object', id);
    const keptVariant = next.get('variant');
    if (keptVariant && obj && !obj.variants.includes(keptVariant)) next.delete('variant');
    chip.href = `${location.pathname}?${next.toString()}`;
    chip.title = obj ? `${obj.name} (${id})` : id;
    Object.assign(chip.style, {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      boxSizing: 'border-box',
      padding: '4px 6px',
      borderRadius: '8px',
      textDecoration: 'none',
      cursor: 'pointer',
      background: current ? 'rgba(78,161,255,.18)' : 'transparent',
      border: current ? '1px solid rgba(120,180,255,.85)' : '1px solid transparent',
    } as Partial<CSSStyleDeclaration>);
    if (!current) {
      chip.addEventListener('mouseenter', () => { chip.style.background = 'rgba(120,130,170,.16)'; });
      chip.addEventListener('mouseleave', () => { chip.style.background = 'transparent'; });
    }

    const img = document.createElement('img');
    Object.assign(img.style, {
      width: '34px',
      height: '34px',
      flex: '0 0 auto',
      borderRadius: '6px',
      background: 'rgba(30,32,48,.9)',
      objectFit: 'contain',
    } as Partial<CSSStyleDeclaration>);
    img.width = 34; img.height = 34;
    img.alt = id;
    imgs.set(id, img);

    const label = document.createElement('span');
    label.textContent = obj ? obj.name : id;
    Object.assign(label.style, {
      font: '12px/1.2 system-ui',
      color: current ? '#cfe3ff' : '#aab',
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    } as Partial<CSSStyleDeclaration>);

    chip.appendChild(img);
    chip.appendChild(label);
    strip.appendChild(chip);
  }
  container.appendChild(strip);

  // ---- render each object's thumbnail with ONE shared tiny offscreen renderer ----
  // (sequential: build → frame → snapshot data-URL → dispose, one object in memory at a time)
  let thumbRenderer: THREE.WebGLRenderer | null = null;
  try {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(ICON_PX, ICON_PX);
    thumbRenderer.shadowMap.enabled = false;
  } catch {
    // No WebGL for thumbnails (e.g. context limit) — leave the placeholder chips. The
    // picker still works as a clickable strip; only the rendered previews are skipped.
    return;
  }

  for (const id of objIds) {
    const obj = objects.get(id);
    const img = imgs.get(id);
    if (!obj || !img) continue;
    try {
      const url = await renderThumbnail(thumbRenderer, obj);
      if (url) img.src = url;
    } catch {
      // a single object failing to build/render must not break the rest of the strip.
    }
    // yield to the event loop so the page stays responsive while thumbnails stream in
    await new Promise((r) => setTimeout(r, 0));
  }

  thumbRenderer.dispose();
}

/**
 * Build ONE object, frame a three-quarter camera from its bounds, render to the shared
 * renderer, and return a PNG data-URL. Disposes the object's geometries/materials after.
 */
async function renderThumbnail(renderer: THREE.WebGLRenderer, obj: WorldObject): Promise<string | null> {
  const built = await obj.build(obj.variants[0] ?? '', 1);

  const scene = new THREE.Scene();
  // soft studio lighting matching the main scene's mood (no ground — alpha background)
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(3, 5, 3);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x8899cc, 0x33301f, 1.0));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  scene.add(built.root);

  // frame from the real bounds: look at the centre, pull back to fit the whole prop
  const box = new THREE.Box3().setFromObject(built.root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = 0.5 * Math.hypot(size.x, size.y, size.z) || 1;
  const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  const d = radius * 2.6;
  cam.position.set(center.x + d * 0.72, center.y + d * 0.5, center.z + d * 0.72);
  cam.lookAt(center);

  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');

  // dispose the object's GPU resources so memory stays flat across all thumbnails
  disposeObject(built.root);
  return url;
}

/** Free all geometries + materials under a root (so per-thumbnail builds don't leak). */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
}
