// ============================================================================
// src/lab/texture-settings.ts — the TEXTURE SETTINGS menu (object mode only).
// ============================================================================
//
// A collapsible dark-HUD panel (left side, below the HUD) that lets you choose, PER MATERIAL TYPE
// (stone, floor, wood, metal, gold, cloth, terracotta, …), WHICH tiling texture it wears and how its
// surface reads (roughness / metalness). It mutates the shared config (texture-catalog.ts); the
// caller's `onChange` re-bakes the object live and persists the choice to the URL.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import { TEXTURES, CONFIGURABLE_PRESETS, getConfig, setTypeSetting, resetConfig, getRelief, setRelief, getAOStrength, setAOStrength, type Preset } from './texture-catalog.ts';

/** What the caller gets back — enough to re-sync every widget after the config is replaced from
 *  outside (applying a profile), without this module knowing why. */
export interface TextureSettingsHandle {
  /** Pull every control back in line with the live config. */
  resync: () => void;
}

export interface TextureSettingsOpts {
  container: HTMLElement;
  /** Called (debounced) after the config mutates — the caller re-bakes the object + writes the URL. */
  onChange: () => void;
  /** Left offset of the panel. Defaults to 236px, which clears the LAB's object picker; pages
   *  without one (the contact sheet) pass a smaller value so the panel does not float in a gap. */
  left?: string;
  /** Mounted at the TOP of the panel, above everything. The lab uses it for the profile bar; this
   *  module stays unaware of what a profile is. */
  header?: (mount: HTMLElement) => void;
  /** Extra global sliders the CALLER owns (the lab's studio lights). They live in this panel because
   *  that is where you are looking while judging a surface, but they must NOT trigger a re-bake —
   *  moving a light is a render-only change — so they bypass `onChange` entirely. */
  extras?: readonly { label: string; get: () => number; set: (v: number) => void }[];
  /** Caller-owned COLOUR swatches, drawn beside the extras. Same contract: render-only, no re-bake.
   *  The lab uses them for light tint, which is the other half of judging a material — a surface is
   *  a response to a light, and a warm key over a cool fill reads nothing like a neutral studio. */
  colors?: readonly { label: string; get: () => string; set: (v: string) => void }[];
}

const TYPE_LABEL: Record<Preset, string> = {
  stone: 'Stone', smoothstone: 'Smooth stone', floor: 'Floor', wood: 'Wood', grained: 'Dark wood',
  metal: 'Metal', irondark: 'Dark iron', gold: 'Gold', cloth: 'Cloth', terracotta: 'Terracotta',
  dark: 'Dark', plain: 'Plain',
};

/** Texture options grouped for the <select> (optgroups), so the list reads by family. */
const GROUP_LABEL: Record<string, string> = { neutral: 'Flat', stone: 'Stone', floor: 'Floor', wood: 'Wood', metal: 'Metal', cloth: 'Cloth' };

