# Lab asset coloring — the RECOLOR system

This is the **authoritative** guide for how lab assets get their colors/materials. It supersedes
the older "theme / retexture / palette-role" approach described in `themes.ts`, `retexture.ts`,
and `materials.ts` (those remain only for the game renderer `src/render/dungeon.ts` and for the
`RetextureRule` variant type — see **Legacy** below). When they disagree with this file, **this
file wins.**

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

## The mapping is a 3-layer cascade (most-specific wins)

This is the "authoritative path" — for any (object, swatch) there is exactly one result:

```
③ OBJECT override   by file token (bed_decorated, sword_shield)   ← rare, pinpoint fixes
② FOLDER override   by pack folder (kaykit_dungeon, …)            ← the main tuning layer
① BASE              role → surface preset, tint = the swatch's OWN color
```

- **① Base keeps colors.** It only assigns a *surface* (stone is rough, gold is metallic) and lets
  the gradient shade it. So most objects need **no override at all** — the dungeon looks like itself,
  just with believable materials. This is the goal: a base so good we barely remap.
- **② Folder** is where you tune a whole pack. Empty for the dungeon (the base is tuned for it);
  other packs ship their own atlas and refine here.
- **③ Object** is the escape hatch for the handful of objects where a *shared* swatch means
  something unusual — the grey that's masonry on a wall but **bedding** on a bed, or **iron** on a
  blade. This is the ONLY place that ambiguity is resolved, and it's explicit data, not a heuristic.

## How to tune (the common tasks)

All edits are in [recolor.ts](recolor.ts):

- **Change a surface globally** → edit `SURFACE` (e.g. make stone rougher) or `ROLE_PRESET` (e.g.
  default the `orange` swatch to `wood` instead of `terracotta`).
- **Fix one pack** → add an entry to `FOLDER_OVERRIDES['kaykit_<pack>']` with `roles` and/or
  `swatches`.
- **Fix one object** → add an entry to `OBJECT_OVERRIDES['<file_token>']`. `roles` recolors a whole
  family (`{stone:'cloth'}` = every grey on this object becomes cloth); `swatches` pinpoints one.
- **Add a surface** → add a `Preset` + its `SURFACE` entry (roughness/metalness).

Priorities we tune in order: **the bed first** (its greys are bedding → cloth; its frame stays
wood), then **architecture** (the earth/stone swatches for walls/pillars/floors).

## Reference / debugging

- The lab's bottom-right **SWATCH → MATERIAL legend** ([recolor-legend.ts](recolor-legend.ts))
  shows, for the current object, every swatch → its resolved preset+tint, with the swatches the
  model actually uses highlighted ("N of 27 used by this model"). Use it to see exactly what maps
  where and spot anything wrong.
- `npm run probe:palette` ([scripts/palette-probe.mjs](../../scripts/palette-probe.mjs)) samples the
  real GLBs and reports which swatch each triangle lands on — the ground truth behind the swatch
  list in [palette.ts](palette.ts).

## Legacy (do not extend)

- `themes.ts`, `retexture.ts`, `materials.ts` are the **old** lab approach (palette roles → tiling
  PBR via per-triangle retexture + coalescence + name-regex exceptions). The lab no longer uses
  them for rendering. They stay because: `src/render/dungeon.ts` (the game) still colors via
  `themes.ts` (migrating the game to recolor.ts is a future task), and `MeshObjectSpec.variants`
  still types its rules as `RetextureRule`. Don't add new coloring logic there — add it here.
```
