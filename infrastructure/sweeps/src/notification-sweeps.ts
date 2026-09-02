/**
 * The notification delivery worker (doc §29.3, §29.4, §29.6).
 *
 * §29.3's diagram puts this after the commit point: the calling operation writes outbox
 * rows and RETURNS — "it never waits for delivery". Everything here runs afterwards, and
 * the guarantee it provides is at-least-once (§29.5).
 *
 * ## The failure the design is built around
 *
 * §29.6, on a provider outage: **"Rows accumulate as pending and drain on recovery.
 * Alerted on (§32.4) — a silent backlog is the failure mode that matters."**
 *
 * So nothing here discards a row because a provider is down, and nothing marks a row sent
 * that was not. Those are the two ways a backlog becomes silent, and they are both worse
 * than the backlog.
 */
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { NotificationTransport, RenderedNotification } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { METRICS, metrics } from '@starlink/observability';
import { afterAttempt, type NotificationState, type RetryPolicy } from '@starlink/notifications';

import type { SweepOutcome } from './case-sweeps.js';

export interface OutboxPort {
  claimDue(limit: number, at: Timestamp): Promise<readonly PendingNotification[]>;
  markSent(notificationId: UUID, at: Timestamp): Promise<void>;
  markRetrying(notificationId: UUID, delayMs: number, errorCode: string, at: Timestamp): Promise<void>;
  markDeadLetter(notificationId: UUID, reason: string, at: Timestamp): Promise<void>;
  reclaimStalled(olderThan: Timestamp, limit: number): Promise<number>;
  counts(): Promise<{ pending: number; deadLetter: number }>;
}

export interface PendingNotification {
  readonly notificationId: UUID;
  readonly recipientId: UUID;
  readonly channel: string;
  readonly event: string;
  readonly targetRef?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: NotificationState;
  readonly attempts: number;
  /**
   * Further events folded into this one (§29.5). Zero for an ordinary notification; the
   * renderer adds one, because the row itself is the first event.
   */
  readonly coalescedCount?: number;
}

export interface NotificationSweepDeps {
  readonly outbox: OutboxPort;
  /** One per channel. A channel with no transport is left queued, never discarded. */
  readonly transports: ReadonlyMap<string, NotificationTransport>;
  readonly render: (row: PendingNotification) => RenderedNotification;
  readonly policy: RetryPolicy;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
  /** How long a PROCESSING row may sit before it is assumed abandoned. */
  readonly stalledAfterSeconds?: number;
}

export class NotificationDeliverySweep {
  constructor(private readonly deps: NotificationSweepDeps) {}

  async run(): Promise<SweepOutcome> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString() as Timestamp;

    /**
     * Recover rows a dead worker left PROCESSING before claiming new ones.
     *
     * Without this they are invisible to `claimDue` forever — the quietest possible way
     * to lose a notification, because the depth gauge counts them as in-flight and
     * nothing ever moves them. At-least-once means recovering is right even at the risk
     * of a duplicate.
     */
    const stalledBefore = new Date(
      Date.parse(at) - (this.deps.stalledAfterSeconds ?? 300) * 1000,
    ).toISOString() as Timestamp;
    const reclaimed = await this.deps.outbox.reclaimStalled(stalledBefore, this.deps.batchSize ?? 50);
    if (reclaimed > 0) {
      this.deps.logger.warn('reclaimed stalled notifications', {
        operation: 'sweep.notification',
        outcome: 'SUCCEEDED',
        detail: { reclaimed },
      });
    }

    const due = await this.deps.outbox.claimDue(this.deps.batchSize ?? 50, at);
    let acted = 0;

    for (const row of due) {
      const transport = this.deps.transports.get(row.channel);

      if (transport === undefined) {
        /**
         * No transport for this channel. Retried, not dead-lettered.
         *
         * The channel a customer is reached on is D-12, waiting on D-01; push is FUTURE
         * per §29.3's diagram. A row for an unbuilt channel is a row waiting for the
         * channel to be built, and dead-lettering it would discard notifications the
         * business will want the moment it answers.
         */
        await this.deps.outbox.markRetrying(row.notificationId, 15 * 60_000, 'NO_TRANSPORT', at);
        continue;
      }

      const delivered = await transport.deliver(
        this.deps.render(row),
        // §29.5: "Each row carries a stable key; adapters that support idempotency keys
        // receive it." The row id IS stable across retries, which is what makes a
        // deduplicating provider turn at-least-once into exactly-once.
        row.notificationId,
      );

      const outcome = delivered.ok
        ? delivered.value === 'DELIVERED'
          ? ({ outcome: 'DELIVERED' } as const)
          : delivered.value === 'PERMANENT_FAILURE'
            ? ({ outcome: 'PERMANENT_FAILURE', errorCode: 'PERMANENT_FAILURE' } as const)
            : ({ outcome: 'RETRYABLE', errorCode: 'RETRYABLE' } as const)
        : ({
            outcome: delivered.error.retryable ? 'RETRYABLE' : 'PERMANENT_FAILURE',
            errorCode: delivered.error.code,
          } as const);

      const step = afterAttempt(row, outcome, this.deps.policy);

      if (step.next === 'SENT') {
        await this.deps.outbox.markSent(row.notificationId, at);
        acted += 1;
      } else if (step.next === 'RETRYING') {
        await this.deps.outbox.markRetrying(
          row.notificationId,
          step.delayMs,
          outcome.outcome === 'DELIVERED' ? 'UNKNOWN' : outcome.errorCode,
          at,
        );
      } else {
        await this.deps.outbox.markDeadLetter(row.notificationId, step.reason, at);
        // Counted, because §32.4 alerts on "notification dead-letter count rising" and a
        // counter is what makes "rising" answerable.
        metrics.increment(METRICS.deadLetter, 1, { queue: 'notification' });
        this.deps.logger.error('notification dead-lettered', {
          operation: 'sweep.notification',
          outcome: 'FAILED',
          errorCode: step.reason,
          detail: {
            notificationId: row.notificationId,
            channel: row.channel,
            event: row.event,
            attempts: row.attempts + 1,
          },
        });
      }
    }

    /**
     * Published every tick, including zero.
     *
     * §29.6 names the silent backlog as "the failure mode that matters", and a gauge that
     * only appears when there is a backlog cannot distinguish "nothing pending" from
     * "the worker is not running" — which is exactly the distinction an operator needs.
     */
    const counts = await this.deps.outbox.counts();
    metrics.set(METRICS.notificationOutboxDepth, counts.pending);

    return { examined: due.length, acted };
  }
}
