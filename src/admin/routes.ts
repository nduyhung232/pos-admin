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

/** Start-of-day / end-of-day helpers for the report date inputs (local time). */
function dayRangeMs(fromDate: string, toDate: string): { fromMs: number; toMs: number } {
  const fromMs = new Date(`${fromDate}T00:00:00`).getTime();
  const toMs = new Date(`${toDate}T23:59:59.999`).getTime();
  return { fromMs, toMs };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`;
}

export function registerAdminRoutes(app: Express, prisma: PrismaClient, config: Config): void {
  // ---- Auth ----------------------------------------------------------------

  app.get('/login', async (_req: Request, res: Response) => {
    const managers = await prisma.staff.findMany({
      where: { active: true, role: 'MANAGER' },
      select: { syncId: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.render('login', { managers, error: null });
  });

  app.post('/login', async (req: Request, res: Response) => {
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
      res.status(401).render('login', { managers, error: 'Sai thông tin đăng nhập' });
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

    setSessionStaff(req, staff.syncId);
    await audit(prisma, staff.syncId, 'login', 'staff', staff.syncId);
    res.redirect('/reports');
  });

  app.post('/logout', (req: Request, res: Response) => {
    clearSession(req);
    res.redirect('/login');
  });
  // GET convenience for the sidebar link.
  app.get('/logout', (req: Request, res: Response) => {
    clearSession(req);
    res.redirect('/login');
  });

  app.get('/', (_req: Request, res: Response) => res.redirect('/reports'));

  // ---- Revenue report (home) ----------------------------------------------

  app.get('/reports', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const fromDate = (req.query.from as string) || monthStartStr();
    const toDate = (req.query.to as string) || todayStr();
    const { fromMs, toMs } = dayRangeMs(fromDate, toDate);

    const range = {
      status: 'PAID' as const,
      createdAtMs: { gte: BigInt(fromMs), lte: BigInt(toMs) },
    };

    const byMethod = await prisma.order.groupBy({
      by: ['paymentMethod'],
      where: range,
      _sum: { total: true },
      _count: { _all: true },
    });

    const totalRevenue = byMethod.reduce((sum, m) => sum + (m._sum.total ?? 0), 0);
    const totalOrders = byMethod.reduce((sum, m) => sum + m._count._all, 0);

    const topRaw = await prisma.orderItem.groupBy({
      by: ['productName'],
      where: { order: range },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 10,
    });

    const topProducts = await Promise.all(
      topRaw.map(async (t) => {
        const rows = await prisma.orderItem.findMany({
          where: { productName: t.productName, order: range },
          select: { unitPrice: true, quantity: true },
        });
        return {
          productName: t.productName,
          quantity: t._sum.quantity ?? 0,
          revenue: rows.reduce((s, r) => s + r.unitPrice * r.quantity, 0),
        };
      }),
    );

    res.render('reports', {
      active: 'reports',
      session,
      fromDate,
      toDate,
      totalRevenue,
      totalOrders,
      // Division goes through the shared Money rule (HALF_UP), same as the POS.
      averageOrderValue: average(totalRevenue, totalOrders),
      byMethod: byMethod.map((m) => ({
        paymentMethod: m.paymentMethod,
        orderCount: m._count._all,
        revenue: m._sum.total ?? 0,
      })),
      topProducts,
    });
  });

  // ---- Products ------------------------------------------------------------

  app.get('/products', async (req: Request, res: Response) => {
    const session = await requireManager(req, res, prisma, 'redirect');
    if (!session) return;

    const products = await prisma.product.findMany({
      orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
      select: { syncId: true, name: true, price: true, category: true, active: true },
    });
    res.render('products', {
      active: 'products',
      session,
      products,
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

    const fromDate = (req.query.from as string) || monthStartStr();
    const toDate = (req.query.to as string) || todayStr();
    const { fromMs, toMs } = dayRangeMs(fromDate, toDate);

    const where = {
      createdAtMs: { gte: BigInt(fromMs), lte: BigInt(toMs) },
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAtMs: 'desc' },
        take: 200,
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

    res.render('orders', {
      active: 'orders',
      session,
      fromDate,
      toDate,
      total,
      orders: orders.map((o) => ({
        ...o,
        createdAtMs: Number(o.createdAtMs),
        deviceName: o.device.name,
      })),
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
