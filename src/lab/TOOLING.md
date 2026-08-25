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

### A board of CASES beats a shot of one case

When a rule has many branches, put them all on one board rather than taking one screenshot per
branch: side by side you can see which one is the odd one out, and a folder of separate PNGs makes
you hold the others in your head. `cell-snap.ts`'s `demo=caps` is the pattern — sixteen wall-ending
cases in 6x5 patches with at least two clear cells between them, so no two can share a lattice point
and quietly become one figure.

Two things make such a board readable, and both were learned by getting them wrong first:
- **CAPTION EVERY CASE.** A sprite plate per patch, `depthTest: false` so a wall never swallows its
  own label. Without them you can see that one patch differs from its neighbour and still not know
  which rule it is exercising.
- **PUT THE CAPTION NORTH OF ITS CASE.** A sprite always faces the camera, so one placed over the
  case hides the thing it names as soon as the pitch drops, and one to the SOUTH reads as the title
  of the row below. North of it is a heading, at every pitch.

`--size=WxH` sets the viewport (default 900x620). A wide board of small cases is unreadable at the
default, and on a deliverable that IS pixels, that is the whole thing failing.

```bash
npm run cell:snap -- demo caps --size=1800x1250 --angle=90 --pitch=76   # the whole board
npm run cell:snap -- demo caps --no-build --focus=14.5,11.5,8 --pitch=16 --out=cell-shots/z-nub
```

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

## A save must not cost the author their work

Two things in the authoring loop conspired to throw away a painted grid, and both are fixed in ways
that are easy to undo by accident.

**A store write used to reload the page.** `jsonStorePlugin` writes a git-tracked JSON file that
`src/floor/cell-structures.ts` imports, so Vite saw the author's own save as a source change, found
no HMR boundary, and full-reloaded — wiping the grid at the exact moment they said "keep this". The
plugin now returns `[]` from `handleHotUpdate` for its OWN store file. The editors read the store
over HTTP (`GET /__lab/<name>`), so nothing needs the module graph to notice; a page that wants the
new data reloads on purpose. `profilesPlugin` and `surfacesPlugin` write their stores the same way
and do NOT have this guard yet — the lab reloads on Approve. Same fix if it starts to hurt.

Path comparison there goes through `posix()`: `fileURLToPath` hands back a native path and Vite
normalizes the watcher's to forward slashes, so on Windows the two never compare equal.

**A reload used to cost the grid regardless.** `cell-editor.ts` mirrors the whole lattice —
integer masks, so it is small — into `localStorage` under `ascent:cell-editor:draft` on a 400 ms
debounce from `render()`, and reads it back at boot. `loadedName` rides along, so the Save button
still names its target after a reload. It is a DRAFT, not a save: the store is still the only thing
the generator reads, and a draft whose cell count does not match the `w`/`h`/`levels` it claims is
dropped rather than repaired.

`loadedName` is also what lets Save write straight back to the structure you opened, with the name
ON the button in place of a confirm dialog (Ctrl/Cmd+S does the same thing). Loading binds it,
saving under a new name rebinds it, clearing the grid and deleting that structure both release it.

## The cell editor's gestures, and why the hit targets come and go

Three buttons' worth of meaning on a board where four brushes aim at a point, one aims at a square
and one aims at an edge. The rules, in full:

| gesture | what it does |
|---|---|
| left click / drag | paints every target you cross |
| right click | abstains the one target you pressed on — restores its full domain |
| right **drag** | rubber-bands a box and fills it with the brush on release |
| shift + right drag | same box, filled with abstentions |
| alt + click (COPY) | picks a cell up instead of pasting |

The box is **armed on press and only fires once the pointer has moved**. That is the whole reason
right-click-abstain still works: a press that never left its target resolves to the abstain it was
armed over. A box also spans **whatever kind of thing it was anchored on** — start on a north wall
and it fills north walls, start on a corner and it fills corners. It never infers which channels you
meant from the shape of the region, because it would be wrong about half the time.

COPY is the one brush that carries a whole lattice point rather than one channel of it, which is what
makes "make this bit look like that bit" expressible at all. A plain click picks up while nothing is
held and pastes once something is, so the brush works before anyone has read that Alt is the
eyedropper; the drag that follows a pick is suppressed so it cannot smear what it only just picked up.

**The hit targets exist only while the brush that uses them is up, and that is not tidiness.** The
wall hit line is 20px wide and the corner hit circle is r=16, and both are drawn ABOVE the floor
squares. Leaving them in place for every mode put a dead cross over every cell border and corner that
swallowed floor paint and selection drags and did nothing with them — which reads as the brush being
unreliable, not as something being in the way. If you ever hoist those `svgEl` calls back out of their
`if (brush.mode === …)`, you have put the dead zones back.
