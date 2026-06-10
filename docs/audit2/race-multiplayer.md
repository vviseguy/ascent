# Audit v2 — THE RACE & MULTIPLAYER REACHABILITY

Dimension: docs 04 (competitive structure), 05 (netcode), 00 pillars 5/6/9/10.
All claims below verified against current source, June 2026. Stale-AUDIT.md claims re-checked.

---

### no-rival-crews-spawned — the playable build is a solo time-trial, not a race

- Severity: CRITICAL
- Intent: The pitch IS a multi-crew race. 00 pillar 5: "PURE RACE, NO CHASE … Pressure = rival
  Anchors climbing + sabotage + rubber-banding." Pillar 10: "All crews climb ONE physical shaft;
  they spread by altitude and collide at flashpoints." 04 §0: "There is exactly one physical
  shaft. Every crew climbs it."
- Reality: `main.ts:32` boots `buildTower({ crewSize: 3, numStrata: 5 })`. `buildTower`
  (src/game/scene.ts:129) does not even ACCEPT a crew-count option; it spawns exactly one crew
  (loop at scene.ts:149-162 spawns 3 players + 1 Anchor, all `crewId: 0`) and hardcodes
  `numCrews: 1` into the MatchConfig (scene.ts:170). The only multi-crew entry point,
  `buildSandbox({ numCrews })` (scene.ts:47, 56, 62), is dead code from the app's perspective —
  `main.ts:18` imports only `buildTower`, and no other caller passes `numCrews > 1` anywhere in
  src/ (grep: only scene.ts itself and match.ts's loop bound).
- Gap: With zero rival Anchors there is no pacing pressure, no one to out-climb, no flashpoints,
  no sabotage, no one on the standings rail, no reason the win banner says "YOUR CREW WINS"
  instead of "done." Every competitive system the spec calls the game's identity is untestable
  by playing. The build exercises the *escort*, never the *race*.
- Fix sketch: Add `numCrews` to `buildTower` (spawn each crew at its stratum-0 entry with an X
  offset, `crewId: c`, per-crew anchorIds; set `match.numCrews`). Even inert, a second crew makes
  the standings rail / win-check / draft-deficit code paths real; humans driving it is the next
  finding.

---

### netcode-proven-but-unwired — the only spec-legal road to a race stops one seam short of the app

- Severity: HIGH (it is the remediation path for the CRITICAL above)
- Intent: 05 §0-§5: peer-symmetric rollback over a WebRTC mesh; room-code lobby (04 §8.1:
  "Host creates a room → deterministic room-code → peerId … Friends join by code"); 00 pillar 12.
  ROADMAP P2's keystone milestone: "two players in two browsers co-op-carry and throw the Anchor
  across a gap with no perceptible desync."
- Reality — what EXISTS and is proven:
  - `RollbackManager` (src/net/rollback.ts:45) — full GGPO loop: canonicalize→broadcast w/
    redundancy, contradiction-triggered rollback, snapshot ring incl. match state, check-frames.
  - Proven headlessly over a lossy/jittery `LoopbackTransport` in src/net/prove.ts:128-153
    (3 peers, 900 ticks, delayed/dropped/duplicated delivery, hash-compared vs a no-network
    reference sim, net/prove.ts:161-173).
  - `PeerJsMeshTransport` (src/net/transport-peerjs.ts:56) implementing the proven `Transport`
    interface over two data channels (HOT unreliable / CTRL reliable, transport-peerjs.ts:85-98).
  - Deterministic room-code → peerId scheme + seed derivation (src/net/room-code.ts:33-39, 53).
- Reality — what is MISSING (the honest seam, item by item):
  1. **No lobby UI at all.** `index.html` is a bare `#app` div (index.html:13-15); `boot()`
     (main.ts:23-45) creates a canvas + legend and starts the local loop. `genRoomCode` /
     `roomFromUrl` / `shareLink` / `seedFromCode` are exported but called by NOTHING outside
     src/net (grep across src/).
  2. **No roster handshake.** `hostRoom`/`joinRoom` (transport-peerjs.ts:145-153) only open a
     PeerJS peer; the file itself says the lobby/roster handshake is "intentionally minimal"
     (transport-peerjs.ts:140-144). Needed: coordinator accepts joiners on CTRL, assigns dense
     slots 0..N-1, broadcasts roster + seed + start-tick, then everyone constructs
     `PeerJsMeshTransport(peer, selfId, code, gen, roster)`.
  3. **The render loop never touches the netcode.** `startLoop` (src/render/loop.ts:63-66)
     fills a local `frame[]` and calls `sim.advance(frame)` directly; its own header
     (loop.ts:18-21) says the networked path "lives in the netcode loop, not here" — and no such
     loop exists (src/net contains only input-bus, prove, rollback, room-code, transport-peerjs,
     transport, wire; 05 §11's planned `clock.ts` shared-tick sync is unbuilt). Needed: a loop
     variant that calls `rollback.tick(localInput)` per due tick plus GGPO-style time-sync
     (stall the rich peer / let the poor peer catch up — 05 §4).
  4. **playerId ↔ bodyId mapping does not exist for the tower scene.** `InputBus.inputsForTick`
     returns an array indexed by playerId 0..playerCount-1 (src/net/input-bus.ts:105-119) and
     `Sim.advance` consumes it indexed by BODY id (src/sim/sim.ts:114). The net proof gets away
     with identity mapping only because it spawns the player bodies FIRST, ids 0..N-1
     (net/prove.ts:55-63). `buildTower` spawns crew bodies then the Anchor (ids 0-2, Anchor 3;
     scene.ts:149-162); a 2-crew tower gives human-driven bodies non-contiguous ids — so either
     a slot→bodyId remap layer in the rollback path or a "spawn all human bodies first"
     convention in `buildTower` is required.
  5. **The real-network adapter is untested live.** transport-peerjs.ts:20-25 states plainly:
     "has NOT yet been live-tested … Treat as integration-pending until browser-tested." ICE
     config is two STUN servers, no TURN (transport-peerjs.ts:32-37) — Frequency shipped with
     STUN+TURN (CLAUDE.md "Reuse from Frequency"); symmetric-NAT pairs will fail to connect.
  6. **Multi-crew scene + per-slot spawn** (the CRITICAL above) so each remote slot drives a
     body in its own crew.
- Gap: Two browsers cannot play together today, full stop — yet every hard part (deterministic
  sim, rollback core, wire format, transport adapter, room-code scheme) already exists and is
  proven. The remaining work is bounded integration (a lobby screen, a handshake, a netcode-aware
  loop, an id map, a live test), not invention. Calling the netcode "done" or "not started" would
  both be wrong; it is *one wiring seam from real*.
- Fix sketch: Build in this order: (a) slot→bodyId map + multi-crew `buildTower`; (b) minimal
  lobby (URL `?room=` join via `roomFromUrl`, host shows `genRoomCode()`, fixed 2-player roster
  to start); (c) roster handshake on CTRL; (d) `startNetLoop` that drives `RollbackManager.tick`;
  (e) two-browser live test on localhost broker, then PeerJS cloud. ROADMAP P2's milestone is
  the acceptance test.

---

### pvp-verbs-implemented-but-never-experienced — the sim already knows what a rival is; the game never shows it one

- Severity: HIGH
- Intent: 00 pillar 9 / 04 §2: "There is no rival-specific verb … the rival Anchor is the prize";
  grab priority, regrab immunity (04 §3.4), struggle asymmetry — the whole non-degeneracy design.
- Reality: The crew-aware PvP machinery is genuinely implemented in the deterministic sim:
  - Grab priority tiers with "enemy Anchor (a DIFFERENT crew's Anchor — the prize)" as tier 0
    (src/sim/verbs/verbs.ts:519-535).
  - `REGRAB_IMMUNITY` enforced in `isGrabbable` (verbs.ts:542).
  - Friendly vs hostile struggle break times (`STRUGGLE_BREAK_FRIENDLY` vs `STRUGGLE_BREAK`,
    verbs.ts:757) keyed on `isSameCrew` (verbs.ts:562-566).
  But since no body with `crewId !== 0` ever exists in the playable build (finding 1), every one
  of these branches is dead at runtime: tier 0 is unreachable, hostile struggle is unreachable,
  "drag the rival Anchor" has never happened.
- Gap: The game's most design-critical risk — "does grab degenerate into a lock under real PvP?"
  (ROADMAP P4's named risk) — cannot even begin to be observed. The five grab-pressures have
  never been felt against an opponent.
- Fix sketch: No sim work needed. Reachability is gated entirely on findings 1 + 2 (a second
  crew with at least one human in it).

---

### rubber-banding-mathematically-dead — catch-up code exists but cannot fire with one crew

- Severity: HIGH
- Intent: 00 pillar 6: "MARIO-KART RUBBER-BANDING. Trailing crews draw better boons"; 03 §4 via
  the deficit input; 04 §5.2: rubber-banding is what "guarantees flashpoints keep happening."
- Reality: `runDrafts` (src/game/match.ts:184-215) computes `leaderFloors` as the max over all
  crews (match.ts:190) and `deficit = leaderFloors - floor` (match.ts:197). With `numCrews: 1`
  (scene.ts:170) the leader IS the only crew, so deficit ≡ 0, and `catchupFactor` returns 0 for
  any deficit ≤ `LEAD_DEADZONE_FLOORS = 2` (src/game/boons.ts:65, 75-77). Every draft therefore
  draws at base tier weights (boons.ts:27); the uplift path (boons.ts:82+) has never executed in
  the playable game. (The code itself is correct and unit-proven — this is a reachability gap,
  not a bug.)
- Gap: The comeback engine — the system the spec leans on to keep the pack bunched and the match
  dramatic — is inert. Tuning it (ROADMAP P5's named risk: "the most playtest-sensitive balance
  surface") cannot start.
- Fix sketch: Same gate as above: a second crew whose Anchor actually climbs. A deterministic
  ghost crew (below) is sufficient to exercise the deficit math end-to-end before live PvP.

---

### standings-rail-races-nobody — HUD answers "am I winning?" with "you are the only entrant"

- Severity: MEDIUM
- Intent: 04 §1.4: the altitude ribbon shows YOUR Anchor "plus small rival pips at each rival
  Anchor's committed altitude … a glance answers *am I winning?* and *who is close enough to
  fight?*" Crew banner shows deltas to the crews directly above/below.
- Reality: The rail itself is built and crew-generic — one bead per crew, crew-colored, YOU
  highlighted (src/render/renderer.ts:861-885), fed from `sim.match.crews.map(...)`
  (src/render/loop.ts:81). But with one crew the array has one element: a single YOU bead on an
  empty track. The rival-win branch of the banner — `` `CREW ${winner+1} WINS` ``
  (renderer.ts:845) — is unreachable. No delta-to-adjacent-crew banner exists at all (no such
  element in `attachHud`, renderer.ts:~890-931).
- Gap: The HUD's core competitive question has no answer to give. Harmless today, but it means
  the rail's multi-crew behavior (bead overlap, target scaling at renderer.ts:866) is unexercised.
- Fix sketch: Lands free with finding 1 (the rail already loops over crews). Add the
  above/below-delta line when ≥2 crews exist.

---

### no-fog-band-rival-visibility — the info economy (silhouettes/pips by altitude band) is unbuilt

- Severity: MEDIUM (correctly sequenced after rivals exist — flagged so it isn't forgotten)
- Intent: 04 §5.4: rival fidelity degrades in three bands — NEAR full fidelity, MID fog
  silhouettes ("crew color, rough position … 'carrying enemy Anchor' banner"), FAR pips only —
  and the render boundaries MUST equal the netcode AoI bands ("the coupling is non-negotiable").
- Reality: The renderer draws every body at full fidelity regardless of crew or altitude
  distance; the only fog is scene-distance fog on terrain (renderer.ts:185) and the
  floors-below desaturation band (renderer.ts:35-38 header). Grep for "silhouette" in src/
  hits only character-shape comments (renderer.ts:332, character.ts:68) — no rival fog-band
  rendering, no `SilhouettePose`, no AoI band logic anywhere in src/.
- Gap: When rivals do land, they will be fully visible at any distance — leaking exactly the
  information 04 §5.4 prices, and decoupled from the (also unbuilt) AoI send-rate bands.
- Fix sketch: When rivals exist: derive band from |rivalAnchorY − myAnchorY| in floors (NEAR≤6,
  MID≤14), render MID crews as flat crew-color silhouettes, FAR as rail pips only. Keep the
  thresholds in one shared constant module so render and future AoI cannot drift apart.

---

### no-honest-path-to-a-local-race — crewmates are inert; the spec's no-AI rule means a second crew needs humans (or ghosts)

- Severity: MEDIUM (a strategic gap, not a code bug)
- Intent: 00 pillar 3: "TERRAIN-FIRST, NO AI. Antagonists are gravity, hazards, and other
  players. No NPCs, no behavior trees." So a rival crew can only be humans — the race
  cannot be faked with bots without violating a locked pillar.
- Reality: Even inside the one crew, only `frame[localPlayerId]` is ever driven
  (src/render/loop.ts:64-65); the other two role bodies and the Anchor receive no input and
  stand inert for the whole match (the Anchor moves only when carried/thrown). Spawning a second
  crew today would produce four statues at the spawn: standings bead frozen at 0, deficit grows
  but THEY never draft past floor 0, no flashpoints. That is not a race and would test nothing.
- Gap: There is no intermediate between "solo sandbox" and "full networked lobby," so every
  race-dependent system (rubber-banding, standings drama, flashpoint geometry, PvP pressure)
  stays untested until the entire netcode seam (finding 2) closes.
- Fix sketch — three honest intermediates, cheapest first:
  1. **Ghost crew (recommended).** Record the local player's canonicalized input stream
     (loop.ts already canonicalizes via `canonicalizeInput`, loop.ts:60) for a seed; replay it
     next run as crew 1's inputs against the same seed. Deterministic, sim-legal, and NOT AI —
     it is a human, time-shifted (a time-trial ghost). Gives a real climbing rival Anchor:
     standings rail, deficit math, win race, and flashpoint *geometry* all go live. Honest
     limitation to document: a ghost cannot react, so PvP verbs remain untested. Note the spec
     tension explicitly: pillar 3 bans AI; a replayed human run is not a behavior tree, but it
     is also not in the spec — needs a LEAD DESIGNER sign-off line in DECISIONS-LOG.
  2. **Local hotseat 2P.** The sim trivially supports it — `loop.ts` can set `frame[idA]` and
     `frame[idB]` from two key clusters. Zero netcode. But the mouse-first control scheme
     (aim/grab/throw on mouse, main.ts:57-59) means player 2 gets a crippled keyboard-only
     scheme; acceptable only as a debug rig, not a demo.
  3. **Networked 2P** (the real answer): finding 2's checklist. One human per crew (crewSize 1
     + Anchor) is the minimal real race and matches ROADMAP P2's keystone milestone shape.

---

## Dimension verdict

The race — the genre claim in the first line of every design doc — does not exist in any form in
the playable build: one hardcoded crew (scene.ts:170), dead rubber-banding, dead PvP tiers, a
standings rail with one bead. Yet ~90% of the hard work is done and proven (deterministic sim,
crew-aware verbs, rollback core, transport adapter); what's missing is one integration seam
(lobby → roster → netcode loop → id map → live test) plus a designer call on ghost crews as the
single-machine bridge. This dimension is a wiring deficit, not a design or engine deficit.
