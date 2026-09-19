/**
 * Merged POS admin — single Express entry point.
 *
 * Two audiences on one process (like the original, minus the second project):
 *   /api/sync/*   POS terminals, authenticated by device bearer token (unchanged)
 *   everything else  the web admin, server-rendered EJS, manager session cookie
 *
 * This mirrors the sales_web shape: one `node server.ts`, EJS views, a session
 * cookie, self-contained SQLite. The financial logic and the Android sync
 * contract are preserved from pos-admin.
 */

import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.ts';
import { prisma } from './db.ts';
import { registerSyncRoutes } from './sync/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const app = express();
app.set('trust proxy', 1);

// Minimal request logger shim so lib/ modules can call req.log?.warn/error.
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: typeof console.warn; error: typeof console.error } }).log = {
    warn: (...a: unknown[]) => console.warn(...a),
    error: (...a: unknown[]) => console.error(...a),
  };
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// The sync API is JSON; the admin pages are form posts. Support both.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: config.sessionTtlMs,
    },
  }),
);

app.get('/health', (_req, res) => res.json({ status: 'ok', timeMs: Date.now() }));

// POS terminals (device-token auth). Contract identical to pos-admin.
registerSyncRoutes(app, prisma);

// Web admin (manager session, server-rendered).
registerAdminRoutes(app, prisma, config);

async function ensureDefaultAdmin() {
  try {
    const existing = await prisma.staff.findFirst({ where: { name: 'admin' } });
    if (!existing) {
      const nowMs = Date.now();
      await prisma.staff.create({
        data: {
          syncId: '00000000-0000-0000-0000-000000000001',
          name: 'admin',
          role: 'MANAGER',
          pinHash: 'd2wU33qAewnhkWsrmYw5Bmu5FntgyQBg3Lzv4Rm57r4=',
          pinSalt: 'bBelY1WiXT3ad21r9ltI0Q==',
          active: true,
          createdAtMs: BigInt(nowMs),
          updatedAtMs: BigInt(nowMs),
        },
      });
      console.log('Default manager "admin" (password: hung1234) ready.');
    }
  } catch (err) {
    console.error('Failed to ensure default admin account:', err);
  }
}

app.listen(config.port, config.host, async () => {
  console.log(`POS Admin (merged) running at http://localhost:${config.port}`);
  await ensureDefaultAdmin();
});

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down`);
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
