// The schematic's channel alphabet. A view layer, but a PURE one, and the whole claim of the design
// is that a mixture can be read back to its members — which is exactly the kind of claim that rots
// silently when someone appends a value.
import { describe, it, expect } from 'vitest';
import {
  certainty, cornerInk, floorInk, floorValueColor, openingIsPlain, openingRings, openState, rgb, segInk,
  CORNER_CHANNEL, FLOOR_CHANNEL, SEG_CHANNEL,
} from './cell-visual.ts';
import { floors, segs, corners, wallTypes, opens, fullField } from '../floor/cell-field.ts';
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
  it('nine kinds split across three rings of three, every one decodable', () => {
    // the rings group by KIND now, not by passability — passability moved to `open`, and a ring that
    // encoded it would be showing one field while claiming to show another
    const ringOf = (v: (typeof WALL_TYPES)[number]): number =>
      openingRings(wallTypes(v)).findIndex(Boolean);
    for (const v of WALL_TYPES) expect(ringOf(v)).toBeGreaterThanOrEqual(0);
    // each ring carries exactly three, on three distinct channels
    for (let r = 0; r < 3; r++) {
      const inRing = WALL_TYPES.filter((v) => ringOf(v) === r);
      expect(inRing.length).toBe(3);
      expect(new Set(inRing.map((v) => openingRings(wallTypes(v))[r])).size).toBe(3);
    }
    // one from each of two rings lights both
    const both = openingRings(wallTypes('doorway', 'window'));
    expect(both[0]).not.toBeNull();
    expect(both[1]).not.toBeNull();
  });

  it('draws nothing for plain solid OR for abstaining — a ring is a claim', () => {
    expect(openingIsPlain(wallTypes('solid'))).toBe(true);
    expect(openingIsPlain(wallTypes(...WALL_TYPES))).toBe(true);
    expect(openingIsPlain(wallTypes('doorway'))).toBe(false);
  });

  it('EVERY kind wears a ring now — a ring says what it is, not whether you fit through', () => {
    // it used to mean "walk-through", so the solid-looking variants deliberately wore none. Passability
    // has moved to `open`, so a ring encoding it would be showing one field while labelled another.
    for (const v of WALL_TYPES) {
      expect(openingRings(wallTypes(v)).some(Boolean)).toBe(true);
    }
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
    // A ring means you can get through, so only those types need one — see `OPENING_RING`. A solid
    // variant with a ring would be the real gap, so check that direction too.
    // EVERY kind must land on a ring — an appended one with no ring is the silent gap this guards
    for (const v of WALL_TYPES) {
      if (!openingRings(wallTypes(v)).some(Boolean)) missing.push(`kind with no ring: ${v}`);
    }
    expect(missing).toEqual([]);
  });
});

// keep the imports honest
void corners;

describe('cell-visual — `open` is VISIBLE, which it was not', () => {
  /* The field was authorable and undrawn: the brush painted it, the schematic did not change, and an
     author had no way to see whether it took. A structure shipped with twenty scaffold walls whose
     `open` was still undecided — settling to `closed`, exactly as specified — and the only hint was
     the `random` lens flickering them open. */
  it('tells the three states apart', () => {
    expect(openState(opens('open'))).toBe('open');
    expect(openState(opens('closed'))).toBe('closed');
    expect(openState(opens('closed', 'open'))).toBe('undecided');
    expect(openState(fullField().open)).toBe('undecided');
  });

  it('UNDECIDED is not `open` — that is the confusion that caused this', () => {
    // a domain allowing both is not a claim that it is open; it settles closed
    expect(openState(opens('closed', 'open'))).not.toBe('open');
  });
});
