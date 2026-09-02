/**
 * The idempotency ledger (ADR-006, INTEGRATION_CONTRACTS §9).
 *
 * ADR-006 names it directly: at-least-once is assumed and "every consumer idempotent
 * (dedupe on event/job id against the PG `idempotency_records` table where the side
 * effect is external)". §9's rule for channels says the same in one clause: **"duplicate
 * webhooks absorbed idempotently"**.
 *
 * ## Claim, then complete — two writes, not one
 *
 * A single "insert if absent" would make the second delivery of a webhook a no-op, which
 * sounds right and is not: the second delivery usually arrives BECAUSE the first one
 * never finished. A provider retries when it did not get a 2xx, and the most common
 * reason for that is a crash partway through processing. Treating the retry as a
 * duplicate would drop the message the retry existed to save.
 *
 * So a claim records the attempt, and `complete` records the outcome. A key that is
 * claimed but not completed is a first attempt that died, and is retried; a key that is
 * completed is a genuine duplicate, and its recorded result is returned unchanged. That
 * is also what lets the second delivery answer with the SAME response as the first
 * rather than a bare acknowledgement — a provider comparing the two sees agreement.
 *
 * ## Retention
 *
 * `expires_at` is written and indexed, and nothing purges yet. That is safe only while
 * no channel adapter is registered — the table has no writer in production today. A
 * purge belongs with the first adapter that goes live, not before it: a sweep deleting
 * rows from an empty table is a job that can never be observed working.
 */
import type pg from 'pg';
import type { Timestamp } from '@starlink/shared-contracts';

export interface LedgerEntry {
  readonly scope: string;
  readonly key: string;
  readonly resultRef?: string;
  readonly resultPayload?: Readonly<Record<string, unknown>>;
  /** False while a first attempt is still in flight or died partway. */
  readonly completed: boolean;
}

export type IdempotencyClaim =
  /** Nobody has processed this key. The caller should do the work. */
  | { readonly status: 'FRESH' }
  /** Someone finished this key already. The caller should return `entry`'s result. */
  | { readonly status: 'DUPLICATE'; readonly entry: LedgerEntry }
  /**
   * Claimed earlier and never completed — a first attempt that died.
   *
   * The caller SHOULD process it, accepting that a side effect may happen twice. §29.5's
   * reasoning applies beyond notifications: "a rare duplicate is acceptable, a lost
   * [event] is not."
   */
  | { readonly status: 'RECLAIMED'; readonly claimedAt: Timestamp };

const toEntry = (row: Record<string, unknown>): LedgerEntry => ({
  scope: row.scope as string,
  key: row.idempotency_key as string,
  ...(row.result_ref !== null ? { resultRef: row.result_ref as string } : {}),
  ...(row.result_payload !== null
    ? { resultPayload: row.result_payload as Readonly<Record<string, unknown>> }
    : {}),
  // A row with no recorded result was claimed and never completed.
  completed: row.result_ref !== null || row.result_payload !== null,
});

export class PgIdempotencyLedger {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Records an attempt at `key`, and reports what was already known about it.
   *
   * The insert is the claim, and it is conditional — `ON CONFLICT DO NOTHING` means two
   * concurrent deliveries of the same webhook produce one claim and one processing pass.
   * A check-then-insert would produce two of each the first time a provider fans out.
   */
  async claim(scope: string, key: string, at: Timestamp, ttlSeconds?: number): Promise<IdempotencyClaim> {
    const inserted = await this.pool.query(
      `INSERT INTO conversation.idempotency_records (scope, idempotency_key, created_at, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL
                                ELSE $3::timestamptz + make_interval(secs => $4) END)
       ON CONFLICT DO NOTHING`,
      [scope, key, at, ttlSeconds ?? null],
    );
    if ((inserted.rowCount ?? 0) > 0) return { status: 'FRESH' };

    const existing = await this.pool.query(
      `SELECT * FROM conversation.idempotency_records
        WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    // Vanished between the insert and the read — another writer purged it. Treat as
    // fresh: doing the work twice is the recoverable direction.
    if (row === undefined) return { status: 'FRESH' };

    const entry = toEntry(row);
    return entry.completed
      ? { status: 'DUPLICATE', entry }
      : { status: 'RECLAIMED', claimedAt: row.created_at as Timestamp };
  }

  /**
   * Records what the work produced, making the key a genuine duplicate from now on.
   *
   * `result_payload` is a small reference document, never content — the same rule the
   * notification payload follows. A ledger that cached message bodies would be a copy of
   * the conversation with the authorization removed.
   */
  async complete(
    scope: string,
    key: string,
    result: { resultRef?: string; resultPayload?: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE conversation.idempotency_records
          SET result_ref = $3, result_payload = $4::jsonb
        WHERE scope = $1 AND idempotency_key = $2`,
      [
        scope,
        key,
        result.resultRef ?? null,
        result.resultPayload === undefined ? null : JSON.stringify(result.resultPayload),
      ],
    );
  }

  async lookup(scope: string, key: string): Promise<LedgerEntry | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM conversation.idempotency_records
        WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toEntry(row);
  }
}
