# 05 — Netcode & Technical Architecture (v2)

> Status: authoritative v2. Supersedes the v1 file (per-crew instances + NPC sync — both
> deleted). This is the deepest technical doc; other docs defer to the contracts here.
> Read alongside `01-game-design.md`, `04-competitive-structure.md`, `06-art-direction-shaders.md`,
> `09-level-generation.md`. Reference codebase: `c:/Users/Jacob/Documents/Projects/frequency`.

This game is a **rollback-netcode realtime climber**, not a turn-based party game. That single
fact reframes everything we inherit from Frequency. Frequency is **host-authoritative,
single-reducer, snapshot-broadcast, no per-frame prediction**. ASCENT must be **peer-symmetric,
deterministic-lockstep-with-rollback, input-broadcast, predict-every-frame**. So we **reuse
Frequency's connection lifecycle and keep almost none of its game-loop model.** The boundary is
stated precisely below before any new design.

---

## 0. REUSE vs REPLACE (read `frequency/src/net/` + `frequency/CLAUDE.md` first)

Frequency's `src/net/` modules and their documented behavior (CLAUDE.md "Architecture" + "UI
conventions / Back button / Reconnection"):

| Frequency module | What it does today | ASCENT verdict |
|---|---|---|
| `roomCode.ts` (`RoomCodec`) | deterministic `freqv1-<CODE>-g<gen>` → peerId, no directory service | **REUSE** verbatim (rebrand prefix `ascv1-`). Determinism of the join target is exactly what we want; the generation suffix is also our migration ladder. |
| `migration.ts` (`nextHost`) | senior connected peer (lowest `joinedAt`) becomes host at `gen+1`, silent | **REUSE the election rule**, **REPURPOSE the role.** We are peer-symmetric, so the "host" is no longer the simulation owner — it becomes the **session coordinator / relay-anchor / signaling pivot** (see §6). The generation ladder + silent migration is still gold. |
| `net.ts` (`NetController`) | wires transport + zustand store + migration | **REUSE the shell** (lifecycle owner, holds transport, drives migration). **REPLACE its payload semantics**: it no longer pumps intents into a reducer; it pumps **input frames into the InputBus** (§3) and owns the rollback loop's network side. |
| `transport.ts` (`Transport` interface + PeerJS impl) | uniform `send/broadcast/onMessage/onPeerJoin/onPeerLeave`, hides host/peer | **REUSE the interface shape, REPLACE the channel config.** Frequency uses PeerJS default (reliable/ordered SCTP) — fine for clue text. We need **unreliable/unordered** data channels for input frames (§5). Keep one reliable channel for control. The `Transport` abstraction is exactly our `mesh|relay` seam (§6). |
| `protocol.ts` (`ProtocolEnvelope`, versioned `kind`) | tiny versioned envelope: intent/snapshot/hello/welcome/ping/pong | **REUSE the versioned-envelope discipline.** **REPLACE the kinds**: drop `snapshot`; add `input`, `checkframe`, `commit`, `reveal`, `sync` (§5). Keep `hello/welcome/ping/pong`. |
| `peer.ts` / `peerClient.ts` / `hostServer.ts` | PeerJS dial/accept plumbing, host accepts many + peer dials host | **REUSE as the relay-mode plumbing.** In mesh mode every peer both accepts and dials (full mesh), so we generalize "host accepts many / peer dials host" into "anchor accepts many / others also dial each other." |
| `netStore.ts` (zustand) | net state for UI; "net code never touches the DOM, reads/writes stores" | **REUSE the principle hard.** Sim never touches DOM or stores per-frame; only a throttled **presentation projection** writes to a zustand store for React chrome (lobby, standings, RTT HUD). The 60Hz sim talks to the renderer directly, not through zustand. |
| Reconnection logic (CLAUDE.md): recreate Peer on destroy/disconnect, `peer-unavailable` fails a dead generation instantly, ~5s live-host window | **REUSE the tuning verbatim.** "Don't shorten these blindly — a 1s timeout was the can't-reconnect bug." We inherit that scar tissue. Flaky-connection resilience is a stated UX bar. |
| Kick / idle-drop / banned set | host-only `KICK`, auto-drop > IDLE_DROP_MS | **REUSE**, owned by the coordinator role. A dropped climber's entity is frozen then collapsed-out (§7 drop-in/out). |
| Reducer / game loop / phases / snapshot broadcast | host runs one reducer, broadcasts full `RoomState` | **REPLACE ENTIRELY.** This is the single biggest delta. No central reducer; no full-state broadcast on the hot path. State is *derived locally* by every peer from the shared input stream via the deterministic SIM CORE (§1) + ROLLBACK MANAGER (§2). |

**One-line summary:** we keep Frequency's *connection brain* (deterministic room codes, silent
generation-ladder migration, the `Transport` seam, reconnection tuning, drop/ban handling) and
throw away its *simulation brain* (host-authoritative reducer + snapshot broadcast), replacing it
with deterministic rollback over input frames.

---

## 1. Deterministic fixed-timestep SIM CORE

