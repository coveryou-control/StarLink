/**
 * CCS business-object context providers (brief §46, INTEGRATION_CONTRACTS §5).
 *
 * Read canonical context; register links. StarLink never mutates these objects and
 * never becomes authoritative for them. Every returned summary is a reference plus a
 * TTL-bound display cache — never a copy that could drift into a second truth.
 */
import type { CanonicalRef, SensitivityClass, Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

export interface BusinessObjectSummary {
  readonly ref: CanonicalRef;
  readonly type: string;
  readonly displayLabel: string;
  readonly status: string;
  readonly sensitivity: SensitivityClass;
  readonly cachedAt: Timestamp;
}

/**
 * Purpose-bound, actor-attributed read.
 *
 * `purpose` and `actor` are required arguments rather than ambient context because
 * privileged reads must be auditable and masking must be decided per request
 * (brief §29). A signature that allowed an anonymous read would make that optional.
 */
export interface ContextQuery {
  readonly purpose: string;
  readonly actor: UUID;
}

export interface Customer360Summary {
  readonly customerRef: CanonicalRef;
  readonly displayName: string;
  /** Masked by default. Unmasking is a separate, audited capability (brief §29). */
  readonly maskedContact: { readonly mobile?: string; readonly email?: string };
  readonly relationshipOwner?: UUID;
  readonly activeObjects: readonly BusinessObjectSummary[];
  readonly cachedAt: Timestamp;
}

export interface CustomerContextProvider extends HealthReporting {
  getCustomer360(customerRef: CanonicalRef, query: ContextQuery): Promise<Result<Customer360Summary>>;
  findByIdentity(claim: {
    readonly mobile?: string;
    readonly email?: string;
    readonly policyNumber?: string;
  }): Promise<Result<readonly CanonicalRef[]>>;
  /** The designated employee (D-19). Absent for a new prospect — that is a normal answer. */
  getRelationshipOwner(customerRef: CanonicalRef): Promise<Result<{ principalId: UUID } | null>>;
}

/** Shared shape for Policy / Claim / Booking / Payment / Opportunity providers. */
export interface BusinessObjectProvider extends HealthReporting {
  getSummary(ref: CanonicalRef, query: ContextQuery): Promise<Result<BusinessObjectSummary>>;
  listForCustomer(customerRef: CanonicalRef): Promise<Result<readonly BusinessObjectSummary[]>>;
  /** Registers the conversation↔object back-reference (brief §21, §22). */
  linkConversation(ref: CanonicalRef, conversationId: UUID, relation: string): Promise<Result<void>>;
}

export interface OpportunityDraft {
  readonly customerRef: CanonicalRef;
  readonly product?: string;
  readonly intent: string;
  readonly notes?: string;
}

export interface OpportunityProvider extends BusinessObjectProvider {
  /**
   * PROPOSE, not create: CCS decides. AI may recommend this, but cannot silently
   * create high-impact work (brief §22).
   */
  proposeCreate(
    draft: OpportunityDraft,
    origin: { readonly conversationId: UUID; readonly messageId?: UUID },
  ): Promise<Result<CanonicalRef>>;
}
