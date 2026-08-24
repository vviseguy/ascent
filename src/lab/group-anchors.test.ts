// The per-group texture phase is invisible in a unit test — it happens in a shader. What IS testable
// is the contract the shader depends on, and every one of these is a bug that would read as a
// rendering fault rather than a data fault:
//
//   1. every vertex of a triangle carries ONE anchor (else a paver tears along a shared corner)
//   2. triangle ORDER and COUNT survive (else every stored hidden/group index points elsewhere)
//   3. the geometry HASH still matches after anchoring (else the store rejects its own edits)
//   4. a saved group beats the auto facet, and carries its own `vary`
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { applyGroupAnchors, GROUP_ANCHOR_ATTR, VARY_CODE, VARY_INHERIT } from './group-anchors.ts';
import {
  applyHiddenFaces, geometryHash, setSurfaceStore, sourceGeometry, triCount, EMPTY_SURFACES,
} from './face-surfaces.ts';

/** A V-valley: two quads meeting at a shared bottom edge. The fold is CONCAVE, so carve mode keeps
 *  them apart — and the two valley vertices are shared by both, which is exactly the case that
 *  forces a vertex split. Vertices 0 and 1 are the valley; 2/3 and 4/5 are the two wings. */
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

/** Two squares far apart with no shared vertex — the easy case (two facets, nothing to split). */
function twoIslands(): THREE.Mesh {
  const quad = (x: number): number[] => [x, 0, 0, x + 1, 0, 0, x + 1, 0, 1, x, 0, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...quad(0), ...quad(10)]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial());
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
function triAnchors(mesh: THREE.Mesh, t: number): string[] {
  const idx = mesh.geometry.index!;
  const all = anchors(mesh);
  return [0, 1, 2].map((k) => all[idx.getX(t * 3 + k)]!.xyz);
}

beforeEach(() => setSurfaceStore(structuredClone(EMPTY_SURFACES)));

describe('group-anchors — one anchor per group, and never half a triangle', () => {
  it('separate facets get DIFFERENT anchors, and every corner of a triangle agrees', () => {
    const mesh = twoIslands();
    applyGroupAnchors(mesh, 'test://islands');
    for (let t = 0; t < 4; t++) expect(new Set(triAnchors(mesh, t)).size).toBe(1);
    // two islands, two anchors — a mesh whose facets all shared one anchor would be the no-op bug
    const distinct = new Set([0, 1, 2, 3].map((t) => triAnchors(mesh, t)[0]));
    expect(distinct.size).toBe(2);
  });

  it('a vertex two groups both want is DUPLICATED, not fought over', () => {
    const mesh = valley();
    const before = triCount(mesh.geometry);
    applyGroupAnchors(mesh, 'test://valley');
    // the valley edge is shared by both wings, so exactly its two vertices split
    expect(mesh.geometry.getAttribute('position').count).toBe(6 + 2);
    expect(triCount(mesh.geometry)).toBe(before);
    for (let t = 0; t < before; t++) expect(new Set(triAnchors(mesh, t)).size).toBe(1);
    // and the two wings really are separate groups (a concave crease is not crossed)
    expect(new Set([0, 1, 2, 3].map((t) => triAnchors(mesh, t)[0])).size).toBe(2);
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
    applyGroupAnchors(mesh, 'test://valley');
    expect(centroids(mesh)).toEqual(centroids(src));
  });

  it('auto facets ask the material TYPE — they do not decide for it', () => {
    const mesh = twoIslands();
    applyGroupAnchors(mesh, 'test://islands');
    for (const a of anchors(mesh)) expect(a.w).toBe(VARY_INHERIT);
  });

  it('code 1 is `none`, because that is what a MISSING attribute reads as', () => {
    // GL's default generic vertex attribute is (0,0,0,1). Any other numbering would make a mesh
    // with no anchors baked in vary by accident, which is the one thing this must never do.
    expect(VARY_CODE.none).toBe(1);
  });
});

describe('group-anchors — a saved group beats the auto partition', () => {
  it('takes the triangles it names, with its own anchor and its own vary', () => {
    const mesh = twoIslands();
    setSurfaceStore({
      version: 1,
      meshes: {
        'test://islands': {
          geom: geometryHash(mesh),
          hidden: {},
          groups: [{ id: 'both', name: 'both islands', tris: { 0: [0, 1, 2, 3] }, vary: 'none' }],
        },
      },
    });
    applyGroupAnchors(mesh, 'test://islands');
    // one group now, so one anchor across the whole mesh — and it says `none`
    expect(new Set([0, 1, 2, 3].map((t) => triAnchors(mesh, t)[0])).size).toBe(1);
    for (const a of anchors(mesh)) expect(a.w).toBe(VARY_CODE.none);
    // the two islands span x = 0..1 and 10..11, so their shared centroid is the midpoint
    expect(triAnchors(mesh, 0)[0]).toBe('5.5000,0.0000,0.5000');
  });

  it('an entry authored against DIFFERENT geometry is ignored, not applied blind', () => {
    const mesh = twoIslands();
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
    for (const a of anchors(mesh)) expect(a.w).toBe(VARY_INHERIT); // fell back to the auto partition
  });
});

describe('group-anchors — the ordering contract with hidden faces', () => {
  it('anchoring first still leaves the ORIGINAL geometry as the hash the store is checked against', () => {
    const mesh = twoIslands();
    const stored = geometryHash(mesh);
    setSurfaceStore({ version: 1, meshes: { 'test://islands': { geom: stored, hidden: { 0: [3] } } } });

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
