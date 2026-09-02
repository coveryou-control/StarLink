/**
 * Correcting and deleting a message.
 *
 * ## Why both are revisions rather than mutations
 *
 * `conversation.message_revisions` has existed since the foundation migration with kinds
 * CORRECTION, REDACTION and TOMBSTONE, and `messages.redacted_at` alongside it. The schema
 * was designed for this: a message is a historical record somebody may later have to argue
 * from (§24.9), so neither operation destroys what was there. The body changes and the
 * previous body is kept, with who changed it and when.
 *
 * ## The sender, and only the sender
 *
 * Editing somebody else's words is impersonation, and deleting them is moderation. The
 * first is never right; the second is a policy about who may remove whose messages, which
 * is a business decision nobody has taken — so it is not invented here. `decide()` answers
 * "may this person act in this conversation"; this adds "and is it theirs".
 *
 * There is deliberately no time limit. A five-minute edit window is exactly the kind of
 * number rule 10 forbids inventing, and its absence costs nothing: the revision history
 * records every correction whenever it happened.
 *
 * ## Search follows for free
 *
 * `messages.search_vector` is `GENERATED ALWAYS AS (to_tsvector('english', coalesce(body,
 * '')))`, so changing the body re-indexes it and blanking the body removes it from the
 * index. A redacted message stops being findable by its text without a second write that
 * could fail after the first committed.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';

import type { MessageRecord, MessageStore } from './ports.js';

export interface ReviseMessageCommand {
  readonly conversationId: UUID;
  readonly messageId: UUID;
  readonly actorId: UUID;
  readonly correlationId: string;
}

export interface EditMessageCommand extends ReviseMessageCommand {
  readonly body: string;
}

export type ReviseFailure =
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_THE_SENDER'
  | 'ALREADY_REDACTED'
  | 'EMPTY_BODY'
  | 'BODY_TOO_LONG'
  | 'UNCHANGED';

export type ReviseResult =
  | { readonly ok: true; readonly message: MessageRecord }
  | { readonly ok: false; readonly reason: ReviseFailure };

/** The same ceiling the send path uses; a correction is not a way past it. */
const MAX_BODY = 10_000;

export interface ReviseDeps {
  readonly store: MessageStore;
  readonly now: () => Date;
  readonly newId: () => UUID;
}

/**
 * Replaces the body, keeping the previous one.
 *
 * The whole operation is one transaction: the row is loaded FOR UPDATE, checked, written,
 * and its revision recorded together. Without the lock two concurrent edits would each
 * record the other's text as "previous", and the history would describe a sequence that
 * never happened.
 */
export async function editMessage(
  command: EditMessageCommand,
  deps: ReviseDeps,
): Promise<ReviseResult> {
  const body = command.body.trim();
  if (body === '') return { ok: false, reason: 'EMPTY_BODY' };
  if (body.length > MAX_BODY) return { ok: false, reason: 'BODY_TOO_LONG' };

  return deps.store.transaction(async (tx) => {
    const existing = await tx.loadMessageForRevision(command.conversationId, command.messageId);
    if (existing === undefined) return { ok: false, reason: 'MESSAGE_NOT_FOUND' };
    if (existing.senderPrincipalId !== command.actorId) return { ok: false, reason: 'NOT_THE_SENDER' };
    // A deleted message has no text to correct, and re-populating it would resurrect
    // something somebody deliberately removed.
    if (existing.redactedAt !== undefined) return { ok: false, reason: 'ALREADY_REDACTED' };
    /**
     * An edit that changes nothing writes nothing.
     *
     * Otherwise opening the editor and pressing save stamps `edited_at`, so a message is
     * marked as corrected when it was only looked at — and the history fills with
     * revisions whose previous body equals their new one.
     */
    if (existing.body === body) return { ok: false, reason: 'UNCHANGED' };

    const at = deps.now().toISOString() as Timestamp;
    await tx.insertRevision({
      revisionId: deps.newId(),
      messageId: command.messageId,
      kind: 'CORRECTION',
      previousBody: existing.body,
      actorId: command.actorId,
    });
    const updated = await tx.applyCorrection(command.messageId, body, at);
    // Same reason as the redaction below: the sidebar holds a copy of the newest message.
    await tx.refreshPreview(command.conversationId);

    await tx.appendOutbox({
      eventName: 'message.revised.v1',
      eventVersion: 1,
      aggregateType: 'conversation',
      aggregateId: command.conversationId,
      // No body on the event: §20.4 keeps message content off the wire, and a correction
      // is still content. The client re-reads through the authorized path.
      payload: {
        messageId: command.messageId,
        conversationId: command.conversationId,
        kind: 'CORRECTION',
      },
      correlationId: command.correlationId,
    });

    return { ok: true, message: updated };
  });
}

/**
 * Removes the text, keeping the record that a message was there.
 *
 * The row survives with `redacted_at` set and its body blanked. It is not deleted, for the
 * same reason `endParticipation` dates a row rather than removing it (BR-09, §24.3): the
 * sequence has to stay gap-free, a reply pointing at it must still resolve to something,
 * and "what was here" must remain answerable from the revision history.
 */
export async function redactMessage(
  command: ReviseMessageCommand,
  deps: ReviseDeps,
): Promise<ReviseResult> {
  return deps.store.transaction(async (tx) => {
    const existing = await tx.loadMessageForRevision(command.conversationId, command.messageId);
    if (existing === undefined) return { ok: false, reason: 'MESSAGE_NOT_FOUND' };
    if (existing.senderPrincipalId !== command.actorId) return { ok: false, reason: 'NOT_THE_SENDER' };
    // Idempotent: deleting twice is not an error, but it must not write a second revision
    // whose "previous body" is already empty.
    if (existing.redactedAt !== undefined) return { ok: true, message: existing };

    const at = deps.now().toISOString() as Timestamp;
    await tx.insertRevision({
      revisionId: deps.newId(),
      messageId: command.messageId,
      kind: 'REDACTION',
      previousBody: existing.body,
      actorId: command.actorId,
    });
    const updated = await tx.applyRedaction(command.messageId, at);

    /**
     * The conversation-list preview holds a copy of the newest message's text, so deleting
     * that message would leave its words visible on every sidebar showing the thread. The
     * preview is recomputed from what still has text — in the same transaction, because a
     * redaction that committed with the old preview intact is a redaction that did not
     * happen where it matters most.
     */
    await tx.refreshPreview(command.conversationId);

    await tx.appendOutbox({
      eventName: 'message.revised.v1',
      eventVersion: 1,
      aggregateType: 'conversation',
      aggregateId: command.conversationId,
      payload: {
        messageId: command.messageId,
        conversationId: command.conversationId,
        kind: 'REDACTION',
      },
      correlationId: command.correlationId,
    });

    return { ok: true, message: updated };
  });
}
