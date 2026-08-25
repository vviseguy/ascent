// The per-group texture phase is invisible in a unit test — it happens in a shader. What IS testable
// is the contract the shader depends on, and every one of these is a bug that would read as a
// rendering fault rather than a data fault:
//
//   0. A MESH WITH NO SAVED GROUP IS NOT TOUCHED. This is the invariant the whole feature rests on:
//      variation is something you AUTHOR, so anything nobody authored must reach the renderer as the
//      identical geometry object it would have reached it as before this file existed. (The shader
//      half of that is VARY_CODE.none === 1 — see below.)
//   1. every vertex of a triangle carries ONE anchor (else a paver tears along a shared corner)
//   2. triangle ORDER and COUNT survive (else every stored hidden/group index points elsewhere)
//   3. the geometry HASH still matches after anchoring (else the store rejects its own edits)
//   4. a saved group varies and everything around it does NOT
//   5. NUMERICALLY: the phase either side of a seam is EQUAL where it must be and different where
//      it must be. Coordination is the absence of a change, and an absence is the one thing that
//      cannot be certified by looking at a render of photographic stone.
//   6. and on the REAL asset: two abutting placements of one tile agree on the anchor of the paver
//      they SHARE, bit for bit. That is the whole cross-tile half of the feature, and it is the one
//      claim a render genuinely cannot settle — see the last block in this file.
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
// The store the GAME ships, not a fixture: the seam tests below are only worth anything if they run
// against the pavers a human actually authored.
import realStore from '../game/mesh-surfaces.json' with { type: 'json' };
import {
  applyGroupAnchors, groupWorldAnchor, phaseKeyString, GROUP_ANCHOR_ATTR, VARY_CODE, VARY_INHERIT,
} from './group-anchors.ts';
import {
  applyHiddenFaces, geometryHash, setSurfaceStore, sourceGeometry, triCount, SOURCE_GEOM,
  EMPTY_SURFACES, type SurfaceGroup, type SurfaceStore,
} from './face-surfaces.ts';

/** A V-valley: two quads meeting at a shared bottom edge. The fold is CONCAVE, so the two wings are
 *  different regions — and the two valley vertices are shared by both, which is exactly the case
 *  that forces a vertex split. Vertices 0 and 1 are the valley; 2/3 and 4/5 are the two wings.
 *  Triangles 0-1 are the WEST wing, 2-3 the EAST one. */
function valley(): THREE.Mesh {
  const pos = new Float32Array([
    0, 0, 0, /*0*/ 0, 0, 1, /*1*/
    -1, 1, 0, /*2*/ -1, 1, 1, /*3*/
    1, 1, 0, /*4*/ 1, 1, 1, /*5*/
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6 * 2), 2));
  g.setIndex([0, 1, 3, 0, 3, 2, 0, 4, 5, 0, 5, 1]);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial());
}

/** Two squares far apart with no shared vertex — the easy case (nothing to split). Triangles 0-1
 *  are the square at x = 0..1, triangles 2-3 the one at x = 10..11. */
function twoIslands(): THREE.Mesh {
  const quad = (x: number): number[] => [x, 0, 0, x + 1, 0, 0, x + 1, 0, 1, x, 0, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...quad(0), ...quad(10)]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial());
}

/** Put one authored entry in the store for a mesh, hash included so it validates. */
function author(mesh: THREE.Mesh, url: string, groups: SurfaceGroup[]): void {
  setSurfaceStore({ version: 1, meshes: { [url]: { geom: geometryHash(mesh), hidden: {}, groups } } });
}

/** Read the vec4 anchor attribute back as one entry per vertex. */
function anchors(mesh: THREE.Mesh): { xyz: string; w: number }[] {
  const a = mesh.geometry.getAttribute(GROUP_ANCHOR_ATTR);
  const out: { xyz: string; w: number }[] = [];
  for (let v = 0; v < a.count; v++) {
    out.push({ xyz: `${a.getX(v).toFixed(4)},${a.getY(v).toFixed(4)},${a.getZ(v).toFixed(4)}`, w: a.getW(v) });
  }
  return out;
}

/** The anchors of a triangle's three corners, as seen through the geometry's own index. */
function triAnchors(mesh: THREE.Mesh, t: number): { xyz: string; w: number }[] {
  const idx = mesh.geometry.index!;
  const all = anchors(mesh);
  return [0, 1, 2].map((k) => all[idx.getX(t * 3 + k)]!);
}

