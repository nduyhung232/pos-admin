/**
 * Discount maths — 1:1 port of the Android app's `common/DiscountCalculator.kt`.
 *
 * Pure and side-effect free so it can be unit tested in isolation and reused by
 * the reporting layer to re-verify stored order totals.
 *
 * Business rules (agreed with the shop owner, mirrored from the Android side):
 *  1. The total can never go below 0 — a discount larger than the subtotal is
 *     clamped to the subtotal.
 *  2. Percent input is clamped to 0..100.
 *  3. Exactly one discount per order (enforced by the caller).
 */

import { percentOf } from './money.ts';

export const MAX_PERCENT = 100;

/** Mirrors the Kotlin `DiscountType` enum, stored as text in both databases. */
export const DiscountType = {
  NONE: 'NONE',
  AMOUNT: 'AMOUNT',
  PERCENT: 'PERCENT',
  CODE: 'CODE',
} as const;

export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

export interface DiscountResult {
  /** Actual đồng removed (0..subtotal). */
  discountAmount: number;
  /** subtotal - discountAmount, never below 0. */
  total: number;
}

export interface DiscountInput {
  subtotal: number;
  type: DiscountType;
  /** Raw operator figure: VND for AMOUNT, percent for PERCENT. */
  input?: number;
  /** For CODE: the code's own value type. */
  codeValueType?: DiscountType;
  /** For CODE: the code's value (VND or percent). */
  codeValue?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Percent of subtotal, percent clamped to 0..100, rounded HALF_UP. */
function percentDiscount(subtotal: number, percent: number): number {
  return percentOf(subtotal, clamp(percent, 0, MAX_PERCENT));
}

export function compute(args: DiscountInput): DiscountResult {
  const { subtotal, type } = args;
  const input = args.input ?? 0;
  const codeValueType = args.codeValueType ?? DiscountType.NONE;
  const codeValue = args.codeValue ?? 0;

  const safeSubtotal = Math.max(subtotal, 0);

  let raw: number;
  switch (type) {
    case DiscountType.NONE:
      raw = 0;
      break;
    case DiscountType.AMOUNT:
      raw = Math.max(input, 0);
      break;
    case DiscountType.PERCENT:
      raw = percentDiscount(safeSubtotal, input);
      break;
    case DiscountType.CODE:
      if (codeValueType === DiscountType.AMOUNT) {
        raw = Math.max(codeValue, 0);
      } else if (codeValueType === DiscountType.PERCENT) {
        raw = percentDiscount(safeSubtotal, codeValue);
      } else {
        raw = 0;
      }
      break;
    default:
      raw = 0;
  }

  // Rule 1: never below zero — clamp the discount to the subtotal.
  const discountAmount = clamp(raw, 0, safeSubtotal);
  return { discountAmount, total: safeSubtotal - discountAmount };
}

export function isPercentValid(percent: number): boolean {
  return Number.isInteger(percent) && percent >= 0 && percent <= MAX_PERCENT;
}
