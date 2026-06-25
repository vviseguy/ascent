# ART-LAB — procedural element catalog & integration plan

The asset lab (`src/lab/`) is a screenshot-driven design environment for procedural decoration
elements. Eight elements shipped from the first design round (four families: stone, flora, vines,
accents), reviewed together for palette coherence on 2026-06-10. Art direction bible:
`docs/06-art-direction-shaders.md`.

**Everything here is VIEW-layer.** Elements are floats-and-`Math.random`-free only in the sense
that they are seeded (`mulberry32`) — they never touch `src/sim/` and must never feed back into it.

---

## The screenshot loop (how to iterate on an element)

```bash
node scripts/lab-snap.mjs <elementId> <seed> --dist=dist-lab-<elementId> [--actor] [--angles=30,150,270] [--time=2.5]
```

- Writes `lab-shots/<id>-s<seed>-a<angle>[-actor].png` (+ `<id>-s<seed>-inside-actor.png` with
  `--actor`). Open/Read the PNGs and LOOK — never ship an element you haven't seen.
- `--actor` orbits a blue 0.35u-radius capsule through the element — REQUIRED for reactive
  elements; the `-inside-actor` shot must show the element responding.
- ALWAYS pass a private `--dist=dist-lab-<id>` — parallel designers clobber a shared dist.
- Judge at MULTIPLE seeds (1 and 4 minimum) — procedural variety must hold up.
- Elements live in `src/lab/elements/<id>.ts`, default-export a `LabElement`
  (see `src/lab/element.ts` for the contract). The lab auto-discovers files; no registry.
- Finish with `npx tsc -b --noEmit` green.

## Palette tokens

| Token | Hex | Use |
|---|---|---|
| bg / void | `0x0a0a12` | deep indigo night background |
| wall | `0x2e2e4a` | tower wall base tone |
| AMBER (lit/earned) | `0xffb24f` | sodium-warm accents: veins, weeps, berries, even-seed crystals |
| INDIGO (potential/unrevealed) | `0x5a78ff` | cool electric accents: odd-seed crystals, plan-view glow |
| crew blue / Anchor gold | saturated | reserved for PLAYERS — decoration must never compete |

House rules: desaturated cool stone, muted mossy greens, amber/indigo used SPARINGLY. Stylized
bold forms over photo-texture. Readability is sacred: floors brighter than walls, decoration
darker/quieter than players, nothing taller than capsule shoulders near play paths.

---

## Element catalog

All elements: `build(seed)` → `{ root, update?, radius }`, base at local y=0, fully procedural
from seed, self-contained materials. Same seed → same look (cache and share builds).

### stone-slab — `src/lab/elements/stone-slab.ts`
Cracked indigo-night stone FLOOR module, 3.2u square. Plate fractures with per-plate tone offsets
(reads as broken plates at 20u), worn chamfered border, rare amber veins. Static, no `update()`.
- Top-face canvas spans exactly the slab so edge wear lands on physical edges; base at y=0.
- Bake ~100ms/seed: cache by seed, reuse 3–4 seeds per floor rather than one per tile.
- Roughness pinned ~0.975 ON PURPOSE — lowering it brings back a grazing-angle specular wash at
  exactly the low camera angles the game uses. Same for stone-wall (~0.985).
- Slab albedo intentionally brighter than wall albedo: floors read brighter than walls.

### stone-wall — `src/lab/elements/stone-wall.ts`
Coursed-block tower WALL: varied course heights, per-block tone, mortar shadow lines, moss bands
in bottom crevices, rare amber weeping streaks on interior course lines. Static.
- Textures are TOROIDAL at `TEX_WORLD = 2.0u` per repeat (normal map wraps too). For real
  perimeter walls reuse the MATERIAL on any panel size by box-projecting UVs at
  `u = worldX / 2.0, v = worldY / 2.0` (copy `buildPanelGeometry`). The 3.4×2.9×0.3 demo panel
  is a stand-in.

