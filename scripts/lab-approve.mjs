#!/usr/bin/env node
// ============================================================================
// scripts/lab-approve.mjs — headless box-fit + approve of the wall-tile pieces.
// ============================================================================
//
// Box-fit lives in the browser, and the /__lab/approve middleware lives in the vite DEV server. So:
// spin up `vite`, open each piece in headless Chromium (SwiftShader WebGL), refit at a chosen edge
// density via window.__labApprove(ed), and publish — freezing footprint + materials into
// src/game/approved-assets.json. No 13 manual clicks; re-runnable when meshes change.
//
//   node scripts/lab-approve.mjs [edgeDensity]      (default 0.4)
//
// NOTE: each approve writes the JSON → vite HMR-reloads → can abort the NEXT navigation, so goto is
// retried. The pieces are the wall/barrier/pillar GLBs the 9-cell tile renders (floors = slabs).
// ============================================================================

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ed = Number(process.argv[2] ?? '0.4') || 0.4;
const stripAnsi = (s) => s.replace(/\x1b?\[[0-9;]*m/g, ''); // vite colourises the port — drop ANSI
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SLUGS = [
  'wall', 'wall_half', 'wall_half_endcap', 'wall_corner', 'barrier_corner',
  'wall_arched', 'wall_archedwindow_open', 'wall_gated', 'wall_broken',
  'pillar', 'barrier', 'barrier_half', 'barrier_column',
];
const ids = SLUGS.map((s) => `kk-dungeon_remastered-${s}`);

// 1. start the vite dev server (carries the /__lab/approve middleware)
const vite = spawn('npx', ['vite', '--host', '127.0.0.1'], { cwd: root, shell: process.platform === 'win32' });
let base = '';
let buf = '';
await new Promise((res, rej) => {
  const onData = (d) => {
    buf += d.toString();
    const m = stripAnsi(buf).match(/(http:\/\/127\.0\.0\.1:\d+)\/ascent/);
    if (m && !base) { base = `${m[1]}/ascent`; res(); }
  };
  vite.stdout.on('data', onData);
  vite.stderr.on('data', onData);
  setTimeout(() => rej(new Error('vite did not report a /ascent URL in 60s:\n' + buf)), 60000);
}).catch((e) => { console.error('[lab-approve]', e.message); vite.kill(); process.exit(1); });
console.log(`[lab-approve] vite at ${base} — approving ${ids.length} pieces at edge density ${ed}`);

// 2. headless chromium (software WebGL, same flags as lab-snap)
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

const gotoReady = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction('window.__LAB_READY === true && typeof window.__labApprove === "function"', null, { timeout: 30000 });
      return true;
    } catch {
      await sleep(500); // an HMR reload from the previous approve raced us — settle + retry
    }
  }
  return false;
};

let ok = 0;
const failures = [];
for (const id of ids) {
  const url = `${base}/lab.html?object=${encodeURIComponent(id)}&frozen=1`;
  try {
    if (!(await gotoReady(url))) { console.log(`  x ${id} — never became ready`); failures.push(id); continue; }
    const r = await page.evaluate((e) => window.__labApprove(e), ed);
    if (r && r.ok) { console.log(`  ok ${id}`); ok++; }
    else { console.log(`  x ${id} — ${JSON.stringify(r)}`); failures.push(id); }
    await sleep(700); // let the JSON-write HMR reload settle before the next navigation
  } catch (e) {
    console.log(`  x ${id} — ${String(e.message ?? e).split('\n')[0]}`); failures.push(id);
  }
}

await browser.close();
vite.kill();
console.log(`[lab-approve] approved ${ok}/${ids.length}${failures.length ? ` · failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
