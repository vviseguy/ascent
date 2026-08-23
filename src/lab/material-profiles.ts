// ============================================================================
// src/lab/material-profiles.ts — NAMED, SHAREABLE material profiles.
// ============================================================================
//
// texture-catalog.ts holds ONE live config: which texture + surface each material TYPE wears. That
// is enough to tune a look, but not to KEEP one — there was no way to name a look, save it, diff
// two of them, or have a second one at all. The only persistence was a `?tex=` query string, and
// approving an object froze a private COPY of the resolved values, so retuning stone propagated to
// nothing and no one could even tell which approved objects had fallen behind.
//
// A PROFILE fixes that. It is a named, git-tracked set of per-type overrides:
//
//   dungeon-default   the house look
//   dungeon-damp      extends dungeon-default, overrides { stone, floor }   <- 2 deltas, 10 inherited
//
// `extends` IS the sharing mechanism. A variant names only what differs, so editing `oak` in the
// base moves every profile that inherits it. `captureDelta` computes that sparse diff for you when
// you Save As, so a variant can never silently freeze a full copy of its parent.
//
// The 4-layer swatch cascade (recolor.ts) is untouched: it still decides which TYPE a given swatch
// asks for. A profile only swaps the answer table underneath it.
//
// Pure VIEW/tooling — no sim, no determinism constraints (floats fine).
// ============================================================================

import {
  DEFAULT_CONFIG, CONFIGURABLE_PRESETS, getConfig, setConfig, getRelief, setRelief,
  getAOStrength, setAOStrength, type Preset, type RecolorConfig, type TypeSetting,
} from './texture-catalog.ts';

/** One profile. Every field except `label` is optional — an entry that overrides nothing is a valid
 *  alias for its parent, which is a useful thing to be able to name. */
export interface MaterialProfile {
  label: string;
  /** Another profile id to inherit from. Omitted = inherit DEFAULT_CONFIG. */
  extends?: string;
  relief?: number;
  ao?: number;
  /** Sparse per-type overrides — only what this profile changes. */
  types?: Partial<Record<Preset, Partial<TypeSetting>>>;
}

export interface ProfileStore {
  version: number;
  profiles: Record<string, MaterialProfile>;
}

/** A profile flattened through its `extends` chain: ready to apply, and stamped with a `rev`. */
export interface ResolvedProfile {
  id: string;
  label: string;
  /** Root-first inheritance chain, for the UI to show what a variant is built on. */
  chain: string[];
  config: RecolorConfig;
  relief: number;
  ao: number;
  /** Content hash of the resolved values. Two profiles that resolve identically share a rev, and a
   *  profile that is edited gets a new one — which is what makes "is this approved object stale?"
   *  a question with an answer, without anyone having to remember to bump a version. */
  rev: string;
}

export const EMPTY_STORE: ProfileStore = { version: 1, profiles: {} };

// ---- resolution ---------------------------------------------------------------------------

/** Walk `extends` root-first. Cycles and unknown parents degrade to a shorter chain rather than
 *  throwing — a broken profile should still render something you can look at and fix. */
function chainOf(store: ProfileStore, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur && store.profiles[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = store.profiles[cur]!.extends;
  }
  if (cur && seen.has(cur)) console.warn(`[profiles] cycle in extends chain at "${cur}" — truncated`);
  else if (cur) console.warn(`[profiles] unknown parent profile "${cur}"`);
  return chain;
}

