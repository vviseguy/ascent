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

### Real tiling textures + the per-type settings menu

The bake gives color + gradient, but it's on the **atlas UVs**, so it can't show repeating grain
(masonry, planks, metal). So a **small world-space shader** (`patchTilingDetail` in
[recolor.ts](recolor.ts)) adds the real texture on top:

```
ORM map  = baked per-pixel:  R = tiling SLOT (per material TYPE / preset),  G = roughness,  B = metalness
shader   = sample the slot's chosen texture in WORLD space (box-planar UV, physical scale)
         → take its LUMINANCE × (1/mean)  (averages to 1)  → MULTIPLY onto the baked albedo
result   = baked color × gradient × tiling PATTERN    (pattern only; the type's tint keeps the colour)
```

- **The texture per type is a live CHOICE, not hard-wired.** [texture-catalog.ts](texture-catalog.ts)
  is the library (`TEXTURES`: masonry, brick, concrete, marble, cobble, planks, dark-wood, brushed
  steel, worn/dark iron, linen, …) **plus** the per-type config (`DEFAULT_CONFIG`: which texture +
  roughness + metalness each preset wears) and a compact URL codec.
- **The in-app menu** ([texture-settings.ts](texture-settings.ts), object mode) lets you pick the
  texture and tune roughness/metalness per type. A change re-bakes the object live and persists to
  `?tex=stone:masonry:95:0,…` (shareable / screenshottable). `Reset` restores `DEFAULT_CONFIG`.
- Grain is **luminance only** (a scalar pattern), so the type's tint owns the colour and ANY texture
  can sit on ANY type predictably. It's **world-space** (not atlas UVs) so the tile size is physical
  and never stretches — the proven `materials.ts` approach, driven by the config.
- `PRESET_SLOT` gives each type a fixed slot baked into ORM.r; the shader only emits a branch for the
  slots whose config texture isn't flat. The ORM map is `NearestFilter` (slot/rough/metal are
  per-swatch **constants** — linear filtering would average a slot at a seam into a wrong texture).
  Tiling textures load as **sRGB** (decode to linear) so the multiply is in the right space; the
  normalising mean is **computed** from each image (no magic numbers).
- **Metals need reflections.** [lab.ts](lab.ts) adds an IBL `RoomEnvironment` (`scene.environment`):
  metalness is a reflection property, so without an env a metal goes dark/flat grey and reads as
  stone. With it (+ a brushed-steel texture + high metalness) metal reads as metal.
- **RELIEF (normal maps).** The global **Relief** slider (`getRelief`, URL `?relief=`) turns on real
  normal-map bump: each used texture's `*_nor.jpg` is sampled in world space and applied via a planar
  tangent basis (KayKit faces are axis-aligned, so no mesh tangents needed) → clean grooves/depth, no
  derivative-bump noise. To keep diff+nor under the 16-sampler floor, the bake binds textures only for
  the presets THIS object uses (`present` set → `patchTilingDetail`); past 5 distinct textures relief
  auto-drops for that object (logged). Relief 0 (default) = albedo grain only, no extra samplers.
- This is the **only** custom shader; color/gradient/surface stay a plain CPU bake.

To add a texture: drop the files in `public/textures/`, add a `TEXTURES` entry (id + label + group +
`diff` + `scale`), done — it shows up in every type's dropdown.

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
- `materials.ts` is **partly live, not legacy**: the recolor tiling layer reuses its CC0 texture files
  (`public/textures/*_diff.jpg`) and its proven world-space box-planar projection (recolor
  re-implements the simpler albedo-only tiling in `patchTilingDetail` rather than calling
  `DungeonMaterials`, to stay the single source for lab coloring), and it stays the flame-glow /
  no-atlas render fallback in `dungeon.ts`.
```
