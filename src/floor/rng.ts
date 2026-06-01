/**
 * src/floor/rng.ts — deterministic seeded PRNG for FLOOR GENERATION ONLY.
 *
 * WHY a local RNG: floor generation must be a pure, reproducible function of
 * `(runSeed, stratumIndex)` so every peer in the shared arena generates a
 * bit-identical floor with zero network traffic (see GENERATION-SOLVABILITY.md
 * §"All random choices seeded from run-seed + stratum-index"). The simulation
 * has its OWN PRNG; we deliberately do NOT import it here. Floor gen is the
 * project's first fully-isolated "provable brick" (DECISIONS-LOG build philosophy),
 * so it owns its own tiny, dependency-free generator.
 *
 * DETERMINISM CONTRACT (sacred — see CONVENTIONS in the build brief):
 *  - Integer math only. We use BigInt for the 64-bit mixing (splitmix64) so the
 *    arithmetic is exact and identical across every JS engine / browser. No floats
 *    leak into any value that affects generation output.
 *  - No Math.random, no Date, no wall-clock, no platform-dependent behavior.
 *  - Same seed => same sequence, forever.
 *
 * DESIGN: splitmix64 for seeding/mixing (excellent avalanche, trivially portable),
 * exposed through a small mutable stream object plus pure helpers. We keep the raw
 * 64-bit output available (`next64`) and derive bounded integers via rejection-free
 * Lemire-style multiply-shift where range bias must be avoided, or a simple modulo
 * where a tiny bias is irrelevant (documented at each call site in the generator).
 */

/** 2^64 - 1 mask, used to keep BigInt arithmetic in the unsigned 64-bit ring. */
const MASK64 = 0xffffffffffffffffn;
/** splitmix64 increment constant (the "golden gamma"). */
const GAMMA = 0x9e3779b97f4a7c15n;

/**
 * One step of the splitmix64 finalizer applied to a 64-bit state word.
 * Pure: given the same input word, always returns the same output word.
 * This is the canonical splitmix64 output mixer (Vigna), well-distributed.
 */
function mix64(z0: bigint): bigint {
  let z = z0 & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return z & MASK64;
}

/**
 * Combine two 64-bit words into one (used to fold runSeed + stratumIndex, or to
 * derive named sub-streams from a base seed). Order-stable and avalanche-strong.
 * Mirrors the `mix64(a,b)` hashing discipline in 09-level-generation.md §2: we
 * HASH inputs rather than advancing a shared stream, so generation of one floor
 * never depends on generation order of others.
 */
export function mixSeeds(a: bigint, b: bigint): bigint {
  return mix64((a ^ ((b + GAMMA) & MASK64)) & MASK64);
}

/**
 * A floor-gen PRNG stream. Plain mutable holder of a 64-bit state word; behavior
 * lives in the free functions below (kept as a struct, not a class-with-methods,
 * to stay aligned with the "plain serializable data" convention — though the RNG
 * itself is never serialized into floor output).
 */
export interface Rng {
  /** Current 64-bit state, always kept masked to [0, 2^64). */
  state: bigint;
}

/**
 * Create a PRNG from a 64-bit seed word. The seed is mixed once up front so that
 * even adjacent / structured seeds (e.g. stratumIndex 0,1,2…) produce
 * well-separated streams from the very first draw.
 */
export function makeRng(seed64: bigint): Rng {
  return { state: mix64(seed64 & MASK64) };
}

/**
 * Create a PRNG seeded from (runSeed, stratumIndex) — the canonical floor-gen
 * entry point. `runSeed` may be any bigint (the lobby seed); `stratumIndex` is the
 * integer floor index. We fold the index through the same prime multiplier the
 * level-gen doc uses (0x100000001b3, the FNV prime) before mixing, matching that
 * doc's `stratumSeed` so streams are spread cleanly across indices.
 */
export function makeFloorRng(runSeed: bigint, stratumIndex: number): Rng {
  const idx = (BigInt(stratumIndex) * 0x100000001b3n) & MASK64;
  return makeRng(mixSeeds(runSeed & MASK64, idx));
}

