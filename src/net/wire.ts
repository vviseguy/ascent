// ============================================================================
// src/net/wire.ts — the INPUT PACKET byte layout (encode/decode).
// ============================================================================
//
// Rollback sends INPUTS, not state (05-netcode-architecture §5). Every local sim
// tick a peer broadcasts its newest input plus the last-N inputs redundantly, so a
// dropped/reordered UDP-like datagram self-heals from the next one — no ACKs, no
// retransmit stalls. This module is the pure, deterministic codec for that packet.
//
// We encode the sim's PlayerInput (src/sim/world/input.ts), which is already
// integer-quantized: moveX/moveZ ∈ [-1024,1024], aim = raw Q16.16 angle, buttons
// bitfield, grabTarget id. To keep the packet tiny we requantize move to int8 and
// aim to a uint16 angle step on the wire, then expand back on decode to the exact
// same quantized values both peers will feed the (deterministic) sim. The KEY
// determinism requirement: encode∘decode must be a pure, lossless-after-requantize
// function so every peer reconstructs byte-identical InputFrames for a given tick.
//
// Packet (matches spec §5.1, adapted to our PlayerInput):
//   off  size  field
//   0    1     proto        (PROTO_VERSION)
//   1    1     kind         (PacketKind.Input)
//   2    1     playerId     (uint8, dense 0..N-1)
//   3    1     count        (number of frames in this packet, 1..MAX_REDUNDANT)
//   4    4     baseTick     (uint32 LE = tick of the FIRST/newest frame)
//   8    n*6   frames[]     newest→oldest, each 6 bytes:
//                 0: buttons  (uint8)
//                 1: moveX    (int8, quantized stick X)
//                 2: moveZ    (int8, quantized stick Z)
//                 3-4: aim    (uint16 LE, 65536-step angle)
//                 5: grabTgt  (uint8: grabTarget+1, 0 = none/-1; ids 0..254)
// ============================================================================

import type { PlayerInput } from '../sim/world/input.ts';
import { MOVE_Q } from '../sim/world/input.ts';
import { TWO_PI, toRaw, fromRaw, toFloat } from '../sim/fixed/fixed.ts';

export const PROTO_VERSION = 1;

/** Packet kinds (versioned-envelope discipline reused from Frequency). */
export const PacketKind = {
  Input: 1,
  CheckFrame: 2,
  Hello: 3,
  Welcome: 4,
  Ping: 5,
  Pong: 6,
  Sync: 7,
} as const;
export type PacketKind = (typeof PacketKind)[keyof typeof PacketKind];

/** Max redundant frames per packet (drop/reorder self-heal window). */
export const MAX_REDUNDANT = 12;
const FRAME_BYTES = 6;
const HEADER_BYTES = 8;

/** Clamp helper for int8 fields. */
const i8 = (n: number): number => (n < -127 ? -127 : n > 127 ? 127 : n | 0);

/** Requantize move [-MOVE_Q,MOVE_Q] → int8 [-127,127] (wire) and back. */
const moveToWire = (m: number): number => i8(Math.round((m / MOVE_Q) * 127));
const moveFromWire = (b: number): number => Math.round((b / 127) * MOVE_Q);

/** Aim raw-Fixed angle → uint16 step [0,65535] and back (65536 steps over 2π). */
const TWO_PI_RAW = toRaw(TWO_PI);
function aimToWire(rawAim: number): number {
  // normalize to [0, 2π) then scale to 16 bits
  let a = rawAim % TWO_PI_RAW;
  if (a < 0) a += TWO_PI_RAW;
  return Math.round((a / TWO_PI_RAW) * 65536) & 0xffff;
}
function aimFromWire(step: number): number {
  return toRaw(fromRaw(Math.round((step / 65536) * TWO_PI_RAW)));
}

/**
 * Encode an input packet: `frames[0]` is the NEWEST (at baseTick), `frames[1]` is
 * baseTick-1, etc. Returns an ArrayBuffer ready for transport.send. Pure.
 */
