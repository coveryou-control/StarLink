import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalRef, UUID, VerificationMethod } from '@starlink/shared-contracts';

import { LocalOtpIdentity, type CustomerLookup, type OtpSender } from './otp-identity.js';

const KNOWN_MOBILE = '+919999900001';
const UNKNOWN_MOBILE = '+919999900002';
const KNOWN_EMAIL = 'known@example.test';
const CUSTOMER_REF: CanonicalRef = { system: 'CCS', type: 'customer', id: 'c-1' };

class CapturingSender implements OtpSender {
  readonly sent: { method: VerificationMethod; destination: string; code: string }[] = [];
  async send(method: VerificationMethod, destination: string, code: string): Promise<void> {
    this.sent.push({ method, destination, code });
  }
  get lastCode(): string {
    return this.sent.at(-1)?.code ?? '';
  }
}

class StubLookup implements CustomerLookup {
  async byContact(_method: VerificationMethod, destination: string): Promise<CanonicalRef | null> {
    if (destination === KNOWN_MOBILE || destination === KNOWN_EMAIL) return CUSTOMER_REF;
    return null;
  }
}

let sender: CapturingSender;
let clock: number;
let counter: number;
let identity: LocalOtpIdentity;

const build = (overrides: Partial<ConstructorParameters<typeof LocalOtpIdentity>[0]> = {}): void => {
  identity = new LocalOtpIdentity({
    secret: 'x'.repeat(40),
    sender,
    lookup: new StubLookup(),
    now: () => clock,
    newId: () => {
      counter += 1;
      return `018f2c5a-0000-7000-8000-${String(counter).padStart(12, '0')}` as UUID;
    },
    ...overrides,
  });
};

beforeEach(() => {
  sender = new CapturingSender();
  clock = Date.parse('2026-08-25T10:00:00.000Z');
  counter = 0;
  build();
});

async function verifiedSession(mobile = KNOWN_MOBILE): Promise<{ sessionId: UUID; code: string }> {
  const created = await identity.createSession('WEBSITE', { mobile });
  if (!created.ok) throw new Error('createSession failed');
  const sessionId = created.value.sessionId;
  const begun = await identity.beginVerification(sessionId, 'OTP_MOBILE');
  if (!begun.ok) throw new Error('beginVerification failed');
  return { sessionId, code: sender.lastCode };
}

describe('session creation', () => {
  it('starts every session at the bottom of the assurance ladder', async () => {
    // Even when the caller supplies a policy number and a mobile. Hints are a delivery
    // address, never evidence — assurance moves only when a code comes back.
    const created = await identity.createSession('WEBSITE', {
      mobile: KNOWN_MOBILE,
      policyNumber: 'P-12345',
    });

    expect(created.ok && created.value.assurance).toBe('ANONYMOUS');
    expect(created.ok && created.value.customerRef).toBeUndefined();
    expect(created.ok && created.value.verifiedAt).toBeUndefined();
  });

  it('expires from the clock, with no sweep required', async () => {
    const created = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
    const sessionId = created.ok ? created.value.sessionId : ('' as UUID);

    clock += 31 * 60 * 1000;

    expect((await identity.beginVerification(sessionId, 'OTP_MOBILE')).ok).toBe(false);
  });
});

