#!/usr/bin/env node
// ============================================================================
// scripts/lab-snap.mjs — headless screenshots of Asset Lab elements.
// ============================================================================
//
// THE feedback loop for AI-designed art: build the lab, render an element in
// headless Chromium (SwiftShader WebGL), and save turntable PNGs that an agent
// (or a human) can look at and iterate on.
//
//   node scripts/lab-snap.mjs <elementId> [seed] [--actor] [--no-build]
//        [--angles=30,150,270] [--time=2.5] [--out=lab-shots]
//
// Output: lab-shots/<element>-s<seed>-a<angle>[-actor].png
// With --actor, an extra shot is taken with the demo capsule INSIDE the element
// (time chosen so the orbit is at its innermost point) to show reactivity.
// ============================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags.set(k, v ?? '1');
  } else positional.push(a);
}
const element = positional[0];
if (!element) {
  console.error('usage: node scripts/lab-snap.mjs <elementId> [seed] [--actor] [--no-build] [--angles=a,b,c] [--time=T] [--out=dir]');
  process.exit(2);
}
const seed = Number(positional[1] ?? '1') || 1;
const withActor = flags.has('actor');
const angles = (flags.get('angles') ?? '30,150,270').split(',').map(Number);
const timeSec = Number(flags.get('time') ?? '2.5');
const outDir = flags.get('out') ?? 'lab-shots';
const root = resolve(import.meta.dirname, '..');
// --dist=<dir> gives each parallel design agent its OWN build output so
// concurrent `vite build`s never clobber one another (default: dist).
const distName = flags.get('dist') ?? 'dist';
const dist = join(root, distName);

// 1. build (skippable when iterating fast on snaps only)
if (!flags.has('no-build')) {
  console.log(`[lab-snap] vite build → ${distName}…`);
  execSync(`npx vite build --logLevel=error --outDir=${distName}`, { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(dist, 'lab.html'))) {
  console.error('[lab-snap] dist/lab.html missing — build failed?');
  process.exit(1);
}

// 2. tiny static server mapping /ascent/* -> dist/* (matches the vite base)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname.replace(/^\/ascent\/?/, '');
    if (p === '' || p === '/') p = 'index.html';
    const file = join(dist, p);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// 3. headless chromium with software WebGL
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const logs = [];
page.on('console', (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const q = `element=${encodeURIComponent(element)}&seed=${seed}&frozen=1${withActor ? '&actor=1' : ''}`;
await page.goto(`http://127.0.0.1:${port}/ascent/lab.html?${q}`);
try {
  await page.waitForFunction('window.__LAB_READY === true || typeof window.__LAB_ERROR === "string"', null, { timeout: 20000 });
} catch {
  console.error('[lab-snap] page never became ready. console:\n' + logs.join('\n'));
  await browser.close(); server.close(); process.exit(1);
}
const err = await page.evaluate('window.__LAB_ERROR');
if (err) {
  console.error(`[lab-snap] lab error: ${err}`);
  await browser.close(); server.close(); process.exit(1);
}

mkdirSync(join(root, outDir), { recursive: true });
const saved = [];
for (const a of angles) {
  await page.evaluate(`window.__labSetTime(${timeSec}); window.__labSetAngle(${a});`);
  const f = join(root, outDir, `${element}-s${seed}-a${a}${withActor ? '-actor' : ''}.png`);
  await page.screenshot({ path: f });
  saved.push(f);
}
if (withActor) {
  // a second actor shot at a time where the orbit is at its innermost point
  // (sin(t*0.9) = -1 → t ≈ 5.236/0.9·? — just sample a few times and keep one inside)
  await page.evaluate(`window.__labSetTime(${(Math.PI * 1.5) / 0.9}); window.__labSetAngle(${angles[0]});`);
  const f = join(root, outDir, `${element}-s${seed}-inside-actor.png`);
  await page.screenshot({ path: f });
  saved.push(f);
}

await browser.close();
server.close();
console.log('[lab-snap] saved:');
for (const f of saved) console.log('  ' + f);
