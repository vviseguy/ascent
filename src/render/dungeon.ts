// ============================================================================
// src/render/dungeon.ts — KayKit dungeon environment (view-only).
// ============================================================================
//
// Builds the visible world from the KayKit "Dungeon Remastered" CC0 tileset, laid out
// per the deterministic tower LAYOUT GRID (CompiledTower.cellGrid). For each stratum cell
// we drop a floor tile on walkable cells, wall pieces on the sides its `wallMask` marks
// as facing non-floor, corner pillars at TRUE convex corners (not T-junctions), a KayKit
// stair model on stair cells, emissive torches (which feed bloom = cheap "lighting"), and
// a deterministic, THEMED set of furniture props so rooms have personality.
//
// VIEW-ONLY: it reads the compiled layout (sim-derived, deterministic) and renders; it
// never touches the sim. Collision is still the sim's AABB terrain underneath these tiles.
// All randomness is a deterministic hash of cell coords / roomId (never Math.random), so
// every peer paints the identical dungeon (docs/06 §0).
//
// This file also owns four UX/visual systems requested by the boss:
//   1. OCCLUSION CUTAWAY — walls between the camera and the local player fade out per
//      frame so the player is always visible (isometric cutaway), and restore behind.
//   2. INKY FOG-OF-WAR — unexplored cells are fully hidden; newly-explored cells FADE in
//      smoothly (not a pop); the surrounding void reads as black liquid shadow (tight
//      black fog + a dark floor underlay) so you forget the far sides of walls exist.
//   6. STONE DETAIL — a procedurally-built tiling normal+roughness DataTexture is patched
//      onto the wall/floor/pillar materials so flat KayKit stone reads as real stone.
//   7. KAYKIT STAIRS — the stairs model placed on stair cells, scaled to rise one floor.
// ============================================================================

import { openDoorLeaves, stripFragment, wantsOpen } from '../lab/cell-preview.ts';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toFloat, fromRaw } from '../sim/fixed/fixed.ts';
import type { StratumCellGrid, CellTile, StairInfo, WorldPlacement } from '../game/tower.ts';
import { DungeonMaterials, classifySurface } from './materials.ts';
// SHARED VIEW ENGINE (candidate to relocate to src/render/ later): recolor.ts is the lab's
// per-pixel, gradient-preserving asset-coloring engine — a pure view utility with no lab-app
// dependencies (it imports only three + palette.ts). The game consumes it directly so the
// in-game dungeon and the lab use the SAME coloring engine and can't drift apart (the old
// per-triangle retexture/theme path is gone). See src/lab/CLAUDE.md (authoritative).
import { applyRecolor, ensureTilingTextures, cloneMaterial } from '../lab/recolor.ts';
// Phase-4b (docs/16 §10): the remastered tile-unit pieces are referenced BY URL from the IR's
// `WorldPlacement.unit`. PIECE is the sim-side registry naming those urls (pure string data) — the
// renderer preloads them as templates keyed by url and clones them through the same recolor path.
import { PIECE } from '../floor/tile-place.ts';
import { PIECE as CELL_PIECE } from '../floor/cell-place.ts';

const DIR = 'models/kaykit_dungeon/';
/** The KayKit tiles we use (CC0, downloaded to public/models/kaykit_dungeon/). */
const TILES: Record<string, string> = {
  floor: 'floor_tile_large.glb',
  stairs: 'stairs.glb',
  torch: 'torch_lit.glb',
  // ---- themed furniture / decoration props ----
  barrel: 'barrel_large.glb',
  barrelStack: 'barrel_small_stack.glb',
  crates: 'crates_stacked.glb',
  boxStack: 'box_stacked.glb',
  chest: 'chest.glb',
  chestGold: 'chest_gold.glb',
  tableLong: 'table_long.glb',
  tableMedium: 'table_medium.glb',
  tableSmall: 'table_small.glb',
  tableCloth: 'table_long_tablecloth.glb',
  chair: 'chair.glb',
  shelfLarge: 'shelf_large.glb',
  shelves: 'shelves.glb',
  shelfCandles: 'shelf_small_candles.glb',
  bed: 'bed_decorated.glb',
  bedFrame: 'bed_frame.glb',
  candle: 'candle_lit.glb',
  candleTriple: 'candle_triple.glb',
  bottleA: 'bottle_A_green.glb',
  bottleB: 'bottle_B_brown.glb',
  plates: 'plate_stack.glb',
  coinsL: 'coin_stack_large.glb',
  coinsM: 'coin_stack_medium.glb',
  swordShield: 'sword_shield.glb',
  rubble: 'rubble_large.glb',
  rubbleHalf: 'rubble_half.glb',
  keyring: 'keyring_hanging.glb',
  bannerRed: 'banner_red.glb',
  bannerBlue: 'banner_blue.glb',
};
/** KayKit dungeon tiles are authored 4 units per cell — scale to the sim's cell size. */
const NATIVE_CELL = 4;
/** KayKit wall/pillar tiles are 4 units TALL (native) — used to size the stair rise too. */
const NATIVE_WALL_H = 4;
/** The KayKit stairs model native rise (glb POSITION span on Y). */
const NATIVE_STAIR_H = 5.1;
/** The KayKit stairs model native run (glb POSITION span on Z, ascends toward +Z). */
const NATIVE_STAIR_RUN = 4;
/** The KayKit stairs model native width (glb POSITION span on X, centred on the origin). */
const NATIVE_STAIR_W = 5;
/** Cap real point-lights (forward-rendering cost); the rest of the glow is emissive+bloom. */
const MAX_TORCH_LIGHTS = 8;
/** Fog-of-war BFS depth: how many REACHABLE cells out from the player a floor reveals.
 *  Reveal flows along connected (non-wall-separated) cells, NOT a raw distance radius.
 *  At the 30×30 scale the player's small explored pocket was swamped by black fog slabs
 *  filling most of the frame, which read as flat squares obstructing the view. A much
 *  deeper flood reveals the current room AND several rooms out through doorways, so the
 *  lit dungeon — not the fog — dominates the screen. Still a graph flood (never bleeds
 *  through solid walls or into the inter-room VOID), so unexplored wings stay fog-gated. */
const FOG_BFS_DEPTH = 6;
/** How far line of sight reaches. Sight is stopped by walls, so this is only a cap on the cost of
 *  the trace — a long hall reveals its whole length, a corridor reveals as far as its first turn. */
const FOG_LOS_RANGE = 24;
/** Occlusion cutaway: how fast a wall fades out/in when it (un)blocks the player (/s). */
const OCCLUDE_FADE_RATE = 9;
/** Min opacity a wall fades to while it occludes the local player. */
const OCCLUDE_MIN_OPACITY = 0.12;
/** Horizontal radius (world u) around the player within which a wall can count as occluding. */
const OCCLUDE_RADIUS = 5.5;

/** A wall/doorway mesh that participates in occlusion cutaway (issue 1). */
interface WallRec {
  obj: THREE.Object3D;
  x: number; z: number;
  /** 'X' = a wall on an east/west face (spans Z); 'Z' = north/south face (spans X). */
  axis: 'X' | 'Z';
  /** current occlusion fade ∈ [OCCLUDE_MIN..1]; 1 = fully solid. */
  occ: number;
}

