// ============================================================================
// src/game/boons.ts — the draft economy + Mario-Kart rubber-banding (docs/03).
// ============================================================================
//
// The in-run progression: at milestone floors a crew DRAFTS a boon (crew-shared,
// never per-player — C2). The trailing crew draws BETTER boons via deterministic
// rubber-banding driven by ONE input: normalized altitude deficit `d` (C1/C4).
//
// DETERMINISM (C6): every draw uses a seeded PRNG keyed on (runSeed, crewId, draft
// index) and integer math — never the JS built-in random, never wall-clock. Draft
// resolution is a pure function of (seed, crewState, leaderHeight). The active-boon
// set + momentum + draft cursor live in MatchState.crews (hashed, snapshotted), so
// progression rolls back exactly like everything else.
//
// This module is pure logic over plain numbers; the boon EFFECTS are applied by
// readers (e.g. Slipstream reads activeBoons each tick). We ship a starter pool and
// the full rubber-band curve; effect wiring is intentionally small + extensible.
// ============================================================================

import { mixSeeds, makeRng, nextInt, nextFloat01, type Rng } from '../floor/rng.ts';

/** Boon rarity tiers (index = tier; higher = rarer). */
export const Tier = { Common: 0, Uncommon: 1, Rare: 2, Legendary: 3 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/** Base tier weights at zero deficit (docs/03 §3). */
const BASE_WEIGHTS: readonly number[] = [60, 28, 10, 2];

export interface BoonDef {
  id: number;
  name: string;
  tier: Tier;
  /** which physical/escort fantasy it deepens (flavor + filtering). */
  tag: 'grab' | 'throw' | 'carry' | 'build' | 'route' | 'protect';
  /** true if this is a comeback-pool boon (only offered to trailing crews, §4.3C). */
  comeback?: boolean;
}

/** Starter boon pool (C3: physical/escort only — no DPS/anti-NPC). */
export const BOON_POOL: readonly BoonDef[] = [
  { id: 0, name: 'Sure Grip', tier: Tier.Common, tag: 'grab' },
  { id: 1, name: 'Long Arms', tier: Tier.Common, tag: 'grab' },
  { id: 2, name: 'Strong Toss', tier: Tier.Common, tag: 'throw' },
  { id: 3, name: 'Sticky Boots', tier: Tier.Common, tag: 'route' },
  { id: 4, name: 'Light Step', tier: Tier.Common, tag: 'route' },
  { id: 5, name: 'Padded Cargo', tier: Tier.Uncommon, tag: 'carry' },
  { id: 6, name: 'Quick Hands', tier: Tier.Uncommon, tag: 'grab' },
  { id: 7, name: 'Spotter', tier: Tier.Uncommon, tag: 'protect' },
  { id: 8, name: 'Reinforced Bridge', tier: Tier.Uncommon, tag: 'build' },
  { id: 9, name: 'Cannon Arm', tier: Tier.Rare, tag: 'throw' },
  { id: 10, name: 'Anchor Harness', tier: Tier.Rare, tag: 'carry' },
  { id: 11, name: 'Bodyguard', tier: Tier.Rare, tag: 'protect' },
  { id: 12, name: 'Featherweight Anchor', tier: Tier.Legendary, tag: 'carry' },
  { id: 13, name: 'Grapple Mastery', tier: Tier.Legendary, tag: 'grab' },
  // comeback-pool (only offered when catchup is high)
  { id: 14, name: 'Slipstream', tier: Tier.Rare, tag: 'route', comeback: true },
  { id: 15, name: 'Second Wind', tier: Tier.Uncommon, tag: 'protect', comeback: true },
];

// ---- rubber-banding (docs/03 §4) -------------------------------------------

/** Deficit (in floors) at which catch-up saturates. */
export const DEFICIT_SCALE = 30;
/** Leader deadzone: crews within this many floors of the top get NO catch-up. */
export const LEAD_DEADZONE_FLOORS = 2;
const RARITY_UPLIFT_MAX = 0.18;

/** clamp helper */
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The one rubber-band input → the catch-up scalar (0..1, S-curved). `deficitFloors`
 * = leaderHeightFloors − thisCrewHeightFloors. Pure (docs/03 §4.1-4.2).
 */
export function catchupFactor(deficitFloors: number): number {
  if (deficitFloors <= LEAD_DEADZONE_FLOORS) return 0; // near the lead → no help (C4)
  const d = clamp01(deficitFloors / DEFICIT_SCALE);
  return d * d * (3 - 2 * d); // smoothstep
}

/** Tier weights shifted upward by the catch-up uplift (docs/03 §4.3A). */
function shiftedWeights(catchup: number): number[] {
  const uplift = catchup * RARITY_UPLIFT_MAX; // fraction of mass to move upward
  const w = BASE_WEIGHTS.slice();
  // move `uplift` fraction of Common/Uncommon mass up one tier, deterministically.
  const total = w.reduce((a, b) => a + b, 0);
  const moveC = Math.round(w[0]! * uplift);
  const moveU = Math.round(w[1]! * uplift);
  w[0]! -= moveC; w[1]! += moveC;
  w[1]! -= moveU; w[2]! += moveU;
  // a sliver to Legendary at high catchup (tops out ~4%, docs/03)
  const legBump = Math.round(total * 0.02 * catchup);
  w[2]! -= legBump; w[3]! += legBump;
  for (let i = 0; i < w.length; i++) if (w[i]! < 0) w[i] = 0;
  return w;
}

/** How many cards to offer (3 base; 4 at catchup ≥ 0.5, §4.3B). */
export function offerSize(catchup: number): number {
  return catchup >= 0.5 ? 4 : 3;
}

/** Whether a free reroll is granted (catchup ≥ 0.85, §4.3B). */
export function freeReroll(catchup: number): boolean {
  return catchup >= 0.85;
}

/**
 * Draw a draft offer for a crew. Deterministic from (runSeed, crewId, draftIndex,
 * catchup). Returns the offered boon ids. comeback-pool boons are eligible only when
 * catchup ≥ 0.4 (§4.3C). Pure.
 */
export function drawOffer(
  runSeed: bigint,
  crewId: number,
  draftIndex: number,
  catchup: number,
): number[] {
  const rng = makeRng(mixSeeds(runSeed & 0xffffffffffffffffn, ((BigInt(crewId) << 40n) ^ (BigInt(draftIndex) << 8n)) & 0xffffffffffffffffn));
  const n = offerSize(catchup);
  const weights = shiftedWeights(catchup);
  const allowComeback = catchup >= 0.4;
  const offer: number[] = [];
  const used = new Set<number>();
  let guard = 0;
  while (offer.length < n && guard++ < 200) {
    const tier = weightedTier(rng, weights);
    const candidates = BOON_POOL.filter(
      (b) => b.tier === tier && (!b.comeback || allowComeback) && !used.has(b.id),
    );
    if (candidates.length === 0) continue;
    const pick = candidates[nextInt(rng, candidates.length)]!;
    used.add(pick.id);
    offer.push(pick.id);
  }
  return offer;
}

function weightedTier(rng: Rng, weights: readonly number[]): Tier {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Tier.Common;
  let r = Math.floor(nextFloat01(rng) * total);
  for (let t = 0; t < weights.length; t++) {
    if (r < weights[t]!) return t as Tier;
    r -= weights[t]!;
  }
  return Tier.Common;
}

/** A crew's live Slipstream climb bonus (fraction), if it holds Slipstream (§4.3C). */
export function slipstreamBonus(hasSlipstream: boolean, catchup: number): number {
  return hasSlipstream ? catchup * 0.12 : 0;
}

/** Lookup a boon def by id. */
export function boonById(id: number): BoonDef | undefined {
  return BOON_POOL.find((b) => b.id === id);
}
