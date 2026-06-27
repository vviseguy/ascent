// ============================================================================
// scripts/fetch-kaykit.mjs — download the free KayKit asset packs + emit a manifest.
// ============================================================================
//
// One-shot, re-runnable. For each pack it pulls the GitHub tarball (CC0, from
// github.com/KayKit-Game-Assets), extracts the model folder (Assets/gltf), and copies
// the files VERBATIM into public/models/<dir>/. The gltf packs ship a per-model <name>.bin
// + one shared <pack>_texture.png in that same folder; Three's GLTFLoader resolves both
// relative to the .gltf URL, so nothing is converted. Dungeon Remastered ships
// self-contained <name>.gltf.glb. The legacy `dungeon` pack is ALREADY on disk (the 6
// hand-made objects/*.ts depend on it) — we only list it, never re-download.
//
// Then it writes src/lab/kaykit-packs.generated.ts: { packId -> [model base-names] } so
// the catalog is a committed static literal (tree-shakeable, no FS at boot) yet always in
// sync with what is actually on disk.
//
// Mechanism: curl (download, -L follows the API tarball redirect) + tar (plain extract to a
// temp dir, no divergent flags) — both ship on Windows 11 and in Git Bash. Selection/copy +
// manifest are pure Node fs, so the only external tools are curl + tar with portable flags.
//
//   node scripts/fetch-kaykit.mjs
// ============================================================================

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync, rmSync, mkdirSync, cpSync, readdirSync, writeFileSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'public', 'models');
const ORG = 'KayKit-Game-Assets';

/** Packs to DOWNLOAD: repo → target dir + the model extension that pack ships. */
const DOWNLOADS = [
  { id: 'dungeon_remastered', repo: 'KayKit-Dungeon-Remastered-1.0', dir: 'kaykit_dungeon_remastered', ext: '.glb' },
  { id: 'furniture', repo: 'KayKit-Furniture-Bits-1.0', dir: 'kaykit_furniture', ext: '.gltf' },
  { id: 'halloween', repo: 'KayKit-Halloween-Bits-1.0', dir: 'kaykit_halloween', ext: '.gltf' },
  { id: 'restaurant', repo: 'KayKit-Restaurant-Bits-1.0', dir: 'kaykit_restaurant', ext: '.gltf' },
  { id: 'hexagon', repo: 'KayKit-Medieval-Hexagon-Pack-1.0', dir: 'kaykit_hexagon', ext: '.gltf' },
  { id: 'city', repo: 'KayKit-City-Builder-Bits-1.0', dir: 'kaykit_city', ext: '.gltf' },
  { id: 'prototype', repo: 'KayKit-Prototype-Bits-1.0', dir: 'kaykit_prototype', ext: '.gltf' },
  { id: 'spacebase', repo: 'KayKit-Space-Base-Bits-1.0', dir: 'kaykit_spacebase', ext: '.gltf' },
];
/** Packs ALREADY on disk: just listed for the manifest, never re-downloaded. */
const EXISTING = [{ id: 'dungeon', dir: 'kaykit_dungeon', ext: '.glb' }];

/** Recursively find the first directory whose path ends with `Assets/gltf`. */
function findGltfDir(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    const norm = d.split(sep).join('/');
    if (norm.endsWith('/Assets/gltf')) return d;
    for (const e of entries) if (e.isDirectory()) stack.push(join(d, e.name));
  }
  return null;
}

/** Model base-names under a dir for a given extension, RECURSIVELY. Returns forward-slash
 *  paths relative to `dir` with the extension stripped (e.g. 'tiles/base/hex_grass' for the
 *  nested hexagon pack, 'armchair' for a flat pack). Sorted + deduped. Preserving the
 *  sub-structure keeps each .gltf's relative .bin/texture refs resolving after the copy. */
function baseNames(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), childRel);
      else if (e.name.toLowerCase().endsWith(ext)) out.push(childRel.slice(0, -ext.length));
    }
  };
  walk(dir, '');
  return [...new Set(out)].sort();
}

// SKIP_DOWNLOAD=1 re-lists the on-disk packs + regenerates the manifest WITHOUT re-fetching.
const skipDownload = process.env.SKIP_DOWNLOAD === '1';
const tmp = mkdtempSync(join(tmpdir(), 'kaykit-'));
const manifest = {};
try {
  for (const pack of DOWNLOADS) {
    const target = join(MODELS, pack.dir);
    if (!skipDownload) {
      const tarball = join(tmp, `${pack.id}.tar.gz`);
      const url = `https://api.github.com/repos/${ORG}/${pack.repo}/tarball`;
      process.stdout.write(`• ${pack.id}: downloading ${pack.repo} … `);
      execFileSync('curl', ['-sL', url, '-o', tarball], { stdio: ['ignore', 'ignore', 'inherit'] });
      const size = statSync(tarball).size;
      if (size < 1024) throw new Error(`tarball for ${pack.repo} is suspiciously small (${size} bytes)`);

      const extract = join(tmp, pack.id);
      mkdirSync(extract, { recursive: true });
      // GNU tar on Windows: --force-local stops it reading the `C:` in a path as a remote
      // host; forward-slash the -f path and extract via cwd (not -C) to dodge colon quirks.
      const tarballPosix = tarball.split(sep).join('/');
      execFileSync('tar', ['--force-local', '-xzf', tarballPosix], { cwd: extract, stdio: ['ignore', 'ignore', 'inherit'] });

      const gltfDir = findGltfDir(extract);
      if (!gltfDir) throw new Error(`no Assets/gltf folder found in ${pack.repo}`);

      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(gltfDir, target, { recursive: true });
    }

    manifest[pack.id] = baseNames(target, pack.ext);
    console.log(`• ${pack.id}: ${manifest[pack.id].length} models${skipDownload ? ' (relisted)' : ` → public/models/${pack.dir}/`}`);
  }

  for (const pack of EXISTING) {
    manifest[pack.id] = baseNames(join(MODELS, pack.dir), pack.ext);
    console.log(`• ${pack.id}: ${manifest[pack.id].length} models (already on disk)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- write the committed manifest (kept in DOWNLOADS-then-EXISTING order) ----
const order = [...DOWNLOADS, ...EXISTING].map((p) => p.id);
const body = order
  .map((id) => `  ${id}: [\n${manifest[id].map((n) => `    '${n}',`).join('\n')}\n  ],`)
  .join('\n');
const out = `// ============================================================================
// src/lab/kaykit-packs.generated.ts — AUTO-GENERATED by scripts/fetch-kaykit.mjs.
// ============================================================================
// Do NOT edit by hand. Re-run \`node scripts/fetch-kaykit.mjs\` to regenerate.
// Maps each KayKit packId → its model base-names (filename without extension). The
// catalog (kaykit-catalog.ts) reconstructs each meshUrl as models/<dir>/<base>.<ext>.
// ============================================================================

export const PACK_FILES: Record<string, readonly string[]> = {
${body}
};
`;
const outPath = join(ROOT, 'src', 'lab', 'kaykit-packs.generated.ts');
writeFileSync(outPath, out);
const total = Object.values(manifest).reduce((s, a) => s + a.length, 0);
console.log(`\n✓ wrote ${outPath} — ${total} models across ${order.length} packs`);
