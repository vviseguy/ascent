// ============================================================================
// src/sim/world/input.ts — the per-player input for one tick.
// ============================================================================
//
// Rollback sends INPUTS, not state (00-master-vision §12). This is the canonical
// per-player, per-tick input the sim consumes. It is small and integer-only so it
// quantizes cleanly onto the wire (the wire format in src/net will pack the last-N
// of these per packet for drop/reorder self-healing).
//
// The four verbs are the whole control scheme (pillar 2: RUSH / GRAB / THROW /
// STRUGGLE). Movement is a quantized direction; aim is a quantized angle. Nothing
// here is a float: move components are small signed integers in [-MOVE_Q, MOVE_Q]
// and aim is a raw Fixed angle — both reproducible across engines.
// ============================================================================

import { type Fixed, fromRaw, div, fromInt, ZERO } from '../fixed/fixed.ts';

/** Button bits in PlayerInput.buttons. Const object (not a TS `enum`) for strip-only compat. */
export const Button = {
  Rush: 1 << 0,
  Grab: 1 << 1,
  Throw: 1 << 2,
  Struggle: 1 << 3,
  Jump: 1 << 4,
  /** Anchor: plant/replant the crew beacon. Others: recall to the beacon. */
  Recall: 1 << 5,
  /** Role ability (context: Mender revive, Bulwark body-block, Engineer bridge…). */
  Ability: 1 << 6,
  /** RIGHT button held (mouse-first scheme): the SIM resolves a short TAP → Ability,
   *  a sustained HOLD → Rush, using a held-tick counter (deterministic, rollback-safe). */
  RightHold: 1 << 7,
  /**
   * PRIMARY interact (docs/11 §1): the contextual left-TAP action — pick up a loose
   * item, place/use the held item, grab a body, or open a container. The SIM's interact
   * system (src/sim/interact) resolves WHAT it does from the per-tick target + inventory.
   */
  Primary: 1 << 8,
  /**
   * SECONDARY interact (docs/11 §1): the contextual RIGHT action — throw the held body
   * or held item (hold to charge), or open a container. Resolved by the interact system.
   */
  Secondary: 1 << 9,
} as const;
export type Button = (typeof Button)[keyof typeof Button];

/**
 * "No slot selected this tick" sentinel for PlayerInput.slot. A LEVEL field: the IO layer
 * sets slot to 0..4 only on the tick the player actually changes the hotbar selection; a
 * neutral/dropped frame carries NO_SLOT so the sim leaves the current selection untouched
 * (a slot change is sticky in WorldState, not re-asserted every tick).
 */
export const NO_SLOT = -1;
/** Number of hotbar slots (docs/11 §4). */
export const NUM_SLOTS = 5;

/** Quantization scale for movement components: move ∈ [-MOVE_Q, MOVE_Q] integer. */
export const MOVE_Q = 1024;

/**
 * One player's input for one tick. Plain integers (serializable, hashable).
 *  - moveX / moveZ : intended move direction, each in [-MOVE_Q, MOVE_Q]. The pair
 *    encodes a stick vector; magnitude > MOVE_Q is clamped by the consumer.
 *  - aim           : facing/aim angle as a raw Fixed (radians).
 *  - buttons       : Button bitfield (now up to bit 9 → carried on the wire as a uint16).
 *  - grabTarget    : entity id the GRAB verb targets this tick, or -1 (resolved by
 *    the verb layer; included so grab intent is part of the deterministic input).
 *  - slot          : hotbar slot the player selected THIS tick (0..NUM_SLOTS-1), or
 *    NO_SLOT (-1) for "unchanged". A level field, not an edge (docs/11 §9.1).
 */
export interface PlayerInput {
  moveX: number;
  moveZ: number;
  aim: number; // raw Fixed
  buttons: number;
  grabTarget: number;
  slot: number;
}

/** The neutral input (no movement, no buttons). Used as the rollback prediction base. */
export const NEUTRAL_INPUT: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  aim: 0,
  buttons: 0,
  grabTarget: -1,
  slot: NO_SLOT,
};

/** True if a button bit is held this tick. */
export const isDown = (inp: PlayerInput, b: Button): boolean => (inp.buttons & b) !== 0;

/**
 * Decode the quantized move vector into Fixed components in roughly [-1, 1].
 * (Consumer normalizes/clamps magnitude.) Pure, deterministic.
 */
export function moveVec(inp: PlayerInput): { x: Fixed; z: Fixed } {
  const q = fromInt(MOVE_Q);
  return {
    x: div(fromInt(inp.moveX), q),
    z: div(fromInt(inp.moveZ), q),
  };
}

/** Aim as a Fixed angle. */
export const aimAngle = (inp: PlayerInput): Fixed => fromRaw(inp.aim);

/** A fresh neutral input object (when you need a mutable one). */
export const neutralInput = (): PlayerInput => ({ ...NEUTRAL_INPUT });

/** Zero Fixed re-export convenience for input consumers. */
export const ZERO_FIXED: Fixed = ZERO;
