# Audit v2 — SPECTACLE & AUDIO (docs 06, 08, 00 pillar 7)

Audited against current source (June 2026). Every claim below was verified by reading the
code as it is now; stale AUDIT.md status was ignored. Read-only audit.

---

### audio-zero — the game is completely silent; the entire audio readability channel is absent
- Severity: **CRITICAL**
- Intent: 08 §0 — "Sound is a HUD." Audio has three ranked jobs: (1) always tell you where your
  Anchor is and how it's doing (pillar 1, bus B0 "highest, never duckable"), (2) make the four
  verbs instantly readable by ear (§6.1 — "a blindfolded experienced player should narrate the
  fight from audio alone"; the GRAB latch is "the single most important SFX"), (3) score the
  climb→flashpoint→resolve swing and the two signature beats (Anchor-thrown stinger, lead
  change). 08 §7 also makes materialization audible (the "crystallize/assemble" sweep matched to
  the visual coalescence stages).
- Reality: ZERO audio exists. A full-repo grep of `src/` for `AudioContext|new Audio|useSound|
  \.mp3|\.ogg|\.wav|\.webm|\.m4a|audio` (case-insensitive) returns no matches; `index.html`
  contains no audio element; there is no `public/` asset dir; `package.json` dependencies are
  only `three` + `peerjs`. No AudioDirector, no buses, no samples, no synthesis, nothing.
- Gap: half of the game's designed readability bandwidth is missing. Grabs, throws, landings,
  struggles, the recall plant, floor materialization, the win — all mute. The Anchor (the game's
  protagonist per pillar 1) has no sonic presence at all. Even as a single-player sandbox, the
  build feels inert and unconfirming: every action lands without acknowledgment.
- Fix sketch: stand up the 08 §10 build order steps 1–2 only: one `AudioContext` (resume on first
  gesture, the Frequency `useSound` pattern), a master limiter, and ~10 synthesized/placeholder
  one-shots driven from the renderer's existing snapshot-diff (`detectEvents`,
  src/render/renderer.ts:484-545 already detects land/throw/grab/rush — it just feeds visuals).
- Minimal load-bearing set per 08 (for the current single-crew build): the four verb signatures
  with the Anchor-mass "CLAMP" variant (§6.1); landing/impact thud by mass; the Anchor lane —
  presence drone, carried loop, grabbed alarm, downed beat, death toll vs thrown-down distinction
  (§6.3, §6.5); recall-beacon plant chime + periodic ping (§6.3); the coalescence materialize
  sweep + emerge "breach/whoosh-up" (§7); a win sting. Multi-crew later adds the two committed-only
  stingers (Anchor-thrown, lead change §5.3) and the 3-state adaptive music (§5.2).

