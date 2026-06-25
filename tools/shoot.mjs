// tools/shoot.mjs — headless screenshot harness for the ASCENT WebGL demo.
// Loads the running Vite dev server in headless Chrome (software WebGL via
// SwiftShader so it works without a GPU), drives some input to exercise the
// character animation states, and writes a sequence of PNGs for visual review.
//
// Usage: node tools/shoot.mjs <outDir> <label> [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'tmp/shots';
const label = process.argv[3] ?? 'shot';
const url = process.argv[4] ?? 'http://localhost:5173';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const shot = async (name) => {
  const p = join(outDir, `${label}-${name}.png`);
  await page.screenshot({ path: p });
  console.log('shot', p);
};

await page.goto(url, { waitUntil: 'load', timeout: 30000 });

// confirm a WebGL canvas actually came up
const glOk = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return 'no-canvas';
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return gl ? 'ok' : 'no-webgl';
});
console.log('webgl:', glOk, 'size:', await page.evaluate(() => { const c = document.querySelector('canvas'); return c ? `${c.width}x${c.height}` : 'n/a'; }));

// Drive input by dispatching real KeyboardEvents on window (the app listens there);
// Playwright's keyboard needs a focused element, which a bare canvas isn't.
const kd = (key) => page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), key);
const ku = (key) => page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true })), key);

await page.waitForTimeout(2500);          // let the crew drop onto the slab + settle
await shot('01-idle');

// WALK/RUN: hold right long enough to separate the controlled body from the cluster
await kd('d');
await page.waitForTimeout(1800);
await shot('02-run');
await ku('d');
await page.waitForTimeout(500);

// JUMP → airborne → land
await kd(' ');
await page.waitForTimeout(80); await ku(' ');
await page.waitForTimeout(160); await shot('03-air');
await page.waitForTimeout(520); await shot('04-land');

// RUSH/dash (hold a direction, tap rush)
await kd('a'); await kd('j');
await page.waitForTimeout(90); await ku('j');
await page.waitForTimeout(90); await shot('05-rush');
await ku('a');

// a closer idle beat for the body read
await page.waitForTimeout(900); await shot('06-settle');

if (errors.length) { console.log('--- PAGE ERRORS ---'); for (const e of errors.slice(0, 20)) console.log(e); }
await browser.close();
console.log('done');
