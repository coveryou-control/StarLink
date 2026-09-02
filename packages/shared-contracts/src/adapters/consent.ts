/**
 * Consent & contact governance contract (brief §46, doc Part IV §58).
 *
 * FAIL_CLOSED by construction: if eligibility cannot be established, no new proactive
 * outbound contact happens. Channel availability is never permission — "we can reach
 * them" and "we may reach them" are different questions, and only this client answers
 * the second one.
 *
 * The check happens immediately before SEND, not when the conversation was created,
 * because consent can be withdrawn between those two moments.
 */
import type { CanonicalRef, ChannelKind, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

export type Eligibility =
  | { readonly allowed: true; readonly constraints?: readonly string[] }
  | { readonly allowed: false; readonly reason: string };

export interface OutboundCheck {
  readonly customerRef: CanonicalRef;
  readonly channel: ChannelKind;
  /** Purpose-bound: possession of contact data is not permission for every use. */
  readonly purpose: string;
  readonly templateRef?: string;
}

export interface ReEngagementCheck {
  readonly conversationId: UUID;
  readonly channel: ChannelKind;
  readonly purpose: string;
}

export interface ConsentEligibilityClient extends HealthReporting {
  checkOutbound(request: OutboundCheck): Promise<Result<Eligibility>>;
  checkReEngagement(request: ReEngagementCheck): Promise<Result<Eligibility>>;
}