/** Everything about a geometry a renderer can see, as a comparable string. */
function fingerprint(g: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const [name, attr] of Object.entries(g.attributes).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${name}:${attr.itemSize}:${Array.from({ length: attr.count * attr.itemSize },
      (_, k) => attr.getComponent(Math.floor(k / attr.itemSize), k % attr.itemSize)).join(',')}`);
  }
  parts.push('index:' + (g.index ? Array.from({ length: g.index.count }, (_, k) => g.index!.getX(k)).join(',') : 'none'));
  return parts.join('|');
}

beforeEach(() => setSurfaceStore(structuredClone(EMPTY_SURFACES)));

describe('group-anchors — nothing authored, nothing touched', () => {
  it('leaves the SAME geometry object in place, with no anchor attribute at all', () => {
    const mesh = twoIslands();
    const before = mesh.geometry;
    const printed = fingerprint(before);

    applyGroupAnchors(mesh, 'test://islands');

    // Not "identical contents" — the identical OBJECT. A rebuild that happens to produce the same
    // numbers still costs a buffer upload per template and still splits vertices, and the point of
    // the identity default is that an un-authored mesh is not in this feature at all.
    expect(mesh.geometry).toBe(before);
    expect(fingerprint(mesh.geometry)).toBe(printed);
    expect(mesh.geometry.getAttribute(GROUP_ANCHOR_ATTR)).toBeUndefined();
    // and nothing was parked, so sourceGeometry() is still just the geometry
    expect(mesh.userData[SOURCE_GEOM]).toBeUndefined();
    expect(sourceGeometry(mesh)).toBe(before);
  });

  it('code 1 is `none`, because that is what a MISSING attribute reads as', () => {
    // The other half of the invariant above, and the reason it is safe to bake nothing: GL's default
    // generic vertex attribute is (0,0,0,1), so a geometry with no `aGroupAnchor` hands the shader
    // w = 1 = none and `groupPhase` returns before it touches the UV. Any other numbering would make
    // an un-authored mesh vary by accident, which is the one thing this must never do.
    expect(VARY_CODE.none).toBe(1);
  });

  it('an authored MODEL does not drag its un-authored meshes in with it', () => {
    // Two meshes under one root, one url. Only mesh 0 is authored, so mesh 1 must come out untouched
    // — a group is a decision about a region, not a licence over the whole GLB.
    const a = twoIslands(); const b = twoIslands();
    const root = new THREE.Group(); root.add(a, b);
    const untouched = b.geometry;
    setSurfaceStore({
      version: 1,
      meshes: {
        'test://pair': {
          geom: geometryHash(root), hidden: {},
          groups: [{ id: 'left', name: 'left island', tris: { 0: [0, 1] } }],
        },
      },
    });

    applyGroupAnchors(root, 'test://pair');

    expect(a.geometry.getAttribute(GROUP_ANCHOR_ATTR)).toBeDefined();
    expect(b.geometry).toBe(untouched);
    expect(b.geometry.getAttribute(GROUP_ANCHOR_ATTR)).toBeUndefined();
  });

  it('an entry authored against DIFFERENT geometry is ignored, not applied blind', () => {
    const mesh = twoIslands();
    const before = mesh.geometry;
    setSurfaceStore({
      version: 1,
      meshes: {
        'test://islands': {
          geom: 'deadbeef',
          hidden: {},
          groups: [{ id: 'both', name: 'both', tris: { 0: [0, 1, 2, 3] }, vary: 'none' }],
        },
      },
    });
    applyGroupAnchors(mesh, 'test://islands');
    expect(mesh.geometry).toBe(before); // fell all the way back to identity
  });
});

describe('group-anchors — a saved group is the ONLY thing that varies', () => {
  it('the group gets its own anchor; everything around it is pinned to `none`', () => {
    const mesh = twoIslands();
    author(mesh, 'test://islands', [{ id: 'left', name: 'left island', tris: { 0: [0, 1] } }]);
    applyGroupAnchors(mesh, 'test://islands');

    // The authored island, asking the material TYPE what it is allowed to do. x is 0, not the
    // island's own centre of 0.5, because the island reaches the object's x = 0 face and a face a
    // neighbour could also be standing on outranks a centroid only this mesh can compute. y and z
    // span the whole object (it is flat and 1 deep), so both take the midpoint of the two faces.
    for (const t of [0, 1]) {
      expect(new Set(triAnchors(mesh, t).map((a) => a.xyz)).size).toBe(1);
      expect(triAnchors(mesh, t)[0]!.xyz).toBe('0.0000,0.0000,0.5000');
      expect(triAnchors(mesh, t)[0]!.w).toBe(VARY_INHERIT);
    }
    // the island nobody authored: the inert code, so the shader leaves it on the world projection
    for (const t of [2, 3]) {
      expect(triAnchors(mesh, t)[0]!.w).toBe(VARY_CODE.none);
      expect(triAnchors(mesh, t)[0]!.xyz).toBe('0.0000,0.0000,0.0000');
    }
  });

  it('carries its own `vary` override when it names one', () => {
    const mesh = twoIslands();
    author(mesh, 'test://islands', [
      { id: 'both', name: 'both islands', tris: { 0: [0, 1, 2, 3] }, vary: 'shift+rotate' },
    ]);
    applyGroupAnchors(mesh, 'test://islands');
    // one group now, so one anchor across the whole mesh — the midpoint of x = 0..1 and 10..11
    expect(new Set([0, 1, 2, 3].map((t) => triAnchors(mesh, t)[0]!.xyz)).size).toBe(1);
    expect(triAnchors(mesh, 0)[0]!.xyz).toBe('5.5000,0.0000,0.5000');
    for (const a of anchors(mesh)) expect(a.w).toBe(VARY_CODE['shift+rotate']);
  });

  it('a vertex the group and its surroundings both want is DUPLICATED, not fought over', () => {
    const mesh = valley();
    const before = triCount(mesh.geometry);
    author(mesh, 'test://valley', [{ id: 'west', name: 'west wing', tris: { 0: [0, 1] } }]);
    applyGroupAnchors(mesh, 'test://valley');

    // the valley edge is shared by the authored wing and the un-authored one, so exactly its two
    // vertices split
    expect(mesh.geometry.getAttribute('position').count).toBe(6 + 2);
    expect(triCount(mesh.geometry)).toBe(before);
    for (let t = 0; t < before; t++) expect(new Set(triAnchors(mesh, t).map((a) => a.xyz)).size).toBe(1);
    // west varies, east does not — no triangle wears half of each
    expect(triAnchors(mesh, 0)[0]!.w).toBe(VARY_INHERIT);
    expect(triAnchors(mesh, 2)[0]!.w).toBe(VARY_CODE.none);
  });

  it('the duplicated vertex keeps its POSITION — the mesh is unchanged geometry', () => {
    const mesh = valley();
    const centroids = (m: THREE.Mesh): string[] => {
      const p = m.geometry.getAttribute('position'), idx = m.geometry.index!;
      return Array.from({ length: triCount(m.geometry) }, (_, t) => {
        const v = new THREE.Vector3();
        for (let k = 0; k < 3; k++) v.add(new THREE.Vector3().fromBufferAttribute(p, idx.getX(t * 3 + k)));
        return v.multiplyScalar(1 / 3).toArray().map((n) => n.toFixed(5)).join(',');
      });
    };
    const src = new THREE.Mesh(mesh.geometry.clone(), mesh.material);
    author(mesh, 'test://valley', [{ id: 'west', name: 'west wing', tris: { 0: [0, 1] } }]);
    applyGroupAnchors(mesh, 'test://valley');
    expect(centroids(mesh)).toEqual(centroids(src));
  });
});

// ---------------------------------------------------------------------------------------------
// THE NUMERIC SEAM TEST
//
// Everything above checks the DATA. This checks the thing anyone actually cares about: for two
// triangles either side of a boundary, does the shader apply the SAME phase or a different one.
// `phaseKeyOf` returns exactly what `groupPhase` is a function of — the resolved mode plus the
// quantised WORLD anchor — so equal keys mean coordinated and different keys mean differentiated,
// with no hash to re-implement and no render to squint at.
//
// This is here because eyeballing was not good enough. Separation is a large, obvious change;
// coordination is the ABSENCE of one, and on photographic stone "the lines are subtle" — which is
// how a scope error survived a round of looking at renders.
// ---------------------------------------------------------------------------------------------
describe('group-anchors — the phase either side of a seam, as a number', () => {
  /** Two placements of one mesh, butted together along x — the wall-run case. */
  const placed = (make: () => THREE.Mesh, url: string, xs: number[]): THREE.Mesh[] =>
    xs.map((x) => {
      const m = make();
      applyGroupAnchors(m, url);
      m.position.x = x;
      m.updateMatrixWorld(true);
      return m;
    });

  it('an UN-AUTHORED seam is coordinated — both sides resolve to the identity', () => {
    // Two abutting panels of a wall nobody has authored. Different meshes, different world
    // positions, and still the same phase, because there is no phase: this is the continuity the
    // world-space projection gives away for free, and the thing varying-by-default destroyed.
    const [left, right] = placed(twoIslands, 'test://wall', [0, 2]);
    for (let t = 0; t < 4; t++) {
      expect(phaseKeyString(left!, t, 'shift+rotate')).toBe('identity');
      expect(phaseKeyString(right!, t, 'shift+rotate')).toBe('identity');
    }
    expect(phaseKeyString(left!, 3, 'shift+rotate')).toBe(phaseKeyString(right!, 0, 'shift+rotate'));
  });

  it('an AUTHORED group differs from the un-authored surface it is set into', () => {
    const mesh = valley();
    author(mesh, 'test://valley', [{ id: 'west', name: 'west wing', tris: { 0: [0, 1] } }]);
    applyGroupAnchors(mesh, 'test://valley');
    mesh.updateMatrixWorld(true);

    const west = phaseKeyString(mesh, 0, 'shift');
    const east = phaseKeyString(mesh, 2, 'shift');
    expect(east).toBe('identity');          // nobody authored it, so nothing moves it
    expect(west).not.toBe('identity');      // the decision took effect
    expect(west).not.toBe(east);
    // ...and the group is internally coordinated: its own two triangles must not come apart
    expect(phaseKeyString(mesh, 1, 'shift')).toBe(west);
  });

  it('two AUTHORED groups on one mesh get different phases', () => {
    const mesh = valley();
    author(mesh, 'test://valley', [
      { id: 'west', name: 'west wing', tris: { 0: [0, 1] } },
      { id: 'east', name: 'east wing', tris: { 0: [2, 3] } },
    ]);
    applyGroupAnchors(mesh, 'test://valley');
    mesh.updateMatrixWorld(true);
    expect(phaseKeyString(mesh, 0, 'shift')).not.toBe(phaseKeyString(mesh, 2, 'shift'));
  });

  it('the SAME group in two placements gets different phases — that is the whole point', () => {
    // 18,000 floor tiles share one geometry and one group. What separates them is the modelMatrix,
    // which is why the anchor is baked in OBJECT space and pushed to world in the vertex shader.
    setSurfaceStore({
      version: 1,
      meshes: {
        'test://tile': {
          geom: geometryHash(twoIslands()), hidden: {},
          groups: [{ id: 'paver', name: 'paver', tris: { 0: [0, 1] } }],
        },
      },
    });
    const [a, b] = placed(twoIslands, 'test://tile', [0, 2]);
    expect(phaseKeyString(a!, 0, 'shift')).not.toBe(phaseKeyString(b!, 0, 'shift'));
    // the second placement is exactly 2 m along, so the keys differ by 2 in x and nothing else
    expect(phaseKeyString(a!, 0, 'shift')).toBe('shift@0,0,0.5');
    expect(phaseKeyString(b!, 0, 'shift')).toBe('shift@2,0,0.5');
  });

  it('a texture that forbids variation collapses an inheriting group back to identity', () => {
    // The per-texture permission is a CEILING. A group that named no `vary` of its own asks the
    // material type, and a type wearing plank grain answers no.
    const mesh = valley();
    author(mesh, 'test://valley', [{ id: 'west', name: 'west wing', tris: { 0: [0, 1] } }]);
    applyGroupAnchors(mesh, 'test://valley');
    mesh.updateMatrixWorld(true);
    expect(phaseKeyString(mesh, 0, 'none')).toBe('identity');
    expect(phaseKeyString(mesh, 0, 'shift')).not.toBe('identity');
  });

  it("a group's own `vary` override beats the type, in both directions", () => {
    const mesh = valley();
    author(mesh, 'test://valley', [
      { id: 'west', name: 'west wing', tris: { 0: [0, 1] }, vary: 'shift+rotate' },
      { id: 'east', name: 'east wing', tris: { 0: [2, 3] }, vary: 'none' },
    ]);
    applyGroupAnchors(mesh, 'test://valley');
    mesh.updateMatrixWorld(true);
    // the type says `none`, but the west group overrode it
    expect(phaseKeyString(mesh, 0, 'none')).toContain('shift+rotate@');
    // the type says turn freely, but the east group opted out
    expect(phaseKeyString(mesh, 2, 'shift+rotate')).toBe('identity');
  });
});

describe('group-anchors — the ordering contract with hidden faces', () => {
  it('anchoring first still leaves the ORIGINAL geometry as the hash the store is checked against', () => {
    const mesh = twoIslands();
    const stored = geometryHash(mesh);
    setSurfaceStore({
      version: 1,
      meshes: {
        'test://islands': {
          geom: stored,
          hidden: { 0: [3] },
          groups: [{ id: 'left', name: 'left island', tris: { 0: [0, 1] } }],
        },
      },
    });

    applyGroupAnchors(mesh, 'test://islands');
    applyHiddenFaces(mesh, 'test://islands');

    // the picker and the store both read through sourceGeometry(): it must still be the ORIGINAL,
    // not the anchored rebuild, or a cold load rejects the very edit it just applied
    expect(geometryHash(new THREE.Mesh(sourceGeometry(mesh)))).toBe(stored);
    // ...while what actually renders is anchored AND filtered
    expect(mesh.geometry.getAttribute(GROUP_ANCHOR_ATTR)).toBeDefined();
    expect(triCount(mesh.geometry)).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// THE REAL ASSET, AND THE SEAM BETWEEN TWO TILES
//
// Everything above runs on hand-built fixtures, which prove the mechanism and nothing about the
// thing on screen. `floor_tile_large` is the mesh the feature exists for: 13 authored pavers, of
// which 8 are only HALF (or a QUARTER) of a stone — the other half lives in the next tile. Those
// are the ones that were breaking.
//
// The gate is a NUMBER, not a screenshot. Two abutting placements must produce the same world
// anchor for the shared paver BIT FOR BIT: a hash turns a one-ulp disagreement into a completely
// different phase, so "close" is indistinguishable from "wrong" and only exact means anything. A
// close-up render of a seam is corroboration; this is the proof.
// ---------------------------------------------------------------------------------------------
interface GltfJson {
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
}

/**
 * Minimal GLB -> BufferGeometry (positions + index, which is all the anchor pass reads).
 *
 * three's own GLTFLoader is not usable here: `parse` still routes materials through loaders that
 * want a DOM, and this suite runs in `environment: 'node'`. Reading the two chunks by hand is thirty
 * lines and has the property that matters — the numbers are the file's, untouched by a loader.
 */
function readGlb(url: URL): THREE.BufferGeometry {
  const buf = readFileSync(url);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('not a GLB with both chunks');
  const CTOR = { 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array } as const;
  const ITEMS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (i: number): Float32Array | Uint16Array | Uint32Array => {
    const a = json.accessors[i]!;
    const bv = json.bufferViews[a.bufferView]!;
    const T = CTOR[a.componentType as keyof typeof CTOR];
    const n = ITEMS[a.type];
    if (!T || !n) throw new Error(`unsupported accessor ${a.componentType}/${a.type}`);
    // An interleaved buffer would need a de-stride pass. This kit has none, and guessing wrong
    // would read plausible garbage rather than fail, so refuse instead.
    if (bv.byteStride !== undefined && bv.byteStride !== n * T.BYTES_PER_ELEMENT) {
      throw new Error(`interleaved accessor ${i} — this reader needs a de-stride pass`);
    }
    // Copy into a fresh ArrayBuffer rather than viewing the file buffer: node hands back a Buffer
    // pooled at an arbitrary byteOffset, and a Float32Array view needs 4-byte alignment.
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const bytes = new ArrayBuffer(a.count * n * T.BYTES_PER_ELEMENT);
    new Uint8Array(bytes).set(bin.subarray(base, base + bytes.byteLength));
    return new T(bytes);
  };
  const prim = json.meshes[0]!.primitives[0]!;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(read(prim.attributes['POSITION']!) as Float32Array, 3));
  if (prim.indices !== undefined) g.setIndex(new THREE.BufferAttribute(read(prim.indices), 1));
  return g;
}

describe('group-anchors — a paver split across two tiles is ONE stone', () => {
  const TILE_URL = 'models/kaykit_dungeon_remastered/floor_tile_large.gltf.glb';
  /** ONE geometry, shared by every placement — which is what the game does (`cloneSkeleton` clones
   *  the object graph and shares the buffers), and so what the anchor cache has to survive. */
  const source = readGlb(new URL('../../public/models/kaykit_dungeon_remastered/floor_tile_large.gltf.glb', import.meta.url));
  const store = realStore as unknown as SurfaceStore;
  const groups = store.meshes[TILE_URL]!.groups!;
  /** Any triangle of a named paver — the anchor is constant across a group, so the first will do. */
  const triOf = (id: string): number => groups.find((g) => g.id === id)!.tris['0']![0]!;

  /** A placed tile. `scale` 1 is a merged 4u block, 0.5 the per-cell draw — see cell-tower.ts. */
  function place(x: number, z: number, scale: number, turn = 0): THREE.Mesh {
    const m = new THREE.Mesh(source, new THREE.MeshStandardMaterial());
    applyGroupAnchors(m, TILE_URL);
    m.position.set(x, 0, z);
    m.scale.setScalar(scale);
    m.rotation.y = (turn * Math.PI) / 2;
    m.updateMatrixWorld(true);
    return m;
  }

  /** The world anchor of ONE triangle as its exact IEEE-754 bits. Equal strings = the same point. */
  function bitsAt(mesh: THREE.Mesh, tri: number): string {
    const a = groupWorldAnchor(mesh, tri)!;
    const dv = new DataView(new ArrayBuffer(24));
    [a.x, a.y, a.z].forEach((n, i) => dv.setFloat64(i * 8, n));
    return [0, 1, 2].map((i) => dv.getBigUint64(i * 8).toString(16).padStart(16, '0')).join(' ');
  }

  /** The world anchor as its exact IEEE-754 bits. Equal strings = the same point, to the last bit. */
  function anchorBits(mesh: THREE.Mesh, group: string): string {
    return bitsAt(mesh, triOf(group));
  }

  /* THE 2u CELL DRAWS A DIFFERENT MESH FROM THE MERGED 4u BLOCK — see `FLOOR_MESH` in cell-place.ts.
     `floor_tile_small` is exactly one quadrant of `floor_tile_large`: one 1.15 diamond at its centre
     and a 0.95 quarter-octagon at each corner, the same stones on the same 2.00 lattice. Which means
     the octagon a merge boundary runs through is a HALF on the block's side and a QUARTER on the
     cell's, and those are the two halves of one stone. */
  const CELL_URL = 'models/kaykit_dungeon_remastered/floor_tile_small.gltf.glb';
  const cellSource = readGlb(new URL('../../public/models/kaykit_dungeon_remastered/floor_tile_small.gltf.glb', import.meta.url));
  const cellGroups = store.meshes[CELL_URL]!.groups!;
  const cellTriOf = (id: string): number => cellGroups.find((g) => g.id === id)!.tris['0']![0]!;

  /** A per-cell ground draw: the 2u mesh at NATIVE scale, centred on the cell. */
  function placeCell(x: number, z: number, turn = 0): THREE.Mesh {
    const m = new THREE.Mesh(cellSource, new THREE.MeshStandardMaterial());
    applyGroupAnchors(m, CELL_URL);
    m.position.set(x, 0, z);
    m.rotation.y = (turn * Math.PI) / 2;
    m.updateMatrixWorld(true);
    return m;
  }
  /**
   * THE XZ BITS ONLY — for comparing a 2u cell against a 4u block, where Y cannot be compared.
   *
   * A snapped anchor takes the coordinate of the bounding-box face the group reaches, and BOTH tiles'
   * pavers reach their own top face. That plane is nominally 0.05 in both meshes and is stored as two
   * different float32s (0.049999997 and 0.050000004 — the same 3.7e-9 class of gap the header
   * describes WITHIN `floor_tile_large`). It is a property of the GLBs, not of the placement, and it
   * is identical for every placement of each mesh, so it cannot make one tile disagree with its own
   * neighbours; and `phaseKeyString` quantises it into the same bucket either way — asserted below
   * alongside every use of this, so the gap is never taken on trust.
   *
   * X and Z are the coordinates a placement actually moves, and those must be exact.
   */
  function xzBits(mesh: THREE.Mesh, tri: number): string {
    const a = groupWorldAnchor(mesh, tri)!;
    const dv = new DataView(new ArrayBuffer(16));
    [a.x, a.z].forEach((n, i) => dv.setFloat64(i * 8, n));
    return [0, 1].map((i) => dv.getBigUint64(i * 8).toString(16).padStart(16, '0')).join(' ');
  }
  const cellAnchorBits = (mesh: THREE.Mesh, group: string): string => bitsAt(mesh, cellTriOf(group));

  beforeEach(() => setSurfaceStore(structuredClone(store)));

  it('the pavers the seam needs are AUTHORED — 8 of the 13 reach the tile edge', () => {
    // Without these the mechanism could not fire at a seam at all, and every assertion below would
    // be passing on a case the game never reaches.
    const named = new Set(groups.map((g) => g.id));
    for (const s of ['south', 'north', 'west', 'east']) expect(named).toContain(`half-octagon-${s}`);
    for (const c of ['south-west', 'north-west', 'north-east', 'south-east']) expect(named).toContain(`corner-${c}`);
    expect(named).toContain('centre-octagon');
    expect(groups).toHaveLength(13);
  });

  it('EDGE SEAM, 2u cells: the two halves of one octagon land on the same point, bit for bit', () => {
    // Two per-cell draws butted along z. The octagon centred on their shared edge is `south` in one
    // tile and `north` in the other; both must resolve to the middle of that edge and nothing else.
    const a = place(0, 0, 0.5), b = place(0, 2, 0.5);
    expect(anchorBits(a, 'half-octagon-south')).toBe(anchorBits(b, 'half-octagon-north'));
    expect(phaseKeyString(a, triOf('half-octagon-south'), 'shift'))
      .toBe(phaseKeyString(b, triOf('half-octagon-north'), 'shift'));
    // and it IS the seam: world z = 1 is exactly where the two tiles touch
    expect(groupWorldAnchor(a, triOf('half-octagon-south'))!.z).toBe(1);
  });

  it('EDGE SEAM: both axes, both scales', () => {
    for (const s of [0.5, 1]) {
      const p = 4 * s; // one tile pitch
      expect(anchorBits(place(0, 0, s), 'half-octagon-south')).toBe(anchorBits(place(0, p, s), 'half-octagon-north'));
      expect(anchorBits(place(0, 0, s), 'half-octagon-east')).toBe(anchorBits(place(p, 0, s), 'half-octagon-west'));
    }
  });

  it('CORNER: all FOUR quarter-octagons meeting at a tile corner agree', () => {
    // The hard case, and the one a centroid of boundary vertices cannot do. Each quarter's boundary
    // vertices lie on two faces shared with two DIFFERENT neighbours, so no symmetric function of
    // that set is common to all four — but the corner those faces intersect at is, and it snaps
    // there on both axes at once.
    const s = 0.5, p = 2;
    const want = anchorBits(place(0, 0, s), 'corner-south-west');
    expect(anchorBits(place(-p, 0, s), 'corner-south-east')).toBe(want);
    expect(anchorBits(place(0, p, s), 'corner-north-west')).toBe(want);
    expect(anchorBits(place(-p, p, s), 'corner-north-east')).toBe(want);
    const a = groupWorldAnchor(place(0, 0, s), triOf('corner-south-west'))!;
    expect([a.x, a.z]).toEqual([-1, 1]); // the shared corner of those four tiles, exactly
  });

  it('a QUARTER-TURNED tile still coordinates — the anchors ARE the pattern lattice', () => {
    // Tiles are placed at any of four turns. The 13 anchors sit on the octagon/diamond lattice,
    // which is invariant under a quarter turn, so the paver facing the seam changes but the world
    // point does not. This asserts the phase KEY rather than raw bits: `rotation.y` is not a
    // bit-exact operation the way translate-and-halve is (the quaternion leaves ~1e-16 on the
    // matrix). That gap is harmless rather than lucky because a snapped anchor lands ON the
    // quantisation lattice — `floor(v*128 + 0.5)` puts a lattice value half a bucket from either
    // edge, so it absorbs any perturbation below 1/256 of a metre.
    const a = place(0, 0, 0.5), b = place(0, 2, 0.5, 1);
    expect(phaseKeyString(b, triOf('half-octagon-east'), 'shift'))
      .toBe(phaseKeyString(a, triOf('half-octagon-south'), 'shift'));
  });

  it('the CENTRE octagon reaches no seam, and goes on varying alone', () => {
    // The other half of the rule, and the reason the feature exists: a paver wholly inside one tile
    // has no neighbour to agree with, so it must still be its own stone in every tile.
    const a = place(0, 0, 0.5), b = place(2, 0, 0.5);
    expect(anchorBits(a, 'centre-octagon')).not.toBe(anchorBits(b, 'centre-octagon'));
    expect(phaseKeyString(a, triOf('centre-octagon'), 'shift'))
      .not.toBe(phaseKeyString(b, triOf('centre-octagon'), 'shift'));
    // ...and no two of the tile's own 13 pavers collapsed onto one phase
    expect(new Set(groups.map((g) => phaseKeyString(a, triOf(g.id), 'shift'))).size).toBe(13);
  });

  it('the 2u tile carries the FIVE pavers its seams need', () => {
    // Same claim as the 13 above, for the mesh a cell draws. Without these a cell would be one
    // uniform stone beside a merged block's thirteen — a variation fork replacing the size fork.
    const named = new Set(cellGroups.map((g) => g.id));
    for (const c of ['south-west', 'north-west', 'north-east', 'south-east']) expect(named).toContain(`corner-${c}`);
    expect(named).toContain('centre-diamond');
    expect(cellGroups).toHaveLength(5);
  });

  it('MERGED 4u block against unmerged 2u cells: ONE lattice, and the split octagon is one stone', () => {
    /* THE CASE THIS WHOLE CHANGE EXISTS FOR. cell-tower.ts draws an aligned 2x2 of matching floor as
       one 4u tile and everything else per 2u cell, and whether a patch merges is DATA — a hole, a
       staircase, a material change and an odd row all stop it. So a merge boundary runs through the
       middle of an ordinary floor, and the octagon standing on it is drawn in three pieces by two
       different meshes: a HALF from the block, and a QUARTER from each of the two cells beyond it.
       All three must land on the same world point, bit for bit, or that stone tears.

       Cells sit on EVEN world coordinates and a block's centre one unit south-east of its first
       cell's, so on ODD ones — which is exactly the offset that puts both meshes' octagons on the
       same 2.00 lattice. Nothing here is a tolerance: it is that offset plus the boundary snap. */
    const block = place(1, 1, 1);       // the four cells at (0,0) (2,0) (0,2) (2,2), merged
    const westCell = placeCell(0, 4);   // the two unmerged cells butted against its +z edge
    const eastCell = placeCell(2, 4);
    const want = xzBits(block, triOf('half-octagon-south'));
    expect(xzBits(westCell, cellTriOf('corner-north-east'))).toBe(want);
    expect(xzBits(eastCell, cellTriOf('corner-north-west'))).toBe(want);
    // ...and it IS the octagon standing on the boundary: world (1, 3), where the three pieces meet
    const a = groupWorldAnchor(block, triOf('half-octagon-south'))!;
    expect([a.x, a.z]).toEqual([1, 3]);
    // the phase KEY is what actually shades, and it agrees across BOTH meshes — which is also what
    // certifies that the two GLBs' top-plane float32s (see `xzBits`) land in one bucket.
    const key = phaseKeyString(block, triOf('half-octagon-south'), 'shift');
    expect(phaseKeyString(westCell, cellTriOf('corner-north-east'), 'shift')).toBe(key);
    expect(phaseKeyString(eastCell, cellTriOf('corner-north-west'), 'shift')).toBe(key);
    // ...while two merged blocks side by side coordinate exactly, the same as two cells do
    expect(anchorBits(place(0, 0, 1), 'half-octagon-east')).toBe(anchorBits(place(4, 0, 1), 'half-octagon-west'));
    expect(cellAnchorBits(placeCell(0, 0), 'corner-south-east')).toBe(cellAnchorBits(placeCell(2, 0), 'corner-south-west'));
  });

  it('a CORNER where a block and three cells meet: all four quarters agree', () => {
    // The 4-way case across the boundary. A tile corner is an octagon CENTRE, so the four quarters
    // meeting there come from up to four different placements — here one block and three cells.
    const block = place(1, 1, 1), a = placeCell(0, 4), b = placeCell(-2, 4), c = placeCell(-2, 2);
    const want = xzBits(block, triOf('corner-south-west'));               // world (-1, 3)
    expect(xzBits(a, cellTriOf('corner-north-west'))).toBe(want);
    expect(xzBits(b, cellTriOf('corner-north-east'))).toBe(want);
    expect(xzBits(c, cellTriOf('corner-south-east'))).toBe(want);
    const key = phaseKeyString(block, triOf('corner-south-west'), 'shift');
    expect(phaseKeyString(a, cellTriOf('corner-north-west'), 'shift')).toBe(key);
    expect(phaseKeyString(b, cellTriOf('corner-north-east'), 'shift')).toBe(key);
    expect(phaseKeyString(c, cellTriOf('corner-south-east'), 'shift')).toBe(key);
  });

  it('a tower-sized offset holds ACROSS the merge boundary too', () => {
    // The seam test above at the origin says nothing about float32 anchors at real floor
    // coordinates. Same three pieces, moved to where a tower actually sits.
    const block = place(147, -97, 1), west = placeCell(146, -94), east = placeCell(148, -94);
    const want = xzBits(block, triOf('half-octagon-south'));
    expect(xzBits(west, cellTriOf('corner-north-east'))).toBe(want);
    expect(xzBits(east, cellTriOf('corner-north-west'))).toBe(want);
    const key = phaseKeyString(block, triOf('half-octagon-south'), 'shift');
    expect(phaseKeyString(west, cellTriOf('corner-north-east'), 'shift')).toBe(key);
    expect(phaseKeyString(east, cellTriOf('corner-north-west'), 'shift')).toBe(key);
  });

  it('a tower-sized offset does not drift — the seam holds far from the origin', () => {
    // Float32 in the attribute, float64 in the placement, and a hash with no tolerance downstream.
    // Anything that rounded would show up at the coordinates of a real floor rather than at 0.
    expect(anchorBits(place(146, -98, 0.5), 'half-octagon-east'))
      .toBe(anchorBits(place(148, -98, 0.5), 'half-octagon-west'));
    expect(anchorBits(place(146, -98, 0.5), 'corner-south-east'))
      .toBe(anchorBits(place(148, -96, 0.5), 'corner-north-west'));
  });
});
