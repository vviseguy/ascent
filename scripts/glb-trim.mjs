#!/usr/bin/env node
// Trim a GLB along X, keeping only the geometry beyond a cut, and re-origin it so the kept part
// starts at x = 0.
//
//   node tmp/glb-trim.mjs <in.glb> <out.glb> <cutX>
//
// KEEPS THE ORIGINAL VERTICES AND MATERIALS UNTOUCHED. Only the INDEX buffer is rewritten — the
// triangles whose centroid sits before the cut are dropped — and a translation is folded into the
// node. That is a far smaller edit than rebuilding attributes, and it means UVs, normals, the atlas
// material and every other property are exactly what the artist shipped.
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath, cutArg] = process.argv.slice(2);
if (!inPath || !outPath || cutArg === undefined) {
  console.error('usage: node tmp/glb-trim.mjs <in.glb> <out.glb> <cutX>');
  process.exit(2);
}
const CUT = Number(cutArg);

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const buf = readFileSync(inPath);
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
  const body = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
  else if (type === 0x004e4942) bin = Buffer.from(body);
  off += 8 + len; off += (4 - (off % 4)) % 4;
}
const g = json;

function readAcc(i) {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const [Arr, sz] = CT[a.componentType], n = NC[a.type];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = bv.byteStride ?? n * sz;
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    const v = new Arr(bin.buffer, bin.byteOffset + base + k * stride, n);
    for (let c = 0; c < n; c++) out[k * n + c] = v[c];
  }
  return out;
}

let kept = 0, dropped = 0;
let keptMinX = Infinity;   // the lowest X of any vertex that SURVIVED the cut
const newBlocks = [];   // { primRef, Uint32Array }

for (const mesh of g.meshes) {
  for (const prim of mesh.primitives) {
    const pos = readAcc(prim.attributes.POSITION);
    const idx = prim.indices !== undefined ? readAcc(prim.indices) : null;
    const triCount = idx ? idx.length / 3 : pos.length / 9;
    const keep = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
      if (cx >= CUT) {
        keep.push(a, b, c); kept++;
        // WHERE THE SURVIVING GEOMETRY ACTUALLY BEGINS — see the re-origin note below.
        for (const v of [a, b, c]) if (pos[v * 3] < keptMinX) keptMinX = pos[v * 3];
      } else dropped++;
    }
    newBlocks.push({ prim, data: new Uint32Array(keep) });
  }
}

// append the new index blocks to the binary chunk and repoint each primitive at them
let binOut = bin;
for (const { prim, data } of newBlocks) {
  while (binOut.length % 4 !== 0) binOut = Buffer.concat([binOut, Buffer.from([0])]);
  const byteOffset = binOut.length;
  binOut = Buffer.concat([binOut, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
  g.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target: 34963 });
  g.accessors.push({ bufferView: g.bufferViews.length - 1, componentType: 5125, count: data.length, type: 'SCALAR' });
  prim.indices = g.accessors.length - 1;
}
g.buffers[0].byteLength = binOut.length;

/* RE-ORIGIN so the kept geometry starts at x = 0 — BY WHAT SURVIVED, NOT BY THE CUT PLANE.
   Triangles are dropped whole, by CENTROID, so the surviving geometry almost never begins exactly at
   the cut: it begins at the first vertex of the first triangle that cleared it. Shifting by CUT
   therefore leaves the piece floating `keptMinX - CUT` short of its own origin, and since these
   pieces are placed flush against the thing they finish, that distance is a VISIBLE GAP with the
   piece's loose decoration hanging in it.
   That is not hypothetical: `wall_endcap_short` cut at 0.80 kept geometry starting at 0.90, so every
   cap sat 0.100 off the wall it was capping with two brick blobs stranded in the space. Shifting by
   `keptMinX` makes the piece flush for ANY cut value, which is what the old comment here already
   claimed was happening. */
const SHIFT = Number.isFinite(keptMinX) ? keptMinX : CUT;
for (const r of g.scenes[g.scene ?? 0].nodes) {
  const nd = g.nodes[r];
  if (nd.matrix) { nd.matrix[12] -= SHIFT; } else {
    const t = nd.translation ?? [0, 0, 0];
    nd.translation = [t[0] - SHIFT, t[1], t[2]];
  }
}

const jsonBuf = Buffer.from(JSON.stringify(g), 'utf8');
const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const binPad = Buffer.concat([binOut, Buffer.alloc((4 - (binOut.length % 4)) % 4, 0)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binPad.length, 8);
const jc = Buffer.alloc(8); jc.writeUInt32LE(jsonPad.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
const bc = Buffer.alloc(8); bc.writeUInt32LE(binPad.length, 0); bc.writeUInt32LE(0x004e4942, 4);
writeFileSync(outPath, Buffer.concat([header, jc, jsonPad, bc, binPad]));

console.log(`${inPath.split(/[\\/]/).pop()} -> ${outPath.split(/[\\/]/).pop()}  cut at x=${CUT}`);
console.log(`  kept ${kept} triangles, dropped ${dropped}`);
