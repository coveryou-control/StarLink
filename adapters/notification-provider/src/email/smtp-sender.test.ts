/**
 * The SMTP sender, and the defect it exposed on the way in.
 *
 * The transport resolved the recipient's address, checked it was present, and then called
 * `sender.send(payload, key)` — handing the sender only the payload, whose
 * `recipientPrincipalId` is a UUID. Every message would have been addressed to a UUID.
 * Nothing caught it because no sender existed to receive the call; the parameter list was
 * the only thing that could have, and it did not have the address in it.
 *
 * So the first test here is the one that would have failed then: the address the
 * transport resolved is the address the mail is sent to.
 */
import { describe, expect, it } from 'vitest';
import type { RenderedNotification, UUID } from '@starlink/shared-contracts';

import { SmtpEmailSender } from './smtp-sender.js';
import { EmailNotificationTransport } from './email-transport.js';

const RECIPIENT = '018f2c5a-e3e3-7000-8000-00000000000a' as UUID;

const payload = (over: Partial<RenderedNotification> = {}): RenderedNotification => ({
  recipientPrincipalId: RECIPIENT,
  channel: 'EMAIL',
  subject: 'A conversation was transferred to you',
  body: 'You have an update in StarLink.',
  ...over,
});

interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/** Stands in for nodemailer's transporter; records rather than connects. */
const recordingTransporter = (onSend?: () => void) => {
  const sent: SentMail[] = [];
  return {
    sent,
    transporter: {
      async sendMail(mail: SentMail) {
        onSend?.();
        sent.push(mail);
        return { messageId: mail.headers['Message-ID'] };
      },
    } as never,
  };
};

const senderWith = (t: ReturnType<typeof recordingTransporter>) =>
  new SmtpEmailSender({
    host: 'relay.internal.invalid',
    port: 587,
    secure: false,
    from: 'starlink@coveryou.example',
    transporter: t.transporter,
  });

describe('the resolved address is the address used', () => {
  it('sends to the address the transport resolved, not to the principal id', async () => {
    const t = recordingTransporter();
    const transport = new EmailNotificationTransport({
      sender: senderWith(t),
      addressFor: async () => 'zarina@coveryou.example',
    });

    const verdict = await transport.deliver(payload(), 'notification-1');

    expect(verdict.ok && verdict.value).toBe('DELIVERED');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('zarina@coveryou.example');
    // The regression, stated as an assertion: never the UUID.
    expect(t.sent[0]!.to).not.toBe(RECIPIENT);
  });
});

describe('the message itself', () => {
  it('carries the idempotency key as the Message-ID', async () => {
    /**
     * §29.5: "Each row carries a stable key; adapters that support idempotency keys
     * receive it." SMTP has no idempotency facility, so the key rides as the Message-ID,
     * which relays and mailboxes deduplicate on. Two deliveries of the same outbox row
     * therefore produce one mail in most mailboxes rather than two.
     */
    const t = recordingTransporter();
    const transport = new EmailNotificationTransport({
      sender: senderWith(t),
      addressFor: async () => 'zarina@coveryou.example',
    });

    await transport.deliver(payload(), 'row-abc');
    await transport.deliver(payload(), 'row-abc');

    const ids = t.sent.map((m) => m.headers['Message-ID']);
    expect(ids[0]).toBe('<row-abc@coveryou.example>');
    expect(ids[0]).toBe(ids[1]);
  });

  it('suppresses auto-responders', async () => {
    // A notification is not a conversation. Out-of-office replies to a no-reply sender
    // are traffic nobody reads addressed to a mailbox nobody monitors.
    const t = recordingTransporter();
    await senderWith(t).send('zarina@coveryou.example', payload(), 'row-1');
    expect(t.sent[0]!.headers['Auto-Submitted']).toBe('auto-generated');
  });

  it('falls back to a subject rather than sending a blank one', async () => {
    const t = recordingTransporter();
    await senderWith(t).send('zarina@coveryou.example', payload({ subject: undefined }), 'row-1');
    expect(t.sent[0]!.subject.length).toBeGreaterThan(0);
  });
});

describe('failures are classified by the transport, not the sender', () => {
  it('turns a relay failure into a retryable verdict, never a delivered one', async () => {
    /**
     * §29.6: "Provider outage — rows accumulate as pending and drain on recovery." The
     * sender throws; the transport is the one place that decides what a throw means, so
     * the retry policy lives in one place and cannot drift between senders.
     */
    const t = recordingTransporter(() => {
      throw new Error('ECONNREFUSED relay.internal.invalid:587');
    });
    const transport = new EmailNotificationTransport({
      sender: senderWith(t),
      addressFor: async () => 'zarina@coveryou.example',
    });

    const verdict = await transport.deliver(payload(), 'row-1');

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.code).toBe('EMAIL_SEND_FAILED');
    expect(verdict.error.retryable).toBe(true);
    expect(verdict.error.failureClass).toBe('FAIL_DEGRADED');
  });

  it('dead-letters a missing address without ever reaching the relay', async () => {
    // §29.6: "Permanent failure (invalid address) — row dead-lettered, principal flagged
    // for administrative attention. Not retried forever." A principal with no contact row
    // is this case, and retrying would bury it instead of surfacing it.
    const t = recordingTransporter();
    const transport = new EmailNotificationTransport({
      sender: senderWith(t),
      addressFor: async () => undefined,
    });

    const verdict = await transport.deliver(payload(), 'row-1');

    expect(verdict.ok && verdict.value).toBe('PERMANENT_FAILURE');
    expect(t.sent).toHaveLength(0);
  });

  it('reports the absent PROVIDER before it blames the address', async () => {
    /**
     * With neither configured, checking the address first would dead-letter every row as
     * an invalid address — blaming each recipient's directory record for what is one
     * missing relay, and destroying the rows before the relay arrives.
     */
    const transport = new EmailNotificationTransport({ addressFor: async () => undefined });
    const verdict = await transport.deliver(payload(), 'row-1');

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.code).toBe('EMAIL_PROVIDER_NOT_CONFIGURED');
    expect(verdict.error.retryable).toBe(true);
  });
});

describe('health', () => {
  it('reports UP once a relay is configured', async () => {
    const t = recordingTransporter();
    const transport = new EmailNotificationTransport({
      sender: senderWith(t),
      addressFor: async () => 'zarina@coveryou.example',
    });
    expect((await transport.health()).status).toBe('UP');
  });

  it('reports DOWN, not DEGRADED, with no relay', async () => {
    // Nothing can be delivered on this channel at all. A softer report would let an
    // operator believe email works.
    const transport = new EmailNotificationTransport({ addressFor: async () => undefined });
    expect((await transport.health()).status).toBe('DOWN');
  });
});
