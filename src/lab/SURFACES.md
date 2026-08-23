# Surfaces — editing the MESH rather than its colours

The material pipeline ([MATERIALS.md](MATERIALS.md)) answers "what is this part made of", keyed by
atlas swatch. Some things are properties of a REGION of a mesh instead, and no colour rule can
express them — the decorative bricks jutting out of a dungeon wall being the case that forced this.

## SURFACES — per-triangle selection and hiding ([face-select.ts](face-select.ts))

The swatch cascade answers "what is this part made of", which is the wrong grain for "this
particular face". Some things are properties of a REGION of a mesh: the decorative bricks jutting
out of a dungeon wall want to be gone, and no colour rule can express that.

The SURFACES panel (object mode, **off by default** — it takes the left mouse button, so it has to
be switched on) does triangle picking on the loaded mesh:

| drawn | meaning |
|---|---|
| white + an arrow | the triangle under the cursor. The arrow is its NORMAL — on a thin wall the front and back faces project a few pixels apart and are otherwise indistinguishable |
| amber | the PREVIEW: what GROW would add at the current tolerance, before you commit |
| blue | already selected |

**GROW is what makes it a tool.** Hovering flood-fills across shared edges to every triangle whose
normal is within `grow ≤ N°` of the hovered one, so a wall face arrives in one click instead of
forty. The tolerance is a slider because "coplanar" is never exactly true in an exported mesh.
Showing the preview separately from the selection is what makes the slider legible — you drag it
and watch the amber spread, instead of clicking and undoing.

Two things that are easy to get wrong and are deliberate here:

- **Grow is SEED-relative, not neighbour-relative.** Chaining neighbour-to-neighbour walks all the
  way around a curved surface a fraction of a degree at a time, which is never what "these faces
  are basically the same face" means.
- **Adjacency is by POSITION, not vertex index.** A GLB duplicates vertices at every UV and normal
  seam, so two triangles that visually share an edge routinely share no index; keying the edge map
  on quantised position is what lets a fill cross a seam instead of stopping dead at it.

**A press only ARMS a click; the RELEASE decides.** Move more than 5 px in between and the gesture
is handed back to the camera untouched, so orbit stays on left-drag and pan on right-drag exactly as
they are outside edit mode. Edit mode does not take the mouse away from you — it adds a meaning to
tapping, and both buttons work the same way: left-click adds the preview, right-click removes it.
Hover updates pause mid-drag (re-picking every frame while the camera swings is just noise), and a
pointer that wanders onto a panel clears the highlight, because `pointerleave` on the canvas is not
reliable across a fast move and a stale highlight looks live.

Nothing touches the geometry until **Hide** — selection is a view, hiding is an edit — and hiding
re-runs the box-fit, because collision must not keep boxing a brick that is gone.

**Indices are numbered against the SOURCE geometry, always.** On a cold load the build has already
applied the stored hidden set, so `mesh.geometry` is the FILTERED mesh; `applyHiddenFaces` parks the
original in `userData` and everything index-shaped reads it back through `sourceGeometry()`.
Numbering topology off the filtered mesh while the stored indices number the original is exactly the
"selection lands a few faces away from the cursor" bug. For the same reason the picker is re-mounted
whenever `rebuildObject` swaps the root (any texture change does), carrying the unsaved hidden set
across by hand.

## Two grow modes: `planar` and `carve`

A flat face and "one carved tile" are different questions, not two settings of one.

`planar` grows a single cone about the seed normal — what is FLAT with this face. `carve` grows
the seed face PLUS the slants that roll down off it, and stops at the concave crease where the
neighbouring tile’s slant comes back up. That gives a tile the way a mason would think of one:
the face and its own chamfers, fitted against the next tile, with the boundary in the rut.

**The difference is the SIGN of the fold, not its angle.** Measured on `floor_tile_large`:

| angle | convex | concave | what it is |
|---|---|---|---|
| 0-5° | 16 | 100 | triangulation seams inside a face (sign is noise here) |
| 20-45° | **104** | 0 | the bevels rolling down off each paver |
| 60-65° | 0 | **28** | creases where two bevels meet — the rut bottoms |
| 90-95° | 32 | 0 | tile perimeter, top meeting the outer side wall |

Both the bevels and the ruts are just "edges" to an angle threshold, which is why `planar` can
only ever give you tops-without-slants (15°, 73 facets) or the whole surface at once (45°, 5
facets). Convexity separates them: `carve` at 50° gives **21** facets — one per paver, each
carrying its slants. An edge is convex when the neighbour’s centroid sits BEHIND this face’s
plane. Below ~8° the centroid offset is nearly in-plane so the sign is meaningless noise; those
edges always join regardless.

### The tolerance means something different in each mode

In `planar` the cone IS the boundary rule. In `carve` the concave creases draw the boundaries and
the cone only caps how far down a slant may roll before it stops belonging to its face — so it
wants to be much higher, and each mode remembers its own value (**15° planar, 75° carve**).

Set it too low in carve mode and you do not get over-merging, you get ORPHANED SLANTS: the paver
top groups fine but its steeper chamfers fall outside the cone and reappear as their own sliver
facets. That is what the extra facets at 50° were — not ruts being crossed.

