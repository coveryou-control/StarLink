/**
 * Assembles the facts an SLA clock is computed from (doc §23.5, §24.11).
 *
 * Reads only. Every value returned is an OBSERVATION — when a clock started, when it
 * stopped, when the case was waiting — and nothing here computes elapsed time, a
 * deadline or a breach. That division is what makes §23.5's "a holiday added
 * retrospectively re-derives correctly" true: correcting a calendar changes the answer
 * without changing a single row this file reads.
 *
 * The three clocks, and where each one's start and stop actually come from:
 *
 *   * **First response** starts when the customer's first message "becomes routable" —
 *     which is the queue entry's enqueue time for a case placed during opening hours,
 *     and the next opening for one that arrived after hours. The caller resolves that,
 *     because it needs the calendar and this file does not read calendars.
 *   * **First response** stops at the first CUSTOMER-VISIBLE reply from an employee.
 *     §23.5: "An internal note does not stop the first-response clock. Only a message the
 *     customer can actually see counts, or the metric measures internal activity rather
 *     than service." That is a `visibility = 'CUSTOMER_VISIBLE'` predicate in SQL below,
 *     not a filter applied afterwards.
 *   * **Resolution** shares the start and stops when the case reaches RESOLVED.
 *   * **Escalation** starts at the most recent escalation and stops at the first
 *     customer-visible reply after it.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { PauseSpan, SlaTarget } from '@starlink/sla';

/** A target row with the scope it was configured against (D-22: per category or team). */
export interface ScopedSlaTarget extends SlaTarget {
  readonly scopeKind: string;
  readonly scopeId: string;
}

export interface CaseClockFacts {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  readonly categoryId?: string;
  readonly teamId?: string;
  /** When the conversation arrived. NOT the clock start — see the header. */
  readonly arrivedAt: Timestamp;
  /**
   * Recorded on the queue entry at the moment of arrival (§23.5): whether the clock
   * should have started is "a fact about the moment of arrival, and a calendar corrected
   * next week must not silently rewrite it".
   */
  readonly afterHours: boolean;
  /** The first reply the customer could actually see. Stops the first-response clock. */
  readonly firstCustomerVisibleReplyAt?: Timestamp;
  readonly resolvedAt?: Timestamp;
  readonly escalatedAt?: Timestamp;
  /** Spans in WAITING_CUSTOMER, from the append-only state history. */
  readonly waitingOnCustomerSpans: readonly PauseSpan[];
  readonly state: string;
}

export class PgSlaReader {
  constructor(private readonly pool: pg.Pool) {}

  /** Every target that could apply to a case, for the caller to select from. */
  async targetsFor(
    scope: { categoryId?: string; teamId?: string },
    at: Timestamp,
  ): Promise<readonly ScopedSlaTarget[]> {
    const result = await this.pool.query(
      `SELECT scope_kind, scope_id, clock, target_seconds, basis, warning_pct, is_seed_placeholder
         FROM conversation.sla_targets
        WHERE ((scope_kind = 'CATEGORY' AND scope_id = $1)
            OR (scope_kind = 'TEAM' AND scope_id = $2))
          -- Effective-dated, half-open, like every other configuration entity. A target
          -- corrected next month must not change what we promised last month.
          AND effective_from <= $3
          AND (effective_to IS NULL OR effective_to > $3)`,
      [scope.categoryId ?? '', scope.teamId ?? '', at],
    );

    return result.rows.map((row) => ({
      scopeKind: row.scope_kind as string,
      scopeId: row.scope_id as string,
      clock: row.clock as SlaTarget['clock'],
      targetSeconds: row.target_seconds as number,
      basis: row.basis as SlaTarget['basis'],
      warningPct: row.warning_pct as number,
      provisional: row.is_seed_placeholder as boolean,
    }));
  }