describe('challenge issuance', () => {
  it('sends a code out of band and never returns it', async () => {
    const created = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
    const sessionId = created.ok ? created.value.sessionId : ('' as UUID);

    const begun = await identity.beginVerification(sessionId, 'OTP_MOBILE');

    expect(begun.ok).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.destination).toBe(KNOWN_MOBILE);
    // The response must not carry the code by any route.
    expect(JSON.stringify(begun)).not.toContain(sender.lastCode);
  });

  it('behaves identically for a known and an unknown contact', async () => {
    // Otherwise this is a customer-enumeration oracle: "is this mobile one of yours?"
    const known = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
    const unknown = await identity.createSession('WEBSITE', { mobile: UNKNOWN_MOBILE });

    const a = await identity.beginVerification(
      known.ok ? known.value.sessionId : ('' as UUID),
      'OTP_MOBILE',
    );
    const b = await identity.beginVerification(
      unknown.ok ? unknown.value.sessionId : ('' as UUID),
      'OTP_MOBILE',
    );

    expect(a.ok).toBe(b.ok);
    expect(a.ok && b.ok && a.value.attemptsRemaining).toBe(b.ok ? b.value.attemptsRemaining : -1);
  });

  it('never delivers a code to a channel the method did not name', async () => {
    // An email OTP falling back to the mobile hint would send a credential to an
    // address the caller chose rather than the one the method names.
    const created = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
    const sessionId = created.ok ? created.value.sessionId : ('' as UUID);

    const begun = await identity.beginVerification(sessionId, 'OTP_EMAIL');

    expect(begun.ok).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it('refuses portal and policy-lookup methods rather than approximating them', async () => {
    const created = await identity.createSession('WEBSITE', { policyNumber: 'P-1' });
    const sessionId = created.ok ? created.value.sessionId : ('' as UUID);

    expect((await identity.beginVerification(sessionId, 'POLICY_LOOKUP')).ok).toBe(false);
    expect((await identity.beginVerification(sessionId, 'AUTH_PORTAL')).ok).toBe(false);
  });

  it('generates codes of the configured length, drawn from a CSPRNG', async () => {
    for (let i = 0; i < 40; i += 1) {
      const created = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
      await identity.beginVerification(created.ok ? created.value.sessionId : ('' as UUID), 'OTP_MOBILE');
    }

    expect(sender.sent.every((s) => /^\d{6}$/.test(s.code))).toBe(true);
    // A constant or trivially-sequential generator would collapse this set.
    expect(new Set(sender.sent.map((s) => s.code)).size).toBeGreaterThan(30);
  });
});

describe('verification', () => {
  it('raises assurance to VERIFIED_CUSTOMER and binds the customer reference', async () => {
    const { sessionId, code } = await verifiedSession();

    const completed = await identity.completeVerification(sessionId, challengeIdOf(1), code);

    expect(completed.ok && completed.value.assurance).toBe('VERIFIED_CUSTOMER');
    expect(completed.ok && completed.value.customerRef).toEqual(CUSTOMER_REF);
    expect(completed.ok && completed.value.verifiedAt).toBe(new Date(clock).toISOString());
  });

  it('raises a proven-but-unknown contact to PSEUDONYMOUS, not VERIFIED_CUSTOMER', async () => {
    // They proved control of the number. They are no longer anonymous — but they are
    // not a known customer either, and treating them as one would over-grant.
    const { sessionId, code } = await verifiedSession(UNKNOWN_MOBILE);

    const completed = await identity.completeVerification(sessionId, challengeIdOf(1), code);

    expect(completed.ok && completed.value.assurance).toBe('PSEUDONYMOUS');
    expect(completed.ok && completed.value.customerRef).toBeUndefined();
  });

  it('refuses a wrong code', async () => {
    const { sessionId, code } = await verifiedSession();
    const wrong = code === '000000' ? '111111' : '000000';

    expect((await identity.completeVerification(sessionId, challengeIdOf(1), wrong)).ok).toBe(false);
  });

  it('burns the challenge after the attempt cap, even if the right code follows', async () => {
    // Without this, a 6-digit code is a few minutes of brute force.
    const { sessionId, code } = await verifiedSession();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      await identity.completeVerification(sessionId, challengeIdOf(1), wrong);
    }

    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(false);
  });

  it('counts a failed attempt even against a code of the wrong length', async () => {
    const { sessionId, code } = await verifiedSession();

    for (let i = 0; i < 5; i += 1) {
      await identity.completeVerification(sessionId, challengeIdOf(1), 'short');
    }

    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(false);
  });

  it('makes a code single-use', async () => {
    const { sessionId, code } = await verifiedSession();
    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(true);

    // A replay must find nothing.
    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(false);
  });

  it('refuses an expired challenge', async () => {
    const { sessionId, code } = await verifiedSession();

    clock += 6 * 60 * 1000;

    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(false);
  });

  it('refuses another session redeeming this session’s challenge', async () => {
    // The challenge id is not a bearer token. Without this binding, observing one id
    // would let an unrelated session claim the verification.
    const { code } = await verifiedSession();
    const other = await identity.createSession('WEBSITE', { mobile: KNOWN_MOBILE });
    const otherId = other.ok ? other.value.sessionId : ('' as UUID);

    expect((await identity.completeVerification(otherId, challengeIdOf(1), code)).ok).toBe(false);
  });

  it('returns one indistinguishable refusal for every failure reason', async () => {
    const { sessionId, code } = await verifiedSession();
    const wrong = code === '000000' ? '111111' : '000000';

    const unknownChallenge = await identity.completeVerification(sessionId, challengeIdOf(99), code);
    const wrongCode = await identity.completeVerification(sessionId, challengeIdOf(1), wrong);
    const unknownSession = await identity.completeVerification(challengeIdOf(99), challengeIdOf(1), code);

    const shapes = [unknownChallenge, wrongCode, unknownSession].map((r) =>
      r.ok ? 'ok' : `${r.error.code}|${r.error.message}|${r.error.failureClass}`,
    );
    expect(new Set(shapes).size).toBe(1);
  });
});

describe('resolveCustomer and invalidate', () => {
  it('resolves nothing before verification', async () => {
    const { sessionId } = await verifiedSession();
    const resolved = await identity.resolveCustomer(sessionId);
    expect(resolved.ok && resolved.value).toBeNull();
  });

  it('resolves the reference after verification', async () => {
    const { sessionId, code } = await verifiedSession();
    await identity.completeVerification(sessionId, challengeIdOf(1), code);

    const resolved = await identity.resolveCustomer(sessionId);

    expect(resolved.ok && resolved.value?.customerRef).toEqual(CUSTOMER_REF);
    expect(resolved.ok && resolved.value?.assurance).toBe('VERIFIED_CUSTOMER');
  });

  it('drops the session’s outstanding challenges on invalidate', async () => {
    // A challenge outliving its session is a code still redeemable against something
    // that no longer exists.
    const { sessionId, code } = await verifiedSession();
    await identity.invalidate(sessionId);

    expect((await identity.completeVerification(sessionId, challengeIdOf(1), code)).ok).toBe(false);
    expect((await identity.resolveCustomer(sessionId)).ok).toBe(true);
  });

  it('reports itself as interim authority, never as the customer master', async () => {
    const health = await identity.health();
    expect(health.authority).toBe('TEMPORARY_AUTHORITY');
  });
});

/** Ids are deterministic in these tests: session 1, challenge 2, and so on. */
function challengeIdOf(n: number): UUID {
  return `018f2c5a-0000-7000-8000-${String(n + 1).padStart(12, '0')}` as UUID;
}
