/**
 * `NotificationService` — what gets written, and what deliberately does not.
 *
 * §29.2's governing sentence is a product decision with teeth: **"Notify only what
 * someone must act on. Everything else is an unread count."** Most of this file asserts
 * that nothing was written, because the failure mode of a notification system is not
 * silence — it is noise, after which the one that mattered is ignored too.
 *
 * The other half is §29.1's ordering: "a notification that fails must never mean a
 * message that was not stored". This service is called from the middle of domain
 * operations, so it must not be able to fail one.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@starlink/observability';
import type { UUID } from '@starlink/shared-contracts';

import { NotificationService, type NotifyRequest } from './notification-service.js';
import type { ApiConfig } from '../config.js';

const RECIPIENT = '018f2c5a-4f4f-7000-8000-00000000000a' as UUID;
const CONVERSATION = '018f2c5a-4f4f-7000-8000-00000000000b' as UUID;

const logger = createLogger({ service: 'notification-service-test', sink: () => undefined });

interface Written {
  readonly channel: string;
  readonly event: string;
  readonly dedupeKey?: string;
  readonly recipientId: string;
}

/** The outbox, with the same suppression semantics as the partial unique index. */
class FakeOutbox {
  readonly rows: Written[] = [];
  throws = false;
  private readonly keys = new Set<string>();

  async enqueue(input: {
    channel: string;
    event: string;
    dedupeKey?: string;
    recipientId: UUID;
  }): Promise<boolean> {
    if (this.throws) throw new Error('database unavailable');
    if (input.dedupeKey !== undefined) {
      if (this.keys.has(input.dedupeKey)) return false;
      this.keys.add(input.dedupeKey);
    }
    this.rows.push({
      channel: input.channel,
      event: input.event,
      recipientId: input.recipientId,
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    });
    return true;
  }
}

const serviceWith = (
  outbox: FakeOutbox,
  windowSeconds = 300,
  transports: readonly string[] = ['INAPP', 'EMAIL'],
): NotificationService =>
  new NotificationService(outbox as never, logger, {
    SL_NOTIFICATION_DEDUPE_WINDOW_SECONDS: windowSeconds,
    SL_NOTIFY_TRANSPORTS: transports,
  } as unknown as ApiConfig);

const request = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  event: 'CONVERSATION_ASSIGNED',
  recipientId: RECIPIENT,
  recipientKind: 'EMPLOYEE',
  targetRef: CONVERSATION,
  ...over,
});

describe('what is never notified', () => {
  it('writes nothing for an event on §29.2’s prohibition list', async () => {
    const outbox = new FakeOutbox();
    // BR-26's case: an internal note must never reach anyone customer-facing as a
    // notification. The prohibition is checked before anything else, so no later branch
    // can reach it.
    const written = await serviceWith(outbox).notify(
      request({ event: 'INTERNAL_NOTE_TO_CUSTOMER' as never }),
    );

    expect(written).toBe(0);
    expect(outbox.rows).toHaveLength(0);
  });

  it('writes nothing for an event with no rule', async () => {
    // Fail closed: adding an event to the enum must not make it notifiable by default.
    const outbox = new FakeOutbox();
    expect(await serviceWith(outbox).notify(request({ event: 'SOMETHING_NEW' as never }))).toBe(0);
    expect(outbox.rows).toHaveLength(0);
  });

  it('writes nothing for a CUSTOMER recipient', async () => {
    /**
     * D-12 chose email on 2026-08-28, and this still writes nothing: the channel has no
     * durable address (D-31) and no provider (N-07). Zero rows is the honest answer while
     * that holds — the alternative is a growing pile of undeliverable rows about
     * customers.
     */
    const outbox = new FakeOutbox();
    const written = await serviceWith(outbox).notify(
      request({ event: 'CUSTOMER_CONVERSATION_ANSWERED', recipientKind: 'CUSTOMER' }),
    );

    expect(written).toBe(0);
    expect(outbox.rows).toHaveLength(0);
  });
});

describe('channels', () => {
  it('writes in-app only when the recipient is connected', async () => {
    const outbox = new FakeOutbox();
    await serviceWith(outbox).notify(request({ away: false }));
    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP']);
  });

  it('adds email when the recipient is away, on a row that says "external if away"', async () => {
    const outbox = new FakeOutbox();
    await serviceWith(outbox).notify(request({ away: true }));
    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP', 'EMAIL']);
  });

  it('writes both regardless of away where §29.2 says "in-app + external"', async () => {
    const outbox = new FakeOutbox();
    await serviceWith(outbox).notify(request({ event: 'TRANSFERRED', away: false }));
    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP', 'EMAIL']);
  });

  it('honours an email opt-out but never suppresses in-app', async () => {
    // §29.6: in-app "is not disableable — it is the unread mechanism".
    const outbox = new FakeOutbox();
    await serviceWith(outbox).notify(request({ event: 'TRANSFERRED', optedOutOf: ['EMAIL'] }));
    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP']);
  });
});