  /**
   * The observations for one conversation.
   *
   * One query for the case row, one for the first customer-visible reply, one for the
   * waiting spans. Not a single joined query: the reply lookup is `ORDER BY … LIMIT 1`
   * over a filtered index and the spans are a small set per conversation, and joining
   * them would multiply rows for no gain.
   */
  async factsFor(conversationId: UUID): Promise<CaseClockFacts | undefined> {
    const head = await this.pool.query(
      `SELECT c.conversation_id, c.case_id, c.state, c.created_at,
              sc.category_id, sc.owning_team_id, sc.resolved_at, sc.escalation_level,
              COALESCE(q.after_hours, false) AS after_hours,
              q.enqueued_at
         FROM conversation.conversations c
         LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
         LEFT JOIN conversation.queue_entries q ON q.conversation_id = c.conversation_id
        WHERE c.conversation_id = $1
        LIMIT 1`,
      [conversationId],
    );

    const row = head.rows[0];
    if (row === undefined) return undefined;

    /**
     * The first reply the CUSTOMER COULD SEE. The visibility predicate is the whole
     * point of this query: an internal note must not stop the clock, and filtering after
     * the fact would mean the earliest row wins whether or not it was visible.
     *
     * `sender_kind <> 'CUSTOMER'` because the customer's own messages are not a response
     * to themselves.
     */
    const reply = await this.pool.query(
      `SELECT min(created_at) AS at
         FROM conversation.messages
        WHERE conversation_id = $1
          AND visibility = 'CUSTOMER_VISIBLE'
          AND sender_kind <> 'CUSTOMER'`,
      [conversationId],
    );

    // Pause spans, straight from the append-only history. An episode still open has no
    // `effective_to`, and the clock treats that as "paused until the moment asked about".
    const waiting = await this.pool.query(
      `SELECT effective_from, effective_to
         FROM conversation.case_state_episodes
        WHERE conversation_id = $1 AND state = 'WAITING_CUSTOMER'
        ORDER BY effective_from`,
      [conversationId],
    );

    const stamp = (value: Date | null): Timestamp | undefined =>
      value === null ? undefined : (value.toISOString() as Timestamp);

    const replyAt = stamp(reply.rows[0]?.at as Date | null);
    const resolvedAt = stamp(row.resolved_at as Date | null);

    return {
      conversationId,
      ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
      ...(row.category_id !== null ? { categoryId: row.category_id as string } : {}),
      ...(row.owning_team_id !== null ? { teamId: row.owning_team_id as string } : {}),
      // The enqueue time where there is one, else creation. A conversation assigned
      // directly never sat in a queue, and its clock starts when it arrived.
      arrivedAt: stamp((row.enqueued_at ?? row.created_at) as Date)!,
      afterHours: row.after_hours as boolean,
      ...(replyAt !== undefined ? { firstCustomerVisibleReplyAt: replyAt } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      waitingOnCustomerSpans: waiting.rows.map((span) => ({
        from: stamp(span.effective_from as Date)!,
        ...(span.effective_to !== null ? { to: stamp(span.effective_to as Date)! } : {}),
      })),
      state: row.state as string,
    };
  }

  /**
   * Open cases whose clocks a sweep should evaluate.
   *
   * Bounded and oldest-first. Deliberately does NOT try to pre-filter to "probably
   * breached" in SQL: whether a case has breached depends on the calendar, and the
   * calendar is not something this query can join against without reimplementing the
   * clock in SQL — which is the duplication §23.5 exists to prevent.
   */
  async openCases(limit: number): Promise<readonly UUID[]> {
    const result = await this.pool.query(
      `SELECT c.conversation_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_type = 'CUSTOMER_SERVICE'
          AND c.state NOT IN ('RESOLVED', 'CLOSED')
        ORDER BY c.created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.conversation_id as UUID);
  }

  /**
   * The configured FIRST_RESPONSE target per team, for the threshold gauge.
   *
   * `CustomerWaitingBeyondStandard` compares `starlink_oldest_waiting_seconds` against
   * `starlink_team_waiting_threshold_seconds` — a rule that needs BOTH series to exist.
   * The gauge half shipped with the queue metrics; this is the threshold half, which
   * could not be published until D-22 had somewhere to live.
   */
  async firstResponseTargetsByTeam(at: Timestamp): Promise<ReadonlyMap<string, number>> {
    const result = await this.pool.query(
      `SELECT scope_id, target_seconds
         FROM conversation.sla_targets
        WHERE scope_kind = 'TEAM' AND clock = 'FIRST_RESPONSE'
          AND effective_from <= $1
          AND (effective_to IS NULL OR effective_to > $1)`,
      [at],
    );
    return new Map(result.rows.map((row) => [row.scope_id as string, row.target_seconds as number]));
  }

  /** Has this warning or breach already been sent? Keeps §23.6's stages fire-once. */
  async alreadyNotified(
    conversationId: UUID,
    clock: string,
    level: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM conversation.sla_notifications
        WHERE conversation_id = $1 AND clock = $2 AND level = $3`,
      [conversationId, clock, level],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Records that a notification was sent.
   *
   * `ON CONFLICT DO NOTHING` so two sweep instances racing produce one row and one
   * notification rather than two of each.
   */
  async recordNotification(input: {
    conversationId: UUID;
    clock: string;
    level: string;
    elapsedSeconds: number;
    at: Timestamp;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.sla_notifications
         (conversation_id, clock, level, notified_at, elapsed_seconds)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (conversation_id, clock, level) DO NOTHING`,
      [input.conversationId, input.clock, input.level, input.at, input.elapsedSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
