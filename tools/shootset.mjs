// tools/shootset.mjs — capture idle + a motion frame for many demo URLs in ONE browser.
// Usage: node tools/shootset.mjs <outDir> label=url [label=url ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'tmp/shots';
const demos = process.argv.slice(3).map((s) => { const i = s.indexOf('='); return { label: s.slice(0, i), url: s.slice(i + 1) }; });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});

for (const { label, url } of demos) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const kd = (k) => page.evaluate((x) => window.dispatchEvent(new KeyboardEvent('keydown', { key: x })), k);
  const ku = (k) => page.evaluate((x) => window.dispatchEvent(new KeyboardEvent('keyup', { key: x })), k);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !(document.body.textContent || '').includes('LOADING CREW'), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2600);
  await page.screenshot({ path: join(outDir, `${label}-idle.png`) });
  await kd('d'); await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, `${label}-move.png`) });
  await ku('d');
  console.log(label, errs.length ? `ERRORS: ${errs.slice(0, 3).join(' | ')}` : 'ok');
  await page.close();
}
await browser.close();
console.log('done');
