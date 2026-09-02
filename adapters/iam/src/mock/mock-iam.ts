/**
 * In-memory IAM adapter for tests and local development.
 *
 * Reports `authority: 'MOCK'` so that nothing — a dashboard, an export, an incident
 * review — can mistake it for a real identity source (INTEGRATION_CONTRACTS §1 rule 4).
 */
import type {
  HealthReport,
  IdentityAuthorizationClient,
  PrincipalClaims,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

const now = (): string => new Date().toISOString();

const notFound = (code: string, message: string): Result<never> =>
  err({
    code,
    message,
    retryable: false,
    // Identity is an authority: if it cannot answer, we refuse rather than assume.
    failureClass: 'FAIL_CLOSED',
    correlationId: 'mock',
  });

export class MockIamAdapter implements IdentityAuthorizationClient {
  private readonly principals = new Map<UUID, PrincipalClaims>();
  private readonly credentials = new Map<string, UUID>();

  constructor(seed: readonly PrincipalClaims[] = [], credentials: ReadonlyMap<string, UUID> = new Map()) {
    for (const p of seed) this.principals.set(p.principalId, p);
    for (const [k, v] of credentials) this.credentials.set(k, v);
  }

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    const found = this.principals.get(principalId);
    if (found === undefined) return notFound('PRINCIPAL_NOT_FOUND', 'no such principal');
    return ok(found);
  }

  async verifyCredential(username: string, secret: string): Promise<Result<{ principalId: UUID }>> {
    const principalId = this.credentials.get(`${username}:${secret}`);
    // Uniform refusal: an unknown account and a wrong secret are indistinguishable
    // to the caller (doc §27.1). Telling them apart tells an attacker which half
    // they got right and tells a legitimate user nothing they can act on.
    if (principalId === undefined) return notFound('AUTH_FAILED', 'authentication failed');
    return ok({ principalId });
  }

  async getSessionVersion(principalId: UUID): Promise<Result<number>> {
    const found = this.principals.get(principalId);
    if (found === undefined) return notFound('PRINCIPAL_NOT_FOUND', 'no such principal');
    return ok(found.sessionVersion);
  }

  async revokeSessions(principalId: UUID, _reason: string): Promise<Result<void>> {
    const found = this.principals.get(principalId);
    if (found === undefined) return notFound('PRINCIPAL_NOT_FOUND', 'no such principal');
    // Bumping the version is the revocation: the next request and the next socket
    // message both fail their version check (ADR-008).
    this.principals.set(principalId, { ...found, sessionVersion: found.sessionVersion + 1 });
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: now() };
  }

  /** Test helper: simulate an employee exit. */
  setStatus(principalId: UUID, status: PrincipalClaims['status']): void {
    const found = this.principals.get(principalId);
    if (found !== undefined) {
      this.principals.set(principalId, { ...found, status, sessionVersion: found.sessionVersion + 1 });
    }
  }
}
