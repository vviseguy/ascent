// scripts/tex-tile-shot.mjs — render a 3x3 tiling of textures so a seam is VISIBLE.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
const dir = resolve('public/textures');
const files = process.argv.slice(2);
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try { const b = await readFile(join(dir, decodeURIComponent(req.url.slice(1))));
        res.writeHead(200, { 'content-type': MIME[extname(req.url)] ?? 'text/html' }); res.end(b); }
  catch { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body></body></html>'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340 * files.length, height: 380 } });
await page.goto(`http://127.0.0.1:${port}/__blank`);
await page.setContent(`<body style="margin:0;background:#111;display:flex;font:12px system-ui;color:#ccc">` +
  files.map((f) => `<figure style="margin:0;padding:8px"><div style="width:320px;height:320px;
     background-image:url(/${f});background-size:106.67px 106.67px"></div>
     <figcaption style="padding-top:6px">${f} — 3×3</figcaption></figure>`).join('') + `</body>`);
await page.waitForTimeout(900);
await page.screenshot({ path: process.env.OUT ?? 'tmp/tile-shot.png' });
await browser.close(); server.close();
console.log('wrote', process.env.OUT ?? 'tmp/tile-shot.png');