The sim core is a **pure function of (previous state, all players' inputs for the tick)**. No
wall-clock, no `Math.random`, no DOM, no floats-from-the-renderer leaking back in. Every peer runs
the identical core and *must* produce bit-identical state for identical inputs. This is the whole
ballgame; everything else (rollback, AoI, anti-cheat) is bookkeeping around this invariant.

### 1.1 Tick model
- **Fixed timestep: 60 Hz, `DT = 1/60 s` exactly.** Stored as the integer tick index, never as
  accumulated seconds. The renderer runs free (rAF, interpolates between sim ticks); the sim runs in
  fixed steps driven by an accumulator. The *sim clock is the shared tick counter*, never
  `performance.now()` (per the bible's time/clock note). `performance.now()` is allowed **only** in
  the transport layer for RTT/timeout/jitter-buffer math — it must never enter `step()`.
- Render decoupling: `accumulator += realDelta; while (accumulator >= DT) { step(); accumulator -= DT; }`
  then render with `alpha = accumulator / DT` interpolation. Clamp `realDelta` (spiral-of-death guard)
  to e.g. 250 ms; on a stall we *drop render frames, never sim ticks* — dropping sim ticks desyncs.

### 1.2 The core interface

```ts
// All numbers in the sim are deterministic. See §8 for float policy.
export type Tick = number;            // integer sim frame index, shared across peers
export type PlayerId = number;        // dense 0..N-1 index, assigned at session start (stable)

export interface InputFrame {
  // Bit-packed control state for ONE player on ONE tick. ~3 bytes (see §5.1).
  buttons: number;     // bitfield: jump, grab, role-primary, role-secondary, shove, interact, ...
  moveX: number;       // quantized stick X, int8 [-127..127]
  moveY: number;       // quantized stick Y, int8 [-127..127]
  aim: number;         // quantized aim angle, uint8 (256 steps) — for shove/breaker direction
}

export interface SimConfig {
  seed: bigint;                 // session seed -> all PRNG + floor-gen (NEVER built-in random)
  stakes: StakesConfig;         // per-lobby tunable: revives/downed-not-dead .. permadeath
  playerCount: number;
  // role assignment, lobby rules, collapse pacing curve, etc.
}

export interface SimState {
  tick: Tick;
  rng: PrngState;               // serializable PRNG cursor (§8.2)
  players: PlayerSimState[];    // FIXED iteration order = ascending PlayerId (§8.4)
  collapse: CollapseState;      // rising hazard front height + pacing
  strata: StrataRuntime;        // per-stratum runtime: which routes formed, destructible HP,
                                //   crusher phases, turret timers, pickup availability
  // NOTE: strata GEOMETRY is regenerated from (seed, stratumIndex) on demand (§9 cross-ref),
  //   NOT stored per-tick. Only mutable runtime deltas live here -> small save/restore.
}

export interface SimCore {
  init(cfg: SimConfig): SimState;
  // Pure: same inputs -> same next state, on every browser, forever.
  step(state: SimState, inputs: ReadonlyArray<InputFrame>): SimState;
  // Snapshot for rollback save/restore. MUST be a deep, value-only copy.
  save(state: SimState): SimSnapshot;
  restore(snap: SimSnapshot): SimState;
  // Determinism check value (§8.5, §9-anticheat). FNV-1a/xxhash over the canonical byte layout.
  hash(state: SimState): number;   // uint32
}
```

`inputs[i]` is the `InputFrame` for `PlayerId === i` on `state.tick`. `inputs.length === playerCount`
**always** — disconnected/late players are filled by prediction (§2), never absent. This keeps
iteration order and array shape constant, which is a determinism requirement (§8.4).

### 1.3 Save/restore strategy (the rollback-critical part)
Rollback re-simulates up to ~k frames every time a misprediction lands, so `save`/`restore`/`step`
must be cheap and allocation-light.

- **Ring of pre-allocated snapshots**, depth = max rollback window + slack (we size **16**; tight
  cluster needs ~5, we keep headroom for worst-peer order statistics, §6). No per-frame GC churn.
- **State is a flat, typed-array-friendly struct-of-arrays where it's hot** (player positions/
  velocities/HP, destructible HP, timers). `save` is a `set()`/`copyWithin` of typed arrays into the
  ring slot — microseconds, not a JSON clone.
- **Strata geometry is NOT in the snapshot.** It is a pure function of `(seed, stratumIndex)` and the
  reveal/coalescence animation is *view-layer only* (bible: "ALL of this is VIEW-LAYER … determinism-
  safe"). We snapshot only the small *runtime mutable* set (route-formed flags, destructible HP,
  hazard phase counters, pickup taken bits, collapse front). This is why save/restore stays cheap
  even though the world is huge. See `09-level-generation.md` for the gen contract.

### 1.4 What the core simulates (and what it explicitly does not)
Simulates: player movement/physics, jumps/grabs/falls/catches, collapse front rise, destructible
terrain HP + breakage, crushers/turrets/timed traps (deterministic scripted hazards — fixed phase
counters keyed off `tick`), pickups, shove/contest PvP verbs, boon effects, downed/revive/permadeath
per stakes, race standings derivation (height-based).

Does **not** simulate: any AI / behavior tree / creature (the bible bans these — **the single
biggest determinism win**; no cross-browser AI to keep bit-identical). Hazards are *scripted and
deterministic*: a crusher is `phase = (tick + offset) % period`, a turret fires on
`tick % cadence === 0`, the collapse front height is a closed-form/seeded curve. All telegraphs are
view-layer reads of these deterministic counters.

---

## 2. ROLLBACK MANAGER (GGPO-style)

Owns: the input ring buffer, prediction of remote inputs, detecting when a real input contradicts a
prediction, rolling back to the last verified tick and re-simulating forward, and the input-delay
dial. Local input is **always applied instantly** (predict-confirm model).

### 2.1 Data structures

```ts
const HISTORY = 128;             // power of two; ~2.1s of ticks; index by (tick & (HISTORY-1))

interface RollbackManager {
  // Per-player ring of received/predicted inputs.
  inputs: Int32Array[];          // [playerId][tick & MASK] -> packed InputFrame word(s)
  confirmed: Int32Array;         // [playerId] -> highest tick with a REAL (non-predicted) input
  predictedFrom: Int32Array;     // [playerId] -> tick we started predicting from (for rollback span)

  localPlayer: PlayerId;
  currentTick: Tick;             // sim has advanced to here (predicted)
  lastVerifiedTick: Tick;        // min over players of confirmed -> fully trustworthy below this

  states: SimSnapshot[];         // ring of saved states, indexed by tick & MASK (§1.3)
}
```

### 2.2 Prediction
When a remote player's input for `tick` hasn't arrived, **repeat their last known input** (hold the
buttons/stick). This is the standard GGPO heuristic and is right for a climber: movement intent is
highly autocorrelated frame-to-frame; repeating "still holding jump+right" mispredicts rarely. We do
**not** try fancier extrapolation — simpler = fewer rollback triggers in aggregate and trivially
deterministic.

### 2.3 The frame loop (per sim tick)

```
1. Sample local input -> store as REAL at inputs[local][tick].
2. For each remote player without a REAL input at `tick`: synthesize predicted = inputs[p][lastReal].
3. save(state) into states[tick & MASK].
4. state = step(state, assembledInputs).  // advance one tick, locally authoritative-by-prediction
5. currentTick++.
6. On network receive of REAL inputs (any tick t): if it differs from what we predicted at t:
      a. rollbackTo = t (the earliest contradicted tick).
      b. state = restore(states[rollbackTo & MASK]).
      c. re-run step() from rollbackTo up to currentTick, using now-corrected inputs
         (still predicting any inputs that remain unknown).
      d. update lastVerifiedTick = min_p(confirmed[p]).
7. Periodically (every CHECK_PERIOD ticks <= lastVerifiedTick) compute hash(state) -> check-frame (§9).
```

Rollback re-sim cost = `(currentTick - rollbackTo) * stepCost`. With `step()` at single-digit µs and
a clamped window this is sub-millisecond and invisible. **The window is bounded by AoI (§6): we only
ever re-sim entities in the local tight-sync band; fogged remote crews are not in the rollback set.**

### 2.4 Input-delay dial
Two knobs, exposed and auto-tuned:
- **`inputDelay` (frames):** locally delay applying *your own* input by N frames so remote inputs are
  more likely to have arrived → fewer rollbacks at the cost of N/60 s of local latency. Auto-set per
  peer-cluster from RTT: `inputDelay = clamp(round(maxClusterRTT/2 / DT) , 1, 4)`. Re-evaluated
  slowly (hysteresis) so it doesn't oscillate.
- **`maxRollbackFrames`:** hard cap (we use 8 in tight clusters). If a peer falls further behind than
  this, we **stop predicting them** and freeze/interpolate their avatar (treat as "fogging out", §6)
  rather than rolling back across a huge span. This bounds worst-case CPU.

Trade-off statement: input delay trades *local feel* for *fewer visible corrections*; rollback trades
*CPU + occasional visual snap* for *zero local latency*. We bias toward **low input delay + rollback**
for the local player's traversal (tight, responsive jumps matter), and toward **more input delay**
only as cluster RTT degrades. This is per-cluster, not global.

---

## 3. INPUT BUS (behind the `mesh | relay` interface)

The Rollback Manager never speaks PeerJS. It speaks to an **InputBus** that abstracts *how* input
frames reach other peers. This is the generalization of Frequency's `Transport` seam.

```ts
export interface InputBus {
  readonly localPlayer: PlayerId;
  readonly peers: ReadonlyArray<PlayerId>;

  // Broadcast our local input + redundant last-N (§5). Fire-and-forget, unreliable channel.
  sendInput(tick: Tick, frame: InputFrame): void;

  // Deliver received inputs to the rollback manager (may be out-of-order / duplicated / dropped).
  onInputs(cb: (from: PlayerId, frames: TickedInput[]) => void): () => void;

  // Reliable side-channel: check-frame hashes, commit/reveal, sync handshakes, lobby control.
  sendControl(to: PlayerId | 'all', msg: ControlMsg): void;
  onControl(cb: (from: PlayerId, msg: ControlMsg) => void): () => void;

  // RTT per peer (transport-layer performance.now()) for input-delay tuning + clock sync.
  rtt(p: PlayerId): number;
}

export type Topology = 'mesh' | 'relay';
export function makeInputBus(t: Topology, transport: Transport): InputBus;
```

- **`mesh`** (default, ~8 players, the typical case): every peer sends its input directly to every
  other peer in its AoI band. N² fanout, but N is small *and AoI bounds it further* (§6). This is the
  lowest-latency option and needs no infra.
- **`relay`** (scale toward ~20–30): peers send input to a relay node which fans out. Trades one extra
  hop of latency for O(N) per-peer egress + O(1) connections (see §10). The relay is **not** a
  simulation authority — it's a dumb input reflector + optional check-frame referee. The
  coordinator/anchor role (migrated Frequency host) is the natural relay host; if it drops, the
  generation-ladder migration re-elects one (we reuse `migration.ts`).

Both implementations sit on the **same `Transport`** from Frequency, so swapping topology is a config
flag, not a rewrite. AoI (§6) operates *above* the bus: the bus only ever carries input for peers in
your band; fogged peers' input is dropped (you interpolate their silhouette from coarse position
beacons on the reliable channel instead).