/**
 * A per-cell render record for the FOG OF WAR (issue 2 / boss #3). Each cell owns:
 *  - `group`: the dungeon tiles (floor/walls/props/stairs) sitting IN this cell — hidden
 *    until the cell is first explored, then revealed.
 *  - `fog`: a grid-aligned BLACK CUBE filling this cell's volume — the "black liquid
 *    shadow". Shown while UNexplored (so the cell reads as solid ink that lines up to the
 *    grid), hidden once explored. Because it is grid geometry (not a screen overlay), it
 *    always aligns — that fixes the "misaligned black rectangles" complaint.
 * Reveal flows by BFS over REACHABLE neighbours (wallMask connectivity), not a raw radius.
 */
interface CellRec {
  cx: number; cz: number; sy: number;
  /** grid coords + stratum, for the BFS over reachable neighbours. */
  col: number; row: number; stratum: number;
  /** which sides are walled (bit 1=+X 2=-X 4=+Z 8=-Z): a walled side blocks BFS flow. */
  wallMask: number;
  /** true for a real walkable cell (BFS only flows between walkable cells). */
  walkable: boolean;
  group: THREE.Group;
  /** the grid-aligned black cube hiding this cell while unexplored (null for stair extras). */
  fog: THREE.Mesh | null;
  explored: boolean;
  /** smooth reveal ∈ [0,1]; eases 0→1 after `explored` (no popping). */
  reveal: number;
  /** materials in this cell whose opacity we drive for the reveal fade. */
  mats: THREE.Material[];
}

/**
 * WALK THE STRAIGHT LINE from one grid cell to another, asking `blocked` at every step.
 *
 * A SUPERCOVER walk: it advances one axis at a time rather than taking a diagonal step, so the path
 * is contiguous and sight can never slip between two walls that meet at a corner. `blocked(c, r, bit)`
 * is asked about the cell being LEFT and the direction of travel — `wallMask` bits are
 * 1 = +X, 2 = -X, 4 = +Z, 8 = -Z.
 *
 * Pure and exported so it can be tested on a grid of numbers, with no renderer and no scene.
 */
export function traceSight(
  fromCol: number, fromRow: number, col: number, row: number,
  blocked: (c: number, r: number, bit: number) => boolean,
): boolean {
  let c = fromCol, r = fromRow;
  let dc = col - c, dr = row - r;
  const sc = Math.sign(dc), sr = Math.sign(dr);
  dc = Math.abs(dc); dr = Math.abs(dr);
  let err = dc - dr;
  for (let guard = 0; guard < 2 * (dc + dr) + 2; guard++) {
    if (c === col && r === row) return true;
    const e2 = 2 * err;
    let stepC = 0, stepR = 0;
    if (e2 > -dr && dc > 0) { stepC = sc; err -= dr; }
    else if (dr > 0) { stepR = sr; err += dc; }
    else return true;
    const bit = stepC > 0 ? 1 : stepC < 0 ? 2 : stepR > 0 ? 4 : 8;
    if (blocked(c, r, bit)) return false;
    c += stepC; r += stepR;
  }
  return false;
}

export class Dungeon {
  readonly group = new THREE.Group();
  private readonly tpl = new Map<string, THREE.Object3D>();
  /** Phase-4b tile-unit templates, keyed BY URL (the IR's `WorldPlacement.unit.url`). Preloaded in
   *  load() from the remastered pack and recolored like the shell; cloned by `placeUnit`. */
  private readonly unitTpl = new Map<string, THREE.Object3D>();
  /** Per-stratum subgroups (+ their surface Y) so floors ABOVE the player can be culled. */
  private strata: { surfaceY: number; group: THREE.Group }[] = [];
  /** Per-cell records for fog-of-war + smooth reveal. */
  private cells: CellRec[] = [];
  /** Walls that participate in the camera→player occlusion cutaway. */
  private walls: WallRec[] = [];
  /** Exact stair placements from the sim (origin/dir/width/run/rise) so the KayKit staircase
   *  aligns to the collision. Empty for the sandbox / legacy heuristic fallback. */
  private stairInfos: StairInfo[] = [];
  /** Real tiling CC0 PBR materials (stone/wood/metal/gold) assigned by mesh class. */
  private readonly materials = new DungeonMaterials();
  /** When true (?raw / ?theme=raw|none), skip recolor and show the ORIGINAL flat KayKit atlas —
   *  recolor's "Raw atlas" mode, mirrored from the lab (lab.ts `?raw=1`). */
  private rawColoring = false;
  /** DEBUG A/B (?shell=classic): texture the shell the OLD way — one fixed PBR material per
   *  surface KIND (classifySurface → get()), no per-pixel recolor. For comparison. */
  private classicShell = false;
  /** DEV (?fog=off): reveal every cell at build (no black fog cubes) — for inspecting generation. */
  private fogOff = false;
  /** DEV (?bare=1): floor mesh ONLY on ROOM (template) cells, so corridors read as empty and the
   *  placed room templates stand out — "constrain to emptiness to see what templates are placed". */
  private bareTemplates = false;
  /** Shared opaque BLACK material for the fog cubes (the "black liquid shadow" fill). */
  private readonly fogMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
  /** Index from a packed (stratum,row,col) key → CellRec, for the reachable-cell BFS. */
  private readonly cellIndex = new Map<number, CellRec>();
  /** scratch vectors (avoid per-frame alloc). */
  private readonly _v = new THREE.Vector3();
  private readonly _camToPlayer = new THREE.Vector3();
  private readonly _camToWall = new THREE.Vector3();

  /** Preload all tile templates (await before building / before the loop). */
  async load(): Promise<void> {
    // REAL MATERIALS: load the CC0 tiling PBR sets first (the FLAME path + ?shell=classic use them).
    await this.materials.load();
    // COLORING ENGINE — the game now re-skins the whole KayKit pack with the LAB's recolor engine
    // (lab/recolor.ts), the SAME per-pixel, gradient-preserving coloring the lab uses, so the
    // in-game dungeon matches the lab and can't drift when the lab's authoring changes. recolor
    // resolves the look as a pure function of each model's URL via a base→folder→object cascade
    // (see recolor.ts) — there is no multi-scheme selection, so the dungeon has ONE canonical look.
    //
    // TODO(publish): recolor's mapping tables (ROLE_PRESET / FOLDER_OVERRIDES / OBJECT_OVERRIDES in
    // recolor.ts + SWATCHES in palette.ts) are still imported from src/lab. When a baked theme
    // manifest is emitted (e.g. a *.generated.ts of the compiled mapping), read THAT here instead
    // of importing the lab tables, and reintroduce ?theme=<scheme> if multiple schemes are baked.
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    // ?raw / ?theme=raw|none → show the original flat KayKit atlas (recolor's "Raw atlas" mode,
    // mirrors the lab's ?raw=1). recolor has no color SCHEMES, so other ?theme= values are inert.
    const themeParam = params.get('theme');
    this.rawColoring = params.get('raw') === '1' || themeParam === 'raw' || themeParam === 'none';
    this.classicShell = params.get('shell') === 'classic';
    this.fogOff = params.get('fog') === 'off';
    this.bareTemplates = params.get('bare') === '1';

    // THE TILING ARRAYS MUST EXIST BEFORE THE FIRST RECOLOR.
    // applyRecolor bakes colour + the ORM slot, then hands the material to patchTilingDetail — which
    // returns early, silently, if the texture arrays have not been built. The lab always awaited this
    // (world-object.ts does it alongside the GLB load) and the game never did, so the tower has been
    // rendering flat baked colour this whole time: no grain, no relief, no per-texel roughness, no AO.
    // Nothing errored, the dungeon just quietly looked like painted blocks.
    // One await, once, before any template is coloured. Idempotent — a no-op when the config's
    // texture set is unchanged, so it costs nothing on later calls.
    if (!this.rawColoring && !this.classicShell) await ensureTilingTextures();

    const loader = new GLTFLoader();
    const loaded = await Promise.all(Object.entries(TILES).map(async ([k, file]) => {
      const g = await loader.loadAsync(DIR + file);
      await this.themeTemplate(k, file, g.scene);
      return [k, g.scene] as const;
    }));
    for (const [k, scene] of loaded) this.tpl.set(k, scene);

    // Phase-4b (docs/16 §10): preload the remastered TILE-UNIT pieces, keyed by url. The IR's
    // `WorldPlacement.unit.url` references these directly (the same urls PIECE names sim-side), so the
    // renderer can clone them in `placeUnit`. First pass uses LIVE recolor (applyRecolor by url) — the
    // same pure-function coloring the shell uses; applying the FROZEN `unit.materials` recipe (which
    // box-fit/approve already saved) is the follow-up (docs/16 §10: "the renderer applies, not
    // re-derives"). A url that fails recolor keeps its original atlas (still visible), never untextured.
    /* BOTH CATALOGUES. This preloaded only the 4u `tile-place` pieces, and `placeUnit` drops a
       placement whose url has no template with a bare `return` — so every mesh that exists only in the
       2u catalogue was silently absent from the world. Measured on a 40x40x3 tower: 415 of 2,761
       placements, which was every staircase, every torch, every scaffold and every doorway.
       The IR is produced by two compilers and the renderer serves both, so it has to know both. */
    const unitUrls = [...new Set([...Object.values(PIECE), ...Object.values(CELL_PIECE)])];
    const unitLoaded = await Promise.all(unitUrls.map(async (url) => {
      const g = await loader.loadAsync(stripFragment(url));
      if (wantsOpen(url)) openDoorLeaves(g.scene);
      if (!this.rawColoring && !this.classicShell) applyRecolor(g.scene, url, 'position');
      g.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      return [url, g.scene] as const;
    }));
    for (const [url, scene] of unitLoaded) this.unitTpl.set(url, scene);
  }

