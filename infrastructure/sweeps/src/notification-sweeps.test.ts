/**
 * PHASE 8 EXIT CRITERION: provider-down drains-on-recovery, and DLQ visibility.
 *
 * §29.6's sentence is the whole test file: **"Provider outage — rows accumulate as
 * pending and drain on recovery. Alerted on (§32.4) — a silent backlog is the failure
 * mode that matters."**
 *
 * Two ways to make a backlog silent, and both are worse than the backlog:
 *
 *   * marking a row SENT that was not sent, and
 *   * discarding a row because the provider is down.
 *
 * Everything below is arranged to prove neither happens.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '@starlink/observability';
import type {
  DeliveryVerdict,
  HealthReport,
  NotificationTransport,
  RenderedNotification,
  Result,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import type { NotificationState } from '@starlink/notifications';

import {
  NotificationDeliverySweep,
  type OutboxPort,
  type PendingNotification,
} from './notification-sweeps.js';

const logger = createLogger({ service: 'notification-sweeps-test', sink: () => undefined });
const RECIPIENT = '018f2c5a-6070-7000-8000-00000000000a' as UUID;

/** An in-memory outbox with the same conditional semantics as the SQL one. */
class FakeOutbox implements OutboxPort {
  readonly rows = new Map<UUID, PendingNotification & { nextAttemptAt: number; error?: string }>();

  add(channel: string, id = crypto.randomUUID() as UUID): UUID {
    this.rows.set(id, {
      notificationId: id,
      recipientId: RECIPIENT,
      channel,
      event: 'CONVERSATION_ASSIGNED',
      payload: {},
      state: 'PENDING',
      attempts: 0,
      nextAttemptAt: 0,
    });
    return id;
  }

  async claimDue(limit: number, at: Timestamp): Promise<readonly PendingNotification[]> {
    const now = Date.parse(at);
    const due = [...this.rows.values()]
      .filter((r) => (r.state === 'PENDING' || r.state === 'RETRYING') && r.nextAttemptAt <= now)
      .slice(0, limit);
    for (const row of due) this.rows.set(row.notificationId, { ...row, state: 'PROCESSING' });
    return due;
  }

  async markSent(id: UUID): Promise<void> {
    const row = this.rows.get(id)!;
    this.rows.set(id, { ...row, state: 'SENT', attempts: row.attempts + 1 });
  }

  async markRetrying(id: UUID, delayMs: number, errorCode: string, at: Timestamp): Promise<void> {
    const row = this.rows.get(id)!;
    this.rows.set(id, {
      ...row,
      state: 'RETRYING',
      attempts: row.attempts + 1,
      error: errorCode,
      nextAttemptAt: Date.parse(at) + delayMs,
    });
  }

  async markDeadLetter(id: UUID, reason: string): Promise<void> {
    const row = this.rows.get(id)!;
    this.rows.set(id, { ...row, state: 'DEAD_LETTER', attempts: row.attempts + 1, error: reason });
  }

  async reclaimStalled(olderThan: Timestamp, limit: number): Promise<number> {
    const cutoff = Date.parse(olderThan);
    let n = 0;
    for (const row of [...this.rows.values()]) {
      if (row.state === 'PROCESSING' && row.nextAttemptAt <= cutoff && n < limit) {
        this.rows.set(row.notificationId, { ...row, state: 'PENDING' });
        n += 1;
      }
    }
    return n;
  }

  async counts(): Promise<{ pending: number; deadLetter: number }> {
    const all = [...this.rows.values()];
    return {
      pending: all.filter((r) => ['PENDING', 'RETRYING', 'PROCESSING'].includes(r.state)).length,
      deadLetter: all.filter((r) => r.state === 'DEAD_LETTER').length,
    };
  }

  stateOf(id: UUID): NotificationState {
    return this.rows.get(id)!.state;
  }
}

/** A transport whose availability the test controls. */
class ControllableTransport implements NotificationTransport {
  readonly channel = 'EMAIL' as const;
  up = true;
  delivered = 0;

  async deliver(_payload: RenderedNotification, _key: string): Promise<Result<DeliveryVerdict>> {
    if (!this.up) {
      return err({
        code: 'PROVIDER_DOWN',
        message: 'provider unavailable',
        retryable: true,
        failureClass: 'FAIL_DEGRADED',
        correlationId: 'test',
      });
    }
    this.delivered += 1;
    return ok('DELIVERED');
  }

  async health(): Promise<HealthReport> {
    return {
      status: this.up ? 'UP' : 'DOWN',
      authority: 'MOCK',
      checkedAt: new Date().toISOString(),
    };
  }
}

const sweepFor = (
  outbox: OutboxPort,
  transport: NotificationTransport,
  maxAttempts = 5,
  now: () => Date = () => new Date(),
): NotificationDeliverySweep =>
  new NotificationDeliverySweep({
    outbox,
    transports: new Map([[transport.channel, transport]]),
    render: (row) => ({
      recipientPrincipalId: row.recipientId,
      channel: row.channel as never,
      body: 'you have work',
    }),
    policy: { maxAttempts },
    logger,
    now,
  });

