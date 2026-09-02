import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRYPT, hashPassword, verifyPassword } from './password.js';

// The default cost is deliberately expensive, which is the point — but it makes tests
// slow. These use reduced parameters where the cost itself is not what is under test.
const FAST = { N: 2 ** 10, r: 8, p: 1, keyLength: 32 } as const;

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse', FAST);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('produces a different hash each time, so identical passwords are not identifiable', async () => {
    // Per-credential salt: two users with the same password must not share a hash,
    // or the store itself discloses that fact.
    const a = await hashPassword('same password', FAST);
    const b = await hashPassword('same password', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('carries its parameters, so cost can be raised without invalidating old hashes', async () => {
    const old = await hashPassword('secret', FAST);
    expect(old.startsWith('scrypt$1024$8$1$')).toBe(true);
    // Verified against the parameters it was created with, not today's defaults.
    expect(await verifyPassword('secret', old)).toBe(true);
    expect(DEFAULT_SCRYPT.N).toBeGreaterThan(FAST.N);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt credential must read as "authentication failed", not as a 500 that
    // tells the caller their account is special.
    for (const bad of ['', 'not-a-hash', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$aa$bb', 'scrypt$1024$8$1$$']) {
      expect(await verifyPassword('secret', bad), bad).toBe(false);
    }
  });

  it('refuses absurd parameters in a stored hash rather than exhausting memory', async () => {
    const hostile = `scrypt$${2 ** 25}$32$16$aaaa$bbbb`;
    expect(await verifyPassword('secret', hostile)).toBe(false);
  });
});
