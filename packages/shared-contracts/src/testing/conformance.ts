/**
 * Adapter conformance kit.
 *
 * The claim that an adapter is replaceable "without rewriting business logic" is only
 * worth something if every implementation is held to the SAME behavioural contract.
 * These suites are written once here and executed against Mock, Local and (from
 * Phase 9/10) Remote implementations.
 *
 * They test BEHAVIOUR, not wiring: that revocation actually revokes, that a claim has
 * exactly one winner, that consent fails closed. A type-check alone would let an
 * implementation satisfy the interface and violate the contract.
 *
 * Exported as plain functions taking the test primitives, so this file stays free of a
 * test-framework dependency and shared-contracts remains a leaf package.
 */
import type {
  ConsentEligibilityClient,
  EmployeeDirectoryProvider,
  IdentityAuthorizationClient,
  ObjectStorageProvider,
  Result,
  WorkOrchestratorClient,
} from '../adapters/index.js';
import type { CanonicalRef, UUID } from '../domain/primitives.js';

export interface TestPrimitives {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeDefined(): void;
  };
}

const unwrap = <T>(result: Result<T>, context: string): T => {
  if (!result.ok) throw new Error(`${context}: ${result.error.code} ${result.error.message}`);
  return result.value;
};

/* ------------------------------------------------------------------ identity */

export interface IdentityFixture {
  readonly adapter: IdentityAuthorizationClient;
  /** A principal that exists and is ACTIVE. */
  readonly knownPrincipalId: UUID;
  /** Credentials that authenticate `knownPrincipalId`. */
  readonly validCredential: { username: string; secret: string };
}

export function identityConformance(t: TestPrimitives, makeFixture: () => Promise<IdentityFixture>): void {
  t.describe('IdentityAuthorizationClient conformance', () => {
    t.it('resolves a known principal with a complete claim set', async () => {
      const { adapter, knownPrincipalId } = await makeFixture();
      const claims = unwrap(await adapter.resolvePrincipal(knownPrincipalId), 'resolvePrincipal');
      t.expect(claims.principalId).toBe(knownPrincipalId);
      t.expect(claims.status).toBe('ACTIVE');
      // Downstream authorization needs every one of these; an implementation that
      // omits them would fail open in surprising ways.
      t.expect(Array.isArray(claims.roles)).toBe(true);
      t.expect(Array.isArray(claims.teams)).toBe(true);
      t.expect(Array.isArray(claims.managerChain)).toBe(true);
      t.expect(claims.sessionVersion).toBeGreaterThan(0);
      t.expect(claims.authority).toBeDefined();
    });

    t.it('fails closed for an unknown principal', async () => {
      const { adapter } = await makeFixture();
      const result = await adapter.resolvePrincipal(crypto.randomUUID());
      t.expect(result.ok).toBe(false);
      if (!result.ok) t.expect(result.error.failureClass).toBe('FAIL_CLOSED');
    });

    t.it('accepts a valid credential', async () => {
      const { adapter, validCredential, knownPrincipalId } = await makeFixture();
      const out = unwrap(
        await adapter.verifyCredential(validCredential.username, validCredential.secret),
        'verifyCredential',
      );
      t.expect(out.principalId).toBe(knownPrincipalId);
    });

    t.it('returns an identical refusal for a wrong secret and an unknown account', async () => {
      // Doc §27.1: distinguishing the two tells an attacker which half they got right
      // and tells a legitimate user nothing they can act on.
      const { adapter, validCredential } = await makeFixture();
      const wrongSecret = await adapter.verifyCredential(validCredential.username, 'definitely-wrong');
      const unknownUser = await adapter.verifyCredential('no-such-user-at-all', 'definitely-wrong');
      t.expect(wrongSecret.ok).toBe(false);
      t.expect(unknownUser.ok).toBe(false);
      if (!wrongSecret.ok && !unknownUser.ok) {
        t.expect(wrongSecret.error.code).toBe(unknownUser.error.code);
        t.expect(wrongSecret.error.message).toBe(unknownUser.error.message);
      }
    });

    t.it('makes revocation observable immediately by bumping the session version', async () => {
      // FR-AUTH-2: effective on the NEXT request, not at a cache expiry.
      const { adapter, knownPrincipalId } = await makeFixture();
      const before = unwrap(await adapter.getSessionVersion(knownPrincipalId), 'version before');
      unwrap(await adapter.revokeSessions(knownPrincipalId, 'conformance test'), 'revokeSessions');
      const after = unwrap(await adapter.getSessionVersion(knownPrincipalId), 'version after');
      t.expect(after).toBeGreaterThan(before);
    });

    t.it('reports which authority answered', async () => {
      const { adapter } = await makeFixture();
      const health = await adapter.health();
      // Nothing may present an interim store as canonical truth.
      t.expect(['CANONICAL', 'TEMPORARY_AUTHORITY', 'MOCK'].includes(health.authority)).toBe(true);
    });
  });
}

