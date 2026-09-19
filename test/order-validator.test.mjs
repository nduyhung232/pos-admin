/**
 * Tests for the sync push validator.
 *
 * This is the gate that stops unverified money figures entering the reporting
 * database, so its negative cases matter more than its happy path.
 *
 * Run: node --experimental-strip-types --test test/order-validator.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOrder,
  validateShift,
  parseCashBreakdown,
} from '../src/lib/order-validator.ts';

const NOW = 1_800_000_000_000;

function uuid(n) {
  const hex = String(n).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

/** A valid cash order: 2 x 25_000 = 50_000, no discount. */
function baseOrder(overrides = {}) {
  return {
    syncId: uuid(1),
    subtotal: 50_000,
    discountAmount: 0,
    total: 50_000,
    discountType: 'NONE',
    discountInput: 0,
    discountCode: null,
    orderType: 'DINE_IN',
    paymentMethod: 'CASH',
    cashReceived: 50_000,
    changeAmount: 0,
    status: 'PAID',
    createdAtMs: NOW - 1000,
    shiftSyncId: uuid(9),
    staffSyncId: uuid(8),
    staffName: 'Thu ngân A',
    cancelledByStaffSyncId: null,
    cancelledAtMs: null,
    items: [
      {
        syncId: uuid(2),
        productSyncId: uuid(3),
        productName: 'Cà phê sữa',
        unitPrice: 25_000,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

function baseShift(overrides = {}) {
  return {
    syncId: uuid(9),
    openedAtMs: NOW - 100_000,
    closedAtMs: null,
    openingCash: 500_000,
    countedCash: null,
    expectedCash: null,
    cashDifference: null,
    cashBreakdown: null,
    status: 'OPEN',
    staffSyncId: uuid(8),
    staffName: 'Thu ngân A',
    closedByStaffSyncId: null,
    ...overrides,
  };
}

// ---- happy paths ------------------------------------------------------------

test('accepts a consistent cash order', () => {
  assert.equal(validateOrder(baseOrder(), NOW), null);
});

test('accepts change on an overpaid cash order', () => {
  const o = baseOrder({ cashReceived: 100_000, changeAmount: 50_000 });
  assert.equal(validateOrder(o, NOW), null);
});

test('accepts a non-cash order with zero cash fields', () => {
  const o = baseOrder({ paymentMethod: 'TRANSFER', cashReceived: 0, changeAmount: 0 });
  assert.equal(validateOrder(o, NOW), null);
});

test('accepts a percent discount that matches the shared rounding rule', () => {
  // 10% of 12_345 = 1234.5 -> 1235 (HALF_UP)
  const o = baseOrder({
    subtotal: 12_345,
    discountType: 'PERCENT',
    discountInput: 10,
    discountAmount: 1_235,
    total: 11_110,
    cashReceived: 11_110,
    changeAmount: 0,
    items: [
      {
        syncId: uuid(2),
        productSyncId: uuid(3),
        productName: 'Trà đào',
        unitPrice: 12_345,
        quantity: 1,
      },
    ],
  });
  assert.equal(validateOrder(o, NOW), null);
});

// ---- money integrity: the cases that protect the books ----------------------

test('rejects subtotal that disagrees with line items', () => {
  const o = baseOrder({ subtotal: 60_000, total: 60_000, cashReceived: 60_000 });
  const reason = validateOrder(o, NOW);
  assert.match(reason ?? '', /does not equal the sum of line items/);
});

test('rejects total that is not subtotal minus discount', () => {
  const o = baseOrder({ total: 40_000 });
  assert.match(validateOrder(o, NOW) ?? '', /does not equal subtotal - discountAmount/);
});

test('rejects discount larger than subtotal', () => {
  const o = baseOrder({ discountType: 'AMOUNT', discountInput: 90_000, discountAmount: 90_000, total: 0 });
  assert.match(validateOrder(o, NOW) ?? '', /exceeds subtotal/);
});

test('rejects a percent discount computed with a different rounding rule', () => {
  // A terminal rounding DOWN would send 1234 instead of 1235.
  const o = baseOrder({
    subtotal: 12_345,
    discountType: 'PERCENT',
    discountInput: 10,
    discountAmount: 1_234,
    total: 11_111,
    cashReceived: 11_111,
    items: [
      {
        syncId: uuid(2),
        productSyncId: uuid(3),
        productName: 'Trà đào',
        unitPrice: 12_345,
        quantity: 1,
      },
    ],
  });
  assert.match(validateOrder(o, NOW) ?? '', /percent discount mismatch/);
});

test('rejects a discount amount when type is NONE', () => {
  const o = baseOrder({ discountAmount: 5_000, total: 45_000, cashReceived: 45_000 });
  assert.match(validateOrder(o, NOW) ?? '', /must be 0 when discountType is NONE/);
});

test('rejects non-integer money amounts', () => {
  const o = baseOrder({ subtotal: 50_000.5 });
  assert.match(validateOrder(o, NOW) ?? '', /non-negative integer/);
});

test('rejects negative money amounts', () => {
  const o = baseOrder({ discountAmount: -1_000 });
  assert.match(validateOrder(o, NOW) ?? '', /non-negative integer/);
});

test('rejects wrong change on a cash order', () => {
  const o = baseOrder({ cashReceived: 100_000, changeAmount: 10_000 });
  assert.match(validateOrder(o, NOW) ?? '', /changeAmount 10000 should be 50000/);
});

test('rejects cash received below the total on a paid order', () => {
  const o = baseOrder({ cashReceived: 10_000, changeAmount: 0 });
  assert.match(validateOrder(o, NOW) ?? '', /is less than total/);
});

test('rejects cash fields on a non-cash order', () => {
  const o = baseOrder({ paymentMethod: 'CARD', cashReceived: 50_000, changeAmount: 0 });
  assert.match(validateOrder(o, NOW) ?? '', /must have zero cashReceived/);
});

// ---- structural / audit cases ----------------------------------------------

test('rejects an order with no line items', () => {
  assert.match(validateOrder(baseOrder({ items: [] }), NOW) ?? '', /no line items/);
});

test('rejects a non-UUID syncId', () => {
  assert.match(validateOrder(baseOrder({ syncId: '123' }), NOW) ?? '', /not a valid UUID/);
});

test('rejects zero or negative quantity', () => {
  for (const quantity of [0, -1]) {
    const o = baseOrder({
      items: [
        { syncId: uuid(2), productSyncId: uuid(3), productName: 'X', unitPrice: 25_000, quantity },
      ],
    });
    assert.match(validateOrder(o, NOW) ?? '', /quantity must be a positive integer/);
  }
});

test('rejects a missing product name snapshot', () => {
  const o = baseOrder({
    items: [
      { syncId: uuid(2), productSyncId: uuid(3), productName: '  ', unitPrice: 50_000, quantity: 1 },
    ],
  });
  assert.match(validateOrder(o, NOW) ?? '', /productName is required/);
});

test('rejects a cancelled order with no attribution', () => {
  const o = baseOrder({ status: 'CANCELLED' });
  assert.match(validateOrder(o, NOW) ?? '', /must record who cancelled it/);
});

test('accepts a properly attributed cancellation', () => {
  const o = baseOrder({
    status: 'CANCELLED',
    cancelledByStaffSyncId: uuid(7),
    cancelledAtMs: NOW - 500,
  });
  assert.equal(validateOrder(o, NOW), null);
});

test('rejects cancellation fields on a paid order', () => {
  const o = baseOrder({ cancelledAtMs: NOW - 500 });
  assert.match(validateOrder(o, NOW) ?? '', /must not carry cancellation fields/);
});

test('rejects a CODE discount without a code', () => {
  const o = baseOrder({
    discountType: 'CODE',
    discountAmount: 10_000,
    total: 40_000,
    cashReceived: 40_000,
  });
  assert.match(validateOrder(o, NOW) ?? '', /discountCode is required/);
});

test('rejects a timestamp far in the future', () => {
  const o = baseOrder({ createdAtMs: NOW + 48 * 60 * 60 * 1000 });
  assert.match(validateOrder(o, NOW) ?? '', /too far in the future/);
});

// ---- shifts ----------------------------------------------------------------

test('accepts an open shift', () => {
  assert.equal(validateShift(baseShift(), NOW), null);
});

test('rejects an open shift carrying closing figures', () => {
  const s = baseShift({ countedCash: 100_000 });
  assert.match(validateShift(s, NOW) ?? '', /must not carry closing figures/);
});

test('accepts a closed shift whose reconciliation adds up', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 1_000,
    countedCash: 1_200_000,
    expectedCash: 1_200_000,
    cashDifference: 0,
    cashBreakdown: '500000x2;100000x2',
    closedByStaffSyncId: uuid(8),
  });
  assert.equal(validateShift(s, NOW), null);
});

test('accepts a closed shift with a genuine cash shortfall', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 1_000,
    countedCash: 1_150_000,
    expectedCash: 1_200_000,
    cashDifference: -50_000,
    cashBreakdown: '500000x2;100000x1;50000x1',
    closedByStaffSyncId: uuid(8),
  });
  assert.equal(validateShift(s, NOW), null);
});

