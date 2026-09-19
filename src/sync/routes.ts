/**
 * Sync API — the only endpoints a POS terminal talks to.
 *
 * CONTRACT:
 *   - paths: POST /api/sync/push, GET /api/sync/pull
 *   - auth: Authorization: Bearer <token> ONLY (no X-Device-Id — the token,
 *     chosen by the manager in the web admin, identifies the terminal)
 *   - request/response JSON shapes validated by zod schemas
 *   - validation via order-validator, idempotent upsert behaviour
 *
 * OWNERSHIP MODEL (this is what removes sync conflicts):
 *   pull : server -> POS   products, staff credentials, this device's code batch
 *   push : POS -> server   orders, shifts
 * No table is written by both sides, so there is never a merge to resolve.
 *
 * IDEMPOTENCE
 * Every record carries a UUID `syncId` with a UNIQUE constraint. A terminal that
 * loses the response and retries cannot create duplicates.
 *
 * VALIDATION
 * Pushed money figures are re-derived from their own line items before storage
 * (see order-validator.ts). Anything inconsistent is rejected and reported back.
 */

import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import { validateOrder, validateShift } from '../lib/order-validator.ts';
import type {
  SyncPushRequest,
  SyncPushResponse,
  SyncPullResponse,
  SyncRejection,
} from '../shared/types.ts';
import type { PrismaClient } from '@prisma/client';
import { requireDevice } from '../lib/device-auth.ts';

// ---- request schemas --------------------------------------------------------

const orderItemSchema = z.object({
  syncId: z.string().uuid(),
  productSyncId: z.string().uuid().nullable(),
  productName: z.string().min(1).max(200),
  unitPrice: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
});

const orderSchema = z.object({
  syncId: z.string().uuid(),
  subtotal: z.number().int().nonnegative(),
  discountAmount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  discountType: z.enum(['NONE', 'AMOUNT', 'PERCENT', 'CODE']),
  discountInput: z.number().int(),
  discountCode: z.string().max(32).nullable(),
  orderType: z.enum(['DINE_IN', 'TAKE_AWAY']),
  paymentMethod: z.enum(['CASH', 'TRANSFER', 'CARD']),
  cashReceived: z.number().int().nonnegative(),
  changeAmount: z.number().int().nonnegative(),
  status: z.enum(['PAID', 'CANCELLED']),
  createdAtMs: z.number().int().positive(),
  shiftSyncId: z.string().uuid().nullable(),
  staffSyncId: z.string().uuid().nullable(),
  staffName: z.string().max(100).nullable(),
  cancelledByStaffSyncId: z.string().uuid().nullable(),
  cancelledAtMs: z.number().int().positive().nullable(),
  items: z.array(orderItemSchema).min(1).max(200),
});

const shiftSchema = z.object({
  syncId: z.string().uuid(),
  openedAtMs: z.number().int().positive(),
  closedAtMs: z.number().int().positive().nullable(),
  openingCash: z.number().int().nonnegative(),
  countedCash: z.number().int().nonnegative().nullable(),
  expectedCash: z.number().int().nonnegative().nullable(),
  cashDifference: z.number().int().nullable(),
  cashBreakdown: z.string().max(500).nullable(),
  status: z.enum(['OPEN', 'CLOSED']),
  staffSyncId: z.string().uuid().nullable(),
  staffName: z.string().max(100).nullable(),
  closedByStaffSyncId: z.string().uuid().nullable(),
});

/** Batch caps keep one push bounded; the terminal pages larger backlogs. */
const pushSchema = z.object({
  clientTimeMs: z.number().int().positive(),
  orders: z.array(orderSchema).max(500),
  shifts: z.array(shiftSchema).max(100),
});

