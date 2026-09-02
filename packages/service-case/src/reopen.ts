/**
 * Reopening after resolution (doc §11.5 BR-21/BR-22, §22.4, D-08).
 *
 * Two business rules, and the whole of this file is the boundary between them:
 *
 *   BR-21 — "A reply inside the reopen window reopens the same thread to the same owner"
 *   BR-22 — "After the window, a new conversation is created with prior history linked
 *            for staff"
 *
 * The rules are DECIDED. Only the window length is not: §44.3 D-08 proposes seven days
 * and says plainly that "7 days is arbitrary until the business gives a service standard",
 * and A-08 records that if it is wrong "window length changes; the model does not". So the
 * length arrives as configuration and nothing here has an opinion about it.
 *
 * ## Why the same owner, and why that is not merely a nicety
 *
 * BR-21 says the same OWNER, not just the same thread. A customer replying two days later
 * is continuing a conversation with a person, and handing them to whoever is free
 * discards the context that person already has. §21.7's distinction applies: the
 * designated employee never moved, and neither should this.
 *
 * The one case that overrides it is a departed owner — a deactivated principal cannot own
 * work (BR-13), and reopening onto one would recreate exactly the unreachable work §32.3
 * monitors with a target of zero. {@link decideReopen} therefore reports the intended
 * owner and leaves the caller to check they are still active, because whether an account
 * is active is not this module's to know.
 *
 * ## The window is measured in REAL time, not working time
 *
 * Deliberate, and worth stating because everything else in Phase 6 is calendar-aware. An
 * SLA clock measures what we promised and therefore pauses when nobody is rostered
 * (§23.5). A reopen window measures how long a customer has to change their mind, and a
 * customer's weekend is not paused. Making it working-time would mean a Friday resolution
 * stays reopenable until the following Wednesday, which is not what "seven days" means to
 * the person reading it.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export interface ReopenPolicy {
  /**
   * How long after resolution a reply reopens the same thread (D-08).
   *
   * No default. A module that guessed would be inventing the service standard §44.3 says
   * the business owes us.
   */
  readonly windowSeconds: number;
}

export interface ResolvedConversation {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  /** When the conversation was resolved. Absent means it never was. */
  readonly resolvedAt?: Timestamp;
  /** The owner at the moment of resolution — BR-21's "the same owner". */
  readonly ownerId?: UUID;
}

export type ReopenDecision =
  /** BR-21. Inside the window: the same thread, back to ACTIVE, to the same owner. */
  | {
      readonly outcome: 'REOPEN_SAME_THREAD';
      readonly conversationId: UUID;
      /**
       * Absent when the conversation had no owner recorded. The caller routes it
       * normally rather than inventing one.
       */
      readonly intendedOwnerId?: UUID;
    }
  /**
   * BR-22. Past the window: a NEW conversation, against the SAME case, with the prior
   * history linked for staff (§22.4).
   *
   * The customer is told nothing about this — §21.4's transition table, last row:
   * "No — it simply continues." From their side it is one continuous relationship; the
   * split exists so the organisation can measure two separate pieces of work honestly.
   */
  | {
      readonly outcome: 'NEW_CONVERSATION_SAME_CASE';
      readonly previousConversationId: UUID;
      readonly caseId?: UUID;
    }
  /** Not resolved, so there is nothing to reopen — the reply simply belongs to it. */
  | { readonly outcome: 'STILL_OPEN'; readonly conversationId: UUID };

/**
 * Which of BR-21 and BR-22 applies to a customer reply arriving now.
 *
 * The boundary is half-open, `[resolvedAt, resolvedAt + window)`, matching every other
 * effective period in the system — ownership episodes, participation, role grants,
 * calendar versions. A reply at exactly the expiry instant is outside the window: the
 * alternative would make the window one millisecond longer than configured, which is the
 * sort of detail that is invisible until someone is arguing about a specific case.
 */
export function decideReopen(
  conversation: ResolvedConversation,
  policy: ReopenPolicy,
  at: Timestamp,
): ReopenDecision {
  if (conversation.resolvedAt === undefined) {
    return { outcome: 'STILL_OPEN', conversationId: conversation.conversationId };
  }

  const resolvedAt = Date.parse(conversation.resolvedAt);
  const now = Date.parse(at);
  const expiresAt = resolvedAt + policy.windowSeconds * 1000;

  // A reply timestamped BEFORE the resolution is not a time-travelling customer; it is
  // clock skew between the application and the database, or a retried request carrying
  // its original timestamp (ADR-025 — this machine's clock has run a minute behind the
  // database). Treating it as "inside the window" is the forgiving reading, and the
  // forgiving reading is the right one when the alternative is splitting a conversation
  // because two clocks disagreed.
  if (now < resolvedAt || now < expiresAt) {
    return {
      outcome: 'REOPEN_SAME_THREAD',
      conversationId: conversation.conversationId,
      ...(conversation.ownerId !== undefined ? { intendedOwnerId: conversation.ownerId } : {}),
    };
  }

  return {
    outcome: 'NEW_CONVERSATION_SAME_CASE',
    previousConversationId: conversation.conversationId,
    ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
  };
}

/**
 * When the reopen window closes, so a sweep can move RESOLVED to CLOSED (§21.4).
 *
 * Returned rather than stored, for the same reason the SLA clock is computed rather than
 * stored (§23.5, migration 0005): a stored expiry could not be corrected if the policy
 * changed, and it would need a backfill nobody would remember to run.
 */
export const reopenWindowExpiresAt = (
  resolvedAt: Timestamp,
  policy: ReopenPolicy,
): Timestamp =>
  new Date(Date.parse(resolvedAt) + policy.windowSeconds * 1000).toISOString() as Timestamp;
