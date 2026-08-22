# Lab asset coloring — the RECOLOR system

This is the **authoritative** guide for how lab assets get their colors/materials. It supersedes
the older "theme / retexture / palette-role" approach (the now-deleted `themes.ts` and the residual
`retexture.ts` / `materials.ts` — see **Legacy** below). The game renderer (`src/render/dungeon.ts`)
also colors via this engine now. When anything disagrees with this file, **this file wins.**

## The one idea

KayKit models carry no real textures. Every triangle is UV-mapped onto a shared **atlas** of ~27
flat color **swatches** (one block of the grid image = one swatch: a grey, a brown, a gold…).
Each swatch is a soft **light→dark gradient** that KayKit uses to bake cheap shading — a model's
"lit" faces point at the top of a swatch, its shadowed faces at the bottom.

So coloring an asset = **decide what each swatch should become**, then recolor while **keeping the
baked gradient as shading**. We do it **per pixel, in one shader** ([recolor.ts](recolor.ts)):

```
for each pixel:
   sample its atlas color
     → nearest SWATCH                       (which color family)
     → SHADE = pixel luminance ÷ swatch reference luminance   (the baked gradient)
   output = swatch's mapped TINT × SHADE,  with the swatch's surface (roughness/metalness)
```

Result: the model keeps its exact silhouette **and** KayKit's baked light/shadow; we only swap the
flat color family for a chosen tint + surface. No geometry splitting, no per-triangle matching, no
coalescence, no tolerance tuning. **A part's look is a pure function of its own color.**

### Real surfaces: tiling textures, relief, roughness, AO ([tiling.ts](tiling.ts))

The bake gives colour + gradient, but it sits on the **atlas UVs**, so it can never show repeating
grain (masonry courses, plank runs) or react to light like a real surface. A world-space shader
patch in [tiling.ts](tiling.ts) adds that on top of the baked material:

```
uTexArr [layer]  = the texture ALBEDO                            (sRGB)
uSurfArr[layer]  = PACKED  R,G = normal.xy   B = roughness RATIO/2   A = ambient occlusion
uShade           = the baked KayKit gradient on its own (per atlas pixel, LINEAR-filtered)
uSlot[13]        = per material TYPE: (layer, 1/scale, 1/meanLuma, colourMode)
```

**Two `sampler2DArray`s hold the whole working set.** The shader indexes them by the SLOT already
baked into `ORM.r`, so there is no branch chain, no per-object sampler budget, and no cap on how
many distinct textures an object may wear. (The previous version bound one `sampler2D` per texture
plus a second for its normal map, so relief silently switched itself OFF past 5 distinct textures
and every object had to thread a `present` preset set through the bake just to stay under the
16-sampler floor. Both of those are gone.) The arrays are built from the textures the CURRENT
config references — typically ~8 layers at 1024² ≈ 86 MB — and rebuild only when that set changes.
`?texres=512|1024|2048` overrides the layer size.

**What makes light catch it:**

| channel | effect | note |
|---|---|---|
| normal | real per-texel slopes | world-space planar tangent basis; KayKit faces are axis-aligned, so no mesh tangents needed |

| roughness | specular breakup | stored as a RATIO around 1 (mean-normalised at bake), so the TYPE keeps its authored roughness as the average and the map only adds variation |
| AO | crevice darkening | multiplies **indirect** light only, so the key light still models the form |

**Tangent handedness is not optional.** A tangent-space normal map is defined with
`cross(T, B) == the OUTWARD normal`. Picking the projection plane from `abs(normal)` alone ignores
which WAY a face points, and then `cross(T,B)` comes out as `-Y` / `-X` / `+Z` for the three cases —
so every up-facing surface, and every face on the negative side of its axis, gets a mirrored frame
and its bumps light as DENTS. `planarFrame` flips `B` (and V with it, so grain and relief stay
registered) whenever the frame comes out left-handed. Ground truth for eyeballing it: brick mortar
is recessed and the KayKit mesh has its own protruding bricks — the painted courses and the real
geometry must agree about where the light is.

The **Relief** and **AO** sliders (global, `?relief=` / `?ao=`) drive strength. Relief defaults to
**0.45** — enough to read as carved stone, short of the noise that starts competing with silhouette
past ~0.6 (docs/06: bold forms over photo-texture). The panel also carries **Light ∠ / Light ↑**
(`?rake=az:el`), which move the studio key light: a normal map shows nothing under a flat frontal
key, so being able to rake the light is what makes relief judgeable at all.

