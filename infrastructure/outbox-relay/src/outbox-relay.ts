/**
 * The transactional outbox relay (ADR-006, brief §17, doc §29.4).
 *
 * This is the seam between durable state and everything best-effort. Domain code
 * commits a message and an outbox row in ONE transaction and stops there; this relay
 * reads committed rows afterwards and publishes them. That ordering is what makes
 * "persist before publish" true rather than aspirational (P-05): a crash between the
 * two leaves a committed message and an unpublished row, which is recoverable, instead
 * of a delivered event for a message that does not exist, which is not.
 *
 * Guarantees, and their limits:
 *
 *   * **At-least-once, never at-most-once.** A crash after publishing but before
 *     marking the row will republish it. Consumers deduplicate on `event_id`; the
 *     client discards an event whose id it already holds (§19.5). A rare duplicate is
 *     acceptable; a lost assignment notification is not (§29.5).
 *   * **Bounded retries with backoff, then dead-letter.** Rows that keep failing stop
 *     consuming the loop and become visible instead of invisible (§32.4 alerts on the
 *     dead-letter count).
 *   * **Safe to run more than once.** Claiming uses `FOR UPDATE SKIP LOCKED`, so two
 *     relays share the work rather than double-publishing. This refines ADR-006's
 *     "singleton via advisory lock": SKIP LOCKED removes the single point of failure
 *     and the bottleneck, and costs nothing here because per-conversation ordering is
 *     already recovered client-side by the sequence-gap rule (§20.8) rather than
 *     depending on publish order.
 */
import type pg from 'pg';
import type {
  DomainEventEnvelope,
  EventPublisher,
  RealtimeBackplane,
  RealtimeChannel,
  RealtimeEvent,
  UUID,
} from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';

export interface OutboxRelayOptions {
  readonly pool: pg.Pool;
  readonly backplane: RealtimeBackplane;
  readonly publisher: EventPublisher;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export interface DrainResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
}

interface OutboxRow {
  outbox_id: UUID;
  event_name: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: UUID;
  payload: Record<string, unknown>;
  correlation_id: string;
  attempts: number;
  created_at: Date;
}

/**
 * Which events are staff-only.
 *
 * Marked at the relay so the gateway can refuse to fan them out to a customer
 * connection at publish time — the worst leak available in the product (§27.16).
 * Defaulting to staff-only would be safe but useless; defaulting to customer-visible
 * would be dangerous, so the set is explicit and small enough to review.
 */
const CUSTOMER_VISIBLE_EVENTS = new Set([
  'conversation.resolved.v1',
  'conversation.reopened.v1',
  'customer.reply.received.v1',
]);

const isStaffOnly = (eventName: string, payload: Record<string, unknown>): boolean => {
  // An internal note is staff-only regardless of which event carried it.
  if (payload.visibility === 'INTERNAL') return true;
  return !CUSTOMER_VISIBLE_EVENTS.has(eventName);
};

/** Maps an outbox row onto the channel its audience is listening on. */
const channelFor = (row: OutboxRow): RealtimeChannel => {
  /**
   * §20.7's queue-arrival row is about a CONVERSATION and addressed to a TEAM.
   *
   * The audience is read from the payload rather than from the aggregate because
   * `outbox.aggregate_id` is a uuid and a team id is text. Keeping the aggregate as the
   * conversation also keeps the row's lineage honest: the thing that happened is that a
   * conversation was queued, and the team room is merely who needs to hear about it.
   */
  if (row.event_name === 'conversation.queue.arrived.v1') {
    const teamId = row.payload.teamId;
    if (typeof teamId === 'string' && teamId !== '') return { kind: 'TEAM', teamId };
    // A queue-arrival with no team has nobody to tell. CONTROL rather than a guessed
    // room: publishing to the wrong team's queue view is worse than publishing nowhere.
    return { kind: 'CONTROL' };
  }
  if (row.aggregate_type === 'conversation') {
    return { kind: 'CONVERSATION', conversationId: row.aggregate_id };
  }
  if (row.aggregate_type === 'principal') {
    return { kind: 'PRINCIPAL', principalId: row.aggregate_id };
  }
  return { kind: 'CONTROL' };
};

/** Exponential, capped. A provider outage should back off, not hammer. */
const backoffSeconds = (attempts: number): number => Math.min(2 ** attempts, 300);