### no-post-stack-no-bloom — zero post-processing; "the soul of the look" is absent
- Severity: **HIGH**
- Intent: 06 §7.2 — a budgeted post stack: **Bloom** ("The soul of the look — emissive
  coalescence, rims, hazards, beacons glow", confidence High), color grade/ACES tonemap + LUT,
  vignette, FXAA; 06 §7.1 an HDR half-float target "so bloom & color-grade behave"; 06 §1.5's
  whole material philosophy is "matte bodies, **emissive intent**… bloom does the heavy lifting."
- Reality: `new THREE.WebGLRenderer({ canvas, antialias: true })` and a direct
  `this.renderer.render(scene, camera)` — src/render/renderer.ts:182 and renderer.ts:472. No
  composer, no `pmndrs/postprocessing` (not in package.json deps), no tone mapping or color-grade
  configuration anywhere (grep for `toneMapping|outputColorSpace|EffectComposer|Bloom` in
  src/render: no matches). Emissive values are set in places (e.g. renderer.ts:679) but with no
  bloom they read as flat tinted pixels, not light.
- Gap: the entire "coalescing architecture in the void / luminous" identity (06 §1.1) cannot
  exist without glow. Amber "lit" floors, the indigo potential wireframe, held/downed emissive
  pulses — all render as slightly-different flat colors. The build reads as a dev grey-box, not
  the spec's tower of light.
- Fix sketch: add `pmndrs/postprocessing` with just BloomEffect (selective threshold) + ACES
  tonemap + vignette in one EffectPass; set the renderer to a half-float target. ~30 lines in the
  Renderer constructor + replacing the final `render()` call.

### coalescence-opacity-fade-not-materialization — the signature reveal is a 2-state opacity crossfade, not dots→lines→panels→lit
- Severity: **HIGH**
- Intent: 06 §2 (THE signature) — four overlapping phases per **tile**: Potential (instanced
  glowing point-sprite dots that breathe), Assembling (vertex "gather" displacement — fragments
  slide/snap inward with elastic overshoot, ignition lines drawing edges), Paneling (dissolve mask
  with a hot white→amber rim tracing the in-fill), Lit (earned sodium-amber). Reveal is a per-tile
  scalar from `distanceToNearestClimber` (§2.1). §2.5: on `FloorCross(up)` a radial porthole
  dissolve + vertical light shaft + crew-color ring pulse ("birth-through-the-membrane").
  00 pillar-7/§4e restates this as the resolved "maximal spectacle within the box."
- Reality: src/render/renderer.ts:639-688 (`updateCoalescence`): one scalar per **stratum band**
  computed from the **Anchor's height only** (`rel = (band.baseY - anchorY + …)/spacing`), driving
  (a) a `LineDashedMaterial` opacity fade on a flat 2D rectangle-outline floor plan
  (renderer.ts:267, 987-996 — deliberately reduced from 3D wire boxes for legibility), and (b) a
  `MeshStandardMaterial` opacity/color lerp on the solid slabs (renderer.ts:669-681). No dots, no
  vertex displacement/snap, no dissolve mask or hot rim, no ignition lines, no shaders at all
  (stock materials only), no FloorCross emergence effect of any kind. Strata 2+ above are simply
  `visible = false` (renderer.ts:683-686). Reveal ignores every climber except the Anchor and has
  no XZ spatial component — a whole floor fades as one unit.
- Gap: the game's one signature visual — "architecture assembling itself out of light just ahead
  of the climbers" — is currently "a translucent floor gets less translucent." Crossing up through
  a floor (the hero moment, explicitly called out in pillar 7) has zero ceremony. Nothing in the
  current look is ownable or memorable.
- Fix sketch: smallest meaningful step, in order of payoff: (1) add the §2.5 emergence beat — on
  the Anchor/local player crossing a band base, spawn the existing pooled ring + a stretched
  additive quad "light shaft" in crew color (the pool infra at renderer.ts:695-737 already
  exists); (2) replace the plan-outline fade with vertex-colored per-tile reveal (distance from
  nearest climber in XZ, not just Anchor Y) so the floor inks in as a wave; (3) the full §2
  TileMaterial state machine is the real fix (06 App-B step 1) and needs custom shaders.

### no-crew-rim-no-anchor-pulse — the "emissive intent" body language is missing
- Severity: **HIGH**
- Intent: 06 §1.5 — every body gets a **crew-color Fresnel rim light** "so allegiance reads from
  any angle, even backlit or in fog" (and §3.1.4: the rim is fog-immune, applied after fog); the
  Anchor gets an **idle emissive heartbeat pulse** (~2 s, locked to `uSimTick`) on a core glyph,
  doubling when downed/vulnerable; a persistent crew-color ground-decal halo.
- Reality: bodies are plain `MeshStandardMaterial` flat lamberts — src/render/character.ts:128-131
  (color/roughness only, no rim term, no custom shader, no onBeforeCompile anywhere in src/render).
  Emissive is a **constant** hex applied only while held (`0x442266`) or downed (`0x551122`) —
  renderer.ts:447-448, consumed at character.ts:270 — there is no pulse, no heartbeat, no
  tick-driven animation of it. The Anchor's importance read is the gold base color + a static gold
  ring + an "ANCHOR" text sprite (renderer.ts:335-340).
- Gap: bodies don't read through fog or against dark floors below; the Anchor reads as "the yellow
  one with a label," not as a living, precious core (pillar 1's "heavy, precious" fantasy). When
  rival crews land, allegiance-at-a-glance will not survive the murk without the fog-immune rim.
- Fix sketch: one `onBeforeCompile` patch on the shared body material adding a Fresnel emissive
  term in crew color (≈10 lines of GLSL), plus making the existing emissive channel pulse with
  `sin(tick·k)` (tick is already passed in `AnimSample.tick`, character.ts:63) at 2× rate when
  `downed`.

### recall-beacon-invisible — the planted Recall Beacon has no visual representation at all
- Severity: **MEDIUM**
- Intent: 06 §1.5.4 — "**Recall Beacon** is a tall crew-color light column planted at the Anchor —
  the single brightest crew-color feature, visible across the shaft (the rally point, pillar 1)";
  contrast law §1.6.6 ranks beacons second-brightest after active hazard strikes. 08 §6.3 gives it
  a plant chime + a ~2 s ping so the crew can hear-find it.
- Reality: the beacon exists in sim/match state only — plant/recall logic at
  src/game/beacon.ts:54-75 writes `cs.beaconX/Y/Z/beaconTick`; a grep for `beacon` across
  src/render returns only comments about the Anchor's gold ring (renderer.ts:18, 335). No mesh,
  column, marker, or HUD element shows where the beacon is. (The gold ring on the Anchor body is
  the Anchor marker, not the planted beacon.)
- Gap: the player presses Q and *nothing visibly happens*; later, recall teleports them to an
  invisible point. A core crew-coordination verb (and respawn target — survival.ts respawns at the
  beacon) is unreadable, and the shaft loses its designed brightest crew-color landmark.
- Fix sketch: on `cs.beaconTick >= 0`, place a pooled additive cylinder/quad column (crew color,
  ~10 u tall) at `beaconX/Y/Z` + reuse `spawnImpact` for the plant moment. ~20 lines in the
  renderer reading `sim.match.crews` (already surfaced to the loop at src/render/loop.ts:76-83).

### hazards-unrendered-and-absent — no hazard visuals exist, and the tower ships zero hazards
- Severity: **MEDIUM**
- Intent: 06 §1.3 reserves the brightest channel for hazards ("hazard-red → white-hot…danger owns
  the brightest reds"); §1.6.5 "Hazards are red and telegraphed in advance"; §7.5 frame-locks the
  windup telegraph to the sim's tick math; §6.3 defines a dedicated `HazardMaterial`. 08 §6.4
  gives every hazard a TELL→FIRE→TAIL envelope.
- Reality: the playable tower is built with `hazards: []` — src/game/scene.ts:179. And even if
  hazards existed, the renderer has no code path to draw them: grep for `hazard` in src/render
  returns no matches (the sandbox's crusher, scene.ts:96-103, would be an invisible force).
- Gap: an entire palette channel (danger-red) and the pillar-3 "deterministic, always telegraphed"
  spectacle/readability system are absent from the playable build. Nothing in the tower threatens,
  glows red, or winds up.
- Fix sketch: add 1–2 crushers per stratum in `buildTower`, and a minimal hazard view: an emissive
  red sphere at the hazard's interpolated position + an opacity ramp keyed to the same
  `(tick + phase) % period` the sim uses (renderer already receives the world each frame).

### floors-below-stack-minimal — depth treatment is a darken-lerp + uniform fog, not the volumetric abyss
- Severity: **MEDIUM**
- Intent: 06 §3.1 — desaturation + value crush, **exponential height fog** tinted cool-indigo
  increasing downward, faked volumetric god-ray shafts ("the abyss breathes"), edge-translucent
  parallax floor planes ("look down the shaft and see history"), fog-immune rival rims; void
  background with a vertical indigo→black gradient (06 §1.3). Floors above hang as visible
  "potential" (pillar 7) — the tower should read as a tower.
- Reality: below-floors get a single color lerp toward near-black (`lerpHex(COLORS.wall, 0x0a0a14,
  depth*0.85)`, renderer.ts:658-664 — a value crush, reasonable start); fog is uniform
  camera-distance `THREE.Fog(0x0a0a12, 30, 70)` (renderer.ts:185), not height-based; background is
  a flat color (renderer.ts:184); no god rays, no translucency below, no gradient. Floors 2+ above
  are fully invisible (renderer.ts:683-686), so the climb never shows "the route resolving above"
  — you see at most one ghost floor.
- Gap: no sense of vertical scale or peril — the abyss below and the potential above (the two
  emotional poles of a climbing game) are both visually absent. Note: hiding higher floors was a
  deliberate legibility fix (renderer.ts:981-986 documents the player feedback), and 06 §10.1 says
  readability wins — but the spec's legible answer was faint *dots*, not nothing.
- Fix sketch: (1) a large vertical-gradient background quad or `scene.background` via a tiny
  canvas gradient; (2) swap to `THREE.FogExp2` + darken slabs by world-Y (already have baseY per
  band); (3) re-show strata +2/+3 as ultra-faint dot/point sprites at band corners (a dozen
  `THREE.Points`, nearly free, restores "the tower continues upward").

### particles-minimal — one generic puff covers every event; no verb-specific spectacle
- Severity: **MEDIUM**
- Intent: 06 §4 — each verb gets an unmistakable tell: RUSH speed-lines + crew-tinted afterimages,
  GRAB snap-connect arc + grab-ring clamp, THROW muzzle burst + crew-tinted streak trail, STRUGGLE
  escalating strain shards + snap-release pop, fall motion-streak trails (§3.2), all through a
  priority/budget particle manager (§5).
- Reality: a single pooled effect — expanding ring + 10 dust points (renderer.ts:695-719,
  pool of 24) — is reused for landings, throws, grabs, and rush starts, differing only in color/
  size (renderer.ts:506, 525, 532, 538). Verb overlays are a plain leash line, a single magenta
  struggle dot, and the dashed aim-arc (renderer.ts:765-786). No trails, afterimages, shards,
  rings-on-grab, or any instanced particle system; the fxGroup also allocates + disposes fresh
  line/sphere geometry every frame (renderer.ts:426-429, 952-958), against 06 §8's no-hot-loop-
  allocation rule.
- Gap: every verb feels the same weight; throws (the headline physical verb) leave no arc through
  the air; brawl moments will read as overlapping identical puffs.
- Fix sketch: extend the existing pool pattern with two more archetypes — a short-lived stretched
  quad trail (throw/fall streak, crew-tinted) and a 2-3 ghost-quad dash afterimage — and persist
  the leash/arc objects instead of rebuilding per frame.

### earned-warmth-leak — amber appears on floors that are still translucent ghosts
- Severity: **LOW**
- Intent: 06 §1.3/§2.4/§10.5 — sodium-amber is *earned*: it appears **only** on fully resolved
  (`reveal ≥ 0.9`), lit, walkable surfaces, "so warmth literally reads as 'this is solid ground
  you can trust.'"
- Reality: the floor above lerps its color and emissive toward `COLORS.lit` continuously from
  reveal 0 (`lit = reveal²`, color/emissive set at renderer.ts:671-679) while still at opacity
  0.02–0.6 — i.e. warm tint on ground that is explicitly not yet "yours."
- Gap: minor today (no bloom, single crew), but it erodes the one color semantic the art bible
  calls non-negotiable before the real materializer lands.
- Fix sketch: gate the amber ramp behind `reveal > 0.9` (`lit = smoothstep(0.9, 1.0, reveal)`),
  keeping the approach phase cool.

### perf-per-box-meshes — per-AABB meshes + per-box materials: fine at this scale, a dead end for the real tower
- Severity: **LOW**
- Intent: 06 §5/§6/§8 — instanced tiles sharing one über-`TileMaterial`, ≤250 draw calls in the
  worst case, far strata collapsed to impostors; an endless tower must have bounded render cost.
- Reality: every terrain AABB becomes its own `THREE.Mesh` with its own unique
  `MeshStandardMaterial` (renderer.ts:256-263). The 5-stratum tower is 5×25 slabs + seam lips + 1
  deep slab ≈ ~200+ meshes/materials; with strata 2+ hidden by coalescence, visible terrain draws
  are ~100, plus ~10 meshes per stubby character × 4 bodies + 8 throwables + the 48-object impact
  pool — comfortably OK for today's scene (likely 150-250 visible draws), so this is NOT a current
  perf bug. But the approach scales linearly with strata and materials can't batch, so it cannot
  reach the spec's endless tower or 4-crew scene within budget.
- Fix sketch: when the floor window grows, switch slabs to one `InstancedMesh` per band (or merged
  geometry per band) with per-instance color; materials per band (the tint loop at
  renderer.ts:660-680 is already per-band) rather than per box.

---

**Dimension verdict:**
The palette skeleton is honestly faithful (crew hexes, indigo/amber, near-black void, 1-key+ambient
lighting all match 06), but everything that makes 06 *spectacle* — bloom, the materialization state
machine, emissive rims, beacons, particles — is absent, leaving a legible grey-box; and audio is not
degraded but nonexistent: the build delivers zero of 08's three jobs, making sound the single
largest intent gap in the entire experience.
