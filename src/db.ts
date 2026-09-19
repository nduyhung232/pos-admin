/**
 * Single Prisma client for the merged app.
 *
 * DATABASE_URL defaults to a local SQLite file so the app is self-contained like
 * sales_web. Set DATABASE_URL in the environment to point elsewhere.
 */

import { PrismaClient } from '@prisma/client';

// Default to a local SQLite file if not configured. Prisma reads DATABASE_URL
// from the environment, so set it before the client is constructed.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL = 'file:./data/pos.db';
}

export const prisma = new PrismaClient();
