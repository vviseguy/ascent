# `src/lab` — the Asset Lab

An authoring environment, not a shipped surface. It exists so a human can LOOK at an asset and
decide something about it: what it is made of, how it responds to light, which faces should not be
there, and whether it is good enough to publish. The game then consumes the frozen decisions.

**Everything here is VIEW-layer.** Floats, `Math.random`, classes and mutable module state are all
fine. Nothing in this folder may be imported by `src/sim/`, and nothing here may feed back into it —
see the root [CLAUDE.md](../../CLAUDE.md) determinism rule. The one thing that crosses the line is
*data*: `src/game/approved-assets.json` and `src/game/mesh-surfaces.json` are written here and read
by the game.

## The deep docs — read the one that matches what you are changing

| doc | covers |
|---|---|
| [MATERIALS.md](MATERIALS.md) | **Authoritative for colour and surface.** The swatch→preset cascade, the texture-array tiling layer (relief / roughness / AO / colour modes), named material profiles, and the approval freeze. |
| [SURFACES.md](SURFACES.md) | Editing the MESH: per-triangle selection, coplanar grow, hiding, and the geometry-hash provenance guard. |
| [TOOLING.md](TOOLING.md) | The lab’s own chrome: drawer layout, the contact sheet, and how to screenshot/measure a WebGL page headlessly. |
| [../../docs/ART-LAB.md](../../docs/ART-LAB.md) | The PROCEDURAL element catalog (`elements/`) and its screenshot loop — a separate concern from the KayKit material pipeline. |

## The map

```
lab.ts               the lab screen: scene, studio rig, URL state, wiring. The orchestrator —
                     it knows about every panel; no panel knows about it.
world-object.ts      the build contract. meshObject().build() is the ONE path both the lab and the
                     game take to turn a GLB into a placed, coloured, box-fitted object.

  colour  ──  recolor.ts          swatch cascade + the per-pixel bake (albedo / ORM / shade)
              palette.ts          the 27 atlas swatches, probed from the real GLBs
              tiling.ts           the world-space surface shader: texture arrays, relief, rough, AO
              texture-catalog.ts  the texture library + per-type config + URL codec
              material-profiles.ts  named, inheritable sets of that config
  mesh    ──  face-surfaces.ts    hidden-triangle data + the geometry-hash guard
              facets.ts           the facet PARTITION + centroid, pure — the picker's overlay, the baker's anchor
              face-select.ts      the interactive picker (hover / grow / hide)
              group-anchors.ts    bakes each SAVED group's anchor into the mesh (per-group texture phase)
              box-fit.ts          the collision voxelizer (auto edge density)
  publish ──  approve.ts          freeze fit + materials → src/game/approved-assets.json
  chrome  ──  drawers.ts, texture-settings.ts, profile-bar.ts, surface-panel.ts,
              fit-controls.ts, recolor-legend.ts, object-picker.ts
  pages   ──  lab.ts · sheet.ts (contact sheet) · tile-editor.ts · walltile.ts · board.ts
```

## You want to change X → touch Y

| goal | where |
|---|---|
| which texture a material TYPE wears | `DEFAULT_CONFIG` in texture-catalog.ts, or the in-app menu |
| which TYPE a swatch resolves to | the 4-layer cascade in recolor.ts — see MATERIALS.md |
| how a surface responds to light | tiling.ts (relief / roughness / AO) |
| CHECK a surface's orientation, or whether two surfaces share a phase | the `calibration` / `gradient` test textures — see MATERIALS.md |
| whether a carved stone varies | save it as a GROUP in the SURFACES panel — only authored groups vary; then `TextureOption.vary` / the `Vary` slider / `?vary=` — see MATERIALS.md |
| a whole named look, shared or inherited | material-profiles.json + profile-bar.ts |
| remove geometry from an asset | the SURFACES panel — see SURFACES.md |
| add a texture | drop files in `public/textures/`, add a `TEXTURES` entry, **run `npm run tex:seams`** |
| add a panel | build it however you like, then one `dock()` call in lab.ts — see TOOLING.md |

## Rules that must not be quietly reverted

1. **Never trust a texture’s tileability — measure it.** `npm run tex:seams`. The shipped `planks`
   default was laying a hard seam across every planked object and nobody had noticed.
2. **A material’s look is a pure function of its own swatch colour.** Context belongs in *which
   preset a swatch resolves to*, never in a conditional inside a preset. Add a preset instead.
3. **Approval freezes a COPY.** That is what keeps the game stable while the lab is being retuned.
   It also means every frozen thing needs a provenance stamp (profile `rev`, geometry hash) or
   "is this stale?" becomes unanswerable.
4. **Triangle indices are only meaningful against one exact geometry.** Anything index-shaped reads
   through `sourceGeometry()` and is guarded by a hash. See SURFACES.md.
5. **Look at it.** Every change in this folder is a change to something visual; screenshot it
   headlessly before claiming it works. Verifying only in-session missed two persistence bugs that
   a cold reload caught immediately.
6. **Texture variation applies ONLY to hand-saved groups; everything else is the identity
   transform.** The tiling projection is world-space planar, so abutting faces are already
   continuous — continuity is free and variation is what breaks it. A first cut varied every
   carve@75 auto facet and pulled every wall run apart; the auto partition is the SELECTION AID
   (`show groups` is how you find the pavers worth saving), never the render scope.
   `group-anchors.ts` bakes nothing at all into a mesh with no saved group, so it reaches the
   renderer as the identical geometry object. See MATERIALS.md.
7. **An invisible hit target must not outlive the brush that uses it.** The cell editor's wall lines
   and corner circles are transparent, generous, and drawn on top of the floor squares — so when they
   were emitted in every mode they ate floor paint and selection drags along every border. They are
   emitted inside `if (brush.mode === …)` for that reason. See TOOLING.md.

## Keeping these current

These docs are load-bearing — they are how the next session knows why something is the way it is.
When you change this folder, update the doc that owns the concern **in the same commit**:

- new material/texture/profile behaviour → MATERIALS.md
- new mesh-editing behaviour → SURFACES.md
- new panel, page, or measurement technique → TOOLING.md
- a new invariant someone could plausibly undo → the numbered list above

If a doc grows past ~250 lines it is probably covering two concerns; split it and add a row to the
table at the top rather than letting this file absorb the overflow again.
