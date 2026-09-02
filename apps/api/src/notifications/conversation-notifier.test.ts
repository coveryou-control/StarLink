/**
 * §29.2's recipients, resolved.
 *
 * The table addresses roles; the outbox stores principals. Everything that can go wrong
 * in that translation is silent — a notification sent to the previous owner, a breach
 * that reached nobody because the lead lookup failed, a customer who received an
 * employee's notification. None of those produce an error anywhere; the only symptom is
 * somebody who was not told.
 *
 * So this file asserts WHO, by principal id, for every row that has a real trigger.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@starlink/observability';
import type { UUID } from '@starlink/shared-contracts';

import { ConversationNotifier } from './conversation-notifier.js';
import type { NotificationRecipients } from './recipients.js';
import type { NotificationService, NotifyRequest } from './notification-service.js';

const CONVERSATION = '018f2c5a-5e5e-7000-8000-000000000001' as UUID;
const OWNER = '018f2c5a-5e5e-7000-8000-000000000002' as UUID;
const NEW_OWNER = '018f2c5a-5e5e-7000-8000-000000000003' as UUID;
const LEAD = '018f2c5a-5e5e-7000-8000-000000000004' as UUID;
const OFFICER = '018f2c5a-5e5e-7000-8000-000000000005' as UUID;
const MESSAGE = '018f2c5a-5e5e-7000-8000-000000000006' as UUID;

const logger = createLogger({ service: 'conversation-notifier-test', sink: () => undefined });

class FakeService {
  readonly sent: NotifyRequest[] = [];
  async notify(request: NotifyRequest): Promise<number> {
    this.sent.push(request);
    return 1;
  }
}

const recipientsWith = (over: Partial<NotificationRecipients> = {}): NotificationRecipients =>
  ({
    ownerOf: async () => OWNER,
    teamOf: async () => 'team-a',
    leadsOfTeam: async () => [LEAD],
    leadsFor: async () => [LEAD],
    optedOutOf: async () => [],
    isAway: async () => false,
    ...over,
  }) as NotificationRecipients;

const notifierWith = (
  service: FakeService,
  recipients: NotificationRecipients = recipientsWith(),
): ConversationNotifier =>
  new ConversationNotifier(service as unknown as NotificationService, recipients, logger);

const recipientsOf = (service: FakeService, event: string): string[] =>
  service.sent.filter((r) => r.event === event).map((r) => r.recipientId);

describe('a transfer reaches both parties', () => {
  it('tells the incoming and the outgoing owner', async () => {
    // Telling only the receiver is the version that looks right in a demo: the outgoing
    // owner keeps the conversation on their list and nobody finds out for a day.
    const service = new FakeService();
    await notifierWith(service).transferred(CONVERSATION, OWNER, NEW_OWNER);

    expect(recipientsOf(service, 'TRANSFERRED').sort()).toEqual([OWNER, NEW_OWNER].sort());
  });

  it('does not tell the same person twice when the transfer is a no-op', async () => {
    const service = new FakeService();
    await notifierWith(service).transferred(CONVERSATION, OWNER, OWNER);
    expect(recipientsOf(service, 'TRANSFERRED')).toEqual([OWNER]);
  });

  it('tells the receiver when there was no previous owner', async () => {
    // A conversation claimed straight out of a queue has no outgoing party.
    const service = new FakeService();
    await notifierWith(service).transferred(CONVERSATION, undefined, NEW_OWNER);
    expect(recipientsOf(service, 'TRANSFERRED')).toEqual([NEW_OWNER]);
  });
});

describe('an escalation reaches the receiving officer and the lead', () => {
  it('tells both, and never the same person twice', async () => {
    const service = new FakeService();
    await notifierWith(service).escalated(CONVERSATION, OFFICER);
    expect(recipientsOf(service, 'ESCALATED_TO_YOUR_FUNCTION').sort()).toEqual(
      [OFFICER, LEAD].sort(),
    );
  });

  it('collapses the case where the receiving officer IS the lead', async () => {
    const service = new FakeService();
    await notifierWith(service, recipientsWith({ leadsFor: async () => [OFFICER] })).escalated(
      CONVERSATION,
      OFFICER,
    );
    expect(recipientsOf(service, 'ESCALATED_TO_YOUR_FUNCTION')).toEqual([OFFICER]);
  });
});

describe('the SLA stages', () => {
  it('sends a warning to the owner alone — §23.6’s "quiet nudge"', async () => {
    const service = new FakeService();
    await notifierWith(service).waitingBeyondStandard(CONVERSATION, 'WARNING', 'FIRST_RESPONSE');

    expect(recipientsOf(service, 'WAITING_BEYOND_STANDARD')).toEqual([OWNER]);
  });

  it('sends a breach to the owner and the team lead', async () => {
    const service = new FakeService();
    await notifierWith(service).waitingBeyondStandard(CONVERSATION, 'BREACH', 'FIRST_RESPONSE');

    expect(recipientsOf(service, 'WAITING_BEYOND_STANDARD').sort()).toEqual([OWNER, LEAD].sort());
  });

  it('discriminates the two stages so the breach is not deduped away', async () => {
    const service = new FakeService();
    const notifier = notifierWith(service);

    await notifier.waitingBeyondStandard(CONVERSATION, 'WARNING', 'FIRST_RESPONSE');
    await notifier.waitingBeyondStandard(CONVERSATION, 'BREACH', 'FIRST_RESPONSE');

    const toOwner = service.sent.filter((r) => r.recipientId === OWNER);
    expect(new Set(toOwner.map((r) => r.dedupeDiscriminator)).size).toBe(2);
  });

  it('reaches nobody customer-facing', async () => {
    /**
     * §23.6, in capitals in the source: "THE CUSTOMER IS NOT NOTIFIED OF ANY OF THIS. A
     * breach is our failure to manage, not news to deliver."
     */
    const service = new FakeService();
    await notifierWith(service).waitingBeyondStandard(CONVERSATION, 'BREACH', 'RESOLUTION');

    expect(service.sent.every((r) => r.recipientKind === 'EMPLOYEE')).toBe(true);
  });

  it('sends nothing when the conversation is unowned', async () => {
    // Waiting in a queue with no owner is what the queue view is for. There is nobody to
    // tell, which is different from failing to tell somebody.
    const service = new FakeService();
    await notifierWith(
      service,
      recipientsWith({ ownerOf: async () => undefined, leadsFor: async () => [] }),
    ).waitingBeyondStandard(CONVERSATION, 'WARNING', 'FIRST_RESPONSE');

    expect(service.sent).toHaveLength(0);
  });
});

