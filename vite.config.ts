import { defineConfig, type PluginOption } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

// Path aliases mirror tsconfig.json "paths". Keep them in sync.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// ---- ASSET-LAB APPROVE middleware (dev only) -------------------------------------------------
// The lab can't write files from the browser, so it POSTs an approved entry here and we merge it
// into src/game/approved-assets.json (pretty-printed + key-sorted for clean git diffs). This is the
// "publish" step: auto-fit/recolor in the lab → reviewer approves → frozen data the game reads.
// Only runs in `vite dev`; has no effect on the production build.
function labApprovePlugin(): PluginOption {
  const STORE = r('./src/game/approved-assets.json');
  const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
    new Promise((res) => { let b = ''; req.on('data', (c) => (b += String(c))); req.on('end', () => res(b)); });
  return {
    name: 'lab-approve',
    configureServer(server) {
      server.middlewares.use('/__lab/approve', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const { objectId, asset, remove } = JSON.parse(await readBody(req)) as {
              objectId: string; asset?: Record<string, unknown>; remove?: boolean;
            };
            if (!objectId) throw new Error('missing objectId');
            const store = JSON.parse(readFileSync(STORE, 'utf8')) as { version: number; objects: Record<string, unknown> };
            if (remove) delete store.objects[objectId];
            else store.objects[objectId] = { ...asset, approvedAt: new Date().toISOString() };
            // stable order so diffs are minimal
            store.objects = Object.fromEntries(Object.entries(store.objects).sort(([a], [b]) => a.localeCompare(b)));
            writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
            res.statusCode = 200; res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: Object.keys(store.objects).length }));
          } catch (e) {
            res.statusCode = 400; res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        })();
      });
    },
  };
}

// ---- TILE-STRUCTURE store middleware (dev only) ---------------------------------------------
// The tile editor POSTs a painted grid here and we merge it into src/game/structures.json (pretty +
// key-sorted). GET returns the whole store so the editor can list/load. The game reads the JSON via
// src/game/structures.ts. Dev-only; no production-build effect.
function structuresPlugin(): PluginOption {
  const STORE = r('./src/floor/structures.json');
  const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
    new Promise((res) => { let b = ''; req.on('data', (c) => (b += String(c))); req.on('end', () => res(b)); });
  return {
    name: 'lab-structures',
    configureServer(server) {
      server.middlewares.use('/__lab/structures', (req, res, next) => {
        const read = () => JSON.parse(readFileSync(STORE, 'utf8')) as { version: number; structures: Record<string, unknown> };
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') { res.statusCode = 200; res.end(JSON.stringify(read())); return; }
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const { name, structure, remove } = JSON.parse(await readBody(req)) as { name: string; structure?: Record<string, unknown>; remove?: boolean };
            if (!name) throw new Error('missing name');
            const store = read();
            if (remove) delete store.structures[name];
            else store.structures[name] = { ...structure, savedAt: new Date().toISOString() };
            store.structures = Object.fromEntries(Object.entries(store.structures).sort(([a], [b]) => a.localeCompare(b)));
            writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
            res.statusCode = 200; res.end(JSON.stringify({ ok: true, count: Object.keys(store.structures).length }));
          } catch (e) {
            res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [labApprovePlugin(), structuresPlugin()],
  // Served from a GitHub Pages PROJECT site at vviseguy.github.io/ascent/, so all
  // asset URLs must be prefixed with the repo name. (Harmless in dev.)
  base: '/ascent/',
  build: {
    rollupOptions: {
      // Two pages: the game (index) and the ASSET LAB (lab) — a turntable gallery
      // where art elements are designed with screenshot feedback (scripts/lab-snap.mjs).
      input: {
        main: r('./index.html'),
        lab: r('./lab.html'),
        walltile: r('./walltile.html'),
        board: r('./board.html'),
        tileeditor: r('./tile-editor.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@sim': r('./src/sim'),
      '@net': r('./src/net'),
      '@render': r('./src/render'),
      '@game': r('./src/game'),
      '@floor': r('./src/floor'),
    },
  },
});
