/**
 * The domain-facing notification entry point (doc §29.1, §29.2, ADR-006).
 *
 * ## The ordering is the whole design
 *
 * §29.1: **"P-05 — the record is written first, then delivery is attempted. A
 * notification that fails must never mean a message that was not stored. Everything in
 * this section follows from that ordering, and reversing it would be the single worst
 * change anyone could make here."**
 *
 * So `notify` writes outbox rows and returns. It never calls a transport, never awaits a
 * provider, and never throws into its caller: a domain operation that assigned a
 * conversation has succeeded whether or not anybody could be told about it.
 *
 * ## Deciding, then writing
 *
 * Three questions in order, each of which can produce nothing:
 *
 *   1. Is this event notifiable at all? (§29.2's matrix — an event with no rule, or one
 *      on the "never notified" list, stops here.)
 *   2. Which channels, for this recipient? (preferences, away state, and the customer
 *      channel, which D-12 settled as email but which has no address or provider yet,
 *      so it still yields an empty list — see `matrix.ts`.)
 *   3. Has an equivalent notification already been written in this window? (§29.5's
 *      dedupe, enforced by the database rather than by a check here.)
 *
 * Producing nothing at any step is a normal outcome, not a failure. A system that
 * notified whenever it was unsure would train people to ignore it.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { PgNotificationOutbox } from '@starlink/database';
import type { Logger } from '@starlink/observability';
import {
  channelsFor,
  dedupeKeyFor,
  isNeverNotified,
  windowStartFor,
  type NotifiableEvent,
  type NotificationChannel,
  type RecipientContext,
} from '@starlink/notifications';
import { CONFIG, LOGGER, NOTIFICATION_OUTBOX } from '../tokens.js';
import type { ApiConfig } from '../config.js';

export interface NotifyRequest {
  readonly event: NotifiableEvent;
  readonly recipientId: UUID;
  readonly recipientKind: 'EMPLOYEE' | 'CUSTOMER';
  /** What it is about. Part of §29.5's `(recipient, event, target)` dedupe key. */
  readonly targetRef?: string;
  /**
   * Structured, and never message content (§32's redaction rules, and §29's model: a
   * notification says there is something to look at, and the thing stays behind the
   * authorization that guards it).
   */
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
  /** §29.6's away state — "simply 'not currently connected'", never presence. */
  readonly away?: boolean;
  /**
   * Channels this recipient has opted out of (§29.6), resolved by the caller.
   *
   * In-app never appears here: §29.6 makes it "the unread mechanism", not a preference,
   * and the schema behind `PgNotificationPreferences` cannot express it.
   */
  readonly optedOutOf?: readonly NotificationChannel[];
  /**
   * Distinguishes two notifications that are the same event about the same target and
   * must NOT collapse into one.
   *
   * §29.5's dedupe key is `(recipient, event, target)` within a window, which is right
   * for the case it names — five customer messages in a row producing one notification.
   * It is wrong where one event has stages: an SLA warning and the breach that follows it
   * are the same row of §29.2's table about the same conversation, and a case already
   * past its target when it becomes routable produces both within a tick or two of each
   * other. Suppressing the breach because the warning was just sent loses the one that
   * mattered.
   *
   * Absent by default, because widening the key by habit would defeat the dedupe.
   */
  readonly dedupeDiscriminator?: string;
}

@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_OUTBOX) private readonly outbox: PgNotificationOutbox,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Decides and writes. Returns how many rows were written, which may legitimately be
   * zero.
   *
   * Never throws. §29.3: "An adapter that is absent, misconfigured or failing costs a
   * NOTIFICATION. It never costs a MESSAGE." The same applies to this service — a caller
   * in the middle of a domain operation must not have that operation fail because a
   * notification could not be recorded.
   */
  async notify(request: NotifyRequest): Promise<number> {
    try {
      // §29.2's prohibition list, checked first so nothing on it can be reached by any
      // later branch.
      if (isNeverNotified(request.event)) return 0;

      const recipient: RecipientContext = {
        principalKind: request.recipientKind,
        away: request.away ?? false,
        optedOutOf: request.optedOutOf ?? [],
      };

      /**
       * §29.2 decides which channels this event SHOULD reach; `SL_NOTIFY_TRANSPORTS`
       * decides which are switched on. Both have to agree before a row is written.
       *
       * Filtering here rather than at delivery is the point. A disabled channel that
       * still enqueued would pile up rows nothing can deliver — which is exactly what
       * happened with EMAIL before this existed, holding the backlog alert permanently
       * red. A-21 sanctions the resulting behaviour: "V1-A ships with in-app notification
       * only."
       *
       * Note this is NOT how an unbuilt channel is handled. A channel that is enabled but
       * has no transport yet still enqueues and retries, so its rows drain when the
       * transport lands — see the sweep's NO_TRANSPORT branch. Disabled means "do not
       * raise this at all"; unbuilt means "raise it and wait".
       */
      const enabled = new Set(this.config.SL_NOTIFY_TRANSPORTS);
      const channels = channelsFor(request.event, recipient).filter((channel) =>
        enabled.has(channel),
      );
      // Empty is a real answer — a customer recipient yields none until D-31 and N-07,
      // and a staff member yields none for a channel nobody has switched on.
      if (channels.length === 0) return 0;

      const at = new Date().toISOString() as Timestamp;
      const window = windowStartFor(at, this.config.SL_NOTIFICATION_DEDUPE_WINDOW_SECONDS);

      let written = 0;
      for (const channel of channels) {
        // One row per channel. `dedupeKey` explains why the channel is part of the key.
        const accepted = await this.outbox.enqueue({
          notificationId: crypto.randomUUID() as UUID,
          recipientId: request.recipientId,
          recipientKind: request.recipientKind,
          channel,
          event: request.event,
          ...(request.targetRef !== undefined ? { targetRef: request.targetRef } : {}),
          payload: request.payload ?? {},
          dedupeKey: this.dedupeKey(request, channel, window),
          at,
        });
        if (accepted) written += 1;
      }
      return written;
    } catch (error) {
      // Swallowed deliberately, and logged loudly. See the method comment: a failure to
      // record a notification must never fail the operation that caused it.
      this.logger.error('notification could not be enqueued', {
        operation: 'notification.enqueue',
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        detail: {
          event: request.event,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return 0;
    }
  }

  /**
   * §29.5's `(recipient, event, target)` within a window, with the channel in front and
   * the optional stage discriminator behind.
   *
   * The CHANNEL is part of the key. Without it, writing the in-app row would suppress the
   * email one — the recipient would get a badge and no email, which is precisely the
   * combination "external if away" exists to avoid.
   */
  private dedupeKey(request: NotifyRequest, channel: string, window: string): string {
    const base = dedupeKeyFor(request.recipientId, request.event, request.targetRef, window);
    const suffix =
      request.dedupeDiscriminator === undefined ? '' : `:${request.dedupeDiscriminator}`;
    return `${channel}:${base}${suffix}`;
  }
}
