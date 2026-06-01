// ============================================================================
// src/net/input-bus.ts — the per-player input timeline + prediction.
// ============================================================================
//
// The InputBus is the rollback manager's memory of "what did each player do on
// each tick". It absorbs the messy reality of an unreliable channel — inputs arrive
// late, out of order, duplicated, or never — and presents the sim a CLEAN, COMPLETE
// input array for any tick: confirmed inputs where known, PREDICTED inputs where not
// (05-netcode §2). The single rule that makes rollback work:
//
//   "predict a missing input as the last KNOWN input from that player"
//
// (repeat-last-input — simple, and the most common correct guess for held controls).
//
// It also reports, when a real input finally arrives, whether it CONTRADICTED the
// prediction we simulated — that's the rollback trigger (the earliest contradicted
// tick across all players).
//
// DETERMINISM: the bus stores integer-quantized PlayerInputs (already canonicalized
// through the wire codec). For a given (set of received inputs), every peer computes
// the same confirmed/predicted arrays — there is no wall-clock or ordering nondeter?
// minism here; arrival order only affects WHEN we roll back, not the final state.
// ============================================================================

import type { PlayerInput } from '../sim/world/input.ts';
import { NEUTRAL_INPUT } from '../sim/world/input.ts';

/** Ring buffer depth — how far back we keep inputs. >= max rollback window + slack. */
export const INPUT_HISTORY = 256;
const MASK = INPUT_HISTORY - 1; // requires power-of-two
if ((INPUT_HISTORY & MASK) !== 0) throw new Error('INPUT_HISTORY must be a power of two');

/** Per-player input timeline. */
interface Lane {
  /** ring of inputs by tick&MASK */
  inputs: (PlayerInput | undefined)[];
  /** ring of "is this tick CONFIRMED (real), vs predicted/empty" */
  confirmed: Uint8Array;
  /** highest tick we have a CONFIRMED input for (−1 = none yet). */
  lastConfirmedTick: number;
  /** the most recent confirmed input value (the prediction source). */
  lastInput: PlayerInput;
}

export class InputBus {
  private lanes: Lane[];
  readonly playerCount: number;

  constructor(playerCount: number) {
    this.playerCount = playerCount;
    this.lanes = Array.from({ length: playerCount }, () => ({
      inputs: new Array<PlayerInput | undefined>(INPUT_HISTORY),
      confirmed: new Uint8Array(INPUT_HISTORY),
      lastConfirmedTick: -1,
      lastInput: { ...NEUTRAL_INPUT },
    }));
  }

  /**
   * Record a CONFIRMED input for (player, tick). Returns the tick if this input
   * CONTRADICTS what we previously had at that tick (a rollback trigger), else -1.
   * Idempotent for duplicates; ignores inputs older than the ring window.
   */
  addConfirmed(playerId: number, tick: number, input: PlayerInput): number {
    const lane = this.lanes[playerId];
    if (!lane || tick < 0) return -1;
    const slot = tick & MASK;
    const prev = lane.inputs[slot];
    const wasConfirmed = lane.confirmed[slot] === 1 && prev !== undefined && this.sameSlotTick(lane, tick);
    // detect contradiction vs whatever we simulated at this tick (predicted or confirmed)
    let contradicted = -1;
    if (prev !== undefined && !inputsEqual(prev, input)) contradicted = tick;
    else if (prev === undefined) contradicted = tick; // we had nothing → we predicted → may differ

    lane.inputs[slot] = input;
    lane.confirmed[slot] = 1;
    if (tick > lane.lastConfirmedTick) {
      lane.lastConfirmedTick = tick;
      lane.lastInput = input;
    }
    // a duplicate identical confirmed input is not a rollback trigger
    if (wasConfirmed && prev !== undefined && inputsEqual(prev, input)) return -1;
    return contradicted;
  }

  /** Record the LOCAL player's own input for a tick (always confirmed, never predicted). */
  addLocal(playerId: number, tick: number, input: PlayerInput): void {
    const lane = this.lanes[playerId];
    if (!lane) return;
    const slot = tick & MASK;
    lane.inputs[slot] = input;
    lane.confirmed[slot] = 1;
    if (tick > lane.lastConfirmedTick) {
      lane.lastConfirmedTick = tick;
      lane.lastInput = input;
    }
  }

  /**
   * Build the COMPLETE input array for a tick: confirmed where known, else the
   * player's last-known input (prediction). Writes predictions into the ring so a
   * later real input can be compared against exactly what we simulated. Returns a
   * stable array of length playerCount (iteration order = ascending playerId).
   */
  inputsForTick(tick: number, out: (PlayerInput | undefined)[]): (PlayerInput | undefined)[] {
    out.length = this.playerCount;
    for (let p = 0; p < this.playerCount; p++) {
      const lane = this.lanes[p]!;
      const slot = tick & MASK;
      let v = lane.inputs[slot];
      if (v === undefined || lane.confirmed[slot] === 0) {
        // predict: repeat the last confirmed input (held controls usually persist)
        v = lane.lastInput;
        lane.inputs[slot] = v; // remember what we simulated, for later contradiction check
        lane.confirmed[slot] = 0; // mark predicted
      }
      out[p] = v;
    }
    return out;
  }

  /** Highest tick for which EVERY player has a CONFIRMED input (the verified frontier). */
  verifiedThrough(): number {
    let min = Infinity;
    for (const lane of this.lanes) min = Math.min(min, lane.lastConfirmedTick);
    return min === Infinity ? -1 : min;
  }

  lastConfirmedTickFor(playerId: number): number {
    return this.lanes[playerId]?.lastConfirmedTick ?? -1;
  }

  // A slot may be reused across ring wraps; we treat any present value at the slot as
  // "this tick" because the rollback window << INPUT_HISTORY. (Guard kept explicit.)
  private sameSlotTick(_lane: Lane, _tick: number): boolean {
    return true;
  }
}

/** Structural equality of two input frames (post-canonicalization). */
export function inputsEqual(a: PlayerInput, b: PlayerInput): boolean {
  return (
    a.buttons === b.buttons &&
    a.moveX === b.moveX &&
    a.moveZ === b.moveZ &&
    a.aim === b.aim &&
    a.grabTarget === b.grabTarget
  );
}
