/**
 * Money — SINGLE SOURCE OF TRUTH for VND arithmetic on the server/web side.
 *
 * This is a deliberate 1:1 port of the Android app's `common/Money.kt`.
 * Both implementations MUST agree, so they are pinned by a shared vector file
 * (`money-vectors.json`) that the Kotlin test and the TypeScript test both read.
 * If you change a rule here, change it in Money.kt and regenerate the vectors.
 *
 * ## Storage
 * Every monetary amount is an integer number of VND — the smallest indivisible
 * unit (VND has no sub-unit; ISO 4217 exponent 0). `+`, `-`, `*` on integers are
 * exact and need no rounding.
 *
 * ## Rounding rule (shop's own convention, mirrors Money.kt)
 * Rounding is only ever needed for DIVISION:
 *
 *   Round to the nearest whole VND, HALF_UP:
 *     fractional part  < 0.5  -> toward zero
 *     fractional part >= 0.5  -> away from zero
 *
 * Negative amounts round by magnitude, matching Java's RoundingMode.HALF_UP:
 *   -7 / 2 = -3.5 -> -4
 *
 * ## Rules for callers
 *  - NEVER use `/` or `%` directly on a money value. Use the functions here so
 *    every rounding decision stays in one auditable place.
 *  - Never use a floating-point value as a money amount.
 *
 * NOTE: this is the shop's internal convention. If VAT invoices must comply with
 * Vietnamese tax authority rules, the statutory rounding rule takes precedence
 * and must be verified against the regulation before issuing tax invoices.
 * VAT helpers are intentionally NOT ported — see the note at the bottom.
 */

/** Largest magnitude we allow through an intermediate product, to stay exact. */
const MAX_EXACT = Number.MAX_SAFE_INTEGER;

function assertSafeInt(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Money: ${name} must be an integer VND amount, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money: ${name} exceeds exact integer range`);
  }
}

/**
 * Exact integer HALF_UP division of numerator/denominator.
 * Works on magnitudes then reapplies the sign, so behaviour matches
 * BigDecimal.divide(..., 0, RoundingMode.HALF_UP) in the Kotlin implementation.
 */
function halfUp(numerator: number, denominator: number): number {
  if (Math.abs(numerator) > MAX_EXACT) {
    throw new RangeError('Money: intermediate value too large to stay exact');
  }
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);

  const q = Math.floor(n / d);
  const remainder = n - q * d;
  // remainder/d >= 0.5  <=>  2*remainder >= d   (integer-only comparison)
  const rounded = 2 * remainder >= d ? q + 1 : q;

  // `sign * 0` yields IEEE-754 negative zero, which is not strictly equal to 0
  // and has no counterpart in Kotlin's Int. Normalise so the two Money
  // implementations agree on every value, including this edge (divide(-1, 3)).
  if (rounded === 0) return 0;
  return sign * rounded;
}

/**
 * Divide a VND amount and round to whole đồng.
 * Throws on a zero divisor — that is a programming error, not a value to absorb.
 */
export function divide(amount: number, divisor: number): number {
  assertSafeInt(amount, 'amount');
  assertSafeInt(divisor, 'divisor');
  if (divisor === 0) {
    throw new RangeError('Money.divide: divisor must not be zero');
  }
  return halfUp(amount, divisor);
}

/**
 * Percentage of an amount, rounded to whole đồng. Used for discounts.
 *   percentOf(45_000, 15) = 6_750
 *   percentOf(33_000,  8) = 2_640
 */
export function percentOf(amount: number, percent: number): number {
  assertSafeInt(amount, 'amount');
  assertSafeInt(percent, 'percent');
  return halfUp(amount * percent, 100);
}

/**
 * Split an amount into `parts` shares that sum EXACTLY back to `amount`.
 * The rounding remainder is spread one đồng at a time over the first shares, so
 * no đồng is created or lost.
 *
 *   split(100_000, 3) = [33_334, 33_333, 33_333]
 *   split(10, 4)      = [3, 3, 2, 2]
 *
 * Negative amounts are REJECTED. Splitting a negative total is not a real
 * business case, and the Kotlin implementation does not preserve the sum for
 * negative input (see KNOWN-ISSUE note in the project CONTEXT). Failing loudly
 * is safer than silently disagreeing with the Android side.
 */
export function split(amount: number, parts: number): number[] {
  assertSafeInt(amount, 'amount');
  assertSafeInt(parts, 'parts');
  if (parts <= 0) {
    throw new RangeError('Money.split: parts must be positive');
  }
  if (amount < 0) {
    throw new RangeError('Money.split: amount must not be negative');
  }

  const base = Math.floor(amount / parts);
  let remainder = amount - base * parts;

  const shares: number[] = [];
  for (let i = 0; i < parts; i += 1) {
    if (remainder > 0) {
      remainder -= 1;
      shares.push(base + 1);
    } else {
      shares.push(base);
    }
  }
  return shares;
}

/**
 * Average of a total over a count, 0 when count is 0.
 * Mirrors RevenueReport.averageOrderValue on the Android side.
 */
export function average(total: number, count: number): number {
  return count === 0 ? 0 : divide(total, count);
}

/*
 * NOT PORTED, ON PURPOSE:
 *   Money.baseFromGross(gross, vatPercent)  — VAT extraction.
 * The Android app declares it but never calls it, and the correct rounding rule
 * for a Vietnamese VAT invoice is a legal question, not a coding one. Porting an
 * unverified rule into the reporting layer would risk producing tax figures we
 * cannot defend. Add it only once the statutory rule is confirmed.
 */
