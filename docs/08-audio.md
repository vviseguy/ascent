# 08 — Audio & Music Direction (ASCENT v3)

> Supersedes any earlier audio notes. Consistent with the v3 vision bible. Cross-references:
> `01-game-design.md`, `02-roles-anchor-verbs.md`, `02-roles-traversal-combat.md`,
> `04-competitive-structure.md`, `05-netcode-architecture.md`, `06-art-direction-shaders.md`,
> `07-ux-ui-gamefeel.md`, `09-level-generation.md`. Where this doc names a tick value or event it
> is the canonical audio-side contract; flag mismatches against those docs in review.

## 0. TL;DR — what audio must do here

ASCENT is a **vertical escort brawl-race** with a **climb-first, brawl-flashpoint** rhythm
(bible pillar 5: calm-coordination → panic-burst → calm). Audio has exactly three jobs, ranked:

1. **Tell you where YOUR ANCHOR is and how it's doing — always, through any chaos** (pillar 1). The
   Anchor is the game; its audio is the game's audio. This owns the top of the mix priority stack.
2. **Make the four verbs (RUSH/GRAB/THROW/STRUGGLE) instantly readable by ear** so brawls stay
   legible in a top-down camera where the action can be small and stacked (pillar 2). Sound is a HUD.
3. **Score the pacing swing** — climb → flashpoint → resolve — and stamp the two dramatic beats that
   define the genre: **a LEAD CHANGE** and **YOUR / A RIVAL ANCHOR THROWN DOWN** (pillars 5, 6, 9).

Everything below serves those three, in that order. Determinism rule (bible "Time/clock"): **audio is
view-layer only; it NEVER feeds the sim, reads only committed sim state, and is driven off the shared
tick counter for musical timing — `performance.now()` lives at the transport layer, not here.**

Assumed sim rate (confirm with `05-netcode-architecture.md`): **60 fixed ticks/s**. All "tick" math
below uses 60 Hz; if the netcode doc lands on a different rate, the formulas scale, the design doesn't.

---

## 1. Determinism & architecture stance (read first)

Audio is downstream of the rollback sim. It is allowed to be *wrong* briefly (a sound that a rollback
later un-happens) but must never *cause* divergence.

**Hard rules**

- **No audio call may write sim state, advance the sim PRNG, or branch sim logic.** Pitch/pan
  randomization uses a **separate, view-only RNG seeded from `(tick, eventId)`** — deterministic *for
  one client's replay sameness* but explicitly walled off from the seeded sim PRNG (bible: "seeded
  PRNG, NEVER built-in random" governs the sim; audio gets its own walled RNG so two viewers of the
  same match can sound slightly different without anyone desyncing).
- **Events are derived, not sent.** We do not put "play sound X" on the wire. Each client diffs
  *committed* sim state per rendered frame and emits **audio events** locally. Inputs-not-state (bible
  pillar 12) means every client reconstructs the same state and therefore the same events — for free,
  no extra bandwidth.
- **Rollback-safe SFX (the de-risk that matters):** the grab/throw/many-rigid-body layer is the
  bible's named determinism risk (pillar 12). Its *audio* inherits a softer version: a mispredicted
  GRAB can fire a latch sound that rollback then erases. We handle this with a **2-class event model**
  (§6.3 below + §8.3): *speculative* one-shots play immediately on predicted state (responsiveness
  wins); *committed* one-shots wait until the event survives `confirmFrame`. The Anchor-thrown stinger
  is **committed-only** — we never fake the biggest dramatic beat.

**Where it lives in the frequency-derived stack.** ASCENT reuses frequency's `src/net/` (host-auth
single reducer, intents, fast-path vs state-path throttles, silent host migration). Audio plugs in as
a pure consumer:

```
sim (rollback, deterministic)            <-- ground truth, ticks
   |  committed snapshot per render frame
   v
AudioDirector (view-layer, this doc)     <-- diffs snapshots -> AudioEvent[]
   |        |
   |        +--> MusicEngine  (adaptive layers, tempo = f(tick))
   +-----------> SfxBus       (verbs, roles, hazards, spatialized)
```

