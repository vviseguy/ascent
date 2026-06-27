// ============================================================================
// src/lab/fit-controls.ts — LIVE FIT CONTROLS panel (object mode only).
// ============================================================================
//
// A small dark-HUD panel (top-right) that RE-FITS the displayed WorldObject live and
// updates the green box overlay + HUD stats + timing readout, without rebuilding the
// GLB. It surfaces the box-fit knobs a reviewer tunes by eye:
//
//   • edgeDensity  slider 0.00–1.00 (shown as %)        → opts.edgeDensity
//   • box overlap  checkbox (= !nonOverlap)             → opts.nonOverlap
//   • seed mode    scan · cluster · random-best         → opts.seedMode
//   • samples (N)  + treeing (B)   [random-best only]   → opts.samples / opts.beam
//
// The chosen values are PERSISTED in the URL (?edgeDensity=&overlap=&seedMode=&samples=&beam=)
// via history.replaceState so a tuned state is shareable / screenshottable. A change debounces
// (~150ms) then re-fits; the fit-time readout (from the timing HUD) makes the cost visible. A
// "Refit" button forces an immediate re-fit (e.g. to re-sample random-best at the same seed).
//
// Pure VIEW/tooling — no sim, no determinism constraints (random-best uses a SEEDED PRNG so
// its results still reproduce; see box-fit.ts).
// ============================================================================

import type { SeedMode, FitBoxesOpts } from './box-fit.ts';

/** The live-tunable subset of box-fit opts the panel drives. */
export interface FitControlState {
  edgeDensity: number;
  /** TRUE = boxes may overlap (opts.nonOverlap === false). */
  overlap: boolean;
  seedMode: SeedMode;
  samples: number;
  beam: number;
  /** AUTO edge-density: scan for the LOWEST edge-density reaching ~95% fill (default ON). When on,
   *  the edgeDensity slider is the manual fallback and is disabled. */
  autoEdge: boolean;
}

/** The fill target the auto edge-density scan aims to just exceed. */
export const AUTO_FILL_TARGET = 0.95;

const SEED_MODES: SeedMode[] = ['scan', 'cluster', 'random-best'];

/** Parse the live-fit state from URL params, falling back to the box-fit defaults
 *  (edgeDensity 0.5, non-overlap ON, seedMode cluster, samples 10, beam 2). */
export function readFitStateFromParams(params: URLSearchParams): FitControlState {
  const ed = Number(params.get('edgeDensity'));
  const sm = params.get('seedMode');
  const samples = Number(params.get('samples'));
  const beam = Number(params.get('beam'));
  return {
    edgeDensity: Number.isFinite(ed) && params.has('edgeDensity') ? clamp01(ed) : 0.5,
    overlap: params.get('overlap') === '1',
    seedMode: (sm && (SEED_MODES as string[]).includes(sm) ? sm : 'cluster') as SeedMode,
    samples: Number.isFinite(samples) && samples > 0 ? Math.round(samples) : 10,
    beam: Number.isFinite(beam) && beam > 0 ? Math.round(beam) : 2,
    autoEdge: params.get('autoEd') !== '0', // default ON
  };
}

/** Map the panel state → the box-fit opts overrides (the rest stay at box-fit defaults). */
export function fitStateToOpts(s: FitControlState, randomSeed: number): FitBoxesOpts {
  return {
    edgeDensity: s.edgeDensity,
    nonOverlap: !s.overlap,
    seedMode: s.seedMode,
    samples: s.samples,
    beam: s.beam,
    randomSeed,
    autoEdgeDensity: s.autoEdge,
    fillTarget: AUTO_FILL_TARGET,
  };
}

