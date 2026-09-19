/**
 * Device authentication for the sync API.
 *
 * A POS terminal authenticates with a single bearer token. The token is chosen
 * by a manager in the web admin (no server-generated random token, no device id).
 *
 * DESIGN (simplified per requirement — "no complex token")
 *  - The manager types a token when registering a terminal. The terminal sends it
 *    as `Authorization: Bearer <token>` on every sync request. There is no
 *    `X-Device-Id` header anymore: the token alone identifies the terminal.
 *  - The server stores only a SHA-256 hash of the token, so a database leak does
 *    not reveal the token in plaintext. The hash is deterministic (no salt) on
 *    purpose: it lets the server look the token up directly via a UNIQUE index
 *    instead of trying every device row.
 *  - A minimum token length is enforced so a manager cannot pick a trivially
 *    guessable token.
 *
 * SECURITY TRADE-OFF (accepted): a deterministic SHA-256 of a user-chosen token
 * is weaker than the previous Argon2id-of-random-token scheme — it is offline
 * brute-forceable if the database leaks and the token is weak. This matches the
 * chosen "moderate security, runs over the internet" posture. For a stronger
 * posture: use long random tokens and/or terminate TLS in front of this service,
 * and get an independent security review.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';

/** Minimum length for a manager-chosen device token. */
export const MIN_TOKEN_LENGTH = 12;

export interface AuthenticatedDevice {
  id: number;
  name: string;
}

/** True when a manager-chosen token meets the basic length policy. */
export function isTokenPolicyValid(token: string): boolean {
  return typeof token === 'string' && token.trim().length >= MIN_TOKEN_LENGTH;
}

/**
 * Deterministic SHA-256 (hex) of the token. Deterministic so the token can be
 * used as the sole lookup key via a UNIQUE index. Never store the plaintext.
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

/** Extract a bearer token, or null when the header is absent/malformed. */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Authenticate the calling terminal by its bearer token alone.
 *
 * On failure this sends the reply itself and returns null, so a route can simply
 * `if (!device) return;`. Failures are deliberately indistinguishable (same
 * status, same body) so the endpoint does not reveal whether a token exists.
 */
export async function requireDevice(
  req: Request,
  res: Response,
  prisma: PrismaClient,
): Promise<AuthenticatedDevice | null> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  const tokenHash = hashDeviceToken(token);
  const device = await prisma.device.findUnique({
    where: { tokenHash },
    select: { id: true, name: true, active: true },
  });

  // Same response for unknown token and inactive device.
  if (!device || !device.active) {
    // Log the attempt (never the token) so repeated failures are visible.
    req.log?.warn?.({}, 'device authentication failed');
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  return { id: device.id, name: device.name };
}
