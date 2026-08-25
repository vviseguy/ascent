#!/usr/bin/env node
// Split a GLB into its PARTS — by node, or by connected component.
//
//   node scripts/glb-parts.mjs <in.glb>                              analyse: list nodes + components
//   node scripts/glb-parts.mjs <in.glb> <out.glb> --node=<name>      keep one node's own mesh
//   node scripts/glb-parts.mjs <in.glb> <out.glb> --drop-node=<name> drop a node and its subtree
//   node scripts/glb-parts.mjs <in.glb> <out.glb> --keep=0,2,5       keep these components
//   node scripts/glb-parts.mjs <in.glb> <out.glb> --drop=3,4         drop these components
//
// WHY THIS EXISTS. These kit meshes are NOT one welded solid. A wall piece is typically its body,
// one or two decorative flourishes, and a scatter of small debris blobs stuck to the faces — all
// disconnected, all inside a single primitive. `glb-trim` cuts along X by TRIANGLE centroid, which
// has no notion of that: a debris blob belonging to the section being cut away survives whole if its
// own centroid happens to sit past the cut, and ends up detached, floating in the seam. That is the
// "rubble in the gap" defect on `wall_endcap_short`. Selecting whole COMPONENTS makes the unit of
// the edit the unit the artist actually modelled.
//
// SAME GUARANTEE AS `glb-trim`: only the INDEX buffer is rewritten (plus node bookkeeping).
// Vertices, UVs, normals and the atlas material stay byte-identical to upstream, so a part still
// recolours and box-fits exactly like its parent. Unreferenced vertices stay in the buffer — the
// file does not shrink, and three.js derives a bounding sphere from the original extent, which is
// conservative (a too-large sphere cannot cause wrong culling).
//
// COMPONENT INDICES ARE POSITIONAL, so the ordering is pinned: triangle count descending, then minX,
// minY, minZ. Analyse mode prints exactly the indices the selectors take. Re-check them if the pack
// is ever re-fetched.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = new Map(args.filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), ''] : [a.slice(2, i), a.slice(i + 1)];
}));
const [inPath, outPath] = args.filter((a) => !a.startsWith('--'));
if (!inPath) {
  console.error('usage: node scripts/glb-parts.mjs <in.glb> [<out.glb> --node=N|--drop-node=N|--keep=i,j|--drop=i,j]');
  process.exit(2);
}

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const base = (p) => p.split(/[\\/]/).pop();

const buf = readFileSync(inPath);
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const body = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
  else if (type === 0x004e4942) bin = Buffer.from(body);
  off += 8 + len;
  off += (4 - (off % 4)) % 4;
}
const g = json;

function readAcc(i) {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const [Arr, sz] = CT[a.componentType], n = NC[a.type];
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = bv.byteStride ?? n * sz;
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    const v = new Arr(bin.buffer, bin.byteOffset + start + k * stride, n);
    for (let c = 0; c < n; c++) out[k * n + c] = v[c];
  }
  return out;
}

/** Connected components of one primitive, welded by POSITION so seam-split vertices don't over-count. */
function components(prim) {
  const pos = readAcc(prim.attributes.POSITION);
  const idx = prim.indices !== undefined ? Array.from(readAcc(prim.indices)) : null;
  const n = pos.length / 3;
  const tris = idx ? idx.length / 3 : n / 3;
  const at = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);

  const weld = new Map(), rep = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const key = pos[k * 3].toFixed(4) + ',' + pos[k * 3 + 1].toFixed(4) + ',' + pos[k * 3 + 2].toFixed(4);
    if (!weld.has(key)) weld.set(key, k);
    rep[k] = weld.get(key);
  }
  const par = new Map();
  for (const v of weld.values()) par.set(v, v);
  const find = (a) => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
  const uni = (a, b) => { a = find(rep[a]); b = find(rep[b]); if (a !== b) par.set(a, b); };
  for (let t = 0; t < tris; t++) { uni(at(t, 0), at(t, 1)); uni(at(t, 1), at(t, 2)); }

  const byRoot = new Map();
  for (let t = 0; t < tris; t++) {
    const r = find(rep[at(t, 0)]);
    let c = byRoot.get(r);
    if (!c) { c = { tris: [], bb: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] }; byRoot.set(r, c); }
    c.tris.push(t);
    for (const k of [0, 1, 2]) {
      for (let q = 0; q < 3; q++) {
        const v = pos[at(t, k) * 3 + q];
        if (v < c.bb[q]) c.bb[q] = v;
        if (v > c.bb[q + 3]) c.bb[q + 3] = v;
      }
    }
  }
  // FIXED ORDER — the selectors take these indices.
  return [...byRoot.values()].sort((a, b) =>
    b.tris.length - a.tris.length || a.bb[0] - b.bb[0] || a.bb[1] - b.bb[1] || a.bb[2] - b.bb[2]);
}

const prims = [];
for (const m of g.meshes) for (const p of m.primitives) prims.push({ mesh: m, prim: p });

