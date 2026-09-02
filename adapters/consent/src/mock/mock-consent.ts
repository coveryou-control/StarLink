/**
 * Mock consent client.
 *
 * Deliberately offered in two postures, because a permissive default in a test suite
 * is how a fail-closed rule quietly stops being tested:
 *
 *   * `permissive()` for local development, where blocking every outbound would make
 *     the product unusable before the real client exists.
 *   * `strict()` for tests, which denies unless a purpose has been explicitly allowed —
 *     the posture the production client will have.
 *
 * Neither is authoritative. Consent truth belongs to CCS Consent & Contact Governance
 * (brief §2), and this adapter exists only so the domain can be written against the
 * final interface today.
 */
import type {
  ConsentEligibilityClient,
  Eligibility,
  HealthReport,
  OutboundCheck,
  ReEngagementCheck,
  Result,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

export type ConsentPosture = 'PERMISSIVE' | 'STRICT' | 'UNAVAILABLE';

export class MockConsentClient implements ConsentEligibilityClient {
  private constructor(
    private readonly posture: ConsentPosture,
    private readonly allowedPurposes: ReadonlySet<string>,
  ) {}

  /** Local development: allow, but still make the call, so the call site is exercised. */
  static permissive(): MockConsentClient {
    return new MockConsentClient('PERMISSIVE', new Set());
  }

  /** Tests: deny unless explicitly permitted. */
  static strict(allowedPurposes: readonly string[] = []): MockConsentClient {
    return new MockConsentClient('STRICT', new Set(allowedPurposes));
  }

  /** Simulates the authority being unreachable, for the fail-closed tests. */
  static unavailable(): MockConsentClient {
    return new MockConsentClient('UNAVAILABLE', new Set());
  }

  private evaluate(purpose: string): Result<Eligibility> {
    if (this.posture === 'UNAVAILABLE') {
      // The whole point: an unreachable consent authority is NOT an implicit yes.
      return err({
        code: 'CONSENT_AUTHORITY_UNAVAILABLE',
        message: 'consent could not be established',
        retryable: true,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'mock',
      });
    }
    if (this.posture === 'PERMISSIVE') return ok({ allowed: true });
    return this.allowedPurposes.has(purpose)
      ? ok({ allowed: true })
      : ok({ allowed: false, reason: `purpose "${purpose}" is not permitted for this customer` });
  }

  async checkOutbound(request: OutboundCheck): Promise<Result<Eligibility>> {
    return this.evaluate(request.purpose);
  }

  async checkReEngagement(request: ReEngagementCheck): Promise<Result<Eligibility>> {
    return this.evaluate(request.purpose);
  }

  async health(): Promise<HealthReport> {
    return {
      status: this.posture === 'UNAVAILABLE' ? 'DOWN' : 'UP',
      authority: 'MOCK',
      checkedAt: new Date().toISOString(),
    };
  }
}