/** FNV-1a over the canonical resolved values. Deterministic and clock-free. */
function revOf(config: RecolorConfig, relief: number, ao: number): string {
  const canon = JSON.stringify([
    CONFIGURABLE_PRESETS.map((p) => [p, config[p].texture, Math.round(config[p].roughness * 1000), Math.round(config[p].metalness * 1000)]),
    Math.round(relief * 1000), Math.round(ao * 1000),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Flatten a profile: DEFAULT_CONFIG, then each level of the chain, most-derived last. */
export function resolveProfile(store: ProfileStore, id: string): ResolvedProfile {
  const chain = chainOf(store, id);
  const config = structuredClone(DEFAULT_CONFIG);
  let relief = getDefaultRelief();
  let ao = getDefaultAO();
  for (const step of chain) {
    const p = store.profiles[step]!;
    if (p.relief !== undefined) relief = p.relief;
    if (p.ao !== undefined) ao = p.ao;
    for (const [k, v] of Object.entries(p.types ?? {})) {
      const key = k as Preset;
      if (config[key]) config[key] = { ...config[key], ...v };
    }
  }
  return {
    id,
    label: store.profiles[id]?.label ?? id,
    chain,
    config,
    relief,
    ao,
    rev: revOf(config, relief, ao),
  };
}

// The catalog owns the out-of-the-box relief/AO values; read them once, before anything mutates the
// live state, so resolving a profile never inherits whatever the user last dragged a slider to.
let _defRelief: number | undefined;
let _defAO: number | undefined;
export function captureCatalogDefaults(): void {
  _defRelief ??= getRelief();
  _defAO ??= getAOStrength();
}
const getDefaultRelief = (): number => _defRelief ?? 0.45;
const getDefaultAO = (): number => _defAO ?? 0.7;

/** The rev of whatever is LIVE right now — comparable against a stored one. */
export function liveRev(): string {
  return revOf(getConfig(), getRelief(), getAOStrength());
}

// ---- apply / capture ------------------------------------------------------------------------

/** Make a resolved profile the live state. */
export function applyProfile(p: ResolvedProfile): void {
  setConfig(structuredClone(p.config));
  setRelief(p.relief);
  setAOStrength(p.ao);
}

/** Diff the LIVE state against a parent and return only what differs — the body of a new variant.
 *  This is what keeps `extends` honest: Save As can never freeze a full copy of its parent. */
export function captureDelta(store: ProfileStore, parentId: string | undefined, label: string): MaterialProfile {
  const base = parentId ? resolveProfile(store, parentId) : { config: DEFAULT_CONFIG, relief: getDefaultRelief(), ao: getDefaultAO() };
  const live = getConfig();
  const types: Partial<Record<Preset, Partial<TypeSetting>>> = {};
  for (const p of CONFIGURABLE_PRESETS) {
    const a = live[p], b = base.config[p];
    const d: Partial<TypeSetting> = {};
    if (a.texture !== b.texture) d.texture = a.texture;
    if (a.roughness !== b.roughness) d.roughness = a.roughness;
    if (a.metalness !== b.metalness) d.metalness = a.metalness;
    if (Object.keys(d).length) types[p] = d;
  }
  const out: MaterialProfile = { label };
  if (parentId) out.extends = parentId;
  if (getRelief() !== base.relief) out.relief = getRelief();
  if (getAOStrength() !== base.ao) out.ao = getAOStrength();
  if (Object.keys(types).length) out.types = types;
  return out;
}

/** How many type-overrides a profile declares itself (not counting what it inherits). */
export function deltaCount(p: MaterialProfile): number {
  return Object.keys(p.types ?? {}).length + (p.relief !== undefined ? 1 : 0) + (p.ao !== undefined ? 1 : 0);
}

// ---- the dev store (GET/POST /__lab/profiles, see vite.config.ts) -----------------------------

export async function loadProfiles(): Promise<ProfileStore> {
  try {
    const res = await fetch('/__lab/profiles');
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as ProfileStore;
  } catch (e) {
    console.warn('[profiles] store unavailable (dev middleware only) —', String(e));
    return structuredClone(EMPTY_STORE);
  }
}

export async function saveProfile(id: string, profile: MaterialProfile): Promise<{ ok: boolean; error?: string }> {
  return post({ id, profile });
}

export async function deleteProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  return post({ id, remove: true });
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/__lab/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Slugify a label into a stable id. */
export function idFromLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
}
