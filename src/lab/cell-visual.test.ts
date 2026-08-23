// The schematic's channel alphabet. A view layer, but a PURE one, and the whole claim of the design
// is that a mixture can be read back to its members — which is exactly the kind of claim that rots
// silently when someone appends a value.
import { describe, it, expect } from 'vitest';
import {
  certainty, cornerInk, floorInk, floorValueColor, openingIsPlain, openingRings, rgb, segInk,
  CORNER_CHANNEL, FLOOR_CHANNEL, SEG_CHANNEL,
} from './cell-visual.ts';
import { floors, segs, corners, wallTypes, fullField } from '../floor/cell-field.ts';
import { SEGS, FLOOR_MATERIALS, CORNERS, WALL_TYPES } from '../floor/cell.ts';

describe('cell-visual — channels ADD, and a mixture decodes', () => {
  it('one value is its own channel, two are the sum, three are white', () => {
    const R = rgb([true, false, false]), G = rgb([false, true, false]);
    expect(segInk(segs('wall')).stroke).toBe(R);
    expect(segInk(segs('barrier')).stroke).toBe(G);
    expect(segInk(segs('wall', 'barrier')).stroke).toBe(rgb([true, true, false]));
    expect(segInk(segs('wall', 'barrier', 'sloped')).stroke).toBe(rgb([true, true, true]));
  });

  it('`none` takes no channel — it is absence, not a colour', () => {
    // wall alone and {none, wall} are the same HUE; the difference is carried by the dash, so `none`
    // does not cost one of only three channels
    expect(segInk(segs('wall')).stroke).toBe(segInk(segs('none', 'wall')).stroke);
    expect(segInk(segs('none', 'wall')).maybeGone).toBe(true);
    expect(segInk(segs('wall')).maybeGone).toBe(false);
    expect(segInk(segs('none')).certainlyGone).toBe(true);
  });

  it('every field maps at most three values to channels, or the scheme stops decoding', () => {
    for (const map of [SEG_CHANNEL, FLOOR_CHANNEL, CORNER_CHANNEL]) {
      const used = new Set(Object.values(map));
      expect([...used].every((c) => c === 0 || c === 1 || c === 2)).toBe(true);
    }
    // ...and no two values of the same field may share a channel unless they are meant to read alike
    expect(new Set(Object.values(SEG_CHANNEL)).size).toBe(Object.values(SEG_CHANNEL).length);
    expect(new Set(Object.values(CORNER_CHANNEL)).size).toBe(Object.values(CORNER_CHANNEL).length);
  });

  it('a stair material takes the channel of what it is MADE of', () => {
    // that is what lets `stairs` be a hatch over a material rather than a fourth colour
    expect(floorValueColor('stairs')).toBe(floorValueColor('stone'));
    expect(floorValueColor('stairs_wood')).toBe(floorValueColor('wood'));
  });
});

describe('cell-visual — the two PARALLEL hatch channels', () => {
  it('stairs and fill are independent, and both can show at once', () => {
    expect(floorInk(floors('stairs')).hatches.map((x) => x.id)).toEqual(['h-stair']);
    expect(floorInk(floors('rock')).hatches.map((x) => x.id)).toEqual(['h-fill']);
    expect(floorInk(floors('stairs', 'rock')).hatches.map((x) => x.id)).toEqual(['h-stair', 'h-fill']);
    expect(floorInk(floors('stone')).hatches).toEqual([]);
  });

  it('a certain hatch is stronger than a merely possible one', () => {
    const certain = floorInk(floors('stairs')).hatches[0]!;
    const possible = floorInk(floors('stairs', 'stone')).hatches[0]!;
    expect(certain.opacity).toBeGreaterThan(possible.opacity);
  });
});

describe('cell-visual — CERTAINTY is intensity', () => {
  it('one value draws at full and abstaining draws faint', () => {
    expect(certainty(1, 7)).toBe(1);
    expect(certainty(7, 7)).toBeLessThan(0.4);
    expect(certainty(2, 7)).toBeLessThan(1);
    expect(certainty(2, 7)).toBeGreaterThan(certainty(5, 7));
  });

  it('so the most common state on a half-finished board is the quietest', () => {
    // this is the correction the additive scheme needs: without it, "no opinion" lights every channel
    // and comes out WHITE, so undecided fields shout louder than decided ones
    const decided = floorInk(floors('stone'));
    const abstaining = floorInk(fullField().floor);
    expect(abstaining.strength).toBeLessThan(decided.strength);
  });
});

describe('cell-visual — openings ride as two rings', () => {
  it('splits six values into two rings of three', () => {
    expect(openingRings(wallTypes('door'))[0]).toBe(rgb([false, true, false]));
    expect(openingRings(wallTypes('door'))[1]).toBeNull();
    expect(openingRings(wallTypes('arch'))[0]).toBeNull();
    expect(openingRings(wallTypes('arch'))[1]).toBe(rgb([false, true, false]));
    // one from each ring lights both
    const both = openingRings(wallTypes('door', 'arch'));
    expect(both[0]).not.toBeNull();
    expect(both[1]).not.toBeNull();
  });

  it('draws nothing for plain solid OR for abstaining — a ring is a claim', () => {
    expect(openingIsPlain(wallTypes('solid'))).toBe(true);
    expect(openingIsPlain(wallTypes(...WALL_TYPES))).toBe(true);
    expect(openingIsPlain(wallTypes('door'))).toBe(false);
  });
});

describe('cell-visual — the layers stay apart', () => {
  it('ground is drawn darker than ink, so a wall never merges into a floor of the same channel', () => {
    // `wall` and `stone` both own channel 0; only brightness separates them
    const groundRed = floorValueColor('stone');
    const inkRed = segInk(segs('wall')).stroke;
    expect(groundRed).not.toBe(inkRed);
    const lum = (hex: string): number => parseInt(hex.slice(1, 3), 16);
    expect(lum(groundRed)).toBeLessThan(lum(inkRed));
  });

  it('an empty domain is a conflict on every field', () => {
    expect(floorInk(0).conflict).toBe(true);
    expect(segInk(0).conflict).toBe(true);
    expect(cornerInk(0)).toBe(rgb([false, false, false]));
  });

  it('covers every value of every field — an appended value with no channel is a silent gap', () => {
    const missing: string[] = [];
    for (const v of SEGS) if (v !== 'none' && SEG_CHANNEL[v] === undefined) missing.push(`seg:${v}`);
    // `none` is ABSENCE, like a floor's `none` and a wall's — shown by drawing less, not by a hue
    for (const v of CORNERS) if (v !== 'none' && CORNER_CHANNEL[v] === undefined) missing.push(`corner:${v}`);
    for (const v of FLOOR_MATERIALS) {
      if (v === 'none' || v === 'rock') continue;   // absence and fill are hatch/dim, not colour
      if (FLOOR_CHANNEL[v] === undefined) missing.push(`floor:${v}`);
    }
    for (const v of WALL_TYPES) if (!openingRings(wallTypes(v)).some(Boolean)) missing.push(`opening:${v}`);
    expect(missing).toEqual([]);
  });
});

// keep the imports honest
void corners;
