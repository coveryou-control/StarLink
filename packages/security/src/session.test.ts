/**
 * Session and token tests.
 *
 * The headline case is revocation: FR-AUTH-2 requires it to be effective on the NEXT
 * request. A test that only checks "a valid cookie works" would pass against a design
 * where revocation silently does nothing for twelve hours.
 */
import { describe, expect, it } from 'vitest';
import type {
  HealthReport,
  IdentityAuthorizationClient,
  PrincipalClaims,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import { CursorCodec } from './cursor.js';
import { cookieOptionsFor, SessionService } from './session.js';
import { createSignedTokenCodec } from './signed-token.js';

/**
 * A local stub rather than the mock adapter.
 *
 * A domain package importing an adapter implementation is exactly the coupling the
 * boundary law forbids — and the law caught it when this test first tried. The stub
 * also keeps the test honest about what `SessionService` actually depends on: the
 * interface, not any particular identity source.
 */
class StubIdentity implements IdentityAuthorizationClient {
  private principals: Map<UUID, PrincipalClaims>;

  constructor(seed: readonly PrincipalClaims[]) {
    this.principals = new Map(seed.map((p) => [p.principalId, p]));
  }

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    const found = this.principals.get(principalId);
    if (found === undefined) {
      return err({
        code: 'PRINCIPAL_NOT_FOUND',
        message: 'no such principal',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'stub',
      });
    }
    return ok(found);
  }

  async verifyCredential(): Promise<Result<{ principalId: UUID }>> {
    return err({
      code: 'AUTH_FAILED',
      message: 'authentication failed',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: 'stub',
    });
  }

  async getSessionVersion(principalId: UUID): Promise<Result<number>> {
    const found = this.principals.get(principalId);
    if (found === undefined) {
      return err({
        code: 'PRINCIPAL_NOT_FOUND',
        message: 'no such principal',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'stub',
      });
    }
    return ok(found.sessionVersion);
  }

  async revokeSessions(principalId: UUID): Promise<Result<void>> {
    const found = this.principals.get(principalId);
    if (found !== undefined) {
      this.principals.set(principalId, { ...found, sessionVersion: found.sessionVersion + 1 });
    }
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}

const SECRET = 'a'.repeat(40);
const OTHER_SECRET = 'b'.repeat(40);
const PRINCIPAL_ID = '018f2c5a-2222-7000-8000-000000000001';

const claims = (over: Partial<PrincipalClaims> = {}): PrincipalClaims => ({
  principalId: PRINCIPAL_ID,
  employeeId: 'E-1',
  status: 'ACTIVE',
  displayName: 'Session Agent',
  roles: [],
  teams: [],
  department: 'Service',
  managerChain: [],
  skills: [],
  products: [],
  languages: [],
  delegations: [],
  privilegedCapabilities: [],
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  authority: 'TEMPORARY_AUTHORITY',
  sessionVersion: 1,
  ...over,
});

const service = (identity: StubIdentity, now?: () => Date) =>
  new SessionService({ secret: SECRET, identity, ...(now ? { now } : {}) });

describe('signed tokens', () => {
  it('round-trips a payload', () => {
    const codec = createSignedTokenCodec<{ a: number }>({ secret: SECRET, purpose: 'test' });
    const result = codec.verify(codec.sign({ a: 42 }));
    expect(result.valid && result.payload.a).toBe(42);
  });

  it('rejects a tampered payload', () => {
    const codec = createSignedTokenCodec<{ a: number }>({ secret: SECRET, purpose: 'test' });
    const token = codec.sign({ a: 42 });
    const forged = `${Buffer.from(JSON.stringify({ a: 999 })).toString('base64url')}.${token.split('.')[1]}`;
    expect(codec.verify(forged).valid).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const mint = createSignedTokenCodec<{ a: number }>({ secret: OTHER_SECRET, purpose: 'test' });
    const check = createSignedTokenCodec<{ a: number }>({ secret: SECRET, purpose: 'test' });
    expect(check.verify(mint.sign({ a: 1 })).valid).toBe(false);
  });

  it('rejects a token minted for a different purpose', () => {
    // Domain separation: a cursor must not be presentable as a session.
    const cursorish = createSignedTokenCodec<{ a: number }>({ secret: SECRET, purpose: 'cursor' });
    const sessionish = createSignedTokenCodec<{ a: number }>({ secret: SECRET, purpose: 'session' });
    expect(sessionish.verify(cursorish.sign({ a: 1 })).valid).toBe(false);
  });

  it('refuses to construct with a short secret', () => {
    expect(() => createSignedTokenCodec({ secret: 'too-short', purpose: 'test' })).toThrow();
  });
});

describe('session verification', () => {
  it('accepts a freshly issued employee session', async () => {
    const iam = new StubIdentity([claims()]);
    const svc = service(iam);
    const { token } = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });
    const result = await svc.verify(token, 'EMPLOYEE');
    expect(result.ok).toBe(true);
  });

  it('REVOKES on the next request when the version moves (FR-AUTH-2)', async () => {
    const iam = new StubIdentity([claims()]);
    const svc = service(iam);
    const { token } = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });

    expect((await svc.verify(token, 'EMPLOYEE')).ok).toBe(true);
    await iam.revokeSessions(PRINCIPAL_ID, 'admin revoked');

    const after = await svc.verify(token, 'EMPLOYEE');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('REVOKED');
  });

  it('refuses a deactivated principal even before any version bump', async () => {
    const iam = new StubIdentity([claims({ status: 'SUSPENDED' })]);
    const svc = service(iam);
    const { token } = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });
    const result = await svc.verify(token, 'EMPLOYEE');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PRINCIPAL_INACTIVE');
  });

  it('refuses an employee cookie presented to the customer surface', async () => {
    const iam = new StubIdentity([claims()]);
    const svc = service(iam);
    const { token } = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });
    const result = await svc.verify(token, 'CUSTOMER');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_SURFACE');
  });

  it('expires on the clock', async () => {
    const iam = new StubIdentity([claims()]);
    let clock = new Date('2026-08-25T10:00:00.000Z');
    const svc = new SessionService({ secret: SECRET, identity: iam, employeeTtlSeconds: 60, now: () => clock });
    const { token } = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });

    clock = new Date('2026-08-25T10:02:00.000Z');
    const result = await svc.verify(token, 'EMPLOYEE');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXPIRED');
  });

  it('never consults the identity store for a forged token', async () => {
    // Cheap checks first, so junk cookies cannot be used to hammer the identity store.
    let lookups = 0;
    const iam = new StubIdentity([claims()]);
    const counting = new Proxy(iam, {
      get(target, prop, receiver) {
        if (prop === 'resolvePrincipal') lookups += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const svc = service(counting as StubIdentity);
    await svc.verify('garbage.token', 'EMPLOYEE');
    expect(lookups).toBe(0);
  });

  it('gives customer sessions a shorter lifetime than employee sessions', async () => {
    const iam = new StubIdentity([claims()]);
    const svc = service(iam);
    const emp = svc.issue({ principalId: PRINCIPAL_ID, kind: 'EMPLOYEE', surface: 'EMPLOYEE', sessionVersion: 1 });
    const cus = svc.issue({ principalId: PRINCIPAL_ID, kind: 'CUSTOMER', surface: 'CUSTOMER', sessionVersion: 1, assurance: 'VERIFIED_CUSTOMER' });
    expect(Date.parse(cus.payload.expiresAt)).toBeLessThan(Date.parse(emp.payload.expiresAt));
  });
});

describe('paging cursors', () => {
  const conversationId = '018f2c5a-3333-7000-8000-000000000001';
  const other = '018f2c5a-3333-7000-8000-000000000002';

  it('round-trips within its conversation', () => {
    const codec = new CursorCodec(SECRET);
    const token = codec.encode({ createdAt: '2026-08-25T10:00:00.000Z', id: 'm-1', conversationId });
    const result = codec.decode(token, conversationId);
    expect(result.ok && result.cursor.id).toBe('m-1');
  });

  it('rejects an unsigned or tampered cursor', () => {
    // "An unsigned cursor is a client-supplied database query" (doc §38).
    const codec = new CursorCodec(SECRET);
    const handCrafted = Buffer.from(JSON.stringify({ createdAt: 'x', id: 'y', conversationId })).toString('base64url');
    expect(codec.decode(handCrafted, conversationId).ok).toBe(false);
    expect(codec.decode(`${handCrafted}.deadbeef`, conversationId).ok).toBe(false);
  });

  it('refuses a valid cursor replayed against a different conversation', () => {
    const codec = new CursorCodec(SECRET);
    const token = codec.encode({ createdAt: '2026-08-25T10:00:00.000Z', id: 'm-1', conversationId });
    const result = codec.decode(token, other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_CONVERSATION');
  });

  it('is not interchangeable with a session token even on the same secret', () => {
    const codec = new CursorCodec(SECRET);
    const sessionCodec = createSignedTokenCodec<Record<string, unknown>>({ secret: SECRET, purpose: 'session' });
    const cursor = codec.encode({ createdAt: '2026-08-25T10:00:00.000Z', id: 'm-1', conversationId });
    expect(sessionCodec.verify(cursor).valid).toBe(false);
  });
});

/**
 * The cookie lifetime regression (found by the browser suite, 2026-08-29).
 *
 * `cookieOptionsFor` is spread straight into Express's `res.cookie`, whose `maxAge` is
 * MILLISECONDS — while the HTTP `Max-Age` attribute it emits is seconds, and every caller
 * naturally has a seconds value to hand. The seconds were passed through unconverted, so
 * a 30-minute customer session expired after 1.8 seconds and a 12-hour employee session
 * after 43. Nothing failed: every request the integration suites make carries a
 * hand-built `Cookie` header, which has no expiry at all.
 *
 * These assertions are deliberately arithmetic rather than "is a positive number" — the
 * bug produced a perfectly positive number.
 */
describe('session cookie lifetime (§26.1, FR-AUTH-3)', () => {
  it('converts seconds to the milliseconds Express expects', () => {
    expect(cookieOptionsFor('CUSTOMER', false, 30 * 60).maxAge).toBe(30 * 60 * 1000);
    expect(cookieOptionsFor('EMPLOYEE', false, 12 * 60 * 60).maxAge).toBe(12 * 60 * 60 * 1000);
  });

  it('keeps a customer session usable for its full bounded life', () => {
    // The failure this pins: a 30-minute session that dies before the widget's 8-second
    // poll comes round even once.
    const { maxAge } = cookieOptionsFor('CUSTOMER', false, 30 * 60);
    expect(maxAge).toBeGreaterThan(8_000);
  });

  it('still clears the cookie when the lifetime is zero', () => {
    // Sign-out passes 0; multiplying must not turn that into something that lingers.
    expect(cookieOptionsFor('EMPLOYEE', false, 0).maxAge).toBe(0);
  });
});
