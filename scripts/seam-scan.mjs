#!/usr/bin/env node
// ============================================================================
// scripts/seam-scan.mjs — find texture-phase discontinuities in a RENDER, numerically.
// ============================================================================
//
// "Do these two surfaces share a texture phase?" is a question human eyes are bad at. A seam in
// stone is a few percent of brightness across one pixel column, sitting in a texture that is itself
// full of a few percent of brightness variation. Looking harder does not help — an inverted normal
// map survived several rounds of exactly that.
//
// So do not look. MEASURE. Render the surface wearing the UV-ramp texture (`gradient`: R = a single
// triangle wave along U, G along V), then scan the image for STEPS. A ramp is smooth by
// construction, so the only sharp jumps in it are phase breaks.
//
// The statistic is the same one `tex-seam-check.mjs` uses for tileability, applied to a frame
// instead of a texture: compare the biggest single-pixel jump to the image's own typical local
// gradient. That ratio is scale-free, so it does not care about exposure, texture contrast, or how
// bright the scene is.
//
//   ratio < ~4    no step this scanline can see        = phases agree
//   ratio > ~8    a step well outside normal variation = a seam
//
//   node scripts/seam-scan.mjs shot.png                       # whole image, worst rows
//   node scripts/seam-scan.mjs shot.png --box=200,140,420,260 # just this region
//   node scripts/seam-scan.mjs a.png b.png                    # compare two renders
//
// LIMITS, because a number that is trusted blindly is worse than no number:
//   - A silhouette edge or a shadow boundary is also a step. Aim the box at ONE flat, evenly-lit
//     surface spanning the seam; that is what the close-up crop is for.
//   - It finds steps along X (columns). Pass --axis=y for horizontal seams.
//   - It cannot tell a phase break from a genuine material change. It answers "is there a
//     discontinuity here", not "should there be".
// ============================================================================

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const flag = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const axis = flag('axis', 'x');
const box = flag('box', null);
const top = Number(flag('top', 6));

if (!files.length) {
  console.error('usage: seam-scan.mjs <shot.png...> [--box=x,y,w,h] [--axis=x|y] [--top=N]');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

for (const f of files) {
  const path = resolve(f);
  if (!existsSync(path)) { console.error(`missing: ${f}`); continue; }
  const b64 = readFileSync(path).toString('base64');

  const r = await page.evaluate(async ([uri, boxSpec, ax, topN]) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    let [bx, by, bw, bh] = boxSpec ? boxSpec.split(',').map(Number) : [0, 0, c.width, c.height];
    bx = Math.max(0, bx); by = Math.max(0, by);
    bw = Math.min(bw, c.width - bx); bh = Math.min(bh, c.height - by);
    const d = g.getImageData(bx, by, bw, bh).data;
    // sum of |delta| across R,G,B — the ramp encodes position in R and G, so a shift in either shows
    const at = (x, y) => { const i = (y * bw + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const diff = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);

    const steps = [];      // {pos, value} the largest jump per line
    const alls = [];       // every jump, for the baseline
    const [outer, inner] = ax === 'y' ? [bw, bh] : [bh, bw];
    for (let o = 0; o < outer; o++) {
      let best = 0, bestAt = -1;
      for (let i = 1; i < inner; i++) {
        const p = ax === 'y' ? at(o, i - 1) : at(i - 1, o);
        const q = ax === 'y' ? at(o, i) : at(i, o);
        const v = diff(p, q);
        alls.push(v);
        if (v > best) { best = v; bestAt = i; }
      }
      steps.push({ line: o, at: bestAt, value: best });
    }
    alls.sort((a, b) => a - b);
    const median = alls[Math.floor(alls.length / 2)] || 0;
    const p90 = alls[Math.floor(alls.length * 0.9)] || 0;
    steps.sort((a, b) => b.value - a.value);
    return { w: bw, h: bh, median, p90, worst: steps.slice(0, topN) };
  }, [`data:image/png;base64,${b64}`, box, axis, top]);

  // scale-free: the worst step against the image's OWN typical local gradient
  const base = Math.max(r.median, 0.5);
  const worst = r.worst[0]?.value ?? 0;
  const ratio = worst / base;
  const verdict = ratio < 4 ? 'CONTINUOUS — no step above normal variation'
    : ratio < 8 ? 'suspicious — a step, but within reach of texture contrast'
    : 'SEAM — a step well outside this image\'s own variation';

  console.log(`\n${f}  (${r.w}x${r.h}, axis=${axis}${box ? `, box=${box}` : ''})`);
  console.log(`  typical local step: median ${r.median.toFixed(1)}  p90 ${r.p90.toFixed(1)}`);
  console.log(`  worst step        : ${worst.toFixed(1)}  =  ${ratio.toFixed(1)}x median`);
  console.log(`  -> ${verdict}`);
  if (r.worst.length) {
    const cols = r.worst.map((s) => `${axis === 'y' ? 'col' : 'row'} ${s.line}@${s.at}=${s.value.toFixed(0)}`);
    console.log(`  worst lines: ${cols.join('  ')}`);
  }
}

await browser.close();
