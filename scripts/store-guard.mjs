#!/usr/bin/env node
// ============================================================================
// scripts/store-guard.mjs — run a command without letting it leave edits in the
// git-tracked authoring stores.
// ============================================================================
//
// The lab's dev middleware exists to write `src/game/*.json` — that is the point of Approve and of
// the surfaces Save button. Which means any headless run that drives those buttons ALSO writes
// them, and a fixture left behind by a test looks exactly like an authored edit in review. That is
// not hypothetical: a Playwright run once committed 344 of the dungeon wall's 494 triangles as
// hidden, and it shipped, because remembering to reset the file is not a control.
//
//   node scripts/store-guard.mjs node tmp/whatever.mjs      # run, then restore
//   node scripts/store-guard.mjs --restore                  # just restore (after an interactive session)
//   node scripts/store-guard.mjs --check                    # exit 1 if a store is dirty, change nothing
//
// Snapshots the CURRENT contents (not HEAD) so it is safe over a genuine in-progress edit too: it
// restores what was there when you started, whatever that was.
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every git-tracked file the lab's dev middleware can write. Add one when you add a store. */
const STORES = [
  'src/game/approved-assets.json',
  'src/game/mesh-surfaces.json',
  'src/game/structures.json',
  'src/lab/material-profiles.json',
];

const paths = STORES.map((p) => resolve(root, p)).filter((p) => existsSync(p));
const snapshot = new Map(paths.map((p) => [p, readFileSync(p, 'utf8')]));

const restore = () => {
  const changed = [];
  for (const [p, before] of snapshot) {
    if (readFileSync(p, 'utf8') !== before) { writeFileSync(p, before); changed.push(p.slice(root.length + 1)); }
  }
  return changed;
};

const args = process.argv.slice(2);

if (args[0] === '--check') {
  // dirty relative to HEAD — the question you actually want answered before committing
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', ...STORES], { cwd: root, encoding: 'utf8' });
  const dirty = (r.stdout ?? '').split('\n').filter(Boolean);
  if (dirty.length) {
    console.error('[store-guard] tracked authoring stores differ from HEAD:');
    for (const d of dirty) console.error('  ' + d);
    console.error('If that was a test and not an authored edit: npm run stores:restore');
    process.exit(1);
  }
  console.log('[store-guard] stores clean');
  process.exit(0);
}

if (args[0] === '--restore') {
  const r = spawnSync('git', ['checkout', '--', ...STORES], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

if (!args.length) {
  console.error('usage: store-guard.mjs <command...> | --restore | --check');
  process.exit(2);
}

const run = spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
const touched = restore();
if (touched.length) console.log(`[store-guard] restored ${touched.length} store(s) the run had written: ${touched.join(', ')}`);
process.exit(run.status ?? 0);
