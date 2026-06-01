# ASCENT — UX, UI, Accessibility & Game Feel (v3)

> Vision bible **v3** compliant. This doc owns the **player-facing layer**: camera, HUD, readability
> of the physical game, the juice/game-feel spec, onboarding, accessibility, drop-in/out + reconnect
> UX, and the first-60-seconds beat.
>
> Cross-references (siblings, some still in draft):
> - `01-game-design.md` — pillars, win conditions, tuning knobs.
> - `02-roles-anchor-verbs.md` / `02-roles-traversal-combat.md` — verb mechanics, grab pressures, encumbrance, role kits.
> - `03-progression-economy.md` — boons/draws (rubber-band), unlocks.
> - `04-competitive-structure.md` — standings, rounds, lobby settings.
> - `05-netcode-architecture.md` — determinism boundary, rollback, silent migration, reconnect, the
>   input-frame/sim-`step()` contract (peer-symmetric, NOT a host reducer).
> - `06-art-direction-shaders.md` — palette, identity colors, Coalescence shader, VFX budget.
> - `08-audio.md` — audio cues paired with every feel beat below (UX and audio share a cue table).
>
> **Determinism rule (non-negotiable, from pillar 7 + `05`):** *everything in this document is
> view-layer.* Nothing here reads from `performance.now()` into the sim, nothing here mutates sim
> state, nothing here feeds back into the sim `step()`. Camera, HUD, juice, screenshake, and animation
> all consume a **read-only interpolated snapshot** of the deterministic tick state (two snapshots +
> render-α, per `05`). The only thing that crosses back into the sim is the local player's
> **`InputFrame`** (see `05`), produced by the input layer, never by UI animation. When in doubt: if a
> thing can differ between two clients and it touches gameplay, it is a bug. If it can differ and it is purely cosmetic (screenshake seed, particle jitter), it is fine
> and **must** use the cosmetic PRNG stream, never the sim PRNG.

---

## 0. Design north star for the player-facing layer

ASCENT is a **vertical escort brawl-race** (bible pitch). The UX job is to make a chaotic,
physical, multi-crew, multi-altitude scrum **instantly legible** while preserving the comedy and
drama of Gang-Beasts physicality. Three commitments drive every decision below:

1. **The Anchor is the camera, the HUD, and the story.** A crew's entire standing is their Anchor's
   height (pillar 1). So the Anchor is the primary subject of the camera, the most prominent HUD
   element, and the focus of every readability and juice affordance. If a player can only track one
   thing on screen, it must be **their Anchor's altitude and safety**.

2. **Diegetic-first, HUD-second.** Because this is a physical game with a beautiful Coalescence world
   (`06`), we push status onto the **characters and the world** (auras, leashes, glows, posture)
   before we resort to screen-space chrome. Screen-space HUD carries only what cannot be reliably
   read off the 3D scene at a slight-tilt top-down distance: numeric standings, your Anchor's
   off-screen position, cooldowns, and recall state.

3. **Readability beats spectacle, but we get both.** Maximal spectacle is a pillar (7), but a
   throw you can't read is a feel failure. The juice spec below is built around a strict **hierarchy
   of legibility**: silhouette > color identity > state aura > motion > particles > screenshake.
   Particles and shake are the *last* layer and have a hard budget so they never bury the read.

---

## 1. Camera

The camera is the single most important readability tool. It must follow a **vertical climb**, keep
a crew together, frame **flashpoints** (brawls), and never disorient.

### 1.1 Rig & projection

- **Projection:** perspective, **not** orthographic. FOV ~38–42° (longish lens) to keep the
  three-quarter Hades look without strong parallax distortion at the edges. Ortho was rejected: it
  flattens the vertical depth that sells "how far is the fall," which is the core stakes read.
- **Tilt:** "slight-tilt top-down" = camera pitched **~55° down from horizontal** (35° above the
  floor plane). This is the Hades three-quarter compromise: you see floor tops (for traversal/route
  reading) **and** the vertical faces of the shaft and the gap depth below (for fall stakes).
- **Yaw:** fixed. The tower has a canonical "front." We do **not** allow free camera rotation —
  rotation destroys the muscle-memory mapping of "throw stick = world direction" and is a comedy/
  readability disaster in a grab-throw game. Up is always up.
- **Roll:** locked at 0 except for **bounded cosmetic roll** during big impacts (see screenshake).

### 1.2 Target: crew/Anchor centroid, Anchor-weighted

The camera follows a **weighted centroid** of the local crew, computed from the interpolated
snapshot each render frame (view-layer only):

```
target = Σ(w_i · pos_i) / Σ(w_i)
  w_anchor      = 3.0     // your Anchor dominates framing
  w_localPlayer = 1.5     // you matter more than teammates
  w_teammate    = 1.0
  w_rival       = 0.0     // rivals never pull your camera (but see flashpoint, 1.5)
```

Vertical (altitude) tracking is **biased toward the Anchor**: even if you scout far above with a
Runner, the camera anchors its vertical center on a point **2/3 between the Anchor and the local
player**, so you never lose your Anchor off the bottom of the screen. If the local player climbs
beyond a scout-leash distance, we switch to **split affordance** (1.6) rather than zooming out
infinitely.

### 1.3 Vertical lead & climb feel

The climb is the game's verb. The camera **leads upward**:

- Vertical framing places the weighted target at **42% from the bottom** of the safe frame (not
  centered) so there is more sky than floor — you see the **potential wireframe floors above**
  (`06` Coalescence) you are climbing toward. This makes "up is good, up is the goal" a constant
  spatial truth.
- **Asymmetric vertical smoothing:** moving up, the camera is **snappy** (smoothing time ~120 ms) so
  ascent feels responsive and earned. Moving down (falls), the camera is **looser** (~260 ms) and
  briefly **rubber-bands behind** the faller, which makes falls feel fast and dangerous (the world
  rushes up past you) without losing the faller off-screen.
- **Fall-follow clamp:** during a tracked fall (your Anchor or you), the camera will exceed normal
  zoom-out limits to keep the impact point and the faller both framed — the player must always see
  where they land and whether a teammate can catch them.