### grass-clump — `src/lab/elements/grass-clump.ts`
REACTIVE instanced grass: 6-segment bowed blades, root→tip gradient, center-dense dome profile,
moss grounding disc + instanced stones. Blades bend radially away from actors and spring back.
3 draw calls. Footprint radius ~1.5u, blade heights 0.25–0.9u (below capsule shoulders).
- MUST call `update(timeSec, actors)` per frame for reactivity; skipping freezes gracefully at
  the resting pose. ~420 matrix composes/frame — cull update beyond ~8u from any player.

### fern-shrub — `src/lab/elements/fern-shrub.ts`
REACTIVE fern: 5–7 arched fronds + 2 young crown fronds, all instances of one creased-leaf
geometry in one InstancedMesh. Fronds dip and yaw-part around actors, spring back. 3 draw calls.
Footprint radius 0.95–1.35u, crown ~0.8u. Same update contract/cull rule as grass (~230 composes).

### vine-drape — `src/lab/elements/vine-drape.ts`
REACTIVE hanging ivy for lintels & stair-hole edges, built for a 2.5u lintel at y=3 (root base
y=0, bar spans x±1.25). Strands part around players (immediate part + underdamped spring-back),
smooth-noise hem, tip leaf flourishes, rare amber berries. 2 draw calls.
- MUST call `update(timeSec, actors)` per frame. Actor positions are compared in ELEMENT-LOCAL
  space — pass world positions through `root.worldToLocal`. Push reach 1.3u horizontal, vertical
  influence ±1.2–2.0u around node height. Mounting bar = box instances 0–2 (hide or keep).
- Uniform scale 0.8–1.2 safe; re-tune `PUSH_R` if scaled harder.

### vine-wall — `src/lab/elements/vine-wall.ts`
STATIC ivy patch climbing a wall panel — zero per-frame cost, no update. 2 draw calls.
- The dark 2.2×2.6×0.12u panel (box instances 0–1) is a stand-in: keep as a decorated wall tile,
  or drop those instances and parent the ivy flush onto a real wall (growth lives at
  z ≈ +0.075–0.09 off the panel center plane). Each seed → distinct runner layout.

### glow-crystal — `src/lab/elements/glow-crystal.ts`
LUMINOUS ACCENT: 3–6 angular shards with per-facet emissive banding out of a dark rock mound,
slow two-sine pulse + faint shadowless PointLight (distance 2.6).
- **Seed parity is semantic**: even seeds AMBER (lit/earned), odd seeds INDIGO (potential/
  unrevealed). Pick parity by game meaning, never randomly.
- Call `update(timeSec)` every frame (actors unused) — pulses emissive + light, cheap.
- Footprint radius ~0.95u, dominant shard 0.8–1.1u. MAX 1 per room/landmark — the PointLights
  stack if clustered. Place at floor level.
- Review note: at full emissive the hues run hotter/purer than the flat UI tokens (tone-mapping
  of `emissiveIntensity` 1.3) — accepted as accent behavior; don't "fix" by dropping intensity
  or the indigo tip stops reading hot.

### rubble-pile — `src/lab/elements/rubble-pile.ts`
STATIC merged stone-debris drift, one draw call, quiet by design (value-matched to stone-slab).
Footprint ellipse ~1.3×0.7u elongated along local X.
- Yaw parallel to walls or diagonal into stair corners; sink root y by 0–0.02u on uneven floors.
  Scale 0.7–1.3 safe. Vertex-color contact-AO assumes base near y=0 — don't float it.
  Safe to scatter liberally.

---

## Review verdicts (art-director pass, seeds 1+4, fresh snaps in `dist-lab-review`)

