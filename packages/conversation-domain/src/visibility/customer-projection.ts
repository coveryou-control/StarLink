/**
 * Customer serialisers — layer 4 of the §18.4 authorization ladder (§25.3, ADR-021).
 *
 * This is the last line, not the boundary. Authorization has already happened by the
 * time anything reaches here; what this layer prevents is a field leaking through a
 * path that *was* authorised — the customer may legitimately read this conversation,
 * and the row still carries the assigned agent, the SLA clock, the escalation state and
 * the internal priority.
 *
 * ## Allow-list, and why it has to be
 *
 * Every function below names the fields it emits and constructs a fresh object. It
 * never spreads, never deletes, never "omits". A deny-list is wrong here for a reason
 * that has nothing to do with taste: the internal record grows. When Phase 6 adds an
 * SLA breach flag and Phase 5 adds a transfer reason, a deny-list silently starts
 * publishing them and nothing fails. An allow-list silently keeps hiding them, and
 * that is the direction you want the silence to point.
 *
 * The tests fuzz this: an internal record is filled with sentinel values in every
 * field, projected, and the output searched for any sentinel that was not explicitly
 * allowed. A new leaking field fails that test without anyone remembering to update it.
 */
import { toCustomerStatus, type CustomerVisibleStatus } from '@starlink/service-case';
import type { MessageVisibility, Timestamp, UUID } from '@starlink/shared-contracts';

/**
 * The internal shape. Deliberately wide — it is what the repository actually holds, and
 * the point of this module is that most of it never reaches a customer.
 */
export interface InternalConversationRecord {
  readonly conversationId: UUID;
  readonly conversationType: string;
  readonly title?: string | null;
  readonly state?: string | null;
  readonly lastActivityAt: Timestamp;
  readonly lastMessagePreview?: string | null;
  /**
   * BR-19's recorded outcome. §22.5 gives the customer this and NOT the resolution
   * timestamp — "Resolution timestamp | When it was resolved, and the outcome |
   * **Outcome only**" — so the two travel separately and only this one is projected.
   */
  readonly outcome?: string | null;
  // --- none of the following may ever reach a customer ---
  readonly caseId?: UUID;
  /**
   * WHEN it was resolved. Internal. §22.5's row gives the customer the outcome and
   * withholds the timestamp, and the field is listed here so the distinction is visible
   * rather than implied by an absence.
   */
  readonly resolvedAt?: Timestamp;
  readonly customerRef?: string;
  readonly currentOwnerId?: UUID;
  readonly currentOwnerName?: string;
  readonly owningTeamId?: string;
  readonly owningDepartment?: string;
  readonly sensitivity?: string;
  readonly priority?: string;
  readonly slaTargetId?: UUID;
  readonly slaDueAt?: Timestamp;
  readonly slaBreached?: boolean;
  readonly escalationLevel?: number;
  readonly escalatedAt?: Timestamp;
  readonly transferCount?: number;
  readonly queueEntryId?: UUID;
  readonly participantCount?: number;
  readonly internalNotesCount?: number;
  readonly tenantId?: string;
  readonly createdBy?: UUID;
  readonly lastSeq?: number;
}

/** What a customer sees of their own conversation. Nothing here is about staff. */
export interface CustomerConversationView {
  readonly conversationId: UUID;
  readonly subject: string | null;
  /**
   * The customer-facing lifecycle only. Internal states (queued, claimed, escalated)
   * are collapsed by {@link toCustomerState} rather than passed through — "escalated"
   * tells a customer about our internal handling, which is not theirs to know and
   * invites an argument about why.
   */
  readonly status: CustomerVisibleStatus;
  /**
   * BR-20: "The customer is told the conversation was resolved, **and why**."
   *
   * `null` until there is one, which is every state but RESOLVED and CLOSED. The status
   * alone satisfies the first half of BR-20 and not the second; without this the customer
   * was told a conversation had ended and never told what came of it.
   *
   * Free text written by the resolving agent — see `PgCaseStore.resolve` for why it is
   * not a code. §22.5 pairs it with a deliberate omission: the customer gets the outcome
   * and never the resolution TIMESTAMP.
   */
  readonly outcome: string | null;
  readonly lastActivityAt: Timestamp;
}

/**
 * Re-exported from `@starlink/service-case`, which owns the vocabulary next to the state
 * machine it maps from. Kept exported here because this module is the visibility
 * boundary every customer-facing serialiser goes through, and a caller should not have to
 * know which package the four words live in.
 */