describe('provider down, then recovery (§29.6)', () => {
  it('accumulates rows while the provider is down, and never marks them sent', async () => {
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    transport.up = false;
    const ids = [outbox.add('EMAIL'), outbox.add('EMAIL'), outbox.add('EMAIL')];

    const result = await sweepFor(outbox, transport).run();

    expect(result.acted).toBe(0);
    expect(transport.delivered).toBe(0);
    for (const id of ids) {
      // RETRYING, not SENT and not gone. Marking a row sent that was not sent is one of
      // the two ways a backlog becomes silent.
      expect(outbox.stateOf(id)).toBe('RETRYING');
    }
    expect((await outbox.counts()).pending).toBe(3);
  });

  it('drains on recovery, delivering everything that accumulated', async () => {
    /**
     * The exit criterion. The rows were still there, still pending, and the recovery
     * needed no intervention — which is the whole argument for the outbox over a
     * fire-and-forget send (§29.4).
     */
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    transport.up = false;
    const ids = [outbox.add('EMAIL'), outbox.add('EMAIL'), outbox.add('EMAIL')];

    // The outage.
    let clock = Date.now();
    const now = (): Date => new Date(clock);
    await sweepFor(outbox, transport, 5, now).run();

    // Time passes so the backoff elapses, then the provider returns.
    clock += 60 * 60_000;
    transport.up = true;
    const recovery = await sweepFor(outbox, transport, 5, now).run();

    expect(recovery.acted).toBe(3);
    expect(transport.delivered).toBe(3);
    for (const id of ids) expect(outbox.stateOf(id)).toBe('SENT');
    expect((await outbox.counts()).pending).toBe(0);
  });

  it('respects backoff — a retrying row is invisible until its time comes', async () => {
    // Without this the worker would spin against a dead provider at full speed, which is
    // how an outage becomes a self-inflicted denial of service on recovery.
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    transport.up = false;
    outbox.add('EMAIL');

    const clock = Date.now();
    const now = (): Date => new Date(clock);
    await sweepFor(outbox, transport, 5, now).run();

    transport.up = true;
    // Same instant: the row's next attempt is in the future, so nothing is claimed.
    const immediate = await sweepFor(outbox, transport, 5, now).run();
    expect(immediate.examined).toBe(0);
    expect(transport.delivered).toBe(0);
  });
});

describe('the dead letter (§29.6, §32.4)', () => {
  it('dead-letters after the attempt limit, and keeps the row as evidence', async () => {
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    transport.up = false;
    const id = outbox.add('EMAIL');

    let clock = Date.now();
    const now = (): Date => new Date(clock);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sweepFor(outbox, transport, 3, now).run();
      clock += 60 * 60_000;
    }

    expect(outbox.stateOf(id)).toBe('DEAD_LETTER');
    // Not deleted. The row IS the evidence that somebody was not told something, and
    // §32.4 alerts on the count — deleting it would silence the alert by hiding the fact.
    expect((await outbox.counts()).deadLetter).toBe(1);
  });

  it('dead-letters an invalid address immediately, without spending retries', async () => {
    const outbox = new FakeOutbox();
    const permanent: NotificationTransport = {
      channel: 'EMAIL',
      async deliver() {
        return ok('PERMANENT_FAILURE');
      },
      async health() {
        return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
      },
    };
    const id = outbox.add('EMAIL');

    await sweepFor(outbox, permanent).run();

    expect(outbox.stateOf(id)).toBe('DEAD_LETTER');
    expect(outbox.rows.get(id)!.attempts).toBe(1);
  });
});

describe('a channel with no transport is queued, never discarded', () => {
  it('retries rather than dead-letters', async () => {
    /**
     * The customer channel is D-12, waiting on D-01; push is FUTURE per §29.3's diagram.
     * A row for an unbuilt channel is a row waiting for the channel to exist, and
     * discarding it would throw away notifications the business will want the moment it
     * answers.
     */
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    const id = outbox.add('WHATSAPP');

    await sweepFor(outbox, transport).run();

    expect(outbox.stateOf(id)).toBe('RETRYING');
    expect(outbox.rows.get(id)!.error).toBe('NO_TRANSPORT');
  });
});

describe('a worker that died mid-delivery', () => {
  it('recovers rows left PROCESSING, accepting a possible duplicate', async () => {
    /**
     * §29.5: "The worker delivers, then crashes before marking the row… At-least-once is
     * the honest guarantee — a rare duplicate email is acceptable, a lost assignment
     * notification is not."
     *
     * A row left PROCESSING is invisible to `claimDue` forever, which is the quietest way
     * to lose a notification: the depth gauge counts it as in-flight and nothing moves it.
     */
    const outbox = new FakeOutbox();
    const transport = new ControllableTransport();
    const id = outbox.add('EMAIL');
    // Simulate the crash: claimed, never resolved.
    outbox.rows.set(id, { ...outbox.rows.get(id)!, state: 'PROCESSING', nextAttemptAt: 0 });

    const result = await sweepFor(outbox, transport).run();

    expect(outbox.stateOf(id)).toBe('SENT');
    expect(result.acted).toBe(1);
  });
});