// ---------------------------------- ANALYSE ----------------------------------
if (!outPath) {
  console.log(base(inPath) + '   nodes ' + (g.nodes?.length ?? 0) + '  meshes ' + (g.meshes?.length ?? 0));
  const walk = (i, d) => {
    const nd = g.nodes[i];
    const t = nd.translation ? '  t=[' + nd.translation.map((v) => v.toFixed(2)).join(', ') + ']' : '';
    const m = nd.mesh !== undefined ? '  mesh ' + nd.mesh : '';
    console.log('  '.repeat(d + 1) + '[node ' + i + '] "' + (nd.name ?? '') + '"' + m + t);
    for (const c of nd.children ?? []) walk(c, d + 1);
  };
  for (const r of g.scenes[g.scene ?? 0].nodes) walk(r, 0);
  for (const { mesh, prim } of prims) {
    const cs = components(prim);
    const total = cs.reduce((a, c) => a + c.tris.length, 0);
    console.log('\n  mesh "' + (mesh.name ?? '') + '" — ' + total + ' tris in ' + cs.length + ' components:');
    cs.forEach((c, i) => console.log(
      '    [' + String(i).padStart(2) + '] ' + String(c.tris.length).padStart(4) + ' tris'
      + '  x[' + c.bb[0].toFixed(2) + ',' + c.bb[3].toFixed(2) + ']'
      + ' y[' + c.bb[1].toFixed(2) + ',' + c.bb[4].toFixed(2) + ']'
      + ' z[' + c.bb[2].toFixed(2) + ',' + c.bb[5].toFixed(2) + ']'));
  }
  process.exit(0);
}

// ---------------------------------- EXTRACT ----------------------------------
const nums = (s) => (s ? s.split(',').filter((x) => x !== '').map(Number) : []);
const keepSet = flags.has('keep') ? new Set(nums(flags.get('keep'))) : null;
const dropSet = flags.has('drop') ? new Set(nums(flags.get('drop'))) : null;
const nodeName = flags.get('node');
const dropNodeName = flags.get('drop-node');

let keptTris = 0, droppedTris = 0;

// -- node selection: rebuild the scene around one node, folding its accumulated translation in
if (nodeName !== undefined || dropNodeName !== undefined) {
  const parentOf = new Map();
  g.nodes.forEach((nd, i) => { for (const c of nd.children ?? []) parentOf.set(c, i); });

  if (nodeName !== undefined) {
    const target = g.nodes.findIndex((nd) => (nd.name ?? '') === nodeName);
    if (target < 0) { console.error('no node named "' + nodeName + '"'); process.exit(1); }
    // A part lifted out of its parent has to carry the parent's offset, or it moves.
    const t = [0, 0, 0];
    for (let i = target; i !== undefined; i = parentOf.get(i)) {
      const tr = g.nodes[i].translation ?? [0, 0, 0];
      for (let q = 0; q < 3; q++) t[q] += tr[q];
    }
    const nd = { ...g.nodes[target], translation: t };
    delete nd.children;
    g.nodes = [nd];
    g.scenes[g.scene ?? 0].nodes = [0];
  } else {
    const target = g.nodes.findIndex((nd) => (nd.name ?? '') === dropNodeName);
    if (target < 0) { console.error('no node named "' + dropNodeName + '"'); process.exit(1); }
    const doomed = new Set();
    const mark = (i) => { doomed.add(i); for (const c of g.nodes[i].children ?? []) mark(c); };
    mark(target);
    for (const nd of g.nodes) if (nd.children) nd.children = nd.children.filter((c) => !doomed.has(c));
    g.scenes[g.scene ?? 0].nodes = g.scenes[g.scene ?? 0].nodes.filter((r) => !doomed.has(r));
    for (const nd of g.nodes) if (nd.children && nd.children.length === 0) delete nd.children;
  }
}

