// scripts/tex-seam-check.mjs — is a texture PERIODIC (tileable)? Numeric wrap-seam check.
//
// Metric: compare the pixel difference ACROSS the wrap seam (last column vs first column,
// last row vs first row) against the AVERAGE interior neighbour difference of the image.
//   ratio = seamDiff / interiorDiff
//   ~1.0  → the seam looks exactly like any other place in the image  = SEAMLESS
//   >2    → visible line when tiled
// Run: npm run tex:seams  (or: node scripts/tex-seam-check.mjs [dir])
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const dir = resolve(process.argv[2] ?? 'public/textures');
const files = readdirSync(dir).filter((f) => /_diff\.(jpg|png)$/i.test(f));
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try { const b = await readFile(join(dir, decodeURIComponent(req.url.slice(1))));
        res.writeHead(200, { 'content-type': MIME[extname(req.url)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/__blank`).catch(() => {});
 await page.setContent('<html><body></body></html>');
const rows = [];
for (const f of files) {
  const r = await page.evaluate(async ([url]) => {
    const img = new Image(); img.src = url; await img.decode();
    const W = Math.min(img.naturalWidth, 1024), H = Math.min(img.naturalHeight, 1024);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    let seamX = 0, seamY = 0, intX = 0, intY = 0;
    for (let y = 0; y < H; y++) seamX += Math.abs(lum(W - 1, y) - lum(0, y));
    for (let x = 0; x < W; x++) seamY += Math.abs(lum(x, H - 1) - lum(x, 0));
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) intX += Math.abs(lum(x, y) - lum(x - 1, y));
    for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) intY += Math.abs(lum(x, y) - lum(x, y - 1));
    // mean brightness drift between the two halves = the "big blotch" tiling tell
    let l = 0, rr = 0, t = 0, b = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = lum(x, y); (x < W / 2 ? (l += v) : (rr += v)); (y < H / 2 ? (t += v) : (b += v)); }
    const half = (W * H) / 2;
    return { W: img.naturalWidth, H: img.naturalHeight,
      sx: seamX / H, sy: seamY / W, ix: intX / (H * (W - 1)), iy: intY / (W * (H - 1)),
      driftX: Math.abs(l - rr) / half, driftY: Math.abs(t - b) / half };
  }, [`http://127.0.0.1:${port}/${f}`]);
  rows.push({ f, ...r, rx: r.sx / r.ix, ry: r.sy / r.iy });
}
await browser.close(); server.close();

rows.sort((a, b) => Math.max(b.rx, b.ry) - Math.max(a.rx, a.ry));
console.log('file'.padEnd(26), 'size'.padEnd(11), 'seamX', ' seamY', '  verdict     drift(L/R,T/B)');
for (const r of rows) {
  const worst = Math.max(r.rx, r.ry);
  const v = worst < 1.35 ? 'SEAMLESS' : worst < 2.0 ? 'soft seam' : 'VISIBLE SEAM';
  console.log(r.f.padEnd(26), `${r.W}x${r.H}`.padEnd(11),
    r.rx.toFixed(2).padStart(5), r.ry.toFixed(2).padStart(6), ' ', v.padEnd(13),
    `${r.driftX.toFixed(1)}/${r.driftY.toFixed(1)}`);
}