**It composes with every light in the scene, including the game’s.** The perturbed normal is
written into three’s `normal` *before* the `lights_fragment_*` chunks, so directional, hemisphere,
IBL and POINT lights all use it — the game’s torches (`dungeon.ts`: up to `MAX_TORCH_LIGHTS`
orange `PointLight`s, decay 2) rake the grain for free. The lab has a **Torch** slider (`?torch=`)
that adds the same light so dungeon materials can be judged the way they will actually be lit.
Two caveats worth knowing: relief only reads under **grazing** light (a light hitting a face
head-on sits at the flat top of the cosine and reveals almost nothing — which is why the torch is
parked beside the object rather than in front of it), and a normal map does **not** self-shadow,
so relief cannot occlude itself. That needs parallax occlusion, which is the next rung up.

**Cost.** Per textured fragment: 3 texture fetches (albedo array, surface array, shade map) plus
the slot read, no branch chain. Program count is the number worth watching, and it is now FLAT:
every recolored material emits byte-identical source, so they share ONE compiled program.
Measured on the contact sheet, `linkProgram` calls stay at **8 whether the page shows 1 object or
14** — before the shared cache key it was 5 / 8 / 18, i.e. one shader compile per object, a
load-time hitch that grew with the asset set. Array build is a one-off ~2-4 s of CPU (canvas
decode + channel packing) for 8 layers at 1024², and only reruns when the config’s texture set
changes. `npm run` nothing — measure with a WebGL-level probe, not `renderer.info`, if you change
this: the headless GL here is SwiftShader, so absolute frame times are meaningless and only
counts (programs, draws, fetches) transfer.

**Colour mode** (per TextureOption, `color:`):

- `grain` (default) — LUMINANCE only, normalised to mean 1 and multiplied onto the baked tint. The
  texture contributes PATTERN, the swatch keeps the COLOUR, so any texture sits on any type
  predictably. Right for masonry, concrete, brushed metal.
- `albedo` — the texture’s OWN colour, re-shaded by `uShade` (the baked KayKit gradient, extracted
  at bake time as `pixelL / swatchRefL`). For scanned materials where the colour variation IS the
  asset — the Poly Haven woods — because a luminance-only read throws exactly that away.

**The texture per type is a live CHOICE, not hard-wired.** [texture-catalog.ts](texture-catalog.ts)
is the library (`TEXTURES`) plus the per-type config (`DEFAULT_CONFIG`) and a compact URL codec;
[texture-settings.ts](texture-settings.ts) is the in-app menu (object mode). A change re-bakes live
and persists to `?tex=stone:masonry:95:0,…` (shareable / screenshottable). `Reset` restores defaults.

**Sources.** ambientCG (CC0) for the original set, Poly Haven (CC0) for the wood scans. Poly Haven
publishes each asset’s real-world `dimensions`, which IS our `scale` (metres per repeat) — no
guessing. Its packed `arm` map (R=AO, G=rough, B=metal) covers two of our channels in one file.

**Tileability is checked, not assumed.** `npm run tex:seams` compares the wrap-seam pixel delta to
the image’s own interior gradient; ratio ≈1 = seamless, >2 = a visible line every repeat. This is
how `wood_diff.jpg` (the old `planks` default) was caught at **9.8×** — it had been laying a hard
seam across every planked object. It is kept in the library only so old `?tex=` URLs resolve;
`wood`/`grained` now default to verified Poly Haven scans. Run it on any texture before adding it.
`npm run tex:tile <file...>` renders a 3×3 tiling if you want to see a seam rather than score it.

To add a texture: drop the files in `public/textures/`, add a `TEXTURES` entry (id + label + group +
`diff` + `scale`, plus `nor` / `arm` / `rough` / `ao` / `color` as available), run `npm run tex:seams`,
done — it shows up in every type’s dropdown.

## Profiles: naming a look, and sharing it ([material-profiles.ts](material-profiles.ts))

The per-type config above is ONE live config. That is enough to tune a look and not enough to keep
one — there was no way to name it, save it, diff two of them, or have a second. The only
persistence was a `?tex=` query string.

A **profile** is a named, git-tracked set of per-type overrides, stored in
[material-profiles.json](material-profiles.json) and edited from the PROFILE bar at the top of
TEXTURE SETTINGS ([profile-bar.ts](profile-bar.ts)):

```jsonc
"dungeon-default": { "label": "Dungeon (default)" },          // the house look
"timber-hall":     { "label": "Timber hall",
                     "extends": "dungeon-default",            // <- the sharing mechanism
                     "types": { "stone": { "texture": "brick" },
                                "wood":  { "texture": "rough-planks" } } }
```

- **`extends` is how a look is shared.** A variant names only its deltas, so editing the base moves
  every profile that inherits from it. `Save as variant` runs `captureDelta`, which diffs the LIVE
  state against the parent and writes only the difference — a variant can never silently freeze a
  full copy of its parent and stop tracking it.
