// ============================================================================
// src/lab/approve.ts — "Approve & save" (the lab → published-store publish step).
// ============================================================================
//
// Gathers the CURRENT object's auto-fitted footprint + resolved materials and POSTs them to the
// dev middleware (`/__lab/approve`, vite.config.ts), which freezes them into
// src/game/approved-assets.json. That file is the reviewed data the game reads (approved-assets.ts).
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

import type { Footprint } from './world-object.ts';
import type { ResolvedSwatch } from './recolor.ts';
import type { FitStats } from './box-fit.ts';
import { getConfig, getRelief } from './texture-catalog.ts';
import { isApproved } from '../game/approved-assets.ts';

/** The live lab state the button snapshots on click (read fresh each time, post-refit). */
export interface ApproveState {
  footprint: Footprint | undefined;
  stats: FitStats | undefined;
  seedMode: string;
  autoEdge: boolean;
  recolor: ResolvedSwatch[] | undefined;
  present: ReadonlySet<number> | undefined;
  /** Which PROFILE these materials came from, and the content rev of the values actually approved.
   *  The frozen `swatches` stay the source of truth for rendering; this pair is what makes
   *  "which approved objects have fallen behind the current profile?" answerable at all. If the
   *  reviewer had drifted off the profile, `rev` is the drifted state — it records what was
   *  approved, not what the profile says. */
  profile: { id: string; rev: string } | undefined;
}

/** Build the JSON payload (footprint + fit provenance + frozen per-swatch materials) from state. */
function buildAsset(s: ApproveState): Record<string, unknown> {
  const cfg = getConfig();
  const swatches = (s.recolor ?? [])
    .filter((sw) => !s.present || s.present.has(sw.ref)) // only the swatches this model wears
    .map((sw) => ({ name: sw.name, ref: sw.ref, preset: sw.preset, texture: cfg[sw.preset].texture, tint: sw.tint, roughness: sw.roughness, metalness: sw.metalness }));
  return {
    footprint: { boxes: s.footprint?.boxes ?? [] },
    fit: {
      edgeDensity: s.stats?.edgeDensity ?? 0,
      cell: s.stats?.cell ?? 0,
      fill: s.stats?.fill ?? 0,
      coverage: s.stats?.coverage ?? 0,
      boxCount: s.stats?.boxCount ?? (s.footprint?.boxes.length ?? 0),
      seedMode: s.seedMode,
      autoEdge: s.autoEdge,
    },
    materials: { relief: getRelief(), profile: s.profile ?? null, swatches },
  };
}

type ApproveResult = { ok: boolean; count?: number; error?: string };

async function post(body: Record<string, unknown>): Promise<ApproveResult> {
  try {
    const res = await fetch('/__lab/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await res.json()) as ApproveResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export const approveObject = (objectId: string, s: ApproveState): Promise<ApproveResult> => post({ objectId, asset: buildAsset(s) });
export const unapproveObject = (objectId: string): Promise<ApproveResult> => post({ objectId, remove: true });

/** Mount the Approve & save button + status into a container (object mode). Reads state fresh on click
 *  (via `getState`) so it always saves the latest live fit/materials. */
export function buildApproveButton(opts: { container: HTMLElement; objectId: string; getState: () => ApproveState }): void {
  const { container, objectId, getState } = opts;

  const wrap = document.createElement('span');
  Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' } as Partial<CSSStyleDeclaration>);

  const btn = document.createElement('button');
  Object.assign(btn.style, {
    background: 'rgba(78,255,161,.16)', color: '#bdffd9', border: '1px solid rgba(78,255,161,.5)',
    borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', font: '11px system-ui',
  } as Partial<CSSStyleDeclaration>);

  const status = document.createElement('span');
  Object.assign(status.style, { fontSize: '10px', opacity: '.8' } as Partial<CSSStyleDeclaration>);

  const unbtn = document.createElement('button');
  unbtn.textContent = 'unapprove';
  Object.assign(unbtn.style, {
    background: 'transparent', color: '#f9a', border: '1px solid rgba(255,120,140,.4)',
    borderRadius: '6px', padding: '3px 7px', cursor: 'pointer', font: '10px system-ui',
  } as Partial<CSSStyleDeclaration>);

  const render = (approved: boolean): void => {
    btn.textContent = approved ? '✓ Re-approve' : '✓ Approve & save';
    unbtn.style.display = approved ? '' : 'none';
  };
  render(isApproved(objectId));

  btn.addEventListener('click', async () => {
    btn.disabled = true; status.textContent = 'saving…';
    const r = await approveObject(objectId, getState());
    btn.disabled = false;
    status.textContent = r.ok ? `✓ approved (${r.count} total)` : `failed: ${r.error ?? '?'}`;
    if (r.ok) render(true);
  });
  unbtn.addEventListener('click', async () => {
    const r = await unapproveObject(objectId);
    status.textContent = r.ok ? `removed (${r.count} total)` : `failed: ${r.error ?? '?'}`;
    if (r.ok) render(false);
  });

  wrap.appendChild(status); wrap.appendChild(unbtn); wrap.appendChild(btn);
  container.appendChild(wrap);
}
