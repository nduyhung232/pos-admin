/**
 * PIN hasher tests.
 *
 * The critical property is CROSS-PLATFORM AGREEMENT: a PIN set in the web admin
 * must verify on the Android terminal offline. PBKDF2-HMAC-SHA256 is a fully
 * specified standard (RFC 8018), so if both sides use the same parameters they
 * produce identical bytes.
 *
 * Run: node --experimental-strip-types --test test/pin-hasher.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';

import {
  createPin,
  verifyPin,
  isPolicyValid,
  PIN_KDF,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH,
} from '../src/lib/pin-hasher.ts';

// ---- parameters must not drift from the Android side ------------------------

test('KDF parameters match the Android PinHasher exactly', () => {
  // [FROM SOURCE: app/src/main/java/com/example/sunmipostester/auth/PinHasher.kt]
  assert.equal(PIN_KDF.digest, 'sha256', 'algorithm must be PBKDF2WithHmacSHA256');
  assert.equal(PIN_KDF.iterations, 120_000, 'iterations must be 120_000');
  assert.equal(PIN_KDF.keyBytes, 32, 'key length must be 256 bits');
  assert.equal(PIN_KDF.saltBytes, 16, 'salt must be 16 bytes');
  assert.equal(MIN_PIN_LENGTH, 4);
  assert.equal(MAX_PIN_LENGTH, 8);
});

test('known-answer: derivation is the plain PBKDF2 standard, no custom steps', () => {
  // If someone adds a pepper, a prefix, or a second round, this fails — and
  // sign-in on the terminal would silently break for every user.
  const pin = '1234';
  const salt = Buffer.alloc(PIN_KDF.saltBytes, 0x2a); // fixed salt, reproducible
  const expected = pbkdf2Sync(
    pin,
    salt,
    PIN_KDF.iterations,
    PIN_KDF.keyBytes,
    PIN_KDF.digest,
  ).toString('base64');

  // Verify through the public API using that same fixed salt.
  return verifyPin(pin, expected, salt.toString('base64')).then((ok) => {
    assert.ok(ok, 'verifyPin must accept a hash produced by standard PBKDF2');
  });
});

// ---- round trip ------------------------------------------------------------

test('a created PIN verifies', async () => {
  const cred = await createPin('4821');
  assert.ok(await verifyPin('4821', cred.pinHash, cred.pinSalt));
});

test('a wrong PIN does not verify', async () => {
  const cred = await createPin('4821');
  assert.equal(await verifyPin('4822', cred.pinHash, cred.pinSalt), false);
  assert.equal(await verifyPin('', cred.pinHash, cred.pinSalt), false);
  assert.equal(await verifyPin('48210', cred.pinHash, cred.pinSalt), false);
});

test('salt is unique per credential, so identical PINs hash differently', async () => {
  const a = await createPin('1234');
  const b = await createPin('1234');
  assert.notEqual(a.pinSalt, b.pinSalt, 'each credential needs its own salt');
  assert.notEqual(a.pinHash, b.pinHash, 'same PIN must not produce the same hash');
});

test('hash and salt are base64 of the expected byte lengths', async () => {
  const cred = await createPin('1234');
  assert.equal(Buffer.from(cred.pinSalt, 'base64').length, PIN_KDF.saltBytes);
  assert.equal(Buffer.from(cred.pinHash, 'base64').length, PIN_KDF.keyBytes);
  // No line wrapping — Android decodes with Base64.NO_WRAP.
  assert.ok(!cred.pinHash.includes('\n'));
  assert.ok(!cred.pinSalt.includes('\n'));
});

// ---- failure handling ------------------------------------------------------

test('corrupted stored credential denies access instead of throwing', async () => {
  assert.equal(await verifyPin('1234', 'not-base64!!', 'also-bad!!'), false);
  assert.equal(await verifyPin('1234', '', ''), false);
  // Right encoding, wrong lengths.
  assert.equal(
    await verifyPin('1234', Buffer.alloc(8).toString('base64'), Buffer.alloc(4).toString('base64')),
    false,
  );
});

test('createPin refuses a PIN that fails policy', async () => {
  await assert.rejects(() => createPin('123'), /policy/);
  await assert.rejects(() => createPin('12a4'), /policy/);
  await assert.rejects(() => createPin('123456789'), /policy/);
});

// ---- policy ---------------------------------------------------------------

test('policy accepts 4..8 digits only', () => {
  assert.ok(isPolicyValid('1234'));
  assert.ok(isPolicyValid('12345678'));
  assert.ok(!isPolicyValid('123'), 'too short');
  assert.ok(!isPolicyValid('123456789'), 'too long');
  assert.ok(!isPolicyValid('12 4'), 'space is not a digit');
  assert.ok(!isPolicyValid('12a4'), 'letters rejected');
  assert.ok(!isPolicyValid(''), 'empty rejected');
  assert.ok(!isPolicyValid('١٢٣٤'), 'non-ASCII digits rejected');
});