export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Drains one batch.
   *
   * Each row is claimed, published and settled inside ONE transaction, so a crash
   * mid-batch releases the lock and the next relay picks the row up unchanged.
   */
  async drainOnce(): Promise<DrainResult> {
    const client = await this.options.pool.connect();
    let claimed: number;
    let published = 0;
    let retried = 0;
    let deadLettered = 0;

    try {
      await client.query('BEGIN');

      const rows = await client.query<OutboxRow>(
        `SELECT outbox_id, event_name, event_version, aggregate_type, aggregate_id,
                payload, correlation_id, attempts, created_at
           FROM conversation.outbox
          WHERE state IN ('PENDING', 'PROCESSING')
            AND next_attempt_at <= now()
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      claimed = rows.rowCount ?? 0;

      for (const row of rows.rows) {
        const delivered = await this.deliver(row);

        if (delivered) {
          await client.query(
            `UPDATE conversation.outbox
                SET state = 'PUBLISHED', published_at = now(), attempts = attempts + 1
              WHERE outbox_id = $1`,
            [row.outbox_id],
          );
          published += 1;
          continue;
        }

        const attempts = row.attempts + 1;
        if (attempts >= this.maxAttempts) {
          // Visible rather than invisible: a silently stuck event is the failure mode
          // that matters, so it is alerted on (§32.4) rather than retried forever.
          await client.query(
            `UPDATE conversation.outbox
                SET state = 'DEAD_LETTER', attempts = $2, last_error_code = 'MAX_ATTEMPTS'
              WHERE outbox_id = $1`,
            [row.outbox_id, attempts],
          );
          deadLettered += 1;
          this.options.logger.error('outbox row dead-lettered', {
            correlationId: row.correlation_id,
            operation: row.event_name,
            outcome: 'FAILED',
            errorCode: 'MAX_ATTEMPTS',
          });
        } else {
          await client.query(
            `UPDATE conversation.outbox
                SET state = 'PENDING', attempts = $2,
                    next_attempt_at = now() + ($3 || ' seconds')::interval
              WHERE outbox_id = $1`,
            [row.outbox_id, attempts, backoffSeconds(attempts)],
          );
          retried += 1;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return { claimed, published, retried, deadLettered };
  }

  /**
   * Publishes one row to both destinations.
   *
   * The realtime backplane is best-effort — a client that missed the event is correct
   * after a re-read (FR-RT-1) — but the enterprise event fabric is not: CCS must
   * eventually receive it, so a failure there means the row is retried.
   */
  private async deliver(row: OutboxRow): Promise<boolean> {
    const occurredAt = row.created_at.toISOString();

    const realtime: RealtimeEvent = {
      eventId: row.outbox_id,
      name: row.event_name,
      channel: channelFor(row),
      ...(typeof row.payload.seq === 'number' ? { seq: row.payload.seq } : {}),
      occurredAt,
      correlationId: row.correlation_id,
      payload: row.payload,
      staffOnly: isStaffOnly(row.event_name, row.payload),
    };

    const envelope: DomainEventEnvelope = {
      eventId: row.outbox_id,
      name: row.event_name,
      version: row.event_version,
      occurredAt,
      correlationId: row.correlation_id,
      payload: row.payload,
    };

    // Realtime first and non-fatal: losing it costs latency, not correctness.
    const fanout = await this.options.backplane.publish(realtime);
    if (!fanout.ok) {
      this.options.logger.warn('realtime publish failed', {
        correlationId: row.correlation_id,
        operation: row.event_name,
        outcome: 'FAILED',
        errorCode: fanout.error.code,
      });
    }

    const enterprise = await this.options.publisher.publish([envelope]);
    if (!enterprise.ok) {
      this.options.logger.warn('event publication failed, will retry', {
        correlationId: row.correlation_id,
        operation: row.event_name,
        outcome: 'FAILED',
        errorCode: enterprise.error.code,
      });
      return false;
    }
    return true;
  }

  /** Depth and oldest age, for the alerts in infrastructure/monitoring/alerts.yml. */
  async metrics(): Promise<{ depth: number; oldestAgeSeconds: number; deadLettered: number }> {
    const result = await this.options.pool.query(
      // FILTER binds to the AGGREGATE, not to the surrounding expression — writing
      // `EXTRACT(... min(x)) FILTER (...)` is a syntax error, which is easy to miss
      // because it reads naturally.
      `SELECT
         count(*) FILTER (WHERE state IN ('PENDING','PROCESSING'))::int AS depth,
         COALESCE(EXTRACT(EPOCH FROM (
           now() - min(created_at) FILTER (WHERE state IN ('PENDING','PROCESSING'))
         )), 0)::int AS oldest,
         count(*) FILTER (WHERE state = 'DEAD_LETTER')::int AS dead
       FROM conversation.outbox`,
    );
    const row = result.rows[0];
    return { depth: row.depth, oldestAgeSeconds: row.oldest, deadLettered: row.dead };
  }
}
