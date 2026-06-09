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
} as const;
export type Button = (typeof Button)[keyof typeof Button];

/** Quantization scale for movement components: move ∈ [-MOVE_Q, MOVE_Q] integer. */
export const MOVE_Q = 1024;

/**
 * One player's input for one tick. Plain integers (serializable, hashable).
 *  - moveX / moveZ : intended move direction, each in [-MOVE_Q, MOVE_Q]. The pair
 *    encodes a stick vector; magnitude > MOVE_Q is clamped by the consumer.
 *  - aim           : facing/aim angle as a raw Fixed (radians).
 *  - buttons       : Button bitfield.
 *  - grabTarget    : entity id the GRAB verb targets this tick, or -1 (resolved by
 *    the verb layer; included so grab intent is part of the deterministic input).
 */
export interface PlayerInput {
  moveX: number;
  moveZ: number;
  aim: number; // raw Fixed
  buttons: number;
  grabTarget: number;
}

/** The neutral input (no movement, no buttons). Used as the rollback prediction base. */
export const NEUTRAL_INPUT: PlayerInput = {
  moveX: 0,
  moveZ: 0,
  aim: 0,
  buttons: 0,
  grabTarget: -1,
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
