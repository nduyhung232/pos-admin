/**
 * Admin routes — server-rendered (EJS) merge of the former React frontend and
 * Fastify admin API into one Express app, in the style of sales_web.
 *
 * WHAT CHANGED vs pos-admin
 *  - React SPA + JSON endpoints  ->  EJS pages + HTML form POSTs.
 *  - Fastify handlers            ->  Express handlers.
 *
 * WHAT IS PRESERVED (deliberately, financial-grade)
 *  - MANAGER-only access, enforced per route (fail closed) via requireManager.
 *  - Every mutation writes an AuditLog row (who changed a price / PIN / code).
 *  - PINs hashed with PBKDF2 (createPin); device tokens hashed with SHA-256.
 *  - All money is Int VND; division goes through the shared Money rule.
 *  - "last active manager" cannot be demoted/deactivated.
 *  - Device token is chosen by the manager; only its SHA-256 hash is stored.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { Config } from '../config.ts';
import { createPin, isPolicyValid, verifyPin } from '../lib/pin-hasher.ts';
import { hashDeviceToken, isTokenPolicyValid, MIN_TOKEN_LENGTH } from '../lib/device-auth.ts';
import { average } from '../shared/money.ts';
import { setSessionStaff, clearSession, requireManager } from './session.ts';

/** Codes are 10 chars from an alphabet with 0/O/1/I/L removed (mirrors the POS). */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateCode(): string {
  const bytes = randomUUID().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    const n = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    out += CODE_ALPHABET[n % CODE_ALPHABET.length];
  }
  return out;
}

/** Thrown inside a staff transaction to roll back when no active manager remains. */
class LastManagerError extends Error {}

async function audit(
  prisma: PrismaClient,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      atMs: BigInt(Date.now()),
      actor,
      action,
      entityType,
      entityId,
      // Detail must never contain PIN material — callers pass shapes only.
      detail: detail === undefined ? null : JSON.stringify(detail),
    },
  });
}

/** Start-of-day / end-of-day helpers for the report date inputs (Vietnam time UTC+7). */
function vnDateStr(d: Date = new Date()): string {
  const vnTime = new Date(d.getTime() + 7 * 3600 * 1000);
  return vnTime.toISOString().slice(0, 10);
}

function dayRangeMs(fromDate: string, toDate: string): { fromMs: number; toMs: number } {
  const fromMs = new Date(`${fromDate}T00:00:00+07:00`).getTime();
  const toMs = new Date(`${toDate}T23:59:59.999+07:00`).getTime();
  return { fromMs, toMs };
}

function todayStr(): string {
  return vnDateStr();
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return vnDateStr(d);
}

function daysAgoStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return vnDateStr(d);
}

function monthStartStr(): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function lastMonthRange(): { from: string; to: string } {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const firstDayPrevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastDayPrevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return {
    from: firstDayPrevMonth.toISOString().slice(0, 10),
    to: lastDayPrevMonth.toISOString().slice(0, 10),
  };
}