export function encodeInput(
  playerId: number,
  baseTick: number,
  frames: readonly PlayerInput[],
): ArrayBuffer {
  const n = Math.min(frames.length, MAX_REDUNDANT);
  const buf = new ArrayBuffer(HEADER_BYTES + n * FRAME_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, PROTO_VERSION);
  dv.setUint8(1, PacketKind.Input);
  dv.setUint8(2, playerId & 0xff);
  dv.setUint8(3, n & 0xff);
  dv.setUint32(4, baseTick >>> 0, true);
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    const o = HEADER_BYTES + i * FRAME_BYTES;
    dv.setUint8(o, f.buttons & 0xff);
    dv.setInt8(o + 1, moveToWire(f.moveX));
    dv.setInt8(o + 2, moveToWire(f.moveZ));
    dv.setUint16(o + 3, aimToWire(f.aim), true);
    dv.setUint8(o + 5, (f.grabTarget < 0 ? 0 : (f.grabTarget + 1)) & 0xff);
  }
  return buf;
}

/** A decoded input packet: per-tick frames keyed by their absolute tick. */
export interface DecodedInput {
  playerId: number;
  /** [{tick, frame}] newest→oldest exactly as packed. */
  frames: { tick: number; frame: PlayerInput }[];
}

/** Decode an input packet. Returns null if the buffer is malformed/wrong kind. */
export function decodeInput(buf: ArrayBuffer): DecodedInput | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== PROTO_VERSION) return null;
  if (dv.getUint8(1) !== PacketKind.Input) return null;
  const playerId = dv.getUint8(2);
  const n = dv.getUint8(3);
  if (buf.byteLength < HEADER_BYTES + n * FRAME_BYTES) return null;
  const baseTick = dv.getUint32(4, true);
  const frames: { tick: number; frame: PlayerInput }[] = [];
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + i * FRAME_BYTES;
    const tgt = dv.getUint8(o + 5);
    frames.push({
      tick: baseTick - i,
      frame: {
        buttons: dv.getUint8(o),
        moveX: moveFromWire(dv.getInt8(o + 1)),
        moveZ: moveFromWire(dv.getInt8(o + 2)),
        aim: aimFromWire(dv.getUint16(o + 3, true)),
        grabTarget: tgt === 0 ? -1 : tgt - 1,
      },
    });
  }
  return { playerId, frames };
}

/**
 * Requantize a PlayerInput through the wire codec WITHOUT serializing — the exact
 * value both peers will simulate. The local peer must feed THIS (not the raw input)
 * into its own sim, or it would simulate a slightly different input than remotes
 * decode, causing a guaranteed self-desync. Pure + idempotent.
 */
export function canonicalizeInput(f: PlayerInput): PlayerInput {
  return {
    buttons: f.buttons & 0xff,
    moveX: moveFromWire(moveToWire(f.moveX)),
    moveZ: moveFromWire(moveToWire(f.moveZ)),
    aim: aimFromWire(aimToWire(f.aim)),
    grabTarget: f.grabTarget < 0 || f.grabTarget > 254 ? -1 : f.grabTarget,
  };
}

/** Encode a check-frame (tick + state hash) on the reliable channel. */
export function encodeCheckFrame(playerId: number, tick: number, hash: number): ArrayBuffer {
  const buf = new ArrayBuffer(11);
  const dv = new DataView(buf);
  dv.setUint8(0, PROTO_VERSION);
  dv.setUint8(1, PacketKind.CheckFrame);
  dv.setUint8(2, playerId & 0xff);
  dv.setUint32(3, tick >>> 0, true);
  dv.setUint32(7, hash >>> 0, true);
  return buf;
}

export interface DecodedCheckFrame { playerId: number; tick: number; hash: number; }
export function decodeCheckFrame(buf: ArrayBuffer): DecodedCheckFrame | null {
  if (buf.byteLength < 11) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== PROTO_VERSION || dv.getUint8(1) !== PacketKind.CheckFrame) return null;
  return { playerId: dv.getUint8(2), tick: dv.getUint32(3, true), hash: dv.getUint32(7, true) };
}

// toFloat referenced for potential debug; keep import meaningful
void toFloat;
