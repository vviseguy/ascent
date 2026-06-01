// ============================================================================
// src/sim/hazards/index.ts — public surface of the scripted-hazards layer.
// ============================================================================
// Re-exports the data model, the pure schedule cores, the apply system, the
// fall-damage helper, and the deterministic jitter utility, so consumers can
// `import { applyHazards, type Hazard, ... } from '../hazards/index.ts'`.
// ============================================================================

export * from './model.ts';
export * from './schedule.ts';
export * from './apply.ts';
export * from './falldamage.ts';
export * from './jitter.ts';