export function registerAdminRoutes(app: Express, prisma: PrismaClient, config: Config): void {
  // ---- Auth ----------------------------------------------------------------

  const setNoCache = (res: Response) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
  };

  app.get('/login', async (_req: Request, res: Response) => {
    setNoCache(res);
    const managers = await prisma.staff.findMany({
      where: { active: true, role: 'MANAGER' },
      select: { syncId: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.render('login', { managers, error: null, selectedId: null });
  });

  app.post('/login', async (req: Request, res: Response) => {
    setNoCache(res);
    const schema = z.object({
      staffSyncId: z.string().uuid(),
      pin: z.string().min(4).max(8),
    });
    const parsed = schema.safeParse(req.body);

    const renderError = async () => {
      const managers = await prisma.staff.findMany({
        where: { active: true, role: 'MANAGER' },
        select: { syncId: true, name: true },
        orderBy: { name: 'asc' },
      });
      res.status(401).render('login', {
        managers,
        error: 'Sai thông tin đăng nhập',
        selectedId: req.body?.staffSyncId || null,
      });
    };

    if (!parsed.success) return renderError();

    const staff = await prisma.staff.findUnique({
      where: { syncId: parsed.data.staffSyncId },
      select: {
        syncId: true, name: true, role: true, pinHash: true, pinSalt: true, active: true,
      },
    });

    const ok =
      staff !== null &&
      staff.active &&
      staff.role === 'MANAGER' &&
      (await verifyPin(parsed.data.pin, staff.pinHash, staff.pinSalt));

    if (!ok || staff === null) {
      req.log?.warn?.({ staffSyncId: parsed.data.staffSyncId }, 'admin login failed');
      return renderError();
    }

    req.session.regenerate(async (err) => {
      if (err) {
        req.log?.error?.(err, 'session regenerate failed');
      }
      setSessionStaff(req, staff.syncId);
      await audit(prisma, staff.syncId, 'login', 'staff', staff.syncId);
      res.redirect('/reports');
    });
  });

  const handleLogout = async (req: Request, res: Response) => {
    setNoCache(res);
    await clearSession(req, res);
    res.redirect('/login');
  };

  app.post('/logout', handleLogout);
  app.get('/logout', handleLogout);

  app.get('/', (_req: Request, res: Response) => res.redirect('/reports'));

  // ---- Revenue report (home) ----------------------------------------------

  app.get('/reports', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const presetParam = req.query.preset as string | undefined;
    let fromDate = (req.query.from as string) || '';
    let toDate = (req.query.to as string) || '';

    if (presetParam === 'today') {
      fromDate = todayStr();
      toDate = todayStr();
    } else if (presetParam === 'yesterday') {
      fromDate = yesterdayStr();
      toDate = yesterdayStr();
    } else if (presetParam === 'last7days') {
      fromDate = daysAgoStr(6);
      toDate = todayStr();
    } else if (presetParam === 'thismonth') {
      fromDate = monthStartStr();
      toDate = todayStr();
    } else if (presetParam === 'lastmonth') {
      const lm = lastMonthRange();
      fromDate = lm.from;
      toDate = lm.to;
    } else if (!fromDate || !toDate) {
      fromDate = monthStartStr();
      toDate = todayStr();
    }

    let activePreset = presetParam || '';
    if (!activePreset) {
      if (fromDate === todayStr() && toDate === todayStr()) activePreset = 'today';
      else if (fromDate === yesterdayStr() && toDate === yesterdayStr()) activePreset = 'yesterday';
      else if (fromDate === daysAgoStr(6) && toDate === todayStr()) activePreset = 'last7days';
      else if (fromDate === monthStartStr() && toDate === todayStr()) activePreset = 'thismonth';
      else {
        const lm = lastMonthRange();
        if (fromDate === lm.from && toDate === lm.to) activePreset = 'lastmonth';
      }
    }

    const { fromMs, toMs } = dayRangeMs(fromDate, toDate);

    // 1. Fetch all orders (PAID and CANCELLED)
    const orders = await prisma.order.findMany({
      where: {
        createdAtMs: { gte: BigInt(fromMs), lte: BigInt(toMs) },
      },
      include: {
        items: {
          include: {
            product: { select: { category: true } },
          },
        },
        device: { select: { name: true } },
      },
      orderBy: { createdAtMs: 'asc' },
    });

    // 2. Fetch closed shifts for cash reconciliation
    const shifts = await prisma.shift.findMany({
      where: {
        openedAtMs: { gte: BigInt(fromMs), lte: BigInt(toMs) },
        status: 'CLOSED',
      },
      select: {
        syncId: true,
        openedAtMs: true,
        closedAtMs: true,
        openingCash: true,
        countedCash: true,
        expectedCash: true,
        cashDifference: true,
        staffName: true,
      },
      orderBy: { openedAtMs: 'desc' },
      take: 20,
    });

    const paidOrders = orders.filter((o) => o.status === 'PAID');
    const cancelledOrders = orders.filter((o) => o.status === 'CANCELLED');

    const totalOrders = paidOrders.length;
    const totalCancelled = cancelledOrders.length;
    const totalAllOrders = orders.length;
    const cancellationRate = totalAllOrders > 0 ? Number(((totalCancelled / totalAllOrders) * 100).toFixed(1)) : 0;

    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);
    const totalGross = paidOrders.reduce((sum, o) => sum + o.subtotal, 0);
    const totalDiscount = paidOrders.reduce((sum, o) => sum + o.discountAmount, 0);
    const discountRate = totalGross > 0 ? Number(((totalDiscount / totalGross) * 100).toFixed(1)) : 0;
    const averageOrderValue = totalOrders > 0 ? average(totalRevenue, totalOrders) : 0;

    let totalItemsSold = 0;
    for (const o of paidOrders) {
      for (const it of o.items) {
        totalItemsSold += it.quantity;
      }
    }
    const averageItemsPerOrder = totalOrders > 0 ? Number((totalItemsSold / totalOrders).toFixed(1)) : 0;

    // Payment methods breakdown
    const methodMap = new Map<string, { count: number; revenue: number }>();
    for (const o of paidOrders) {
      const cur = methodMap.get(o.paymentMethod) || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += o.total;
      methodMap.set(o.paymentMethod, cur);
    }
    const byMethod = Array.from(methodMap.entries()).map(([method, data]) => ({
      paymentMethod: method,
      name: method === 'CASH' ? 'Tiền mặt' : method === 'TRANSFER' ? 'Chuyển khoản' : method === 'CARD' ? 'Thẻ' : method,
      orderCount: data.count,
      revenue: data.revenue,
      percent: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(1)) : 0,
    }));

    // Order types breakdown
    const typeMap = new Map<string, { count: number; revenue: number }>();
    for (const o of paidOrders) {
      const cur = typeMap.get(o.orderType) || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += o.total;
      typeMap.set(o.orderType, cur);
    }
    const byOrderType = Array.from(typeMap.entries()).map(([type, data]) => ({
      orderType: type,
      name: type === 'DINE_IN' ? 'Tại bàn' : type === 'TAKE_AWAY' ? 'Mang về' : type,
      orderCount: data.count,
      revenue: data.revenue,
      percent: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(1)) : 0,
    }));

    // Hourly distribution (0h - 23h in Vietnam time UTC+7)
    const hourlyData = Array.from({ length: 24 }, (_, hour) => ({
      hour: `${String(hour).padStart(2, '0')}:00`,
      revenue: 0,
      orders: 0,
    }));
    for (const o of paidOrders) {
      const vnDate = new Date(Number(o.createdAtMs) + 7 * 3600 * 1000);
      const h = vnDate.getUTCHours();
      hourlyData[h].revenue += o.total;
      hourlyData[h].orders += 1;
    }

    // Timeline Chart (by Day if range > 1 day, by Hour if range == 1 day)
    const isSingleDay = fromDate === toDate;
    const timelineLabels: string[] = [];
    const timelineRevenue: number[] = [];
    const timelineOrders: number[] = [];

    if (isSingleDay) {
      for (let h = 7; h <= 23; h += 1) {
        timelineLabels.push(`${String(h).padStart(2, '0')}:00`);
        timelineRevenue.push(hourlyData[h].revenue);
        timelineOrders.push(hourlyData[h].orders);
      }
    } else {
      const dayMap = new Map<string, { revenue: number; orders: number }>();
      const cur = new Date(`${fromDate}T00:00:00+07:00`);
      const end = new Date(`${toDate}T00:00:00+07:00`);
      while (cur <= end) {
        const dStr = vnDateStr(cur);
        dayMap.set(dStr, { revenue: 0, orders: 0 });
        cur.setDate(cur.getDate() + 1);
      }

      for (const o of paidOrders) {
        const vnDate = new Date(Number(o.createdAtMs) + 7 * 3600 * 1000);
        const dStr = vnDate.toISOString().slice(0, 10);
        const existing = dayMap.get(dStr);
        if (existing) {
          existing.revenue += o.total;
          existing.orders += 1;
        }
      }

      for (const [dStr, val] of dayMap.entries()) {
        const parts = dStr.split('-');
        timelineLabels.push(`${parts[2]}/${parts[1]}`);
        timelineRevenue.push(val.revenue);
        timelineOrders.push(val.orders);
      }
    }

    // Categories breakdown
    const catMap = new Map<string, { revenue: number; quantity: number }>();
    for (const o of paidOrders) {
      for (const it of o.items) {
        const cat = it.product?.category?.trim() || 'Khác';
        const cur = catMap.get(cat) || { revenue: 0, quantity: 0 };
        cur.quantity += it.quantity;
        cur.revenue += it.unitPrice * it.quantity;
        catMap.set(cat, cur);
      }
    }
    const byCategory = Array.from(catMap.entries())
      .map(([category, data]) => ({
        category,
        quantity: data.quantity,
        revenue: data.revenue,
        percent: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Top Products
    const prodMap = new Map<string, { quantity: number; revenue: number; category: string }>();
    for (const o of paidOrders) {
      for (const it of o.items) {
        const cur = prodMap.get(it.productName) || {
          quantity: 0,
          revenue: 0,
          category: it.product?.category?.trim() || 'Khác',
        };
        cur.quantity += it.quantity;
        cur.revenue += it.unitPrice * it.quantity;
        prodMap.set(it.productName, cur);
      }
    }
    const topProducts = Array.from(prodMap.entries())
      .map(([name, data]) => ({
        productName: name,
        category: data.category,
        quantity: data.quantity,
        revenue: data.revenue,
        percent: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(1)) : 0,
        averagePrice: data.quantity > 0 ? average(data.revenue, data.quantity) : 0,
      }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);

    // Staff Performance
    const staffMap = new Map<string, { orderCount: number; revenue: number }>();
    for (const o of paidOrders) {
      const sName = o.staffName?.trim() || 'Thu ngân';
      const cur = staffMap.get(sName) || { orderCount: 0, revenue: 0 };
      cur.orderCount += 1;
      cur.revenue += o.total;
      staffMap.set(sName, cur);
    }
    const byStaff = Array.from(staffMap.entries())
      .map(([name, data]) => ({
        staffName: name,
        orderCount: data.orderCount,
        revenue: data.revenue,
        averageOrderValue: data.orderCount > 0 ? average(data.revenue, data.orderCount) : 0,
        percent: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Shifts Summary
    const totalShifts = shifts.length;
    const totalOpeningCash = shifts.reduce((s, sh) => s + sh.openingCash, 0);
    const totalCountedCash = shifts.reduce((s, sh) => s + (sh.countedCash ?? 0), 0);
    const totalExpectedCash = shifts.reduce((s, sh) => s + (sh.expectedCash ?? 0), 0);
    const totalCashDifference = shifts.reduce((s, sh) => s + (sh.cashDifference ?? 0), 0);

    // 1. Chart: Day of Week (Thứ 2 -> Chủ Nhật)
    const dayOfWeekLabels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
    // UTC+7 Day mapping: 1->0 (Mon), 2->1 (Tue), 3->2 (Wed), 4->3 (Thu), 5->4 (Fri), 6->5 (Sat), 0->6 (Sun)
    const dowIndexMap = [6, 0, 1, 2, 3, 4, 5];
    const dowRevenue = [0, 0, 0, 0, 0, 0, 0];
    const dowOrders = [0, 0, 0, 0, 0, 0, 0];
    for (const o of paidOrders) {
      const vnDate = new Date(Number(o.createdAtMs) + 7 * 3600 * 1000);
      const dow = vnDate.getUTCDay();
      const idx = dowIndexMap[dow];
      dowRevenue[idx] += o.total;
      dowOrders[idx] += 1;
    }
    const chartDayOfWeek = {
      labels: dayOfWeekLabels,
      revenue: dowRevenue,
      orders: dowOrders,
    };

    // 2. Chart: Ticket Size / Order Value Distribution
    const ticketBuckets = [
      { label: '< 30k', min: 0, max: 29999, count: 0, revenue: 0 },
      { label: '30k - 60k', min: 30000, max: 60000, count: 0, revenue: 0 },
      { label: '60k - 100k', min: 60001, max: 100000, count: 0, revenue: 0 },
      { label: '100k - 200k', min: 100001, max: 200000, count: 0, revenue: 0 },
      { label: '> 200k', min: 200001, max: Infinity, count: 0, revenue: 0 },
    ];
    for (const o of paidOrders) {
      const val = o.total;
      for (const b of ticketBuckets) {
        if (val >= b.min && val <= b.max) {
          b.count += 1;
          b.revenue += val;
          break;
        }
      }
    }
    const chartTicketSize = {
      labels: ticketBuckets.map((b) => b.label),
      counts: ticketBuckets.map((b) => b.count),
      revenues: ticketBuckets.map((b) => b.revenue),
      percents: ticketBuckets.map((b) =>
        totalOrders > 0 ? Number(((b.count / totalOrders) * 100).toFixed(1)) : 0
      ),
    };

    // 3. Chart: Topping Statistics & Attachment Rate
    const masterToppings = await prisma.topping.findMany({
      select: { name: true, price: true },
    });
    const toppingPriceMap = new Map<string, number>();
    for (const t of masterToppings) {
      toppingPriceMap.set(t.name.trim().toLowerCase(), t.price);
    }

    let itemsWithToppingCount = 0;
    const toppingUsageMap = new Map<string, { count: number; estRevenue: number }>();
    for (const o of paidOrders) {
      for (const it of o.items) {
        const match = it.productName.match(/^(.*?)\s*\(\+(.*?)\)$/);
        if (match) {
          itemsWithToppingCount += it.quantity;
          const rawToppings = match[2].split(',').map((s) => s.trim()).filter(Boolean);
          for (const tName of rawToppings) {
            const cur = toppingUsageMap.get(tName) || { count: 0, estRevenue: 0 };
            cur.count += it.quantity;
            const unitP = toppingPriceMap.get(tName.toLowerCase()) || 0;
            cur.estRevenue += unitP * it.quantity;
            toppingUsageMap.set(tName, cur);
          }
        }
      }
    }
    const topToppings = Array.from(toppingUsageMap.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        estRevenue: data.estRevenue,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const toppingAttachmentRate =
      totalItemsSold > 0
        ? Number(((itemsWithToppingCount / totalItemsSold) * 100).toFixed(1))
        : 0;

    const toppingStats = {
      itemsWithToppingCount,
      itemsWithoutToppingCount: Math.max(0, totalItemsSold - itemsWithToppingCount),
      attachmentRate: toppingAttachmentRate,
      topToppings,
      totalToppingPortions: Array.from(toppingUsageMap.values()).reduce((sum, v) => sum + v.count, 0),
    };
    const chartTopping = {
      labels: topToppings.map((t) => t.name),
      counts: topToppings.map((t) => t.count),
      revenues: topToppings.map((t) => t.estRevenue),
    };

    // 4. Chart: Discount Breakdown & Promotion Impact
    const discountGroups = {
      NONE: { label: 'Nguyên giá', count: 0, discount: 0, revenue: 0 },
      PERCENT: { label: 'Giảm theo %', count: 0, discount: 0, revenue: 0 },
      AMOUNT: { label: 'Giảm số tiền', count: 0, discount: 0, revenue: 0 },
      CODE: { label: 'Mã Voucher', count: 0, discount: 0, revenue: 0 },
    };
    for (const o of paidOrders) {
      const type = o.discountType;
      if (!type || type === 'NONE' || o.discountAmount === 0) {
        discountGroups.NONE.count += 1;
        discountGroups.NONE.revenue += o.total;
      } else if (type === 'PERCENT') {
        discountGroups.PERCENT.count += 1;
        discountGroups.PERCENT.discount += o.discountAmount;
        discountGroups.PERCENT.revenue += o.total;
      } else if (type === 'AMOUNT') {
        discountGroups.AMOUNT.count += 1;
        discountGroups.AMOUNT.discount += o.discountAmount;
        discountGroups.AMOUNT.revenue += o.total;
      } else if (type === 'CODE') {
        discountGroups.CODE.count += 1;
        discountGroups.CODE.discount += o.discountAmount;
        discountGroups.CODE.revenue += o.total;
      } else {
        discountGroups.NONE.count += 1;
        discountGroups.NONE.revenue += o.total;
      }
    }
    const discountedOrdersCount =
      discountGroups.PERCENT.count + discountGroups.AMOUNT.count + discountGroups.CODE.count;
    const discountedOrdersRate =
      totalOrders > 0 ? Number(((discountedOrdersCount / totalOrders) * 100).toFixed(1)) : 0;

    const discountStats = {
      discountedOrdersCount,
      discountedOrdersRate,
      fullPriceOrdersCount: discountGroups.NONE.count,
      totalDiscountAmount: totalDiscount,
    };
    const chartDiscount = {
      labels: ['Nguyên giá', 'Giảm theo %', 'Giảm số tiền', 'Mã Voucher'],
      counts: [
        discountGroups.NONE.count,
        discountGroups.PERCENT.count,
        discountGroups.AMOUNT.count,
        discountGroups.CODE.count,
      ],
      discounts: [
        0,
        discountGroups.PERCENT.discount,
        discountGroups.AMOUNT.discount,
        discountGroups.CODE.discount,
      ],
      revenues: [
        discountGroups.NONE.revenue,
        discountGroups.PERCENT.revenue,
        discountGroups.AMOUNT.revenue,
        discountGroups.CODE.revenue,
      ],
    };

    res.render('reports', {
      active: 'reports',
      session,
      fromDate,
      toDate,
      activePreset,
      totalRevenue,
      totalGross,
      totalDiscount,
      discountRate,
      totalOrders,
      totalCancelled,
      cancellationRate,
      totalItemsSold,
      averageItemsPerOrder,
      averageOrderValue,
      byMethod,
      byOrderType,
      byCategory,
      topProducts,
      byStaff,
      shiftsSummary: {
        totalShifts,
        totalOpeningCash,
        totalCountedCash,
        totalExpectedCash,
        totalCashDifference,
      },
      shifts: shifts.map((s) => ({
        ...s,
        openedAtMs: Number(s.openedAtMs),
        closedAtMs: s.closedAtMs ? Number(s.closedAtMs) : null,
      })),
      isSingleDay,
      chartTimeline: {
        labels: timelineLabels,
        revenue: timelineRevenue,
        orders: timelineOrders,
      },
      chartHourly: {
        labels: hourlyData.slice(7, 24).map((h) => h.hour),
        revenue: hourlyData.slice(7, 24).map((h) => h.revenue),
        orders: hourlyData.slice(7, 24).map((h) => h.orders),
      },
      chartDayOfWeek,
      chartTicketSize,
      toppingStats,
      chartTopping,
      discountStats,
      chartDiscount,
    });
  });

  // ---- Products ------------------------------------------------------------

  app.get('/products', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const [products, allToppings] = await Promise.all([
      prisma.product.findMany({
        orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
        select: {
          syncId: true,
          name: true,
          price: true,
          category: true,
          active: true,
          toppings: {
            select: { syncId: true, name: true, price: true, active: true },
          },
        },
      }),
      prisma.topping.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { syncId: true, name: true, price: true },
      }),
    ]);

    res.render('products', {
      active: 'products',
      session,
      products,
      allToppings,
      error: typeof req.query.error === 'string' ? req.query.error : null,
      notice: typeof req.query.notice === 'string' ? req.query.notice : null,
    });
  });

  app.post('/products', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const schema = z.object({
      name: z.string().min(1).max(200),
      // Integer VND only. A float price would corrupt every downstream total.
      price: z.coerce.number().int().nonnegative().max(100_000_000),
      category: z.string().min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.redirect('/products');

    const nowMs = Date.now();
    const product = await prisma.product.create({
      data: {
        syncId: randomUUID(),
        name: parsed.data.name.trim(),
        price: parsed.data.price,
        category: parsed.data.category.trim(),
        active: true,
        createdAtMs: BigInt(nowMs),
        updatedAtMs: BigInt(nowMs),
      },
      select: { syncId: true, name: true, price: true },
    });

    await audit(prisma, session.staffSyncId, 'create', 'product', product.syncId, {
      name: product.name,
      price: product.price,
    });
    res.redirect('/products?notice=created');
  });

  /**
   * Batch partial update of products — one "Save" button for the whole screen.
   * Only changed rows/fields are sent (PATCH), so unchanged prices are not
   * re-transmitted. A price change is financially significant and is audited.
   */
  app.patch('/products', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'json');
    if (!session) return;

    const schema = z.object({
      changes: z
        .array(
          z.object({
            syncId: z.string().uuid(),
            name: z.string().min(1).max(200).optional(),
            // Integer VND only. A float price would corrupt every downstream total.
            price: z.number().int().nonnegative().max(100_000_000).optional(),
            category: z.string().min(1).max(100).optional(),
            active: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid' });

    const changes = parsed.data.changes.filter(
      (c) => c.name !== undefined || c.price !== undefined || c.category !== undefined || c.active !== undefined,
    );
    if (changes.length === 0) return res.json({ ok: true, updated: 0 });

    const syncIds = changes.map((c) => c.syncId);
    const existing = await prisma.product.findMany({
      where: { syncId: { in: syncIds } },
      select: { syncId: true, name: true, price: true, category: true, active: true },
    });
    const before = new Map(existing.map((p) => [p.syncId, p]));
    if (syncIds.some((id) => !before.has(id))) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const nowMs = BigInt(Date.now());
    await prisma.$transaction(
      changes.map((c) => {
        const { syncId, ...fields } = c;
        const data: Record<string, unknown> = { ...fields, updatedAtMs: nowMs };
        if (typeof fields.name === 'string') data.name = fields.name.trim();
        if (typeof fields.category === 'string') data.category = fields.category.trim();
        return prisma.product.update({ where: { syncId }, data });
      }),
    );

    for (const c of changes) {
      const prev = before.get(c.syncId)!;
      await audit(prisma, session.staffSyncId, 'update', 'product', c.syncId, {
        before: { name: prev.name, price: prev.price, category: prev.category, active: prev.active },
        after: c,
      });
    }

    res.json({ ok: true, updated: changes.length });
  });

  app.post('/products/:syncId/toppings', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'json');
    if (!session) return;

    const schema = z.object({
      toppingSyncIds: z.array(z.string().uuid()),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid' });

    const product = await prisma.product.findUnique({
      where: { syncId: req.params.syncId },
      select: { id: true, syncId: true },
    });
    if (!product) return res.status(404).json({ ok: false, error: 'not_found' });

    const nowMs = BigInt(Date.now());
    await prisma.product.update({
      where: { syncId: product.syncId },
      data: {
        updatedAtMs: nowMs,
        toppings: {
          set: parsed.data.toppingSyncIds.map((id) => ({ syncId: id })),
        },
      },
    });

    await audit(prisma, session.staffSyncId, 'update', 'product_toppings', product.syncId, {
      toppingSyncIds: parsed.data.toppingSyncIds,
    });

    res.json({ ok: true });
  });

  // ---- Toppings ------------------------------------------------------------

  app.get('/toppings', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const toppings = await prisma.topping.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: { syncId: true, name: true, price: true, active: true },
    });
    res.render('toppings', {
      active: 'toppings',
      session,
      toppings,
      error: typeof req.query.error === 'string' ? req.query.error : null,
      notice: typeof req.query.notice === 'string' ? req.query.notice : null,
    });
  });

  app.post('/toppings', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const schema = z.object({
      name: z.string().min(1).max(200),
      price: z.coerce.number().int().nonnegative().max(100_000_000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.redirect('/toppings');

    const nowMs = Date.now();
    const topping = await prisma.topping.create({
      data: {
        syncId: randomUUID(),
        name: parsed.data.name.trim(),
        price: parsed.data.price,
        active: true,
        createdAtMs: BigInt(nowMs),
        updatedAtMs: BigInt(nowMs),
      },
      select: { syncId: true, name: true, price: true },
    });

    await audit(prisma, session.staffSyncId, 'create', 'topping', topping.syncId, {
      name: topping.name,
      price: topping.price,
    });
    res.redirect('/toppings?notice=created');
  });

  app.patch('/toppings', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'json');
    if (!session) return;

    const schema = z.object({
      changes: z
        .array(
          z.object({
            syncId: z.string().uuid(),
            name: z.string().min(1).max(200).optional(),
            price: z.number().int().nonnegative().max(100_000_000).optional(),
            active: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid' });

    const changes = parsed.data.changes.filter(
      (c) => c.name !== undefined || c.price !== undefined || c.active !== undefined,
    );
    if (changes.length === 0) return res.json({ ok: true, updated: 0 });

    const syncIds = changes.map((c) => c.syncId);
    const existing = await prisma.topping.findMany({
      where: { syncId: { in: syncIds } },
      select: { syncId: true, name: true, price: true, active: true },
    });
    const before = new Map(existing.map((t) => [t.syncId, t]));
    if (syncIds.some((id) => !before.has(id))) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const nowMs = BigInt(Date.now());
    await prisma.$transaction(
      changes.map((c) => {
        const { syncId, ...fields } = c;
        const data: Record<string, unknown> = { ...fields, updatedAtMs: nowMs };
        if (typeof fields.name === 'string') data.name = fields.name.trim();
        return prisma.topping.update({ where: { syncId }, data });
      }),
    );

    for (const c of changes) {
      const prev = before.get(c.syncId)!;
      await audit(prisma, session.staffSyncId, 'update', 'topping', c.syncId, {
        before: { name: prev.name, price: prev.price, active: prev.active },
        after: c,
      });
    }

    res.json({ ok: true, updated: changes.length });
  });

  // ---- Staff ---------------------------------------------------------------

  app.get('/staff', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    // Credential columns are deliberately not selected.
    const staff = await prisma.staff.findMany({
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }],
      select: { syncId: true, name: true, role: true, active: true },
    });
    res.render('staff', {
      active: 'staff',
      session,
      staff,
      error: typeof req.query.error === 'string' ? req.query.error : null,
      notice: typeof req.query.notice === 'string' ? req.query.notice : null,
    });
  });

  app.post('/staff', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const schema = z.object({
      name: z.string().min(1).max(100),
      role: z.enum(['CASHIER', 'MANAGER']),
      pin: z.string().min(4).max(8),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.redirect('/staff?error=invalid');
    if (!isPolicyValid(parsed.data.pin)) return res.redirect('/staff?error=pin_policy');

    const credential = await createPin(parsed.data.pin);
    const nowMs = Date.now();
    const staff = await prisma.staff.create({
      data: {
        syncId: randomUUID(),
        name: parsed.data.name.trim(),
        role: parsed.data.role,
        pinHash: credential.pinHash,
        pinSalt: credential.pinSalt,
        active: true,
        createdAtMs: BigInt(nowMs),
        updatedAtMs: BigInt(nowMs),
      },
      select: { syncId: true, name: true, role: true },
    });

    // Audit records the event, never the PIN or its hash.
    await audit(prisma, session.staffSyncId, 'create', 'staff', staff.syncId, {
      name: staff.name,
      role: staff.role,
    });
    res.redirect('/staff?notice=created');
  });

  /**
   * Batch partial update of staff — one "Save" button for the whole screen.
   *
   * The browser sends ONLY the rows/fields the user changed (PATCH semantics),
   * so a screen full of staff does not re-transmit unchanged data. Each change
   * may include a new PIN (write-only). The whole batch runs in one transaction
   * and is rejected as a unit if it would leave no active manager.
   */
  app.patch('/staff', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'json');
    if (!session) return;

    const schema = z.object({
      changes: z
        .array(
          z.object({
            syncId: z.string().uuid(),
            name: z.string().min(1).max(100).optional(),
            role: z.enum(['CASHIER', 'MANAGER']).optional(),
            active: z.boolean().optional(),
            pin: z.string().min(4).max(8).optional(),
          }),
        )
        .min(1)
        .max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid' });

    // Keep only rows that actually carry a change beyond the id.
    const changes = parsed.data.changes.filter(
      (c) => c.name !== undefined || c.role !== undefined || c.active !== undefined || c.pin !== undefined,
    );
    if (changes.length === 0) return res.json({ ok: true, updated: 0 });

    // PIN policy (4–8 digits) mirrors the POS rule.
    for (const c of changes) {
      if (c.pin !== undefined && !isPolicyValid(c.pin)) {
        return res.status(400).json({ ok: false, error: 'pin_policy' });
      }
    }

    const syncIds = changes.map((c) => c.syncId);
    const existing = await prisma.staff.findMany({
      where: { syncId: { in: syncIds } },
      select: { syncId: true, name: true, role: true, active: true },
    });
    const before = new Map(existing.map((s) => [s.syncId, s]));
    if (syncIds.some((id) => !before.has(id))) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // Hash any new PINs BEFORE the transaction (createPin is deliberately slow).
    const creds = new Map<string, { pinHash: string; pinSalt: string }>();
    for (const c of changes) {
      if (c.pin !== undefined) creds.set(c.syncId, await createPin(c.pin));
    }

    const nowMs = BigInt(Date.now());
    try {
      await prisma.$transaction(async (tx) => {
        for (const c of changes) {
          const data: Record<string, unknown> = { updatedAtMs: nowMs };
          if (c.name !== undefined) data.name = c.name.trim();
          if (c.role !== undefined) data.role = c.role;
          if (c.active !== undefined) data.active = c.active;
          const cred = creds.get(c.syncId);
          if (cred) {
            data.pinHash = cred.pinHash;
            data.pinSalt = cred.pinSalt;
          }
          await tx.staff.update({ where: { syncId: c.syncId }, data });
        }
        // Same invariant the POS enforced: at least one active manager must remain.
        const activeManagers = await tx.staff.count({ where: { active: true, role: 'MANAGER' } });
        if (activeManagers < 1) throw new LastManagerError();
      });
    } catch (e) {
      if (e instanceof LastManagerError) {
        return res.status(409).json({ ok: false, error: 'last_manager' });
      }
      throw e;
    }

    // Audit after commit. PIN material is never included in the detail.
    for (const c of changes) {
      const prev = before.get(c.syncId)!;
      if (c.name !== undefined || c.role !== undefined || c.active !== undefined) {
        await audit(prisma, session.staffSyncId, 'update', 'staff', c.syncId, {
          before: { name: prev.name, role: prev.role, active: prev.active },
          after: { name: c.name, role: c.role, active: c.active },
        });
      }
      if (c.pin !== undefined) {
        await audit(prisma, session.staffSyncId, 'reset_pin', 'staff', c.syncId);
      }
    }

    res.json({ ok: true, updated: changes.length });
  });

  // ---- Discount campaigns --------------------------------------------------

  app.get('/campaigns', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const campaigns = await prisma.campaign.findMany({
      orderBy: { createdAtMs: 'desc' },
      select: {
        syncId: true, name: true, valueType: true, value: true, createdAtMs: true,
        _count: { select: { codes: true } },
      },
    });
    const devices = await prisma.device.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    res.render('campaigns', {
      active: 'campaigns',
      session,
      devices,
      campaigns: campaigns.map((c) => ({
        syncId: c.syncId,
        name: c.name,
        valueType: c.valueType,
        value: c.value,
        createdAtMs: Number(c.createdAtMs),
        totalCodes: c._count.codes,
      })),
      error: req.query.error ?? null,
    });
  });

  app.post('/campaigns', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const schema = z.object({
      name: z.string().min(1).max(200),
      valueType: z.enum(['AMOUNT', 'PERCENT']),
      value: z.coerce.number().int().positive(),
      count: z.coerce.number().int().positive().max(5_000),
      deviceId: z.coerce.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.redirect('/campaigns?error=invalid');
    // A percentage above 100 would mean a negative price.
    if (parsed.data.valueType === 'PERCENT' && parsed.data.value > 100) {
      return res.redirect('/campaigns?error=percent_range');
    }

    const device = await prisma.device.findUnique({
      where: { id: parsed.data.deviceId },
      select: { id: true, name: true, active: true },
    });
    if (!device || !device.active) return res.redirect('/campaigns?error=unknown_device');

    const nowMs = Date.now();
    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          syncId: randomUUID(),
          name: parsed.data.name.trim(),
          valueType: parsed.data.valueType,
          value: parsed.data.value,
          createdAtMs: BigInt(nowMs),
        },
        select: { id: true, syncId: true, name: true },
      });

      // Generate distinct codes; the unique index is the final guarantee.
      const codes = new Set<string>();
      while (codes.size < parsed.data.count) codes.add(generateCode());

      await tx.discountCode.createMany({
        data: [...codes].map((code) => ({
          syncId: randomUUID(),
          code,
          campaignId: created.id,
          assignedDeviceId: device.id,
          assignedAtMs: BigInt(nowMs),
        })),
      });
      return created;
    });

    await audit(prisma, session.staffSyncId, 'create', 'campaign', campaign.syncId, {
      name: campaign.name,
      valueType: parsed.data.valueType,
      value: parsed.data.value,
      count: parsed.data.count,
      assignedTo: device.name,
    });
    res.redirect('/campaigns');
  });

  // ---- Orders (long-term history) -----------------------------------------

  app.get('/orders', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const presetParam = req.query.preset as string | undefined;
    let fromDate = (req.query.from as string) || '';
    let toDate = (req.query.to as string) || '';

    if (presetParam === 'today') {
      fromDate = todayStr();
      toDate = todayStr();
    } else if (presetParam === 'yesterday') {
      fromDate = yesterdayStr();
      toDate = yesterdayStr();
    } else if (presetParam === 'last7days') {
      fromDate = daysAgoStr(6);
      toDate = todayStr();
    } else if (presetParam === 'thismonth') {
      fromDate = monthStartStr();
      toDate = todayStr();
    } else if (presetParam === 'lastmonth') {
      const lm = lastMonthRange();
      fromDate = lm.from;
      toDate = lm.to;
    } else if (!fromDate || !toDate) {
      fromDate = monthStartStr();
      toDate = todayStr();
    }

    let activePreset = presetParam || '';
    if (!activePreset) {
      if (fromDate === todayStr() && toDate === todayStr()) activePreset = 'today';
      else if (fromDate === yesterdayStr() && toDate === yesterdayStr()) activePreset = 'yesterday';
      else if (fromDate === daysAgoStr(6) && toDate === todayStr()) activePreset = 'last7days';
      else if (fromDate === monthStartStr() && toDate === todayStr()) activePreset = 'thismonth';
      else {
        const lm = lastMonthRange();
        if (fromDate === lm.from && toDate === lm.to) activePreset = 'lastmonth';
      }
    }

    const { fromMs, toMs } = dayRangeMs(fromDate, toDate);

    const where = {
      createdAtMs: { gte: BigInt(fromMs), lte: BigInt(toMs) },
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAtMs: 'desc' },
        take: 300,
        select: {
          syncId: true,
          subtotal: true,
          discountAmount: true,
          total: true,
          discountType: true,
          discountCode: true,
          orderType: true,
          paymentMethod: true,
          status: true,
          createdAtMs: true,
          staffName: true,
          device: { select: { name: true } },
          items: { select: { productName: true, unitPrice: true, quantity: true } },
        },
      }),
      prisma.order.count({ where }),
    ]);

    const paidOrders = orders.filter((o) => o.status === 'PAID');
    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);
    const totalDiscount = paidOrders.reduce((sum, o) => sum + o.discountAmount, 0);
    const dineInCount = paidOrders.filter((o) => o.orderType === 'DINE_IN').length;
    const takeAwayCount = paidOrders.filter((o) => o.orderType === 'TAKE_AWAY').length;
    const cancelledCount = orders.filter((o) => o.status === 'CANCELLED').length;

    res.render('orders', {
      active: 'orders',
      session,
      fromDate,
      toDate,
      activePreset,
      total,
      summary: {
        totalRevenue,
        paidCount: paidOrders.length,
        cancelledCount,
        dineInCount,
        takeAwayCount,
        totalDiscount,
      },
      orders: orders.map((o) => {
        const d = new Date(Number(o.createdAtMs));
        const timePart = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const datePart = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        return {
          ...o,
          createdAtMs: Number(o.createdAtMs),
          timeFormatted: timePart,
          dateFormatted: datePart,
          deviceName: o.device.name,
        };
      }),
    });
  });

  // ---- Shifts -------------------------------------------------------------

  app.get('/shifts', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const shifts = await prisma.shift.findMany({
      orderBy: { openedAtMs: 'desc' },
      take: 200,
      select: {
        syncId: true,
        openedAtMs: true,
        closedAtMs: true,
        openingCash: true,
        countedCash: true,
        expectedCash: true,
        cashDifference: true,
        cashBreakdown: true,
        status: true,
        staffName: true,
        device: { select: { name: true } },
      },
    });

    res.render('shifts', {
      active: 'shifts',
      session,
      shifts: shifts.map((s) => ({
        ...s,
        openedAtMs: Number(s.openedAtMs),
        closedAtMs: s.closedAtMs === null ? null : Number(s.closedAtMs),
        deviceName: s.device.name,
      })),
    });
  });

  // ---- Devices ------------------------------------------------------------

  app.get('/devices', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    // tokenHash is never selected.
    const devices = await prisma.device.findMany({
      orderBy: { createdAtMs: 'desc' },
      select: { id: true, name: true, active: true, lastSeenAtMs: true, createdAtMs: true },
    });

    res.render('devices', {
      active: 'devices',
      session,
      minTokenLength: MIN_TOKEN_LENGTH,
      devices: devices.map((d) => ({
        ...d,
        lastSeenAtMs: d.lastSeenAtMs === null ? null : Number(d.lastSeenAtMs),
        createdAtMs: Number(d.createdAtMs),
      })),
      error: (req.query.error as string) ?? null,
      created: (req.query.created as string) ?? null,
    });
  });

  /**
   * Register a terminal. The manager chooses the token; only its SHA-256 hash is
   * stored. The token is what the terminal will send as `Authorization: Bearer`.
   */
  app.post('/devices', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(100),
        token: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.redirect('/devices?error=invalid');

    const token = parsed.data.token.trim();
    if (!isTokenPolicyValid(token)) return res.redirect('/devices?error=token_policy');

    const tokenHash = hashDeviceToken(token);

    // Reject a token already in use — the hash column is UNIQUE.
    const clash = await prisma.device.findUnique({
      where: { tokenHash },
      select: { id: true },
    });
    if (clash) return res.redirect('/devices?error=token_taken');

    const device = await prisma.device.create({
      data: {
        name: parsed.data.name.trim(),
        tokenHash,
        active: true,
        createdAtMs: BigInt(Date.now()),
      },
      select: { id: true, name: true },
    });

    // Audit records the event and the device — never the token or its hash.
    await audit(prisma, session.staffSyncId, 'create', 'device', String(device.id), {
      name: device.name,
    });

    res.redirect('/devices?created=1');
  });

  // ---- Audit log ----------------------------------------------------------

  app.get('/audit', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const logs = await prisma.auditLog.findMany({ orderBy: { atMs: 'desc' }, take: 200 });
    res.render('audit', {
      active: 'audit',
      session,
      logs: logs.map((l) => ({ ...l, atMs: Number(l.atMs) })),
    });
  });
}
