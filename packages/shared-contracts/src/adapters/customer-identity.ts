/**
 * Customer identity contract (brief §7, ADR-019).
 *
 * Full verification is NOT required before every chat. The required assurance depends
 * on the intended action: a general FAQ may be anonymous; a policy copy, claim detail
 * or payment question requires a verified identity.
 */
import type { Assurance, CanonicalRef, ChannelKind, Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

export type VerificationMethod = 'OTP_MOBILE' | 'OTP_EMAIL' | 'POLICY_LOOKUP' | 'AUTH_PORTAL';

export interface IdentityHints {
  readonly mobile?: string;
  readonly email?: string;
  readonly policyNumber?: string;
  readonly portalSessionToken?: string;
}

export interface CustomerSession {
  readonly sessionId: UUID;
  readonly assurance: Assurance;
  readonly channel: ChannelKind;
  readonly customerRef?: CanonicalRef;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  /**
   * The instant assurance was last raised. History created before this point under a
   * DIFFERENT identity claim is never inherited (doc §27.3) — this is what stops a
   * hijacked session from acquiring someone else's thread.
   */
  readonly verifiedAt?: Timestamp;
}

export interface VerificationChallenge {
  readonly challengeId: UUID;
  readonly method: VerificationMethod;
  readonly expiresAt: Timestamp;
  readonly attemptsRemaining: number;
}

export interface CustomerIdentityProvider extends HealthReporting {
  createSession(channel: ChannelKind, hints?: IdentityHints): Promise<Result<CustomerSession>>;
  beginVerification(sessionId: UUID, method: VerificationMethod): Promise<Result<VerificationChallenge>>;
  /** Success raises assurance and is audited; a burst of failures is what takeover looks like. */
  completeVerification(sessionId: UUID, challengeId: UUID, proof: string): Promise<Result<CustomerSession>>;
  resolveCustomer(sessionId: UUID): Promise<Result<{ customerRef: CanonicalRef; assurance: Assurance } | null>>;
  invalidate(sessionId: UUID): Promise<Result<void>>;
}