### 1.4 Spread / cluster zoom (the breathing dolly)

Zoom is driven by the **bounding extent of the weighted targets**, mapped to a dolly distance with
hysteresis so it doesn't pump:

```
extent      = max(verticalSpread, horizontalSpread · aspectComp)
distance    = clamp(lerp(D_close, D_far, smoothstep(E_min, E_max, extent)), D_close, D_far)
D_close ≈ 14u  (tight cluster: calm coordination / single climber)
D_far   ≈ 30u  (spread crew: scouting, multi-route, chaos)
hysteresis: zoom-out responds in ~180 ms; zoom-in lags ~500 ms (never snap-in on someone)
```

Rationale matches the Overcooked pacing pillar (5): **calm-coordination = tight & intimate**,
**panic-burst = pulled-back & legible**. The camera literally inhales during flashpoints so you can
read the whole scrum, then settles in close as the crew re-clusters for traversal.

### 1.5 Flashpoint framing (rival collisions)

A **flashpoint** = a tick-detected condition (computed in sim, surfaced as a snapshot flag — see
`04`/`05`) where your crew and a rival crew are within brawl range **and** a grab/throw/RUSH is in
flight near your Anchor. On a flashpoint:

- Rivals temporarily gain `w_rival = 0.8` in the centroid **only for rivals inside the flashpoint
  radius**, pulling the brawl into frame.
- Zoom-out hysteresis is **bypassed** (instant pull-back, capped at D_far + 6u) — chaos must never be
  off-screen.
- A subtle **edge-vignette pulse** and a **time-feel dip** (see hitstop, 4.4) sell the stakes.
- When the flashpoint resolves (separation or a resolved ring-out), rival weight decays over 700 ms
  back to 0 and the camera re-clusters.

This is the only time rivals influence your camera. It keeps "frequent but not constant" rival
interaction (pillar 10) feeling like **discrete dramatic beats** rather than a constantly noisy frame.

### 1.6 Off-screen & split affordances (no second camera)

We never spawn a second camera (cost + determinism-irrelevant complexity + disorientation). Instead:

- **Anchor altitude pip:** if your Anchor is off the top or bottom of the frame (e.g. you scouted
  far ahead), a **persistent edge chevron** on the vertical HUD rail (see 2.3) shows the Anchor's
  relative altitude and a distance readout. The chevron pulses if the Anchor is in danger.
- **Scout leash:** when the local player exceeds the scout-leash distance from the Anchor, a faint
  **dotted leash line** is drawn from screen edge toward the Anchor, and the camera holds at the leash
  boundary rather than tearing the crew apart. Pushing further triggers a gentle "rubber-band"
  resistance read (visual only — does **not** restrict movement; this is escort, not a tether).
- **Teammate edge markers:** off-screen teammates get small role-colored arrows at the frame edge.

### 1.7 Screenshake budget (hard-capped, accessibility-gated)

Screenshake is **cosmetic-PRNG seeded** (never sim PRNG) and lives under a strict budget so it never
compounds into nausea or illegibility:

```
shakeBudget per frame: trauma ∈ [0,1], decays linearly at 1.6/s
offset    = trauma² · maxOffset · noise(cosmeticSeed, t)   // squared = gentle low end
maxOffset = 0.9u translational, 1.2° rotational (roll), 0 yaw/pitch
trauma sources (additive, then clamped to 1):
  light impact / latch        +0.12
  heavy object impact         +0.30
  throw release (big mass)    +0.22
  Anchor hard landing         +0.45
  ring-out (any Anchor)       +0.60  (your Anchor: +0.75)
hard cap: no single frame exceeds maxOffset; sustained chaos is RMS-limited
  so 5 simultaneous impacts ≠ 5× shake.
```

**Accessibility:** a global **Screen Shake** slider (0–100%, default 60%) scales `maxOffset`; at 0%
shake is replaced by an **equivalent non-motion juice** (a brief edge-flash + zoom-punch of bounded
magnitude) so reduced-motion players still get the impact *read* without the motion (see §6). The
zoom-punch itself is also reduced-motion-gated.

---

## 2. HUD

HUD philosophy: **minimal screen-space chrome, maximal diegetic state.** Every element earns its
pixels by carrying information the 3D scene cannot. Layout is corner-anchored and **fully scalable**
(§6). All HUD reads from the interpolated snapshot; numeric values are quantized to the tick they
came from (no wall-clock interpolation of authoritative numbers like height).

### 2.1 The Standings Rail (top-left) — live race by Anchor height

The single most important HUD element after your own Anchor. It is a **vertical mini-tower**: a
compact glyph rail showing **every crew's Anchor as a colored bead at its relative altitude**.

```
┌─ STANDINGS ──┐
│  ▲ +18m  ◆R  │   <- leader (rival "Rust" crew), arrow = climbing
│      ◇G      │   <- gap shows real altitude spacing (compressed log scale far away)
│   ►YOU ◆ 0m  │   <- your crew, highlighted, always labeled "YOU", center-locked
│      ◆B  ▼   │   <- rival below, ▼ = falling right now
│  ▽ -22m  ◆P  │
└──────────────┘
```

- **Scale:** linear within ±1 stratum of your Anchor, **log-compressed** beyond, so nearby rivals
  (the ones you can actually interact with) get the most resolution. Endless tower = unbounded
  height, so absolute numbers near your Anchor read in meters; distant crews read as "+3 floors."
- **Your crew is altitude-locked to the rail center** and always labeled. Rivals move relative to you
  — this makes "am I winning?" a one-glance read: rivals above the center line = ahead of you.
- **Motion glyphs:** ▲ climbing, ▬ holding, ▼ falling, ✕ Anchor downed (vulnerable beat, pillar 4),
  ☠ true death (kill-plane). A **falling rival bead leaves a brief streak** — schadenfreude is a
  feature.
- **Identity:** crew color + a **second redundant channel** (shape/letter) for colorblind safety
  (§6). Never color-only.