---

## 4. CLOCK / TICK SYNC

There is **no wall-clock in the sim**; but peers must agree on *which tick is "now"* so their input
streams line up. The shared tick counter is established at session start and maintained loosely.

- **Session epoch:** at game start the coordinator broadcasts `START { startTick: 0, ... }` on the
  reliable channel. Everyone's `tick 0` is the same logical frame; they don't need the same
  wall-clock instant.
- **Drift control via input-delay, not clock-stepping.** We never hard-reset a peer's tick. Instead,
  each peer measures how far ahead/behind its inputs are arriving relative to neighbors (the gap
  between `currentTick` and `lastVerifiedTick`) and **nudges its own local rate ±1 frame
  occasionally** (frame skip / frame stall, GGPO "time sync") to converge. Visual impact is a
  one-frame hitch at most, rare.
- **RTT measurement:** `ping/pong` (reused from Frequency's protocol kinds) timestamped with
  `performance.now()` *at the transport layer only*. Per-peer RTT feeds `inputDelay` (§2.4) and AoI
  hand-off hysteresis (§6).
- **Late joiner / migration tick alignment:** a joiner receives the current `tick`, the session
  `seed`, and a **fast-forward snapshot** of the *small* runtime state (§7) on the reliable channel,
  then begins predicting from there. Because geometry is seed-derived, no big world transfer is
  needed — another payoff of the §1.3 split.

---

## 5. WIRE FORMAT

Two channels per peer connection (both negotiated over the `Transport`/PeerJS DataConnection):
1. **`hot` — unreliable, unordered** (`{ ordered:false, maxRetransmits:0 }`): input frames only.
   Loss is fine; we send redundant history and predict gaps.
2. **`ctrl` — reliable, ordered** (default SCTP, Frequency's existing mode): control, check-frames,
   commit/reveal, sync, position beacons, lobby.

All packets carry the versioned envelope (reused discipline from `protocol.ts`): first byte = proto
version, second = kind. Kinds: `INPUT=1, CHECK=2, COMMIT=3, REVEAL=4, SYNC=5, HELLO=6, WELCOME=7,
PING=8, PONG=9, BEACON=10`.

### 5.1 Input packet byte layout (the hot path)

```
INPUT packet (sent every local sim tick on `hot`, ~60/s/peer):
  offset  size  field
  0       1     version
  1       1     kind = INPUT(1)
  2       1     playerId
  3       4     baseTick   (uint32 LE) = tick of the FIRST (newest) frame in this packet
  7       1     count      (1..REDUNDANCY)  -- number of frames included (newest first)
  8       n*4   frames[]   -- each frame packed into 4 bytes (see below), newest -> oldest

  Per-frame 4-byte pack:
    byte0: buttons   (8 bits -> 8 action bits; extend to 2 bytes if we exceed 8 verbs)
    byte1: moveX     (int8, quantized stick)
    byte2: moveY     (int8, quantized stick)
    byte3: aim       (uint8, 256-step angle)
```

- **Redundancy = last 10 frames** per packet (bible: "redundantly pack last ~10 frames per packet").
  `REDUNDANCY = 10` → a single received packet recovers up to 9 prior dropped frames. Packet size:
  `8 + 10*4 = 48 bytes` payload. At 60 Hz that's ~2.9 KB/s per stream before headers — trivial; the
  redundancy is the cheapest possible loss recovery and it's what lets us run on lossy
  unreliable/unordered channels.
- **Out-of-order safe:** `baseTick` is absolute; the receiver indexes each frame into its ring by
  absolute tick and ignores any frame it already has as REAL. A late or duplicate packet can only
  *improve* knowledge, never corrupt it.
- **Quantization** is part of the determinism contract: stick is `round(axis*127)` → int8; aim is
  `round(angle/(2π)*256) & 255`. **Both sender and sim use the dequantized value** (`x/127`,
  `a/256*2π`) so every peer feeds the *identical quantized number* into `step()`. Never quantize on
  the wire but use the raw analog value locally — that desyncs.

### 5.2 Other packets
- **CHECK** (`ctrl`): `{ kind, tick(uint32), hash(uint32) }` — periodic state-hash for desync/tamper
  detection (§9). Cheap; one per `CHECK_PERIOD` (e.g. every 30 verified ticks ≈ 2/s).
- **COMMIT / REVEAL** (`ctrl`): commit-reveal input scheme to defeat P2P lookahead cheating (§9.2).
- **BEACON** (`ctrl`, low rate ~4 Hz): coarse `{playerId, height, stratumIndex, x, hashOfPose}` for
  rendering *fogged* (out-of-AoI) rivals as silhouettes without carrying their full input stream.
- **SYNC / HELLO / WELCOME / PING / PONG**: session start, join handshake, RTT. HELLO/WELCOME/ping/pong
  reuse Frequency semantics.

---

## 6. AREA OF INTEREST — VERTICAL-PROXIMITY MODEL

**AoI = vertical stratum / fog-band proximity in the one shared shaft** (NOT a private crew instance —
v1's instance model is deleted). This is the load-bearing scalability mechanism.

### 6.1 Bands
For the local player at height `h` (or stratum index `s`):
- **TIGHT band** — players within `±TIGHT_STRATA` (≈ same + adjacent stratum, the rendered/reachable
  zone): full rollback participation, k≈5 rollback depth, full input streams on the `hot` channel,
  full collision/PvP interaction. This is your rollback set.
- **LOOSE band** — players separated by fog (beyond TIGHT, still visible as silhouettes per the art
  bible "rival crews as fogged silhouettes on lower strata"): **no rollback, no input streaming.**
  Rendered by interpolating their `BEACON` packets (~4 Hz). They cannot collide with or be shoved by
  you (different vertical zone), so they need no tight sync.
- **OUT** — far enough that they're not even silhouettes: nothing but standings (height number) on
  the reliable channel.

Hand-off uses **hysteresis** (enter TIGHT at ±N strata, leave at ±N+1) so a player bobbing at a band
edge doesn't thrash subscriptions. Transition is a view-layer fade (ties into coalescence reveal).

### 6.2 Why the race makes this work
The collapse-from-below + race naturally **spreads players across strata** (leaders high, stragglers
low). Tight-sync clusters stay small *by game design*. At the typical ~8-player count, the whole pack
is often within 1–2 strata and AoI is a near-no-op — that's fine, k≈5 over 8 peers in mesh is nothing.

### 6.3 The 30-player same-stratum pile-up (designed-for explicitly)
The central tension the bible calls out: many players on the *same* stratum = one large tight-sync
set (N² mesh input + deep rollback set). At 30 this is the worst case. Mitigations, layered:

1. **Multiple routes per stratum** (bible: "several stairs/ramps up") — horizontally partitions a
   crowded stratum. We make AoI **route-aware**: tight-sync is gated by *both* vertical proximity
   *and* "could-interact-soon" (same or adjacent route lane). Two crews taking different ramps up the
   same stratum are loose to each other even at equal height. This caps a realistic tight set to one
   crew + contesters (~5–8), not 30.
2. **Collapse pressure** keeps anyone from loitering on a stratum, so a 30-wide tie is transient.
3. **Soft same-stratum spreading**: a gentle anti-clump rubber-band — when a stratum's occupancy on a
   given route exceeds a threshold, the route-up reveal/throughput favors spreading (and the
   competitive rubber-banding in `04-competitive-structure.md` pushes laggards to *different* routes
   via boon offers). This is a *design* mitigation, not a netcode hack, but netcode depends on it.
4. **Hard fallback — topology switch**: if a tight set still exceeds `MESH_MAX` (we set 10), the
   InputBus flips that cluster to **relay** mode (§3) so per-peer egress/connections stay O(1)/O(N)
   instead of O(N²). The relay is the coordinator/anchor (migrated host).
5. **Rollback-set cap**: a peer never rolls back more than `maxRollbackFrames` (§2.4) and never over
   more than `ROLLBACK_PEER_CAP` peers; beyond that the furthest-behind peers are demoted to LOOSE
   (interpolated) for a beat. Visual cost (a silhouette where a body was) is acceptable in a 30-way
   scrum and bounds CPU to a constant.

**Stated guarantee:** tight-sync set size is bounded by *route lane occupancy*, not by stratum
occupancy, and hard-capped by topology switch + rollback-set cap. The 30 case degrades gracefully to
"the few people literally next to you are crisp; the rest are smooth silhouettes."

---

## 7. DROP-IN / DROP-OUT & MIGRATION (reuse Frequency, adapt to rollback)

- **Drop-out:** when a peer's input stops arriving (transport `onPeerLeave` or `confirmed[p]` stalls
  past a grace window), we **freeze-predict** them for a short grace (so a 1–2 s blip doesn't remove a
  racer), then convert their avatar to a falling/collapsing-out body (juice: the collapse literally
  takes them) and mark them OUT. Their `InputFrame` slot is then filled with neutral input so array
  shape/iteration order is preserved (§8.4). Per-lobby stakes (§ bible) decide if they can rejoin
  their slot.
- **Drop-in / rejoin:** reuse Frequency's reconnection tuning (recreate Peer on destroy/disconnect,
  fail dead generation instantly via `peer-unavailable`, ~5 s live window — *don't shorten*). On
  rejoin the peer gets `{seed, currentTick, runtimeSnapshot}` on `ctrl` and resumes predicting. No
  world transfer (geometry is seed-derived) — joins are near-instant ("NO loading screens ever").
- **Coordinator migration:** reuse `migration.ts` `nextHost` (senior `joinedAt`) + the generation
  ladder + **silent** behavior (no UI copy — Frequency's explicit rule). The migrated coordinator
  re-hosts relay mode and re-anchors signaling. Because *every peer already has full state* (symmetric
  sim), migration here is *cheaper* than Frequency's — there's no authoritative state to hand over,
  only the relay/signaling role.

---

## 8. DETERMINISM STRATEGY

Determinism is the contract that makes rollback possible. Violations = desyncs = the worst class of
bug. Policy, in priority order:

### 8.1 Physics engine — **Rapier (WASM), single-threaded, fixed-timestep, with guards** (chosen)
- **Decision:** use **Rapier compiled to WASM** for player/terrain collision and rigid bodies, run at
  the fixed 60 Hz step, **deterministic build, single thread, no SIMD-variability**. Rapier documents
  cross-platform determinism *when the same binary, same step, same input order* are used — which is
  exactly our setup (everyone ships the same `.wasm`).
- **Why not hand-rolled fixed-point:** a climber has rich contacts (ledges, slopes, crushers, moving
  platforms, destructibles). Writing a deterministic fixed-point solver for that is months we don't
  have and a bug farm. Rapier gives us the solver for free.
- **Tradeoff / risk:** WASM f32/f64 *can* be deterministic across browsers because wasm pins IEEE-754
  semantics (no x87 80-bit surprises, no fast-math), **but** we must (a) ship one pinned Rapier wasm
  build to all clients (version-lock in `ctrl` HELLO; refuse mismatched builds), (b) avoid any
  multi-threaded/SIMD Rapier feature whose scheduling is nondeterministic, (c) keep a strictly fixed
  body-insertion/iteration order (§8.4), and (d) gate it behind check-frames (§9) so a determinism
  regression is *detected immediately in test and in prod*, not discovered as a mystery desync. If
  Rapier ever proves non-bit-identical across a target browser, the fallback is a **fixed-point**
  custom solver for the *narrow* set of interactions we actually use — but we don't pay that cost
  until check-frames prove we must.
- **No-AI dividend:** because there are *no AI/behavior-tree agents* (bible ban), the only things in
  the physics world are players + scripted-deterministic hazards (whose motion is closed-form off the
  tick). That dramatically shrinks the determinism surface — far fewer interacting bodies, no
  perception/steering math, no nondeterministic agent ordering. This is the biggest reason rollback is
  tractable here.

### 8.2 Seeded PRNG (NEVER `Math.random`)
- Single algorithm, **`xoshiro256**` (or `pcg32`) seeded from the session `seed`**, state is part of
  `SimState` (serializable, snapshotted/restored with everything else). All randomness — floor-gen
  (cross-ref `09-level-generation.md`), pickup placement, boon draft offers, hazard jitter — pulls
  from this one cursor in a fixed order. `Math.random` is banned by lint rule + a runtime trap in dev.
- View-layer randomness (particles, screen shake) uses a *separate, non-sim* RNG and is **never** read
  back into the sim.

### 8.3 Trig / float hazards
- **Avoid runtime `Math.sin/cos/tan/atan2` in the sim where avoidable** — they're spec'd but not
  bit-identical across engines/CPUs in the last ULP, which rollback hashing will flag. Mitigations:
  (a) precompute a **fixed-resolution trig LUT** (e.g. 4096 entries) used by the sim for angles
  (aim/turret arcs) so every browser indexes the *same table*; (b) prefer vector math (normalized
  direction vectors, dot/cross) over angle math; (c) any unavoidable transcendental result is
  **quantized** before it influences state. Rapier's internal math is handled by the pinned wasm
  (§8.1), not JS `Math`.

### 8.4 Iteration order
- **Fixed entity iteration order = ascending `PlayerId`, then ascending stable entity id.** No
  `Map`/`Set` iteration of object refs in the sim (insertion-order-but-identity-keyed = footgun). Use
  dense typed arrays indexed by id. Body insertion order into Rapier is the same fixed order on every
  peer. This is mandatory and lint-guarded.

### 8.5 Self-checking
- `hash(state)` (§1.2) over the canonical byte layout, computed on verified ticks, exchanged as
  CHECK-frames (§9.1). A mismatch is a determinism bug; in dev we log the diverging field by hashing
  sub-sections. CI runs a **headless two-instance lockstep replay** of recorded inputs across (at
  minimum) Chromium + Firefox and asserts identical hash streams — determinism is a *tested* property,
  not a hope.

---

## 9. ANTI-CHEAT (light, honest, fits a terrain-first P2P game)

PvP is *spice* not *core* (bible), and there's no central server, so anti-cheat is **light by design**
— detection-and-eject, not prevention-by-authority. Three mechanisms, all cheap and determinism-aligned:

### 9.1 State-hash CHECK-frames (desync **and** tamper detection)
Already required for determinism (§8.5). Doubles as tamper detection: every peer periodically
broadcasts `CHECK { tick, hash }`. Peers compare; a peer whose hash diverges from the majority at a
verified tick is **desynced or cheating** — either way it's ejected (and may rejoin clean via §7).
Majority-vote among ≥3 peers; the relay (if present) can referee. This catches state edits *and*
real bugs, which is why it's worth the bytes.

### 9.2 Commit-reveal inputs (defeats the P2P lookahead cheat)
The classic P2P cheat: a modified client *waits* to see opponents' inputs for tick T before choosing
its own (lookahead/"see the future"). Defeat it with commit-reveal on a cadence:
- Phase A: each peer sends `COMMIT { tick, H(input || nonce) }` for an upcoming window.
- Phase B: after commits are in, each sends `REVEAL { input, nonce }`; peers verify `H` matches.
A peer that reveals an input not matching its commitment, or stalls reveal until others reveal, is
flagged. We run this on a **sampled cadence** (not every frame — that'd add latency), enough to make
sustained lookahead-cheating detectable. Honest framing: this raises the cost, it doesn't make
cheating impossible.

### 9.3 Input validation (clamp impossible inputs)
Every received `InputFrame` is clamped/validated *before* it enters the sim: stick within int8 range,
aim within byte range, button bitfield masked to defined verbs, and **rate/teleport sanity** (a
player position is derived by the sim from inputs, so you can't inject a position; but we still reject
inputs that imply impossible accel given role stats). Cheap, and it bounds the damage of a malformed
or malicious packet.

### 9.4 Honest limits (state them plainly)
- Mesh rollback **cannot prevent aim/wallhacks** — every client must know nearby players' positions to
  simulate them, so a modified client can always *render* what it legitimately *receives*. We get
  **detection** of state tampering (hashes) and **mitigation** of lookahead (commit-reveal) and
  malformed input (validation) — not prevention of read-only client mods.
- This is acceptable because **terrain-first lowers the stakes**: the dominant challenge is the tower,
  not out-aiming a human; PvP verbs are bounded (shove/steal/contest), so the payoff of cheating is
  low. We deliberately do **not** build heavyweight anti-cheat — it wouldn't fit a serverless P2P
  model and the game doesn't need it.

---

## 10. PER-PEER RESOURCE SCALING (precise framing)

Different resources scale differently; conflating them hides the real limits. Per peer, in a tight
cluster of size `K` (NOT total players `N` — AoI decouples them):

| Resource | Mesh cost | Relay cost | Bounded by |
|---|---|---|---|
| **Egress** (upstream B/s) | `O(K)` — send input to each of K peers (~48 B/frame × 60 × K) | `O(1)` — send once to relay | Relay fixes egress. ~K·2.9 KB/s in mesh; at K=8 ≈ 23 KB/s up (fine on broadband, tight on mobile up-link → relay). |
| **Ingress** (downstream) | `O(K)` — receive from each peer | `O(K)` from relay | **AoI fixes ingress** (K = tight band, not N). Loose peers cost only ~4 Hz beacons. |
| **Connections** (WebRTC peer conns) | `O(K)` open data channels | `O(1)` (just the relay) | Relay fixes connections. Browsers tolerate ~tens of peer connections; relay needed well before 30 mesh-connections. |
| **CPU** (sim + rollback re-sim) | `O(K · rollbackDepth)` re-sim cost | same | **AoI fixes CPU** (only tight-band entities in the rollback set) + `maxRollbackFrames`/`ROLLBACK_PEER_CAP` caps. |
| **Memory** | `O(K)` input rings + snapshot ring (snapshots small, §1.3) | same | Snapshot smallness (geometry not stored) keeps this trivial. |
| **Rollback depth** | driven by the **worst-peer extreme-order statistic** of input latency in the cluster | same | One bad-RTT peer sets the depth for everyone in the cluster → we demote that peer to LOOSE past `maxRollbackFrames` rather than let it deepen everyone's rollback. |

**Design conclusions:** *mesh for ~8* (no infra, lowest latency); *relay to extend toward ~20–30*
(fixes egress + connection count). *AoI fixes ingress + CPU* regardless of topology. *Rollback depth
is governed by the worst peer*, so the single most important resilience knob is the
demote-the-laggard rule (§2.4 / §6.3-5), not raw bandwidth. The `mesh|relay` seam (§3) means we ship
mesh first and turn on relay for big lobbies without touching the sim or rollback code.

---

## 11. MODULE / FILE LAYOUT

```
src/
  net/                         # REUSED-from-Frequency connection brain (adapted)
    transport.ts               # REUSE: Transport interface + PeerJS impl; add hot/ctrl channels
    roomCode.ts                # REUSE: deterministic ascv1-<CODE>-g<gen>
    migration.ts               # REUSE: senior-peer election + generation ladder
    protocol.ts                # REUSE discipline: versioned envelope; REPLACE kinds (§5)
    netController.ts           # REUSE shell of Frequency net.ts; drives session lifecycle + migration
    coordinator.ts             # the migrated "host" role: signaling pivot + relay anchor + referee
  bus/
    inputBus.ts                # InputBus interface (§3)
    meshBus.ts                 # mesh impl over Transport
    relayBus.ts                # relay impl over Transport (coordinator reflects)
    wire.ts                    # encode/decode INPUT/CHECK/COMMIT/REVEAL/BEACON (§5), quantization
  sim/
    core.ts                    # SimCore: init/step/save/restore/hash (§1)
    state.ts                   # SimState struct-of-arrays, snapshot ring (§1.3)
    physics.ts                 # Rapier-wasm wrapper, fixed body order, fixed step (§8.1)
    rng.ts                     # seeded xoshiro256** PRNG, serializable cursor (§8.2)
    trig.ts                    # deterministic trig LUT + vector helpers (§8.3)
    hazards.ts                 # scripted deterministic hazards (crushers/turrets/traps/collapse)
    players.ts                 # movement, jump/grab/catch, downed/revive, shove/contest verbs
    strata.ts                  # runtime deltas for strata (geometry comes from levelgen, §9 doc)
    hash.ts                    # canonical byte layout -> uint32 state hash
  rollback/
    manager.ts                 # RollbackManager: rings, predict, rollback+resim, input-delay dial (§2)
    clock.ts                   # shared-tick sync, RTT-driven nudge, epoch (§4)
  aoi/
    bands.ts                   # vertical-proximity + route-lane band computation + hysteresis (§6)
  anticheat/
    checkframe.ts              # hash exchange + majority vote (§9.1)
    commitReveal.ts            # commit-reveal scheduler (§9.2)
    validate.ts                # input clamping / sanity (§9.3)
  present/
    interpolate.ts             # render-time alpha interpolation of sim ticks
    beacons.ts                 # loose-band silhouette interpolation from BEACON packets
    projection.ts              # throttled sim->zustand projection for React chrome (NEVER per-frame DOM)
```

Hot-path rule (inherited from Frequency's "net code never touches the DOM"): **`sim/`, `rollback/`,
`bus/` never import React, the DOM, zustand, or `Math.random`.** Only `present/projection.ts` bridges
to the UI store, throttled.

---

## 12. KEY TYPESCRIPT INTERFACES (consolidated contract)

```ts
// ---- identity / time ----
type Tick = number;          // shared integer sim frame
type PlayerId = number;      // dense 0..N-1, stable for the session

// ---- input ----
interface InputFrame { buttons: number; moveX: number; moveY: number; aim: number; }
interface TickedInput { tick: Tick; frame: InputFrame; }

// ---- sim core (the determinism contract) ----
interface SimCore {
  init(cfg: SimConfig): SimState;
  step(s: SimState, inputs: ReadonlyArray<InputFrame>): SimState;   // pure, bit-identical
  save(s: SimState): SimSnapshot;
  restore(snap: SimSnapshot): SimState;
  hash(s: SimState): number;                                        // uint32 check value
}

// ---- transport seam (reused interface from Frequency) ----
interface Transport {
  readonly selfId: string;
  send(to: string, msg: Uint8Array, channel: 'hot' | 'ctrl'): void;
  broadcast(msg: Uint8Array, channel: 'hot' | 'ctrl'): void;
  onMessage(cb: (from: string, msg: Uint8Array, channel: 'hot'|'ctrl') => void): () => void;
  onPeerJoin(cb: (id: string) => void): () => void;
  onPeerLeave(cb: (id: string) => void): () => void;
  close(): void;
}

// ---- input bus (mesh|relay) ----
interface InputBus {
  readonly localPlayer: PlayerId;
  sendInput(tick: Tick, frame: InputFrame): void;
  onInputs(cb: (from: PlayerId, frames: TickedInput[]) => void): () => void;
  sendControl(to: PlayerId | 'all', msg: ControlMsg): void;
  onControl(cb: (from: PlayerId, msg: ControlMsg) => void): () => void;
  rtt(p: PlayerId): number;
}

// ---- rollback ----
interface RollbackManager {
  addLocalInput(frame: InputFrame): void;     // applied instantly
  onRemoteInputs(from: PlayerId, frames: TickedInput[]): void; // may trigger rollback
  advance(): void;                            // run one tick of the §2.3 loop
  readonly currentTick: Tick;
  readonly lastVerifiedTick: Tick;
  setInputDelay(frames: number): void;        // §2.4 dial
}

// ---- AoI ----
type Band = 'tight' | 'loose' | 'out';
interface AoI { bandOf(self: PlayerId, other: PlayerId, s: SimState): Band; tightSet(self: PlayerId, s: SimState): PlayerId[]; }

// ---- control messages (ctrl channel) ----
type ControlMsg =
  | { kind: 'check'; tick: Tick; hash: number }
  | { kind: 'commit'; tick: Tick; digest: Uint8Array }
  | { kind: 'reveal'; tick: Tick; frame: InputFrame; nonce: Uint8Array }
  | { kind: 'beacon'; player: PlayerId; height: number; stratum: number; x: number; pose: number }
  | { kind: 'sync'; tick: Tick; seed: string; runtimeSnapshot?: Uint8Array }
  | { kind: 'hello' } | { kind: 'welcome'; playerId: PlayerId; tick: Tick }
  | { kind: 'ping'; t: number } | { kind: 'pong'; t: number };
```

---

## 13. CROSS-CUTTING TENSIONS OTHER DOCS MUST RESPECT

- **Everything gameplay touches must be deterministic** (`02-roles-combat.md`,
  `09-level-generation.md`): no `Math.random`, no wall-clock, no per-frame floats from rendering. All
  randomness pulls the seeded sim PRNG in fixed order; all hazards are scripted closed-form off the
  tick. Boon effects, role stats, collapse pacing all live in the sim and must be value-deterministic.
- **Reveal/coalescence is view-layer only** (`06-art-direction-shaders.md`): the gorgeous
  dots→panels→lit-surface assembly is timed animation over the *already-decided* seeded floor-gen
  data; it must never feed back into the sim or it breaks rollback.
- **Rubber-banding lives in the sim, but its inputs must be deterministic** (`04-competitive-
  structure.md`): catch-up boons / comeback tools key off height standings derived in `step()`. The
  same-stratum soft-spreading the netcode relies on (§6.3) is partly *your* job — laggards should be
  nudged onto *different routes*, not piled on one.
- **Level gen owes a pure `(seed, stratumIndex) -> geometry` function** (`09-level-generation.md`):
  netcode's small-snapshot/no-world-transfer/instant-join design depends on geometry being
  regenerable, with only runtime deltas in `SimState`.
- **UX must read smooth despite rollback** (`07-ux-ui-gamefeel.md`): occasional 1-frame correction
  snaps and silhouette↔body transitions at band edges are expected; juice (hitstop/shake) hides them.
  Anything cosmetic (particles/shake) uses the non-sim RNG.