  /** Tiles with live flames keep the emissive applyMaterial path so the torch/candle glow
   *  (which feeds bloom = the dungeon's cheap lighting) survives the re-skin. */
  private static readonly FLAME_TILES = new Set(['torch', 'candle', 'candleTriple', 'shelfCandles']);

  /**
   * Re-skin one KayKit template with the LAB's recolor engine (lab/recolor.ts) — the SAME
   * per-pixel, gradient-preserving coloring the lab uses, invoked exactly as world-object.ts does:
   * `applyRecolor(scene, meshUrl, 'position')`. recolor identifies each atlas pixel's SWATCH, keeps
   * its baked Lightness (the gradient/shading), and swaps Hue+Sat to the swatch's mapped tint with a
   * baked roughness/metalness map — so the whole pack reskins uniformly off one cascade, with NO
   * geometry splitting (hence no speckle to collapse, no per-triangle tolerance). The look is a pure
   * function of the model's URL: recolor's folder/object cascade (kaykit_dungeon → bed_decorated, …)
   * resolves greys-as-bedding/iron etc. itself, so the game passes the model URL and nothing else.
   *
   * FLAME tiles (torch/candle) instead keep the emissive applyMaterial path so their orange glow
   * (which feeds bloom = the dungeon's cheap lighting) survives the re-skin. ?shell=classic and
   * ?raw fall back to the PBR-by-class / original-atlas looks for A/B comparison.
   */
  private async themeTemplate(tileKey: string, url: string, scene: THREE.Object3D): Promise<void> {
    if (Dungeon.FLAME_TILES.has(tileKey)) {
      scene.traverse((o) => this.applyMaterial(tileKey, o as THREE.Mesh));
      return;
    }
    if (this.classicShell) { // ?shell=classic — the OLD per-kind PBR look (A/B comparison)
      scene.traverse((o) => this.applyMaterial(tileKey, o as THREE.Mesh));
      return;
    }
    if (this.rawColoring) { // ?raw / ?theme=raw — keep the original flat KayKit atlas, just shadows
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      return;
    }
    // RECOLOR (the whole coloring system). Pass the FULL model URL (models/kaykit_dungeon/<file>)
    // so recolor's folder/object cascade resolves; 'position' = the same swatch-id method the lab
    // uses. recolor assigns the baked material on every mesh + sets shadows. If the model has no
    // atlas (returns null), fall back to PBR-by-class so the piece is never left untextured.
    const resolved = applyRecolor(scene, DIR + url, 'position');
    if (!resolved) scene.traverse((o) => this.applyMaterial(tileKey, o as THREE.Mesh));
    return Promise.resolve();
  }

  /**
   * REAL MATERIALS: swap a KayKit mesh's flat gradient-atlas material for a genuine
   * tiling PBR material picked by SurfaceKind (stone/floor/wood/metal/gold). 'flame'
   * surfaces (torches/candles) KEEP their KayKit material but get boosted to emissive so
   * they glow + feed bloom (cheap "lighting"). Used for FLAME tiles, ?shell=classic, and as the
   * fallback when a model has no recolor atlas (so a piece is never left untextured).
   */
  private applyMaterial(tileKey: string, mesh: THREE.Mesh): void {
    if (!mesh.isMesh) return;
    const orig = mesh.material as THREE.MeshStandardMaterial | undefined;
    const matName = orig?.name ?? '';
    const kind = classifySurface(tileKey, matName, mesh.name);
    if (kind === 'flame') {
      // torch/candle flame: make the bright orange material glow (bloom), keep its look.
      if (orig && orig.color && orig.color.r > 0.5 && orig.color.g < 0.75 && orig.color.b < 0.5) {
        orig.emissive = new THREE.Color(0xff8a1e);
        orig.emissiveIntensity = 1.8;
        orig.needsUpdate = true;
      }
      return;
    }
    const pbr = this.materials.get(kind);
    if (pbr) mesh.material = pbr;
  }

  /** Build the dungeon geometry for all strata; each CELL gets its own group (for fog). */
  /**
   * PROPS AND TORCHES. Off makes a plain dungeon that builds far faster — on a 2u tower the dressing is
   * thousands of extra meshes and point lights, one scatter roll per cell, and the cells are four times
   * as many as the 4u tower it was tuned for. Nothing about the layout changes.
   */
  private dressing = true;
  /**
   * Pieces dropped for want of a host cell. This is the ONE path that turns the IR into geometry, and
   * a bare `return` here is how a floor loses walls with nobody noticing — it measures 0 today, which
   * is exactly the condition under which a silent drop stays invisible until it isn't.
   */
  private hostless = 0;
  /** The cell the last line-of-sight trace ran from, so standing still costs nothing. */
  private lastLosCell = -1;
  /**
   * Urls the IR asked for that no template was loaded for. A missing template used to be a bare
   * `return` and that is how fifteen percent of the world went missing without a word — the compiler
   * emitted it, the renderer had never heard of it, and nothing anywhere said so.
   */
  private readonly noTemplate = new Set<string>();
  /** One torch every N walled cells. Tuned for 4u; a 2u grid has four times the cells for the same
   *  floor, so the same number means four times the torches. */
  private torchEvery = 11;
  setDressing(on: boolean, torchEvery = 11): void { this.dressing = on; this.torchEvery = Math.max(1, torchEvery); }