test('rejects a closed shift whose difference does not add up', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 1_000,
    countedCash: 1_150_000,
    expectedCash: 1_200_000,
    cashDifference: 0, // wrong: should be -50_000
    closedByStaffSyncId: uuid(8),
  });
  assert.match(validateShift(s, NOW) ?? '', /cashDifference 0 should be/);
});

test('rejects a breakdown that does not total the counted cash', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 1_000,
    countedCash: 1_200_000,
    expectedCash: 1_200_000,
    cashDifference: 0,
    cashBreakdown: '500000x1', // only 500k
    closedByStaffSyncId: uuid(8),
  });
  assert.match(validateShift(s, NOW) ?? '', /cashBreakdown totals 500000/);
});

test('rejects a malformed breakdown', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 1_000,
    countedCash: 1_200_000,
    expectedCash: 1_200_000,
    cashDifference: 0,
    cashBreakdown: '500000*2',
    closedByStaffSyncId: uuid(8),
  });
  assert.match(validateShift(s, NOW) ?? '', /malformed/);
});

test('rejects a closed shift that closes before it opened', () => {
  const s = baseShift({
    status: 'CLOSED',
    closedAtMs: NOW - 200_000,
    countedCash: 500_000,
    expectedCash: 500_000,
    cashDifference: 0,
    closedByStaffSyncId: uuid(8),
  });
  assert.match(validateShift(s, NOW) ?? '', /before openedAtMs/);
});

// ---- breakdown parser ------------------------------------------------------

test('parseCashBreakdown sums denominations', () => {
  assert.equal(parseCashBreakdown('500000x2;100000x5'), 1_500_000);
  assert.equal(parseCashBreakdown('1000x1'), 1_000);
  assert.equal(parseCashBreakdown(''), 0);
  assert.equal(parseCashBreakdown('500000x2;'), 1_000_000);
});

test('parseCashBreakdown rejects malformed input', () => {
  assert.equal(parseCashBreakdown('abc'), null);
  assert.equal(parseCashBreakdown('500000'), null);
  assert.equal(parseCashBreakdown('500000x'), null);
  assert.equal(parseCashBreakdown('-500x2'), null);
});
