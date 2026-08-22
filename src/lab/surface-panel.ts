// ============================================================================
// src/lab/surface-panel.ts — the SURFACES panel (face selection + hide).
// ============================================================================
//
// Deliberately dormant: the checkbox is off by default, and while it is off the picker adds no
// listeners that matter and orbit behaves exactly as before. Face editing is an occasional job, and
// a tool that quietly steals the left mouse button is worse than one you have to switch on.
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

import type { FaceSelectHandle } from './face-select.ts';

export interface SurfacePanelOpts {
  container: HTMLElement;
  select: FaceSelectHandle;
  /** Persist the current hidden set for this mesh. */
  save: () => Promise<{ ok: boolean; error?: string }>;
  /** Shown so it is obvious WHICH mesh an edit is attached to (the store is keyed by mesh URL). */
  meshUrl: string;
  /** Rebuild the object — hiding changes the collision footprint, which is fitted at build time. */
  refit: () => void;
}

const BTN = {
  flex: '1 1 auto', padding: '4px 6px', background: '#23233a', color: '#cde',
  border: '1px solid #34344e', borderRadius: '5px', cursor: 'pointer', font: '10px system-ui',
} as Partial<CSSStyleDeclaration>;

export function buildSurfacePanel(opts: SurfacePanelOpts): void {
  const { container, select, save, meshUrl, refit } = opts;

  const panel = document.createElement('details');
  panel.id = 'surface-panel';
  Object.assign(panel.style, {
    position: 'fixed', left: '484px', top: '84px', width: '232px', zIndex: '25',
    color: '#bcd', font: '11px/1.4 system-ui',
    background: 'rgba(10,10,22,.84)', border: '1px solid rgba(120,130,170,.28)',
    borderRadius: '10px', padding: '8px 10px', boxShadow: '0 4px 18px rgba(0,0,0,.45)',
  } as Partial<CSSStyleDeclaration>);

  const summary = document.createElement('summary');
  summary.innerHTML = '<b style="color:#cfe3ff">SURFACES</b>';
  Object.assign(summary.style, { cursor: 'pointer', letterSpacing: '.04em', marginBottom: '6px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(summary);

  const note = document.createElement('div');
  note.textContent = 'hover to grow a face · left add · right remove';
  Object.assign(note.style, { opacity: '.55', fontSize: '10px', margin: '0 0 8px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(note);

  // --- enable ---
  const enable = document.createElement('label');
  Object.assign(enable.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '0 0 8px' } as Partial<CSSStyleDeclaration>);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  const enableTxt = document.createElement('span');
  enableTxt.textContent = 'edit faces (takes the mouse)';
  enable.append(cb, enableTxt);
  panel.appendChild(enable);

  // --- tolerance ---
  const tolWrap = document.createElement('label');
  Object.assign(tolWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 4px' } as Partial<CSSStyleDeclaration>);
  const tolTxt = document.createElement('span');
  tolTxt.textContent = 'grow ≤';
  Object.assign(tolTxt.style, { flex: '0 0 42px', color: '#cfe3ff', fontWeight: '600' } as Partial<CSSStyleDeclaration>);
  const tol = document.createElement('input');
  tol.type = 'range'; tol.min = '0'; tol.max = '90'; tol.step = '0.5'; tol.value = '15';
  Object.assign(tol.style, { flex: '1 1 auto', accentColor: '#ffc76f' } as Partial<CSSStyleDeclaration>);
  const tolVal = document.createElement('span');
  Object.assign(tolVal.style, { flex: '0 0 30px', textAlign: 'right', fontSize: '10px' } as Partial<CSSStyleDeclaration>);
  tolWrap.append(tolTxt, tol, tolVal);
  panel.appendChild(tolWrap);

  const tolNote = document.createElement('div');
  tolNote.textContent = 'how far off coplanar a neighbour may be and still join';
  Object.assign(tolNote.style, { opacity: '.5', fontSize: '9px', margin: '0 0 8px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(tolNote);

  // --- readout: the three tiers, colour-matched to what is drawn in the viewport ---
  const read = document.createElement('div');
  Object.assign(read.style, { fontSize: '10px', margin: '0 0 8px', lineHeight: '1.6' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(read);

  const rowA = document.createElement('div');
  Object.assign(rowA.style, { display: 'flex', gap: '4px', marginBottom: '4px' } as Partial<CSSStyleDeclaration>);
  const bHide = document.createElement('button'); bHide.textContent = 'Hide selected'; Object.assign(bHide.style, BTN);
  const bClear = document.createElement('button'); bClear.textContent = 'Clear'; Object.assign(bClear.style, BTN);
  rowA.append(bHide, bClear);
  panel.appendChild(rowA);

  const rowB = document.createElement('div');
  Object.assign(rowB.style, { display: 'flex', gap: '4px' } as Partial<CSSStyleDeclaration>);
  const bUnhide = document.createElement('button'); bUnhide.textContent = 'Unhide all'; Object.assign(bUnhide.style, BTN);
  const bSave = document.createElement('button'); bSave.textContent = 'Save'; Object.assign(bSave.style, BTN);
  rowB.append(bUnhide, bSave);
  panel.appendChild(rowB);

  const status = document.createElement('div');
  Object.assign(status.style, { fontSize: '10px', minHeight: '2.4em', marginTop: '5px', wordBreak: 'break-word' } as Partial<CSSStyleDeclaration>);
  status.textContent = meshUrl.split('/').pop() ?? '';
  status.style.color = '#778';
  panel.appendChild(status);

  const swatch = (c: string, label: string, n: number): string =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:4px"></span>${label} <b>${n}</b>`;

  const sync = (): void => {
    const c = select.counts();
    read.innerHTML = [
      swatch('#ffffff', 'hovered', c.hover),
      swatch('#ffc76f', 'would add', c.preview),
      swatch('#4ea1ff', 'selected', c.selected),
      swatch('#8a8a96', 'hidden', c.hidden),
    ].join('<br>');
    bHide.style.opacity = c.selected ? '1' : '.45';
    bClear.style.opacity = c.selected ? '1' : '.45';
    bUnhide.style.opacity = c.hidden ? '1' : '.45';
  };

  const say = (msg: string, bad = false): void => { status.textContent = msg; status.style.color = bad ? '#ff8a78' : '#6fe3d0'; };

  cb.addEventListener('change', () => {
    select.setEnabled(cb.checked);
    enableTxt.style.color = cb.checked ? '#ffc76f' : '';
    sync();
  });
  tol.addEventListener('input', () => { tolVal.textContent = `${Number(tol.value).toFixed(1)}°`; select.setTolerance(Number(tol.value)); sync(); });
  bHide.addEventListener('click', () => { select.hideSelected(); sync(); refit(); say('hidden — Save to persist'); });
  bClear.addEventListener('click', () => { select.clearSelection(); sync(); });
  bUnhide.addEventListener('click', () => { select.unhideAll(); sync(); refit(); say('restored — Save to persist'); });
  bSave.addEventListener('click', () => {
    void save().then((r) => say(r.ok ? `saved ${select.counts().hidden} hidden face(s)` : (r.error ?? 'save failed'), !r.ok));
  });

  tolVal.textContent = '15.0°';
  sync();
  container.appendChild(panel);

  // keep the readout live as the pointer moves over the model
  (panel as HTMLElement & { __sync?: () => void }).__sync = sync;
}

/** Pull the panel's readout back in line (the picker calls this on every hover change). */
export function syncSurfacePanel(): void {
  const p = document.getElementById('surface-panel') as (HTMLElement & { __sync?: () => void }) | null;
  p?.__sync?.();
}