  build(grids: StratumCellGrid[], stairs?: StairInfo[]): void {
    this.hostless = 0;
    this.lastLosCell = -1;
    this.noTemplate.clear();
    this.group.clear();
    this.strata = [];
    this.cells = [];
    this.cellIndex.clear();
    this.walls = [];
    this.stairInfos = stairs ?? [];
    let lights = 0;
    for (const grid of grids) {
      const cs = toFloat(fromRaw(grid.cellSize));
      const sy = toFloat(fromRaw(grid.surfaceY));
      const scale = cs / NATIVE_CELL;
      const h = cs / 2;
      const sub = new THREE.Group();
      // index cells for neighbour lookups (corner detection, stair orientation, themes)
      const byRC = new Map<number, CellTile>();
      for (const c of grid.cells) byRC.set(c.row * grid.width + c.col, c);
      const isFloor = (col: number, row: number): boolean => {
        if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
        const c = byRC.get(row * grid.width + col);
        return !!c && c.type !== 'VOID' && c.type !== 'WALL';
      };
      // WALLS / DOORWAYS / PILLARS are no longer inferred per-cell here — they come from the
      // unified wall IR (grid.wallPlacements) in a dedicated pass below (buildWallsFromSlots),
      // the SAME pieces collision consumes, so render matches collision by construction (docs/13 §C-bis).
      for (const c of grid.cells) {
        if (c.type === 'VOID') continue;
        const cx = toFloat(fromRaw(c.cx)), cz = toFloat(fromRaw(c.cz));
        const cg = new THREE.Group();
        const mats: THREE.Material[] = [];
        const walkable = (c.type === 'ROOM' || c.type === 'CORRIDOR' || c.type === 'DOORWAY' || c.stair) && !c.hole;
        // ?bare: floor only on template (ROOM) cells so corridors read as empty and templates pop.
        // Floor mesh is chosen by the room's ROLE material (wood/dirt/stone) so rooms read distinctly.
        // ...unless the grid brought its own ground (see StratumCellGrid.providesFloors)
        if (walkable && !grid.providesFloors && (!this.bareTemplates || c.roomId >= 0)) {
          this.placeRoleFloor(cg, c.roomRole, cx, sy, cz, scale, mats);
        }
        // (KayKit STAIRS are placed in a dedicated pass below from the sim's exact StairInfo,
        //  not per-cell — see placeStairsExact, so the model lines up with the collision.)

        // Torch placement still keys off the per-cell wallMask (a projection of the slots): a
        // walled cell is a good spot for an emissive torch. Walls themselves are placed later
        // from grid.wallPlacements (buildWallsFromSlots).
        const m = c.wallMask;

        // a deterministic scatter of torches (emissive → lighting) on walled cells
        if (this.dressing && m !== 0 && this.hash(c.col, c.row, 17) % this.torchEvery === 0) {
          this.place(cg, 'torch', cx, sy + cs * 0.55, cz, 0, scale * 0.9, mats);
          if (lights < MAX_TORCH_LIGHTS) {
            const L = new THREE.PointLight(0xffa64d, 18, cs * 2.6, 2);
            L.position.set(cx, sy + cs * 0.6, cz);
            cg.add(L); lights++;
          }
        }

        // ROOM PERSONALITY (issue 5): furnish ROOM cells with a themed prop, deterministically.
        if (this.dressing && c.type === 'ROOM' && !c.stair && !c.hole) {
          this.decorateRoomCell(cg, c, grid, byRC, isFloor, cx, sy, cz, scale, h, mats);
        }

        cg.visible = this.fogOff;     // fog: hidden until explored (?fog=off → shown immediately)
        sub.add(cg);
        // BLACK FOG CUBE (boss #3): a grid-aligned black box filling this cell's column,
        // shown while UNexplored, hidden on reveal. Grid geometry → always lines up.
        const fog = this.makeFogCube(cx, sy, cz, cs);
        fog.visible = !this.fogOff;
        sub.add(fog);
        const rec: CellRec = {
          cx, cz, sy, col: c.col, row: c.row, stratum: grid.stratum,
          wallMask: c.wallMask, walkable, group: cg, fog,
          explored: this.fogOff, reveal: this.fogOff ? 1 : 0, mats,
        };
        this.cells.push(rec);
        this.cellIndex.set(this.cellKey(grid.stratum, c.col, c.row), rec);
      }

      /* VOID cells — the holes and the gaps between rooms. They get ink too, so an unexplored
         region reads as one continuous mass rather than a shape with bites out of it. But a void is
         something you can SEE ACROSS AND DOWN THROUGH, and it used to be recorded with `wallMask: 15`
         — sealed on all four sides — so the flood could neither enter nor leave one and the ink over
         a hole never lifted. Standing beside a shaft you got a black box where the floor below should
         be, permanently. A void blocks nothing; it is `wallMask: 0`. */
      for (const c of grid.cells) {
        if (c.type !== 'VOID') continue;
        const cx = toFloat(fromRaw(c.cx)), cz = toFloat(fromRaw(c.cz));
        const fog = this.makeFogCube(cx, sy, cz, cs);
        fog.visible = !this.fogOff;
        sub.add(fog);
        const rec: CellRec = {
          cx, cz, sy, col: c.col, row: c.row, stratum: grid.stratum,
          wallMask: 0, walkable: false, group: new THREE.Group(), fog,
          explored: this.fogOff, reveal: this.fogOff ? 1 : 0, mats: [],
        };
        this.cells.push(rec);
        this.cellIndex.set(this.cellKey(grid.stratum, c.col, c.row), rec);
      }

      // WALLS from the wall IR (after both cell passes so every host CellRec exists). One tile unit
      // per placement — inherently deduped, no edge-key sets.
      this.buildWallsFromSlots(grid, sy);

      // KAYKIT STAIRS (issue 7 / boss #2): place each staircase from the sim's EXACT
      // StairInfo so the model lines up with the collision treads + the ascent hole. One
      // model per StairInfo on THIS stratum. The stair model is parented to the stair-foot
      // CELL's group, so it reveals / culls / hides exactly with that grid cell's fog (its
      // fog cube already covers the column — no separate fog state needed).
      for (const si of this.stairInfos) {
        if (si.stratum !== grid.stratum) continue;
        // the stair-foot cell: the lower-Z column of the pair, at the run's entry row.
        const footCol = si.cols[0];
        const footRow = this.rowFromZ(grid, toFloat(fromRaw(si.originZ)));
        const host = this.cellIndex.get(this.cellKey(grid.stratum, footCol, footRow))
          ?? this.cellIndex.get(this.cellKey(grid.stratum, si.cols[1], footRow));
        const target = host ? host.group : sub;
        this.placeStairsExact(target, si, host ? host.mats : []);
      }

      this.group.add(sub);
      this.strata.push({ surfaceY: sy, group: sub });
    }
    /* A piece dropped for want of a host cell is invisible geometry, and this is the only path that
       makes geometry. Say so rather than returning quietly — it reads 0 today, which is precisely
       when a silent drop can start firing without anyone finding out. */
    if (this.noTemplate.size > 0) {
      console.warn(`[dungeon] no template for ${this.noTemplate.size} url(s) — those pieces are NOT in `
        + `the world: ${[...this.noTemplate].map((u) => u.split('/').pop()).join(', ')}`);
    }
    if (this.hostless > 0) {
      console.warn(`[dungeon] ${this.hostless} piece(s) dropped: no walkable cell to host them`);
    }
  }

  /**
   * Place wall meshes from the wall IR (`grid.wallPlacements`) — one concrete tile UNIT per entry, the
   * SAME units the collision compiler reads (tower.ts emitWallsFromSlots), so render == collision by
   * construction (docs/16 §10 Path A). Each unit is the remastered-pack GLB at its (x,z) with its
   * turn/scale/y; `placeUnit` clones it through the recolor + fog-reveal + occlusion-cutaway path.
   */
  private buildWallsFromSlots(grid: StratumCellGrid, sy: number): void {
    for (const wp of grid.wallPlacements) this.placeUnit(grid, wp, sy);
  }

