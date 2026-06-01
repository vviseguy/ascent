// ============================================================================
// Fixed-point scalar math — the deterministic bedrock of the ASCENT sim.
// ============================================================================
//
// WHY THIS EXISTS
// ---------------
// ASCENT uses rollback netcode: every peer must compute *bit-identical* results
// from the same inputs, and must be able to re-simulate past frames. IEEE-754
// floating point is NOT reliably identical across JS engines (x87 vs SSE, FMA
// fusion, differing transcendental implementations), so floats are banned from
// the simulation. Instead the sim runs entirely on fixed-point integers.
//
// THE DETERMINISM GUARANTEE
// -------------------------
// A `Fixed` value is an INTEGER stored in a float64. JS number arithmetic on
// integers is exact and identical across every conforming engine *as long as
// every value and intermediate stays within ±2^53* (Number.MAX_SAFE_INTEGER).
// This module's entire job is to do fixed-point math while never letting an
// intermediate exceed 2^53 — and to prove it (see prove.ts, which checks every
// nontrivial op against a BigInt-exact oracle).
//
// FORMAT: Q16.16
// --------------
// real value  =  raw / 65536.   Raw is kept in the int32 range (|raw| < 2^31),
// so real ∈ roughly [-32768, 32768) with a resolution of 1/65536 ≈ 1.5e-5.
// That is ample for a tower arena measured in meters. Keeping raw < 2^31 is
// what bounds the multiply intermediates below 2^53.
//
// ROUNDING: all lossy ops (mul, div) use mathematical FLOOR (toward -infinity),
// chosen because it is simple, total, and trivially matched by the oracle.
// ============================================================================

declare const FixedBrand: unique symbol;
/** A Q16.16 fixed-point number. Never do raw `+`/`*` on these — use the ops here. */
export type Fixed = number & { readonly [FixedBrand]: true };

/** Fractional bits in the Q16.16 format. */
export const FRACT_BITS = 16;
/** 1.0 in raw units (2^16). */
export const ONE_RAW = 1 << FRACT_BITS; // 65536

const f = (raw: number): Fixed => raw as Fixed;

// ---- constants -------------------------------------------------------------
export const ZERO: Fixed = f(0);
export const ONE: Fixed = f(ONE_RAW);
export const TWO: Fixed = f(ONE_RAW * 2);
export const HALF: Fixed = f(ONE_RAW >> 1);
export const NEG_ONE: Fixed = f(-ONE_RAW);
/** π and 2π as the nearest representable Fixed (authoring constants). */
export const PI: Fixed = f(Math.round(Math.PI * ONE_RAW)); // 205887
export const TWO_PI: Fixed = f(Math.round(2 * Math.PI * ONE_RAW));
export const HALF_PI: Fixed = f(Math.round((Math.PI / 2) * ONE_RAW));

// ---- exact integer floor-division (the safety primitive) -------------------
//
// Math.floor(num/den) can be off by one when num/den is not exactly
// representable as a float64 (the division rounds, then floor sees the wrong
// side of an integer boundary). This helper corrects that using only exact
// integer subtraction/multiply, so the result is the TRUE mathematical floor.
// Requires integer inputs with |num| < 2^53 and den != 0.
export function idivFloor(num: number, den: number): number {
  let q = Math.floor(num / den);
  // r is exact: |q*den| ~ |num| < 2^53, so q*den and num-q*den are exact.
  const r = num - q * den;
  if (den > 0) {
    if (r < 0) q -= 1;
    else if (r >= den) q += 1;
  } else {
    if (r > 0) q += 1;
    else if (r <= den) q -= 1;
  }
  return q;
}

// ---- constructors / conversions --------------------------------------------

/** Integer → Fixed. (n must be a safe integer in [-32768, 32767].) */
export const fromInt = (n: number): Fixed => f(n * ONE_RAW);

/**
 * Float → Fixed. AUTHORING / CONSTANTS ONLY. Never call this on a value derived
 * from runtime float state inside the sim — that would inject nondeterminism.
 * Used for hand-written constants and for converting authored level data once,
 * before the sim starts.
 */
export const fromFloatConst = (x: number): Fixed => f(Math.round(x * ONE_RAW));

/** Fixed → float. RENDER / DEBUG ONLY (the view layer never feeds back in). */
export const toFloat = (a: Fixed): number => a / ONE_RAW;

/** Fixed → integer, flooring toward -infinity. */
export const toIntFloor = (a: Fixed): number => idivFloor(a, ONE_RAW);
/** Fixed → nearest integer (ties toward +infinity, deterministic). */
export const toIntRound = (a: Fixed): number => idivFloor(a + (ONE_RAW >> 1), ONE_RAW);

/** Reinterpret a known-valid raw integer as Fixed (e.g. deserialization). */
export const fromRaw = (raw: number): Fixed => f(raw);
/** Get the underlying raw integer (serialization / hashing). */
export const toRaw = (a: Fixed): number => a as number;

// ---- additive ops (exact) --------------------------------------------------
export const add = (a: Fixed, b: Fixed): Fixed => f(a + b);
export const sub = (a: Fixed, b: Fixed): Fixed => f(a - b);
export const neg = (a: Fixed): Fixed => f(-a);
export const abs = (a: Fixed): Fixed => f(a < 0 ? -a : a);

