# Lab tooling — layout, the contact sheet, and how to look at things

The lab is a screenshot-driven environment: nothing here ships to players, and every decision it
supports is one a human makes by LOOKING. These are the parts that exist to make looking cheap.

## Panel layout: DRAWERS ([drawers.ts](drawers.ts))

The lab grew one fixed-position panel at a time, each hard-coding its own corner, until they
collided and covered the model they exist to judge. They now dock into two edge rails — CONTENT /
TEXTURES / SURFACES on the left, FIT / LEGEND on the right — each behind a tab that sticks out of
the edge. One drawer open per side, so the viewport is never more than two panels' worth of covered,
and the open pair persists in `?drawers=left:right`.

`dock()` takes whatever element a panel already built and overrides only its POSITIONING, so no
panel module knows the layout system exists and adding the next one costs a `dock()` call instead
of a hunt for free pixels. Panels are hidden by sliding the shell rather than `display:none`, so a
reopen never re-lays-out and nothing measures zero while closed.

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

## Reference / debugging

- The lab's bottom-right **SWATCH → MATERIAL legend** ([recolor-legend.ts](recolor-legend.ts))
  shows, for the current object, every swatch → its resolved preset+tint, with the swatches the
  model actually uses highlighted ("N of 27 used by this model"). Use it to see exactly what maps
  where and spot anything wrong.
- `npm run probe:palette` ([scripts/palette-probe.mjs](../../scripts/palette-probe.mjs)) samples the
  real GLBs and reports which swatch each triangle lands on — the ground truth behind the swatch
  list in [palette.ts](palette.ts).


## Measuring, when the GL is software

Headless runs here use **SwiftShader** (a CPU rasteriser), so absolute frame times are meaningless
and only COUNTS transfer — programs, draw calls, texture fetches. Measure by instrumenting the
WebGL context itself (patch `WebGL2RenderingContext.prototype.linkProgram` from a Playwright
`addInitScript`) rather than asking the app to report on itself: it needs no app changes and it
cannot be fooled by a counter someone forgot to increment. That is how the one-shader-program-per-
object regression was found — see MATERIALS.md.

Screenshot the live WebGL pages with headless Playwright (`--use-gl=swiftshader`), NOT the preview
pane: a continuously-rAF-ing canvas makes the pane time out. `scripts/lab-snap.mjs` is the worked
example. When testing a pointer tool, draw a marker at the cursor position before the screenshot —
a screenshot has no cursor in it, and "is the highlight under the pointer" is otherwise unanswerable.

## Headless runs WRITE the authoring stores

The dev middleware exists to write `src/game/*.json` — that is what Approve and the surfaces Save
button are for. So any headless run that drives those buttons writes them too, and a fixture left
behind by a test is indistinguishable in review from an authored edit. This has already shipped
once: a Playwright run committed 344 of the dungeon wall’s 494 triangles as hidden.

Remembering to reset the file is not a control. Use the guard:

```bash
node scripts/store-guard.mjs node tmp/whatever.mjs   # run, then restore whatever it wrote
npm run stores:check                                 # before committing — exit 1 if a store is dirty
npm run stores:restore                               # after an interactive session
```

`store-guard --check` is the one to reach for reflexively: it answers "is a data store dirty
relative to HEAD", which is the question you actually have before every commit in this folder.
Add any new middleware-written store to the `STORES` list in the script.