/**
 * Derive a named SUB-STREAM from a base RNG without disturbing the base. WHY:
 * adding a later generation step (e.g. dressing) must never shift the output of an
 * earlier one (spine carving). Each stage pulls its own independent sub-stream via
 * a stable integer `tag`, so stages are decoupled and diffs stay stable
 * (09-level-generation.md §2 "named sub-streams").
 *
 * Pure w.r.t. the parent: reads parent.state but does NOT advance it.
 */
export function subStream(base: Rng, tag: number): Rng {
  return makeRng(mixSeeds(base.state, BigInt(tag >>> 0)));
}

/**
 * Advance the stream and return the next raw 64-bit value (unsigned BigInt).
 * This is the single primitive; everything else is derived from it. Mutates `rng`.
 */
export function next64(rng: Rng): bigint {
  rng.state = (rng.state + GAMMA) & MASK64;
  return mix64(rng.state);
}

/**
 * Next 32-bit unsigned integer as a JS number (safe integer, [0, 2^32)).
 * We take the high 32 bits of the 64-bit word (better-mixed than the low bits).
 */
export function nextU32(rng: Rng): number {
  return Number((next64(rng) >> 32n) & 0xffffffffn);
}

/**
 * Uniform float in [0, 1). DERIVED VALUE — used ONLY for comparisons against
 * configured probabilities (e.g. openness), never stored in or hashed from floor
 * output, so it cannot introduce cross-platform float divergence into the data.
 * Built from 53 bits for full double precision. The division is the same on every
 * IEEE-754 engine for these exact integer operands, so it is reproducible.
 */
export function nextFloat01(rng: Rng): number {
  // Top 53 bits of a 64-bit draw → exact integer in [0, 2^53) → /2^53.
  const bits53 = Number((next64(rng) >> 11n) & 0x1fffffffffffffn);
  return bits53 / 9007199254740992; // 2^53
}

/**
 * Uniform integer in [0, n) for n > 0, using Lemire's multiply-shift with rejection
 * to remove modulo bias. Integer-exact and deterministic. For n <= 1 returns 0.
 *
 * WHY rejection-free-ish: where the generator picks among structural options
 * (which cell, which neighbor), an even distribution matters for good floors and
 * for the fuzz test to actually exercise the space. The rejection loop terminates
 * with probability 1 and in practice almost always on the first try.
 */
export function nextInt(rng: Rng, n: number): number {
  if (n <= 1) return 0;
  const N = BigInt(n);
  // Lemire: draw x in [0,2^64), compute m = x*N (128-bit), low 64 bits = m mod 2^64.
  // Reject when the low part falls in the "short" leftover window to debias.
  const t = (-N & MASK64) % N; // threshold = (2^64 mod N)
  for (;;) {
    const x = next64(rng);
    const m = x * N; // up to 128 bits in BigInt
    const lo = m & MASK64;
    if (lo >= t) {
      return Number(m >> 64n); // high 64 bits = floor(x*N / 2^64) ∈ [0, N)
    }
  }
}

/**
 * Uniform integer in [lo, hi] inclusive. Returns lo if hi <= lo.
 */
export function nextRange(rng: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + nextInt(rng, hi - lo + 1);
}

/**
 * Return true with probability `p` (clamped to [0,1]). Used for openness / gate
 * placement rolls. Comparison-only use of a derived float (see nextFloat01).
 */
export function chance(rng: Rng, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return nextFloat01(rng) < p;
}

/**
 * In-place Fisher–Yates shuffle of a number[] using integer draws. Deterministic.
 * Mutates and returns the array. Used to randomize iteration order over IDs in a
 * reproducible way (so we never depend on Map/Set iteration order — see CONVENTIONS).
 */
export function shuffleInPlace(rng: Rng, arr: number[]): number[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const ai = arr[i] as number;
    const aj = arr[j] as number;
    arr[i] = aj;
    arr[j] = ai;
  }
  return arr;
}

/**
 * Pick one element from a non-empty array uniformly. Caller must ensure length>0.
 */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  // Caller guarantees non-empty; index is in-range by construction.
  return arr[nextInt(rng, arr.length)] as T;
}