// ---- multiply --------------------------------------------------------------
//
// Want floor(a*b / ONE). The naive product a*b can reach 2^62, overflowing
// float64's exact-integer range. Split `a` into integer part `ah` and
// fractional raw `al` (0 ≤ al < ONE), so:
//     a*b/ONE = ah*b + al*b/ONE
// `ah*b` is ≤ ~2^46 (exact integer) and `al*b` is ≤ ~2^47 (exact integer),
// both safely < 2^53. Flooring the cross term via idivFloor yields exactly
// floor(a*b/ONE). (Proof of equality with the oracle: see prove.ts.)
export function mul(a: Fixed, b: Fixed): Fixed {
  const ah = Math.floor(a / ONE_RAW); // integer part of a (toward -inf)
  const al = a - ah * ONE_RAW; // fractional raw, always in [0, ONE_RAW)
  return f(ah * b + idivFloor(al * b, ONE_RAW));
}

// ---- divide ----------------------------------------------------------------
//
// Want floor(a*ONE / b). a*ONE ≤ ~2^47 (exact integer), so idivFloor gives the
// exact mathematical floor. b must be nonzero (caller's responsibility; we
// return 0 for b==0 rather than NaN to keep the sim total/deterministic).
export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0) return ZERO;
  return f(idivFloor(a * ONE_RAW, b));
}

// ---- square root -----------------------------------------------------------
//
// sqrt(real_a) in raw units = isqrt(a * ONE), since
//   sqrt(a/ONE)*ONE = sqrt(a*ONE).
// a*ONE ≤ ~2^47 (exact). isqrt below is a DETERMINISTIC integer floor-sqrt: it
// seeds from Math.sqrt (whose cross-engine rounding does NOT matter) and then
// corrects to the exact floor with integer-only steps — so the final result is
// identical on every engine.
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n)); // approximate seed; engine-dependent, corrected below
  if (!Number.isFinite(x) || x < 0) x = 0;
  // Deterministic exact correction (x stays < 2^24 for n < 2^47, so x*x is exact).
  while (x * x > n) x -= 1;
  while ((x + 1) * (x + 1) <= n) x += 1;
  return x;
}

export function sqrt(a: Fixed): Fixed {
  if (a <= 0) return ZERO;
  return f(isqrt(a * ONE_RAW));
}

// ---- comparison / clamp ----------------------------------------------------
export const eq = (a: Fixed, b: Fixed): boolean => a === b;
export const lt = (a: Fixed, b: Fixed): boolean => a < b;
export const lte = (a: Fixed, b: Fixed): boolean => a <= b;
export const gt = (a: Fixed, b: Fixed): boolean => a > b;
export const gte = (a: Fixed, b: Fixed): boolean => a >= b;
export const min = (a: Fixed, b: Fixed): Fixed => f(a < b ? a : b);
export const max = (a: Fixed, b: Fixed): Fixed => f(a > b ? a : b);
export const sign = (a: Fixed): number => (a > 0 ? 1 : a < 0 ? -1 : 0);
export const clamp = (a: Fixed, lo: Fixed, hi: Fixed): Fixed => f(a < lo ? lo : a > hi ? hi : a);

/** Floor to an integer multiple of ONE (i.e. drop the fractional part). */
export const floor = (a: Fixed): Fixed => f(idivFloor(a, ONE_RAW) * ONE_RAW);
/** Linear interpolate: a + (b-a)*t, t a Fixed in [0,1]. */
export const lerp = (a: Fixed, b: Fixed, t: Fixed): Fixed => add(a, mul(sub(b, a), t));

// ---- trigonometry (deterministic; approximate but identical everywhere) -----
//
// sin/cos use range reduction + a fixed-point Taylor series. Every operation is
// a deterministic fixed-point op, so results are bit-identical across engines.
// Accuracy is ~1e-3 (plenty for facing/aim); it is NOT meant to match Math.sin
// to full precision — only to be deterministic and close. (prove/tests check
// the accuracy bound and the engine-independence.)
//
// Taylor on the reduced range: sin(x) = x - x^3/6 + x^5/120 - x^7/5040.
const INV6 = fromFloatConst(1 / 6);
const INV120 = fromFloatConst(1 / 120);
const INV5040 = fromFloatConst(1 / 5040);

function sinReduced(x: Fixed): Fixed {
  // x assumed in [-PI/2, PI/2]; series is accurate there.
  const x2 = mul(x, x);
  const x3 = mul(x2, x);
  const x5 = mul(x3, x2);
  const x7 = mul(x5, x2);
  return add(sub(add(x, neg(mul(x3, INV6))), neg(mul(x5, INV120))), neg(mul(x7, INV5040)));
}

/** Reduce an angle (radians, Fixed) into [-PI, PI). */
export function wrapAngle(a: Fixed): Fixed {
  // a - 2π * floor((a + π) / 2π)
  const k = idivFloor(add(a, PI), TWO_PI);
  return sub(a, mul(fromInt(k), TWO_PI));
}

export function sin(a: Fixed): Fixed {
  let x = wrapAngle(a); // [-π, π)
  // Fold into [-π/2, π/2] using sin(π - x) = sin(x).
  if (x > HALF_PI) x = sub(PI, x);
  else if (x < neg(HALF_PI)) x = sub(neg(PI), x);
  return sinReduced(x);
}

export function cos(a: Fixed): Fixed {
  return sin(add(a, HALF_PI));
}
