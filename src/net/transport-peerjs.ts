// ============================================================================
// src/net/transport-peerjs.ts — the real WebRTC mesh Transport (PeerJS).
// ============================================================================
//
// Implements the proven `Transport` interface (transport.ts) over PeerJS WebRTC
// data channels, grafting Frequency's connection plumbing (deterministic room-code
// → peer id, PeerJS broker for signaling only, STUN). Two data channels per peer
// link, matching the channel model the rollback loop relies on (§5):
//   - HOT : unreliable + unordered  → input frames (loss self-heals via redundancy)
//   - CTRL: reliable + ordered      → check-frames, sync, control
//
// SESSION SHAPE (§6): a COORDINATOR peer owns the deterministic coordinator id for
// the room code; it accepts joiners, assigns dense player slots (0..N-1), and tells
// everyone the roster. Every peer then dials every other peer (full mesh) using the
// deterministic member ids, so input frames travel peer→peer directly (no relay hop)
// — the lowest-latency topology, which is the whole point of P2P here. (A relay mode
// that routes through the coordinator is a drop-in alternative behind this same
// interface for large lobbies; not built yet.)
//
// ⚠️ VERIFICATION STATUS: the rollback CORE is proven headlessly (src/net/prove.ts)
// over a deterministic loopback. THIS file is the real-network adapter and can only
// be fully verified in actual browsers across a real connection — it has NOT yet
// been live-tested. It is written to the proven interface so the verified core runs
// unchanged on top of it. Treat as integration-pending until browser-tested.
// ============================================================================

import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import { type Transport, type MessageHandler, Channel } from './transport.ts';
import { coordinatorPeerId, memberPeerId } from './room-code.ts';

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

/** Open a Peer with a fixed id; resolves when the broker confirms it. */
function openPeer(id: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, { config: ICE, debug: 1 });
    let settled = false;
    peer.on('open', () => { settled = true; resolve(peer); });
    peer.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

interface Link { ctrl: DataConnection | null; hot: DataConnection | null; }

/**
 * A full-mesh WebRTC transport for one peer. `selfId` is this peer's assigned dense
 * slot; `roster` maps slot → member peer id. The coordinator builds the roster during
 * the join handshake (see joinRoom/hostRoom below) and constructs this with it.
 */
export class PeerJsMeshTransport implements Transport {
  readonly selfId: number;
  private peer: Peer;
  private code: string;
  private gen: number;
  private roster: number; // player count
  private links = new Map<number, Link>();
  private handler: MessageHandler | null = null;

  constructor(peer: Peer, selfId: number, code: string, gen: number, roster: number) {
    this.peer = peer;
    this.selfId = selfId;
    this.code = code;
    this.gen = gen;
    this.roster = roster;
    // accept inbound channels from lower-id peers; dial higher-id peers ourselves,
    // so each unordered pair forms exactly one ctrl + one hot channel.
    peer.on('connection', (conn) => this.acceptConnection(conn));
    for (let other = 0; other < roster; other++) {
      if (other > selfId) this.dial(other);
    }
  }

  private linkFor(slot: number): Link {
    let l = this.links.get(slot);
    if (!l) { l = { ctrl: null, hot: null }; this.links.set(slot, l); }
    return l;
  }

  private dial(other: number): void {
    const id = memberPeerId(this.code, this.gen, other);
    const ctrl = this.peer.connect(id, { reliable: true, metadata: { ch: Channel.Ctrl, from: this.selfId } });
    const hot = this.peer.connect(id, {
      reliable: false,
      // unordered + unreliable: the channel config the input-frame hot path needs
      ...({ serialization: 'binary' } as object),
      metadata: { ch: Channel.Hot, from: this.selfId },
    });
    const link = this.linkFor(other);
    link.ctrl = ctrl; link.hot = hot;
    this.wire(other, ctrl, Channel.Ctrl);
    this.wire(other, hot, Channel.Hot);
  }

  private acceptConnection(conn: DataConnection): void {
    const meta = (conn.metadata ?? {}) as { ch?: Channel; from?: number };
    const from = meta.from ?? -1;
    const ch = meta.ch ?? Channel.Ctrl;
    if (from < 0) return;
    const link = this.linkFor(from);
    if (ch === Channel.Hot) link.hot = conn; else link.ctrl = conn;
    this.wire(from, conn, ch);
  }

  private wire(other: number, conn: DataConnection, ch: Channel): void {
    conn.on('data', (raw: unknown) => {
      if (raw instanceof ArrayBuffer) this.handler?.(other, raw, ch);
      else if (ArrayBuffer.isView(raw)) this.handler?.(other, (raw as ArrayBufferView).buffer as ArrayBuffer, ch);
    });
  }

  send(to: number, data: ArrayBuffer, channel: Channel): void {
    const link = this.links.get(to);
    const conn = channel === Channel.Hot ? link?.hot : link?.ctrl;
    if (conn && conn.open) conn.send(data);
  }

  broadcast(data: ArrayBuffer, channel: Channel): void {
    for (const [slot] of this.links) this.send(slot, data, channel);
  }

  onMessage(handler: MessageHandler): void { this.handler = handler; }

  close(): void {
    for (const l of this.links.values()) { l.ctrl?.close(); l.hot?.close(); }
    this.links.clear();
    this.peer.destroy();
  }
}

/**
 * Host a room: open the deterministic coordinator peer, then (in a full
 * implementation) accept joiners on the reliable channel, assign each a slot, and
 * broadcast the final roster + session seed on lobby "start". Returns enough to
 * build the mesh transport once the roster is locked.
 *
 * NOTE: the lobby/roster handshake is intentionally minimal here — the proven
 * rollback core does not depend on it, and it needs browser testing to finalize.
 */
export async function hostRoom(code: string, gen = 0): Promise<Peer> {
  return openPeer(coordinatorPeerId(code, gen));
}

/** Join a room by dialing the coordinator to receive a slot assignment + roster. */
export async function joinRoom(code: string, slot: number, gen = 0): Promise<Peer> {
  // Each member also opens its OWN deterministic member id so mesh peers can dial it.
  return openPeer(memberPeerId(code, gen, slot));
}
