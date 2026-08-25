#!/usr/bin/env node
// ============================================================================
// scripts/fp-snap.mjs — headless screenshots from the EYE-LEVEL camera (?cam=fp).
// ============================================================================
//
// The point of `?cam=fp` is that a surface has to hold up at 40 cm in the REAL world,
// not on a turntable and not from six metres up. This is how an agent (or CI, or a
// human without a GPU) actually looks at that. Same trick as lab-snap / cell-snap:
// build, serve dist, drive headless Chromium with software WebGL.
//
//   node scripts/fp-snap.mjs --name=wall --walk=900 --yaw=180
//   node scripts/fp-snap.mjs --name=up --pitch=60 --hud     (what the ceiling does)
//   node scripts/fp-snap.mjs --name=nocut --extra=cut=0     (cutaway off — see docs)
//
//   --seed=N --grid=N   the tower (default seed 7, grid 15 — small and legible)
//   --yaw=deg           where the eye looks. 0 = −Z, 180 = +Z (into the dungeon).
//   --pitch=deg         0 = horizon, + = up. Clamped to ±88 by the mode itself.
//   --aim=deg           where to look for the SHOT, if that is not the way you walked
//   --walk=ms           hold W for this long BEFORE aiming, to close on a wall. WASD is
//                       relative to the eye's yaw, so --yaw picks the direction too.
//   --strafe=ms         same, holding D (positive) or A (negative).
//   --settle=ms         extra wait before the shot (default 700) — the dungeon streams in.
//   --hud               keep the game HUD + the mode's own badge (default: hidden)
//   --extra=a=1&b=2     appended to the query, for the existing switches (cut=0, fog=off…)
//   --size=WxH          viewport, default 1100x740     --out=dir   default fp-shots
//   --no-build --dist=d
//
// Output: fp-shots/<name>.png
// ============================================================================

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const flags = new Map();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags.set(k, v ?? '1'); }
}
const num = (k, d) => { const v = Number(flags.get(k)); return Number.isFinite(v) ? v : d; };

const root = resolve(import.meta.dirname, '..');
const dist = join(root, flags.get('dist') ?? 'dist');
const outDir = flags.get('out') ?? 'fp-shots';
const name = flags.get('name') ?? 'fp';
const [vw, vh] = (flags.get('size') ?? '1100x740').split('x').map(Number);

if (!flags.has('no-build')) {
  console.log('[fp-snap] vite build…');
  execSync('npx vite build --logLevel=error', { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('[fp-snap] dist/index.html missing — build failed?');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream',
};
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

// SwiftShader: no GPU in CI or in an agent's sandbox, and the surface work is all
// fragment-stage — software rasterisation shows it faithfully, just slowly.
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const logs = [];
page.on('console', (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const q = `cam=fp&debug=1&seed=${num('seed', 7)}&grid=${num('grid', 15)}`
  + (flags.has('extra') ? `&${flags.get('extra')}` : '');
await page.goto(`http://127.0.0.1:${port}/ascent/index.html?${q}`);
try {
  await page.waitForFunction('window.__fp && window.__renderer', null, { timeout: 60000 });
} catch {
  console.error('[fp-snap] page never booted. console:\n' + logs.join('\n'));
  await browser.close(); server.close(); process.exit(1);
}

// AIM FIRST, WALK SECOND: WASD is relative to the eye's yaw (the shipped control frame),
// so pointing the eye is also choosing which way `--walk` goes.
const yaw = (num('yaw', 180) * Math.PI) / 180, pitch = (num('pitch', 0) * Math.PI) / 180;
await page.evaluate(`window.__fp.look(${yaw}, ${pitch})`);

const walk = num('walk', 0), strafe = num('strafe', 0);
if (walk !== 0) {
  await page.keyboard.down(walk > 0 ? 'w' : 's');
  await page.waitForTimeout(Math.abs(walk));
  await page.keyboard.up(walk > 0 ? 'w' : 's');
}
if (strafe !== 0) {
  await page.keyboard.down(strafe > 0 ? 'd' : 'a');
  await page.waitForTimeout(Math.abs(strafe));
  await page.keyboard.up(strafe > 0 ? 'd' : 'a');
}
// FINAL AIM, after the walk: `--aim` lets the shot look somewhere other than the way it
// travelled — walk down a corridor, then turn and put your face on the wall beside you.
const aim = flags.has('aim') ? (num('aim', 0) * Math.PI) / 180 : yaw;
await page.evaluate(`window.__fp.look(${aim}, ${pitch})`);

if (!flags.has('hud')) {
  // Every overlay is a child of #app; hiding them all leaves exactly the canvas, which is
  // the deliverable. (The mode's own badge/veil are in there too — one mechanism, not two.)
  await page.evaluate(
    "document.querySelectorAll('#app > *').forEach((e) => { if (e.tagName !== 'CANVAS') e.style.visibility = 'hidden'; });",
  );
}
await page.waitForTimeout(num('settle', 700));

mkdirSync(join(root, outDir), { recursive: true });
const file = join(root, outDir, `${name}.png`);
// SwiftShader + the post stack (SMAA → bloom → ACES) is SECONDS per frame on a dungeon
// this size, and the capture has to wait for one. The default 30 s is not enough.
await page.screenshot({ path: file, timeout: num('shotTimeout', 240000) });

const pose = await page.evaluate(
  'JSON.stringify({ pos: window.__renderer.camera.position, fov: window.__renderer.camera.fov, near: window.__renderer.camera.near })',
);
await browser.close();
server.close();
console.log(`[fp-snap] ${file}\n[fp-snap] camera ${pose}`);
const errs = logs.filter((l) => l.startsWith('[pageerror]') || l.includes(':error]'));
if (errs.length) console.log('[fp-snap] page errors:\n' + errs.join('\n'));
