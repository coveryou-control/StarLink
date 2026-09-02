/**
 * The words a notification actually carries.
 *
 * Two things are being protected. The first is that the subject is a SENTENCE — it was
 * `row.event`, so an email would have arrived titled `CUSTOMER_REPLIED`, and nothing
 * caught it because the render was an inline lambda nothing could reach.
 *
 * The second is that the sentences are §29.2's, not ours. `matrix.test.ts` pins each
 * string against the source; this file proves the render uses them rather than composing
 * its own.
 */
import { describe, expect, it } from 'vitest';

import { renderNotification, type RenderableNotification } from './render.js';

const ORIGIN = 'https://starlink.coveryou.example';
const RECIPIENT = '018f2c5a-7d7d-7000-8000-00000000000a';
const CONVERSATION = '018f2c5a-7d7d-7000-8000-00000000000b';

const row = (over: Partial<RenderableNotification> = {}): RenderableNotification => ({
  recipientId: RECIPIENT,
  channel: 'EMAIL',
  event: 'CUSTOMER_REPLIED',
  targetRef: CONVERSATION,
  ...over,
});

describe('the subject is a sentence from §29.2', () => {
  it('never leaks the raw event name', () => {
    const rendered = renderNotification(row(), { employeeOrigin: ORIGIN });
    expect(rendered.subject).toBe('A customer replied to a thread you own');
    // The regression, stated directly.
    expect(rendered.subject).not.toBe('CUSTOMER_REPLIED');
    expect(rendered.subject).not.toMatch(/^[A-Z_]+$/);
  });

  it('uses the right sentence for each event', () => {
    const cases = [
      ['CONVERSATION_ASSIGNED', 'A customer conversation assigned to you'],
      ['TRANSFERRED', 'Transfer into or out of your ownership'],
      ['ESCALATED_TO_YOUR_FUNCTION', 'Escalation to your function'],
      ['WAITING_BEYOND_STANDARD', 'A conversation waiting beyond a service standard'],
      ['ROLE_OR_ACCESS_CHANGED', 'Your role or access changed'],
    ] as const;

    for (const [event, subject] of cases) {
      expect(renderNotification(row({ event }), { employeeOrigin: ORIGIN }).subject).toBe(subject);
    }
  });

  it('falls back to a sentence, never an enum, for an unknown event', () => {
    // Unreachable in practice — an event with no rule is not notifiable — but if it is
    // ever reached, a recipient should read English.
    const rendered = renderNotification(row({ event: 'SOMETHING_NEW' }), {
      employeeOrigin: ORIGIN,
    });
    expect(rendered.subject).not.toMatch(/^[A-Z_]+$/);
  });
});

describe('the link', () => {
  it('is absolute, so it works from a mail client', () => {
    /**
     * It was `/conversations/…` and used by no transport at all. A relative path in an
     * email resolves against the mail client, which is nowhere — so the notification
     * could not reach the thing it was about.
     */
    const rendered = renderNotification(row(), { employeeOrigin: ORIGIN });
    expect(rendered.deepLink).toBe(`${ORIGIN}/conversations/${CONVERSATION}`);
    expect(rendered.body).toContain(`${ORIGIN}/conversations/${CONVERSATION}`);
  });

  it('does not double the slash when the origin has a trailing one', () => {
    const rendered = renderNotification(row(), { employeeOrigin: `${ORIGIN}/` });
    expect(rendered.deepLink).toBe(`${ORIGIN}/conversations/${CONVERSATION}`);
  });

  it('is omitted entirely when the notification is not about a conversation', () => {
    // ROLE_OR_ACCESS_CHANGED has no target. A link to /conversations/undefined is worse
    // than no link.
    const rendered = renderNotification(
      { recipientId: RECIPIENT, channel: 'EMAIL', event: 'ROLE_OR_ACCESS_CHANGED' },
      { employeeOrigin: ORIGIN },
    );
    expect(rendered.deepLink).toBeUndefined();
    expect(rendered.body).not.toContain('undefined');
  });
});

describe('the count', () => {
  it('says how many, once there is more than one', () => {
    // §29.5: "'3 new messages', not three notifications."
    const rendered = renderNotification(row({ coalescedCount: 2 }), { employeeOrigin: ORIGIN });
    expect(rendered.body).toContain('(3 updates)');
  });

  it('says nothing about counts for a single event', () => {
    // "1 update" is a phrase only a program writes.
    const rendered = renderNotification(row({ coalescedCount: 0 }), { employeeOrigin: ORIGIN });
    expect(rendered.body).not.toContain('1 update');
    expect(rendered.body).not.toContain('(');
  });
});

describe('what the body must never contain', () => {
  it('carries no message content, customer name or case detail', () => {
    /**
     * The render is given an outbox row, and the row has never held content. This asserts
     * the render does not invent any — a notification says there is something to look at,
     * and the thing stays behind the authorization that guards it.
     */
    const rendered = renderNotification(
      { ...row(), coalescedCount: 4 },
      { employeeOrigin: ORIGIN },
    );
    const body = rendered.body.toLowerCase();
    for (const forbidden of ['dear ', 'wrote:', 'said:', 'policy number', 'claim number']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('tells the recipient not to reply', () => {
    // Otherwise somebody answers a customer into a mailbox nobody reads.
    expect(renderNotification(row(), { employeeOrigin: ORIGIN }).body).toContain(
      'Replies are not read',
    );
  });
});
