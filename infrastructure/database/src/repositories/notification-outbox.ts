/**
 * The notification outbox (doc §29.4, §29.5).
 *
 * §29.1's ordering governs everything here: **"the record is written first, then delivery
 * is attempted. A notification that fails must never mean a message that was not stored.
 * Everything in this section follows from that ordering, and reversing it would be the
 * single worst change anyone could make here."**
 *
 * ## Why an outbox and not a broker
 *
 * §29.4 answers this directly: StarLink in V1 has ONE consumer — its own worker — and a
 * volume bounded by roughly 200 employees plus a pilot department. A broker would add a
 * component to operate, monitor and back up, "in exchange for a guarantee the outbox
 * already provides". The trigger to revisit is named there too: fan-out to multiple
 * external consumers, or volume where polling becomes the bottleneck.
 *
 * ## Claiming is conditional, because two workers will race
 *
 * §29.5: "Two instances running the worker — rows claimed by conditional update, so a row
 * is delivered by one worker only." Every state change below carries a `WHERE state = …`
 * predicate for that reason. It is the same discipline the queue claim and the attachment
 * pipeline use, and for the same reason: a read followed by a write produces two winners
 * the first time two workers run.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { appendOutboxIn } from './outbox-writer.js';
import type { NotificationState } from '@starlink/notifications';

export interface OutboxRow {
  readonly notificationId: UUID;
  readonly recipientId: UUID;
  readonly recipientKind: string;
  readonly channel: string;
  readonly event: string;
  readonly targetRef?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: NotificationState;
  readonly attempts: number;
  readonly dedupeKey?: string;
  /**
   * How many FURTHER events were folded into this one (§29.5). Zero for an ordinary
   * single notification — the row's own existence is the first event, so the renderer
   * adds one to get "3 new messages".
   */
  readonly coalescedCount: number;
  /** When the recipient marked it read. Absent means unread (migration 0010). */
  readonly readAt?: string;
  /** For the list surface, which orders newest first. */
  readonly createdAt?: string;
}

const toRow = (row: Record<string, unknown>): OutboxRow => ({
  notificationId: row.notification_id as UUID,
  recipientId: row.recipient_id as UUID,
  recipientKind: row.recipient_kind as string,
  channel: row.channel as string,
  event: row.event_name as string,
  ...(row.target_ref !== null ? { targetRef: row.target_ref as string } : {}),
  payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
  state: row.state as NotificationState,
  attempts: row.attempts as number,
  ...(row.dedupe_key !== null ? { dedupeKey: row.dedupe_key as string } : {}),
  coalescedCount: (row.coalesced_count as number | null) ?? 0,
  ...(row.read_at != null ? { readAt: (row.read_at as Date).toISOString() } : {}),
  ...(row.created_at != null ? { createdAt: (row.created_at as Date).toISOString() } : {}),
});

