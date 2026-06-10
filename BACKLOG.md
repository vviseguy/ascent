# ASCENT — Backlog

**How this works:** drop anything into **Inbox** (a one-line note is plenty — don't worry about
format). I triage Inbox into the priority sections, work top-down through **Now** → **Next**,
and move finished items to **Done** with the commit hash. Sources: your playtest notes,
`docs/GAPS.md` (the intent audit), `docs/PARKING-LOT.md`.

## Inbox (drop new ideas here)

_(empty — add lines below this header anytime)_

## Now (in progress)

- [ ] **Graphics quality pass (user request)** — stone/crack materials (procedural albedo+normal),
      3D plant decoration that *bends as players move through it* (GPU-instanced, vertex-shader
      reactive), better lighting. _Design loop running in the Asset Lab (4 designers + art
      director); integration into the game renderer follows their sign-off._
- [ ] **Much wider map (user request)** — bigger stratum footprint (gridSize/cell scale in
      buildTower) + camera dolly range to match. _(Unblocked now — climb-carve landed.)_

## Next (priority order)

- [ ] **Results screen + restart** — win/loss moment, R to restart with next seed; match-cap
      becomes a visible clock and a LOSS, not a silent auto-win. _(GAPS #4)_
- [ ] **Safe respawn** — clamp no-beacon respawn to the stratum entry (kills the off-edge
      infinite-death loop), auto-plant beacon at stratum crests, "respawning in N" HUD,
      gate dead-body input. _(GAPS #5)_
- [ ] **Real chasms + gate lips** — GAP edges become actual ≥2.5 u crossings so the Anchor's
      gap-lock exists and carry/throw/bridge become *required*; gates (BREAK/BUTTON/WEIGHT) get
      real semantics in the compiled terrain. _(GAPS #6)_
- [ ] **Full role cast + Tab body-swap** — all 5 roles + Anchor present and swappable in solo
      play; throwables + hazards placed in tower mode (with render path). _(GAPS #7)_
- [ ] **Draft choice UI + wired boon effects** — 3-card pick moment; 2-3 boons with real sim
      effects; ability cooldown ring, scout-mark + beacon visuals (stop the HUD lying). _(GAPS #8)_
- [ ] **Audio starter set** — AudioContext + ~10 synthesized one-shots driven off the existing
      render event detector (grab latch, throw, impact, jump, draft, win). _(GAPS #9)_
- [ ] **Pressure + the race** — decide ghost-crews vs networked-only rivals (DECISIONS-LOG entry),
      then close the netcode seam in order: slot→bodyId map → multi-crew buildTower → lobby →
      roster handshake → netcode loop → live 2-browser test + TURN. _(GAPS #10)_

## Later / Ideas

- [ ] Coalescence materialization shader (dots→lines→panels→lit, per docs/06) — replace opacity fades
- [ ] Post stack: bloom + color grade (06), GPU-instanced tower geometry if draw calls grow
- [ ] Contested/merge floors + flashpoint geometry once rivals exist (04)
- [ ] Boon pool buildout past the starter set (03 has ~24-28 designs)
- [ ] Anchor weight scaling with progress _(PARKING-LOT)_
- [ ] Bulwark strength → reduced carry penalty _(PARKING-LOT)_
- [ ] Spectate-after-wipe, standings sheet hold-key view (04/07)
- [ ] Mobile/touch controls pass (07 mentions pads)

## Done

- [x] **The tower is CLIMBABLE** — exit openings + Anchor-walkable switchback stairs (0.5u rises,
      guard rails, turn landings) + full-height perimeter wall rings. PROOF 7: route 0→top for
      25 seeds; PROOF 8: a real Anchor climbed 0→1 by stick+jump inputs alone (no teleport).
- [x] **Aim plane at the player's feet** (was 14m below the playfield) + throw-arc terminates at
      the local floor.
- [x] **Camera trued** — exact 55° pitch, 42%-up framing via setViewOffset, dt-exponential
      smoothing (refresh-rate independent).
- [x] **Camera controls** — wheel zoom (clamped 10–40), middle-drag "grab the world" pan,
      recenter-on-move with forward facing-lead (~1–2s drift back), all view-only.
- [x] **Asset Lab** — element contract + auto-discovered gallery page (`npm run lab`) + headless
      screenshot harness (`npm run lab:snap -- <element>`) proven end-to-end (agents see PNGs).
- [x] Determinism bedrock → fixed-point engine, floor gen+verifier, world/spatial/collide/verbs/
      hazards/sim/game/net — 11 standalone proofs, all green in CI
- [x] Tower wired into the game (floor→terrain compiler, 5 strata) + standing/score + win
      conditions + crew identity + recall beacon + death/bleed-out
- [x] Role abilities (Mender revive, Bulwark unhand, Engineer bridge; Breaker/Runner stubs) `92514aa..`
- [x] Verb-mechanic fixes (trains, friendly-carry, catch-latch, aim-spoil, chip, priorities)
- [x] THROW charge + JUMP + downed-beat + encumbered-rush fixes (audit v1 criticals) `92514aa`
- [x] Boon draft engine + Mario-Kart rubber-band math (auto-draft; choice UI still open)
- [x] Movement feel: target-velocity controller w/ auto-stop; mouse-first controls (L=grab/throw,
      R=dash/ability) `618e24f`
- [x] Coalescence v2: current floor solid, next floor translucent 2D plan, higher hidden `db06664`
- [x] HUD: anchor status, standings line, crew colors, onboarding basics `d096874`
