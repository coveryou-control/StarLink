/**
 * Email delivery (doc §29.2, §29.6, A-21, N-07).
 *
 * ## There is no email provider yet, and this says so
 *
 * A-21 assumes "an email transport is available for employee notification" and records
 * what happens if it is not: "V1-A ships with in-app notification only". N-07 names the
 * provider itself as an open question for the infrastructure owner.
 *
 * So this adapter exists to hold the seam, and its default sender REFUSES rather than
 * pretends. A stub that returned DELIVERED would be the worst possible failure here: the
 * outbox would mark every row SENT, the dead-letter count would stay at zero, §32.4's
 * alert would never fire, and nobody would discover that no email had ever been sent
 * until a customer complained about an SLA breach nobody was told about.
 *
 * Refusing is loud in exactly the right way. The rows accumulate as RETRYING, the depth
 * gauge climbs, and §29.6's "provider outage — rows accumulate as pending and drain on
 * recovery. Alerted on (§32.4) — a silent backlog is the failure mode that matters"
 * behaves as designed, because an absent provider IS an outage that has lasted since
 * the beginning.
 */
import type {
  DeliveryVerdict,
  HealthReport,
  NotificationTransport,
  RenderedNotification,
  Result,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

/** What a real provider implements. One method, so a vendor SDK stays behind it. */
export interface EmailSender {
  /**
   * @param to The RESOLVED address, passed explicitly.
   *
   * It is a parameter rather than something the sender looks up, because the transport
   * has already resolved it and re-resolving would let the two disagree. An earlier
   * version of this interface omitted it: the transport resolved the address, checked it
   * was present, and then handed the sender only the payload — whose
   * `recipientPrincipalId` is a UUID. Every send would have been addressed to a UUID.
   * The defect was invisible because no sender existed to receive the call.
   *
   * @param idempotencyKey Passed to providers that support one (§29.5). At-least-once is
   * the guarantee, so a provider that deduplicates turns a rare duplicate into none.
   */
  send(to: string, payload: RenderedNotification, idempotencyKey: string): Promise<void>;
}

export interface EmailTransportOptions {
  /** Absent until N-07 selects a provider. See the header for why that is not a stub. */
  readonly sender?: EmailSender;
  /** Addresses are held by the directory, not by this adapter. */
  readonly addressFor: (principalId: string) => Promise<string | undefined>;
}

export class EmailNotificationTransport implements NotificationTransport {
  readonly channel = 'EMAIL' as const;

  constructor(private readonly options: EmailTransportOptions) {}

  async deliver(
    payload: RenderedNotification,
    idempotencyKey: string,
  ): Promise<Result<DeliveryVerdict>> {
    /**
     * The PROVIDER is checked before the address, and the order matters.
     *
     * With neither configured, checking the address first would report every row as a
     * permanent failure and dead-letter it — blaming each recipient's directory record
     * for what is actually one missing provider. The rows would be gone by the time
     * N-07 is answered, and the dead-letter alert would be firing for the wrong reason.
     *
     * Reporting the absent provider is both more accurate and recoverable: §29.6's
     * "rows accumulate as pending and drain on recovery" is exactly the intended
     * behaviour, and an absent provider is an outage that has lasted since the beginning.
     */
    if (this.options.sender === undefined) {
      return err({
        code: 'EMAIL_PROVIDER_NOT_CONFIGURED',
        message:
          'no email provider is configured (A-21, N-07). Notifications remain queued rather ' +
          'than being reported as sent.',
        retryable: true,
        failureClass: 'FAIL_DEGRADED',
        correlationId: payload.recipientPrincipalId,
      });
    }

    const address = await this.options.addressFor(payload.recipientPrincipalId);

    if (address === undefined) {
      /**
       * §29.6: "Permanent failure (invalid address) — row dead-lettered, principal
       * flagged for administrative attention. Not retried forever."
       *
       * A missing address will not become present by retrying; somebody has to fix the
       * directory record. Dead-lettering surfaces that, where retrying would bury it.
       */
      return ok('PERMANENT_FAILURE');
    }

    try {
      await this.options.sender.send(address, { ...payload }, idempotencyKey);
      return ok('DELIVERED');
    } catch (error) {
      return err({
        code: 'EMAIL_SEND_FAILED',
        message: error instanceof Error ? error.message : 'send failed',
        retryable: true,
        failureClass: 'FAIL_DEGRADED',
        correlationId: payload.recipientPrincipalId,
      });
    }
  }

  async health(): Promise<HealthReport> {
    const configured = this.options.sender !== undefined;
    return {
      // DOWN, not DEGRADED: nothing can be delivered on this channel at all, and a
      // health report that softened that would let an operator believe email works.
      status: configured ? 'UP' : 'DOWN',
      authority: 'TEMPORARY_AUTHORITY',
      checkedAt: new Date().toISOString(),
      ...(configured
        ? {}
        : {
            detail:
              'no email provider configured (A-21, N-07). Employee email notifications are ' +
              'queued and undelivered; in-app is unaffected (§29.6).',
          }),
    };
  }
}