export class PgNotificationOutbox {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Writes a pending row, or folds this event into the one that is already waiting.
   *
   * The uniqueness is the DATABASE's — a partial unique index on `dedupe_key` excluding
   * dead-lettered rows (migration 0001). Two writers racing therefore produce one row and
   * one notification, rather than a check-then-insert producing two. The index excludes
   * `DEAD_LETTER` deliberately: a notification that failed permanently must not block a
   * legitimate later attempt at the same event.
   *
   * ## Suppressing is not the same as coalescing
   *
   * §29.5 asks for **"'3 new messages', not three notifications"**. Dropping the second
   * and third gives one notification, and it gives the wrong one: "you have an update",
   * however many arrived, which is less use than the three it replaced because the
   * recipient cannot tell whether to look now.
   *
   * So a conflict INCREMENTS the waiting row's count — but only while it is still
   * `PENDING`. A row that has been claimed is already on its way to a provider, and
   * bumping its count then would change a message that has left. Once that happens the
   * next event is genuinely suppressed for the rest of the window, which is the honest
   * limit of window-based coalescing rather than a bug in it.
   *
   * Returns `false` where nothing new will be delivered — a fold or a suppression. Both
   * are normal outcomes, not errors; §29.5 exists to make them happen.
   */
  async enqueue(input: {
    notificationId: UUID;
    recipientId: UUID;
    recipientKind: string;
    channel: string;
    event: string;
    targetRef?: string;
    payload: Readonly<Record<string, unknown>>;
    dedupeKey?: string;
    at: Timestamp;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.notification_outbox
         (notification_id, recipient_id, recipient_kind, channel, event_name, target_ref,
          payload, state, next_attempt_at, dedupe_key, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'PENDING',$8,$9,$8)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state <> 'DEAD_LETTER'
       DO UPDATE SET coalesced_count = conversation.notification_outbox.coalesced_count + 1
         WHERE conversation.notification_outbox.state = 'PENDING'
       RETURNING (xmax = 0) AS inserted`,
      [
        input.notificationId,
        input.recipientId,
        input.recipientKind,
        input.channel,
        input.event,
        input.targetRef ?? null,
        JSON.stringify(input.payload),
        input.at,
        input.dedupeKey ?? null,
      ],
    );
    /**
     * `xmax = 0` distinguishes an INSERT from an UPDATE on the same statement — the row
     * version is zero only for a tuple this transaction created. Without it a fold and a
     * fresh write are indistinguishable, and every coalesced event would be reported as a
     * new notification.
     *
     * No row at all means the conflict target existed but the `WHERE` refused it: the
     * waiting row had already been claimed. Nothing new is delivered either way.
     */
    const inserted = result.rows[0]?.inserted === true;

    /**
     * §20.7's **Notification created**, published to the recipient's personal room (N-27).
     *
     * The principal room has been joinable since Phase 3 and nothing ever published to it,
     * so an in-app notification only appeared when the list was re-fetched — §20.7's
     * "notification list on load" fallback carrying the whole feature on its own.
     *
     * Only on a genuine INSERT. A coalesced fold (§29.5's "3 new messages") is not a new
     * notification, and announcing it as one would defeat the coalescing.
     *
     * Carries no content: §29's model is that a notification says there is something to
     * look at, and the thing stays behind the authorization that guards it.
     */
    if (inserted) {
      /**
       * A separate statement rather than the same transaction, and the asymmetry is
       * deliberate. §29.1's P-05 orders the NOTIFICATION record before its delivery; this
       * realtime hint is delivery, so it must never be able to fail the record. A crash
       * between the two loses a live badge update and loses no notification — §20.7 gives
       * this row "transport required: No" and "notification list on load" precisely so
       * that is survivable.
       */
      const client = await this.pool.connect();
      try {
        await appendOutboxIn(client, {
          eventName: 'notification.created.v1',
          aggregateType: 'principal',
          aggregateId: input.recipientId,
          payload: {
            notificationId: input.notificationId,
            recipientId: input.recipientId,
            event: input.event,
            ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
          },
          correlationId: `notify:${input.notificationId}`,
        });
      } finally {
        client.release();
      }
    }

    return inserted;
  }

  /**
   * Claims a batch of due rows for one worker.
   *
   * `FOR UPDATE SKIP LOCKED` for the same reason the queue claim uses it: a second worker
   * steps over a locked row rather than waiting behind it, so N workers do N times the
   * work rather than deadlocking. The `next_attempt_at <= $1` predicate is what makes
   * backoff real — a retrying row is invisible until its time comes.
   */
  async claimDue(limit: number, at: Timestamp): Promise<readonly OutboxRow[]> {
    const result = await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'PROCESSING'
        WHERE notification_id IN (
          SELECT notification_id FROM conversation.notification_outbox
           WHERE state IN ('PENDING','RETRYING')
             AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2)
        RETURNING *`,
      [at, limit],
    );
    return result.rows.map(toRow);
  }

