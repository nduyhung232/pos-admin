/**
 * Seed the merged POS admin with a first manager and demo data.
 *
 * Idempotent: safe to run repeatedly. Creates:
 *   - manager "quanly" / PIN 1234   (PBKDF2, same params as Android)
 *   - a few products
 *   - one device "Quầy 1"           (token printed once, here in the console)
 *   - a couple of paid orders + one closed shift so the reports have data
 *
 * Run: npm run seed
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db.ts';
import { createPin } from '../src/lib/pin-hasher.ts';
import { hashDeviceToken } from '../src/lib/device-auth.ts';

/** Fixed demo token so the seeded terminal can be tested immediately. */
const DEMO_DEVICE_TOKEN = 'quay1-demo-token-123456';

async function seed() {
  const nowMs = Date.now();

  // ---- first manager -------------------------------------------------------
  let manager = await prisma.staff.findFirst({ where: { name: 'Quản lý' } });
  if (!manager) {
    const cred = await createPin('1234');
    manager = await prisma.staff.create({
      data: {
        syncId: randomUUID(),
        name: 'Quản lý',
        role: 'MANAGER',
        pinHash: cred.pinHash,
        pinSalt: cred.pinSalt,
        active: true,
        createdAtMs: BigInt(nowMs),
        updatedAtMs: BigInt(nowMs),
      },
    });
    console.log('Created manager "Quản lý" (PIN: 1234), syncId:', manager.syncId);
  } else {
    console.log('Manager already exists:', manager.syncId);
  }

  // ---- products ------------------------------------------------------------
  const products = [
    { name: 'Cà phê sữa', price: 30000, category: 'Cà phê' },
    { name: 'Cà phê đen', price: 25000, category: 'Cà phê' },
    { name: 'Trà đào', price: 35000, category: 'Trà' },
    { name: 'Trà sữa', price: 40000, category: 'Trà' },
  ];
  const productIds: { syncId: string; name: string; price: number }[] = [];
  for (const p of products) {
    let existing = await prisma.product.findFirst({ where: { name: p.name } });
    if (!existing) {
      existing = await prisma.product.create({
        data: {
          syncId: randomUUID(),
          name: p.name,
          price: p.price,
          category: p.category,
          active: true,
          createdAtMs: BigInt(nowMs),
          updatedAtMs: BigInt(nowMs),
        },
      });
    }
    productIds.push({ syncId: existing.syncId, name: existing.name, price: existing.price });
  }
  console.log('Products ready:', productIds.length);

  // ---- a device ------------------------------------------------------------
  let device = await prisma.device.findFirst({ where: { name: 'Quầy 1' } });
  if (!device) {
    device = await prisma.device.create({
      data: {
        name: 'Quầy 1',
        tokenHash: hashDeviceToken(DEMO_DEVICE_TOKEN),
        active: true,
        createdAtMs: BigInt(nowMs),
      },
    });
    console.log('Created device "Quầy 1"');
    console.log('  token (use this on the POS terminal):', DEMO_DEVICE_TOKEN);
  } else {
    console.log('Device already exists (id):', device.id);
  }

  // ---- one closed shift + a couple of orders (so reports have data) --------
  const shiftSyncId = randomUUID();
  const existingShift = await prisma.shift.findFirst({ where: { deviceId: device.id } });
  let shiftId: number | null = null;
  if (!existingShift) {
    const opened = nowMs - 6 * 60 * 60 * 1000;
    const created = await prisma.shift.create({
      data: {
        syncId: shiftSyncId,
        deviceId: device.id,
        openedAtMs: BigInt(opened),
        closedAtMs: BigInt(nowMs),
        openingCash: 500000,
        countedCash: 630000,
        expectedCash: 630000,
        cashDifference: 0,
        cashBreakdown: '500000x1;100000x1;50000x0;20000x1;10000x1',
        status: 'CLOSED',
        staffSyncId: manager.syncId,
        staffName: manager.name,
        closedByStaffSyncId: manager.syncId,
        receivedAtMs: BigInt(nowMs),
      },
    });
    shiftId = created.id;

    const demoOrders = [
      { items: [{ p: 0, q: 2 }], pay: 'CASH' as const },
      { items: [{ p: 2, q: 1 }, { p: 3, q: 1 }], pay: 'TRANSFER' as const },
    ];
    for (const d of demoOrders) {
      const lines = d.items.map((it) => ({
        product: productIds[it.p],
        quantity: it.q,
      }));
      const subtotal = lines.reduce((s, l) => s + l.product.price * l.quantity, 0);
      const order = await prisma.order.create({
        data: {
          syncId: randomUUID(),
          deviceId: device.id,
          subtotal,
          discountAmount: 0,
          total: subtotal,
          discountType: 'NONE',
          discountInput: 0,
          discountCode: null,
          orderType: 'DINE_IN',
          paymentMethod: d.pay,
          cashReceived: d.pay === 'CASH' ? subtotal : 0,
          changeAmount: 0,
          status: 'PAID',
          createdAtMs: BigInt(nowMs - 3 * 60 * 60 * 1000),
          shiftId,
          shiftSyncId,
          staffSyncId: manager.syncId,
          staffName: manager.name,
          receivedAtMs: BigInt(nowMs),
        },
      });
      for (const l of lines) {
        await prisma.orderItem.create({
          data: {
            syncId: randomUUID(),
            orderId: order.id,
            productSyncId: l.product.syncId,
            productName: l.product.name,
            unitPrice: l.product.price,
            quantity: l.quantity,
          },
        });
      }
    }
    console.log('Seeded 1 closed shift + 2 paid orders');
  } else {
    console.log('Shift/orders already seeded');
  }

  console.log('\nDone. Login at /login with manager "Quản lý" / PIN 1234');
  await prisma.$disconnect();
}

seed().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