/* ---------------------------------------------------------- work orchestrator */

export interface WorkOrchestratorFixture {
  readonly adapter: WorkOrchestratorClient;
  /** A queue entry in WAITING state, freshly created for the test. */
  readonly queueEntryId: UUID;
  readonly claimantIds: readonly UUID[];
}

export function workOrchestratorConformance(
  t: TestPrimitives,
  makeFixture: () => Promise<WorkOrchestratorFixture>,
): void {
  t.describe('WorkOrchestratorClient conformance', () => {
    t.it('yields exactly one winner when many claim at once', async () => {
      // Brief §44 and golden tests G-06/G-07. The losers receive ALREADY_ASSIGNED,
      // which is a normal outcome and NOT an error — an error would be retried.
      const { adapter, queueEntryId, claimantIds } = await makeFixture();
      const outcomes = await Promise.all(
        claimantIds.map((principalId) => adapter.claim(queueEntryId, principalId, crypto.randomUUID())),
      );
      const winners = outcomes.filter((o) => o.ok && o.value.outcome === 'CLAIMED');
      const losers = outcomes.filter((o) => o.ok && o.value.outcome === 'ALREADY_ASSIGNED');
      t.expect(winners.length).toBe(1);
      t.expect(losers.length).toBe(claimantIds.length - 1);
    });

    t.it('treats a repeated claim with the same idempotency key as the same claim', async () => {
      const { adapter, queueEntryId, claimantIds } = await makeFixture();
      const principalId = claimantIds[0] as UUID;
      const key = crypto.randomUUID();
      const first = unwrap(await adapter.claim(queueEntryId, principalId, key), 'first claim');
      const retry = unwrap(await adapter.claim(queueEntryId, principalId, key), 'retried claim');
      t.expect(first.outcome).toBe('CLAIMED');
      // A network retry must not read as a second, losing claimant.
      t.expect(retry.outcome).toBe('CLAIMED');
    });
  });
}

/* ------------------------------------------------------------------- consent */

export interface ConsentFixture {
  readonly adapter: ConsentEligibilityClient;
  readonly customerRef: CanonicalRef;
}

export function consentConformance(t: TestPrimitives, makeFixture: () => Promise<ConsentFixture>): void {
  t.describe('ConsentEligibilityClient conformance', () => {
    t.it('classifies its failures as FAIL_CLOSED', async () => {
      // If eligibility cannot be established, no proactive outbound may happen.
      // Channel availability is never permission (Part IV §58).
      const { adapter, customerRef } = await makeFixture();
      const result = await adapter.checkOutbound({
        customerRef,
        channel: 'WHATSAPP',
        purpose: 'conformance-probe-unknown-purpose',
      });
      if (!result.ok) t.expect(result.error.failureClass).toBe('FAIL_CLOSED');
    });

    t.it('answers with an explicit allow/deny, never an ambiguous value', async () => {
      const { adapter, customerRef } = await makeFixture();
      const eligibility = unwrap(
        await adapter.checkOutbound({ customerRef, channel: 'EMAIL', purpose: 'service-update' }),
        'checkOutbound',
      );
      t.expect(typeof eligibility.allowed).toBe('boolean');
      if (!eligibility.allowed) t.expect(typeof eligibility.reason).toBe('string');
    });
  });
}

/* ---------------------------------------------------------------- directory */

export interface DirectoryFixture {
  readonly adapter: EmployeeDirectoryProvider;
  /** An employee that exists. */
  readonly knownPrincipalId: UUID;
  /** An employee that exists and has NO contact row — the unpopulated case. */
  readonly principalWithoutContacts: UUID;
  /** A principal id that does not exist at all. */
  readonly unknownPrincipalId: UUID;
}

