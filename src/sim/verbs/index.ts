// ============================================================================
// src/sim/verbs/index.ts — public surface of the verb system.
// ============================================================================
//
// The verb system (RUSH / GRAB / THROW / STRUGGLE + the five grab pressures) is a
// single deterministic, rollback-safe sim system. The integrator wires applyVerbs
// into step() as the LAST system (SYSTEM 6, after carry-transform); see verbs.ts.
// ============================================================================

export { applyVerbs, type RoleMap } from './verbs.ts';
export {
  Role,
  RUSH_DIST, RUSH_TICKS, RUSH_CD_TICKS, RUSH_STAGGER_TICKS,
  GRAB_REACH, GRAB_HALF_ANGLE, GRAB_LATCH_TICKS,
  THROW_J, THROW_CHARGE_TICKS, THROW_ANGLE_DEFAULT,
  SHOVE_J, SHOVE_REACH, SHOVE_CD_TICKS,
  STRUGGLE_BREAK, STRUGGLE_PRESS, STRUGGLE_DEBOUNCE_TICKS,
  REGRAB_IMMUNITY_TICKS, MAX_HELPLESS_TICKS,
  CARRY_SPEED_MUL, THROW_STRENGTH, STRUGGLE_STRENGTH,
} from './config.ts';
export { jitterUnit, JitterChannel } from './jitter.ts';