`AudioDirector.update(prevSnap, snap, tick, localCrewId, listenerPose)` is the only entry point. It is
called once per **rendered** frame (not per sim tick — render and sim decouple). We de-dup events by
`(eventKind, entityId, tick)` so a frame that resimmed 6 ticks doesn't fire 6 throws.

---

## 2. The `useSound` pattern (reused from frequency)

frequency ships a `useSound` hook over a small Web Audio wrapper (`frequency/src/hooks/useSound.ts`).
We **REUSE the pattern, REPLACE the content** — frequency is a turn/UI-driven game; ASCENT is realtime
and spatial. Reuse decision per concern:

| frequency piece | decision | why |
| --- | --- | --- |
| `useSound()` hook (load once, returns a `play`-style API) | **REUSE** | clean React-side ergonomics, lazy `AudioContext` unlock on first gesture |
| single shared `AudioContext`, resume-on-gesture | **REUSE** | browsers require a user gesture; same problem here |
| flat sample bank + `play(name)` | **REPLACE** | we need pooling, spatialization, ducking, music layers |
| volume from settings store | **REUSE + EXTEND** | add per-bus (music/sfx/ambience/UI) sliders |

**Hook contract (TS):**

```ts
// useSound.ts  — view layer, no sim imports allowed (enforced by lint boundary)
export function useSound() {
  const ctx = useAudioContext();            // shared, resumed on first gesture
  return useMemo(() => ({
    sfx:   sfxBus,                            // SfxBus singleton (spatial one-shots)
    music: musicEngine,                       // MusicEngine singleton (layers/tempo)
    ui:    (name: UiSfx) => sfxBus.playUi(name),
  }), [ctx]);
}
```

The realtime game loop does **not** call React `play()` per event (re-render churn + GC). The
`AudioDirector` holds direct references to `sfxBus` / `musicEngine` and calls them imperatively. The
hook is for **menu/lobby/HUD** SFX (button, ready-up, the host-migration chime — see `05`'s silent
host migration; we add a near-subliminal UI tick so a migration that *should* be silent stays
emotionally silent but technically acknowledged). Do not route 200 throws/sec through React.

---

## 3. Mix priority — the Anchor cuts through chaos (pillar 1)

A flashpoint can stack 20 players, a dozen thrown crates, two hazards, and a recall in one chokepoint.
We protect legibility with a **strict priority bus graph + sidechain ducking**, not just volume. Five
buses, each a `GainNode` → compressor → master limiter:

| Bus | Contents | Priority | Behavior |
| --- | --- | --- | --- |
| **B0 ANCHOR** | your Anchor's state: presence drone, hurt, downed, grabbed, recall plant, **thrown-down stinger**, death toll | **highest, never duckable** | sidechain-DUCKS everything below; max poly always reserved |
| **B1 SELF VERBS** | the local player's own RUSH/GRAB/THROW/STRUGGLE + your role ability | high | ducks B2/B3 lightly; instant, dry, close |
| **B2 NEARBY ACTION** | other players' verbs, rival Anchors, hazards within ~AoI radius | mid | spatialized; voice-stealing managed here |
| **B3 WORLD/COALESCENCE** | floor materialization, ambient tower, distant climbers | low | the bed; first to duck |
| **B4 MUSIC** | adaptive score | sits *under* B0/B1, *over* B3 by design | own ducking lane (§5.4) |

**Anchor-protection mechanism.** B0 drives a **sidechain compressor** on B1–B4: when the Anchor emits
any state-change event (hurt/downed/grabbed/thrown), B1–B4 duck **−6 dB over 40 ms, release 350 ms**.
The Anchor literally pushes a hole in the mix for itself. Subtle for routine ticks, dramatic for the
thrown stinger (§5.3 pushes the duck to −12 dB).

**Voice stealing (B2).** Cap B2 at **24 concurrent voices**. When over budget, steal in order:
oldest → farthest from listener → quietest post-spatialization → lowest event-class weight. **Never
steal from B0/B1.** RUSH/THROW one-shots are short (<400 ms) so churn is fine; the real risk is a
hundred crate-impacts — those collapse via §6.4 instance-coalescing before they reach voice allocation.

