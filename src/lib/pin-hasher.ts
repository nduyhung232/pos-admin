/**
 * PIN hashing — MUST stay parameter-for-parameter identical to the Android
 * `auth/PinHasher.kt`, because a PIN set here is verified on the terminal offline.
 *
 * Mirrored parameters [FROM SOURCE: PinHasher.kt]:
 *   algorithm   PBKDF2 with HMAC-SHA256
 *   iterations  120_000
 *   key length  256 bits (32 bytes)
 *   salt        16 random bytes, per user
 *   encoding    Base64 (no wrap) for both hash and salt
 *
 * If any of these change on one side, sign-in breaks on the other. They are
 * pinned by a cross-check test (test/pin-hasher.test.mjs).
 *
 * SECURITY
 *  - The plaintext PIN is never stored, logged, or returned.
 *  - Verification uses timingSafeEqual to avoid leaking via response timing.
 *  - A PIN is low-entropy by nature; the slow KDF protects the stored credential
 *    but device-level control of the terminal is still required.
 */

import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** Kept in one place so the values are auditable and testable. */
export const PIN_KDF = {
  digest: 'sha256',
  iterations: 120_000,
  keyBytes: 32, // 256 bits
  saltBytes: 16,
} as const;

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

export interface PinCredential {
  /** Base64, no line wrapping. */
  pinHash: string;
  /** Base64, no line wrapping. */
  pinSalt: string;
}

/** Digits only, length within policy. Mirrors PinHasher.isPolicyValid. */
export function isPolicyValid(pin: string): boolean {
  return (
    pin.length >= MIN_PIN_LENGTH &&
    pin.length <= MAX_PIN_LENGTH &&
    /^[0-9]+$/.test(pin)
  );
}

async function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2Async(pin, salt, PIN_KDF.iterations, PIN_KDF.keyBytes, PIN_KDF.digest);
}

/** Derive a fresh credential with a new random salt. */
export async function createPin(pin: string): Promise<PinCredential> {
  if (!isPolicyValid(pin)) {
    throw new Error('PIN does not meet policy');
  }
  const salt = randomBytes(PIN_KDF.saltBytes);
  const hash = await derive(pin, salt);
  return {
    pinHash: hash.toString('base64'),
    pinSalt: salt.toString('base64'),
  };
}

/**
 * Verify a PIN against a stored credential.
 * Returns false on any decoding problem instead of throwing, so a corrupted row
 * denies access rather than crashing the service.
 */
export async function verifyPin(
  pin: string,
  pinHash: string,
  pinSalt: string,
): Promise<boolean> {
  try {
    const salt = Buffer.from(pinSalt, 'base64');
    const expected = Buffer.from(pinHash, 'base64');
    if (salt.length !== PIN_KDF.saltBytes || expected.length !== PIN_KDF.keyBytes) {
      return false;
    }
    const actual = await derive(pin, salt);
    return timingSafeEqual(expected, actual);
    } catch {
    return false;
  }
}