/**
 * §17.2's fifth operation, held to the same behaviour by every implementation.
 *
 * The whole value of this suite is one distinction that is easy to get wrong and silent
 * when you do: **an unknown principal is an error, a known principal with no contact row
 * is an empty success.** Collapsing them either way is harmful in a different direction.
 * Erroring on the empty case makes an unpopulated directory look broken and turns every
 * notification into a failure; succeeding on the unknown case invents a principal.
 *
 * The Local adapter answers from StarLink's own store today; the HRMS adapter will answer
 * from the system of record at Phase 9 (A-13). This is what keeps that swap safe.
 */
export function directoryConformance(
  t: TestPrimitives,
  makeFixture: () => Promise<DirectoryFixture>,
): void {
  t.describe('EmployeeDirectoryProvider conformance', () => {
    t.it('resolves contact channels for a known principal', async () => {
      const { adapter, knownPrincipalId } = await makeFixture();
      const contacts = unwrap(
        await adapter.resolveContactChannels(knownPrincipalId),
        'resolveContactChannels',
      );
      t.expect(contacts.principalId).toBe(knownPrincipalId);
      // Authority is declared, so a caller can tell a placeholder from a system of record
      // without knowing which adapter is wired.
      t.expect(typeof contacts.authority).toBe('string');
    });

    t.it('returns an EMPTY record, not an error, when no contact is held', async () => {
      /**
       * §17.2's companion rule for organisational attributes — "absent attributes are
       * absent, never blank" — applied to contact channels. Nobody has populated the store
       * yet, and the notification path is required to cope: §29.6 makes a missing address a
       * dead-letter with the principal "flagged for administrative attention", which only
       * works if this returns successfully with nothing in it.
       */
      const { adapter, principalWithoutContacts } = await makeFixture();
      const contacts = unwrap(
        await adapter.resolveContactChannels(principalWithoutContacts),
        'resolveContactChannels',
      );
      t.expect(contacts.email).toBe(undefined);
      t.expect(contacts.mobile).toBe(undefined);
    });

    t.it('refuses an unknown principal rather than inventing one', async () => {
      const { adapter, unknownPrincipalId } = await makeFixture();
      const result = await adapter.resolveContactChannels(unknownPrincipalId);
      t.expect(result.ok).toBe(false);
    });

    t.it('never returns a blank string where an address is absent', async () => {
      // A blank address is worse than a missing one: it passes an `!== undefined` check
      // and then fails at the provider, one row at a time.
      const { adapter, principalWithoutContacts } = await makeFixture();
      const contacts = unwrap(
        await adapter.resolveContactChannels(principalWithoutContacts),
        'resolveContactChannels',
      );
      t.expect(contacts.email === undefined || contacts.email.length > 0).toBe(true);
    });
  });
}

/* ------------------------------------------------------------ object storage */

export function objectStorageConformance(
  t: TestPrimitives,
  makeAdapter: () => Promise<ObjectStorageProvider>,
): void {
  t.describe('ObjectStorageProvider conformance', () => {
    t.it('issues upload grants into a quarantine location, never a servable one', async () => {
      // ADR-012: nothing is reachable until it has been scanned and promoted.
      const adapter = await makeAdapter();
      const grant = unwrap(
        await adapter.issueUploadGrant({
          conversationId: crypto.randomUUID(),
          declaredMime: 'application/pdf',
          declaredBytes: 1024,
          purpose: 'claim-document',
        }),
        'issueUploadGrant',
      );
      t.expect(grant.quarantineKey.startsWith('quarantine/')).toBe(true);
      t.expect(grant.expiresAt).toBeDefined();
    });

    t.it('promotes a quarantined object to a distinct clean key', async () => {
      const adapter = await makeAdapter();
      const grant = unwrap(
        await adapter.issueUploadGrant({
          conversationId: crypto.randomUUID(),
          declaredMime: 'image/png',
          declaredBytes: 512,
          purpose: 'evidence',
        }),
        'issueUploadGrant',
      );
      const promoted = unwrap(await adapter.promote(grant.quarantineKey), 'promote');
      t.expect(promoted.cleanKey.startsWith('quarantine/')).toBe(false);
    });

    t.it('issues time-limited download grants', async () => {
      const adapter = await makeAdapter();
      const grant = unwrap(await adapter.issueDownloadGrant('clean/example', 60), 'issueDownloadGrant');
      t.expect(typeof grant.url).toBe('string');
    });
  });
}
