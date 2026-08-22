// ============================================================================
// src/game/approved-assets.ts — the PUBLISHED, human-APPROVED asset store.
// ============================================================================
//
// The lab is an authoring tool: it auto-fits collision boxes (box-fit) and resolves materials
// (recolor) LIVE. This file is where a reviewer FREEZES the ones they've approved, so the game
// consumes reviewed, deterministic data instead of re-deriving it at runtime.
//
//   lab: auto-fit + recolor  →  reviewer clicks "Approve & save"  →  approved-assets.json  →  game
//
// The JSON is written by the Vite dev middleware (`/__lab/approve`, see vite.config.ts); this module
// is the typed read side. The boxes are in OBJECT-LOCAL metres (same as world-object Footprint); the
// materials are the resolved per-swatch recipe at approval time (frozen even if the live config later
// changes). Pure data — no DOM, no float/determinism constraints here (it's authoring output).
// ============================================================================

// `with { type: 'json' }` is REQUIRED by Node's `--experimental-strip-types` runner (the determinism
// proofs): tower.ts → tile-units.ts → here pulls this JSON into `prove:game`'s static graph, and the
// strip-types loader rejects a bare JSON import. tsc (module ESNext) + Vite/Vitest all accept the
// attribute, so it satisfies every consumer.
import data from './approved-assets.json' with { type: 'json' };

/** A collision box in object-local space (centre + half-extents, metres). */
export interface ApprovedBox { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; }

/** One swatch's frozen material recipe (what the recolor bake needs). */
export interface ApprovedSwatch {
  /** Atlas swatch name (palette.ts). */
  name: string;
  /** Atlas reference colour (hex). */
  ref: number;
  /** Resolved material preset (texture-catalog). */
  preset: string;
  /** Texture id the preset wore at approval (texture-catalog TEXTURES). */
  texture: string;
  tint: number;
  roughness: number;
  metalness: number;
}

/** The fit provenance — how the approved boxes were produced (for audit / re-fit). */
export interface ApprovedFit {
  edgeDensity: number;
  cell: number;
  fill: number;
  coverage: number;
  boxCount: number;
  seedMode: string;
  autoEdge: boolean;
}

/** Which material profile an approval came from (material-profiles.ts), and the content rev of the
 *  values frozen below. Null for entries approved before profiles existed. */
export interface ApprovedProfileRef { id: string; rev: string; }

/** Everything approved for one object. */
export interface ApprovedAsset {
  /** ISO timestamp the entry was last saved (stamped by the dev middleware). */
  approvedAt: string;
  footprint: { boxes: ApprovedBox[] };
  fit: ApprovedFit;
  materials: { relief: number; profile?: ApprovedProfileRef | null; swatches: ApprovedSwatch[] };
}

export interface ApprovedStore {
  version: number;
  objects: Record<string, ApprovedAsset>;
}

const store = data as ApprovedStore;

/** The whole approved store (objects keyed by lab object id). */
export const APPROVED_ASSETS: ApprovedStore = store;

/** The approved entry for an object, or undefined if not yet approved. */
export function getApproved(id: string): ApprovedAsset | undefined {
  return store.objects[id];
}

/** The approved collision footprint for an object (game collision), or undefined. */
export function getApprovedFootprint(id: string): { boxes: ApprovedBox[] } | undefined {
  return store.objects[id]?.footprint;
}

/** Whether an object has an approved entry. */
export function isApproved(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(store.objects, id);
}

/** Count of approved objects (for the lab's progress readout). */
export function approvedCount(): number {
  return Object.keys(store.objects).length;
}

// ---- profile linkage -------------------------------------------------------------------------
// Approval freezes a COPY of the resolved materials, which is what keeps the game stable while the
// lab is being retuned. The cost of that used to be total: retuning a material propagated to
// nothing and there was no way to tell which approved objects had fallen behind. Storing the
// profile id + content rev alongside the frozen copy keeps the stability and makes the staleness
// question answerable, so a bulk re-approve can be offered instead of remembered.

/** The profile ref an object was approved under, if any. */
export function approvedProfile(id: string): ApprovedProfileRef | undefined {
  return store.objects[id]?.materials.profile ?? undefined;
}

/** Approved object ids whose frozen materials do NOT match `rev` — i.e. what a re-approve would
 *  change. Entries approved before profiles existed count as stale: their look is unknown, not
 *  known-current. */
export function staleAgainst(rev: string): string[] {
  return Object.keys(store.objects).filter((id) => store.objects[id]!.materials.profile?.rev !== rev).sort();
}
