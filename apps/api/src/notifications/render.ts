/**
 * What a notification actually says (doc §29.2, §29.3).
 *
 * Extracted from `SweepHost` so the words are testable. They were an inline lambda, which
 * is how the subject line came to be `row.event` — an email would have arrived titled
 * **`CUSTOMER_REPLIED`**. Nothing caught it because nothing could reach it.
 *
 * ## The copy is transcribed, not written
 *
 * Every subject is §29.2's "Notified" column verbatim, held there in `NOTIFICATION_RULES`
 * beside the rule it belongs to. The document does not say "these are the subject lines",
 * but it gives a phrase for every row in the second person, and transcribing it is a
 * different act from inventing English — which matters, because the document treats
 * customer-facing wording as a business decision three times over (D-20 after-hours
 * wording, D-26 status vocabulary, D-28 what the case is called) and this is the same
 * kind of thing pointed at staff.
 *
 * ## What a notification may carry, and what it may not
 *
 * §29.3's contract is "given a recipient and a payload". The payload here is a subject, a
 * count and a link. Never message content, never a customer's name, never case detail —
 * a notification says there is something to look at, and the thing itself stays behind
 * the authorization that guards it. An email carrying an excerpt would be a copy of the
 * conversation with the object check removed, sitting in a mailbox StarLink does not
 * govern.
 */
import { subjectFor } from '@starlink/notifications';
import type { RenderedNotification } from '@starlink/shared-contracts';

/** The fields of an outbox row the copy depends on. */
export interface RenderableNotification {
  readonly recipientId: string;
  readonly channel: string;
  readonly event: string;
  readonly targetRef?: string;
  readonly coalescedCount?: number;
}

export interface RenderOptions {
  /**
   * Absolute origin of the employee surface, for the link.
   *
   * Required, not optional. A relative path is fine in the in-app client and useless in
   * an email — `/conversations/abc` in a mailbox resolves against the mail client, which
   * is nowhere. The link was rendered relative and then used by no transport at all, so
   * the email had no way to reach the thing it was about.
   */
  readonly employeeOrigin: string;
}

/**
 * Turns one outbox row into the words a recipient sees.
 *
 * The same rendering for every channel, deliberately. §29.3 has each adapter answer "the
 * same question in the same way", and a per-channel voice is how the email and the badge
 * come to describe the same event differently — which reads, to the person holding both,
 * as two things happening.
 */
export function renderNotification(
  row: RenderableNotification,
  options: RenderOptions,
): RenderedNotification {
  const subject = subjectFor(row.event);

  /**
   * §29.5's "'3 new messages', not three notifications". The row itself is the first
   * event and `coalescedCount` is how many further ones folded into it, so the total is
   * one more. Below two, the count is left out entirely — "1 update" is a phrase only a
   * program writes.
   */
  const total = (row.coalescedCount ?? 0) + 1;

  const link =
    row.targetRef !== undefined
      ? `${options.employeeOrigin.replace(/\/+$/, '')}/conversations/${row.targetRef}`
      : undefined;

  const body = [
    total > 1 ? `${subject} (${total} updates)` : subject,
    link !== undefined ? `\n\nOpen it in StarLink: ${link}` : '',
    /**
     * Said out loud, because the alternative is a recipient replying to a mailbox nobody
     * reads and believing they have answered a customer.
     */
    '\n\nThis is an automated notification. Replies are not read.',
  ].join('');

  return {
    recipientPrincipalId: row.recipientId as RenderedNotification['recipientPrincipalId'],
    channel: row.channel as RenderedNotification['channel'],
    subject,
    body,
    ...(link !== undefined ? { deepLink: link } : {}),
  };
}
