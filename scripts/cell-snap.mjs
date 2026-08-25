#!/usr/bin/env node
// ============================================================================
// scripts/cell-snap.mjs — headless screenshots of the 2u CELL pipeline.
// ============================================================================
//
// The visual half of the gate on `src/floor/cell-place.ts`. The tests prove which mesh is chosen and
// where it goes; this shows you. Same trick as lab-snap: build, serve dist, drive headless Chromium
// with software WebGL.
//
//   node scripts/cell-snap.mjs structure "walled stairs" [--turns] [--no-build]
//   node scripts/cell-snap.mjs floor 36x28 --seed=3
//   node scripts/cell-snap.mjs all                       every authored structure, one shot each
//
//   --turns        one shot per orientation (0..3 + flipped) — placement must survive all eight
//   --angle=deg --pitch=deg --zoom=f
//   --arrows       draw the climb direction the code CHOSE over each flight, plus a compass
//   --compiled     draw the COMPILED IR (`cell-tower.ts`) instead of the raw per-cell placements.
//                  The difference is the 2x2 ground merge, which is what the game actually draws and
//                  what the default view cannot see. Use it when you are judging GROUND.
//   --size=WxH     viewport, default 900x620. A wide board of many small cases is unreadable at the
//                  default — the pixels are the whole deliverable, so make them enough of them.
//   --out=dir      default cell-shots
//
// Output: cell-shots/<subject>[-t<turn>][-f].png
// ============================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Map();
const pos = [];
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags.set(k, v ?? '1'); } else pos.push(a);
}
const mode = pos[0];
if (!mode || !['structure', 'floor', 'all', 'demo'].includes(mode)) {
  console.error('usage: node scripts/cell-snap.mjs structure "<name>" | floor <w>x<h> | all  [--turns] [--seed=n] [--no-build]');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const dist = join(root, flags.get('dist') ?? 'dist');
const outDir = flags.get('out') ?? 'cell-shots';

if (!flags.has('no-build')) {
  console.log('[cell-snap] vite build…');
  execSync('npx vite build --logLevel=error', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(dist, 'cell-snap.html'))) {
  console.error('[cell-snap] dist/cell-snap.html missing — is cell-snap.html registered in vite.config.ts?');
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.json': 'application/json', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/ascent\/?/, '') || 'index.html';
    const body = await readFile(join(dist, decodeURIComponent(p)));
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const sizeM = /^(\d+)x(\d+)$/.exec(flags.get('size') ?? '');
const page = await browser.newPage({
  viewport: sizeM ? { width: Number(sizeM[1]), height: Number(sizeM[2]) } : { width: 900, height: 620 },
});
const logs = [];
page.on('console', (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const shots = [];
const camera = `angle=${flags.get('angle') ?? 35}&pitch=${flags.get('pitch') ?? 38}&zoom=${flags.get('zoom') ?? 1.15}` + (flags.has('focus') ? `&focus=${flags.get('focus')}` : '')
  + (flags.has('stack') ? `&stack=${flags.get('stack')}` : '')
  + (flags.has('rise') ? `&rise=${flags.get('rise')}` : '')
  + (flags.has('arrows') ? `&arrows=1` : '')
  + (flags.has('compiled') ? `&compiled=1` : '')
  + (flags.has('assets') ? `&assets=${flags.get('assets')}` : '')
  + (flags.has('only') ? `&only=${encodeURIComponent(flags.get('only'))}` : '')
  + (flags.has('spin') ? `&spin=${encodeURIComponent(flags.get('spin'))}` : '')
  + (flags.has('level') ? `&level=${flags.get('level')}` : '')
  + (flags.has('levels') ? `&levels=${flags.get('levels')}` : '');

async function shot(query, name) {
  await page.goto(`http://127.0.0.1:${port}/ascent/cell-snap.html?${query}&${camera}`);
  try {
    await page.waitForFunction('window.__CELL_READY === true', null, { timeout: 40000 });
  } catch {
    console.error(`[cell-snap] ${name}: never became ready\n` + logs.slice(-12).join('\n'));
    return;
  }
  const err = await page.evaluate('window.__CELL_ERROR');
  if (err) { console.error(`[cell-snap] ${name}: ${err}`); return; }
  const warn = await page.evaluate('window.__CELL_WARN');
  if (warn) console.error(`[cell-snap] WARN ${name}: ${warn}`);
  const f = join(root, outDir, `${name.replace(/[^\w.-]+/g, '_')}.png`);
  await page.screenshot({ path: f });
  shots.push(`${f}   ${await page.evaluate('window.__CELL_INFO')}`);
}

mkdirSync(join(root, outDir), { recursive: true });

if (mode === 'demo') {
  const kind = pos[1] ?? 'stairs-open';
  await shot(`demo=${encodeURIComponent(kind)}`, `demo-${kind}`);
} else if (mode === 'floor') {
  const size = pos[1] ?? '36x28';
  const seed = flags.get('seed') ?? '1';
  await shot(`floor=${size}&seed=${seed}`, `floor-${size}-s${seed}`);
} else {
  // `all` needs the name list, and the page publishes it — ask it once
  let names = pos.slice(1);
  if (mode === 'all' || names.length === 0) {
    await page.goto(`http://127.0.0.1:${port}/ascent/cell-snap.html`);
    await page.waitForFunction('window.__CELL_NAMES !== undefined', null, { timeout: 40000 });
    names = await page.evaluate('window.__CELL_NAMES');
    if (!names?.length) { console.error('[cell-snap] the page listed no structures'); process.exit(1); }
  }
  for (const n of names) {
    if (flags.has('turns')) {
      for (const t of [0, 1, 2, 3]) for (const fl of [false, true]) {
        await shot(`structure=${encodeURIComponent(n)}&turn=${t}${fl ? '&flip=1' : ''}`, `${n}-t${t}${fl ? '-f' : ''}`);
      }
    } else {
      await shot(`structure=${encodeURIComponent(n)}`, n);
    }
  }
}

await browser.close();
server.close();
console.log('[cell-snap] saved:');
for (const s of shots) console.log('  ' + s);
