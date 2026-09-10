/**
 * Push delivery (§29's `PUSH` channel), which had a name and no implementation.
 *
 * ## What a push may say
 *
 * §29 is explicit that a notification's payload is "structured, and never message
 * content": a notification tells somebody there is something to look at, and the thing
 * itself stays behind the authorization that guards it. That is a rule about every
 * channel and it BITES hardest here — a push is handed to Google and rendered on a device
 * that may be locked, shared, or mirrored to a watch on somebody else's desk.
 *
 * So the body is built from the event, never from the message. "Rahul mentioned you in
 * #Technology" is the most this may say; the words Rahul wrote are fetched by the client
 * after the notification is opened, through the authenticated API where `decide()` runs.
 * A push carrying the message would be a second read path with no authorization on it,
 * which is rule 2.
 *
 * `RenderedNotification.body` already obeys this — the renderer builds it from the
 * event — so this passes it along rather than composing anything new.
 *
 * ## One person, several devices
 *
 * A verdict is per NOTIFICATION and a send is per device, so the two have to be
 * reconciled. Delivered to any device is DELIVERED: the person has been told, and
 * retrying the whole notification because their spare laptop is unreachable would notify
 * them twice on the phone they are holding.
 *
 * A token FCM says is gone is deleted here rather than retried. It will never work again,
 * and the alternative is an outbox row that fails forever for a device somebody threw
 * away.
 *
 * ## No tokens is not a failure
 *
 * Somebody who has never granted permission has no rows, and that is the ordinary state
 * for most of the company. Reporting PERMANENT_FAILURE would dead-letter a notification
 * they are perfectly well receiving in-app; this reports DELIVERED for the same reason
 * §29.6 forbids treating a disconnected recipient as undeliverable — there is nothing
 * wrong and nothing to retry.
 */
import type {
  DeliveryVerdict,
  HealthReport,
  NotificationTransport,
  RenderedNotification,
  Result,
} from '@starlink/shared-contracts';
import { ok } from '@starlink/shared-contracts';
import type { FcmSender } from './fcm-sender.js';

/** Where the registration tokens live. Implemented against `identity.device_tokens`. */
export interface DeviceTokenStore {
  tokensFor(principalId: string): Promise<readonly string[]>;
  /** Called when FCM reports a token is gone. Deleting is the only correct response. */
  forget(token: string): Promise<void>;
}

export interface PushTransportOptions {
  /** Absent when the project is not configured — see the health report below. */
  readonly sender?: FcmSender;
  readonly tokens: DeviceTokenStore;
  /** Origin the deep link is resolved against, so the worker opens the right place. */
  readonly webOrigin: string;
}

export class PushNotificationTransport implements NotificationTransport {
  readonly channel = 'PUSH' as const;

  constructor(private readonly options: PushTransportOptions) {}

  async deliver(
    payload: RenderedNotification,
    idempotencyKey: string,
  ): Promise<Result<DeliveryVerdict>> {
    const { sender, tokens } = this.options;
    if (sender === undefined) {
      /*
         Queued, not failed. The same posture the email transport takes with no relay:
         rows accumulate as pending, the depth gauge climbs, and nothing is reported as
         sent that was not. An unconfigured channel must never look delivered.
      */
      return ok('RETRYABLE');
    }

    const registered = await tokens.tokensFor(payload.recipientPrincipalId);
    if (registered.length === 0) return ok('DELIVERED');

    const url =
      payload.deepLink === undefined
        ? undefined
        : new URL(payload.deepLink, this.options.webOrigin).toString();

    let anyDelivered = false;
    let lastRetryable: string | undefined;

    for (const token of registered) {
      const outcome = await sender.send(token, {
        title: payload.subject ?? 'StarLink',
        body: payload.body,
        ...(url !== undefined ? { url } : {}),
        /* One notification per thing, per device. Two mentions in the same conversation
           replace each other rather than stacking. */
        tag: idempotencyKey,
      });

      if (outcome.kind === 'DELIVERED') anyDelivered = true;
      else if (outcome.kind === 'TOKEN_GONE') await tokens.forget(token);
      else lastRetryable = outcome.reason;
    }

    if (anyDelivered) return ok('DELIVERED');
    /*
       Nothing got through. If every token was GONE the person has no devices left and
       there is nothing to retry — the rows are deleted and a later registration starts
       clean. Only a genuine transient failure is worth another attempt.
    */
    return ok(lastRetryable === undefined ? 'DELIVERED' : 'RETRYABLE');
  }

  async health(): Promise<HealthReport> {
    const configured = this.options.sender !== undefined;
    return {
      status: configured ? 'UP' : 'DOWN',
      authority: 'CANONICAL',
      checkedAt: new Date().toISOString(),
      detail: configured
        ? 'Firebase Cloud Messaging, HTTP v1.'
        : 'No Firebase project configured (SL_NOTIFY_PUSH_*). Push notifications remain queued.',
    };
  }
}
