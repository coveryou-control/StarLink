/**
 * Publishing `starlink_message_page_rows_examined_ratio` (doc §32.4, §38, ADR-001).
 *
 * ## The alert existed and the series did not
 *
 * §32.4's table has a row — *"Documents-examined ratio degrading · Sustained · A lost
 * index"* — and `alerts.yml` implements it as `MessagePageIndexRegression`. The metric was
 * defined in `@starlink/observability`. The measurement was written, and passes, in
 * `infrastructure/database/src/spikes.test.ts` gate (b).
 *
 * **Nothing emitted it.** A Prometheus alert over a series that does not exist evaluates
 * over no data and never fires, which is indistinguishable from health — and this is the
 * alert §38 calls *"the earliest available warning of the exact regression §38 measured"*.
 * So the one alert designed to catch a silently lost index was itself silently absent.
 * Same failure class as the inactive-owner gauge and the three SLA metrics before it.
 *
 * ## Why a sweep, and not the query path itself
 *
 * The obvious alternative — measure every real message page — is wrong twice. It would put
 * `EXPLAIN ANALYZE` on the hot read path, doubling the work of the operation it measures;
 * and it would report the ratio for whatever conversations people happened to open, which
 * on a quiet morning is a handful of short threads whose ratio is 1 whatever the index is
 * doing. A lost index shows up on the LONG conversations, so this deliberately probes the
 * longest one it can find.
 *
 * ## What it does not do
 *
 * It does not publish a healthy number when it measured nothing. An empty database, or a
 * probe that failed, leaves the series absent — which is the honest signal and the one
 * §32.4 already tolerates for every other gauge. Publishing 1.0 because there was nothing
 * to look at would be inventing the reassurance the alert exists to withhold.
 */
import type pg from 'pg';
import { METRICS, metrics, type Logger } from '@starlink/observability';

export interface IndexHealthDeps {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  /**
   * How many messages a conversation needs before it is worth probing.
   *
   * Below this the planner may legitimately choose a sequential scan — on a 30-row table
   * that IS the cheaper plan — and reporting the resulting ratio would raise an alert
   * about the planner being right. §38's property is about paging a long conversation.
   */
  readonly minMessages?: number;
  /** Page size to probe with. Matches the API's default page (`message-store`). */
  readonly pageSize?: number;
}

export interface IndexHealthOutcome {
  readonly examined: number;
  readonly acted: number;
  /** Absent when nothing was measurable — see the header. */
  readonly ratio?: number;
}

export class MessagePageIndexHealthSweep {
  constructor(private readonly deps: IndexHealthDeps) {}

  async run(): Promise<IndexHealthOutcome> {
    const minMessages = this.deps.minMessages ?? 500;
    const pageSize = this.deps.pageSize ?? 50;

    /**
     * The LONGEST conversation, because that is where a lost index hurts.
     *
     * `last_seq` rather than a `count(*)` over messages: the counter is maintained on the
     * conversation row, so this is an index-ordered read of one row rather than an
     * aggregate over the largest table in the schema. A monitoring probe that scans the
     * message store to decide whether the message store is slow is its own problem.
     */
    const target = await this.deps.pool.query(
      `SELECT conversation_id, last_seq
         FROM conversation.conversations
        WHERE last_seq >= $1
        ORDER BY last_seq DESC
        LIMIT 1`,
      [minMessages],
    );

    const row = target.rows[0];
    if (row === undefined) {
      // Normal on a fresh or small database. Logged at debug so it is discoverable
      // without being noise, and no series is published.
      this.deps.logger.debug('index health probe found nothing long enough to measure', {
        operation: 'sweep.index_health',
        outcome: 'SUCCEEDED',
        detail: { minMessages },
      });
      return { examined: 0, acted: 0 };
    }

    const conversationId = row.conversation_id as string;

    /**
     * The SAME query shape the API's message page runs (`PgMessageReader`), including the
     * visibility predicate and the compound ordering.
     *
     * If this drifts from the real query it measures a plan nobody executes, which is a
     * worse failure than not measuring at all: it would report health for an index the
     * product no longer uses. `index-health-sweep.test.ts` asserts the two agree.
     */
    let plan: Record<string, unknown>;
    try {
      const explained = await this.deps.pool.query(
        /*
           The channel page, clause for clause.

           Threading added a predicate to it — a threaded reply is out of the timeline unless
           its sender put it back — and the probe has to carry the same one or it measures a
           plan the product stopped running. `index-health-sweep.test.ts` compares these
           strings against the reader's for exactly this reason, and it is what caught the
           drift the day the predicate was added.

           The LATERAL that computes reply counts is deliberately NOT here: it runs once per
           row of the page against `messages_thread_idx`, so it scales with the page and not
           with the conversation, which is the property this probe exists to watch.
        */
        `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT * FROM conversation.messages m
          WHERE m.conversation_id = $1
            AND m.visibility = ANY($2::conversation.message_visibility[])
            AND (m.thread_parent_id IS NULL OR m.also_send_to_channel)
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT $3`,
        [conversationId, ['CUSTOMER_VISIBLE', 'INTERNAL'], pageSize],
      );
      plan = explained.rows[0]['QUERY PLAN'][0]['Plan'] as Record<string, unknown>;
    } catch (error) {
      /**
       * A failed probe must not take the process down, and must not publish either.
       * Reported as a FAILED operation so it appears in the logs an operator reads — the
       * absent series is then explained rather than mysterious.
       */
      this.deps.logger.error('index health probe failed', {
        operation: 'sweep.index_health',
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
      return { examined: 1, acted: 0 };
    }

    const returned = Number(plan['Actual Rows'] ?? 0);
    const examined = collectRowsExamined(plan);
    const ratio = examined / Math.max(returned, 1);

    metrics.set(METRICS.rowsExaminedRatio, ratio);

    /**
     * A blocking sort means the compound index is not serving the ordering, which is the
     * §38 regression itself. The ratio usually catches it — a sort has to read everything
     * first — but not always, so it is logged explicitly rather than inferred.
     */
    const sorted = JSON.stringify(plan).includes('"Node Type":"Sort"');
    if (sorted || ratio > 3) {
      this.deps.logger.warn('message page plan degraded', {
        operation: 'sweep.index_health',
        outcome: 'SUCCEEDED',
        detail: { conversationId, ratio, returned, examined, blockingSort: sorted },
      });
    }

    return { examined: 1, acted: 1, ratio };
  }
}

/** Every node's actual rows, summed — the work the database did to return the page. */
function collectRowsExamined(plan: Record<string, unknown>): number {
  let total = Number(plan['Actual Rows'] ?? 0);
  const children = plan['Plans'];
  if (Array.isArray(children)) {
    for (const child of children) total += collectRowsExamined(child as Record<string, unknown>);
  }
  return total;
}