// -- component selection: rewrite the index buffer
if (keepSet || dropSet) {
  const blocks = [];
  for (const { prim } of prims) {
    const cs = components(prim);
    const idx = prim.indices !== undefined ? Array.from(readAcc(prim.indices)) : null;
    const at = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);
    const out = [];
    cs.forEach((c, i) => {
      const keep = keepSet ? keepSet.has(i) : !dropSet.has(i);
      if (keep) {
        for (const t of c.tris) out.push(at(t, 0), at(t, 1), at(t, 2));
        keptTris += c.tris.length;
      } else droppedTris += c.tris.length;
    });
    blocks.push({ prim, data: new Uint32Array(out) });
  }
  for (const { prim, data } of blocks) {
    while (bin.length % 4 !== 0) bin = Buffer.concat([bin, Buffer.from([0])]);
    const byteOffset = bin.length;
    bin = Buffer.concat([bin, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
    g.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target: 34963 });
    g.accessors.push({ bufferView: g.bufferViews.length - 1, componentType: 5125, count: data.length, type: 'SCALAR' });
    prim.indices = g.accessors.length - 1;
  }
}
/* PRUNE what the scene can no longer reach.
   A node split leaves the OTHER half's mesh sitting in the file, unreferenced — nothing draws it,
   but it still ships. Splitting a 100 KB doorway into two 100 KB halves defeats the point, so the
   parts are walked from the scene roots and everything unreachable goes.
   Whole bufferViews are kept or dropped intact and never repacked internally, so the bytes that
   survive are still exactly the artist's. (A COMPONENT selection frees no vertices — the POSITION
   accessor is still referenced, so its unused vertices stay, same as `glb-trim`.) */
{
  const usedNode = new Set();
  const markNode = (i) => { if (usedNode.has(i)) return; usedNode.add(i); for (const c of g.nodes[i].children ?? []) markNode(c); };
  for (const r of g.scenes[g.scene ?? 0].nodes) markNode(r);

  const usedMesh = new Set();
  for (const i of usedNode) if (g.nodes[i].mesh !== undefined) usedMesh.add(g.nodes[i].mesh);

  const usedAcc = new Set();
  for (const mi of usedMesh) {
    for (const p of g.meshes[mi].primitives) {
      for (const a of Object.values(p.attributes)) usedAcc.add(a);
      if (p.indices !== undefined) usedAcc.add(p.indices);
      for (const t of p.targets ?? []) for (const a of Object.values(t)) usedAcc.add(a);
    }
  }

  const usedBV = new Set();
  for (const ai of usedAcc) { const bv = g.accessors[ai].bufferView; if (bv !== undefined) usedBV.add(bv); }
  for (const im of g.images ?? []) if (im.bufferView !== undefined) usedBV.add(im.bufferView);   // the atlas

  // rebuild the binary chunk from the surviving views, in a stable order
  const bvOrder = [...usedBV].sort((a, b) => a - b);
  const bvMap = new Map();
  const chunks = [];
  let cursor = 0;
  for (const oldIdx of bvOrder) {
    const bv = g.bufferViews[oldIdx];
    const start = bv.byteOffset ?? 0;
    let slice = bin.subarray(start, start + bv.byteLength);
    while (cursor % 4 !== 0) { chunks.push(Buffer.alloc(1)); cursor++; }
    const nbv = { ...bv, byteOffset: cursor };
    chunks.push(Buffer.from(slice));
    cursor += slice.length;
    bvMap.set(oldIdx, nbv);
  }
  bin = Buffer.concat(chunks);

  const accOrder = [...usedAcc].sort((a, b) => a - b);
  const accMap = new Map(accOrder.map((old, i) => [old, i]));
  const meshOrder = [...usedMesh].sort((a, b) => a - b);
  const meshMap = new Map(meshOrder.map((old, i) => [old, i]));
  const nodeOrder = [...usedNode].sort((a, b) => a - b);
  const nodeMap = new Map(nodeOrder.map((old, i) => [old, i]));
  const bvIdx = new Map(bvOrder.map((old, i) => [old, i]));

  g.bufferViews = bvOrder.map((old) => bvMap.get(old));
  g.accessors = accOrder.map((old) => {
    const a = { ...g.accessors[old] };
    if (a.bufferView !== undefined) a.bufferView = bvIdx.get(a.bufferView);
    return a;
  });
  g.meshes = meshOrder.map((old) => ({
    ...g.meshes[old],
    primitives: g.meshes[old].primitives.map((p) => {
      const np = { ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, accMap.get(v)])) };
      if (p.indices !== undefined) np.indices = accMap.get(p.indices);
      if (p.targets) np.targets = p.targets.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, accMap.get(v)])));
      return np;
    }),
  }));
  g.nodes = nodeOrder.map((old) => {
    const nd = { ...g.nodes[old] };
    if (nd.mesh !== undefined) nd.mesh = meshMap.get(nd.mesh);
    if (nd.children) nd.children = nd.children.filter((c) => nodeMap.has(c)).map((c) => nodeMap.get(c));
    if (nd.children && nd.children.length === 0) delete nd.children;
    return nd;
  });
  for (const im of g.images ?? []) if (im.bufferView !== undefined) im.bufferView = bvIdx.get(im.bufferView);
  g.scenes[g.scene ?? 0].nodes = g.scenes[g.scene ?? 0].nodes.map((r) => nodeMap.get(r));
}
g.buffers[0].byteLength = bin.length;

const jsonBuf = Buffer.from(JSON.stringify(g), 'utf8');
const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binPad.length, 8);
const jc = Buffer.alloc(8); jc.writeUInt32LE(jsonPad.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
const bc = Buffer.alloc(8); bc.writeUInt32LE(binPad.length, 0); bc.writeUInt32LE(0x004e4942, 4);
writeFileSync(outPath, Buffer.concat([header, jc, jsonPad, bc, binPad]));

const how = nodeName !== undefined ? 'node "' + nodeName + '"'
  : dropNodeName !== undefined ? 'dropped node "' + dropNodeName + '"'
    : keepSet ? 'kept components ' + [...keepSet].join(',')
      : 'dropped components ' + [...dropSet].join(',');
console.log(base(inPath) + ' -> ' + base(outPath) + '   ' + how);
if (keptTris || droppedTris) console.log('  kept ' + keptTris + ' triangles, dropped ' + droppedTris);
