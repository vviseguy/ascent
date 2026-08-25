#!/usr/bin/env node
// Regenerate every LOCAL DERIVATIVE asset — the pieces we cut out of the KayKit pack ourselves.
//
//   npm run assets:derive          rebuild them all
//   npm run assets:derive -- --check   rebuild to a temp path and fail if anything differs
//
// WHY A SET, AND WHY A SCRIPT. The pack ships composites: a doorway is a frame WITH its leaf welded
// into the same file, a gate is bars WITH the wall around them. The engine needs the halves
// separately — an open doorway and a shut one are different things on screen and want different
// collision, and a gate you can raise is a grille placed over an arch. Every one of these is a
// mechanical cut from an upstream file, so none of them belongs in git as a mystery binary: this
// script IS their provenance, and `fetch-kaykit` can be re-run without fighting it.
//
// The upstream files are never modified. Each derivative is a new name alongside them.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = join(root, 'public/models/kaykit_dungeon_remastered');
const parts = join(root, 'scripts/glb-parts.mjs');
const trim = join(root, 'scripts/glb-trim.mjs');
const tmp = join(root, 'tmp');
const check = process.argv.includes('--check');

/* THE DEBRIS COMPONENTS. These meshes are not one welded solid — each is a body, a flourish or two,
   and a scatter of small brick/rubble blobs stuck to the faces, all disconnected inside one
   primitive. Component indices come from `node scripts/glb-parts.mjs <file>` and are pinned by a
   fixed sort (triangle count desc, then minX/minY/minZ). RE-CHECK THEM IF THE PACK IS RE-FETCHED. */
const ENDCAP_DEBRIS = '1,2,3,4,5,6,7,8';
const GATE_BARS = '12,13,14,15,16,17,18,19,20,21';

const out = (name) => join(check ? tmp : M, name);

const steps = [
  {
    name: 'wall_doorway_open.gltf.glb',
    what: 'the doorway frame WITHOUT its leaf — an open doorway as its own asset, so it stops being a `#open` url fragment',
    run: () => run(parts, [join(M, 'wall_doorway.glb'), out('wall_doorway_open.gltf.glb'), '--drop-node=wall_doorway_door']),
  },
  {
    name: 'wall_door.gltf.glb',
    what: 'the leaf alone, carrying its parent offset, so a door can be placed, swung or removed independently of its frame',
    run: () => run(parts, [join(M, 'wall_doorway.glb'), out('wall_door.gltf.glb'), '--node=wall_doorway_door']),
  },
  {
    name: 'wall_gated_arch.gltf.glb',
    what: 'the gate\'s wall with the portcullis taken out — the opening, without the thing filling it',
    run: () => run(parts, [join(M, 'wall_gated.gltf.glb'), out('wall_gated_arch.gltf.glb'), `--drop=${GATE_BARS}`]),
  },
  {
    name: 'wall_gated_bars.gltf.glb',
    what: 'the portcullis alone — 4 horizontal bars and 6 vertical, placeable over the arch or lifted away',
    run: () => run(parts, [join(M, 'wall_gated.gltf.glb'), out('wall_gated_bars.gltf.glb'), `--keep=${GATE_BARS}`]),
  },
  {
    name: 'wall_endcap_short.gltf.glb',
    what: 'the ultra-short cap: strip the debris FIRST, then cut at x=0.80, so no orphaned blob can survive the cut',
    run: () => {
      const mid = join(tmp, 'endcap_nodebris.glb');
      run(parts, [join(M, 'wall_endcap.gltf.glb'), mid, `--drop=${ENDCAP_DEBRIS}`]);
      run(trim, [mid, out('wall_endcap_short.gltf.glb'), '0.80']);
    },
  },
];

function run(script, args) {
  execFileSync(process.execPath, [script, ...args], { stdio: check ? 'pipe' : 'inherit' });
}

let failed = 0;
for (const s of steps) {
  if (!check) console.log(`\n== ${s.name}\n   ${s.what}`);
  s.run();
  if (check) {
    const a = join(M, s.name), b = join(tmp, s.name);
    const same = existsSync(a) && readFileSync(a).equals(readFileSync(b));
    console.log(`${same ? 'ok  ' : 'DIFF'}  ${s.name}`);
    if (!same) failed++;
  }
}
if (check && failed) {
  console.error(`\n${failed} derivative(s) differ from what this script produces — run \`npm run assets:derive\`.`);
  process.exit(1);
}
if (check) console.log('\nall derivatives match their recipe.');