/** Mount the texture-settings panel. Each row = one material type: texture <select> + R/M sliders. */
export function buildTextureSettings(opts: TextureSettingsOpts): TextureSettingsHandle {
  const { container, onChange, extras = [], colors = [], header, left = '236px' } = opts;

  // debounce so dragging a slider doesn't re-bake on every pixel.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(onChange, 180); };

  const panel = document.createElement('details');
  panel.id = 'texture-settings';
  panel.open = true;
  Object.assign(panel.style, {
    position: 'fixed', left, top: '84px', width: '238px', zIndex: '25',
    color: '#bcd', font: '11px/1.4 system-ui',
    background: 'rgba(10,10,22,.84)', border: '1px solid rgba(120,130,170,.28)',
    borderRadius: '10px', padding: '8px 10px',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)', maxHeight: 'calc(100vh - 170px)', overflowY: 'auto',
  } as Partial<CSSStyleDeclaration>);

  const summary = document.createElement('summary');
  summary.innerHTML = '<b style="color:#cfe3ff">TEXTURE SETTINGS</b>';
  Object.assign(summary.style, { cursor: 'pointer', letterSpacing: '.04em', marginBottom: '6px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(summary);

  const note = document.createElement('div');
  note.textContent = 'pick a texture + surface per type';
  Object.assign(note.style, { opacity: '.55', fontSize: '10px', margin: '0 0 8px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(note);

  // grouped <option> list, reused per row.
  const groups = [...new Set(TEXTURES.map((t) => t.group))];
  const fillSelect = (sel: HTMLSelectElement, current: string): void => {
    for (const g of groups) {
      const og = document.createElement('optgroup'); og.label = GROUP_LABEL[g] ?? g;
      for (const t of TEXTURES.filter((x) => x.group === g)) {
        const o = document.createElement('option'); o.value = t.id; o.textContent = t.label;
        if (t.id === current) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  };

  const inputBg = { background: 'rgba(20,20,34,.9)', color: '#cde', border: '1px solid rgba(120,130,170,.3)', borderRadius: '6px' } as Partial<CSSStyleDeclaration>;
  if (header) {
    const mount = document.createElement('div');
    mount.style.margin = '0 0 8px';
    panel.appendChild(mount);
    header(mount);
  }

  // per-row resync hooks (for Reset, and for an externally applied profile).
  const resync: (() => void)[] = [];

  // --- GLOBAL surface + studio controls, above the per-type rows ---
  // Relief and AO are the two knobs that decide whether a surface reads as REAL or as a painted
  // box; the light sliders are here so you can rake the key across the grain without leaving the
  // panel — a normal map shows nothing under a flat frontal light, which is what made relief look
  // broken when it was off by default.
  const globalSlider = (label: string, get: () => number, set: (v: number) => void, rebake: boolean): void => {
    const wrap = document.createElement('label');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 4px' } as Partial<CSSStyleDeclaration>);
    const t = document.createElement('span'); t.textContent = label; t.style.flex = '0 0 62px'; t.style.color = '#cfe3ff'; t.style.fontWeight = '600';
    const s = document.createElement('input');
    s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.01'; s.value = String(get());
    Object.assign(s.style, { flex: '1 1 auto', accentColor: rebake ? '#4ea1ff' : '#c9a227' } as Partial<CSSStyleDeclaration>);
    const val = document.createElement('span'); val.style.flex = '0 0 24px'; val.style.textAlign = 'right'; val.style.fontSize = '10px';
    const upd = (): void => { val.textContent = Number(s.value).toFixed(2); };
    upd();
    s.addEventListener('input', () => { set(Number(s.value)); upd(); if (rebake) fire(); });
    wrap.appendChild(t); wrap.appendChild(s); wrap.appendChild(val);
    panel.appendChild(wrap);
    resync.push(() => { s.value = String(get()); upd(); });
  };
  globalSlider('Relief', getRelief, setRelief, true);
  globalSlider('AO', getAOStrength, setAOStrength, true);
  for (const e of extras) globalSlider(e.label, e.get, e.set, false);
  if (colors.length) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', margin: '5px 0 0' } as Partial<CSSStyleDeclaration>);
    for (const c of colors) {
      const wrap = document.createElement('label');
      Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 auto', fontSize: '10px', opacity: '.9' } as Partial<CSSStyleDeclaration>);
      const t = document.createElement('span'); t.textContent = c.label;
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = c.get();
      Object.assign(inp.style, { width: '26px', height: '18px', padding: '0', border: '1px solid #34344e', borderRadius: '4px', background: 'none', cursor: 'pointer' } as Partial<CSSStyleDeclaration>);
      inp.addEventListener('input', () => c.set(inp.value));
      wrap.append(t, inp);
      row.appendChild(wrap);
      resync.push(() => { inp.value = c.get(); });
    }
    panel.appendChild(row);
  }
  {
    const rule = document.createElement('div');
    Object.assign(rule.style, { margin: '8px 0', borderBottom: '1px solid rgba(120,130,170,.22)' } as Partial<CSSStyleDeclaration>);
    panel.appendChild(rule);
  }

  for (const p of CONFIGURABLE_PRESETS) {
    const row = document.createElement('div');
    Object.assign(row.style, { margin: '0 0 9px', paddingBottom: '7px', borderBottom: '1px solid rgba(120,130,170,.12)' } as Partial<CSSStyleDeclaration>);

    // line 1: type label + texture select
    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' } as Partial<CSSStyleDeclaration>);
    const lbl = document.createElement('span');
    lbl.textContent = TYPE_LABEL[p];
    Object.assign(lbl.style, { flex: '0 0 62px', color: '#cfe3ff', fontWeight: '600' } as Partial<CSSStyleDeclaration>);
    const sel = document.createElement('select');
    Object.assign(sel.style, { flex: '1 1 auto', padding: '2px 3px', ...inputBg } as Partial<CSSStyleDeclaration>);
    fillSelect(sel, getConfig()[p].texture);
    sel.addEventListener('change', () => { setTypeSetting(p, { texture: sel.value }); fire(); });
    top.appendChild(lbl); top.appendChild(sel);
    row.appendChild(top);

    // line 2: roughness + metalness sliders
    const mkSlider = (which: 'roughness' | 'metalness', tag: string): { wrap: HTMLElement; sync: () => void } => {
      const wrap = document.createElement('label');
      Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', opacity: '.85' } as Partial<CSSStyleDeclaration>);
      const t = document.createElement('span'); t.textContent = tag; t.style.flex = '0 0 14px'; t.style.opacity = '.7';
      const s = document.createElement('input');
      s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.01'; s.value = String(getConfig()[p][which]);
      Object.assign(s.style, { flex: '1 1 auto', accentColor: '#4ea1ff' } as Partial<CSSStyleDeclaration>);
      const val = document.createElement('span'); val.style.flex = '0 0 24px'; val.style.textAlign = 'right';
      const upd = (): void => { val.textContent = Number(s.value).toFixed(2); };
      upd();
      s.addEventListener('input', () => { setTypeSetting(p, { [which]: Number(s.value) }); upd(); fire(); });
      wrap.appendChild(t); wrap.appendChild(s); wrap.appendChild(val);
      return { wrap, sync: () => { s.value = String(getConfig()[p][which]); upd(); } };
    };
    const rough = mkSlider('roughness', 'R');
    const metal = mkSlider('metalness', 'M');
    const sliders = document.createElement('div');
    Object.assign(sliders.style, { display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '4px' } as Partial<CSSStyleDeclaration>);
    sliders.appendChild(rough.wrap); sliders.appendChild(metal.wrap);
    row.appendChild(sliders);

    resync.push(() => { for (const o of sel.options) o.selected = o.value === getConfig()[p].texture; rough.sync(); metal.sync(); });
    panel.appendChild(row);
  }

  // Reset to defaults
  const reset = document.createElement('button');
  reset.textContent = 'Reset to defaults';
  Object.assign(reset.style, { width: '100%', marginTop: '2px', background: 'rgba(78,161,255,.16)', color: '#cfe3ff', border: '1px solid rgba(120,180,255,.5)', borderRadius: '6px', padding: '4px', cursor: 'pointer', font: '11px system-ui' } as Partial<CSSStyleDeclaration>);
  reset.addEventListener('click', () => { resetConfig(); for (const r of resync) r(); fire(); });
  panel.appendChild(reset);

  container.appendChild(panel);
  return { resync: () => { for (const r of resync) r(); } };
}
