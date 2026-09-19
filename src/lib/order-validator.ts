/**
 * Server-side validation for orders and shifts pushed up from a terminal.
 *
 * WHY THIS EXISTS
 * The terminal computes totals locally and is offline-capable, so the server
 * receives figures it did not calculate. Storing them unchecked would mean the
 * reporting layer reports numbers nobody verified. Every pushed order is
 * re-derived here from its own line items; anything inconsistent is REJECTED and
 * reported back rather than silently stored or silently "corrected".
 *
 * Rejecting (not fixing) is deliberate: a mismatch means the two sides disagree
 * about money, and that needs a human, not a guess.
 *
 * The money rules used here come from the shared package, the same code the
 * frontend uses, pinned to the Android implementation by shared test vectors.
 */

import { compute, DiscountType } from '../shared/discount.ts';
import type { OrderPush, ShiftPush } from '../shared/types.ts';

export interface ValidationIssue {
  syncId: string;
  kind: 'order' | 'shift';
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reasonable clock window: reject timestamps far in the future. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/**
 * Validate one pushed order.
 * @returns null when the order is acceptable, otherwise the reason to reject.
 */
export function validateOrder(order: OrderPush, nowMs: number): string | null {
  if (!UUID_RE.test(order.syncId)) {
    return 'syncId is not a valid UUID';
  }
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return 'order has no line items';
  }

  // ---- money fields must be whole, non-negative VND ----
  for (const [field, value] of Object.entries({
    subtotal: order.subtotal,
    discountAmount: order.discountAmount,
    total: order.total,
    cashReceived: order.cashReceived,
    changeAmount: order.changeAmount,
  })) {
    if (!isNonNegativeInt(value)) {
      return `${field} must be a non-negative integer VND amount`;
    }
  }

  // ---- line items ----
  let itemsSum = 0;
  for (const item of order.items) {
    if (!UUID_RE.test(item.syncId)) {
      return `item ${item.syncId}: syncId is not a valid UUID`;
    }
    if (!isNonNegativeInt(item.unitPrice)) {
      return `item ${item.syncId}: unitPrice must be a non-negative integer`;
    }
    if (!isPositiveInt(item.quantity)) {
      return `item ${item.syncId}: quantity must be a positive integer`;
    }
    if (typeof item.productName !== 'string' || item.productName.trim() === '') {
      return `item ${item.syncId}: productName is required (snapshot)`;
    }
    itemsSum += item.unitPrice * item.quantity;
    if (!Number.isSafeInteger(itemsSum)) {
      return 'line items sum exceeds the exact integer range';
    }
  }

  if (itemsSum !== order.subtotal) {
    return `subtotal ${order.subtotal} does not equal the sum of line items ${itemsSum}`;
  }

  // ---- discount must reproduce with the shared rules ----
  if (order.discountAmount > order.subtotal) {
    return 'discountAmount exceeds subtotal';
  }
  if (order.subtotal - order.discountAmount !== order.total) {
    return `total ${order.total} does not equal subtotal - discountAmount (${
      order.subtotal - order.discountAmount
    })`;
  }
  if (order.discountType === DiscountType.NONE && order.discountAmount !== 0) {
    return 'discountAmount must be 0 when discountType is NONE';
  }
  if (order.discountType === DiscountType.PERCENT) {
    // Recompute with the shared calculator: catches a terminal using a different
    // rounding rule, which is exactly the drift we are guarding against.
    const expected = compute({
      subtotal: order.subtotal,
      type: DiscountType.PERCENT,
      input: order.discountInput,
    }).discountAmount;
    if (expected !== order.discountAmount) {
      return `percent discount mismatch: ${order.discountInput}% of ${order.subtotal} should be ${expected}, got ${order.discountAmount}`;
    }
  }
  if (order.discountType === DiscountType.CODE && !order.discountCode) {
    return 'discountCode is required when discountType is CODE';
  }
  if (order.discountType !== DiscountType.CODE && order.discountCode) {
    return 'discountCode present but discountType is not CODE';
  }

