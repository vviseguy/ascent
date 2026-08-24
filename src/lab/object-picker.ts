// ============================================================================
// src/lab/object-picker.ts — the content PICKER (TEXT-ONLY, double-nested dropdowns).
// ============================================================================
//
// A dark HUD LIST down the LEFT side, DOUBLE-NESTED into collapsible dropdowns:
//   level 1  =  PACK     (KayKit Dungeon · KayKit Furniture · … · Procedural)
//   level 2  =  GROUPING (Structure · Furniture · Containers · …)
//   level 3  =  one ROW per entry = just its NAME
// Built with native <details>/<summary> so collapse/expand needs no custom JS state and
// stays keyboard-accessible. Everything starts COLLAPSED except the branch holding the
// current entry, which is opened and scrolled into view.
//
// It is text-only — NO rendered thumbnails, NO GLB loading on page load. A model loads
// ONLY when an entry is picked (the page navigates to ?object=<id> / ?element=<id>). Rows
// PRESERVE the current &seed/&boxes (+ &variant for objects), so you flip between assets
// without losing your view settings. The current row is highlighted.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import type { WorldObject } from './world-object.ts';

/** Whether a row opens a WorldObject (?object=) or a LabElement (?element=). */
export type PickerKind = 'object' | 'element';

/** One clickable entry = a name + its id + what kind of thing it opens. */
export interface PickerEntry {
  id: string;
  name: string;
  kind: PickerKind;
}

/** A level-2 grouping: a header label + its entries (in display order). */
export interface PickerGroup {
  label: string;
  entries: PickerEntry[];
}

/** A level-1 pack: a header label + its groupings (in display order). */
export interface PickerPack {
  label: string;
  groups: PickerGroup[];
}

export interface ObjectPickerOpts {
  /** Where to mount the strip (typically document.body). */
  container: HTMLElement;
  /** The nested packs → groups → entries to render, in display order. */
  packs: PickerPack[];
  /** The currently shown entry id (highlighted + its branch opened), or null. */
  currentId: string | null;
  /** Current URL params, so a click can PRESERVE seed/boxes (+ variant for objects). */
  params: URLSearchParams;
  /** All known WorldObjects (to drop a stale &variant when switching to an object that lacks it). */
  objects: Map<string, WorldObject>;
}

/** Build the href for an entry: switch object/element id, preserve view params. */
function hrefFor(entry: PickerEntry, params: URLSearchParams, objects: Map<string, WorldObject>): string {
  const next = new URLSearchParams(params);
  if (entry.kind === 'object') {
    next.set('object', entry.id);
    next.delete('element');
    // keep &variant only if the target object HAS it — else drop so it falls back to its first.
    const keptVariant = next.get('variant');
    const obj = objects.get(entry.id);
    if (keptVariant && obj && !obj.variants.includes(keptVariant)) next.delete('variant');
  } else {
    next.set('element', entry.id);
    next.delete('object');
    next.delete('variant'); // elements have no variants
  }
  return `${location.pathname}?${next.toString()}`;
}

/**
 * Mount the TEXT-ONLY nested picker. Synchronous + instant: no WebGL, no GLB loads — just
 * DOM. (A model loads only after a row is clicked and the page reloads on the new id.)
 */
export function buildObjectPicker(opts: ObjectPickerOpts): void {
  const { container, packs, currentId, params, objects } = opts;

  // ---- the list shell (dark HUD, left side, vertical, scrolls if tall) ----
  const strip = document.createElement('div');
  strip.id = 'object-picker';
  Object.assign(strip.style, {
    position: 'fixed',
    left: '10px',
    /* ANCHORED, not centred. It used to sit at `top: 50%` with a translate, which is fine for a short
       list and wrong for a long one: the taller it grows the further it creeps UP, until the first
       entries are behind the top bar and you cannot see where the list begins. Spanning top-to-bottom
       instead starts it in the same place every time and gives it the whole window, so far more of the
       catalogue is in view at once. 54px is the drawer rail's offset (drawers.ts) — the top bar's
       height, in one convention rather than two. */
    top: '54px',
    bottom: '54px',
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: '208px',
    overflowY: 'auto',
    padding: '8px',
    background: 'rgba(10,10,22,.72)',
    border: '1px solid rgba(120,130,170,.22)',
    borderRadius: '12px',
    zIndex: '20',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)',
  } as Partial<CSSStyleDeclaration>);

  for (const pack of packs) {
    const packEntries = pack.groups.reduce((n, g) => n + g.entries.length, 0);
    if (packEntries === 0) continue;
    const packHasCurrent = currentId !== null && pack.groups.some((g) => g.entries.some((e) => e.id === currentId));

    // ---- level 1: the pack dropdown ----
    const packDetails = document.createElement('details');
    if (packHasCurrent) packDetails.open = true;
    const packSummary = document.createElement('summary');
    Object.assign(packSummary.style, {
      font: '700 11px/1.5 system-ui',
      letterSpacing: '.04em',
      color: 'rgba(196,208,240,.95)',
      padding: '6px 6px 6px 4px',
      cursor: 'pointer',
      userSelect: 'none',
      borderTop: '1px solid rgba(120,130,170,.16)',
      borderRadius: '6px',
    } as Partial<CSSStyleDeclaration>);
    packSummary.innerHTML = `${pack.label} <span style="opacity:.45;font-weight:500">${packEntries}</span>`;
    packDetails.appendChild(packSummary);

    for (const group of pack.groups) {
      if (group.entries.length === 0) continue;
      const groupHasCurrent = currentId !== null && group.entries.some((e) => e.id === currentId);

      // ---- level 2: the grouping dropdown ----
      const groupDetails = document.createElement('details');
      if (groupHasCurrent) groupDetails.open = true;
      Object.assign(groupDetails.style, { marginLeft: '8px' } as Partial<CSSStyleDeclaration>);
      const groupSummary = document.createElement('summary');
      Object.assign(groupSummary.style, {
        font: '600 10px/1.4 system-ui',
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'rgba(150,165,205,.8)',
        padding: '5px 6px 4px',
        cursor: 'pointer',
        userSelect: 'none',
      } as Partial<CSSStyleDeclaration>);
      groupSummary.innerHTML = `${group.label} <span style="opacity:.5;font-weight:400">${group.entries.length}</span>`;
      groupDetails.appendChild(groupSummary);

      // ---- level 3: one clickable NAME row per entry (text only) ----
      for (const entry of group.entries) {
        const current = entry.id === currentId;
        const row = document.createElement('a');
        row.href = hrefFor(entry, params, objects);
        row.title = `${entry.name} (${entry.id})`;
        if (current) row.dataset['current'] = '1';
        Object.assign(row.style, {
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 8px 4px 14px',
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
        row.textContent = entry.name;
        if (!current) {
          row.addEventListener('mouseenter', () => { row.style.background = 'rgba(120,130,170,.16)'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        }
        groupDetails.appendChild(row);
      }
      packDetails.appendChild(groupDetails);
    }
    strip.appendChild(packDetails);
  }

  container.appendChild(strip);

  // Scroll the current row into view (the list is long once every pack lands).
  const active = strip.querySelector('a[data-current="1"]') as HTMLElement | null;
  active?.scrollIntoView({ block: 'center' });
}
