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
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  applyGroupAnchors, phaseKeyString, GROUP_ANCHOR_ATTR, VARY_CODE, VARY_INHERIT,
} from './group-anchors.ts';
import {
  applyHiddenFaces, geometryHash, setSurfaceStore, sourceGeometry, triCount, SOURCE_GEOM,
  EMPTY_SURFACES, type SurfaceGroup,
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

    // the authored island: its own centroid, asking the material TYPE what it is allowed to do
    for (const t of [0, 1]) {
      expect(new Set(triAnchors(mesh, t).map((a) => a.xyz)).size).toBe(1);
      expect(triAnchors(mesh, t)[0]!.xyz).toBe('0.5000,0.0000,0.5000');
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
    expect(phaseKeyString(a!, 0, 'shift')).toBe('shift@0.5,0,0.5');
    expect(phaseKeyString(b!, 0, 'shift')).toBe('shift@2.5,0,0.5');
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