**The "your Anchor in trouble" override.** If your Anchor enters `downed`, `grabbed`, or `thrown`,
we additionally **low-pass everything except B0 + B1 at 1.2 kHz for the duration** — a "tunnel" that
makes the crisis the only crisp thing you hear. This is the single most important mix decision in the
game and it's cheap: one `BiquadFilterNode` toggled on a bus group.

---

## 4. Spatialized audio for a top-down / three-quarter camera

Camera is slight-tilt top-down / Hades three-quarter (pillar 7, see `06-art-direction-shaders.md`).
Naive `PannerNode` HRTF assumes a forward-facing listener; here the listener "looks down" at a
play-field. We use a **2.5D pan model**, not full 3D HRTF:

- **Stereo pan = horizontal screen offset** of the source from camera center, clamped `[-1, 1]` across
  visible width. **Equal-power pan** (`StereoPannerNode`) — cheap and stable.
- **Volume = distance attenuation in WORLD space**, dominated by the **vertical (altitude) axis** for
  off-screen sources. Roll-off: `gain = clamp((refDist / max(dist, refDist))^1.0, 0, 1)`,
  `refDist = 4 m`, hard cull beyond `cullDist = 60 m`. Linear-ish (exponent 1.0) reads better than
  inverse-square for a game where you must hear things a couple floors away.
- **Altitude = a tilt cue, not pure volume.** Sources **above** get a gentle **high-shelf +2 dB** and
  slightly less low end (brighter = up, matches coalescence-above being "potential/light"); sources
  **below** get a **low-pass ~3 kHz** and a hair of reverb send (muffled/foggy = down, matches the
  desaturate-and-fog of persistent lower floors, pillars 4/7). This makes "a rival Anchor is two floors
  below you" *audibly* below without the camera showing it.
- **No Doppler.** Doppler on thrown bodies in a rollback world is a determinism/illusion headache and
  reads as noise top-down. Off.
