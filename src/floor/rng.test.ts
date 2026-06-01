/**
 * src/floor/rng.test.ts — determinism + distribution sanity for the floor-gen PRNG.
 * Determinism is the sacred property: same seed => same sequence, on any engine.
 */

import { describe, it, expect } from 'vitest';
import {
  makeRng,
  makeFloorRng,
  mixSeeds,
  subStream,
  next64,
  nextU32,
  nextFloat01,
  nextInt,
  nextRange,
  chance,
  shuffleInPlace,
  pick,
} from './rng.ts';

describe('rng determinism', () => {
  it('same seed => identical 64-bit sequence', () => {
    const a = makeRng(12345n);
    const b = makeRng(12345n);
    const seqA = Array.from({ length: 50 }, () => next64(a).toString());
    const seqB = Array.from({ length: 50 }, () => next64(b).toString());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds => different sequences (overwhelmingly)', () => {
    const a = makeRng(1n);
    const b = makeRng(2n);
    const seqA = Array.from({ length: 50 }, () => next64(a).toString());
    const seqB = Array.from({ length: 50 }, () => next64(b).toString());
    expect(seqA).not.toEqual(seqB);
  });

  it('makeFloorRng is deterministic in (runSeed, stratumIndex)', () => {
    const a = makeFloorRng(999n, 7);
    const b = makeFloorRng(999n, 7);
    const c = makeFloorRng(999n, 8); // different index => different stream
    const seqA = Array.from({ length: 20 }, () => nextU32(a));
    const seqB = Array.from({ length: 20 }, () => nextU32(b));
    const seqC = Array.from({ length: 20 }, () => nextU32(c));
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('subStream is independent of the parent and stable per tag', () => {
    const base = makeFloorRng(42n, 0);
    const s1a = subStream(base, 1);
    const s1b = subStream(base, 1);
    const s2 = subStream(base, 2);
    expect(next64(s1a).toString()).toEqual(next64(s1b).toString());
    expect(next64(subStream(base, 1)).toString()).not.toEqual(next64(s2).toString());
  });

  it('mixSeeds is a pure function', () => {
    expect(mixSeeds(5n, 9n)).toEqual(mixSeeds(5n, 9n));
    expect(mixSeeds(5n, 9n)).not.toEqual(mixSeeds(9n, 5n)); // order matters
  });
});

describe('rng bounded helpers', () => {
  it('nextInt stays in [0, n) and is deterministic', () => {
    const a = makeRng(7n);
    const b = makeRng(7n);
    for (let i = 0; i < 1000; i++) {
      const n = (i % 16) + 1;
      const va = nextInt(a, n);
      const vb = nextInt(b, n);
      expect(va).toBe(vb);
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(n);
    }
  });

  it('nextInt(1) and nextInt(0) return 0 without consuming weirdly', () => {
    const r = makeRng(1n);
    expect(nextInt(r, 1)).toBe(0);
    expect(nextInt(r, 0)).toBe(0);
  });

  it('nextRange stays inclusive in [lo, hi]', () => {
    const r = makeRng(3n);
    for (let i = 0; i < 1000; i++) {
      const v = nextRange(r, 5, 9);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(9);
    }
    expect(nextRange(r, 4, 4)).toBe(4);
    expect(nextRange(r, 10, 2)).toBe(10); // hi<=lo => lo
  });

  it('nextFloat01 stays in [0,1) and is deterministic', () => {
    const a = makeRng(11n);
    const b = makeRng(11n);
    for (let i = 0; i < 200; i++) {
      const v = nextFloat01(a);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(nextFloat01(b));
    }
  });

  it('nextInt is roughly uniform (chi-square sanity, not strict)', () => {
    const r = makeRng(123n);
    const buckets = new Array(10).fill(0) as number[];
    const N = 100_000;
    for (let i = 0; i < N; i++) buckets[nextInt(r, 10)]!++;
    // every bucket should be within ~15% of N/10
    for (const c of buckets) {
      expect(c).toBeGreaterThan((N / 10) * 0.85);
      expect(c).toBeLessThan((N / 10) * 1.15);
    }
  });

  it('chance(0)=never, chance(1)=always', () => {
    const r = makeRng(5n);
    for (let i = 0; i < 100; i++) {
      expect(chance(r, 0)).toBe(false);
      expect(chance(r, 1)).toBe(true);
    }
  });

  it('shuffleInPlace is a deterministic permutation', () => {
    const a = shuffleInPlace(makeRng(8n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const b = shuffleInPlace(makeRng(8n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(a).toEqual(b);
    expect([...a].sort((p, q) => p - q)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('pick returns an element and is deterministic', () => {
    const opts = ['a', 'b', 'c', 'd'] as const;
    const x = pick(makeRng(2n), opts);
    const y = pick(makeRng(2n), opts);
    expect(x).toBe(y);
    expect(opts).toContain(x);
  });
});
