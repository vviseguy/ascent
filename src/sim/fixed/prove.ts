// ============================================================================
// Standalone PROOF harness for the fixed-point bedrock.
//   Run:  node --experimental-strip-types src/sim/fixed/prove.ts
//   (Node 22+, no dependencies, no test runner.)
// ============================================================================
//
// This is the "prove it" centerpiece for the most-critical, most-isolatable
// module in the project. It checks the lossy ops (mul, div, sqrt) against a
// BigInt-EXACT oracle across a large deterministic fuzz of values + edge cases,
// and checks trig accuracy + determinism. BigInt is exact, so any disagreement
// is a real bug. If every value stays < 2^53 (which the implementation
// guarantees) the JS-number results are identical across all engines — so
// matching the oracle here proves cross-engine determinism.
// ============================================================================

import {
  ONE_RAW,
  mul,
  div,
  sqrt,
  sin,
  cos,
  toRaw,
  fromRaw,
  toFloat,
  idivFloor,
  type Fixed,
} from './fixed.ts';

const ONE = BigInt(ONE_RAW);

// ---- BigInt-exact oracles (mathematical floor division) --------------------
function bfloorDiv(a: bigint, b: bigint): bigint {
  let q = a / b; // BigInt division truncates toward zero
  if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; // correct toward -infinity
  return q;
}
const mulOracle = (a: number, b: number): number => Number(bfloorDiv(BigInt(a) * BigInt(b), ONE));
const divOracle = (a: number, b: number): number =>
  b === 0 ? 0 : Number(bfloorDiv(BigInt(a) * ONE, BigInt(b)));
function isqrtOracle(n: number): number {
  if (n <= 0) return 0;
  let x = BigInt(n);
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + BigInt(n) / x) / 2n;
  }
  return Number(x); // floor(sqrt(n))
}

// ---- deterministic value generator (mulberry32, for test inputs only) ------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// raw values cover the full Q16.16 int32 range, biased to include small/edge ones.
function sampleRaw(rnd: () => number): number {
  const r = rnd();
  if (r < 0.15) return Math.floor((rnd() - 0.5) * 8); // tiny near zero
  if (r < 0.3) return Math.floor((rnd() - 0.5) * 4 * ONE_RAW); // small magnitude
  return Math.floor((rnd() - 0.5) * 2 * 0x7fffffff); // full int32-ish range
}

// ---- harness ---------------------------------------------------------------
let checks = 0;
let fails = 0;
const failSamples: string[] = [];
function expectEq(got: number, want: number, ctx: () => string): void {
  checks++;
  if (got !== want) {
    fails++;
    if (failSamples.length < 12) failSamples.push(`${ctx()}  got=${got} want=${want}`);
  }
}

const N = 300_000;
const rnd = mulberry32(0xa5ce47);

console.log(`[prove:fixed] fuzzing ${N} cases for mul/div/sqrt against a BigInt oracle...`);

// explicit edge cases first
const edges = [0, 1, -1, ONE_RAW, -ONE_RAW, ONE_RAW - 1, 0x7fffffff, -0x7fffffff, 2, -2, ONE_RAW >> 1];
for (const a of edges) {
  for (const b of edges) {
    expectEq(toRaw(mul(fromRaw(a), fromRaw(b))), mulOracle(a, b), () => `mul(${a},${b})`);
    if (b !== 0) expectEq(toRaw(div(fromRaw(a), fromRaw(b))), divOracle(a, b), () => `div(${a},${b})`);
  }
  const an = Math.abs(a);
  expectEq(toRaw(sqrt(fromRaw(an))), isqrtOracle(an * ONE_RAW), () => `sqrt(${an})`);
}

// idivFloor direct check
for (let i = 0; i < 50_000; i++) {
  const num = Math.floor((rnd() - 0.5) * 2 * 0x3fffffff);
  let den = Math.floor((rnd() - 0.5) * 2 * 0x7fff) || 1;
  expectEq(idivFloor(num, den), Number(bfloorDiv(BigInt(num), BigInt(den))), () => `idivFloor(${num},${den})`);
}

// fuzz mul / div / sqrt
for (let i = 0; i < N; i++) {
  const a = sampleRaw(rnd);
  const b = sampleRaw(rnd);
  expectEq(toRaw(mul(fromRaw(a), fromRaw(b))), mulOracle(a, b), () => `mul(${a},${b})`);
  if (b !== 0) expectEq(toRaw(div(fromRaw(a), fromRaw(b))), divOracle(a, b), () => `div(${a},${b})`);
  const an = Math.abs(a) % (0x7fffffff);
  expectEq(toRaw(sqrt(fromRaw(an))), isqrtOracle(an * ONE_RAW), () => `sqrt(${an})`);
}

// ---- trig: accuracy vs Math (determinism is structural — only fixed ops used)
console.log('[prove:fixed] checking sin/cos accuracy (deterministic, ~1e-3 tolerance)...');
let maxTrigErr = 0;
for (let i = 0; i < 20_000; i++) {
  const ang = (rnd() - 0.5) * 8 * Math.PI; // includes range-reduction territory
  const af = fromRaw(Math.round(ang * ONE_RAW)) as Fixed;
  maxTrigErr = Math.max(maxTrigErr, Math.abs(toFloat(sin(af)) - Math.sin(ang)));
  maxTrigErr = Math.max(maxTrigErr, Math.abs(toFloat(cos(af)) - Math.cos(ang)));
}
const trigOk = maxTrigErr < 2e-3;
if (!trigOk) {
  fails++;
  failSamples.push(`trig maxErr=${maxTrigErr} exceeds 2e-3`);
}

// ---- report ----------------------------------------------------------------
console.log('');
console.log(`  arithmetic checks : ${checks.toLocaleString()}`);
console.log(`  trig max error    : ${maxTrigErr.toExponential(3)} (bound 2e-3) ${trigOk ? 'OK' : 'FAIL'}`);
if (fails === 0) {
  console.log('\n  RESULT: PASS — fixed-point math is exact vs the BigInt oracle and trig is within tolerance.');
  process.exit(0);
} else {
  console.log(`\n  RESULT: FAIL — ${fails} mismatches. Samples:`);
  for (const s of failSamples) console.log('    ' + s);
  process.exit(1);
}