| Element | Verdict | Notes |
|---|---|---|
| stone-slab | **ship** | distance read of plate fractures is the set's anchor |
| stone-wall | **ship-with-notes** | joints slightly toothy at very close range; fine at gameplay distance |
| grass-clump | **ship** | radial part around capsule is clean at both seeds |
| fern-shrub | **ship-with-notes** | leans "palm seedling"; reactivity + palette good |
| vine-drape | **ship** | best reactive feel in the set (pendulum part + spring-back) |
| vine-wall | **ship** | scatter-ready; amber berries are a properly rare accent |
| glow-crystal | **ship-with-notes** | hue saturates under emissive intensity (accepted); enforce 1-per-room + seed-parity rule |
| rubble-pile | **ship** | recedes correctly; one occasional outlier pebble reads as scatter |

Set-wide: the three greens (grass, fern, vines) sit in one muted-moss family; stone family +
rubble + vine-wall panel share the indigo-night value ladder (slab > wall > rubble); amber/indigo
appear only as rare accents. The set reads as ONE game. No unifying edits were needed.

---

## INTEGRATION PLAN (game renderer)

### Where each element goes in the tower

| Surface | Elements | Placement |
|---|---|---|
| Slab tops (floor) | stone-slab (the floor itself), rubble-pile, grass-clump, fern-shrub, glow-crystal | rubble at wall bases/stair corners; grass/fern in room interiors AWAY from door lines; crystal at landmarks (1/room max) |
| Wall faces | stone-wall (the wall material), vine-wall | vine-wall patches on 10–20% of interior wall tiles, biased to corners |
| Stair edges / ceiling openings | vine-drape | hang from the lintel over stair holes & door frames; strands brush players passing through |
| Landmarks / objective rooms | glow-crystal | seed parity = state: amber when earned/lit, indigo when potential/unrevealed |

### Density & draw-call budget per floor (one stratum ≈ one visible floor + plan of next)

- stone-slab: floor tiles share 3–4 cached seed-builds → 3–4 draw calls total via material reuse.
- stone-wall: ONE material (toroidal, box-projected UVs) for all perimeter/interior walls → 1–2 calls.
- rubble-pile: 6–12 piles/floor (static merges; can merge further by shared seed) → ≤6 calls.
- grass-clump + fern-shrub: 4–8 clumps + 2–4 ferns per floor → ~30 calls worst case at 3 each;
  acceptable, but merge moss discs into the floor pass if sorting artifacts appear on stacked
  floors (discs are transparent `depthWrite:false` — render with the ground, not the blades).
- vine-wall: 3–6 patches/floor → ≤12 calls. vine-drape: 1–3 per floor (stair holes) → ≤6 calls.
- glow-crystal: 0–2 per floor. HARD RULE: lights never overlap (distance 2.6) — 1 per room.
- Whole-floor decoration target: ≤70 draw calls; decoration must stay under the floor geometry
  budget, and NOTHING decorative renders on hidden higher floors (coalescence already culls).

### Wiring update(timeSec, actors)

```ts
// per frame, render layer (floats fine here — this never touches the sim):
const actors: THREE.Vector3[] = players.map(p => fixedToFloatVec3(p.pos)); // world space
for (const el of reactiveElements) {              // grass, fern, drape, crystal
  if (el.cullDistSq && nearestActorDistSq(el, actors) > el.cullDistSq) continue; // ~8u cull
  // vine-drape (and any transformed root) compares in LOCAL space:
  const local = actors.map(a => el.root.worldToLocal(tmp.copy(a)));
  el.update(time, local);                          // glow-crystal ignores actors
}
```

- Actor positions should be ~chest height (|y| < ~1.5 local) for the push fields to engage.
- Elements not updated freeze at their resting pose — safe for floors below/above the active one.
- All elements read sim state ONLY through the render layer's interpolated player transforms;
  never call into `src/sim/` from decoration code.

### Seeding

Derive decoration seeds from the floor's deterministic generation seed (e.g.
`hash(floorSeed, tileIndex, elementKind)`) so all peers see identical decoration without any
extra net traffic — but keep it strictly view-side: decoration seeds must never influence sim
state or the solvability verifier.
