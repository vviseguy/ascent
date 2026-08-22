#!/usr/bin/env node
// ============================================================================
// scripts/editor-snap.mjs — headless screenshot of the CELL EDITOR itself.
// ============================================================================
//
// `cell-snap.mjs` shows what the generator will BUILD. This shows the authoring surface: the
// schematic, its colours and hatches, the brush strip and the legend — the parts a unit test cannot
// look at. It drives the running DEV server, because the editor reads its structure store from the
// dev middleware (`/__lab/cell-structures`) and a static build has no such thing.
//
//   npm run dev                                   # in another terminal
//   node scripts/editor-snap.mjs [structure] [--port=5183] [--out=cell-shots/editor]
//
// ============================================================================

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Map();
const pos = [];
for (const a of args) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags.set(k, v ?? '1'); } else pos.push(a);
}
const port = flags.get('port') ?? '5183';
const root = resolve(import.meta.dirname, '..');
const outDir = flags.get('out') ?? 'cell-shots/editor';
const want = pos[0] ?? null;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(flags.get('w') ?? 1500), height: Number(flags.get('h') ?? 950) } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[page] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const url = `http://localhost:${port}/ascent/cell-editor.html`;
try {
  await page.goto(url, { timeout: 15000 });
} catch {
  console.error(`[editor-snap] could not reach ${url} — is \`npm run dev\` running?`);
  await browser.close(); process.exit(1);
}
await page.waitForSelector('#grid rect', { timeout: 20000 });

if (want) {
  const clicked = await page.evaluate((name) => {
    const el = [...document.querySelectorAll('.item .nm')].find((e) => e.textContent.includes(name));
    if (!el) return [...document.querySelectorAll('.item .nm')].map((e) => e.textContent);
    el.click();
    return true;
  }, want);
  if (clicked !== true) {
    console.error(`[editor-snap] no structure matching "${want}". Have: ${JSON.stringify(clicked)}`);
    await browser.close(); process.exit(1);
  }
}
// storeys: --levels=N clicks "add a storey" until there are N, --level=k selects one to edit
const wantLevels = Number(flags.get('levels') ?? 1);
for (let i = 1; i < wantLevels; i++) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#brushbar .bb-levels button')].find((e) => e.textContent === '+');
    b?.click();
  });
  await page.waitForTimeout(120);
}
if (flags.has('level')) {
  await page.evaluate((k) => {
    const c = [...document.querySelectorAll('#brushbar .lvchip')].find((e) => e.textContent === String(k));
    c?.click();
  }, flags.get('level'));
  await page.waitForTimeout(150);
}
if (flags.has('view')) {
  await page.evaluate((v) => {
    const c = [...document.querySelectorAll('#brushbar .lvchip.wide')][0];
    if (c && c.textContent.trim() !== v) c.click();
  }, flags.get('view'));
  await page.waitForTimeout(150);
}

// the 3D rebuild is debounced and then loads GLBs; give it room
await page.waitForTimeout(2600);

mkdirSync(join(root, outDir), { recursive: true });
const tag = (want ?? 'blank') + (wantLevels > 1 ? `-L${wantLevels}` : '') + (flags.has('level') ? `-at${flags.get('level')}` : '');
const f = join(root, outDir, `${tag.replace(/[^\w.-]+/g, '_')}.png`);
await page.screenshot({ path: f });
if (logs.length) console.error('[editor-snap] page errors:\n  ' + logs.join('\n  '));
console.log('[editor-snap] saved: ' + f);
await browser.close();
