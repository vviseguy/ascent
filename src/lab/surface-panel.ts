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

import type { FaceSelectHandle, GrowMode } from './face-select.ts';
import { hiddenFor, type SurfaceGroup } from './face-surfaces.ts';

export interface SurfacePanelOpts {
  container: HTMLElement;
  /** Resolved lazily: a texture change rebuilds the object, which swaps every mesh, so the picker
   *  is re-mounted and the panel must not be holding the dead one. */
  select: () => FaceSelectHandle | null;
  /** Persist the current hidden set AND the named groups for this mesh. */
  save: (groups: readonly SurfaceGroup[]) => Promise<{ ok: boolean; error?: string }>;
  /** Shown so it is obvious WHICH mesh an edit is attached to (the store is keyed by mesh URL). */
  meshUrl: string;
  /** Rebuild the object — hiding changes the collision footprint, which is fitted at build time. */
  refit: () => void;
}

const BTN = {
  flex: '1 1 auto', padding: '4px 6px', background: '#23233a', color: '#cde',
  border: '1px solid #34344e', borderRadius: '5px', cursor: 'pointer', font: '10px system-ui',
} as Partial<CSSStyleDeclaration>;

export interface SurfacePanelHandle {
  /** Push the panel's current mode + tolerance into a freshly mounted picker. */
  rebind: () => void;
}