  /** Delivered. Terminal, and the row is kept as the record that we told somebody. */
  async markSent(notificationId: UUID, at: Timestamp): Promise<void> {
    await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'SENT', sent_at = $2, attempts = attempts + 1
        WHERE notification_id = $1 AND state = 'PROCESSING'`,
      [notificationId, at],
    );
  }

  /** Failed transiently. Back to RETRYING with its next attempt in the future. */
  async markRetrying(notificationId: UUID, delayMs: number, errorCode: string, at: Timestamp): Promise<void> {
    await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'RETRYING',
              attempts = attempts + 1,
              last_error_code = $3,
              next_attempt_at = $4::timestamptz + make_interval(secs => $2)
        WHERE notification_id = $1 AND state = 'PROCESSING'`,
      [notificationId, delayMs / 1000, errorCode, at],
    );
  }

  /**
   * Dead-lettered. §29.6: "Row dead-lettered, principal flagged for administrative
   * attention. Not retried forever."
   *
   * The row is NOT deleted — it is the evidence that somebody was not told something, and
   * §32.4 alerts on the count. Deleting it would make the alert go quiet by making the
   * problem invisible, which is the wrong kind of quiet.
   */
  async markDeadLetter(notificationId: UUID, reason: string, _at: Timestamp): Promise<void> {
    await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'DEAD_LETTER', attempts = attempts + 1, last_error_code = $2, sent_at = NULL
        WHERE notification_id = $1 AND state = 'PROCESSING'`,
      [notificationId, reason],
    );
  }

  /**
   * Returns a stuck PROCESSING row to PENDING.
   *
   * A worker that claimed a row and then died leaves it PROCESSING forever, invisible to
   * `claimDue`. At-least-once (§29.5) means recovering it is right even at the risk of a
   * duplicate — "a rare duplicate email is acceptable, a lost assignment notification is
   * not."
   */
  async reclaimStalled(olderThan: Timestamp, limit: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'PENDING'
        WHERE notification_id IN (
          SELECT notification_id FROM conversation.notification_outbox
           WHERE state = 'PROCESSING' AND next_attempt_at <= $1
           ORDER BY next_attempt_at LIMIT $2)`,
      [olderThan, limit],
    );
    return result.rowCount ?? 0;
  }

  /** Depth and dead-letter count, for the gauges §32.4 alerts on. */
  async counts(): Promise<{ pending: number; deadLetter: number }> {
    const result = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE state IN ('PENDING','RETRYING','PROCESSING'))::int AS pending,
         count(*) FILTER (WHERE state = 'DEAD_LETTER')::int AS dead_letter
       FROM conversation.notification_outbox`,
    );
    return { pending: result.rows[0].pending as number, deadLetter: result.rows[0].dead_letter as number };
  }

  /**
   * §19.6's notification list — "server-owned; the client polls or receives an event".
   *
   * ## Three predicates, each load-bearing
   *
   * **`recipient_id = $1`** is the whole authorization. §20.7 authorizes the notification
   * event "personal room, self only", and the same rule applies to its HTTP fallback. The
   * caller passes the id from the SESSION, never from the request — there is no
   * conversation to run an object check against here, so this predicate is the boundary
   * rather than defence behind one.
   *
   * **`channel = 'INAPP'`** because this is the in-app surface. An EMAIL row is the same
   * notification travelling a second way; showing both would tell the recipient twice
   * about one thing and make the bell disagree with their inbox.
   *
   * **`state = 'SENT'`** because in-app delivery IS the row reaching SENT — the worker is
   * what moves it there. Listing PENDING rows would show a notification before the
   * pipeline had accepted it, and would make the state meaningless for the one channel
   * that has no external provider to fail. The cost is that the list lags a delivery tick
   * (`SL_SWEEP_NOTIFICATION_SECONDS`, 15s); §20.7 answers that by making the realtime
   * `Notification created` event the immediate path and this the "on load" fallback.
   *
   * Newest first, which the partial index in migration 0010 serves directly.
   */
  async listFor(
    recipientId: UUID,
    options: { limit: number; unreadOnly?: boolean },
  ): Promise<readonly OutboxRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.notification_outbox
        WHERE recipient_id = $1
          AND channel = 'INAPP'
          AND state = 'SENT'
          AND ($3::boolean IS NOT TRUE OR read_at IS NULL)
        ORDER BY created_at DESC
        LIMIT $2`,
      [recipientId, options.limit, options.unreadOnly ?? false],
    );
    return result.rows.map(toRow);
  }

  /** What the bell shows. Counted in the database so it cannot drift from the list. */
  async unreadCount(recipientId: UUID): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS unread
         FROM conversation.notification_outbox
        WHERE recipient_id = $1
          AND channel = 'INAPP'
          AND state = 'SENT'
          AND read_at IS NULL`,
      [recipientId],
    );
    return result.rows[0].unread as number;
  }

  /**
   * Marks one notification read, for its own recipient only.
   *
   * `recipient_id` is in the WHERE clause, not checked beforehand. A read-then-write
   * would let a caller mark somebody else's notification read in the window between the
   * two, and — more to the point — a predicate cannot be forgotten at a call site the way
   * a preceding check can.
   *
   * `read_at IS NULL` makes it idempotent: a second call is a no-op rather than a moved
   * timestamp, so a double-click does not rewrite when the person first saw it. Returns
   * whether anything changed, which is how the caller distinguishes "already read" from
   * "not yours" without being told which.
   */
  async markRead(recipientId: UUID, notificationId: UUID, at: Timestamp): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET read_at = $3
        WHERE notification_id = $2 AND recipient_id = $1 AND read_at IS NULL`,
      [recipientId, notificationId, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Clears the bell. Same recipient scoping, same idempotence. */
  async markAllRead(recipientId: UUID, at: Timestamp): Promise<number> {
    const result = await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET read_at = $2
        WHERE recipient_id = $1 AND channel = 'INAPP' AND state = 'SENT' AND read_at IS NULL`,
      [recipientId, at],
    );
    return result.rowCount ?? 0;
  }

  /** The dead letter, for the replay tooling the plan calls for. */
  async deadLettered(limit: number): Promise<readonly OutboxRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.notification_outbox
        WHERE state = 'DEAD_LETTER' ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toRow);
  }

  /**
   * Returns a dead-lettered row to the queue, once its cause is fixed.
   *
   * Attempts are RESET, because a replay after the provider is repaired should get the
   * full retry budget rather than one attempt and an immediate second death. The dedupe
   * key is cleared: the window it belonged to is long past, and keeping it would let a
   * newer notification for the same event collide with a replayed old one.
   */
  async replay(notificationId: UUID, at: Timestamp): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.notification_outbox
          SET state = 'PENDING', attempts = 0, next_attempt_at = $2,
              last_error_code = NULL, dedupe_key = NULL
        WHERE notification_id = $1 AND state = 'DEAD_LETTER'`,
      [notificationId, at],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