- **Listener pose** = the **local camera focus point** (framed on the local crew's Anchor/cluster),
  NOT a single avatar. Keeps your own crew centered and clear while rivals pan/attenuate around you.

Reverb: one shared **convolver** (short bright "vertical shaft" IR, ~1.1 s) on a send. Lower floors get
more send (the abyss has tail); the summit reads dry/open. One convolver, three send levels by altitude
band — no per-source reverb.

---

## 5. Adaptive music — scoring the climb/flashpoint/resolve swing

### 5.1 Form: vertical layers + horizontal stinger seams

Primary tool: **vertical re-orchestration (stems)**; named beats get **horizontal stingers**. No
streamed pre-baked songs (asset budget + we need instant state response). The score is a **fixed-tempo
loop set, with tempo *derived from the tick counter*** so timing is replay-stable and identical across
peers without syncing audio over the wire.

**Tempo from tick (determinism-friendly clock):**
`musicBeatPhase = (tick % ticksPerBeat) / ticksPerBeat`. At 60 ticks/s and 120 BPM, `ticksPerBeat =
30`. Stinger seams and layer fades **quantize to the next beat boundary computed from `tick`**, never
from `performance.now()`. A flashpoint surge lands on the beat for every player deterministically; a
rollback that rewinds the tick rewinds the musical phase too (we don't audibly scrub — we hold the
current loop and re-quantize forward).

### 5.2 Intensity model — what drives the layers

Each client computes a **local `Intensity` scalar 0..1** from *its own* committed view (no sync needed;
inputs-not-state guarantees agreement). `Intensity` is **personal to the local crew** — your music
reflects YOUR fight, not a global mood. Correct for a soft-separated shared tower (pillar 10): you
mostly hear your stratum.

```
intensity = clamp(
    0.45 * proximityPressure   // nearest rival player/Anchor distance, inverse, AoI-scaled
  + 0.30 * combatActivity      // grabs/throws/struggles/hits last ~90 ticks, local cluster
  + 0.15 * anchorPeril         // your Anchor: hurt%, grabbed, near a kill-plane edge
  + 0.10 * hazardImminence     // scripted hazard about to fire near your crew (deterministic lookahead)
  , 0, 1)
```

Three **musical states** with hysteresis (avoid flapping):

| State | Enters when | Leaves when | Orchestration |
| --- | --- | --- | --- |
| **CLIMB (calm)** | `intensity < 0.30` for 120 ticks | — | bed: pulse + pad + sparse vertical arps; "ascending" motif. Drives the calm-coordination beat. |
| **FLASHPOINT (surge)** | `intensity ≥ 0.55` | falls `< 0.35` for 90 ticks | add low brass/perc stems, double-time hat, the "danger" ostinato. Hits hard, instantly. |
| **RESOLVE (tail)** | flashpoint left AND no combat 90 ticks | timer 6 s → CLIMB | a 4–6 s descending "exhale" cue over CLIMB return. Earns the calm again. |

Layer crossfades: **120 ms** adding tension (fast in, reactive), **800 ms** releasing (slow out,
earned). Always start/stop **on the next tick-derived beat**.

### 5.3 The big dramatic swings (the genre's signature beats)

**Horizontal stingers, committed-only**, that play *over* the layer bed and momentarily seize the mix.
The most important music in the game.

- **ANCHOR THROWN DOWN — yours (the diegetic blue-shell, pillar 6).** The defining catastrophe. On
  committed transition `anchor.state -> thrown` with `altitudeLost > threshold`:
  - **Hard −12 dB sidechain duck** of B1–B4 (§3) + the "tunnel" low-pass (§3 override).
  - A **descending two-note brass/sub "FALL" stinger** that *pitch-bends down with the Anchor's actual
    fall distance* (more floors lost = deeper, longer bend). Lands with a sub-thud on `downed`.
  - Music drops to **a near-silent held low drone for ~1.2 s** (the gut-punch space), then re-enters at
    elevated intensity (your crew is scrambling). The silence is deliberate — the loudest thing is the
    absence.
- **ANCHOR THROWN DOWN — a RIVAL's (your triumph).** Same event on a rival crew: a **bright rising
  "ring-out" flourish** panned to where it happened, *short*, does NOT duck your bed (you stay in
  control), small confidence swell in your layers. Asymmetric on purpose: catastrophe is loud and
  centered; triumph is a sparkle off to the side.
- **LEAD CHANGE.** When the **highest Anchor** in the match changes crew (standing = Anchor height,
  pillar 1; see `04-competitive-structure.md`), every client fires a **distinct 3-note "summit-shift"
  motif** in the home key:
  - **Your** crew takes the lead → bright, major, a shimmer added to your CLIMB pad for ~8 s (a
    "you're winning" halo) that fades so it doesn't nag.
  - **Lose** the lead → the same motif **inverted, minor**, no halo — a small urgency sting that
    nudges `intensity` (+0.1 for 5 s) so the music leans you back into the chase. The rubber-band
    expressed musically (pillar 6) without unfairly punishing the leader's audio (it only touches the
    *trailing* listener's own mix).
  - Lead change is **match-global** but each client computes it from its own committed standings table
    (agreed by construction). Quantized to beat. **Committed-only** — never faked.
- **COALESCENCE / FLOOR RESOLVE (pillar 7).** Not a stinger but a **musical sweetener**: as the local
  crew crosses into a newly-resolving stratum, layer in a **rising harmonic "bloom"** (a filtered swell
  that opens as dots→lines→panels→lit completes), tick-synced to the visual resolve (`06`, `09`).
  Reinforces the "emerge up through a coalescing floor" moment. Low priority (B3/B4 boundary), ducks
  instantly under any combat.

### 5.4 Music ducking lane

Music (B4) ducks under verb SFX only *lightly* (−3 dB) so the score stays present in brawls — the score
IS the brawl energy. It ducks **−9 dB under any B0 Anchor stinger** so dramatic beats own the moment.
Never let music mask an Anchor-in-peril cue.

---

## 6. SFX language — sound as HUD (pillar 2 readability)

Design law: **a blindfolded experienced player should narrate the fight from audio alone.** Every verb,
role, and hazard gets a **distinct, consistent sonic signature** on a reserved spectral/timbral lane so
they don't mask each other.

### 6.1 The four verbs (the core readability contract)

| Verb | Sonic signature | Spectral lane | Variants by mass hierarchy |
| --- | --- | --- | --- |
| **RUSH** (dash/stagger) | short upward *whoosh-tick*, airy transient + a "shove" thud on contact-stagger | mid-air 800 Hz–4 kHz | whiff (no hit) vs connect (adds low thud); harder stagger = lower, longer thud |
| **GRAB (latch)** | a **decisive mechanical "CHK-latch"** — the single most important SFX; must be unmistakable | sharp 1–3 kHz click + tiny sub | latch pitch **drops with target mass**: light object = high snap; teammate = mid; **Anchor = deep, heavy "CLAMP"** (you instantly hear someone grabbed an Anchor) |
| **THROW (whoosh + impact)** | two-part: **release whoosh** (rising, pans toward aim) → **impact** (lands at target). Decoupled events. | whoosh 500 Hz–5 kHz sweep; impact broadband thud | impact scales with thrown mass: crate = crack; teammate = "oof"+thud; **Anchor = huge boom + sub** (the throw you fear) |
| **STRUGGLE (mash)** | rhythmic **rubbery creak/strain** that **rises in pitch & rate as the grab nears breaking**; release = a "snap-free" pop | gritty 200 Hz–1.5 kHz, intentionally "tight/strained" | faster mash → faster creak (audible "they're about to break free"); the BULWARK break-grab gets an extra authoritative "SNAP" |

These four lanes are **reserved and never reused** by roles/hazards. If you can't tell which verb fired
with your eyes closed, the SFX is wrong. (Verb definitions track `02-roles-anchor-verbs.md` and
`02-roles-traversal-combat.md`; the mass hierarchy — light object → heavy object → teammate → Anchor —
maps directly onto the latch/impact pitch ladder.)

**Held-player feedback (pillar 2):** a carried player emits a quiet looping "wriggle" (STRUGGLE family,
lower) and a soft chip tick for their light damage — so the carrier *hears* the cost of holding (one of
the bible's five grab-pressures made audible).

### 6.2 Roles & abilities (six identities, pillar 8)

Each role gets a **signature instrument/material** so its ability is identifiable off-screen. Each
ability = a short cue in that role's timbre, distinct from the verb lanes:

| Role | Material/timbre | Ability cues |
| --- | --- | --- |
| **Runner/Scout** | light, glassy, fast | route-tag "ping" (sonar blip, pans to the tagged spot); hazard-tag = warning two-tone |
| **Bulwark/Anchor-guard** | heavy metal/stone | body-block grab = a deep "**WALL**" stop; break-grab = authoritative SNAP (§6.1); shove = big low thud |
| **Mender/Lifeline** | warm, choral/bell | heal = soft ascending shimmer; shield = glassy "bubble-on"; revive = rising 3-note hope motif; catch-faller = a relieved swell |
| **Engineer/Trickster** | wood/construction, clicky | build ramp/bridge = quick "assemble" ratchet (rises as it completes); trap-arm = a furtive *tick…tick*; block placed = woody clunk |
| **Breaker/Mover** | percussive, gravelly | charge = rising grind; break = satisfying **crunch-collapse** + debris tail; shortcut-open = a "way clears" downward sweep |
| **ANCHOR** | the **deepest, most resonant voice in the game** | §6.3 — its own lane, always audible |

Distinct pitch/material per role means a teammate's heal and an enemy Breaker's collapse never sound
alike, even both off-screen.

### 6.3 The ANCHOR's own sonic lane (pillar 1 — owns B0)

The Anchor is never silent and never ambiguous. Its sounds occupy the **deepest, most resonant lane**,
reserved on B0:

- **Presence:** a subtle low **"weight" drone** tied to your Anchor's position — a constant, quiet
  anchor you subconsciously track. Pans/attenuates with the Anchor; if it goes faint you *feel* your
  Anchor drifting from the crew. (Local crew only; rivals' Anchors get spatial event SFX, not the
  personal drone.)
- **Carried:** a heavy **"lift" groan** on pickup + a strained loop while carried (you hear your VIP is
  in someone's hands — yours or a rival's; the loop is *darker/dissonant* if a RIVAL holds it — pillar
  9 person-CTF flavor).
- **Hurt / near kill-plane:** an escalating **low pulse** that quickens as the Anchor nears a hazard or
  ledge edge — a diegetic danger meter for the thing that matters most (pillar 4: kill with POSITION).
- **Grabbed:** the deep "CLAMP" (§6.1) **plus** a B0 alarm tone your crew hears prominently.
- **Thrown down:** the §5.3 catastrophe — music+SFX together. **Committed-only.**
- **Recall beacon plant (pillar 1):** a distinctive **"home" chime + soft expanding ring** (a low
  rising hum resolving on a stable tone) so the whole crew aurally registers "rally point set." The
  beacon emits a faint periodic ping (every ~2 s, tick-synced) so the crew can hear-find it. Recall
  *activation* = a brief "fold/whoosh-in" as the crew snaps to Anchor height (never ahead — pillar 1;
  cooldown-gated per `01`/`02`).

### 6.4 Hazards (pillar 3 — deterministic, so audio can PREDICT)

Hazards are pure functions of the tick counter — **a gift to audio**: we play **anticipation cues** on
a deterministic lookahead, no guessing. Each hazard has a **3-phase envelope: TELL → FIRE → TAIL**,
TELL scheduled `N` ticks ahead of FIRE (we know FIRE's exact tick).

| Hazard | TELL (pre-fire) | FIRE | TAIL |
| --- | --- | --- | --- |
| Timed crusher | rising mechanical *wind-up* whine, ~30 ticks ahead | huge slam + sub | hydraulic hiss retract |
| Pattern turret | targeting *tick-tick-lock* | pew/thunk per shot, panned along fire line | — |
| Collapsing/cracking tile | escalating *crackle* under foot (louder closer to break) | sharp crack + give-way | debris patter (below, foggy) |
| Gust / conveyor | continuous directional *air/whir* loop (pans with direction) | — (continuous) | — |
| Spikes | metallic *shink* extend warning | wet thud on contact | retract scrape |

Each family has a **reserved timbre** distinct from verbs and roles. The crackling-tile cue is
deliberately under-foot and *spatially precise* — a primary readability tool for "don't stand there."
Because timing is deterministic, **the TELL is sample-accurate to FIRE** for every player. (Hazard
catalogue tracks `09-level-generation.md`.)

**Instance-coalescing (the crate-storm problem).** When >K identical impacts occur within a small
radius in one frame (collapsing debris, a thrown-crate volley), **collapse them into one summed
"rubble" event** scaled by count (louder/fuller, slight spread), instead of K voices. K=4. This keeps a
chokepoint collapse from nuking the voice budget (§3) and keeps the mix legible.

### 6.5 Fall / ring-out (pillar 4 — kill with POSITION)

- **Regular player lethal fall:** a Doppler-free **descending "fade-down"** (darker/quieter/more
  low-passed as they recede below — reuses the altitude=below filter, §4) capped by a distant soft
  "gone" cue. Lethal but not melodramatic; regulars die a lot.
- **Anchor ring-out vs Anchor merely thrown-down:** *audibly different*, because they mean different
  things (pillar 4). **Thrown-down** = the §5.3 catastrophe + a `downed` vulnerable-beat sting, then it
  *recovers* (the crew can hear it's not dead). **True Anchor death** (into a hazard / off the very
  bottom kill-plane) = a final, conclusive **low "toll"** (a bell-like death knell) with full B0
  ownership — no ambiguity between "we lost altitude" and "we lost the Anchor."

---

## 7. Ambience & coalescence bed (pillar 7)

- **Vertical shaft tone bed:** a quiet, evolving drone whose **timbre tracks altitude band** — lower =
  darker/foggier (matches desaturate-and-fog), higher/summit = brighter/airier/thinner (matches
  resolving wireframe potential above). Crossfades between ~5 altitude-band beds as you climb. Pure
  loop, tiny footprint.
- **Coalescence materialization (the floor reveal):** as dotted/glowing wireframe resolves
  dots→lines→panels→lit, audio runs a **matched "crystallize/assemble" sweep** — filtered noise + bell
  shimmer that *opens up* as the floor solidifies, tick-synced to the visual stages (`06`, `09`).
  Players **emerging up through** a coalescing floor get a brief "breach/whoosh-up" as they pop through.
  This is the bible's headline visual; its sound should feel like a held breath releasing into a new
  space.
- Floors **below persist** (pillars 4/7, NOT fragment-and-fall) — so their ambience persists too, just
  filtered/foggy with distance (§4). We **never** play a "floor destroyed/fell" sound, because floors
  don't.

---

## 8. Web Audio implementation notes (lightweight)

### 8.1 Asset budget & formats

Browser game, fast load, no loading screens (pillar 7) → **aggressive budget**:

- **Format:** ship **`.webm`/Opus** as primary (~96 kbps mono is plenty for SFX), with **`.m4a`/AAC
  fallback** for Safari quirks. Detect via `canPlayType`, load one set. No `.wav` in production.
- **SFX:** **mono** (we spatialize at runtime; stereo wastes 2x and fights the panner). Short. Target
  **total SFX bank ≤ 1.5 MB compressed** (~120 one-shots @ avg 12 KB).
- **Music stems:** the heavy items. **≤ 8 stems**, mono/light-stereo, looped, **total ≤ 2.5 MB
  compressed.** Loops, not songs — that's how 2.5 MB scores an endless game.
- **Ambience beds:** ~5 altitude beds, mono loops, **≤ 0.8 MB total.**
- **Grand total audio ≤ ~5 MB.** Loadable before first match; lazy-load music stems behind the lobby.
- **Sample-accurate loops:** author loop points at zero-crossings; for music prefer power-of-two-bar
  loops so tick-derived beat math stays exact.

### 8.2 Engine shape

- **One `AudioContext`**, resumed on first user gesture (reuse frequency's unlock). One **master
  compressor/limiter** at the end (prevents chokepoint chaos from clipping — essential).
- **Decode once at load → `AudioBufferSourceNode` per play** (single-use, cheap to spawn, GC-friendly
  if short). **Pool `GainNode`/`StereoPanner` wrappers** (a ring of ~32 reusable "voice" channels for
  B2) to avoid per-shot graph churn.
- **Buses = persistent `GainNode`s** (B0–B4) → sidechain compressors (§3) → master limiter →
  destination. Listener is logical (our 2.5D model, §4), not `AudioListener` HRTF.
- **Scheduling:** for tick-synced cues (music seams, hazard TELLs, beacon pings) use
  `AudioBufferSourceNode.start(when)` where `when` converts from the target **tick** via the
  transport's tick↔time estimate **at scheduling time** — the *only* place audio touches wall-clock,
  read-only/cosmetic, never re-entering the sim. Re-quantize on rollback by cancelling un-started
  scheduled sources.
- **No `ScriptProcessor`/`AudioWorklet` needed** — sample playback + standard nodes only. Keep it
  boring and portable (the bible's cross-browser determinism caution applies even to cosmetic audio:
  avoid worklet math that differs per engine).

### 8.3 The event diff (how AudioDirector turns sim → sound)

```ts
type AudioEvent =
  | { kind: 'verb',   verb: Verb, mass: MassClass, pos: Vec3, by: EntityId, speculative: boolean }
  | { kind: 'role',   role: Role, ability: string, pos: Vec3 }
  | { kind: 'hazard', haz: HazardId, phase: 'tell'|'fire'|'tail', fireTick: number, pos: Vec3 }
  | { kind: 'anchor', crew: CrewId, state: AnchorState, altitudeDelta: number, pos: Vec3 }
  | { kind: 'meta',   what: 'leadChange'|'coalesce'|'recallPlant'|'recallFire', ... };

// per rendered frame:
const events = diffSnapshots(prev, cur, tick);     // pure, deterministic given snapshots
for (const e of events) route(e);                  // -> bus + sample + spatial params
//  speculative verb one-shots: play now (responsiveness)
//  committed-only (anchor thrown, lead change, anchor death): require survival past confirmFrame
//  hazard TELLs: schedule at fireTick - N via start(when)
musicEngine.setIntensity(localIntensity(cur));     // smoothed, hysteresis (§5.2)
```

De-dup key `(kind, entityId, tick)` so a frame that resimmed many ticks emits each event once. On
rollback, **cancel scheduled-but-unstarted** sources whose triggering event no longer exists;
already-playing one-shots are let to finish (cheaper and imperceptible — a stray click vs an audible
scrub).

---

## 9. Open tensions / to resolve with 01/02/04/05

1. **Speculative vs committed boundary feel.** Speculative GRAB-latch maximizes responsiveness but a
   frequently-mispredicted grab will "stutter-latch." My call: **RUSH/THROW-release/STRUGGLE
   speculative; GRAB-latch speculative but with a ~50-ms confirm-grace before the heavy Anchor "CLAMP"
   variant; all Anchor-thrown/death/lead-change committed-only.** Confirm misprediction rates with
   `05-netcode-architecture.md`.
2. **Personal vs global music.** I chose **per-local-crew intensity** (your fight = your music) over a
   global director. In rounds-to-summit / race-to-height modes (pillar 11, `04`) a host might want a
   shared "final ascent" theme near the win line — a *global overlay*. Flag: needs a host-setting hook.
3. **Rubber-band in audio (pillar 6).** Losing-the-lead nudges intensity +0.1 — "aid comeback" or
   "punish leader's ears"? It only affects the *trailing* listener's own mix, never the leader's, so I
   argue it's fair. Validate against `01`/`04` rubber-band guardrails.
4. **Anchor presence-drone fatigue.** A constant low per-crew drone could tire over a long endless run.
   Mitigation: very quiet, ducks to near-zero during calm CLIMB, swells only as the Anchor drifts or is
   imperilled. Needs a fatigue playtest; may gate behind an accessibility toggle.
5. **AoI = Anchor (pillar 12) vs hearing distant drama.** Audio AoI should match netcode AoI (you can't
   sound what you don't simulate). But lead-change and rival-Anchor-thrown are *match-global* meta
   events with no spatial detail beyond a pan hint — confirm `05` surfaces enough committed global
   standing data (cheap: it's already the win-condition table) to fire these without expanding sim AoI.
6. **Determinism of view-RNG.** The walled audio RNG must be seeded so two clients *can* differ (no
   desync) yet one client's replays are stable. Confirm with `05` that nothing in this RNG path leaks
   into the sim PRNG or check-frame hashes (bible pillar 12: hash CHECK-FRAMES, COMMIT-REVEAL inputs).

---

## 10. Build order (de-risk first)

1. **Bus graph + master limiter + Anchor B0 sidechain/tunnel** (§3) — the legibility backbone. Prove
   the Anchor cuts through a synthetic 24-voice chaos test.
2. **Four verb SFX + mass-hierarchy variants** (§6.1) — the readability contract; blindfold-test it.
3. **AudioDirector snapshot-diff + speculative/committed model** (§6.3, §8.3) — wire to the rollback
   sim; verify rollback cancels scheduled cues without audible scrub. Do this alongside the bible's
   named grab/throw determinism spike (pillar 12).
4. **Adaptive music: intensity → 3-state layers, tick-derived tempo** (§5).
5. **The two big stingers: Anchor-thrown + lead-change** (§5.3) — the genre's signature beats.
6. **Hazard TELL-FIRE-TAIL deterministic scheduling** (§6.4) and **coalescence bed** (§7).
7. Roles, ambience banding, recall beacon, polish, accessibility toggles.
