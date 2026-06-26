// ============================================================================
// src/lab/object-picker.ts — the OBJECT PICKER (TEXT-ONLY grouped side LIST).
// ============================================================================
//
// Shown in object mode (?object=…): a dark HUD LIST down the LEFT side, GROUPED by
// CATEGORY (Structure · Furniture · Containers · Decor · Featured · Procedural · …)
// under small text headers. One ROW per WorldObject = just the object's NAME — NO
// rendered thumbnail, NO GLB loading on page load. A GLB is requested ONLY when an
// object is actually picked (i.e. when the page navigates to ?object=<id>). This is
// the load-time fix: the list is plain text and instant.
//
// Clicking a row navigates to ?object=<id> while PRESERVING the current
// &variant / &seed / &boxes params, so you can flip between objects without losing
// your view settings. The current object's row is highlighted. The list scrolls if
// it is taller than the viewport.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import type { WorldObject } from './world-object.ts';

/** One category section: a header label + the ids (in display order) under it. */
export interface PickerGroup {
  /** The header text (e.g. "Structure"). */
  label: string;
  /** Object ids in this group, in display order. */
  ids: string[];
}

export interface ObjectPickerOpts {
  /** Where to mount the strip (typically document.body). */
  container: HTMLElement;
  /** All known WorldObjects, keyed by id (for names + variant-preservation checks). */
  objects: Map<string, WorldObject>;
  /** The grouped rows to render, in section order. */
  groups: PickerGroup[];
  /** The currently shown object id (highlighted). */
  currentId: string;
  /** Current URL params, so a click can PRESERVE variant/seed/boxes. */
  params: URLSearchParams;
}

/**
 * Mount the TEXT-ONLY grouped picker list. Synchronous + instant: no WebGL, no GLB
 * loads — just DOM. (A GLB loads only after a row is clicked and the page reloads
 * on the new ?object=<id>.)
 */
export function buildObjectPicker(opts: ObjectPickerOpts): void {
  const { container, objects, groups, currentId, params } = opts;

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
    gap: '1px',
    width: '178px',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    padding: '8px',
    background: 'rgba(10,10,22,.72)',
    border: '1px solid rgba(120,130,170,.22)',
    borderRadius: '12px',
    zIndex: '20',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)',
  } as Partial<CSSStyleDeclaration>);

  for (const group of groups) {
    if (group.ids.length === 0) continue;

    // ---- a small text section header ----
    const header = document.createElement('div');
    header.textContent = group.label;
    Object.assign(header.style, {
      font: '600 10px/1.4 system-ui',
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      color: 'rgba(150,165,205,.85)',
      padding: '8px 6px 3px',
      marginTop: '2px',
      borderTop: '1px solid rgba(120,130,170,.14)',
      position: 'sticky',
      top: '0',
      background: 'rgba(10,10,22,.92)',
    } as Partial<CSSStyleDeclaration>);
    strip.appendChild(header);

    // ---- one clickable NAME row per object (text only) ----
    for (const id of group.ids) {
      const obj = objects.get(id);
      const current = id === currentId;

      const row = document.createElement('a');
      // PRESERVE variant/seed/boxes; switch only the object id (keep variant only if the
      // target object HAS it — otherwise drop it so it falls back to that object's first).
      const next = new URLSearchParams(params);
      next.set('object', id);
      const keptVariant = next.get('variant');
      if (keptVariant && obj && !obj.variants.includes(keptVariant)) next.delete('variant');
      row.href = `${location.pathname}?${next.toString()}`;
      row.title = obj ? `${obj.name} (${id})` : id;
      if (current) row.dataset['current'] = '1';
      Object.assign(row.style, {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 8px',
        borderRadius: '7px',
        textDecoration: 'none',
        cursor: 'pointer',
        font: '12px/1.25 system-ui',
        color: current ? '#cfe3ff' : '#c2c8da',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        background: current ? 'rgba(78,161,255,.18)' : 'transparent',
        border: current ? '1px solid rgba(120,180,255,.85)' : '1px solid transparent',
      } as Partial<CSSStyleDeclaration>);
      row.textContent = obj ? obj.name : id;
      if (!current) {
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(120,130,170,.16)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      }
      strip.appendChild(row);
    }
  }

  container.appendChild(strip);

  // Scroll the current row into view (the list can be long once the KayKit pack lands).
  const active = strip.querySelector('a[data-current="1"]') as HTMLElement | null;
  active?.scrollIntoView({ block: 'center' });
}