  // ---- payment consistency ----
  if (order.paymentMethod === 'CASH') {
    if (order.status === 'PAID' && order.cashReceived < order.total) {
      return `cashReceived ${order.cashReceived} is less than total ${order.total}`;
    }
    const expectedChange = Math.max(order.cashReceived - order.total, 0);
    if (order.changeAmount !== expectedChange) {
      return `changeAmount ${order.changeAmount} should be ${expectedChange}`;
    }
  } else if (order.cashReceived !== 0 || order.changeAmount !== 0) {
    return 'non-cash order must have zero cashReceived and changeAmount';
  }

  // ---- cancellation consistency ----
  if (order.status === 'CANCELLED') {
    if (order.cancelledAtMs === null || order.cancelledByStaffSyncId === null) {
      return 'cancelled order must record who cancelled it and when';
    }
  } else if (order.cancelledAtMs !== null || order.cancelledByStaffSyncId !== null) {
    return 'non-cancelled order must not carry cancellation fields';
  }

  // ---- timestamps ----
  if (!isPositiveInt(order.createdAtMs)) {
    return 'createdAtMs must be a positive integer epoch millisecond value';
  }
  if (order.createdAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return 'createdAtMs is too far in the future';
  }

  return null;
}

/**
 * Validate one pushed shift.
 * The cash reconciliation is the shop's audit evidence, so its internal
 * arithmetic must hold before it is stored.
 */
export function validateShift(shift: ShiftPush, nowMs: number): string | null {
  if (!UUID_RE.test(shift.syncId)) {
    return 'syncId is not a valid UUID';
  }
  if (!isNonNegativeInt(shift.openingCash)) {
    return 'openingCash must be a non-negative integer VND amount';
  }
  if (!isPositiveInt(shift.openedAtMs)) {
    return 'openedAtMs must be a positive integer epoch millisecond value';
  }
  if (shift.openedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return 'openedAtMs is too far in the future';
  }

  if (shift.status === 'OPEN') {
    if (shift.closedAtMs !== null || shift.countedCash !== null) {
      return 'an OPEN shift must not carry closing figures';
    }
    return null;
  }

  // CLOSED shift: the reconciliation must be internally consistent.
  if (!isPositiveInt(shift.closedAtMs)) {
    return 'a CLOSED shift must record closedAtMs';
  }
  if (shift.closedAtMs! < shift.openedAtMs) {
    return 'closedAtMs is before openedAtMs';
  }
  if (!isNonNegativeInt(shift.countedCash)) {
    return 'a CLOSED shift must record countedCash';
  }
  if (!isNonNegativeInt(shift.expectedCash)) {
    return 'a CLOSED shift must record expectedCash';
  }
  if (typeof shift.cashDifference !== 'number' || !Number.isSafeInteger(shift.cashDifference)) {
    return 'cashDifference must be an integer';
  }
  if (shift.countedCash! - shift.expectedCash! !== shift.cashDifference) {
    return `cashDifference ${shift.cashDifference} should be countedCash - expectedCash (${
      shift.countedCash! - shift.expectedCash!
    })`;
  }

  // The note-by-note breakdown, when present, must add up to countedCash.
  if (shift.cashBreakdown) {
    const parsed = parseCashBreakdown(shift.cashBreakdown);
    if (parsed === null) {
      return 'cashBreakdown is malformed (expected "500000x2;100000x5")';
    }
    if (parsed !== shift.countedCash) {
      return `cashBreakdown totals ${parsed} but countedCash is ${shift.countedCash}`;
    }
  }

  return null;
}

/**
 * Sum a "500000x2;100000x5" breakdown. Returns null when malformed.
 * Exported for testing — this is audit evidence, so its parsing is tested.
 */
export function parseCashBreakdown(raw: string): number | null {
  let total = 0;
  for (const part of raw.split(';')) {
    if (part === '') continue;
    const match = /^(\d+)x(\d+)$/.exec(part.trim());
    if (!match) return null;
    const denom = Number(match[1]);
    const count = Number(match[2]);
    if (!Number.isSafeInteger(denom) || !Number.isSafeInteger(count)) return null;
    total += denom * count;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