export function registerSyncRoutes(app: Express, prisma: PrismaClient): void {
  /**
   * POS -> server. Upload orders and shifts recorded while offline.
   *
   * Shifts are stored BEFORE orders so an order can be linked to its shift in the
   * same push. Each record is committed in its own transaction: one bad order
   * must not block the rest of a day's takings from being banked.
   */
  app.post('/api/sync/push', async (req: Request, res: Response) => {
    const device = await requireDevice(req, res, prisma);
    if (!device) return; // requireDevice already replied

    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const body: SyncPushRequest = parsed.data;

    const nowMs = Date.now();
    const rejected: SyncRejection[] = [];
    const acceptedShiftIds: string[] = [];
    const acceptedOrderIds: string[] = [];

    // ---- shifts first, so orders can reference them ----
    for (const shift of body.shifts) {
      const reason = validateShift(shift, nowMs);
      if (reason) {
        rejected.push({ syncId: shift.syncId, kind: 'shift', reason });
        continue;
      }
      try {
        await prisma.shift.upsert({
          where: { syncId: shift.syncId },
          // A shift is pushed twice: once on open, once on close. Updating the
          // closing figures is expected; the opening figures are immutable.
          update: {
            closedAtMs: shift.closedAtMs === null ? null : BigInt(shift.closedAtMs),
            countedCash: shift.countedCash,
            expectedCash: shift.expectedCash,
            cashDifference: shift.cashDifference,
            cashBreakdown: shift.cashBreakdown,
            status: shift.status,
            closedByStaffSyncId: shift.closedByStaffSyncId,
          },
          create: {
            syncId: shift.syncId,
            deviceId: device.id,
            openedAtMs: BigInt(shift.openedAtMs),
            closedAtMs: shift.closedAtMs === null ? null : BigInt(shift.closedAtMs),
            openingCash: shift.openingCash,
            countedCash: shift.countedCash,
            expectedCash: shift.expectedCash,
            cashDifference: shift.cashDifference,
            cashBreakdown: shift.cashBreakdown,
            status: shift.status,
            staffSyncId: shift.staffSyncId,
            staffName: shift.staffName,
            closedByStaffSyncId: shift.closedByStaffSyncId,
            receivedAtMs: BigInt(nowMs),
          },
        });
        acceptedShiftIds.push(shift.syncId);
      } catch (err) {
        req.log?.error?.({ err, syncId: shift.syncId }, 'shift upsert failed');
        rejected.push({ syncId: shift.syncId, kind: 'shift', reason: 'storage_error' });
      }
    }

    // ---- orders ----
    for (const order of body.orders) {
      const reason = validateOrder(order, nowMs);
      if (reason) {
        rejected.push({ syncId: order.syncId, kind: 'order', reason });
        continue;
      }

      try {
        const existing = await prisma.order.findUnique({
          where: { syncId: order.syncId },
          select: { id: true, status: true },
        });

        if (existing) {
          // Already stored. The only legitimate later change is a cancellation.
          if (order.status === 'CANCELLED' && existing.status === 'PAID') {
            await prisma.order.update({
              where: { id: existing.id },
              data: {
                status: 'CANCELLED',
                cancelledByStaffSyncId: order.cancelledByStaffSyncId,
                cancelledAtMs:
                  order.cancelledAtMs === null ? null : BigInt(order.cancelledAtMs),
              },
            });
          }
          // Re-push of an identical order is a no-op, not an error.
          acceptedOrderIds.push(order.syncId);
          continue;
        }

        await prisma.$transaction(async (tx) => {
          // Resolve the shift by syncId; null when it has not arrived yet.
          const shift = order.shiftSyncId
            ? await tx.shift.findUnique({
                where: { syncId: order.shiftSyncId },
                select: { id: true },
              })
            : null;

          const created = await tx.order.create({
            data: {
              syncId: order.syncId,
              deviceId: device.id,
              subtotal: order.subtotal,
              discountAmount: order.discountAmount,
              total: order.total,
              discountType: order.discountType,
              discountInput: order.discountInput,
              discountCode: order.discountCode,
              orderType: order.orderType,
              paymentMethod: order.paymentMethod,
              cashReceived: order.cashReceived,
              changeAmount: order.changeAmount,
              status: order.status,
              createdAtMs: BigInt(order.createdAtMs),
              shiftId: shift?.id ?? null,
              shiftSyncId: order.shiftSyncId,
              staffSyncId: order.staffSyncId,
              staffName: order.staffName,
              cancelledByStaffSyncId: order.cancelledByStaffSyncId,
              cancelledAtMs:
                order.cancelledAtMs === null ? null : BigInt(order.cancelledAtMs),
              receivedAtMs: BigInt(nowMs),
            },
          });

          for (const item of order.items) {
            const product = item.productSyncId
              ? await tx.product.findUnique({
                  where: { syncId: item.productSyncId },
                  select: { id: true },
                })
              : null;
            await tx.orderItem.create({
              data: {
                syncId: item.syncId,
                orderId: created.id,
                productId: product?.id ?? null,
                productSyncId: item.productSyncId,
                productName: item.productName,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
              },
            });
          }

          // Mark a used discount code as consumed. The code was issued to this
          // device only, so the terminal's offline single-use guarantee holds;
          // this records where it was spent for audit.
          if (order.discountType === 'CODE' && order.discountCode) {
            await tx.discountCode.updateMany({
              where: {
                code: order.discountCode,
                assignedDeviceId: device.id,
                consumed: false,
              },
              data: {
                consumed: true,
                consumedByOrderSyncId: order.syncId,
                consumedAtMs: BigInt(order.createdAtMs),
              },
            });
          }
        });

        acceptedOrderIds.push(order.syncId);
      } catch (err) {
        req.log?.error?.({ err, syncId: order.syncId }, 'order store failed');
        rejected.push({ syncId: order.syncId, kind: 'order', reason: 'storage_error' });
      }
    }

    await prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAtMs: BigInt(nowMs) },
    });

    const response: SyncPushResponse = {
      acceptedOrderIds,
      acceptedShiftIds,
      rejected,
      serverTimeMs: nowMs,
    };
    return res.json(response);
  });

  /**
   * server -> POS. Master data plus this device's private batch of discount codes.
   *
   * SECURITY: this is the one endpoint that returns PIN hashes, because the
   * terminal must authenticate staff with no network. It is device-token
   * authenticated and must never be exposed to a browser session.
   */
  app.get('/api/sync/pull', async (req: Request, res: Response) => {
    const device = await requireDevice(req, res, prisma);
    if (!device) return;

    const nowMs = Date.now();

    const [products, staff, codes] = await Promise.all([
      prisma.product.findMany({
        select: {
          syncId: true,
          name: true,
          price: true,
          category: true,
          active: true,
          updatedAtMs: true,
        },
      }),
      prisma.staff.findMany({
        select: {
          syncId: true,
          name: true,
          role: true,
          pinHash: true,
          pinSalt: true,
          active: true,
          updatedAtMs: true,
        },
      }),
      // Only unconsumed codes assigned to THIS device.
      prisma.discountCode.findMany({
        where: { assignedDeviceId: device.id, consumed: false },
        select: {
          syncId: true,
          code: true,
          campaign: {
            select: { syncId: true, name: true, valueType: true, value: true },
          },
        },
      }),
    ]);

    await prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAtMs: BigInt(nowMs) },
    });

    const response: SyncPullResponse = {
      products: products.map((p) => ({
        syncId: p.syncId,
        name: p.name,
        price: p.price,
        category: p.category,
        active: p.active,
        updatedAtMs: Number(p.updatedAtMs),
      })),
      staff: staff.map((s) => ({
        syncId: s.syncId,
        name: s.name,
        role: s.role as SyncPullResponse['staff'][number]['role'],
        pinHash: s.pinHash,
        pinSalt: s.pinSalt,
        active: s.active,
        updatedAtMs: Number(s.updatedAtMs),
      })),
      discountCodes: codes.map((c) => ({
        syncId: c.syncId,
        code: c.code,
        campaignSyncId: c.campaign.syncId,
        campaignName: c.campaign.name,
        valueType: c.campaign.valueType as 'AMOUNT' | 'PERCENT',
        value: c.campaign.value,
      })),
      serverTimeMs: nowMs,
      cursor: String(nowMs),
    };
    return res.json(response);
  });
}
