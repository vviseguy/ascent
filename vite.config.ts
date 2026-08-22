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

// ---- FACE-SURFACE store middleware (dev only) -----------------------------------------------
// The lab POSTs a mesh URL and its hidden-triangle lists; the game reads the JSON through
// src/lab/face-surfaces.ts. Keyed by MESH URL, not lab object id — hidden geometry is a property
// of the mesh, so two catalog entries on the same GLB share the edit. Dev-only.
function surfacesPlugin(): PluginOption {
  const STORE = r('./src/game/mesh-surfaces.json');
  const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
    new Promise((res) => { let b = ''; req.on('data', (c) => (b += String(c))); req.on('end', () => res(b)); });
  return {
    name: 'lab-surfaces',
    configureServer(server) {
      server.middlewares.use('/__lab/surfaces', (req, res, next) => {
        const read = () => JSON.parse(readFileSync(STORE, 'utf8')) as { version: number; meshes: Record<string, unknown> };
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') { res.statusCode = 200; res.end(JSON.stringify(read())); return; }
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const { meshUrl, entry, remove } = JSON.parse(await readBody(req)) as { meshUrl: string; entry?: Record<string, unknown>; remove?: boolean };
            if (!meshUrl) throw new Error('missing meshUrl');
            const store = read();
            if (remove) delete store.meshes[meshUrl];
            else store.meshes[meshUrl] = entry ?? {};
            store.meshes = Object.fromEntries(Object.entries(store.meshes).sort(([a], [b]) => a.localeCompare(b)));
            writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, count: Object.keys(store.meshes).length }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        })();
      });
    },
  };
}

// ---- MATERIAL-PROFILE store middleware (dev only) -------------------------------------------
// GET returns the whole profile store; POST upserts (or removes) one profile. The lab is the only
// writer. Kept git-tracked and key-sorted so a look change reviews as a readable diff instead of
// living in someone’s query string. Dev-only; no production-build effect.
function profilesPlugin(): PluginOption {
  const STORE = r('./src/lab/material-profiles.json');
  const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
    new Promise((res) => { let b = ''; req.on('data', (c) => (b += String(c))); req.on('end', () => res(b)); });
  return {
    name: 'lab-profiles',
    configureServer(server) {
      server.middlewares.use('/__lab/profiles', (req, res, next) => {
        const read = () => JSON.parse(readFileSync(STORE, 'utf8')) as { version: number; profiles: Record<string, unknown> };
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') { res.statusCode = 200; res.end(JSON.stringify(read())); return; }
        if (req.method !== 'POST') return next();
        void (async () => {
          try {
            const { id, profile, remove } = JSON.parse(await readBody(req)) as { id: string; profile?: Record<string, unknown>; remove?: boolean };
            if (!id) throw new Error('missing id');
            const store = read();
            if (remove) delete store.profiles[id];
            else store.profiles[id] = profile ?? {};
            store.profiles = Object.fromEntries(Object.entries(store.profiles).sort(([a], [b]) => a.localeCompare(b)));
            writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, count: Object.keys(store.profiles).length }));
          } catch (e) {
            res.statusCode = 400;
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
  const STORE = r('./src/game/structures.json');
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
  plugins: [labApprovePlugin(), structuresPlugin(), profilesPlugin(), surfacesPlugin()],
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
        sheet: r('./sheet.html'),
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
