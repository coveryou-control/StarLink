/**
 * Credential hashing (doc §27.12).
 *
 * "A memory-hard password hash with per-credential salt. Never a general-purpose fast
 * hash." scrypt satisfies that and ships in node:crypto, so it costs no native
 * dependency — which matters because a native build step is the kind of friction that
 * later gets "temporarily" swapped for something fast and wrong.
 *
 * The encoded form carries its own parameters, so cost can be raised later without
 * invalidating existing credentials: an old hash still verifies against the parameters
 * it was created with.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParameters {
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

/** ~64 MB of memory per verification — deliberately expensive for an attacker. */
export const DEFAULT_SCRYPT: ScryptParameters = Object.freeze({ N: 2 ** 16, r: 8, p: 1, keyLength: 32 });

const maxmemFor = (p: ScryptParameters): number => 256 * p.N * p.r + 1024 * 1024;

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: maxmemFor(parameters),
  });
  return [
    'scrypt',
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against an encoded hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt stored credential
 * must read as "authentication failed", not as a 500 that tells the caller their
 * account is special.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Guard against a stored hash whose parameters would exhaust memory — a hostile or
  // corrupted row must not be able to take the process down.
  if (N > 2 ** 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: maxmemFor({ N, r, p, keyLength: expected.length }),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
