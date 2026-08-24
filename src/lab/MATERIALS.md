# Materials — how a lab asset gets its look

AUTHORITATIVE for coloring and surfacing. It supersedes the older "theme / retexture /
palette-role" approach (the deleted `themes.ts`, the residual `retexture.ts`). The game renderer
(`src/render/dungeon.ts`) colors through this engine too. When anything disagrees, this file wins.

The pipeline, in order: **swatch → preset → texture+surface → profile → frozen on approval.**

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

Both sources carry a **tint** swatch (`?keytint=` / `?torchtint=`), because a material is a
response to a light and judging one under a neutral studio white is judging it under conditions
it will never ship in — the game mixes a cool key + hemisphere with warm torch points, which is
exactly the warm/cool split docs/06 asks for ("cool desaturated neutrals, plus one warm
resolved-and-lit accent"). The same stone reads as sandstone under a sodium key and as basalt
under a blue one, with no change to the material at all.

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

### Per-GROUP variation: same material, a different stone ([group-anchors.ts](group-anchors.ts))

World-space projection is what makes a wall's masonry continue across the panel beside it. On a
floor of octagonal pavers the same property is the bug: the pavers sit on a lattice commensurate
with the texture's repeat, so every paver in the tower shows the same patch of stone at the same
offset. Eighteen thousand identical stones read as **wallpaper**, not as masonry.

The fix is one rule:

```
phase = hash(anchor)        anchor = the group's area-weighted centroid, in WORLD space
```

**Same anchor -> coordinated; different anchor -> differentiated.** That covers both directions at
once, and it needs no per-instance state: the anchor is baked per VERTEX in OBJECT space
(`aGroupAnchor`, vec4) and carried to world space by `modelMatrix` in the vertex shader, so two
placements of one tile in two different cells land on two different world anchors and differentiate
themselves. A group is the carve-mode facet at 75° — one paver, one protruding brick — or a
hand-saved region that overrides it (SURFACES.md).

- **A per-instance UNIFORM was rejected.** It would force a material per instance, and that is
  precisely the regression the shared `customProgramCacheKey` exists to prevent. Measured after:
  **8 programs** on the contact sheet and **1 shader carrying `uTexArr`** in the game — the same
  numbers as before, because every material still emits byte-identical source and differs only in
  uniform values. If you ever make the SOURCE depend on the material, extend the key (tiling.ts).
- **The varying is `flat`.** The anchor is constant across a group, so a smooth varying returns
  *almost* the same value per fragment — and a hash turns 1e-7 into a different phase, which makes
  every triangle of a paver its own stone.
- **A rotation turns the tangent frame with it.** `cross(cT-sB, sT+cB) == cross(T,B)` for every
  angle, so handedness survives and relief stays registered to the albedo. Verified with the
  `calibration` texture: at `?vary=0` every paver's arrow points the same way (the old continuous
  slab); at full strength each paver has its own quarter turn and the glyphs still light as RIDGES,
  which they would not if T/B had stayed put.

**Permission lives on the TEXTURE** (`TextureOption.vary`), because "may this rotate" is a fact
about the material: `none` | `shift` (default) | `shift+rotate`. `shift+rotate` uses QUARTER turns —
90° maps a square-repeating texture's lattice onto itself, so the tiling stays seamless and joints
stay orthogonal to the world; a free angle differentiates more and looks like a mistake instantly.
Which textures get it was decided by looking at the albedos side by side, not by taste: masonry and
brick are laid in horizontal COURSES and a quarter turn stands them on end (rendered, that reads as
vertical streaking — a stringier material, not a second stone), worn iron's rust runs downhill, and
plank grain has a direction by definition. Concrete, marble and cobbles turn freely. A saved group
may override its type (`SurfaceGroup.vary`, the per-row dropdown in the SURFACES panel).

**Strength is a dial, not a boolean** — `Vary` in the panel, `?vary=0..100`, and the game honours it
too. At **0** the shader emits exactly the projection it did before groups existed, so "did this
change anything else" is one screenshot pair rather than a rebuild. It defaults to full.

