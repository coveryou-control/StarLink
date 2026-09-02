/**
 * Structured mentions.
 *
 * ## Why structure rather than text
 *
 * A mention rendered by searching the body for "@" and a display name is wrong in three
 * ways that all show up in real use: two colleagues called Priya cannot be told apart, a
 * name quoted inside a sentence is highlighted as if somebody had been addressed, and a
 * person who is later renamed loses every mention of them retroactively. Carrying the
 * PRINCIPAL and the exact run of characters removes all three — the message records who
 * was meant, not what was typed.
 *
 * ## Validated against the conversation, not against the client
 *
 * The offsets and the principal both come from a browser, so both are checked here:
 * an offset outside the body, a principal who is not in the conversation, or two mentions
 * covering the same characters are all refused rather than stored. A mention of somebody
 * who cannot read the thread would otherwise be a notification pointing at a conversation
 * the recipient is then denied — which is how a notification becomes an information leak
 * about who is talking to whom.
 */
import type { UUID } from '@starlink/shared-contracts';

/** A mention of one person, or of everybody in the conversation. */
export type Mention =
  | {
      readonly kind: 'PRINCIPAL';
      readonly principalId: UUID;
      /** Index of the `@` in the message body. */
      readonly offset: number;
      /** How many characters the mention spans, `@` included. */
      readonly length: number;
    }
  | {
      readonly kind: 'ALL';
      readonly offset: number;
      readonly length: number;
    };

export type MentionFailure =
  | 'MENTION_OUT_OF_RANGE'
  | 'MENTION_OVERLAPS'
  | 'MENTION_NOT_A_PARTICIPANT'
  | 'MENTION_ALL_NOT_PERMITTED'
  | 'TOO_MANY_MENTIONS';

/**
 * A ceiling, so one message cannot fan out without bound.
 *
 * Not a business value: it bounds a payload and a notification burst, in the same way the
 * attachment list is bounded at ten. Fifty is far above any real message and far below
 * anything that would matter to the notification worker.
 */
export const MAX_MENTIONS = 50;

export type ValidateMentionsResult =
  | { readonly ok: true; readonly mentions: readonly Mention[] }
  | { readonly ok: false; readonly reason: MentionFailure };

/**
 * Checks a client's mentions against the body and the participant set.
 *
 * `participantIds` must be the LIVE participants of the conversation the message is being
 * sent to — the caller loads them inside the send transaction, so a colleague removed
 * between composing and sending is caught rather than notified.
 *
 * `allowAll` is whether `@all` is meaningful here. It is not on a one-to-one, where it
 * would mean the one person already reading the message, and it is not on a customer
 * conversation, where the participant set includes somebody outside the company.
 */
export function validateMentions(
  mentions: readonly Mention[],
  body: string,
  participantIds: ReadonlySet<string>,
  allowAll: boolean,
): ValidateMentionsResult {
  if (mentions.length === 0) return { ok: true, mentions: [] };
  if (mentions.length > MAX_MENTIONS) return { ok: false, reason: 'TOO_MANY_MENTIONS' };

  /**
   * Sorted by offset before the overlap check, so the check is a single pass over
   * neighbours rather than a comparison of every pair. The stored order is the reading
   * order too, which is what the renderer wants.
   */
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);

  let previousEnd = -1;
  for (const mention of sorted) {
    if (
      !Number.isInteger(mention.offset) ||
      !Number.isInteger(mention.length) ||
      mention.offset < 0 ||
      mention.length <= 0 ||
      mention.offset + mention.length > body.length
    ) {
      return { ok: false, reason: 'MENTION_OUT_OF_RANGE' };
    }

    /**
     * Overlapping mentions would make the rendered message ambiguous — two marks over the
     * same characters — and are only ever produced by a broken or hostile client. Refused
     * rather than silently merged, because merging invents a mention nobody made.
     */
    if (mention.offset < previousEnd) return { ok: false, reason: 'MENTION_OVERLAPS' };
    previousEnd = mention.offset + mention.length;

    if (mention.kind === 'ALL') {
      if (!allowAll) return { ok: false, reason: 'MENTION_ALL_NOT_PERMITTED' };
      continue;
    }

    /**
     * The principal must already be in the conversation.
     *
     * Mentioning somebody who is not is not a way to add them — that is BR-07's flow, with
     * its history-exposure acknowledgement — and notifying them would point them at a
     * thread `decide()` will refuse them.
     */
    if (!participantIds.has(mention.principalId)) {
      return { ok: false, reason: 'MENTION_NOT_A_PARTICIPANT' };
    }
  }

  return { ok: true, mentions: sorted };
}

/**
 * Who a message's mentions should notify, excluding the sender.
 *
 * `@all` resolves to every live participant. A person mentioned individually AND covered
 * by an `@all` appears once: the set is the point, because §29.5's coalescing is about
 * repeated events over time and this is one event that names somebody twice.
 *
 * The sender is always removed. `NEVER_NOTIFIED` includes `OWN_ACTION`, and being told you
 * mentioned yourself is the clearest possible case of it.
 */
export function mentionRecipients(
  mentions: readonly Mention[],
  participantIds: readonly string[],
  senderId: string,
): readonly string[] {
  const targets = new Set<string>();
  for (const mention of mentions) {
    if (mention.kind === 'ALL') {
      for (const id of participantIds) targets.add(id);
    } else {
      targets.add(mention.principalId);
    }
  }
  targets.delete(senderId);
  return [...targets];
}