export type { CustomerVisibleStatus };

export interface InternalMessageRecord {
  readonly messageId: UUID;
  readonly conversationId: UUID;
  readonly seq: number;
  readonly body: string;
  readonly visibility: MessageVisibility;
  readonly authorId: UUID;
  readonly authorKind: string;
  readonly authorDisplayName: string;
  readonly createdAt: Timestamp;
  // --- internal only ---
  readonly authorEmployeeId?: string;
  readonly authorTeamId?: string;
  readonly authorDepartment?: string;
  readonly redactedAt?: Timestamp;
  readonly redactedBy?: UUID;
  readonly internalTags?: readonly string[];
  readonly aiConfidence?: number;
  readonly moderationFlags?: readonly string[];
}

export interface CustomerMessageView {
  readonly messageId: UUID;
  readonly seq: number;
  readonly body: string;
  /**
   * Who the customer sees. Never a principal id, never an employee id: those are
   * internal identifiers, and handing them out lets a customer correlate staff across
   * conversations and probe the directory.
   */
  readonly author: { readonly kind: 'YOU' | 'AGENT' | 'SYSTEM'; readonly displayName: string };
  readonly createdAt: Timestamp;
}

/**
 * Projects a conversation for a customer.
 *
 * Fails closed on `null`: a caller that hands us a record it should not have loaded
 * gets nothing back, rather than a partially-populated object that looks legitimate.
 */
export function toCustomerConversationView(
  record: InternalConversationRecord,
): CustomerConversationView {
  return {
    conversationId: record.conversationId,
    subject: record.title ?? null,
    status: toCustomerStatus(record.state),
    outcome: record.outcome ?? null,
    lastActivityAt: record.lastActivityAt,
  };
}

/**
 * Collapses the internal lifecycle to the words a customer may see (D-26, §22.5).
 *
 * Delegates to `@starlink/service-case`, which holds the mapping as a total
 * `Record<ConversationState, …>` beside the state machine — so a new internal state is a
 * compile error there until somebody decides what the customer should be told.
 *
 * This used to be a local `switch` with a `default`, and it was wrong in a way a default
 * arm is designed to hide: it tested for `'AWAITING_CUSTOMER'` when the enum value is
 * `'WAITING_CUSTOMER'`, so every conversation waiting on the customer displayed as though
 * we were still working on it. Its unit test asserted the same misspelling and passed.
 *
 * Kept as a named export because it is part of §18.4 layer 4's surface, and callers
 * should reach the vocabulary through the visibility boundary rather than around it.
 */
export { toCustomerStatus as toCustomerState } from '@starlink/service-case';

/**
 * Projects a message for a customer.
 *
 * Returns `undefined` for anything not customer-visible. The caller must filter these
 * out — and callers should filter at the QUERY (§30.2), not here. This is the
 * belt to that braces: if an internal note ever reaches this function, it produces
 * nothing rather than a redacted husk that still leaks its existence and position.
 */
export function toCustomerMessageView(
  record: InternalMessageRecord,
  viewerPrincipalId: UUID,
): CustomerMessageView | undefined {
  if (record.visibility !== 'CUSTOMER_VISIBLE') return undefined;

  return {
    messageId: record.messageId,
    seq: record.seq,
    body: record.body,
    author: {
      kind:
        record.authorId === viewerPrincipalId
          ? 'YOU'
          : record.authorKind === 'EMPLOYEE' || record.authorKind === 'AI'
            ? 'AGENT'
            : 'SYSTEM',
      displayName: record.authorDisplayName,
    },
    createdAt: record.createdAt,
  };
}

/**
 * Projects a page of messages.
 *
 * Internal notes are dropped ENTIRELY — not replaced by a placeholder. A "[hidden
 * note]" row would tell a customer that staff discussed them at a precise instant,
 * which is most of the leak: the timing and volume of internal discussion around a
 * complaint is exactly what a customer must not be able to infer (§27.16).
 *
 * The `seq` values that remain are therefore non-contiguous, and that is correct. The
 * customer client's gap detection must key on the customer-visible stream, not assume
 * the internal sequence is dense.
 */
export function toCustomerMessagePage(
  records: readonly InternalMessageRecord[],
  viewerPrincipalId: UUID,
): readonly CustomerMessageView[] {
  const views: CustomerMessageView[] = [];
  for (const record of records) {
    const view = toCustomerMessageView(record, viewerPrincipalId);
    if (view !== undefined) views.push(view);
  }
  return views;
}
