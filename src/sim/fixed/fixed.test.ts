// Vitest suite for the fixed-point bedrock. The exhaustive cross-oracle fuzz
// lives in prove.ts (runnable standalone); this mirrors the key guarantees for
// the CI suite (`npm test`) and adds algebraic-identity + vector checks.

import { describe, it, expect } from 'vitest';
import {
  ONE_RAW,
  ZERO,
  ONE,
  add,
  sub,
  mul,
  div,
  neg,
  abs,
  sqrt,
  sin,
  cos,
  PI,
  fromInt,
  fromRaw,
  toRaw,
  toIntFloor,
  idivFloor,
  lerp,
  HALF,
  type Fixed,
} from './fixed.ts';
import { v3, v3len, v3normalize, v3dot, V3_ZERO, v2, v2dist } from './vec.ts';

// BigInt oracles (exact) — same as prove.ts, for cross-checking here too.
const ONE_B = BigInt(ONE_RAW);
const bfloor = (a: bigint, b: bigint): bigint => {
  let q = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n;
  return q;
};
const mulO = (a: number, b: number) => Number(bfloor(BigInt(a) * BigInt(b), ONE_B));
const divO = (a: number, b: number) => (b === 0 ? 0 : Number(bfloor(BigInt(a) * ONE_B, BigInt(b))));

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('fixed: algebraic identities', () => {
  it('additive identity and inverse', () => {
    const a = fromInt(7);
    expect(add(a, ZERO)).toBe(a);
    expect(add(a, neg(a))).toBe(ZERO);
    expect(neg(neg(a))).toBe(a);
  });
  it('multiplicative identity and zero', () => {
    const a = fromRaw(123456);
    expect(mul(a, ONE)).toBe(a);
    expect(mul(a, ZERO)).toBe(ZERO);
  });
  it('abs', () => {
    expect(abs(fromInt(-5))).toBe(fromInt(5));
    expect(abs(fromInt(5))).toBe(fromInt(5));
  });
  it('int round-trip', () => {
    for (const n of [-1000, -1, 0, 1, 42, 32767]) expect(toIntFloor(fromInt(n))).toBe(n);
  });
  it('lerp endpoints + midpoint', () => {
    const a = fromInt(2);
    const b = fromInt(10);
    expect(lerp(a, b, ZERO)).toBe(a);
    expect(lerp(a, b, ONE)).toBe(b);
    expect(lerp(a, b, HALF)).toBe(fromInt(6));
  });
});

describe('fixed: exact vs BigInt oracle (fuzz)', () => {
  // Normalize -0 → 0 before comparing. JS `mul(neg, 0)` can yield -0, but every sim
  // value is stored in an Int32Array (which coerces -0 to 0) and the state hash folds
  // via `>>>0` (also 0), so -0 can never reach the world state or a hash. We assert
  // the stored-equivalent value, exactly as the sim would persist it.
  const norm = (n: number): number => (n === 0 ? 0 : n);
  it('mul/div match the oracle over random + edge inputs', () => {
    const rnd = lcg(99);
    const edges = [0, 1, -1, ONE_RAW, -ONE_RAW, ONE_RAW - 1, 0x7fffffff, -0x7fffffff];
    for (const a of edges)
      for (const b of edges) {
        expect(norm(toRaw(mul(fromRaw(a), fromRaw(b))))).toBe(norm(mulO(a, b)));
        if (b !== 0) expect(norm(toRaw(div(fromRaw(a), fromRaw(b))))).toBe(norm(divO(a, b)));
      }
    for (let i = 0; i < 20000; i++) {
      const a = Math.floor((rnd() - 0.5) * 2 * 0x7fffffff);
      const b = Math.floor((rnd() - 0.5) * 2 * 0x7fffffff);
      expect(norm(toRaw(mul(fromRaw(a), fromRaw(b))))).toBe(norm(mulO(a, b)));
      if (b !== 0) expect(norm(toRaw(div(fromRaw(a), fromRaw(b))))).toBe(norm(divO(a, b)));
    }
  });
  it('idivFloor is exact floor division', () => {
    expect(idivFloor(-7, 2)).toBe(-4);
    expect(idivFloor(7, 2)).toBe(3);
    expect(idivFloor(-7, -2)).toBe(3);
  });
  it('sqrt is the exact floor-sqrt and never NaN', () => {
    expect(sqrt(ZERO)).toBe(ZERO);
    expect(sqrt(fromInt(-9))).toBe(ZERO); // clamped, deterministic
    expect(toIntFloor(sqrt(fromInt(9)))).toBe(3);
    expect(toIntFloor(sqrt(fromInt(2)))).toBe(1);
  });
});

describe('fixed: determinism (re-run equivalence)', () => {
  it('an identical op sequence yields identical raw results', () => {
    const run = () => {
      let acc = fromInt(1);
      const rnd = lcg(7);
      for (let i = 0; i < 5000; i++) {
        const v = fromRaw(Math.floor((rnd() - 0.5) * 1e6)) as Fixed;
        acc = add(mul(acc, fromRaw(70000)), v);
        acc = div(acc, fromRaw(60000));
        acc = sqrt(abs(acc));
      }
      return toRaw(acc);
    };
    expect(run()).toBe(run());
  });
});

describe('fixed: trig', () => {
  it('sin/cos hit known anchors within tolerance', () => {
    const close = (x: Fixed, want: number) => Math.abs(toRaw(x) / ONE_RAW - want) < 3e-3;
    expect(close(sin(ZERO), 0)).toBe(true);
    expect(close(sin(div(PI, fromInt(2))), 1)).toBe(true);
    expect(close(cos(ZERO), 1)).toBe(true);
    expect(close(cos(PI), -1)).toBe(true);
  });
});

describe('vec: vec3/vec2', () => {
  it('length of a 3-4 right triangle is 5', () => {
    expect(toIntFloor(v3len(v3(fromInt(3), ZERO, fromInt(4))))).toBe(5);
  });
  it('normalize yields ~unit length and zero-safe', () => {
    const n = v3normalize(v3(fromInt(3), fromInt(0), fromInt(4)));
    expect(Math.abs(toRaw(v3len(n)) / ONE_RAW - 1)).toBeLessThan(3e-3);
    expect(v3normalize(V3_ZERO)).toEqual(V3_ZERO);
  });
  it('dot of perpendicular axes is zero', () => {
    expect(v3dot(v3(ONE, ZERO, ZERO), v3(ZERO, ONE, ZERO))).toBe(ZERO);
  });
  it('v2dist 3-4-5', () => {
    expect(toIntFloor(v2dist(v2(ZERO, ZERO), v2(fromInt(3), fromInt(4))))).toBe(5);
  });
});
