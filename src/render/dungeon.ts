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

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toFloat, fromRaw } from '../sim/fixed/fixed.ts';
import type { StratumCellGrid, CellTile, StairInfo } from '../game/tower.ts';
import { DungeonMaterials, classifySurface } from './materials.ts';

const DIR = 'models/kaykit_dungeon/';
/** The KayKit tiles we use (CC0, downloaded to public/models/kaykit_dungeon/). */
const TILES: Record<string, string> = {
  floor: 'floor_tile_large.glb',
  wall: 'wall.glb',
  wallHalf: 'wall_half.glb',
  doorway: 'wall_doorway.glb',
  pillar: 'pillar.glb',
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
const FOG_BFS_DEPTH = 30;
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

export class Dungeon {
  readonly group = new THREE.Group();
  private readonly tpl = new Map<string, THREE.Object3D>();
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
    // REAL MATERIALS (issue 6 / boss #1): load the CC0 tiling PBR sets first, then assign
    // them to every mesh by material CLASS so walls read as stone, chests/tables as wood,
    // swords/coins as metal/gold — replacing KayKit's flat gradient-atlas swatches.
    await this.materials.load();
    const loader = new GLTFLoader();
    const loaded = await Promise.all(Object.entries(TILES).map(async ([k, file]) => {
      const g = await loader.loadAsync(DIR + file);
      g.scene.traverse((o) => this.applyMaterial(k, o as THREE.Mesh));
      return [k, g.scene] as const;
    }));
    for (const [k, scene] of loaded) this.tpl.set(k, scene);
  }

  /**
   * REAL MATERIALS: swap a KayKit mesh's flat gradient-atlas material for a genuine
   * tiling PBR material picked by SurfaceKind (stone/floor/wood/metal/gold). 'flame'
   * surfaces (torches/candles) KEEP their KayKit material but get boosted to emissive so
   * they glow + feed bloom (cheap "lighting"). The mesh's original UVs are ignored — the
   * PBR material projects world-space UVs, so the texture tiles at a physical scale and
   * never smears. Deterministic + view-only (no sim contact).
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
  build(grids: StratumCellGrid[], stairs?: StairInfo[]): void {
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
      const corners = new Set<string>(); // dedupe pillars at shared corner points
      const wallEdges = new Set<string>(); // dedupe walls: one piece per shared edge
      const doorEdges = new Set<string>(); // edges that are through-doorways (never walled over)
      // PASS 0: collect every DOORWAY edge first, so a neighbouring cell's wallMask can never
      // wall over an opening (a door must go all the way through — coordinator structural ask).
      for (const c of grid.cells) {
        if (c.type !== 'DOORWAY') continue;
        const cx = toFloat(fromRaw(c.cx)), cz = toFloat(fromRaw(c.cz));
        const m = c.wallMask;
        // a doorway cell's OPEN sides (cleared bits) that connect into a room are the openings.
        // we mark every edge of a doorway cell that faces a floor neighbour as a door edge.
        for (const [bit, ex, ez] of [[1, h, 0], [2, -h, 0], [4, 0, h], [8, 0, -h]] as const) {
          if (m & bit) continue; // a walled side of the doorway cell is not an opening
          doorEdges.add(this.edgeKey(cx + ex, cz + ez));
        }
      }
      for (const c of grid.cells) {
        if (c.type === 'VOID') continue;
        const cx = toFloat(fromRaw(c.cx)), cz = toFloat(fromRaw(c.cz));
        const cg = new THREE.Group();
        const mats: THREE.Material[] = [];
        const walkable = (c.type === 'ROOM' || c.type === 'CORRIDOR' || c.type === 'DOORWAY' || c.stair) && !c.hole;
        if (walkable) this.place(cg, 'floor', cx, sy, cz, 0, scale, mats);
        // (KayKit STAIRS are placed in a dedicated pass below from the sim's exact StairInfo,
        //  not per-cell — see placeStairsExact, so the model lines up with the collision.)

        // WALLS — one piece per shared edge (no stacked/back-to-back walls), inset onto THIS
        // cell's interior side so it never straddles into the neighbour and leaves a clean
        // flat surface for props on the room side. Doorways stay a FULL-thickness opening
        // spanning the whole edge (passable + see-through); other cells never wall over a
        // doorway edge. (Coordinator structural ask.) wallMask: 1=+X 2=-X 4=+Z 8=-Z.
        const m = c.wallMask;
        const isDoor = c.type === 'DOORWAY';
        // inset distance: half the wall's scaled depth, so the wall's OUTER face lands on the
        // cell-edge boundary and its body sits inside this cell.
        const inset = 0.5 * scale;
        // side: [bit, edge dx, edge dz, rotation, occlude-axis, neighbour dcol, neighbour drow]
        const sides: ReadonlyArray<readonly [number, number, number, number, 'X' | 'Z', number, number]> = [
          [1, h, 0, Math.PI / 2, 'X', 1, 0],    // east edge at +X
          [2, -h, 0, Math.PI / 2, 'X', -1, 0],  // west edge at -X
          [4, 0, h, 0, 'Z', 0, 1],              // north edge at +Z
          [8, 0, -h, 0, 'Z', 0, -1],            // south edge at -Z
        ];
        for (const [bit, ex, ez, rot, axis, dc, dr] of sides) {
          const edgeX = cx + ex, edgeZ = cz + ez;
          const key = this.edgeKey(edgeX, edgeZ);
          const inX = ex === 0 ? 0 : -Math.sign(ex) * inset;
          const inZ = ez === 0 ? 0 : -Math.sign(ez) * inset;
          if ((m & bit) !== 0) {
            // SOLID wall on this side. Skip if it would wall over a doorway opening, or if a
            // neighbour cell already owns this shared edge (dedupe → no stacked walls).
            if (doorEdges.has(key) && !isDoor) continue;
            if (wallEdges.has(key)) continue;
            wallEdges.add(key);
            this.placeWall(cg, edgeX + inX, sy, edgeZ + inZ, rot, scale, axis, mats);
          } else if (isDoor && isFloor(c.col + dc, c.row + dr)) {
            // OPEN side of a DOORWAY cell facing a room: a FULL-thickness arch frame centered
            // on the edge — a clean see-through opening the player passes through. Deduped so
            // the two cells sharing the opening place exactly one arch (door leaf: the KayKit
            // pack ships no standalone door leaf, so the opening is left clear per spec).
            if (wallEdges.has(key)) continue;
            wallEdges.add(key);
            this.place(cg, 'doorway', edgeX, sy, edgeZ, rot, scale, mats);
          }
        }

        // CORNER PILLARS at TRUE convex corners only (issue 4). At each of the cell's four
        // grid-corner points, look at the 4 cells around that point: a pillar belongs there
        // only where the floor/solid split forms an L (a convex turn) — exactly 1 or 3 of
        // the 4 cells are floor, OR they are diagonal (two rooms kissing at a corner). A
        // straight wall (2 adjacent floor) or open/closed (0/4 floor) gets NO pillar, which
        // is what removes the spurious posts at T-junctions and mid-runs.
        const tryCorner = (bx: number, bz: number): void => {
          if (!this.convexCorner(c.col, c.row, bx, bz, isFloor)) return;
          const px = cx + bx * h, pz = cz + bz * h;
          const key = `${Math.round(px * 8)},${Math.round(pz * 8)}`;
          if (corners.has(key)) return;
          corners.add(key);
          this.place(cg, 'pillar', px, sy, pz, 0, scale, mats); // full scale → full wall height (issue 3)
        };
        if (!c.stair && !c.hole) { tryCorner(1, 1); tryCorner(1, -1); tryCorner(-1, 1); tryCorner(-1, -1); }

        // a deterministic scatter of torches (emissive → lighting) on walled cells
        if (m !== 0 && this.hash(c.col, c.row, 17) % 11 === 0) {
          this.place(cg, 'torch', cx, sy + cs * 0.55, cz, 0, scale * 0.9, mats);
          if (lights < MAX_TORCH_LIGHTS) {
            const L = new THREE.PointLight(0xffa64d, 18, cs * 2.6, 2);
            L.position.set(cx, sy + cs * 0.6, cz);
            cg.add(L); lights++;
          }
        }

        // ROOM PERSONALITY (issue 5): furnish ROOM cells with a themed prop, deterministically.
        if (c.type === 'ROOM' && !c.stair && !c.hole) {
          this.decorateRoomCell(cg, c, grid, byRC, isFloor, cx, sy, cz, scale, h, mats);
        }

        cg.visible = false;     // fog: hidden until explored
        sub.add(cg);
        // BLACK FOG CUBE (boss #3): a grid-aligned black box filling this cell's column,
        // shown while UNexplored, hidden on reveal. Grid geometry → always lines up.
        const fog = this.makeFogCube(cx, sy, cz, cs);
        sub.add(fog);
        const rec: CellRec = {
          cx, cz, sy, col: c.col, row: c.row, stratum: grid.stratum,
          wallMask: c.wallMask, walkable, group: cg, fog,
          explored: false, reveal: 0, mats,
        };
        this.cells.push(rec);
        this.cellIndex.set(this.cellKey(grid.stratum, c.col, c.row), rec);
      }

      // VOID cells (no tile, the gaps between rooms) still get a black fog cube so the
      // unexplored footprint reads as continuous ink — covered, never a hole in the shadow.
      for (const c of grid.cells) {
        if (c.type !== 'VOID') continue;
        const cx = toFloat(fromRaw(c.cx)), cz = toFloat(fromRaw(c.cz));
        const fog = this.makeFogCube(cx, sy, cz, cs);
        sub.add(fog);
        const rec: CellRec = {
          cx, cz, sy, col: c.col, row: c.row, stratum: grid.stratum,
          wallMask: 15, walkable: false, group: new THREE.Group(), fog,
          explored: false, reveal: 0, mats: [],
        };
        this.cells.push(rec);
        this.cellIndex.set(this.cellKey(grid.stratum, c.col, c.row), rec);
      }

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
  }

  /**
   * A grid-aligned black SLAB capping one cell's floor — the "black liquid shadow" fill.
   *
   * WORLD-grid-aligned geometry (never camera-facing / never a screen overlay): it lies
   * flat on the cell's floor plane so an UNEXPLORED cell reads as a pool of solid ink that
   * lines up exactly to the grid (fixing the "misaligned black rectangles"). It is only a
   * LOW slab (not a full-height column) on purpose: an unexplored cell's tiles/props/walls
   * are HIDDEN (cell.group.visible = false), so there is nothing to poke through — the slab
   * only has to hide the FLOOR footprint. Keeping it low means the steep top-down camera
   * always sees ACROSS the ink instead of being walled into a black canyon. Oversized in
   * X/Z so neighbouring slabs overlap seamlessly. Shared opaque material. */
  private makeFogCube(cx: number, sy: number, cz: number, cs: number): THREE.Mesh {
    const height = Math.max(0.6, cs * 0.18); // a low ink slab, ~0.8u — never towers
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
  // CORNER detection (issue 4)
  // --------------------------------------------------------------------------

  /**
   * Is the grid-corner point at offset (bx,bz) of cell (col,row) — bx,bz ∈ {-1,+1} —
   * a TRUE convex corner where a pillar belongs? Examine the 4 cells touching that point
   * and count how many are FLOOR. A convex corner is exactly 1 floor (inner corner) or
   * exactly 3 floor (outer corner), or a diagonal 2 (two areas kissing). A straight wall
   * run (2 adjacent floor), fully open (4) or fully solid (0) is NOT a corner — that is
   * what kills the false pillars at T-junctions and along straight walls.
   */
  private convexCorner(col: number, row: number, bx: number, bz: number, isFloor: (c: number, r: number) => boolean): boolean {
    // the 4 cells around the corner point: this cell + its two edge-neighbours + the diagonal
    const a = isFloor(col, row);
    const b = isFloor(col + bx, row);
    const d = isFloor(col, row + bz);
    const e = isFloor(col + bx, row + bz);
    const n = (a ? 1 : 0) + (b ? 1 : 0) + (d ? 1 : 0) + (e ? 1 : 0);
    if (n === 1 || n === 3) return true;          // L (inner / outer convex corner)
    if (n === 2 && a === e && b === d && a !== b) return true; // diagonal kiss (two convex corners)
    return false;                                  // straight run / T-junction / open / solid
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

    const theme = (c.roomId >= 0 ? c.roomId : (c.col + c.row)) % 7;
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
      case 0: // LIBRARY — tall bookshelves against walls + a reading table
        if (againstWall) pick = r2 < 70 ? { name: 'shelves', s: scale, hug: true, faceWall: true } : { name: 'shelfLarge', s: scale, hug: true, faceWall: true };
        else if (r2 < 40) pick = { name: 'tableMedium', s: scale * 0.9, hug: false };
        break;
      case 1: // DINING — long tables (center) + chairs + plates/bottles
        if (!againstWall && r2 < 55) pick = { name: r2 < 28 ? 'tableCloth' : 'tableLong', s: scale * 0.9, hug: false };
        else if (againstWall && r2 < 60) pick = { name: 'chair', s: scale, hug: true, faceWall: false };
        else if (r2 < 80) pick = { name: r2 < 70 ? 'plates' : 'bottleA', s: scale, hug: false, yOff: 0 };
        break;
      case 2: // BEDROOM — beds against walls, a small table
        if (againstWall) pick = r2 < 75 ? { name: 'bed', s: scale * 0.9, hug: true, faceWall: true } : { name: 'bedFrame', s: scale * 0.9, hug: true, faceWall: true };
        else if (r2 < 35) pick = { name: 'tableSmall', s: scale, hug: false };
        break;
      case 3: // STORAGE — barrels, crates, boxes (anywhere)
        pick = r2 < 30 ? { name: 'crates', s: scale * 0.85, hug: againstWall }
          : r2 < 55 ? { name: 'barrel', s: scale * 0.85, hug: againstWall }
          : r2 < 78 ? { name: 'barrelStack', s: scale * 0.9, hug: againstWall }
          : { name: 'boxStack', s: scale * 0.85, hug: againstWall };
        break;
      case 4: // ARMORY — weapon racks (sword_shield) on walls + crates
        if (againstWall) pick = r2 < 65 ? { name: 'swordShield', s: scale, hug: true, faceWall: true, yOff: 1.4 } : { name: 'shelfCandles', s: scale, hug: true, faceWall: true };
        else if (r2 < 35) pick = { name: 'crates', s: scale * 0.85, hug: false };
        break;
      case 5: // TREASURE — chests, coins, a gold chest center
        if (!againstWall && r2 < 40) pick = { name: 'chestGold', s: scale, hug: false };
        else if (r2 < 70) pick = { name: r2 < 50 ? 'chest' : 'coinsL', s: scale, hug: againstWall };
        else pick = { name: 'coinsM', s: scale, hug: againstWall };
        break;
      default: // 6 SHRINE / RUINED — rubble, candles, banners, a shrine table
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
    // 1) BFS newly-reachable cells from each body's cell (mark `explored`, persistent).
    for (const b of bodies) {
      const start = this.cellAt(b.x, b.y, b.z);
      if (!start) continue;
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

  /**
   * Place a solid cell-edge wall using the KayKit `wall_half` piece and register it for the
   * occlusion cutaway (issue 1). `wall_half` is anchored at one end (local x ∈ [0,2]); we
   * scale it ×2 along its length and shift back so it covers the full cell edge centered on
   * (x,z) — a single one-cell-owned piece (no stacked/straddling walls), inset by the caller
   * so its body sits on the room side and presents a flat surface for props.
   */
  private placeWall(target: THREE.Group, x: number, y: number, z: number, rotY: number, scale: number, axis: 'X' | 'Z', mats: THREE.Material[]): void {
    const t = this.tpl.get('wallHalf');
    if (!t) return;
    const o = t.clone(true);
    o.position.set(x, y, z);
    o.rotation.y = rotY;
    // scale ×2 along the wall length (native 2 → full 4-unit edge) then recenter the anchor.
    o.scale.set(scale * 2, scale, scale);
    // the piece extends from its origin toward +localX; after rotY it points along the edge.
    // recenter: move back by one native unit (2 * scale) along the edge direction.
    const edgeDir = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    o.position.addScaledVector(edgeDir, -2 * scale);
    // CLONE this wall's material so the OCCLUSION CUTAWAY can fade THIS wall's opacity
    // independently (the shared PBR stone material is reused across every wall, so we must
    // give each occluding wall its own instance to drive). View-only.
    o.traverse((mn) => {
      const mesh = mn as THREE.Mesh;
      const mm = mesh.material as THREE.Material | undefined;
      if (mm) {
        const cl = mm.clone();
        cl.userData = { ...cl.userData, occ: true };
        cl.transparent = true;
        mesh.material = cl;
        mats.push(cl);
      }
    });
    target.add(o);
    this.walls.push({ obj: o, x, z, axis, occ: 1 });
  }

  /** A stable key for a shared cell-EDGE midpoint (world x,z) so two cells dedupe to one wall. */
  private edgeKey(x: number, z: number): string {
    return `${Math.round(x * 8)},${Math.round(z * 8)}`;
  }
}