describe('a customer reply reaches the owner', () => {
  it('resolves the owner rather than trusting a caller', async () => {
    const service = new FakeService();
    await notifierWith(service).customerReplied(CONVERSATION);
    expect(recipientsOf(service, 'CUSTOMER_REPLIED')).toEqual([OWNER]);
  });

  it('sends nothing when nobody owns it yet', async () => {
    const service = new FakeService();
    await notifierWith(service, recipientsWith({ ownerOf: async () => undefined })).customerReplied(
      CONVERSATION,
    );
    expect(service.sent).toHaveLength(0);
  });
});

describe('nothing here can fail its caller', () => {
  it('swallows a failed recipient lookup', async () => {
    /**
     * The lookups are database reads and can fail. Letting one propagate would mean a
     * transfer that was already committed reports an error to the person who performed
     * it — who would reasonably do it again.
     */
    const service = new FakeService();
    const broken = recipientsWith({
      ownerOf: async () => {
        throw new Error('database unavailable');
      },
    });

    await expect(notifierWith(service, broken).customerReplied(CONVERSATION)).resolves.toBeUndefined();
    expect(service.sent).toHaveLength(0);
  });

  it('swallows a failed lead lookup during a breach, and still tells the owner', async () => {
    const service = new FakeService();
    const broken = recipientsWith({
      leadsFor: async () => {
        throw new Error('role assignment read failed');
      },
    });

    await notifierWith(service, broken).waitingBeyondStandard(CONVERSATION, 'BREACH', 'RESOLUTION');

    // The owner was told before the lookup failed. Partial is better than nothing, and
    // the failure is on the log rather than in the caller's face.
    expect(recipientsOf(service, 'WAITING_BEYOND_STANDARD')).toEqual([OWNER]);
  });
});

describe('a mention reaches the people it names', () => {
  /**
   * The row must be a way IN, not only a way to be told.
   *
   * `targetRef` is what the notifications panel navigates on and what `render.ts` turns
   * into the email's link. `mentioned` was the one event that set a payload and no target,
   * so the panel drew a row that could be read and not followed — a defect with no error
   * anywhere, which is the same class of silent failure this whole file exists to catch.
   */
  it('carries the conversation as its target, one row per message', async () => {
    const service = new FakeService();
    await notifierWith(service).mentioned(CONVERSATION, MESSAGE, [OWNER, LEAD]);

    expect(service.sent.map((request) => request.recipientId)).toEqual([OWNER, LEAD]);
    for (const sent of service.sent) {
      expect(sent.event).toBe('MENTIONED');
      expect(sent.targetRef).toBe(CONVERSATION);
      // Per message, not per conversation: two mentions in one thread are two rows.
      expect(sent.dedupeDiscriminator).toBe(MESSAGE);
      // §29.2's outbox holds a reference, never the text.
      expect(sent.payload).toEqual({ conversationId: CONVERSATION, messageId: MESSAGE });
    }
  });
});

describe('a role change reaches the person it affects', () => {
  it('names the kind of change and carries no access facts', async () => {
    const service = new FakeService();
    await notifierWith(service).roleOrAccessChanged(OWNER, 'ROLE_GRANTED');

    const [sent] = service.sent;
    expect(sent?.recipientId).toBe(OWNER);
    expect(sent?.payload).toEqual({ change: 'ROLE_GRANTED' });
    // Not conversation-scoped: the change is about the person, not about a thread.
    expect(sent?.targetRef).toBeUndefined();
  });
});
