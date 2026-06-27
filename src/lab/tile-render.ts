// ============================================================================
// src/lab/tile-render.ts — shared 3D piece building for the tile previews.
// ============================================================================
//
// A KayKit piece is expensive to build (load + recolor) but cheap to clone. So build each
// (url, scale) ONCE and clone per placement — every instance shares geometry + material. Used by
// both the board preview (board.ts) and the tile editor (tile-editor.ts) so the cache is shared.

import * as THREE from 'three';
import { meshObject, type WorldObject } from './world-object.ts';

const objCache = new Map<string, WorldObject>();
const builtCache = new Map<string, Promise<THREE.Object3D>>();

function builtOnce(url: string, scale: number): Promise<THREE.Object3D> {
  const k = `${url}@${scale}`;
  let p = builtCache.get(k);
  if (!p) {
    let o = objCache.get(k);
    if (!o) { o = meshObject({ meshUrl: url, name: url, describe: '', level: 'object', scale, variants: { default: [] } }); objCache.set(k, o); }
    p = o.build('default', 0).then((b) => b.root);
    builtCache.set(k, p);
  }
  return p;
}

/** A fresh clone of a built piece (shares geometry + material with every other clone). */
export const instance = async (url: string, scale: number): Promise<THREE.Object3D> => (await builtOnce(url, scale)).clone();
