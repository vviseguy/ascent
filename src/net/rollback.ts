// ============================================================================
// src/net/rollback.ts — the ROLLBACK MANAGER (the GGPO loop, transport-agnostic).
// ============================================================================
//
// Ties together the three proven pieces — the deterministic Sim, the InputBus
// (prediction memory), and a Transport (wire) — into the rollback loop
// (05-netcode §2). Per local tick it:
//   1. samples the local input, canonicalizes it through the wire codec (so we
//      simulate EXACTLY what remote peers will decode — else we self-desync),
//      records it, and broadcasts it + redundant history on the unreliable channel;
//   2. drains inbound input packets into the InputBus, noting the earliest tick any
//      arrival CONTRADICTED our prediction;
//   3. if a contradiction landed at tick R <= current, ROLLS BACK: restore the
//      saved snapshot at R and re-simulate forward to "now" with corrected inputs;
//   4. advances one new tick from confirmed+predicted inputs, saving each frame into
//      the ring for future rollback;
//   5. periodically emits a check-frame (state hash) on the reliable channel for
//      desync/tamper detection.
//
// SAVE/RESTORE uses the world snapshot ring (clone/restoreInto). The whole thing is
// deterministic: given the same inputs delivered in any order, every peer's world
// converges to the identical hash (proven in src/net/prove.ts).
// ============================================================================

import type { WorldState } from '../sim/world/state.ts';
import { hashWorld } from '../sim/world/hash.ts';
import { clone, restoreInto } from '../sim/world/snapshot.ts';
import type { PlayerInput } from '../sim/world/input.ts';
import type { Sim } from '../sim/sim.ts';
import { hashMatch } from '../game/match.ts';
import { InputBus, INPUT_HISTORY } from './input-bus.ts';
import { Channel, type Transport } from './transport.ts';
import {
  encodeInput, decodeInput, canonicalizeInput, encodeCheckFrame, decodeCheckFrame,
  PacketKind, PROTO_VERSION, MAX_REDUNDANT,
} from './wire.ts';

const RING = INPUT_HISTORY; // snapshot ring depth (matches input history)
const RING_MASK = RING - 1;
const CHECK_PERIOD = 30; // emit a check-frame every N verified ticks

/** A desync report: our hash disagreed with a peer's at a tick. */
export interface DesyncEvent { tick: number; peer: number; ours: number; theirs: number; }

export class RollbackManager {
  readonly sim: Sim;
  readonly bus: InputBus;
  private transport: Transport;
  private selfId: number;

  /** snapshot ring: states[tick & MASK] = world AT THE START of that tick. */
  private states: (WorldState | null)[] = new Array(RING).fill(null);
  /** parallel ring of MATCH snapshots (standings/beacons/win) for the same ticks. */
  private matchStates: (ReturnType<Sim['snapshotMatch']> | null)[] = new Array(RING).fill(null);
  /** scratch for assembling per-tick input arrays. */
  private inScratch: (PlayerInput | undefined)[] = [];
  /** earliest tick contradicted by an arrival since last resolve (-1 = none). */
  private pendingRollback = -1;
  /** local history of our own canonical inputs for redundant resend. */
  private localHistory: PlayerInput[] = [];
  /** check-frame log: peer hashes we've received, keyed tick→peer→hash. */
  private peerChecks = new Map<number, Map<number, number>>();
  readonly desyncs: DesyncEvent[] = [];
  /** input delay in ticks (local feel vs fewer rollbacks; §2.4). */
  inputDelay = 2;

  constructor(sim: Sim, transport: Transport, playerCount: number) {
    this.sim = sim;
    this.transport = transport;
    this.selfId = transport.selfId;
    this.bus = new InputBus(playerCount);
    transport.onMessage((from, data, ch) => this.onMessage(from, data, ch));
  }

  /** Inbound datagram dispatch. */
  private onMessage(_from: number, data: ArrayBuffer, ch: Channel): void {
    const dv = new DataView(data);
    if (dv.byteLength < 2 || dv.getUint8(0) !== PROTO_VERSION) return;
    const kind = dv.getUint8(1);
    if (kind === PacketKind.Input) {
      const dec = decodeInput(data);
      if (!dec) return;
      for (const { tick, frame } of dec.frames) {
        const contra = this.bus.addConfirmed(dec.playerId, tick, frame);
        if (contra >= 0 && (this.pendingRollback < 0 || contra < this.pendingRollback)) {
          this.pendingRollback = contra;
        }
      }
    } else if (kind === PacketKind.CheckFrame && ch === Channel.Ctrl) {
      const cf = decodeCheckFrame(data);
      if (cf) {
        let m = this.peerChecks.get(cf.tick);
        if (!m) { m = new Map(); this.peerChecks.set(cf.tick, m); }
        m.set(cf.playerId, cf.hash);
      }
    }
  }

