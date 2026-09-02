/**
 * In-app notification delivery (doc §29.2, §29.6).
 *
 * ## In-app is not a transport in the way the others are
 *
 * §29.6: in-app "is not disableable — it is the unread mechanism". There is no provider to
 * be down, no address to be invalid and no rate limit to respect. Delivering in-app means
 * writing a row the recipient's client will read when it next looks, so this adapter
 * cannot fail transiently in the way email can, and it must never report
 * PERMANENT_FAILURE for a recipient who simply is not connected.
 *
 * That last point is the one worth guarding. §29.6's "away" is "no realtime connection
 * for a configured period… simply 'not currently connected'", and §21.9 forbids inferring
 * anything from a socket. A transport that treated a disconnected recipient as
 * undeliverable would dead-letter every notification for anyone who closed their laptop,
 * and they would come back to an empty inbox and a full dead-letter queue.
 *
 * So the only failure this adapter reports is a write that did not happen, and that is
 * RETRYABLE — the database being briefly unavailable is not a reason to give up on
 * telling somebody they have been assigned a customer.
 */
import type {
  DeliveryVerdict,
  HealthReport,
  NotificationTransport,
  RenderedNotification,
  Result,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

/** Where an in-app notification lands. Implemented against the outbox's own table. */
export interface InAppSink {
  /**
   * Records the notification for the recipient to collect.
   *
   * Idempotent on the key: §29.5 accepts at-least-once, so the same delivery arriving
   * twice must produce one badge rather than two.
   */
  record(payload: RenderedNotification, idempotencyKey: string): Promise<void>;
}

export class InAppNotificationTransport implements NotificationTransport {
  readonly channel = 'INAPP' as const;

  constructor(private readonly sink: InAppSink) {}

  async deliver(
    payload: RenderedNotification,
    idempotencyKey: string,
  ): Promise<Result<DeliveryVerdict>> {
    try {
      await this.sink.record(payload, idempotencyKey);
      return ok('DELIVERED');
    } catch (error) {
      /**
       * RETRYABLE, never PERMANENT_FAILURE.
       *
       * There is no such thing as an in-app address that is permanently wrong — the
       * recipient is a principal we already know exists. A write that failed is a write
       * to retry, and dead-lettering it would lose a notification over a momentary
       * database hiccup.
       */
      return err({
        code: 'INAPP_WRITE_FAILED',
        message: error instanceof Error ? error.message : 'in-app notification could not be recorded',
        retryable: true,
        // §29.3: "An adapter that is absent, misconfigured or failing costs a
        // NOTIFICATION. It never costs a MESSAGE."
        failureClass: 'FAIL_DEGRADED',
        correlationId: payload.recipientPrincipalId,
      });
    }
  }

  async health(): Promise<HealthReport> {
    /**
     * No external dependency to check — in-app is up whenever the application is.
     *
     * CANONICAL rather than TEMPORARY_AUTHORITY, and the distinction is real: every other
     * adapter here stands in for something that will later be replaced, whereas in-app
     * notification IS StarLink's own unread mechanism (§29.6) and has nothing behind it
     * to cut over to.
     */
    return { status: 'UP', authority: 'CANONICAL', checkedAt: new Date().toISOString() };
  }
}
