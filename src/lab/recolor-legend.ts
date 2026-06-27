// ============================================================================
// src/lab/recolor-legend.ts — the SWATCH → MATERIAL legend (object mode only).
// ============================================================================
//
// A collapsible dark-HUD panel (bottom-right) that makes the recolor mapping VISIBLE for the
// current object: every atlas swatch as  [og colour] name → [tint] preset,  with the swatches
// the model actually USES highlighted and the rest dimmed. It reads the resolved table the build
// produced (recolor.ts resolveMapping), so it always matches what's on screen.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import type { ResolvedSwatch, Preset } from './recolor.ts';

export interface RecolorLegendOpts {
  container: HTMLElement;
  /** Resolved per-swatch table for the current object (WorldObjectBuild.recolor). */
  recolor: ResolvedSwatch[];
  /** Atlas swatch hexes the model actually uses — present highlighted, rest dimmed. */
  present?: ReadonlySet<number>;
  /** For the header. */
  objectName: string;
}

const css = (hex: number): string => '#' + (hex >>> 0).toString(16).padStart(6, '0').slice(-6);

/** Short presets, distinct enough to read at a glance. */
const PRESET_LABEL: Record<Preset, string> = {
  stone: 'stone', smoothstone: 'smooth stone', floor: 'floor', wood: 'wood', grained: 'dark wood',
  metal: 'metal', irondark: 'dark iron', gold: 'gold', cloth: 'cloth', terracotta: 'terracotta',
  dark: 'dark', plain: 'plain',
};

function chip(hex: number): HTMLElement {
  const c = document.createElement('span');
  Object.assign(c.style, {
    display: 'inline-block', width: '13px', height: '13px', borderRadius: '3px',
    background: css(hex), border: '1px solid rgba(255,255,255,.18)', flex: '0 0 auto',
  } as Partial<CSSStyleDeclaration>);
  return c;
}

/** Mount the swatch→material legend (rebuilt each lab load; pure DOM). */
export function buildRecolorLegend(opts: RecolorLegendOpts): void {
  const { container, recolor, present, objectName } = opts;
  const here = (hex: number): boolean => !present || present.has(hex);
  const presentCount = present ? recolor.filter((s) => present.has(s.ref)).length : recolor.length;

  const panel = document.createElement('details');
  panel.id = 'recolor-legend';
  panel.open = true;
  Object.assign(panel.style, {
    // bottom-right, height-capped so it sits BELOW the top-right fit-controls (no overlap).
    position: 'fixed', right: '10px', bottom: '10px', width: '230px',
    color: '#bcd', font: '11px/1.4 system-ui',
    background: 'rgba(10,10,22,.82)', border: '1px solid rgba(120,130,170,.28)',
    borderRadius: '10px', padding: '8px 10px', zIndex: '25',
    boxShadow: '0 4px 18px rgba(0,0,0,.45)', maxHeight: 'calc(100vh - 250px)', overflowY: 'auto',
  } as Partial<CSSStyleDeclaration>);

  const summary = document.createElement('summary');
  summary.innerHTML = `<b style="color:#cfe3ff">SWATCH → MATERIAL</b> <span style="opacity:.55">${objectName}</span>`;
  Object.assign(summary.style, { cursor: 'pointer', letterSpacing: '.04em', marginBottom: '4px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(summary);

  const note = document.createElement('div');
  note.textContent = present ? `${presentCount} of ${recolor.length} swatches used by this model` : 'original colour → preset + tint';
  Object.assign(note.style, { opacity: '.6', fontSize: '10px', margin: '2px 0 6px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(note);

  for (const s of recolor) {
    const used = here(s.ref);
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '5px', padding: '1px 0', opacity: used ? '1' : '.32' } as Partial<CSSStyleDeclaration>);

    row.appendChild(chip(s.ref)); // original atlas colour
    const left = document.createElement('span');
    left.textContent = s.name;
    Object.assign(left.style, { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: '.85', fontWeight: used && present ? '600' : '400' } as Partial<CSSStyleDeclaration>);
    row.appendChild(left);

    const arrow = document.createElement('span');
    arrow.textContent = '→';
    Object.assign(arrow.style, { opacity: '.4', flex: '0 0 auto' } as Partial<CSSStyleDeclaration>);
    row.appendChild(arrow);

    row.appendChild(chip(s.tint)); // mapped tint
    const right = document.createElement('span');
    right.textContent = PRESET_LABEL[s.preset] + (s.emissive ? ' ·glow' : '');
    Object.assign(right.style, { flex: '0 0 78px', fontSize: '10px', opacity: '.8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as Partial<CSSStyleDeclaration>);
    row.appendChild(right);

    panel.appendChild(row);
  }

  container.appendChild(panel);
}
