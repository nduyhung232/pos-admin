/**
 * Money + Discount tests, driven by the SHARED vector file.
 *
 * The same money-vectors.json is consumed by the Kotlin test on the POS side, so
 * a divergence between the two Money implementations fails a build instead of
 * quietly producing different totals in reports.
 *
 * Run: node --experimental-strip-types --test test/money.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { divide, percentOf, split, average } from '../src/shared/money.ts';
import { compute, DiscountType, isPercentValid } from '../src/shared/discount.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../src/shared/money-vectors.json'), 'utf8'));

test('divide: all shared vectors', () => {
  for (const v of vectors.divide) {
    assert.equal(
      divide(v.amount, v.divisor),
      v.expected,
      `divide(${v.amount}, ${v.divisor}) — ${v.note}`,
    );
  }
});

test('percentOf: all shared vectors', () => {
  for (const v of vectors.percentOf) {
    assert.equal(
      percentOf(v.amount, v.percent),
      v.expected,
      `percentOf(${v.amount}, ${v.percent}) — ${v.note}`,
    );
  }
});

test('split: all shared vectors', () => {
  for (const v of vectors.split) {
    assert.deepEqual(
      split(v.amount, v.parts),
      v.expected,
      `split(${v.amount}, ${v.parts}) — ${v.note}`,
    );
  }
});

test('split: always preserves the sum', () => {
  for (const v of vectors.split) {
    const sum = split(v.amount, v.parts).reduce((a, b) => a + b, 0);
    assert.equal(sum, v.amount, `split(${v.amount}, ${v.parts}) must sum back exactly`);
  }
});

test('average: all shared vectors', () => {
  for (const v of vectors.average) {
    assert.equal(average(v.total, v.count), v.expected, `average(${v.total}, ${v.count})`);
  }
});

test('divide: zero divisor is a hard error, never a silent zero', () => {
  assert.throws(() => divide(1000, 0), RangeError);
});

test('money functions reject non-integer amounts', () => {
  assert.throws(() => divide(100.5, 2), TypeError);
  assert.throws(() => percentOf(100.5, 10), TypeError);
});

test('split rejects invalid parts', () => {
  assert.throws(() => split(1000, 0), RangeError);
  assert.throws(() => split(1000, -1), RangeError);
});

test('split rejects negative amounts (documented divergence from Kotlin)', () => {
  // Kotlin's implementation silently loses đồng here; we refuse instead of
  // disagreeing quietly. See knownDivergence in money-vectors.json.
  assert.throws(() => split(-10, 4), RangeError);
});

// ---- Discount ---------------------------------------------------------------

test('discount: NONE removes nothing', () => {
  const r = compute({ subtotal: 45000, type: DiscountType.NONE });
  assert.equal(r.discountAmount, 0);
  assert.equal(r.total, 45000);
});

test('discount: AMOUNT larger than subtotal is clamped, total never negative', () => {
  const r = compute({ subtotal: 45000, type: DiscountType.AMOUNT, input: 90000 });
  assert.equal(r.discountAmount, 45000);
  assert.equal(r.total, 0);
});

test('discount: PERCENT uses HALF_UP rounding', () => {
  const r = compute({ subtotal: 12345, type: DiscountType.PERCENT, input: 10 });
  assert.equal(r.discountAmount, 1235); // 1234.5 -> up
  assert.equal(r.total, 12345 - 1235);
});

test('discount: PERCENT above 100 is clamped to 100', () => {
  const r = compute({ subtotal: 45000, type: DiscountType.PERCENT, input: 250 });
  assert.equal(r.discountAmount, 45000);
  assert.equal(r.total, 0);
});

test('discount: negative input never increases the total', () => {
  const amount = compute({ subtotal: 45000, type: DiscountType.AMOUNT, input: -5000 });
  assert.equal(amount.discountAmount, 0);
  assert.equal(amount.total, 45000);

  const percent = compute({ subtotal: 45000, type: DiscountType.PERCENT, input: -10 });
  assert.equal(percent.discountAmount, 0);
  assert.equal(percent.total, 45000);
});

test('discount: CODE resolves AMOUNT and PERCENT values', () => {
  const byAmount = compute({
    subtotal: 45000,
    type: DiscountType.CODE,
    codeValueType: DiscountType.AMOUNT,
    codeValue: 10000,
  });
  assert.equal(byAmount.discountAmount, 10000);

  const byPercent = compute({
    subtotal: 45000,
    type: DiscountType.CODE,
    codeValueType: DiscountType.PERCENT,
    codeValue: 15,
  });
  assert.equal(byPercent.discountAmount, 6750);
});

test('discount: subtotal 0 yields no discount for any type', () => {
  for (const type of [DiscountType.AMOUNT, DiscountType.PERCENT]) {
    const r = compute({ subtotal: 0, type, input: 50 });
    assert.equal(r.discountAmount, 0);
    assert.equal(r.total, 0);
  }
});

test('isPercentValid enforces 0..100 integers', () => {
  assert.ok(isPercentValid(0));
  assert.ok(isPercentValid(100));
  assert.ok(!isPercentValid(101));
  assert.ok(!isPercentValid(-1));
  assert.ok(!isPercentValid(10.5));
});
