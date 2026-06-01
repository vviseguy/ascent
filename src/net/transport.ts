// ============================================================================
// src/net/transport.ts — the Transport seam (mesh|relay) + a test loopback.
// ============================================================================
//
// Reused in spirit from Frequency's `transport.ts`: a uniform send/broadcast/
// onMessage abstraction that hides whether we're a full mesh of peers or routing
// through a relay-anchor (05-netcode §6 — this interface IS the mesh|relay seam).
// ASCENT differs in CHANNELS: input frames go on an UNRELIABLE/UNORDERED channel
// (loss is fine — we send redundant history and predict gaps); control/check-frames
// go on a RELIABLE channel. The real implementation (PeerJS WebRTC data channels,
// grafting Frequency's peer/migration plumbing) lands in transport-peerjs.ts; this
// file is the interface + an in-process loopback used by the headless net proof to
// simulate latency, jitter, loss, and reordering deterministically.
// ============================================================================

/** Which channel a datagram travels on. */
export const Channel = {
  /** unreliable, unordered — input frames (hot path). Loss self-heals via redundancy. */
  Hot: 0,
  /** reliable, ordered — control, check-frames, sync, lobby. */
  Ctrl: 1,
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export type MessageHandler = (from: number, data: ArrayBuffer, channel: Channel) => void;

export interface Transport {
  /** This peer's dense player id (assigned at session start). */
  readonly selfId: number;
  /** Send to one peer. */
  send(to: number, data: ArrayBuffer, channel: Channel): void;
  /** Send to all other peers. */
  broadcast(data: ArrayBuffer, channel: Channel): void;
  /** Register the inbound handler. */
  onMessage(handler: MessageHandler): void;
  /** Tear down. */
  close(): void;
}

// ----------------------------------------------------------------------------
// LoopbackMesh — a deterministic in-process transport for tests/proofs.
// ----------------------------------------------------------------------------
//
// Connects N virtual peers in one process. A pluggable `link` model decides, per
// datagram, its delivery delay (in ticks) and whether it drops — driven by a SEEDED
// integer PRNG so a run is reproducible (NEVER Math.random). The harness drives
// delivery by calling `pump(now)` as its tick advances, releasing datagrams whose
// arrival tick has come. This lets the net proof inject controlled latency / loss /
// reorder and assert all peers still converge to identical state.

/** Per-datagram network model. Return {delayTicks, drop}. Deterministic (seeded). */
export interface LinkModel {
  shape(from: number, to: number, channel: Channel, seqNo: number): { delayTicks: number; drop: boolean };
}

interface InFlight { to: number; from: number; data: ArrayBuffer; channel: Channel; arriveAt: number; seq: number; }

export class LoopbackHub {
  private handlers = new Map<number, MessageHandler>();
  private queue: InFlight[] = [];
  private seq = 0;
  readonly peerCount: number;
  private link: LinkModel;
  constructor(peerCount: number, link: LinkModel) {
    this.peerCount = peerCount;
    this.link = link;
  }

  register(id: number, h: MessageHandler): void { this.handlers.set(id, h); }

  enqueue(from: number, to: number, data: ArrayBuffer, channel: Channel, now: number): void {
    const s = this.seq++;
    const { delayTicks, drop } = this.link.shape(from, to, channel, s);
    // The reliable channel never truly drops — model it as "redelivered later".
    if (drop && channel === Channel.Hot) return;
    const delay = drop ? delayTicks + 30 : delayTicks; // ctrl loss → big delay, not gone
    this.queue.push({ to, from, data, channel, arriveAt: now + Math.max(0, delay), seq: s });
  }

  /** Deliver all datagrams whose arrival tick <= now. Reliable channel preserves
   *  per-(from,to) order; hot channel may deliver out of order (that's the point). */
  pump(now: number): void {
    const due = this.queue.filter((m) => m.arriveAt <= now);
    this.queue = this.queue.filter((m) => m.arriveAt > now);
    // Deterministic delivery order: ctrl ordered by seq; hot ordered by (arriveAt, seq)
    // — hot reordering across different arriveAt is the realistic case we want to test.
    due.sort((a, b) => {
      if (a.channel !== b.channel) return a.channel - b.channel;
      if (a.channel === Channel.Ctrl) return a.seq - b.seq;
      return a.arriveAt - b.arriveAt || a.seq - b.seq;
    });
    for (const m of due) this.handlers.get(m.to)?.(m.from, m.data, m.channel);
  }

  pending(): number { return this.queue.length; }
}

/** A Transport view for one peer over a shared LoopbackHub. */
export class LoopbackTransport implements Transport {
  readonly selfId: number;
  private hub: LoopbackHub;
  private nowFn: () => number;
  constructor(selfId: number, hub: LoopbackHub, nowFn: () => number) {
    this.selfId = selfId;
    this.hub = hub;
    this.nowFn = nowFn;
  }
  send(to: number, data: ArrayBuffer, channel: Channel): void {
    this.hub.enqueue(this.selfId, to, data, channel, this.nowFn());
  }
  broadcast(data: ArrayBuffer, channel: Channel): void {
    for (let to = 0; to < this.hub.peerCount; to++) {
      if (to !== this.selfId) this.hub.enqueue(this.selfId, to, data, channel, this.nowFn());
    }
  }
  onMessage(handler: MessageHandler): void { this.hub.register(this.selfId, handler); }
  close(): void { /* no-op for loopback */ }
}