  /** turn (quarter-turns CCW 0..3) → Three.js yaw. Matches `tile-units.ts rot()` so mesh == collider. */
  private static readonly TURN_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

  /**
   * Phase-4b (docs/16 §10, Path A): place ONE concrete tile UNIT — a remastered-pack GLB referenced by
   * `wp.unit.url` — through the SAME recolor + fog-reveal + occlusion-cutaway path the abstract pieces
   * use, so render == collision (both branch on `wp.unit`) and the unit fades/reveals like its cell.
   *
   * Transform is the IR's: position (wp.x, sy + unit.y, wp.z); rotation.y = turn·90° CCW; uniform
   * scale = toFloat(unit.scale) (CELL_SIZE 4 / NATIVE 4 → 1). The materials are LIVE-recolored at
   * preload (see load()); applying the frozen `unit.materials` recipe instead is the noted follow-up.
   * Parented to the nearest walkable cell (placementHost) so it reveals/culls with that cell's fog;
   * materials are CLONED so the occlusion cutaway can fade this piece independently (as placeWall does).
   */
  private placeUnit(grid: StratumCellGrid, wp: WorldPlacement, sy: number): void {
    const u = wp.unit!;
    const t = this.unitTpl.get(u.url);
    if (!t) { this.noTemplate.add(u.url); return; }   // never silently: see `noTemplate`
    const x = toFloat(fromRaw(wp.x)), z = toFloat(fromRaw(wp.z));
    const host = this.placementHost(grid, x, z);
    if (!host) { this.hostless++; return; } // a VOID seam with no walkable cell to host/reveal it
    const o = t.clone(true);
    o.position.set(x, sy + toFloat(u.y), z);
    o.rotation.y = Dungeon.TURN_YAW[((u.turn % 4) + 4) % 4]!;
    o.scale.setScalar(toFloat(u.scale));
    // Clone this unit's materials so the occlusion cutaway drives THIS piece's opacity alone (the
    // recolor material is shared across every piece). Mirrors placeWall. View-only.
    const cloneMat = (m: THREE.Material): THREE.Material => {
      // cloneMaterial, not m.clone(): a bare clone drops onBeforeCompile and the whole piece loses
      // its tiling shader. See src/lab/tiling.ts.
      const cl = cloneMaterial(m);
      cl.userData = { ...cl.userData, occ: true };
      cl.transparent = true;
      host.mats.push(cl);
      return cl;
    };
    o.traverse((mn) => {
      const mesh = mn as THREE.Mesh;
      const mm = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mm)) mesh.material = mm.map(cloneMat);
      else if (mm) mesh.material = cloneMat(mm);
    });
    host.group.add(o);
    // Occlusion face axis (approx from the quarter-turn: 0/180 face ±Z, 90/270 face ±X) — good enough
    // for the cutaway; a corner unit picks one axis. Render==collision doesn't depend on this.
    const faceAxis: 'X' | 'Z' = (((u.turn % 2) + 2) % 2 === 0) ? 'Z' : 'X';
    this.walls.push({ obj: o, x, z, axis: faceAxis, occ: 1 });
  }

  /**
   * The nearest WALKABLE cell to a wall placement at (x,z) — to host the piece so it fog-reveals
   * with that cell. A placement sits on a lattice-square centre that may be a cell centre OR a
   * cell-face line (half a cell off), so we invert the grid centering (cell col center =
   * (col − ⌊(W-1)/2⌋)·cs) to the containing cell, then probe it + its 8 neighbours and pick the
   * nearest walkable one. Returns null when no walkable cell is adjacent (a perimeter VOID seam).
   */
  private placementHost(grid: StratumCellGrid, x: number, z: number): CellRec | null {
    const cs = toFloat(fromRaw(grid.cellSize));
    const cHalfCols = (grid.width - 1) >> 1;
    const cHalfRows = (grid.height - 1) >> 1;
    const c0 = Math.round(x / cs + cHalfCols);
    const r0 = Math.round(z / cs + cHalfRows);
    let best: CellRec | null = null;
    let bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rec = this.cellIndex.get(this.cellKey(grid.stratum, c0 + dc, r0 + dr));
        if (!rec || !rec.walkable) continue;
        const ddx = x - rec.cx, ddz = z - rec.cz;
        const d = ddx * ddx + ddz * ddz;
        if (d < bestD) { bestD = d; best = rec; }
      }
    }
    return best;
  }

  /**
   * A grid-aligned black SLAB capping one cell's floor — the "black liquid shadow" fill.
   *
   * WORLD-grid-aligned geometry (never camera-facing / never a screen overlay): it lies
   * flat on the cell's floor plane so an UNEXPLORED cell reads as a pool of solid ink that
   * lines up exactly to the grid (fixing the "misaligned black rectangles"). It is only a
   * FULL cell/wall-height column (per request: the low slab wasn't tall enough): an unexplored
   * cell's tiles/props/walls are HIDDEN (cell.group.visible = false), so the ink stands in for
   * them as a solid black wall the same height as the masonry. Oversized in X/Z so neighbouring
   * slabs overlap seamlessly. Shared opaque material. */
  private makeFogCube(cx: number, sy: number, cz: number, cs: number): THREE.Mesh {
    /* WALL height, not CELL height. This was `cs` with a note that "cs is about wall height" — true
       when a cell was 4u, and wrong ever since the 2u substrate became the default: cells are 2 and
       walls are 4, so every block of ink stood at half the height of the walls around it and the
       unexplored region read as a low kerb rather than a solid mass. A hair taller than the wall so
       no lit rim shows over the top. */
    const height = NATIVE_WALL_H * 1.02;
    const box = new THREE.Mesh(new THREE.BoxGeometry(cs * 1.04, height, cs * 1.04), this.fogMat);
    // straddle the floor plane so the ink sits just over the floor tile and a touch above.
    box.position.set(cx, sy + height / 2 - 0.1, cz);
    box.renderOrder = 2;                     // draw after tiles so the ink reliably covers them
    return box;
  }

  /** Packed (stratum,row,col) key for the cell index used by the reachable-cell BFS. */
  private cellKey(stratum: number, col: number, row: number): number {
    return (stratum * 4096 + row) * 4096 + col;
  }

  /** The grid row whose cell-center Z is closest to world Z `z` (to host a stair model). */
  private rowFromZ(grid: StratumCellGrid, z: number): number {
    let best = 0, bestD = Infinity;
    for (const c of grid.cells) {
      const cz = toFloat(fromRaw(c.cz));
      const d = Math.abs(cz - z);
      if (d < bestD) { bestD = d; best = c.row; }
    }
    return best;
  }


  // --------------------------------------------------------------------------
  // STAIRS (issue 7 / boss #2) — EXACT placement from the sim's StairInfo
  // --------------------------------------------------------------------------

  /**
   * EXACT stair placement (boss #2: "stairs aren't aligned yet"). The sim gives the
   * precise staircase box in `StairInfo` (raw Q16.16). We drop the KayKit `stairs.glb`
   * onto it 1:1, matching how the collision treads were emitted in tower.ts (emitStair):
   *
   *   - native model: X ∈ [-2.5, 2.5] (width 5, CENTERED on its origin), Y ∈ [0, 5.1]
   *     (rise, base at Y=0), Z ∈ [0, 4.0] (run, ENTRY at Z=0, ascends toward +Z).
   *   - StairInfo: width / rise / run (raw), dir = (0, +1) (straight, ascends +Z),
   *     centerX (run centre in X), originY = source surface, originZ = entryZ (run foot).
   *
   * So: SCALE by (width/5.0, rise/5.1, run/4.0); the model's local +Z already maps to
   * world +Z (dirZ = +1) → NO yaw; POSITION at (centerX, originY, originZ) so the model's
   * centred width straddles centerX, its base sits on the source surface, and its entry
   * step (local Z=0) lands at entryZ — flush with the treads, rising into the ascent hole.
   * View-only; reads only the deterministic StairInfo (no float divergence into the sim).
   */
  private placeStairsExact(cg: THREE.Group, si: StairInfo, mats: THREE.Material[]): void {
    const t = this.tpl.get('stairs');
    if (!t) return;
    const width = toFloat(fromRaw(si.width));
    const rise = toFloat(fromRaw(si.rise));
    const run = toFloat(fromRaw(si.run));
    const centerX = toFloat(fromRaw(si.centerX));
    const originY = toFloat(fromRaw(si.originY));
    const originZ = toFloat(fromRaw(si.originZ));
    const o = t.clone(true);
    // local +Z ascends toward +Z (dirZ=+1); straight stairs need no yaw.
    o.rotation.y = 0;
    o.scale.set(width / NATIVE_STAIR_W, rise / NATIVE_STAIR_H, run / NATIVE_STAIR_RUN);
    // X: model is centred (span [-2.5,2.5]) → put its centre on centerX.
    // Y: model base at local 0 → put it on the source surface (originY).
    // Z: model entry at local 0 → put it at the run foot (originZ = entryZ).
    o.position.set(centerX, originY, originZ);
    o.traverse((m) => { const mm = (m as THREE.Mesh).material as THREE.Material | undefined; if (mm) mats.push(mm); });
    cg.add(o);
  }

  // --------------------------------------------------------------------------
  // ROOM PERSONALITY (issue 5)
  // --------------------------------------------------------------------------

  /**
   * Furnish a ROOM cell with one themed prop, deterministically. A THEME is chosen per
   * roomId (library / dining / bedroom / storage / armory / treasure / shrine), and props
   * are placed only on cells with an adjacent WALL (so furniture lines the walls, not the
   * middle of a path) — except a few center pieces. Props never sit on doorways/stairs/holes
   * (filtered by the caller), and we leave the cell center clear unless the prop is small.
   */
  private decorateRoomCell(
    cg: THREE.Group, c: CellTile, grid: StratumCellGrid, byRC: Map<number, CellTile>,
    isFloor: (col: number, row: number) => boolean,
    cx: number, sy: number, cz: number, scale: number, h: number, mats: THREE.Material[],
  ): void {
    // density: ~1 in 2 eligible cells gets a prop (deterministic).
    const roll = this.hash(c.col, c.row, 101);
    if (roll % 100 >= 48) return;

    // theme = the room's ROLE (set sim-side in tower.ts, so structure + objects agree). Index order
    // matches floor/room-roles.ts ROOM_ROLES: 0 hall · 1 library · 2 dining · 3 bedroom · 4 storage ·
    // 5 armory · 6 treasure · 7 shrine. Fall back to a coord hash for a room cell missing a role.
    const theme = c.roomRole >= 0 ? c.roomRole : (c.col + c.row) % 8;
    // a wall this cell sits against (for "against the wall" placement + facing into room)
    const m = c.wallMask;
    const againstWall = m !== 0;
    // pick the side/normal pointing INTO the room from the wall (so props face inward)
    let wallDir: [number, number] | null = null; // unit (dx,dz) pointing away from the wall
    if (m & 1) wallDir = [-1, 0];       // wall on +X → face -X
    else if (m & 2) wallDir = [1, 0];   // wall on -X → face +X
    else if (m & 4) wallDir = [0, -1];  // wall on +Z → face -Z
    else if (m & 8) wallDir = [0, 1];   // wall on -Z → face +Z
    const faceYaw = wallDir ? Math.atan2(wallDir[0], wallDir[1]) : (roll % 4) * Math.PI / 2;
    // nudge a "wall-hugging" prop back toward its wall so it doesn't block the cell center
    const offX = wallDir ? -wallDir[0] * h * 0.55 : 0;
    const offZ = wallDir ? -wallDir[1] * h * 0.55 : 0;

    type Spec = { name: string; s: number; hug: boolean; yOff?: number; faceWall?: boolean };
    let pick: Spec | null = null;
    const r2 = this.hash(c.col, c.row, 211) % 100;
    switch (theme) {
      case 0: // HALL — a feast/throne hall: banners high on walls, long tables down the middle, braziers
        if (againstWall) pick = r2 < 55 ? { name: r2 < 28 ? 'bannerRed' : 'bannerBlue', s: scale, hug: true, faceWall: true, yOff: 1.6 }
          : r2 < 80 ? { name: 'candleTriple', s: scale, hug: true } : null;
        else pick = r2 < 55 ? { name: r2 < 30 ? 'tableCloth' : 'tableLong', s: scale * 0.95, hug: false }
          : r2 < 75 ? { name: 'chair', s: scale, hug: false } : { name: 'coinsM', s: scale, hug: false };
        break;
      case 1: // LIBRARY — tall bookshelves against walls + a reading table
        if (againstWall) pick = r2 < 70 ? { name: 'shelves', s: scale, hug: true, faceWall: true } : { name: 'shelfLarge', s: scale, hug: true, faceWall: true };
        else if (r2 < 40) pick = { name: 'tableMedium', s: scale * 0.9, hug: false };
        break;
      case 2: // DINING — long tables (center) + chairs + plates/bottles
        if (!againstWall && r2 < 55) pick = { name: r2 < 28 ? 'tableCloth' : 'tableLong', s: scale * 0.9, hug: false };
        else if (againstWall && r2 < 60) pick = { name: 'chair', s: scale, hug: true, faceWall: false };
        else if (r2 < 80) pick = { name: r2 < 70 ? 'plates' : 'bottleA', s: scale, hug: false, yOff: 0 };
        break;
      case 3: // BEDROOM — beds against walls, a small table
        if (againstWall) pick = r2 < 75 ? { name: 'bed', s: scale * 0.9, hug: true, faceWall: true } : { name: 'bedFrame', s: scale * 0.9, hug: true, faceWall: true };
        else if (r2 < 35) pick = { name: 'tableSmall', s: scale, hug: false };
        break;
      case 4: // STORAGE — barrels, crates, boxes (anywhere)
        pick = r2 < 30 ? { name: 'crates', s: scale * 0.85, hug: againstWall }
          : r2 < 55 ? { name: 'barrel', s: scale * 0.85, hug: againstWall }
          : r2 < 78 ? { name: 'barrelStack', s: scale * 0.9, hug: againstWall }
          : { name: 'boxStack', s: scale * 0.85, hug: againstWall };
        break;
      case 5: // ARMORY — weapon racks (sword_shield) on walls + crates
        if (againstWall) pick = r2 < 65 ? { name: 'swordShield', s: scale, hug: true, faceWall: true, yOff: 1.4 } : { name: 'shelfCandles', s: scale, hug: true, faceWall: true };
        else if (r2 < 35) pick = { name: 'crates', s: scale * 0.85, hug: false };
        break;
      case 6: // TREASURE — chests, coins, a gold chest center
        if (!againstWall && r2 < 40) pick = { name: 'chestGold', s: scale, hug: false };
        else if (r2 < 70) pick = { name: r2 < 50 ? 'chest' : 'coinsL', s: scale, hug: againstWall };
        else pick = { name: 'coinsM', s: scale, hug: againstWall };
        break;
      default: // 7 SHRINE / RUINED — rubble, candles, banners, a shrine table
        if (againstWall && r2 < 45) pick = { name: 'bannerRed', s: scale, hug: true, faceWall: true, yOff: 0 };
        else if (r2 < 60) pick = { name: 'rubbleHalf', s: scale * 0.8, hug: againstWall };
        else if (r2 < 80) pick = { name: 'candleTriple', s: scale, hug: againstWall };
        else pick = { name: 'tableSmall', s: scale, hug: false };
        break;
    }
    if (!pick) return;
    void isFloor; void grid; void byRC;
    const px = cx + (pick.hug ? offX : 0);
    const pz = cz + (pick.hug ? offZ : 0);
    const yaw = pick.faceWall ? faceYaw : (this.hash(c.col, c.row, 313) % 4) * Math.PI / 2;
    this.place(cg, pick.name, px, sy + (pick.yOff ?? 0), pz, yaw, pick.s, mats);
  }

  /** Deterministic small hash of (col,row,salt) → unsigned int. No Math.random (docs/06 §0). */
  private hash(col: number, row: number, salt: number): number {
    let x = (col * 73856093) ^ (row * 19349663) ^ (salt * 83492791);
    x = (x ^ (x >>> 13)) >>> 0;
    x = Math.imul(x, 0x5bd1e995) >>> 0;
    return (x ^ (x >>> 15)) >>> 0;
  }

  /**
   * FOG OF WAR (issue 2 / boss #3) — REVEAL FLOWS ALONG REACHABLE CELLS.
   *
   * Each frame: for every crew body, find the cell it stands in and BFS outward up to
   * FOG_BFS_DEPTH steps over REACHABLE neighbours — a neighbour is reachable only if NO
   * wall separates the two cells (wallMask) AND it is a walkable cell. This is a graph
   * flood over connected rooms/corridors, NOT a raw distance radius, so reveal spreads
   * THROUGH doorways into adjacent rooms but never bleeds through a solid wall.
   *
   * Reveal is PERSISTENT (once a cell is seen it stays seen): an explored cell shows the
   * dungeon while its BLACK FOG CUBE is hidden, and an unexplored one stays solid grid-
   * aligned ink (the "black liquid shadow"). `radius`/`dt` are unused now (the reveal is a
   * graph flood + a visibility toggle) but kept so the caller's signature is unchanged.
   */
  reveal(bodies: readonly { x: number; y: number; z: number }[], _radius: number, _dt = 0): void {
    /* 1) REVEAL. Two mechanisms, and they answer different questions.
       LINE OF SIGHT is what you can actually see: everything on an unobstructed straight line, however
       far, INCLUDING voids — which is what lets a shaft beside you show the floor below instead of a
       block of ink. The FLOOD is the short "around the corner" sense, a few cells of awareness through
       doorways and up stairs that sight cannot reach. Sight is unbounded by design and the flood is
       deliberately small; together they read as "I can see it, or I am nearly touching it". */
    for (const b of bodies) {
      const start = this.cellAt(b.x, b.y, b.z);
      if (!start) continue;
      this.lineOfSightReveal(start);
      this.floodReveal(start);
    }
    // 2) drive the per-cell fade + fog cube from the `explored` flag.
    for (const cell of this.cells) {
      if (cell.explored) {
        cell.group.visible = true;
        cell.reveal = 1;
        // The black fog cube is hidden the moment the cell is explored — a pure VISIBILITY
        // toggle (not opacity): the PBR tile materials AND the fog material are SHARED across
        // thousands of cells, so driving per-cell opacity on them would change every cell at
        // once. The reveal reads as the dungeon appearing as the grid-aligned ink lifts off.
        if (cell.fog) cell.fog.visible = false;
      } else {
        cell.group.visible = false;
        cell.reveal = 0;
        if (cell.fog) cell.fog.visible = true;
      }
    }
  }

  /** DEV/verify only: force every cell explored (reveal the whole tower for screenshots). */
  revealAll(): void {
    for (const c of this.cells) c.explored = true;
  }

  /**
   * CAMERA FRAMING (boss #1/#2): a PROXIMITY-WEIGHTED summary of the EXPLORED (lit,
   * visible) walkable cells on the player's stratum near (x,z). Returns the weighted
   * centroid plus a `spread` (RMS reach, u) of those cells, so the camera can both AIM at
   * the lit mass and DOLLY to fit it. Weight falls off with distance (1/(1+d²/τ)) so the
   * player's own room dominates while far corridor cells only nudge — this points the
   * opening view at the lit dungeon instead of the perimeter void, which is what made an
   * edge/corner spawn render all-black (the player sits at the arena edge and a naive
   * player-centered, fixed-heading look pointed the boresight into unexplored ink).
   * Returns null when nothing nearby is explored yet. View-only; reads only reveal state.
   */
  exploredFrameNear(x: number, y: number, z: number): { x: number; z: number; spread: number } | null {
    const TAU = 18 * 18; // distance² (u²) at which a cell's weight halves (~4 cells)
    let sw = 0, sx = 0, sz = 0, n = 0;
    for (const cell of this.cells) {
      if (!cell.walkable || !cell.explored) continue;
      if (Math.abs(y - cell.sy) > 3) continue; // same stratum only
      const dx = cell.cx - x, dz = cell.cz - z;
      const w = 1 / (1 + (dx * dx + dz * dz) / TAU);
      sw += w; sx += cell.cx * w; sz += cell.cz * w; n++;
    }
    if (n === 0 || sw <= 0) return null;
    const cx = sx / sw, cz = sz / sw;
    // weighted RMS spread of lit cells about the weighted centroid → how far to dolly.
    let sv = 0, svw = 0;
    for (const cell of this.cells) {
      if (!cell.walkable || !cell.explored) continue;
      if (Math.abs(y - cell.sy) > 3) continue;
      const dx = cell.cx - x, dz = cell.cz - z;
      const w = 1 / (1 + (dx * dx + dz * dz) / TAU);
      const ex = cell.cx - cx, ez = cell.cz - cz;
      sv += (ex * ex + ez * ez) * w; svw += w;
    }
    const spread = svw > 0 ? Math.sqrt(sv / svw) : 0;
    return { x: cx, z: cz, spread };
  }

  /** The walkable CellRec a world point sits in (nearest cell on the matching stratum). */
  private cellAt(x: number, y: number, z: number): CellRec | null {
    let best: CellRec | null = null;
    let bestD = Infinity;
    for (const cell of this.cells) {
      if (!cell.walkable) continue;
      if (Math.abs(y - cell.sy) > 3) continue; // same stratum only
      const dx = x - cell.cx, dz = z - cell.cz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = cell; }
    }
    return best;
  }

  /**
   * BFS from `start` over REACHABLE neighbours up to FOG_BFS_DEPTH steps, marking each as
   * explored. A move from cell A to neighbour B is allowed only when A has no wall on the
   * side facing B (wallMask bit clear) and B is a walkable cell — i.e. they are connected
   * (same room, or through a doorway), never wall-separated. Cheap (a few dozen cells).
   */
  /**
   * Everything the player can SEE from `start`, revealed at once.
   *
   * A supercover walk of the straight line to each candidate cell: step by step, and the moment a step
   * crosses a wall the line stops. A void blocks nothing (`wallMask: 0`), so sight carries across a
   * shaft and the ink over it lifts — the whole point of the exercise.
   *
   * Cost is bounded by FOG_LOS_RANGE, and the whole pass is skipped unless the player CHANGED CELL,
   * so standing still costs nothing.
   */
  private lineOfSightReveal(start: CellRec): void {
    const key = this.cellKey(start.stratum, start.col, start.row);
    if (this.lastLosCell === key) return;     // same cell as last frame; nothing new is visible
    this.lastLosCell = key;

    const R = FOG_LOS_RANGE;
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        if (dc * dc + dr * dr > R * R) continue;            // a circle, not a square
        const target = this.cellIndex.get(this.cellKey(start.stratum, start.col + dc, start.row + dr));
        if (!target || target.explored) continue;
        if (this.sightClear(start, start.col + dc, start.row + dr)) target.explored = true;
      }
    }
  }

  /** Is the straight line from `from` to (col,row) unobstructed? See `traceSight`. */
  private sightClear(from: CellRec, col: number, row: number): boolean {
    return traceSight(from.col, from.row, col, row, (c, r, bit) => {
      const cell = this.cellIndex.get(this.cellKey(from.stratum, c, r));
      return cell === undefined || (cell.wallMask & bit) !== 0;   // off the map, or a wall in the way
    });
  }

  private floodReveal(start: CellRec): void {
    // wallMask bits: 1=+X(col+1) 2=-X(col-1) 4=+Z(row+1) 8=-Z(row-1)
    const steps: ReadonlyArray<readonly [number, number, number]> = [
      [1, 1, 0], [2, -1, 0], [4, 0, 1], [8, 0, -1],
    ];
    const queue: { rec: CellRec; depth: number }[] = [{ rec: start, depth: 0 }];
    const seen = new Set<number>([this.cellKey(start.stratum, start.col, start.row)]);
    while (queue.length) {
      const { rec, depth } = queue.shift()!;
      rec.explored = true;
      if (depth >= FOG_BFS_DEPTH) continue;
      for (const [bit, dc, dr] of steps) {
        if ((rec.wallMask & bit) !== 0) continue; // a wall on this side blocks the flow
        const nb = this.cellIndex.get(this.cellKey(rec.stratum, rec.col + dc, rec.row + dr));
        if (!nb || !nb.walkable) continue;
        const key = this.cellKey(nb.stratum, nb.col, nb.row);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ rec: nb, depth: depth + 1 });
      }
    }
  }

  /**
   * OCCLUSION CUTAWAY (issue 1): fade out any wall that sits BETWEEN the camera and the
   * local player so the player is always visible (isometric cutaway); restore walls that no
   * longer block. A wall occludes if it is within OCCLUDE_RADIUS of the player horizontally,
   * is NEARER the camera than the player (along the camera→player axis), and is on the
   * correct facing side (its outward axis faces the camera). Fades are eased for smoothness.
   */
  occlude(camera: THREE.Camera, player: { x: number; y: number; z: number }, dt: number): void {
    camera.getWorldPosition(this._v);
    const camX = this._v.x, camY = this._v.y, camZ = this._v.z;
    this._camToPlayer.set(player.x - camX, player.y - camY, player.z - camZ);
    const playerDist = this._camToPlayer.length();
    this._camToPlayer.normalize();
    const k = 1 - Math.exp(-OCCLUDE_FADE_RATE * Math.max(dt, 1 / 240));
    for (const wr of this.walls) {
      let occluding = false;
      const dxp = wr.x - player.x, dzp = wr.z - player.z;
      if (dxp * dxp + dzp * dzp <= OCCLUDE_RADIUS * OCCLUDE_RADIUS) {
        this._camToWall.set(wr.x - camX, player.y - camY, wr.z - camZ);
        const wallDist = this._camToWall.length();
        // nearer the camera than the player (in front of them from the camera's view)
        if (wallDist < playerDist - 0.4) {
          // and roughly along the camera→player ray (so we only drop walls that are
          // actually in front of the player on screen, not off to the side)
          const along = (this._camToWall.x * this._camToPlayer.x + this._camToWall.y * this._camToPlayer.y + this._camToWall.z * this._camToPlayer.z) / Math.max(wallDist, 1e-3);
          if (along > 0.6) occluding = true;
        }
      }
      const target = occluding ? OCCLUDE_MIN_OPACITY : 1;
      wr.occ += (target - wr.occ) * k;
      if (Math.abs(wr.occ - target) < 0.01) wr.occ = target;
      wr.obj.traverse((o) => {
        const mat = (o as THREE.Mesh).material as (THREE.Material & { opacity: number; transparent: boolean }) | undefined;
        if (!mat || mat.userData?.['occ'] !== true) return;
        mat.opacity = wr.occ;
        mat.transparent = wr.occ < 1;
        mat.depthWrite = wr.occ > 0.95;
      });
    }
  }

  /**
   * Hide strata whose floor is ABOVE the view height (so the floor of the level above the
   * player never occludes them) — the dungeon equivalent of the coalescence reveal.
   */
  cull(viewY: number): void {
    for (const s of this.strata) s.group.visible = s.surfaceY <= viewY + 2.5;
  }

  /**
   * A small KayKit world-object prop (barrel / crate / box) cloned + sized to a body's
   * radius, replacing the renderer's placeholder coloured cubes for throwables (so no
   * abstract programmer-art cubes remain in the dungeon). View-only; `seed` picks a
   * deterministic variant. Returns null before templates load (caller falls back to a box).
   */
  propFor(radius: number, halfHeight: number, seed: number): THREE.Object3D | null {
    const variants = ['barrel', 'crates', 'boxStack', 'barrelStack'] as const;
    const name = variants[(seed >>> 0) % variants.length]!;
    const t = this.tpl.get(name);
    if (!t) return null;
    const o = t.clone(true);
    // KayKit props are ~2 units wide/tall native; scale so the prop roughly fills the body AABB.
    const sxz = (radius * 2) / 1.9;
    const sy = (halfHeight * 2) / 2.0;
    o.scale.set(sxz, sy, sxz);
    o.rotation.y = ((seed >>> 3) % 4) * Math.PI / 2;
    // recenter: KayKit props sit on y=0 (their base); offset down so the body center aligns.
    o.position.y = -halfHeight;
    const wrap = new THREE.Group();
    wrap.add(o);
    return wrap;
  }

  /** Place a floor tile chosen by the room's ROLE material (mirrors floor/room-roles.ts roleFloor):
   *  library/bedroom → wood, storage/armory/shrine → dirt, else (incl. corridors, role -1) → stone.
   *  Uses the remastered floor pieces (same pack as the walls) so the shell reads consistently. */
  private placeRoleFloor(cg: THREE.Group, roomRole: number, cx: number, sy: number, cz: number, scale: number, mats: THREE.Material[]): void {
    const url = (roomRole === 1 || roomRole === 3) ? PIECE.floorWood
      : (roomRole === 4 || roomRole === 5 || roomRole === 7) ? PIECE.floorDirt
      : PIECE.floorStone;
    const t = this.unitTpl.get(url);
    if (!t) return;
    const o = t.clone(true);
    o.position.set(cx, sy, cz);
    o.scale.setScalar(scale);
    o.traverse((m) => { const mm = (m as THREE.Mesh).material as THREE.Material | undefined; if (mm) mats.push(mm); });
    cg.add(o);
  }

  private place(target: THREE.Group, name: string, x: number, y: number, z: number, rotY: number, scale: number, mats?: THREE.Material[]): THREE.Object3D | null {
    const t = this.tpl.get(name);
    if (!t) return null;
    const o = t.clone(true);
    o.position.set(x, y, z);
    o.rotation.y = rotY;
    o.scale.setScalar(scale);
    if (mats) o.traverse((m) => { const mm = (m as THREE.Mesh).material as THREE.Material | undefined; if (mm) mats.push(mm); });
    target.add(o);
    return o;
  }

}