describe('SL_NOTIFY_TRANSPORTS — only enabled channels are raised', () => {
  it('writes in-app only under the documented default', async () => {
    /**
     * §35 gives `SL_NOTIFY_TRANSPORTS` a default of `inapp`, and A-21 says why: "an email
     * transport is available for employee notification — if wrong: V1-A ships with in-app
     * notification only." TRANSFERRED is an "in-app + external" row, so this is the case
     * where the two disagree and configuration wins.
     */
    const outbox = new FakeOutbox();
    await serviceWith(outbox, 300, ['INAPP']).notify(request({ event: 'TRANSFERRED' }));

    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP']);
  });

  it('does not accumulate undeliverable rows for a disabled channel', async () => {
    /**
     * The defect this setting fixes. Before it, every "in-app + external" event wrote an
     * EMAIL row with no provider to deliver it; the rows sat RETRYING forever, the depth
     * gauge never returned to zero, and `NotificationBacklogNotDraining` was permanently
     * red — which is how an alert becomes background noise.
     */
    const outbox = new FakeOutbox();
    const service = serviceWith(outbox, 300, ['INAPP']);

    for (const event of ['TRANSFERRED', 'ESCALATED_TO_YOUR_FUNCTION', 'ROLE_OR_ACCESS_CHANGED'] as const) {
      await service.notify(request({ event }));
    }

    expect(outbox.rows.filter((r) => r.channel === 'EMAIL')).toHaveLength(0);
  });

  it('raises both once email is switched on', async () => {
    const outbox = new FakeOutbox();
    await serviceWith(outbox, 300, ['INAPP', 'EMAIL']).notify(request({ event: 'TRANSFERRED' }));
    expect(outbox.rows.map((r) => r.channel)).toEqual(['INAPP', 'EMAIL']);
  });

  it('writes nothing at all if every transport is switched off', async () => {
    // Not a state anyone should configure, but silence is the right answer to it —
    // certainly better than rows nothing will ever read.
    const outbox = new FakeOutbox();
    expect(await serviceWith(outbox, 300, []).notify(request())).toBe(0);
    expect(outbox.rows).toHaveLength(0);
  });
});

describe('the dedupe key', () => {
  it('collapses a repeat of the same event about the same target', async () => {
    // §29.5's case: a customer sends five messages in a row, the owner is told once.
    const outbox = new FakeOutbox();
    const service = serviceWith(outbox);

    for (let i = 0; i < 5; i += 1) await service.notify(request({ event: 'CUSTOMER_REPLIED' }));

    expect(outbox.rows).toHaveLength(1);
  });

  it('does not let the in-app row suppress the email row', async () => {
    /**
     * The badge-and-no-email failure. Both rows are the same (recipient, event, target)
     * in the same window and differ only by channel — without the channel in the key the
     * second would be suppressed, and "external if away" would silently never happen.
     */
    const outbox = new FakeOutbox();
    await serviceWith(outbox).notify(request({ away: true }));

    const keys = outbox.rows.map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('keeps an SLA warning and the breach that follows it apart', async () => {
    /**
     * A case already past its target when it becomes routable warns and breaches within a
     * tick or two. Both are §29.2's "waiting beyond a service standard" row about the
     * same conversation, so without the stage discriminator the breach lands inside the
     * warning's window and is suppressed — losing the one that mattered.
     */
    const outbox = new FakeOutbox();
    const service = serviceWith(outbox);

    await service.notify(
      request({ event: 'WAITING_BEYOND_STANDARD', dedupeDiscriminator: 'FIRST_RESPONSE:WARNING' }),
    );
    await service.notify(
      request({ event: 'WAITING_BEYOND_STANDARD', dedupeDiscriminator: 'FIRST_RESPONSE:BREACH' }),
    );

    expect(outbox.rows.filter((r) => r.channel === 'INAPP')).toHaveLength(2);
  });

  it('separates recipients, so both parties to a transfer are told', async () => {
    const outbox = new FakeOutbox();
    const service = serviceWith(outbox);
    const other = '018f2c5a-4f4f-7000-8000-00000000000c' as UUID;

    await service.notify(request({ event: 'TRANSFERRED' }));
    await service.notify(request({ event: 'TRANSFERRED', recipientId: other }));

    expect(new Set(outbox.rows.map((r) => r.recipientId)).size).toBe(2);
  });
});

describe('a notification can never cost an operation', () => {
  it('returns zero rather than throwing when the outbox is unavailable', async () => {
    /**
     * §29.3: "An adapter that is absent, misconfigured or failing costs a NOTIFICATION.
     * It never costs a MESSAGE." A caller in the middle of committing a transfer must not
     * have it fail because a notification could not be recorded.
     */
    const outbox = new FakeOutbox();
    outbox.throws = true;

    await expect(serviceWith(outbox).notify(request())).resolves.toBe(0);
  });
});

describe('the dedupe window is a window, not forever', () => {
  it('lets the same event through in a later window', async () => {
    // A genuinely new event an hour later must still notify. A dedupe that never expired
    // would mean one notification per conversation for its whole life.
    const outbox = new FakeOutbox();
    const service = serviceWith(outbox, 1);

    await service.notify(request({ event: 'CUSTOMER_REPLIED' }));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await service.notify(request({ event: 'CUSTOMER_REPLIED' }));

    expect(outbox.rows).toHaveLength(2);
  });
});