export function buildSurfacePanel(opts: SurfacePanelOpts): SurfacePanelHandle {
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
  // --- GROW MODE ---
  // Two different questions, not two settings of one. 'planar' asks what is FLAT with this face;
  // 'carve' asks what belongs to the same carved piece — the face plus the slants that roll off
  // it, stopping where the next piece's slant comes back up (a concave crease).
  // The tolerance means something DIFFERENT in each mode, so each remembers its own value.
  // In planar it is the whole boundary rule: how far off coplanar still counts as one face.
  // In carve the concave creases draw the boundaries and the cone is only a cap on how far down
  // a slant may roll before it stops belonging to its face — which is why it wants to be much
  // higher. Measured on floor_tile_large, carve is FLAT at 17 facets from 65° to 89°; the wall
  // agrees at 75°. Below ~60° the cone starts biting and orphaned slants reappear as slivers.
  const TOL_FOR: Record<GrowMode, number> = { planar: 15, carve: 75 };
  let curMode: GrowMode = 'planar';

  const modeRow = document.createElement('div');
  Object.assign(modeRow.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '6px 0 2px' } as Partial<CSSStyleDeclaration>);
  const modeLbl = document.createElement('span');
  modeLbl.textContent = 'grow';
  modeLbl.style.flex = '0 0 34px';
  const modeSel = document.createElement('select');
  Object.assign(modeSel.style, { flex: '1 1 auto', background: '#20202e', color: '#def', border: '1px solid #383850', borderRadius: '5px', padding: '2px 4px', font: '10px system-ui' } as Partial<CSSStyleDeclaration>);
  for (const [v, t] of [['planar', 'planar — flat faces'], ['carve', 'carved tile — face + its slants']]) {
    const o = document.createElement('option'); o.value = v!; o.textContent = t!; modeSel.appendChild(o);
  }
  const applyTolText = (): void => {
    tolVal.textContent = `${Number(tol.value).toFixed(1)}°`;
    tolNote.textContent = curMode === 'carve'
      ? 'how far a slant may roll off its face before it stops belonging to it'
      : 'how far off coplanar a neighbour may be and still join';
  };
  modeSel.addEventListener('change', () => {
    TOL_FOR[curMode] = Number(tol.value);          // remember where this mode was left
    curMode = modeSel.value as GrowMode;
    tol.value = String(TOL_FOR[curMode]);
    const h = select();
    h?.setMode(curMode);
    h?.setTolerance(Number(tol.value));
    applyTolText(); sync(); renderGroups();
  });
  modeRow.append(modeLbl, modeSel);
  panel.appendChild(modeRow);
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

  // --- GROUPS: the partition, as a list you can point at ---
  // The viewport shows the partition as colour; this shows it as an inventory. You need both — the
  // colours tell you the SHAPE of the split, the list tells you how many there are and lets you act
  // on one you cannot conveniently hover (a facet behind the model, or a sliver too small to hit).
  const groupsHdr = document.createElement('label');
  Object.assign(groupsHdr.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '10px 0 4px', paddingTop: '8px', borderTop: '1px solid rgba(120,130,170,.22)' } as Partial<CSSStyleDeclaration>);
  const gcb = document.createElement('input');
  gcb.type = 'checkbox';
  const gtxt = document.createElement('span');
  gtxt.innerHTML = '<b style="color:#cfe3ff">show groups</b>';
  groupsHdr.append(gcb, gtxt);
  panel.appendChild(groupsHdr);

  const groupCount = document.createElement('div');
  Object.assign(groupCount.style, { fontSize: '10px', opacity: '.6', margin: '0 0 5px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(groupCount);

  const groupList = document.createElement('div');
  Object.assign(groupList.style, { maxHeight: '190px', overflowY: 'auto', margin: '0 0 8px', display: 'none' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(groupList);

  const hue = (id: number): string => `hsl(${((id * 0.61803398875) % 1) * 360}deg 62% 55%)`;

  const renderGroups = (): void => {
    const h = select();
    const list = h ? h.facets() : [];
    groupCount.textContent = list.length ? `${list.length} facet${list.length === 1 ? '' : 's'} at this tolerance` : '—';
    groupList.style.display = gcb.checked && list.length ? '' : 'none';
    if (!gcb.checked) return;
    groupList.replaceChildren();
    for (const f of list) {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px', borderRadius: '4px', cursor: 'pointer', fontSize: '10px' } as Partial<CSSStyleDeclaration>);
      row.innerHTML = `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${hue(f.id)}"></span>` +
        `<span style="flex:1 1 auto">#${f.id}</span>` +
        `<span style="opacity:.65">${f.tris.length} tri</span>` +
        `<span style="opacity:.5;width:44px;text-align:right">${f.area.toFixed(2)} m²</span>`;
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(78,161,255,.16)'; select()?.highlightFacet(f.id); });
      row.addEventListener('mouseleave', () => { row.style.background = ''; select()?.highlightFacet(null); });
      // left adds, right removes — the same two meanings as in the viewport
      row.addEventListener('click', () => { select()?.commitFacet(f.id, true); sync(); });
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); select()?.commitFacet(f.id, false); sync(); });
      groupList.appendChild(row);
    }
  };

  gcb.addEventListener('change', () => { select()?.setShowGroups(gcb.checked); renderGroups(); });

  // --- SAVED GROUPS: the decisions, as opposed to the proposal above ---
  // The auto partition is recomputed from the tolerance and redrawn wholesale whenever it moves. A
  // saved group stores its TRIANGLES, so once you have committed to a region, retuning the slider
  // cannot quietly redraw it. That is the entire point of persisting rather than deriving.
  let saved: SurfaceGroup[] = (hiddenFor(meshUrl)?.groups ?? []).map((g) => ({ ...g, tris: { ...g.tris } }));

  const savedHdr = document.createElement('label');
  Object.assign(savedHdr.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: '10px 0 4px', paddingTop: '8px', borderTop: '1px solid rgba(120,130,170,.22)' } as Partial<CSSStyleDeclaration>);
  const scb = document.createElement('input');
  scb.type = 'checkbox';
  const stxt = document.createElement('span');
  stxt.innerHTML = '<b style="color:#cfe3ff">saved groups</b>';
  savedHdr.append(scb, stxt);
  panel.appendChild(savedHdr);

  const savedList = document.createElement('div');
  Object.assign(savedList.style, { maxHeight: '150px', overflowY: 'auto', margin: '0 0 5px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(savedList);

  const bNew = document.createElement('button');
  bNew.textContent = 'New group from selection';
  Object.assign(bNew.style, BTN);
  bNew.style.width = '100%';
  panel.appendChild(bNew);

  const slug = (n: string): string => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
  const triCountOf = (g: SurfaceGroup): number => Object.values(g.tris).reduce((a, b) => a + b.length, 0);

  const paintSaved = (): void => {
    const h = select();
    if (!h) return;
    h.paintSets(scb.checked ? saved.map((g) => g.tris['0'] ?? []) : null);
  };

  const renderSaved = (): void => {
    savedList.replaceChildren();
    if (!saved.length) {
      const empty = document.createElement('div');
      Object.assign(empty.style, { fontSize: '10px', opacity: '.5', padding: '2px 0' } as Partial<CSSStyleDeclaration>);
      empty.textContent = 'none yet — select faces, then New group';
      savedList.appendChild(empty);
      return;
    }
    saved.forEach((g, i) => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '5px', padding: '2px 4px', borderRadius: '4px', fontSize: '10px' } as Partial<CSSStyleDeclaration>);
      const dot = document.createElement('span');
      Object.assign(dot.style, { display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', flex: '0 0 auto', background: hue(i) } as Partial<CSSStyleDeclaration>);
      const nm = document.createElement('span');
      nm.textContent = g.name;
      nm.title = 'click to load into the selection';
      Object.assign(nm.style, { flex: '1 1 auto', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as Partial<CSSStyleDeclaration>);
      const n = document.createElement('span');
      n.textContent = `${triCountOf(g)} tri`;
      Object.assign(n.style, { opacity: '.6', flex: '0 0 auto' } as Partial<CSSStyleDeclaration>);
      const ren = document.createElement('button');
      ren.textContent = '✎'; ren.title = 'rename';
      const del = document.createElement('button');
      del.textContent = '×'; del.title = 'delete';
      for (const b of [ren, del]) Object.assign(b.style, { ...BTN, flex: '0 0 auto', padding: '0 4px' } as Partial<CSSStyleDeclaration>);

      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(78,161,255,.16)'; select()?.highlightTris(g.tris); });
      row.addEventListener('mouseleave', () => { row.style.background = ''; select()?.highlightTris(null); });
      nm.addEventListener('click', () => { select()?.setSelection(g.tris); sync(); say(`loaded ${g.name} into the selection`); });
      ren.addEventListener('click', () => {
        const v = window.prompt('Rename group', g.name);
        if (!v) return;
        g.name = v; g.id = slug(v);
        renderSaved(); say('renamed — Save to persist');
      });
      del.addEventListener('click', () => {
        saved.splice(i, 1);
        renderSaved(); paintSaved(); say('deleted — Save to persist');
      });
      row.append(dot, nm, n, ren, del);
      savedList.appendChild(row);
    });
  };

  // The two overlays share one mesh, so they are mutually exclusive: showing saved groups turns the
  // auto-facet tint off rather than drawing one on top of the other.
  scb.addEventListener('change', () => {
    if (scb.checked && gcb.checked) { gcb.checked = false; renderGroups(); }
    paintSaved();
  });
  bNew.addEventListener('click', () => {
    const sel = select()?.selection() ?? {};
    if (!Object.keys(sel).length) return say('nothing selected', true);
    const name = window.prompt('Name this group', `group ${saved.length + 1}`);
    if (!name) return;
    const id = slug(name);
    if (saved.some((g) => g.id === id)) return say(`"${id}" already exists`, true);
    saved.push({ id, name, tris: sel });
    renderSaved(); paintSaved(); say(`created ${name} — Save to persist`);
  });

  const status = document.createElement('div');
  Object.assign(status.style, { fontSize: '10px', minHeight: '2.4em', marginTop: '5px', wordBreak: 'break-word' } as Partial<CSSStyleDeclaration>);
  status.textContent = meshUrl.split('/').pop() ?? '';
  status.style.color = '#778';
  panel.appendChild(status);

  const swatch = (c: string, label: string, n: number): string =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:4px"></span>${label} <b>${n}</b>`;

  const sync = (): void => {
    const c = select()?.counts() ?? { hover: 0, preview: 0, selected: 0, hidden: 0 };
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
    select()?.setEnabled(cb.checked);
    enableTxt.style.color = cb.checked ? '#ffc76f' : '';
    sync();
  });
  tol.addEventListener('input', () => { TOL_FOR[curMode] = Number(tol.value); applyTolText(); select()?.setTolerance(Number(tol.value)); sync(); renderGroups(); });
  bHide.addEventListener('click', () => { select()?.hideSelected(); sync(); refit(); say('hidden — Save to persist'); });
  bClear.addEventListener('click', () => { select()?.clearSelection(); sync(); });
  bUnhide.addEventListener('click', () => { select()?.unhideAll(); sync(); refit(); say('restored — Save to persist'); });
  bSave.addEventListener('click', () => {
    void save(saved).then((r) => say(r.ok ? `saved ${select()?.counts().hidden ?? 0} hidden face(s) + ${saved.length} group(s)` : (r.error ?? 'save failed'), !r.ok));
  });

  applyTolText();
  sync();
  renderGroups();
  renderSaved();
  container.appendChild(panel);

  const rebind = (): void => {
    const h = select();
    if (!h) return;
    h.setMode(modeSel.value as GrowMode);
    h.setTolerance(Number(tol.value));
    h.setEnabled(cb.checked);
    h.setShowGroups(gcb.checked);
    sync();
    renderGroups();
    renderSaved();
    paintSaved();
  };

  // keep the readout live as the pointer moves over the model
  (panel as HTMLElement & { __sync?: () => void }).__sync = sync;
  return { rebind };
}

/** Pull the panel's readout back in line (the picker calls this on every hover change). */
export function syncSurfacePanel(): void {
  const p = document.getElementById('surface-panel') as (HTMLElement & { __sync?: () => void }) | null;
  p?.__sync?.();
}
