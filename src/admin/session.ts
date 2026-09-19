/**
 * Admin session handling for the merged Express app.
 *
 * DESIGN (unchanged intent from the Fastify original)
 *  - The browser session is an express-session cookie (httpOnly + sameSite=strict
 *    + secure in production). It stores only the manager's staffSyncId.
 *  - Every authorisation check RE-READS the staff row, so deactivating an account
 *    or demoting a manager takes effect immediately, not at cookie expiry. This
 *    is the property the original in-memory Map guaranteed and it is preserved.
 *  - Fail closed: any doubt denies access.
 *
 * TRADE-OFF, stated plainly: sessions live in express-session's default
 * MemoryStore, so a process restart signs every manager out. That is acceptable
 * for a single-shop deployment. If ever run as more than one process, move the
 * session store to SQLite/Redis, otherwise sessions vanish at random.
 */

import type { Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

export interface AdminSession {
  staffSyncId: string;
  name: string;
}

/** Store the signed-in manager on the session. */
export function setSessionStaff(req: Request, staffSyncId: string): void {
  (req.session as unknown as { staffSyncId?: string }).staffSyncId = staffSyncId;
}

export function clearSession(req: Request): void {
  // express-session: destroy drops the whole session server-side.
  req.session?.destroy?.(() => undefined);
}

function sessionStaffId(req: Request): string | null {
  const id = (req.session as unknown as { staffSyncId?: string } | undefined)?.staffSyncId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Require an active MANAGER session.
 *
 * Sends the reply itself and returns null on failure, so routes can do
 * `if (!session) return;`. Fails closed.
 *
 * `mode` controls the failure shape:
 *  - 'json' (default): 401/403 JSON — for /api/* and fetch callers.
 *  - 'redirect': 302 to /login — for server-rendered page routes.
 */
export async function requireManager(
  req: Request,
  res: Response,
  prisma: PrismaClient,
  mode: 'json' | 'redirect' = 'json',
): Promise<AdminSession | null> {
  const deny = (code: number, error: string) => {
    if (mode === 'redirect') {
      res.redirect('/login');
    } else {
      res.status(code).json({ error });
    }
    return null;
  };

  const staffSyncId = sessionStaffId(req);
  if (!staffSyncId) return deny(401, 'unauthorized');

  // Re-check the account on every request: a manager deactivated or demoted in
  // another tab must lose access at once, not when the cookie expires.
  const staff = await prisma.staff.findUnique({
    where: { syncId: staffSyncId },
    select: { syncId: true, name: true, role: true, active: true },
  });

  if (!staff || !staff.active || staff.role !== 'MANAGER') {
    clearSession(req);
    return deny(403, 'forbidden');
  }

  return { staffSyncId: staff.syncId, name: staff.name };
}