- **The 4-layer swatch cascade below is untouched.** It still decides which material TYPE a given
  swatch asks for; a profile only swaps the answer table underneath it. Two orthogonal axes:
  cascade = *which type*, profile = *what that type is made of*.
- **`rev` is a content hash** (FNV-1a over the resolved values). Two profiles that resolve the same
  share a rev; an edited profile gets a new one. Nobody has to remember to bump a version.
- Cycles and unknown parents warn and degrade to a shorter chain — a broken profile still renders
  something you can look at and fix.
- Written through `POST /__lab/profiles` (dev middleware, vite.config.ts), key-sorted, so a look
  change reviews as a readable diff instead of living in someone’s URL.

### Approval linkage — which objects have fallen behind

Approving still freezes a COPY of the resolved materials (that is what keeps the game stable while
the lab is being retuned), but the entry now also records `materials.profile = { id, rev }`. So:

```
approvedProfile(id)     the profile ref an object was approved under
staleAgainst(rev)       approved ids whose frozen materials do NOT match rev
```

`rev` is the **live** rev at approval time, not the profile’s — if the reviewer had drifted off the
profile before approving, the store records the drift, because that is what was actually frozen.
Entries approved before profiles existed have no ref and count as stale: their look is unknown,
not known-current.

## The CONTACT SHEET — `npm run sheet` ([sheet.ts](sheet.ts))

The lab shows one object at a time, which is right for approving a footprint and wrong for judging
a material: you tune stone on a wall, it looks great, and three objects later it has wrecked the
barrels. Every material decision is a decision about the whole SET.

`/ascent/sheet.html` renders every object on one grid under the current profile, with the same
PROFILE + TEXTURE SETTINGS panel. Change a texture and they all re-bake together — affordable
precisely because [tiling.ts](tiling.ts) shares materials across objects, so N objects cost one
array build, not N.

| param | effect |
|---|---|
| *(default)* | the approved store — the set that actually ships |
| `?pack=<id>` | a whole KayKit pack (`dungeon_remastered`, `furniture`, …) |
| `?ids=a,b,c` | an explicit list |
| `?limit=<n>` `?cols=<n>` | cap the grid (default 48) / override the column count |

Cells are badged **current / behind / not approved** against the live rev, and the HUD totals them,
so staleness is something you SEE rather than something you have to remember to ask about. The
camera is ORTHOGRAPHIC front-3/4: every cell is framed identically (a perspective camera would
foreshorten the far rows and you would be comparing materials at different apparent scales), and
rows are spaced 1.75x deeper than they are wide so the front row does not stand in front of the one
behind it.

**Not yet built: bulk re-approve from the sheet.** It is the obvious next button, but the sheet
normalises each object’s scale into its cell, which would corrupt the footprint if approval read
the placed root. Capture the build BEFORE `place()` scales it, or it will write wrong boxes.

## Hop 1: swatch → PRESET is a 4-layer cascade (most-specific wins)

A **preset** is the in-between abstraction (the "type"): a clean 1:1 to a texture + surface. To add a
distinction we add ANOTHER preset (`wood`=planks vs `grained`=dark wood, `stone`=masonry vs
`smoothstone`), **never** a context-conditional texture on one preset. Context lives ONLY here, in
which preset a swatch resolves to. For any (object, swatch) there is exactly one result:

```
④ OBJECT override   by file token (bed_decorated, sword_shield)        ← rare, pinpoint fixes
③ CATEGORY override by grouping (Structure="architecture", Furniture)  ← context: same swatch, diff preset
② FOLDER override   by pack folder (kaykit_dungeon, …)                 ← whole-pack tuning
① BASE              role → preset (ROLE_PRESET), tint = the swatch's OWN color
```

- **① Base keeps colors.** It only assigns a *preset* and lets the gradient shade it. Most objects
  need **no override** — the dungeon looks like itself with believable materials.
- **② Folder** tunes a whole pack. Empty for the dungeon (the base is tuned for it).
- **③ Category** resolves CONTEXT: the SAME swatch becomes a different preset by object grouping
  (`object-category.ts`). `ironGrey` is wall **stone** in *Structure* but **dark iron** in *Furniture*;
  the cool dark greys (`darkSteel`/`stoneDark`) are **smoothstone** plinths in *Structure*; architectural
  wood is **grained**. It only ever picks a preset — Hop 2 (preset→texture) stays 1:1.
- **④ Object** is the last escape hatch for one object where a shared swatch is unusual — the grey
  that's **bedding** on a bed, **iron** on a blade. Explicit data, not a heuristic.