**NOT done, deliberately: coordination ACROSS meshes.** Four tiles' corner pieces meeting to form
one diamond stay four groups with four phases. `cell-tower.ts` collapses aligned 2x2 blocks of
matching floor into a single natively-4u mesh — ~18,000 of 26,000 meshes — conditionally and
data-dependently, so anything keyed on per-tile seam points produces a visible discontinuity exactly
at the merged/unmerged boundary. A group is always wholly inside one mesh, which is why this half is
safe and that half is not.

**The known trade, so nobody rediscovers it as a bug:** a facet that spans a whole mesh face — the
flat front of a wall panel — now shifts relative to the panel butted against it, because they are
different meshes with different anchors. On a paver that discontinuity IS the feature; on a long
wall run it is a change. The levers are the per-texture `vary` (set a texture to `none` and its
surfaces go back to one continuous slab) and the strength dial.

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

## Reaching the GAME, not just the lab

`src/render/dungeon.ts` colours the tower through the same `applyRecolor`, so the shader is shared
by construction. Two things have to hold for it to actually arrive, and BOTH failed silently until
they were measured:

1. **The arrays must exist before the first recolor.** `patchTilingDetail` returns early, without a
   warning, when `ensureTilingTextures()` has not run. The lab always awaited it (world-object.ts,
   alongside the GLB load); the game never did, so the tower rendered flat baked colour — no grain,
   no relief, no roughness, no AO — and nothing errored.
2. **A cloned material must keep its patch.** `THREE.Material.copy()` copies a fixed property list
   that does NOT include `onBeforeCompile` or `customProgramCacheKey`, so a plain `.clone()` drops
   the shader and falls back to stock MeshStandardMaterial. The renderer clones every placed unit
   (so the occlusion cutaway can fade one piece alone), which meant the whole dungeon rendered
   untiled while the templates it cloned from were patched correctly. Use `cloneMaterial()` from
   tiling.ts anywhere a recolored material is copied.

**Neither is visible in a screenshot you did not already have a baseline for**, which is why the
check is mechanical rather than visual. Hook `WebGL2RenderingContext.prototype.shaderSource` and
count how many compiled shaders contain `uTexArr`:

```
lab   —  8 shaders,  2 with uTexArr     (control: known good)
game  — 48 shaders,  0 with uTexArr     before
game  — 48 shaders,  1 with uTexArr     after
```

One is the correct number for the game: the shared cache key means every recolored material in the
scene resolves to a single program. If that count is ever 0, the tower is not tiled no matter what
the lab looks like.

## `?tex=` is a DELTA on `?profile=`, not an alternative

The lab writes both to the URL, so a link means "this profile, with these overrides on top". The
profile store loads over fetch, so its `setConfig` lands AFTER the initial `configFromParam` — and
rebuilding from `DEFAULT_CONFIG` at that moment discards every type the link did not name.

`overlayConfigParam` exists for that second pass: it writes the URL deltas onto the LIVE config
rather than onto the defaults, and the profile bar’s `onApplied` calls it. Without it a shared or
screenshotted `?tex=` link silently renders something other than what it says — which defeats the
only reason the surface state round-trips through the URL. It cost two verification passes that
appeared to do nothing before anyone noticed the parameter was being dropped.

## The relief calibration texture

`calibration` in the texture library is a measuring stick, not art: an UP arrow and the word UP on a
known height profile. Point any preset at it and the surface answers three questions at once —
is the pattern upright, is it mirrored, and does a ridge light as a ridge. Orientation bugs in a
world-space projection are otherwise nearly invisible on rough stone and obvious only on sharp
features, which is how an inverted normal survived several rounds of looking at it.

Two orientation fixes live behind it, and they are INDEPENDENT — both were needed:

| fix | scope | what was wrong |
|---|---|---|
| array upload flip | global | `DataArrayTexture` hard-sets `flipY = false`, so a canvas read put V=0 at the TOP and every normal map ran upside-down against the convention it was authored for |
| mirror U on a left-handed frame | per face | box-planar hands the front and back of a wall the SAME uv with opposite normals; the frame is left-handed on one of them |

Mirror **U**, never V. Either restores handedness, but seeing a surface from the other side is a
horizontal mirror — flipping V corrects the lighting and stands the texture on its head.