  /**
   * Advance ONE local tick. `localInput` is this peer's raw input for the tick;
   * it is canonicalized (wire-quantized) before use so we simulate what peers decode.
   * Returns the new current tick.
   */
  tick(localInput: PlayerInput): number {
    const w = this.sim.world;
    const cur = w.tick;

    // 1. local input (canonical) → bus + broadcast with redundancy
    const canon = canonicalizeInput(localInput);
    this.bus.addLocal(this.selfId, cur, canon);
    this.localHistory[cur & RING_MASK] = canon;
    this.broadcastInput(cur);

    // 2/3. resolve any pending rollback BEFORE stepping forward
    if (this.pendingRollback >= 0 && this.pendingRollback <= cur) {
      this.rollbackTo(this.pendingRollback, cur);
      this.pendingRollback = -1;
    }

    // 4. save snapshot at the start of `cur`, then step to cur+1
    this.saveAt(cur);
    this.stepOnce(cur);

    // 5. periodic check-frame on a verified tick (FULL state: world + match).
    const verified = this.bus.verifiedThrough();
    if (verified >= 0 && verified % CHECK_PERIOD === 0) {
      const h = this.fullHashAt(verified);
      if (h !== null) {
        this.transport.broadcast(encodeCheckFrame(this.selfId, verified, h), Channel.Ctrl);
        this.compareChecks(verified, h);
      }
    }
    return this.sim.world.tick;
  }

  /** Combined world+match hash at a saved tick, or null if not in the ring. */
  private fullHashAt(tick: number): number | null {
    const snap = this.states[tick & RING_MASK];
    const m = this.matchStates[tick & RING_MASK];
    if (!snap || snap.tick !== tick || !m) return null;
    return hashMatch(m, hashWorld(snap));
  }

  /** Broadcast our input at `tick` plus the last MAX_REDUNDANT-1 for self-heal. */
  private broadcastInput(tick: number): void {
    const frames: PlayerInput[] = [];
    for (let i = 0; i < MAX_REDUNDANT; i++) {
      const t = tick - i;
      if (t < 0) break;
      const f = this.localHistory[t & RING_MASK];
      if (!f) break;
      frames.push(f);
    }
    this.transport.broadcast(encodeInput(this.selfId, tick, frames), Channel.Hot);
  }

  /** Save the world + match AT THE START of `tick` into the ring. */
  private saveAt(tick: number): void {
    const slot = tick & RING_MASK;
    const existing = this.states[slot];
    if (existing) restoreInto(existing, this.sim.world);
    else this.states[slot] = clone(this.sim.world);
    // match half snapshots by value each save (small: per-crew structs).
    this.matchStates[slot] = this.sim.snapshotMatch();
  }

  /** Step the sim one tick using bus inputs for `tick`. */
  private stepOnce(tick: number): void {
    const inputs = this.bus.inputsForTick(tick, this.inScratch);
    this.sim.advance(inputs);
  }

  /** Restore to tick R and re-simulate forward to `target` (current tick). */
  private rollbackTo(r: number, target: number): void {
    const snap = this.states[r & RING_MASK];
    const matchSnap = this.matchStates[r & RING_MASK];
    if (!snap || !matchSnap) return; // outside ring — would resync via check-frame
    restoreInto(this.sim.world, snap);
    this.sim.restoreMatchFrom(matchSnap);
    // re-run from r up to (but not past) target, re-saving each frame
    for (let t = r; t < target; t++) {
      this.saveAt(t);
      this.stepOnce(t);
    }
  }

  /** Highest tick for which we have a CONFIRMED input from every player. */
  verifiedThrough(): number {
    return this.bus.verifiedThrough();
  }

  /**
   * Hash of the saved world AT THE START of `tick` (i.e. after simulating 0..tick-1),
   * or null if that tick is no longer in the snapshot ring. For `tick <=
   * verifiedThrough()+1` this is a FULLY-CONFIRMED state — the correct thing to
   * compare across peers (the bleeding edge contains unconfirmed predictions and is
   * expected to differ). Used by the net proof.
   */
  hashAt(tick: number): number | null {
    if (tick < 0) return null;
    return this.fullHashAt(tick);
  }

  /** Compare our verified-tick hash to any peer hashes we have for that tick. */
  private compareChecks(tick: number, ours: number): void {
    const m = this.peerChecks.get(tick);
    if (!m) return;
    for (const [peer, theirs] of m) {
      if (theirs !== ours) this.desyncs.push({ tick, peer, ours, theirs });
    }
    this.peerChecks.delete(tick);
  }
}
