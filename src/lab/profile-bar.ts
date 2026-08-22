// ============================================================================
// src/lab/profile-bar.ts — the PROFILE picker that sits on top of TEXTURE SETTINGS.
// ============================================================================
//
// Pick a named look, see at a glance whether you have drifted off it, and save the drift back — as
// an edit to this profile, or as a new variant that inherits from it. That last one is the whole
// point: `Save as variant` diffs the live state against the parent and writes ONLY the deltas
// (material-profiles.ts `captureDelta`), so a variant can never quietly freeze a full copy and
// stop tracking its parent.
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

import {
  type ProfileStore, type ResolvedProfile, resolveProfile, applyProfile, captureDelta, deltaCount,
  liveRev, loadProfiles, saveProfile, idFromLabel,
} from './material-profiles.ts';

export interface ProfileBarOpts {
  /** Where to draw. */
  mount: HTMLElement;
  /** Profile to select on load (from `?profile=`), if it exists. */
  initial?: string | null;
  /** Called after the live config has been replaced: re-sync the panel widgets and re-bake. */
  onApplied: (p: ResolvedProfile) => void;
}

export interface ProfileBarHandle {
  /** Re-read the drift indicator — call after any control changes the live config. */
  refresh: () => void;
  current: () => ResolvedProfile | null;
}

const BTN = {
  flex: '1 1 auto', padding: '3px 6px', background: '#23233a', color: '#cde',
  border: '1px solid #34344e', borderRadius: '5px', cursor: 'pointer', font: '10px system-ui',
} as Partial<CSSStyleDeclaration>;

export function mountProfileBar(opts: ProfileBarOpts): ProfileBarHandle {
  const { mount, initial, onApplied } = opts;
  let store: ProfileStore = { version: 1, profiles: {} };
  let current: ResolvedProfile | null = null;

  const title = document.createElement('div');
  title.innerHTML = '<b style="color:#cfe3ff">PROFILE</b>';
  Object.assign(title.style, { letterSpacing: '.04em', marginBottom: '4px' } as Partial<CSSStyleDeclaration>);

  const sel = document.createElement('select');
  Object.assign(sel.style, {
    width: '100%', background: '#20202e', color: '#def', border: '1px solid #383850',
    borderRadius: '6px', padding: '3px 6px', font: '11px system-ui',
  } as Partial<CSSStyleDeclaration>);

  const info = document.createElement('div');
  Object.assign(info.style, { fontSize: '10px', opacity: '.7', margin: '4px 0 5px', minHeight: '2.4em' } as Partial<CSSStyleDeclaration>);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '4px' } as Partial<CSSStyleDeclaration>);
  const bSave = document.createElement('button'); bSave.textContent = 'Save'; Object.assign(bSave.style, BTN);
  const bVariant = document.createElement('button'); bVariant.textContent = 'Save as variant'; Object.assign(bVariant.style, BTN);
  const bRevert = document.createElement('button'); bRevert.textContent = 'Revert'; Object.assign(bRevert.style, BTN);
  row.append(bSave, bVariant, bRevert);

  const status = document.createElement('div');
  Object.assign(status.style, { fontSize: '10px', minHeight: '1.3em', marginTop: '3px' } as Partial<CSSStyleDeclaration>);

  mount.append(title, sel, info, row, status);

  const say = (msg: string, bad = false): void => {
    status.textContent = msg;
    status.style.color = bad ? '#ff8a78' : '#6fe3d0';
  };

  /** Drift = the live values no longer hash to the profile's rev. */
  const modified = (): boolean => !!current && liveRev() !== current.rev;

  const refresh = (): void => {
    if (!current) { info.textContent = 'no profile store (dev server only)'; return; }
    const own = store.profiles[current.id];
    const parent = own?.extends;
    const bits = [
      parent ? `extends ${parent}` : 'from defaults',
      `${own ? deltaCount(own) : 0} own override${own && deltaCount(own) === 1 ? '' : 's'}`,
      `rev ${current.rev}`,
    ];
    info.innerHTML = bits.join(' &middot; ') + (modified() ? ' <span style="color:#ffc76f">&bull; modified</span>' : '');
    bSave.style.opacity = modified() ? '1' : '.45';
    bRevert.style.opacity = modified() ? '1' : '.45';
  };

  const select = (id: string, quiet = false): void => {
    if (!store.profiles[id]) return;
    current = resolveProfile(store, id);
    applyProfile(current);
    for (const o of sel.options) o.selected = o.value === id;
    refresh();
    if (!quiet) say(`applied ${current.label}`);
    onApplied(current);
  };

  const fillOptions = (): void => {
    sel.replaceChildren();
    for (const [id, p] of Object.entries(store.profiles)) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = p.extends ? `  ${p.label}` : p.label; // one level of visual nesting is enough
      sel.appendChild(o);
    }
  };

  sel.addEventListener('change', () => select(sel.value));

  bSave.addEventListener('click', () => {
    if (!current || !modified()) return;
    const id = current.id;
    const own = store.profiles[id];
    const delta = captureDelta(store, own?.extends, own?.label ?? id);
    void saveProfile(id, delta).then((r) => {
      if (!r.ok) return say(r.error ?? 'save failed', true);
      store.profiles[id] = delta;
      current = resolveProfile(store, id);
      refresh();
      say(`saved ${delta.label}`);
    });
  });

  bVariant.addEventListener('click', () => {
    const label = window.prompt('Name for the new variant', current ? `${current.label} v2` : 'New profile');
    if (!label) return;
    const id = idFromLabel(label);
    if (store.profiles[id]) return say(`"${id}" already exists`, true);
    const delta = captureDelta(store, current?.id, label);
    void saveProfile(id, delta).then((r) => {
      if (!r.ok) return say(r.error ?? 'save failed', true);
      store.profiles[id] = delta;
      fillOptions();
      select(id, true);
      say(`created ${label} (${deltaCount(delta)} deltas)`);
    });
  });

  bRevert.addEventListener('click', () => {
    if (!current) return;
    select(current.id);
    say('reverted');
  });

  void loadProfiles().then((s) => {
    store = s;
    fillOptions();
    const ids = Object.keys(store.profiles);
    if (!ids.length) { refresh(); return; }
    select(initial && store.profiles[initial] ? initial : ids[0]!, true);
  });

  return { refresh, current: () => current };
}