## How to tune (the common tasks)

- **Pick a texture / surface per type** → use the in-app **TEXTURE SETTINGS** menu (live), or edit
  `DEFAULT_CONFIG` in [texture-catalog.ts](texture-catalog.ts) for the out-of-the-box defaults.
- **Change which preset a swatch role gets** → `ROLE_PRESET` in [recolor.ts](recolor.ts) (e.g.
  default the `orange` swatch to `wood` instead of `terracotta`).
- **Fix one pack** → add an entry to `FOLDER_OVERRIDES['kaykit_<pack>']` (recolor.ts) with `roles`
  and/or `swatches`.
- **Fix one object** → add an entry to `OBJECT_OVERRIDES['<file_token>']` (recolor.ts). `roles`
  recolors a whole family (`{stone:'cloth'}` = every grey on this object becomes cloth); `swatches`
  pinpoints one.
- **Add a texture option** → drop files in `public/textures/`, add a `TEXTURES` entry in
  texture-catalog.ts (it appears in every type's dropdown).
- **Add a new material type (preset)** → add it to `Preset` + `CONFIGURABLE_PRESETS` + `DEFAULT_CONFIG`
  (texture-catalog.ts), `PRESET_SLOT` + `ROLE_PRESET` (recolor.ts), and `TYPE_LABEL`
  (texture-settings.ts + recolor-legend.ts).

Priorities we tune in order: **the bed first** (its greys are bedding → cloth; its frame stays
wood), then **architecture** (the earth/stone swatches for walls/pillars/floors).

## Publishing approved assets (lab → game)

The lab auto-fits collision boxes and resolves materials LIVE; nothing reaches the game until a
reviewer **approves** it. The publish step freezes the current object's footprint + materials into a
git-tracked store:

```
auto-fit (box-fit, edge density auto-targets ≥95% fill) + recolor
  → reviewer clicks "✓ Approve & save" (bottom controls bar)
  → POST /__lab/approve   (dev middleware, vite.config.ts)
  → src/game/approved-assets.json    (pretty-printed, key-sorted — clean diffs)
  → game reads it via src/game/approved-assets.ts (getApprovedFootprint / getApproved / isApproved)
```

- **Box-fit auto edge density** (FIT CONTROLS → "auto edge density", default ON): scans edge-density
  low→high and picks the LOWEST that reaches ~95% fill (loosest box set that still hugs that tight).
  The chosen value shows in the HUD (`ed 70%`). Uncheck for the manual slider.
- Each approved entry stores: `footprint.boxes` (object-local metres), `fit` provenance
  (edgeDensity/cell/fill/coverage/boxCount/seedMode), and `materials` (relief + the per-PRESENT-swatch
  recipe: preset + texture + tint + roughness/metalness) — **frozen**, so later config edits don't
  silently change approved objects.
- The middleware is **dev-only** (no prod-build effect). Writing the JSON triggers a vite reload; the
  lab's full state lives in the URL, so it restores and shows the approved status (`✓ Re-approve`).
- **Not yet wired:** the game still needs to CONSUME `getApprovedFootprint` for prop collision (the
  sim is fixed-point, so the boxes need a Fixed conversion at the seam). The store + loader are ready.

## Reference / debugging

- The lab's bottom-right **SWATCH → MATERIAL legend** ([recolor-legend.ts](recolor-legend.ts))
  shows, for the current object, every swatch → its resolved preset+tint, with the swatches the
  model actually uses highlighted ("N of 27 used by this model"). Use it to see exactly what maps
  where and spot anything wrong.
- `npm run probe:palette` ([scripts/palette-probe.mjs](../../scripts/palette-probe.mjs)) samples the
  real GLBs and reports which swatch each triangle lands on — the ground truth behind the swatch
  list in [palette.ts](palette.ts).

## Legacy (do not extend)

- `themes.ts` is **deleted** — the game renderer colors via `recolor.ts` too. `retexture.ts` survives
  only for the `RetextureRule` type (`MeshObjectSpec.variants`, dormant) + the `presentSwatchHexes`
  legend sampler. Don't add new coloring logic there — add it here.
- `materials.ts` is **partly live, not legacy**: the tiling layer reuses its CC0 texture files
  (`public/textures/*`) and its proven world-space box-planar projection ([tiling.ts](tiling.ts)
  re-implements it over texture arrays rather than calling `DungeonMaterials`, to stay the single
  source for lab coloring), and it stays the flame-glow / no-atlas render fallback in `dungeon.ts`.
  Its triplanar blend (3 samples, no hard switch at the dominant axis) is the one thing tiling.ts
  does NOT yet port — box-planar is exact for axis-aligned KayKit faces and cheaper.
```