/** Write the live-fit state back into the URL (replaceState — no history spam). */
export function writeFitStateToUrl(s: FitControlState): void {
  const params = new URLSearchParams(location.search);
  params.set('edgeDensity', s.edgeDensity.toFixed(2));
  params.set('overlap', s.overlap ? '1' : '0');
  params.set('seedMode', s.seedMode);
  params.set('samples', String(s.samples));
  params.set('beam', String(s.beam));
  if (s.autoEdge) params.delete('autoEd'); else params.set('autoEd', '0'); // default ON → clean URL
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

export interface FitControlsOpts {
  container: HTMLElement;
  initial: FitControlState;
  /** Called (debounced) whenever a control changes; re-fit + redraw lives in the caller. */
  onChange: (state: FitControlState) => void;
}

/**
 * Mount the live-fit panel. Returns nothing — the panel drives `onChange` (debounced ~150ms);
 * the "Refit" button calls it immediately. Samples/treeing rows only show for `random-best`.
 */
export function buildFitControls(opts: FitControlsOpts): void {
  const { container, initial, onChange } = opts;
  const state: FitControlState = { ...initial };

  const panel = document.createElement('div');
  panel.id = 'fit-controls';
  Object.assign(panel.style, {
    position: 'fixed',
    right: '10px',
    top: '46px', // leaves the top-right corner for the hide-UI button
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
  title.textContent = 'FIT CONTROLS';
  Object.assign(title.style, { color: '#9ab', letterSpacing: '.08em', fontSize: '10px', marginBottom: '8px', opacity: '.8' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(title);

  // debounce so dragging the slider doesn't thrash the (potentially heavy) re-fit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (immediate = false): void => {
    if (timer) clearTimeout(timer);
    writeFitStateToUrl(state);
    if (immediate) { onChange({ ...state }); return; }
    timer = setTimeout(() => onChange({ ...state }), 150);
  };

  // --- AUTO edge-density checkbox: scan for the lowest edge-density reaching ~95% fill ---
  const autoRow = document.createElement('label');
  Object.assign(autoRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', cursor: 'pointer' } as Partial<CSSStyleDeclaration>);
  const autoBox = document.createElement('input');
  autoBox.type = 'checkbox'; autoBox.checked = state.autoEdge;
  Object.assign(autoBox.style, { accentColor: '#4ea1ff' } as Partial<CSSStyleDeclaration>);
  const autoText = document.createElement('span');
  autoText.innerHTML = 'auto edge density <span style="opacity:.5">(→ ≥95% fill, lowest)</span>';
  autoRow.appendChild(autoBox); autoRow.appendChild(autoText);
  panel.appendChild(autoRow);

  // --- edgeDensity slider (0..1, shown as %) — the MANUAL fallback; disabled while auto is on ---
  const edRow = document.createElement('label');
  Object.assign(edRow.style, { display: 'block', marginBottom: '8px' } as Partial<CSSStyleDeclaration>);
  const edLabel = document.createElement('div');
  const edSlider = document.createElement('input');
  edSlider.type = 'range'; edSlider.min = '0'; edSlider.max = '1'; edSlider.step = '0.01';
  edSlider.value = String(state.edgeDensity);
  Object.assign(edSlider.style, { width: '100%', marginTop: '2px', accentColor: '#4ea1ff' } as Partial<CSSStyleDeclaration>);
  const updEdLabel = (): void => {
    edLabel.innerHTML = state.autoEdge
      ? 'edge density <b style="color:#cfe3ff">auto</b> <span style="opacity:.5">(see HUD)</span>'
      : `edge density <b style="color:#cfe3ff">${(state.edgeDensity * 100).toFixed(0)}%</b>`;
  };
  const syncEdEnabled = (): void => { edSlider.disabled = state.autoEdge; edRow.style.opacity = state.autoEdge ? '.5' : '1'; };
  updEdLabel(); syncEdEnabled();
  edSlider.addEventListener('input', () => { state.edgeDensity = Number(edSlider.value); updEdLabel(); fire(); });
  autoBox.addEventListener('change', () => { state.autoEdge = autoBox.checked; updEdLabel(); syncEdEnabled(); fire(); });
  edRow.appendChild(edLabel); edRow.appendChild(edSlider);
  panel.appendChild(edRow);

  // --- box overlap checkbox (= !nonOverlap) ---
  const ovRow = document.createElement('label');
  Object.assign(ovRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', cursor: 'pointer' } as Partial<CSSStyleDeclaration>);
  const ovBox = document.createElement('input');
  ovBox.type = 'checkbox'; ovBox.checked = state.overlap;
  Object.assign(ovBox.style, { accentColor: '#4ea1ff' } as Partial<CSSStyleDeclaration>);
  const ovText = document.createElement('span');
  ovText.innerHTML = 'box overlap <span style="opacity:.5">(off = non-overlap)</span>';
  ovBox.addEventListener('change', () => { state.overlap = ovBox.checked; fire(); });
  ovRow.appendChild(ovBox); ovRow.appendChild(ovText);
  panel.appendChild(ovRow);

  // --- seed mode dropdown ---
  const smRow = document.createElement('label');
  Object.assign(smRow.style, { display: 'block', marginBottom: '8px' } as Partial<CSSStyleDeclaration>);
  smRow.appendChild(Object.assign(document.createElement('div'), { textContent: 'seed mode' }));
  const smSel = document.createElement('select');
  Object.assign(smSel.style, { width: '100%', marginTop: '2px', background: 'rgba(20,20,34,.9)', color: '#cde', border: '1px solid rgba(120,130,170,.3)', borderRadius: '6px', padding: '3px' } as Partial<CSSStyleDeclaration>);
  for (const m of SEED_MODES) {
    const o = document.createElement('option'); o.value = m; o.textContent = m; if (m === state.seedMode) o.selected = true; smSel.appendChild(o);
  }
  smRow.appendChild(smSel);
  panel.appendChild(smRow);

  // --- random-best params (samples N + treeing B), shown only for random-best ---
  const rbWrap = document.createElement('div');
  Object.assign(rbWrap.style, { marginBottom: '8px', paddingLeft: '6px', borderLeft: '2px solid rgba(120,130,170,.25)' } as Partial<CSSStyleDeclaration>);

  const mkNum = (label: string, val: number, min: number, set: (n: number) => void): HTMLLabelElement => {
    const row = document.createElement('label');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' } as Partial<CSSStyleDeclaration>);
    row.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = String(min); inp.step = '1'; inp.value = String(val);
    Object.assign(inp.style, { width: '52px', background: 'rgba(20,20,34,.9)', color: '#cde', border: '1px solid rgba(120,130,170,.3)', borderRadius: '6px', padding: '2px 4px' } as Partial<CSSStyleDeclaration>);
    inp.addEventListener('input', () => { const n = Math.max(min, Math.round(Number(inp.value) || min)); set(n); fire(); });
    row.appendChild(inp);
    return row;
  };
  rbWrap.appendChild(mkNum('samples (N)', state.samples, 1, (n) => { state.samples = n; }));
  rbWrap.appendChild(mkNum('treeing (B)', state.beam, 1, (n) => { state.beam = n; }));
  panel.appendChild(rbWrap);

  const syncRbVisibility = (): void => { rbWrap.style.display = state.seedMode === 'random-best' ? 'block' : 'none'; };
  syncRbVisibility();
  smSel.addEventListener('change', () => { state.seedMode = smSel.value as SeedMode; syncRbVisibility(); fire(); });

  // --- Refit button (immediate re-fit) ---
  const btn = document.createElement('button');
  btn.textContent = 'Refit';
  Object.assign(btn.style, { width: '100%', marginTop: '2px', background: 'rgba(78,161,255,.18)', color: '#cfe3ff', border: '1px solid rgba(120,180,255,.55)', borderRadius: '6px', padding: '4px', cursor: 'pointer', font: '11px system-ui' } as Partial<CSSStyleDeclaration>);
  btn.addEventListener('click', () => fire(true));
  panel.appendChild(btn);

  container.appendChild(panel);
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