| carve tolerance | facets on `floor_tile_large` |
|---|---|
| 50° | 21 — pavers, plus orphaned slants |
| 55° | 21 |
| 60° | 18 |
| **65-89°** | **17 — one per paver, each carrying its slants** |

Flat across a 25° plateau, because in that range the cone is inert and the creases are doing all
the work. It cannot usefully go past 89° on this asset: the tile perimeter (top meeting the outer
side wall) is convex at 90-95°, so a 90°+ cone would swallow the side walls into the top.

**It generalises.** On the dungeon wall at 75°, each protruding brick becomes ONE group (top,
front and sides together) and stays separate from the wall face — a protrusion is bounded by
concave creases at its base, exactly as a recess is. Same rule, opposite geometry: 257 facets at
15°, 41 at 75°.
## GROUPS — the partition, not just one hover

A **facet** is a maximal run of edge-connected triangles within the angle tolerance: the same
flood the hover preview uses, run to exhaustion so every triangle lands in exactly one. It is the
unit a texture gets "ironed onto", and what a per-group transform will key off.

`show groups` tints every facet a distinct hue (golden-ratio stepping, so neighbouring ids land
far apart — neighbouring facets are exactly the ones you need to tell apart) and lists them
largest-first with triangle count and area. Hovering a row highlights that facet in the viewport;
left-click adds it to the selection, right-click removes it — the same two meanings as in the
viewport, so a facet you cannot conveniently hover (behind the model, or a sliver too small to
hit) is still reachable.

- **Sorted by AREA, not triangle count.** A count says more about how the exporter triangulated
  than about how big the face is.
- **The centroid is area-weighted.** A fan triangulation clusters slivers at one corner, and a
  plain per-triangle mean would drag the anchor there instead of the middle of the face — which
  matters because that centroid becomes the texture anchor.
- **The partition is invalidated by the tolerance, not filtered by it.** The tolerance IS the
  definition of "one surface", so changing it recomputes rather than refines.

What this buys, concretely: on the dungeon wall the flat front face is ONE facet and each
protruding brick contributes its own — because a flood cannot get from the wall to a brick top
without crossing the brick’s non-coplanar sides. That is the behaviour a tiled floor needs too:
the divet around an octagonal tile stops the fill without any special rule for it.

**Facets are MESH-LOCAL.** Facets that abut across two placed instances — the corner pieces of
four floor tiles meeting to form one diamond — are separate facets here and can only be joined
once world positions are known. Anything that wants them to agree (a shared texture phase) needs
a world-level anchor, not a bigger flood.

## SAVED GROUPS — the decision, not the proposal

The auto facet partition is a **proposal**: recomputed from the tolerance, redrawn wholesale every
time it moves. A saved group is a **decision**. It stores its TRIANGLES, not the tolerance that
happened to produce them, so once you have committed to a region no slider drag can silently
redraw it. Verified: with a group saved, the auto partition swings 73 → 5 → 17 → 49 facets across
planar 15/45 and carve 75/30 while the saved group does not move.

That is the whole reason groups are persisted rather than derived, and it is what makes
hand-authored grouping safe to build texture mapping on top of.

```jsonc
"models/…/floor_tile_large.gltf.glb": {
  "geom": "67dd9829",
  "hidden": {},
  "groups": [ { "id": "octagon-centre", "name": "octagon centre", "tris": { "0": [ … 24 … ] } } ]
}
```

Workflow: switch to `carve`, click a tile (one click took the octagonal centre paver and its
slants — 24 triangles), **New group from selection**, name it, **Save**. The list gives you hover
to highlight, click-the-name to load it back into the selection, rename, and delete. `saved
groups` tints them all at once; it and `show groups` share one overlay so turning either on turns
the other off rather than stacking two tints.

Groups live in the same entry as `hidden`, keyed by mesh URL, under the same geometry hash — so a
KayKit re-export invalidates the groups exactly as it invalidates the hidden set, and for the same
reason. `id` is a stable slug: it is what a per-group texture transform will key off.

### The store, and why the geometry hash is not optional

`src/game/mesh-surfaces.json` (via `POST /__lab/surfaces`), keyed by **mesh URL** rather than lab
object id — hidden geometry belongs to the mesh, so two catalog entries on the same GLB share the
edit. `applyHiddenFaces` runs inside `meshObject.build`, the one path both the lab and the game go
through, and the store is a STATIC import (like `approved-assets.json`) because a build is
synchronous and the game has no dev middleware to fetch from.

Triangle indices are positions in a buffer that only one exact GLB produces. Re-export the model
and every stored index silently points somewhere else — so each entry carries a checksum of the
geometry it was authored against and is SKIPPED with a warning on mismatch. Losing an edit is
recoverable; applying it to the wrong triangles is a corruption nobody notices until it ships.

**Save the hash of the UNFILTERED source** (`FaceSelectHandle.sourceHash()`), not of the live
root. With faces already hidden the root IS the filtered mesh, and storing that hash makes the
next cold load compare it against the original and reject the edit as "geometry changed" — which
is exactly the bug this guard is meant to catch, turned against itself.

**Not yet built:** per-group textures and boundary marking. The plumbing is here (a group is just
a triangle set); what they need is a second attribute path so the shader can pick a slot per
group instead of per swatch, plus a per-group UV transform so courses break at a surface edge
rather than running through the object as one slab.