- **Win-condition aware (pillar 11 / `04`):** in race-to-height mode a **summit line** is drawn at
  the top of the rail with a target readout; in endless mode the rail shows a rolling "highest ever"
  ghost tick per crew; in rounds mode a small round pip cluster sits under the rail.

### 2.2 Your Anchor Status (top-center, prominent) — the heartbeat

This is the **emotional core** of the HUD and the only element allowed to grow/pulse/flash
aggressively. It is **center-top** (where eyes rest) and larger than everything else.

Contents:
- **Anchor portrait/silhouette** in crew color, posture-reactive (stands tall when safe, hunched/
  flailing when grabbed, sprawled when downed).
- **State word + ring:** `SECURE` (calm), `EXPOSED` (no ally within guard range), `GRABBED` (a rival
  has latched — flashes red, shows a **struggle meter** mirroring the Anchor's own struggle mash),
  `CARRIED` (by ally = green / by rival = red), `AIRBORNE` (thrown — shows predicted landing safety),
  `DOWNED` (vulnerable beat, countdown to recover), `DEATH` (kill-plane proximity warning).
- **Altitude readout** (the score) — large, with a **delta ticker** (+/- meters since last beat) and
  a tiny **personal-best ghost**.
- **Recall Beacon status** (see 2.5) integrated as a sub-element.
- **Health/durability:** the Anchor is fall-durable, not invincible (pillar 4). A **chunky durability
  arc** around the portrait depletes on hazard hits, refills slowly. This is *durability*, not the
  Smash-style damage% (we kill with position, not damage — pillar 4) — so it's framed as a shield/
  resilience read, with a clear **"low durability = next hazard could be lethal"** flash, not a
  knockback-scaling number.

When your Anchor is grabbed by a rival, this whole element **escalates**: red pulse, audio sting
(see `08`), a directional arrow to the Anchor if off-screen, and a **call-to-action prompt** ("RESCUE
↑ 12m") that the Bulwark/Mender are trained (onboarding §5) to answer.

### 2.3 Vertical altitude rail (right edge)

A thin **right-edge ruler** showing altitude with floor-tick marks, your Anchor's bead, the
**recall-beacon marker** (2.5), the **next coalescing floor** above (a wireframe-styled tick that
solidifies as you near it — ties HUD to the Coalescence reveal, §7), and edge chevrons for
off-screen crew members (1.6). Doubles as the "where's my Anchor vertically" answer.

### 2.4 Abilities & boons — **diegetic-first** (on-character)

Per pillar 7 and the diegetic-first principle, ability state lives **on the character** wherever
possible, with a **thin radial cooldown ring at the character's feet** rather than a screen-corner
ability bar:

- **Foot-ring cooldowns:** each role's primary verbs (RUSH, role ability) render as **arc segments in
  a ground ring** under your character — full = ready, sweeping = on cooldown. Readable by you *and*
  by teammates (a Mender can see your shield is up; a Bulwark can see your RUSH is ready) and even by
  rivals (information parity, intentional — this is a brawl, telegraphs are fair).
- **On-character ability tells:** Engineer's build charge glows in their hands; Mender's heal charge
  pulses on their tool; Breaker's break-charge sparks on their gauntlet; Bulwark's guard stance shows
  a body-block aura. These double as **what-are-they-about-to-do telegraphs** for everyone.
- **Boons (rubber-band, `03`):** drawn boons appear as **a held/equipped diegetic object or aura**
  (a glowing chevron-mote orbiting a trailing player), with a **single screen-corner boon chip**
  (bottom-right) for the *currently armed* boon: icon + one-line + the input to use it. Boons are
  catch-up tools (pillar 6), so the chip uses a distinct **"comeback" warm color** and a gentle
  inward pulse to read as "a gift," never as clutter. The chip explicitly states *why* you have it
  ("Trailing boon") so the leader and trailer both understand the rubber-band is **diegetic and fair**
  (pillar 6 guardrail).
- **Hands-full state (critical readability, pillar 2a):** when you're carrying anything, your foot-ring
  **greys out the climb/build/break/ability segments** and shows an **encumbrance weight glyph** — an
  unmissable read that "your hands are full, you can't do your job." This is the primary teaching tool
  for the grab-is-a-tempo-tool rule.

### 2.5 The Recall Beacon UI

The Recall Beacon is the crew's rally point planted by the Anchor (pillar 1). Recall is **to the
Anchor's height, never ahead**, cooldown-gated. UX:

- **Planting (Anchor only):** the Anchor has a clear **"PLANT BEACON"** prompt; on plant, a tall
  **light-pillar VFX** (diegetic) rises at the spot, visible across the shaft, crew-colored. A short
  cast tells rivals "they're committing to a rally here."
- **Beacon marker:** appears on the vertical altitude rail (2.3) and as a **world-space beam** so the
  crew can find it spatially without HUD-staring.
- **Recall (crew members):** a **hold-to-recall radial** (hold ~0.8 s, can be interrupted by damage/
  grab) so it's a commitment, not a panic-teleport. The radial shows the **destination altitude**
  ("RECALL ↓ to Anchor, -14m") so it's explicit that recall **never advances you** (pillar 1).
- **Cooldown:** a shared **crew cooldown clock** on the beacon chip (bottom-left, near standings).
  Clearly shows when the next recall is available so the crew can plan flashpoints around it.
- **Diegetic recall effect:** recalling players **coalesce in** at the beacon (re-using the
  Coalescence shader, `06`) rather than hard-popping — keeps the world's visual grammar consistent.

### 2.6 Lobby UI (pre-match)

- **Crew assembly:** room-code join (deterministic room-code → peerId, reused from frequency `net/
  roomCode.ts`; see `05`). Big shareable code, one-click copy, "drop-in any time" messaging.
- **Crew board:** each crew shown as a column of role slots (3–5, flex per pillar 11). Players pick a
  **role identity** (six identities, pillar 8) with a live preview of that role's silhouette + verb
  kit + a one-line "your job for the Anchor." Exactly one **Anchor** slot per crew, visually special
  and clearly the most important pick ("This is your VIP. Everything protects them.").
- **Host settings panel (pillar 11):** win condition, lethality, Anchor-death behavior, PvP-spice,
  collapse/pressure knobs, crew size. Each setting has a **plain-language one-liner** and a
  **preset row** (Casual / Standard / Cutthroat) so hosts aren't forced to understand every knob.
- **Readiness + drop-in note:** clear "you can join/leave mid-match, your crew keeps your slot warm"
  text to set expectations for the migration/reconnect UX (§8).
- **Accessibility surfaced early:** colorblind mode, UI scale, motion, and input remap are reachable
  **from the lobby and mid-match pause**, not buried (§6).

---

## 3. Readability language for the PHYSICAL game

This is the heart of the UX problem: a Gang-Beasts-physical, multi-body grab/carry/throw scrum must
be **instantly parseable** at a top-down distance with up to ~5 crews. We solve it with a strict
**legibility hierarchy** (silhouette > identity color > state aura > motion > particles > shake) and
a small set of **consistent visual verbs**.

### 3.1 Identity reads (who is this?)

- **Silhouette per role (pillar 8):** the six identities have **distinct, exaggerated chunky
  silhouettes** readable at top-down distance: Runner = small/lean/forward-leaning; Bulwark =
  wide/heavy/blocky; Mender = mid with a visible tool/halo; Engineer = mid with a tool-pack;
  Breaker = mid with oversized gauntlets; **Anchor = unmistakably the biggest, heaviest, with a
  permanent crew-colored "VIP" light-crown** so it is *never* confused for anyone else, friend or
  foe. (Silhouette spec owned by `06`; UX requires the distinctness.)
- **Crew color = team; role glyph = job.** Two orthogonal channels. Crew color tints a consistent
  body region (e.g. the "shell"/trim) + the ground ring; the role is read off silhouette + a small
  **role glyph** on the ground ring. Both channels are colorblind-redundant (§6).
- **Rival silhouettes:** rivals use the **same silhouette grammar** (a rival Bulwark looks like a
  Bulwark) — readability parity. Rival distinctness comes from **crew color + a subtle "not-yours"
  desaturation/outline treatment** so at a glance you separate "my crew" (full saturation, soft
  rim-light) from "everyone else" (cooler outline). Your **own Anchor** additionally gets a constant
  gentle **guidance glow** so you can always pick it out of a 20-body pile.

### 3.2 Grab / carry / throw state reads (who's holding whom?)

The hardest read in the game. Solution: a **grab-leash visual grammar**, consistent for every mass
tier (objects, teammates, Anchor):

- **GRAB latch:** at the instant of a successful grab, a short **taut leash/bond** snaps between
  grabber's hands and target, color-coded by relationship: **green leash = friendly carry** (ally
  carrying ally/Anchor/object), **red leash = hostile grab** (rival has your guy / you have a rival).
  A latch pop (VFX + sound, §4) confirms the moment.
- **Carrier posture + encumbrance:** the carrier visibly **hunches and slows**, with a **weight
  glyph** scaled to mass tier (small for a crate, huge for the Anchor) and **strain lines**. The
  heavier the carry, the more exaggerated — so "that Bulwark is hauling the Anchor" reads from across
  the shaft. Encumbrance speed is shown by a **trailing motion-smear** that lengthens with slowness
  (slow = long heavy smear; this is counter-intuitively readable because slowness needs an *active*
  tell, not just less motion).
- **Who is held:** the **held body goes limp/flailing** in a posture distinct from standing, with the
  red/green leash making the holder→held relationship a single arc to read. **Chains/trains** (pillar
  2d: grabber-is-prey) read as a **chain of leashes** — a comedic, legible conga of grabs.
- **STRUGGLE:** the held target shows a **struggle meter** (a small radial that fills toward break
  free) and **escalating shake on the leash** — the harder they mash, the more the leash strains and
  the more the holder is **jostled** (telegraphing the imminent break so the holder can pre-empt).
  When the struggle succeeds, the leash **snaps with a recoil pop** (both bodies stagger apart).
- **THROW aim & arc:** while holding, the thrower sees a **predicted trajectory arc** — dotted,
  in their crew color, with a **landing reticle** that **color-codes the landing**: green = safe
  floor, yellow = risky/edge, **red = into a gap / hazard / kill-plane** (so throwing your own Anchor
  is legibly risky, pillar 2). Arc thickness encodes throw power (charge). The held target's
  **wriggle spoils the aim** (pillar 2): the reticle **jitters** proportional to the target's
  struggle, so a fighting captive visibly degrades your throw. Only the thrower sees their own full
  arc; others see a **short charge tell** (a brief wind-up glow + a stubby direction nub) — enough to
  react, not a free perfect read.
- **Mass hierarchy feedback (pillar 2):** light objects = fast snappy leash, small arc, light pop;
  heavy objects/Anchor = slow heavy leash, low flat arc, big charge tell, heavy release boom. The
  *feel* teaches the hierarchy without text.

### 3.3 Ledge & fall danger reads (where will I die?)

Falls are positional death (pillar 4), so **edges and gaps must scream**:

- **Edge danger band:** every real ledge edge over a lethal drop gets a **subtle pulsing danger band**
  on the floor surface (warm-hazard color, §6 redundant via a dotted texture, not color alone). It
  intensifies as a body nears it — proximity-reactive so it's loud only when relevant.
- **Gap depth read:** because the camera is tilted, gaps show **depth fog falling away** (`06`); a
  short **"this is a real drop" shimmer** distinguishes a lethal chasm from a shallow step. Floors
  below remain real and visible (pillar 4/7), desaturated with distance, so you can read *where* a
  thrown body will end up.
- **Airborne/thrown tells:** a thrown or falling body gets a **trajectory ghost** (faint predicted
  path) and a **landing reticle** (same grammar as throw aim) so allies can **read the catch
  opportunity** (Mender/Bulwark catch fallers, pillar 8). A catchable ally shows a **"CATCH" prompt
  ring** when within an ally's catch range.
- **Anchor-specific:** since the Anchor is fall-durable (pillar 4), a thrown Anchor's reticle shows
  **"-Xm altitude lost"** rather than "death" unless it's heading for a true kill-plane, in which case
  it goes full red with a **death warning** klaxon (§8). This teaches the Smash-bros "kill with
  position" model: a thrown Anchor is usually a *setback*, a kill-plane throw is *the* play.
- **Ring-out telegraph:** when any Anchor crosses into a true kill-plane trajectory, a brief
  **slow-mo + framing pull** (§4.5) gives everyone a beat to register the drama (and the victim's
  crew a last-ditch catch window where mechanically possible).

### 3.4 The "what's happening to MY Anchor" guarantee

No matter the chaos, the player must always know their Anchor's state. Triple-redundant:
1. The **Anchor status element** (2.2) — always on screen, escalates on threat.
2. The **on-Anchor guidance glow** (3.1) + state aura (secure/exposed/grabbed/downed).
3. The **standings rail bead** (2.1) motion glyph + the **altitude-rail chevron** if off-screen.

If the Anchor is grabbed/thrown/downed, all three fire together with a coordinated **rescue CTA**.

---

## 4. The JUICE spec (game feel for a physical game)

Juice exists to **confirm physical causality** — every grab, throw, impact, and ring-out must feel
*weighty and consequential*. All juice is **view-layer, cosmetic-PRNG, snapshot-driven** (§0). Each
beat below pairs a **visual**, an **audio cue** (owned by `08`, referenced here), and a **time-feel**
treatment. Numbers are tuning starting points.

### 4.1 The legibility-safe juice budget

Juice obeys the hierarchy: it may **never** reduce the readability of who/what/where. Concretely:
- Particles have a **per-screen cap** (instanced, `06`); at cap, new effects **replace** the least
  important, never stack into mud.
- Screenshake is RMS-limited (§1.7).
- Hitstop is **globally throttled** (§4.4) so simultaneous events don't freeze the game.
- Every juice beat has a **reduced-motion equivalent** (§6).

### 4.2 Grab latch (the snap)

- **Visual:** leash snaps taut (3.2) with a **2-frame impact ring** at the contact point; grabber's
  hands **clamp** (anim pop); a tiny **dust puff** scaled to mass.
- **Time-feel:** **micro-hitstop 40 ms** on a successful grab of a teammate/Anchor (the satisfying
  "got 'em"); none for light objects (keeps object juggling snappy).
- **Audio (`08`):** mass-tiered "thunk" — light click → heavy clamp → deep Anchor *CHUNK*.
- **Failed grab (whiff):** a short **lunge + recoil** with a soft "miss" whoosh, and the grabber is
  briefly **prey-exposed** (pillar 2d) — telegraphed by a vulnerability flicker.

### 4.3 Throw release (the launch)

- **Visual:** a **wind-up squash** (charge) → **release stretch** along the arc; a **directional
  burst** at the hands; the projectile/body gets a **speed-smear** scaled to launch velocity; the
  thrower has **recoil/follow-through** (heavier mass = bigger recoil, can even stagger the thrower
  on an Anchor throw — sells the effort).
- **Time-feel:** **release hitstop scaled by mass** — 0 ms light object, ~60 ms teammate, ~90 ms
  Anchor — a tiny freeze on the launch frame that makes big throws *hit*.
- **Audio (`08`):** charge whine → release *whoom*, mass-tiered.
- **Catch-up note:** a throw that initiates a rubber-band swing (e.g. flinging a rival Anchor down)
  gets a slightly amped beat — the diegetic "blue shell" (pillar 6) deserves drama.

### 4.4 Impact (landings, hits, object collisions)

- **Visual:** **squash on impact + recovery bounce**; an **impact ring** + **debris puff** scaled to
  mass and velocity; surface-reactive (dust on stone, sparks on metal — `06`/`08`). Cracking/collaps-
  ing hazard tiles get their scripted-hazard tell (deterministic, pillar 3) reinforced on impact.
- **Time-feel — hitstop ladder (globally throttled):**
  ```
  light hit / soft landing    0–30 ms
  heavy object impact         60 ms
  body slam (player)          70 ms
  Anchor hard landing         110 ms
  GLOBAL throttle: total hitstop ≤ 130 ms per 250 ms window; concurrent events
    take the MAX, not the sum (prevents chaos-induced slideshow / determinism-safe
    because hitstop only pauses RENDER pacing, never the fixed-tick sim).
  ```
  > **Determinism guard:** hitstop is a **render-side presentation pause** only. The sim continues on
  > its fixed tick; on hitstop we hold the displayed snapshot frame, then catch interpolation up.
  > Hitstop must **never** gate input sampling or tick advance (`05`). It is purely how we *show*
  > the held frames.
- **Audio (`08`):** mass/surface-tiered impact.

### 4.5 Ring-out drama (the kill / the altitude loss)

The signature dramatic beat. Two tiers:
- **Altitude-loss throw (Anchor thrown down, survives):** brief **camera pull + 0.25 s slow-feel
  (render-pace, not sim)**, a **streak trail** on the falling Anchor, and a **standings-rail slam**
  (the bead drops with a thunk). The victim crew gets a **rescue/recover CTA**; rivals get a small
  **schadenfreude flourish**. This is common and should feel *bad-but-survivable*.
- **True ring-out (kill-plane / Anchor death):** the full beat — **slow-mo to ~35% for ~0.5 s**, a
  **focus pull to the killed Anchor**, **desaturation of the world except the two crews involved**,
  a **death VFX** (the Anchor's light-crown shatters), a **standings shockwave**, and a distinct
  **klaxon + sting** (`08`). Per pillar 11, **Anchor-death behavior is tunable** (respawn-at-beacon /
  downed-then-recover / eliminated) so this beat's *aftermath* varies by lobby setting — the *drama*
  of the moment does not.
- **Your-Anchor vs rival-Anchor:** your-Anchor ring-out skews the audio/color toward **alarm**;
  a rival ring-out skews toward **triumph**. Same camera grammar, different emotional dressing.

### 4.6 Fall tells (anticipation)

Anticipation sells weight. Before impacts/falls land:
- **Pre-fall wobble:** a body about to go over an edge gets a **teeter wobble** (1–2 frames of
  off-balance) — a comedic, readable "uh oh."
- **Airtime read:** falling bodies **flail** (Gang-Beasts charm) and cast the **trajectory ghost**
  (3.3) so the catch/no-catch decision is legible mid-air.
- **Hazard wind-up:** scripted hazards (crushers, turrets, collapsing tiles — pillar 3) have
  **deterministic, generous wind-up tells** (telegraph color sweep + audio, `08`) because they're
  pure tick-functions and must be *learnable*, never feel-bad-random.

### 4.7 Positive-feedback juice (climb & coordination)

Not all juice is violence. Reward the co-op core:
- **Coalescence ascend pop:** emerging up through a coalescing floor (pillar 7) gives a **satisfying
  "surface-break" burst** + altitude-ticker bump (the climb's dopamine; doubles as §7's reveal beat).
- **Assist confirms:** a successful **hand-up**, **catch**, **boost-the-Anchor**, or **gap-bridge**
  gets a **green assist sparkle** + a soft chime + a brief **bond glow** between the helping players
  — co-op is *visibly* rewarded so the social loop reinforces itself.
- **Recall coalesce-in:** (2.5) the rally moment gets a unifying crew-colored bloom.

---

## 5. Onboarding: 4 verbs + asymmetric roles + the Anchor concept

Goal: a brand-new player **gets it** within their first match, ideally first 60 seconds (§9). We do
**not** use a long isolated tutorial (multiplayer-first game). We use **a contextual, layered,
in-the-real-game onboarding** with an optional 60-second solo "Tower Steps" sandbox.

### 5.1 Teaching the four verbs (RUSH / GRAB / THROW / STRUGGLE)

- **One verb per moment, just-in-time.** First gap → teach **RUSH** (a ghosted prompt + a safe demo
  gap). First pickup in reach → teach **GRAB**. Holding something near a target → teach **THROW**
  (with the aim-arc visible, 3.2). First time grabbed → teach **STRUGGLE** (the mash prompt appears
  *on* the struggle meter, 2.2/3.2). Each prompt **fades permanently** once performed successfully.
- **Diegetic prompts, not modal popups.** Prompts render as **on-character/world ghost hints**
  (button glyph at the hands for grab, arc preview for throw) so learning happens *in the play space*,
  never in a blocking overlay.
- **The aim-arc IS the throw tutorial.** Because throwing always shows the color-coded landing
  reticle (3.2), players learn safe-vs-risky throws by *seeing*, including the "red = don't throw your
  Anchor into the void (unless you mean it)" lesson.

### 5.2 Teaching asymmetric roles

- **Role identity card at pick (lobby, 2.6):** silhouette + verb kit + one-line **"your job for the
  Anchor."** (e.g. Bulwark: "Body-block grabs aimed at your Anchor. Break grabs on allies.")
- **Role-contextual first-match nudges:** the game surfaces **one role-specific CTA** early — Bulwark
  gets a "body-block this grab!" moment, Mender a "catch that faller!" moment, Engineer a "bridge this
  gap!" moment — so each role learns its *signature interdependency* (pillar 8) by doing it once with
  a spotlight.
- **The interdependency lesson:** the first gap the Anchor can't cross alone triggers a **crew CTA**
  ("Your Anchor can't make this jump — carry or bridge them!") teaching pillar 1's "nobody gets the
  Anchor up alone."

### 5.3 Teaching the Anchor concept (the keystone)

- **The score IS the Anchor.** From the first second, the altitude ticker (2.2) is explicitly **"YOUR
  ANCHOR'S HEIGHT = YOUR SCORE."** No separate personal score exists to confuse them (pillar 1).
- **If you ARE the Anchor:** a dedicated short framing — "You are the Anchor. You're heavy, tough, and
  the most important. You can't cross big gaps alone — your crew gets you up. Plant the beacon, help
  where you can, and **don't get thrown into the void.**" The PLANT BEACON prompt teaches the recall
  rally early.
- **If you're NOT the Anchor:** "Everything you do is for your Anchor's height. Protect it, lift it,
  and throw the *other* crews' Anchors into the abyss."
- **First flashpoint = the thesis:** the onboarding is *complete* the first time a player participates
  in a flashpoint (rescuing their Anchor, or throwing a rival's) — the game gives a one-time
  **"THAT'S THE GAME"** affirmation flourish.

### 5.4 Optional solo sandbox ("Tower Steps")

A 60-second, no-rivals, deterministic mini-tower reachable from the menu for players who want to drill
the verbs before joining. Same engine, no special-casing — it's just a 1-crew lobby with a fixed seed.

---

## 6. Accessibility

Accessibility is **first-class and reachable from lobby + pause** (2.6), not an afterthought. ASCENT's
visual chaos makes this *especially* important.

### 6.1 Color & identity (colorblind-safe)

- **No information is color-only — ever.** Every color channel has a redundant second channel:
  - **Crew identity:** color **+ a per-crew shape/sigil** (on ground ring, standings bead, beacon).
  - **Roles:** color **+ silhouette + role glyph** (§3.1).
  - **Relationship (friend/foe leash):** green/red **+ leash texture** (solid weave = ally, jagged =
    hostile) **+ position/context**.
  - **Danger (edges/hazards/throw reticle):** color **+ dotted/striped texture + icon** (skull on
    kill-plane reticle, not just red).
- **Colorblind palettes:** Deuteranopia / Protanopia / Tritanopia presets that pick **maximally
  separable** crew hues, plus a **high-contrast** mode. Defaults are chosen from a
  CVD-safe base palette (owned with `06`).
- **Crew-relative framing reduces color load:** because *your* crew is always the highlighted,
  full-saturation, center-locked one (1.6/2.1/3.1), the most important read ("mine vs not-mine") is
  carried by saturation + position + your guidance glow, not by distinguishing five hues.

### 6.2 Motion & camera comfort

- **Screen Shake slider** (0–100%, default 60%) — §1.7; at 0% shake → bounded edge-flash equivalent.
- **Reduced Motion master toggle:** caps camera shake, **disables cosmetic camera roll**, replaces
  zoom-punches with flat flashes, tames the breathing-dolly speed, and reduces particle density.
- **Hitstop/slow-mo toggle:** scale or disable time-feel pauses for players who find them disorienting
  (purely presentation; sim unaffected, §4.4).
- **Camera smoothing slider:** for motion-sensitive players, increase smoothing / reduce fall
  rubber-band.
- **Flash-safety:** no full-screen high-frequency flashes; ring-out/alarm flashes are bounded in
  frequency and intensity (photosensitive-safe).

### 6.3 Input

- **Full remap** for all four verbs + role ability + recall + camera helpers, on keyboard/mouse and
  gamepad. Read by the input layer that produces the quantized **`InputFrame`** (`05`) — remap is a
  view/input-layer concern and **never** affects the deterministic sim (the sim sees the bit-packed
  frame, not keys).
- **Hold/toggle options** for grab and recall (hold-to-grab vs toggle-grab) for accessibility/
  preference.
- **STRUGGLE alternatives:** mash is hard for some players — offer **alternating-key**, **hold**, or
  **single-press-rhythm** struggle modes that map to the same intent stream.
- **Aim assist (optional):** light throw-aim magnetism toward valid targets/landings, lobby/
  accessibility-gated (must stay fair in PvP — off by default in Cutthroat preset).

### 6.4 UI scale & readability

- **UI scale slider** (75–150%) — all HUD is corner-anchored and **resolution-independent**; the
  Anchor status element scales with priority (it gets bigger faster).
- **Text:** dyslexia-friendly font option, adjustable size, high-contrast text background scrims.
- **Subtitles/captions** for the audio cue table (`08`) — every gameplay-critical sound (grab,
  ring-out klaxon, hazard wind-up, rescue sting) has a **captioned/visual equivalent** so audio-impaired
  players never lose a critical read. (UX ↔ audio share the cue table.)
- **Reduced-clutter HUD mode:** collapses standings to a single "are you winning?" arrow + keeps only
  the Anchor status element, for cognitive-load-sensitive players.

---

## 7. The Coalescence reveal as a UX beat

The Coalescence visual (pillar 7, `06`) is not just art — it's a **core UX affordance and emotional
beat**, and the UX layer co-owns its *meaning*:

- **Wireframe = readable intent.** Floors above hang as dotted/glowing wireframe "potential." UX uses
  this as **route signposting**: the wireframe shows *where you can go* before you commit, so route
  selection (multiple routes per stratum, pillar 7) is a **readable planning decision**, not a guess.
  The vertical altitude rail (2.3) mirrors the next floor's wireframe tick so HUD and world agree.
- **Resolve-on-approach = progress feedback.** Dots → lines → panels → lit as the crew nears. This is
  a **continuous positive feedback signal**: the world *building itself around your ascent* is the
  game telling you "you're climbing, you're winning ground." It pairs with the altitude ticker and
  the §4.7 ascend pop.
- **Emerge-up-through reveal = the climb's signature moment.** Players emerge up through a coalescing
  floor (pillar 7). UX treats each emergence as a **micro-reveal beat**: a brief framing settle + the
  surface-break burst (§4.7) + a soft "new ground" chime (`08`). It makes endless climbing feel like
  **continuous discovery** rather than repetition — the antidote to "infinite tower = samey."
- **Floors below persist (anti-disorientation).** Because below-floors stay real and only
  desaturate/fog (pillar 4/7), the player's **mental map is stable** — a critical UX win for a game
  where you can be thrown *down* into real places. We never fragment-and-drop floors (explicitly
  rejected, pillar 7), which would destroy spatial memory and the ability to read where a thrown body
  lands.
- **Recall uses the same grammar (2.5):** recalling players coalesce in, reinforcing one consistent
  visual language for "becoming present" in the world.

---

## 8. Drop-in / drop-out & reconnect UX (built on Frequency migration)

Reuses the proven frequency `src/net/` base (host/peer roles, **silent host migration** via the
generation ladder, deterministic room-code → peerId, PeerJS signaling-only + STUN/TURN, the
reconnection tuning). Per `05`, ASCENT keeps frequency's *connection brain* and replaces its
*simulation brain* (the host-authoritative reducer/snapshot model is gone — ASCENT is peer-symmetric
rollback). See `05` for the netcode; this section owns the **player-facing** experience. Confirmed
real files in `frequency/src/net/`: `roomCode.ts`, `migration.ts` (`nextHost` + generation ladder),
`net.ts` (`NetController`), `transport.ts`, `protocol.ts`, `peer.ts`/`peerClient.ts`/`hostServer.ts`,
`netStore.ts` (zustand, never touches DOM).

### 8.1 Drop-in (join mid-match)

- **Warm slot:** a crew can hold a slot for a known player; a fresh joiner picks an open role/crew
  from the lobby/pause join screen. Joining mid-match is **expected and frictionless** (set in lobby
  copy, 2.6).
- **Coalesce-in spawn:** a joining player **coalesces in at their crew's Recall Beacon** (or at the
  Anchor if no beacon), reusing the Coalescence grammar — no jarring pop, and they arrive *useful*
  (next to the thing that matters). A brief **"X joined your crew"** toast + a role-CTA gets them
  oriented (§5.2 nudges fire for fresh joiners).
- **No catch-up penalty/advantage:** standing is the Anchor's height (pillar 1), which the existing
  crew already owns — a joiner can't help or hurt the score by *existing*, only by *playing*. This
  makes drop-in fair by construction.

### 8.2 Drop-out (leave / disconnect)

- **Graceful leave:** the departing player's character **coalesces out** (not a corpse-drop); if they
  were carrying the Anchor or a teammate, the held body is **safely set down** (never dropped into a
  gap by a disconnect — a disconnect must not cause a ring-out; this is a fairness rule the sim
  enforces, surfaced here as "set-down, not drop").
- **Crew continuity:** the crew keeps climbing; the slot goes "open (reconnecting…)" so the player can
  return (8.3). A **discreet HUD note** shows reduced crew strength so the crew can adapt (e.g. pull
  the Anchor back, recall, regroup).

### 8.3 Reconnect (the Frequency migration UX)

- **Silent host migration (invisible to players):** if the host drops, frequency's generation-ladder
  migration re-elects a host **without a visible interruption** (`05`). UX target: **no modal, no
  "host migrating" freeze** in the common case — at most a **tiny transient connection pip** in the
  corner that clears in <1 s. The deterministic, input-based netcode means the sim state survives the
  migration; players should barely notice.
- **Reconnect window:** a dropped player has a reconnect window during which their slot is held
  ("reconnecting…" on the crew board + a ghosted character placeholder so teammates know help is
  coming back). On reconnect they **coalesce back in at the beacon/Anchor** and resume.
- **Connection quality HUD:** a small, **non-alarming** connection indicator (corner pip) reflects
  per-peer RTT/loss health (`05` framing). It escalates to a clear message only on a **genuine,
  sustained** problem ("Reconnecting…", "Lost connection — rejoining…") — never flickery anxiety-
  inducing warnings on a single dropped packet (the redundant last-N-frame input packets, `05`,
  absorb normal loss invisibly).
- **Rollback is invisible by design:** GGPO-style rollback+resim (`05`) is hidden behind the
  interpolated snapshot the view layer renders — players see smooth motion, not the corrections.
  The juice/camera layer must **tolerate small position corrections gracefully** (snapshot
  interpolation + the asymmetric smoothing in §1.3 absorb minor resim pops; large corrections are
  rare and clamped). This is an explicit feel requirement on the camera/animation code.

---

## 9. The first 60 seconds (new player)

The make-or-break window. Choreographed beats (times approximate; all view-layer, all
snapshot-driven):

| t (s) | Beat | What the player sees/learns |
|------:|------|------------------------------|
| 0–3   | **Spawn coalesce-in** | Player + crew coalesce in at the tower base; camera settles on the **Anchor-weighted centroid** (§1.2). The Anchor's light-crown is unmistakable. Tone: "this big glowing one is precious." |
| 3–8   | **Score = Anchor** | Altitude ticker reads **0m** with "YOUR ANCHOR'S HEIGHT = SCORE" (§5.3). Standings rail shows other crews as beads — "this is a race." |
| 8–18  | **First climb + RUSH** | Floors above resolve from wireframe (Coalescence reveal, §7). A short gap teaches **RUSH** (§5.1). First **ascend pop** (§4.7) — climbing feels good. |
| 18–30 | **First GRAB + THROW** | A loose crate in reach teaches **GRAB**; a target teaches **THROW** with the **color-coded aim arc** (§3.2/5.1). Player launches an object — first impact juice (§4.4). |
| 30–42 | **Interdependency moment** | The Anchor hits a gap it **can't cross alone** → crew CTA "carry/bridge your Anchor!" (§5.2). The player either helps carry/boost or watches a teammate do it. Pillar 1 lands: *nobody gets the Anchor up alone.* |
| 42–54 | **First rival contact / flashpoint** | A rival crew's bead climbs into range; camera does its **flashpoint pull** (§1.5). A red leash/grab appears near an Anchor. STRUGGLE/RESCUE prompts fire (§5.1). The brawl flashpoint rhythm (pillar 5) is felt. |
| 54–60 | **"THAT'S THE GAME" affirmation** | Player participates in the flashpoint (rescue own Anchor, body-block, or throw a rival object/Anchor). One-time affirmation flourish (§5.3). They now understand: **climb the Anchor, protect the Anchor, sink rival Anchors.** |

Failure-mode guards: if the player is idle, gentle escalating prompts; if they're the Anchor, the
beats reframe to the Anchor's POV (§5.3); if no rival is near by t≈45, the game **does not fake** a
flashpoint (no AI, pillar 3) — instead it leans the affirmation onto a **co-op assist** beat (§4.7)
so the thesis still lands via the *escort* half of the game.

---

## 10. Open tensions / things to resolve with sibling docs

1. **Throw-aim information parity vs. mind-games.** I give the *thrower* a full color-coded arc but
   only a short charge tell to *others* (§3.2). This balances readability against telegraph-fairness
   in a brawl. If `02`/`04` want throws to be more/less readable to opponents (PvP-spice knob, pillar
   11), the "others see" fidelity should become a **lobby setting**. **Flagged for `02`/`04`.**
2. **Durability arc vs. no-damage-model.** Pillar 4 says we kill with position, not damage. I added a
   **durability arc** on the Anchor (2.2) for *hazard* survivability, explicitly framed as resilience,
   not Smash-style knockback%. If `02`/`01` intend the Anchor to be purely position-killed with **no**
   durability resource, drop the arc and replace with a binary "near-kill-plane" warning. **Flagged
   for `01`/`02`.**
3. **Recall as teleport vs. movement.** I implemented recall as a **hold-to-recall coalesce-in** to
   the beacon (2.5). If `01`/`04` intend recall to be a *physical assisted move* rather than a
   teleport, the UI becomes a "rally waypoint" path instead. **Flagged for `01`/`04`.**
4. **Standings scale (log-compression).** I log-compress distant crews on the rail (2.1) for
   near-crew resolution. If `04`'s endless mode needs **exact absolute** altitudes always legible, add
   a toggle/expanded standings panel. **Flagged for `04`.**
5. **Hitstop in a rollback netcode.** I assert hitstop is render-presentation-only and never gates the
   tick (§4.4). `05` must confirm the render/sim decoupling supports a presentation pause without
   desyncing interpolation under rollback. **Flagged for `05`.**
6. **Aim-assist fairness.** Optional throw-aim magnetism (§6.3) is an accessibility need that collides
   with competitive fairness. Default off in Cutthroat; needs `04` sign-off on whether it's allowed in
   ranked-style play at all. **Flagged for `04`.**
7. **Screenshake/particle budget vs. art's spectacle pillar.** My hard caps (§1.7/4.1) may clip some
   of `06`'s maximal-spectacle ambitions. The budget owner (UX, for legibility) and the look owner
   (`06`) must reconcile the per-screen particle cap and shake RMS limit. **Flagged for `06`.**
```
