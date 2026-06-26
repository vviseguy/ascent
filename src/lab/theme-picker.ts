// ============================================================================
// src/lab/theme-picker.ts — the THEME dropdown (object mode only).
// ============================================================================
//
// A small dark-HUD panel (bottom-left) with a single <select> that switches the
// global dungeon THEME (themes.ts). Like the object picker, it works by NAVIGATION:
// changing the selection sets `?theme=<id>` (or drops it for "None") and reloads,
// PRESERVING the current object / variant / seed / fit params. A reload (rather than a
// live re-skin) keeps the lab's boot path single — and the GLB template is cached, so
// the rebuild is cheap. The current theme is preselected.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import { THEME_ORDER, THEMES } from './themes.ts';

export interface ThemePickerOpts {
  /** Where to mount (typically document.body). */
  container: HTMLElement;
  /** The active theme id, or null for "None" (raw atlas). */
  currentId: string | null;
  /** Current URL params, so switching preserves object/variant/seed/fit. */
  params: URLSearchParams;
}

/** Mount the theme dropdown. On change it navigates to the new `?theme=` (or none). */
export function buildThemePicker(opts: ThemePickerOpts): void {
  const { container, currentId, params } = opts;

  const panel = document.createElement('div');
  panel.id = 'theme-picker';
  Object.assign(panel.style, {
    position: 'fixed',
    left: '10px',
    bottom: '10px',
    width: '210px',
    color: '#bcd',
    font: '11px/1.4 system-ui',
    background: 'rgba(10,10,22,.78)',
    border: '1px solid rgba(120,130,170,.28)',
    borderRadius: '10px',
    padding: '10px 12px',
    zIndex: '25',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)',
    userSelect: 'none',
  } as Partial<CSSStyleDeclaration>);

  const title = document.createElement('div');
  title.textContent = 'THEME';
  Object.assign(title.style, { color: '#9ab', letterSpacing: '.08em', fontSize: '10px', marginBottom: '6px', opacity: '.8' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(title);

  const sel = document.createElement('select');
  Object.assign(sel.style, { width: '100%', background: 'rgba(20,20,34,.9)', color: '#cde', border: '1px solid rgba(120,130,170,.3)', borderRadius: '6px', padding: '4px' } as Partial<CSSStyleDeclaration>);

  // "None" = raw KayKit atlas (no theme).
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None (raw atlas)';
  if (currentId === null) none.selected = true;
  sel.appendChild(none);

  for (const id of THEME_ORDER) {
    const theme = THEMES[id];
    if (!theme) continue;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = theme.name;
    o.title = theme.describe;
    if (id === currentId) o.selected = true;
    sel.appendChild(o);
  }

  // A one-line description of the selected theme, kept in sync.
  const desc = document.createElement('div');
  Object.assign(desc.style, { marginTop: '6px', fontSize: '10px', opacity: '.6', lineHeight: '1.35' } as Partial<CSSStyleDeclaration>);
  const syncDesc = (): void => {
    const t = sel.value ? THEMES[sel.value] : undefined;
    desc.textContent = t ? t.describe : 'The pack as KayKit ships it — flat atlas swatches.';
  };
  syncDesc();

  sel.addEventListener('change', () => {
    const next = new URLSearchParams(params);
    if (sel.value) next.set('theme', sel.value);
    else next.delete('theme');
    location.href = `${location.pathname}?${next.toString()}`;
  });

  panel.appendChild(sel);
  panel.appendChild(desc);
  container.appendChild(panel);
}
