#!/usr/bin/env node
// ============================================================================
// scripts/palette-probe.mjs — derive/verify the KayKit atlas palette from real GLBs.
// ============================================================================
//
// The ground truth behind src/lab/palette.ts. For every triangle in the given GLBs it
// samples the embedded atlas (`dungeon_texture`) at the triangle's centroid UV, finds
// the NEAREST palette swatch, and reports per-swatch: how many triangles land on it,
// the average + worst colour distance, and an example colour. Use it to:
//   • confirm a swatch's role is how models ACTUALLY use it (e.g. the blue-greys are the
//     dungeon SHELL = stone, not metal — the call that shaped palette.ts),
//   • catch coverage gaps (lots of tris at high avgΔ = a swatch the palette is missing),
//   • re-derive the palette if the KayKit pack is ever updated.
//
//   node scripts/palette-probe.mjs [glb ...]      # default: a representative spread
//   FLIP=1 node scripts/palette-probe.mjs ...      # debug: re-introduce the v-flip
//
// NO v-flip is correct: glTF textures load flipY=false, so UV v=0 is the atlas TOP — the
// same row a 2D canvas (retexture.ts) reads first. (Flipping mis-reads every triangle and
// only "works" on greys, since grey appears at many atlas rows — the bug this script found.)
//
// Pure Node, no deps: parses GLB chunks + accessors and inflates the PNG with zlib.
// ============================================================================

import fs from 'node:fs';
import zlib from 'node:zlib';
import { resolve } from 'node:path';

// --- palette mirror of src/lab/palette.ts (name → [hex, role]) ---
const PALETTE = {
  stoneDark: [0x4a5155, 'stone'], darkSteel: [0x6a7277, 'stone'], steel: [0x7a8d9d, 'stone'],
  ironGrey: [0x818c91, 'stone'], neutralGrey: [0x8e8e8d, 'stone'], stoneWarm: [0x978f86, 'stone'],
  neutralLight: [0xbcbcbc, 'stone'], charcoal: [0x13191b, 'dark'],
  woodClay: [0xb16f52, 'wood'], woodRed: [0x9b5a45, 'wood'], woodTan: [0xdaae7d, 'wood'],
  copper: [0xc36532, 'orange'], white: [0xd4dbde, 'light'], cream: [0xdcd0c3, 'light'],
  amber: [0xf9aa4e, 'gold'], goldYellow: [0xeac253, 'gold'], goldOrange: [0xf99e39, 'gold'],
  red: [0xd22227, 'red'], crimson: [0xa41a5a, 'red'], pink: [0xf3727f, 'pink'], salmon: [0xf69372, 'pink'],
  purple: [0x662c8e, 'purple'], teal: [0x50aaae, 'teal'], tealDeep: [0x38a38d, 'teal'],
  green: [0x55b66a, 'green'], greenGrass: [0x52aa48, 'green'], blue: [0x62a0d0, 'blue'],
};
const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function nearest(c) {
  let bn = '', br = '', bd = Infinity;
  for (const [n, [h, role]] of Object.entries(PALETTE)) {
    const d = dist(c, rgb(h));
    if (d < bd) { bd = d; bn = n; br = role; }
  }
  return { name: bn, role: br, d: bd };
}

// --- GLB parse ---
function parseGlb(buf) {
  let off = 12, json = null, bin = null;
  const total = buf.readUInt32LE(8);
  while (off < total) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}
// --- minimal PNG decode (8-bit, colorType 2/6) ---
function decodePng(bytes) {
  let off = 8, width, height, colorType; const idat = [];
  while (off < bytes.length) {
    const len = bytes.readUInt32BE(off), type = bytes.toString('ascii', off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, b = y > 0 ? out[(y - 1) * stride + x] : 0, c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (ft === 1) v = (v + a) & 255; else if (ft === 2) v = (v + b) & 255; else if (ft === 3) v = (v + ((a + b) >> 1)) & 255; else if (ft === 4) v = (v + paeth(a, b, c)) & 255;
      out[y * stride + x] = v;
    }
  }
  return { width, height, ch, data: out };
}
const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx]; const bv = json.bufferViews[acc.bufferView];
  const [Arr, comp] = CT[acc.componentType]; const n = NUM[acc.type];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? comp * n;
  const out = new Array(acc.count);
  for (let i = 0; i < acc.count; i++) out[i] = Array.from(new Arr(bin.buffer, bin.byteOffset + base + i * stride, n));
  return out;
}

const FLIP = process.env.FLIP === '1'; // correct = no flip; FLIP=1 to reproduce the bug
const root = resolve(import.meta.dirname, '..');
const DEFAULT = [
  'wall', 'pillar', 'stairs', 'floor_tile_large', 'chest_gold', 'coin_stack_large',
  'sword_shield', 'banner_red', 'bottle_A_green', 'torch_lit', 'table_medium', 'barrel_small',
].map((n) => `${root}/public/models/kaykit_dungeon/${n}.glb`);
const paths = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;

for (const path of paths) {
  const { json, bin } = parseGlb(fs.readFileSync(path));
  const img = json.images[0]; const bv = json.bufferViews[img.bufferView];
  const png = decodePng(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
  const sample = (u, v) => {
    const fx = ((u % 1) + 1) % 1, fy = ((v % 1) + 1) % 1;
    const x = Math.min(png.width - 1, Math.floor(fx * png.width));
    const y = Math.min(png.height - 1, Math.floor((FLIP ? 1 - fy : fy) * png.height));
    const i = (y * png.width + x) * png.ch;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const clusters = new Map();
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    if (prim.attributes.TEXCOORD_0 === undefined) continue;
    const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
    const index = prim.indices !== undefined ? readAccessor(json, bin, prim.indices).map((a) => a[0]) : uv.map((_, i) => i);
    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = uv[index[t]], b = uv[index[t + 1]], c = uv[index[t + 2]];
      const col = sample((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
      const nb = nearest(col);
      const e = clusters.get(nb.name) ?? { role: nb.role, tris: 0, sumd: 0, maxd: 0, ex: col };
      e.tris++; e.sumd += nb.d; e.maxd = Math.max(e.maxd, nb.d);
      clusters.set(nb.name, e);
    }
  }
  console.log(`\n=== ${path.split(/[\\/]/).pop()} ===`);
  for (const [name, e] of [...clusters].sort((x, y) => y[1].tris - x[1].tris)) {
    const flag = e.tris >= 24 && e.sumd / e.tris > 32 ? '  ⚠ gap?' : '';
    console.log(`  ${name.padEnd(12)} ${e.role.padEnd(7)} tris=${String(e.tris).padStart(4)} avgΔ=${(e.sumd / e.tris).toFixed(1).padStart(5)} maxΔ=${e.maxd.toFixed(0).padStart(3)} eg=${hex(e.ex)}${flag}`);
  }
}
