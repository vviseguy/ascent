# Instruments — how a surface gets MEASURED

The lab's two test textures — `calibration` and `gradient` — and the scanner that reads them,
`scripts/seam-scan.mjs`. None of this is art and none of it ships: each one exists to turn a
question a human cannot answer by looking into one that is mechanical.

What the instruments are pointed AT — the swatch cascade, the tiling shader, per-group variation,
profiles, the approval freeze — is [MATERIALS.md](MATERIALS.md), which stays authoritative for
colour and surface. This file is authoritative for the readings, and for what they are worth.

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

## The `gradient` continuity texture — the other measuring stick

`calibration` answers *is this surface oriented and lit correctly*. `gradient` answers *do two
surfaces AGREE*. Both are instruments, neither is art, and they read in opposite directions:
calibration is a local reading on one face, gradient is a reading ACROSS a boundary.

```
R = ONE triangle wave along U    G = ONE triangle wave along V    B = flat    + a fine dither
```

Brightness in one channel is a direct, monotonic readout of position along one axis. Boring to look
at, which is the property you want: a step in R is a U-shift, a step in G is a V-shift, and the size
of the step is the size of the offset.

Every clause of that is a correction of a version that did not read, and the wrong ones are worth
recording because each looks reasonable:

- **One wave per axis, in its own channel.** A DIAGONAL wave mixes U and V, so a U-shift and a
  V-shift look identical and neither can be isolated. Three varying channels means you are reading
  HUE, which is cyclic — red at both ends of the ramp — so it cannot express magnitude or direction.
- **One cycle, not several.** A second octave puts more than one period in frame, and then an offset
  of one period is indistinguishable from no offset. That is the same aliasing that ruled out a grid.
- **A triangle, not a linear ramp.** A ramp wraps with a hard jump at every repeat, and those jumps
  look exactly like phase breaks. A triangle is C0 across the wrap, so the only discontinuities left
  in the picture are real ones.
- **Plus a dither.** With a perfectly smooth image `seam-scan` has no local gradient to normalise
  against and its scale-free ratio degenerates. Ramp-plus-noise is what that scanner was validated
  on.
- **1 m per repeat**, sized for the close-up crop the scan reads: under one period spans a ~0.75 m
  crop, so the ramp is monotonic in frame, and the texels stay near pixel size so the dither
  survives into the render.

Rotation is deliberately NOT this texture's job. Over a 0.7 m paver the ramp barely turns; use
`calibration`, whose arrows answer rotation outright. Two instruments, one question each.

### Reading it: `scripts/seam-scan.mjs`, not your eyes

Do not certify a seam by looking at it. Render a CLOSE-UP of one seam — a tight crop of one flat,
evenly-lit surface spanning it — and scan the frame:

```bash
node scripts/seam-scan.mjs shot.png --box=x,y,w,h     # steps along X (vertical seams)
node scripts/seam-scan.mjs shot.png --axis=y          # horizontal seams
```

It reports the biggest single-pixel jump against the image's own typical local gradient. Scale-free,
so exposure and texture contrast do not enter. Validated against synthetics whose answer is known by
construction: a clean ramp reads 3.3x, an 18% phase shift 20.8x, a 3% shift 5.8x — that last row is
the case a human misses.

**Its limit decides how you use it here: a silhouette, a shadow boundary or a chamfer is also a
step, and it cannot tell one from a phase break.** On this kit EVERY mesh-to-mesh seam carries
geometry, so an absolute "CONTINUOUS" verdict is not available at a real seam and claiming one would
be a lie. The geometry-immune form is to scan the SAME crop at `?vary=0` and at full: at 0 no phase
transform exists anywhere by construction, so that render is the ground truth for "geometry only",
and any increase at full strength is phase and nothing else.

Measured on a run of three wall panels and the authored floor tile:

| crop | `?vary=0` | full | reading |
|---|---|---|---|
| no seam in the box (control) | 4.0-4.7x | 4.0-4.7x | the scanner's noise floor on these renders |
| UN-AUTHORED wall-panel seam | 9.7x, step 29 | 9.7x, step 29 | unchanged to the digit — and the two PNGs are **byte-identical**. The 9.7x is the panel's own edge geometry, which is why it is already there at `vary=0` |
| AUTHORED paver edge | 14.3x, step 43 | **88.7x, step 266** | the chamfer accounts for 43; the phase break adds 223 |

### The cross-tile seam: a BEFORE/AFTER control, which is stronger than `vary=0`

For the boundary snap the better control is not `?vary=0` but the previous ANCHOR RULE, because the
two renders share geometry, texture, lighting and camera exactly and differ only in the number being
hashed. Measured on `tmp/ab.ts`'s 3x3 run of floor tiles, `gradient`, camera straight down on the
octagon that straddles one tile seam, box 280x320 entirely inside that paver's flat top:

| render | worst step | reading |
|---|---|---|
| `?vary=0` (identical in both builds, byte for byte) | 36, 9.0x | the geometry floor: the two half-tiles' abutting edges, present with no phase transform anywhere |
| full, **own-centroid** anchor | **329, 109.7x** | the reported bug — the paver torn down the middle |
| full, **boundary-snapped** anchor | **27, 9.0x** | at the geometry floor. The phase contributes nothing |
| control box with no seam in it | 18-23, 6.0-7.7x | the scanner's noise floor on these renders |

The pictures say the same thing at a glance and are worth taking: at the four-way corner the
own-centroid build quarters one octagon into four differently-coloured fields with hard steps along
both seams, and the snapped build runs one field through all four meshes. Also re-measured with the
snap in: the un-authored wall run renders **byte-identical PNGs at `?vary=0` and `?vary=100`**, and
the contact sheet still links **8 programs / 1 shader carrying `uTexArr`**.

