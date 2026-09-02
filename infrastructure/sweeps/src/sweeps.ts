/**
 * Periodic sweeps (doc §32.3, §32.4, ADR-023).
 *
 * Two jobs, both of which exist because a state that nothing checks is a state that
 * drifts. They live in `infrastructure/` rather than in an app for the same reason the
 * outbox relay does: WHICH process runs them is a deployment question, and code two
 * processes might host must not live inside either.
 *
 * Neither sweep repairs anything on its own, and that is deliberate:
 *
 *   * **The inactive-owner sweep REPORTS.** It never reassigns. Who inherits a departed
 *     colleague's customers is a routing decision a human makes (§21.9 case C), and a
 *     sweep that quietly redistributed work would hide the very failure §32.3's
 *     zero-target exists to expose.
 *   * **The reservation sweep RELEASES.** An expired hold is not a decision, it is an
 *     attempt that ended. Leaving it consumes an agent's capacity forever: they look
 *     busy, the router stops sending them work, and nothing says why.
 */
import type pg from 'pg';
import type { Logger } from '@starlink/observability';

export interface SweepResult {
  readonly examined: number;
  readonly acted: number;
}

/** A case whose owner can no longer reach it. Unreachable work, by definition. */
export interface StrandedCase {
  readonly caseId: string;
  readonly conversationId?: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly state: string;
  readonly strandedForSeconds: number;
}

export interface SweepDeps {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * Surfaces cases owned by a deactivated principal (§32.3, target ZERO).
 *
 * §21.9: "Case C is the one that silently loses customers. A case owned by a deactivated
 * principal is unreachable work." The deactivation endpoint already surfaces what a
 * leaver held AT THE MOMENT they left; this catches what that missed — a case reopened
 * afterwards, a reassignment nobody completed, a departure processed directly in the
 * database.
 *
 * It logs each one individually rather than only a count. A number tells an operator
 * that something is wrong; the list tells them what to do about it.
 */
export class InactiveOwnerSweep {
  constructor(private readonly deps: SweepDeps) {}

  async run(): Promise<SweepResult & { readonly stranded: readonly StrandedCase[] }> {
    const at = (this.deps.now ?? (() => new Date()))();

    const result = await this.deps.pool.query(
      `SELECT sc.case_id, sc.state, sc.current_owner_id, p.display_name,
              c.conversation_id,
              EXTRACT(EPOCH FROM ($1::timestamptz - sc.updated_at))::int AS stranded_seconds
         FROM conversation.service_cases sc
         JOIN identity.principals p ON p.principal_id = sc.current_owner_id
         LEFT JOIN conversation.conversations c ON c.case_id = sc.case_id
        WHERE p.status <> 'ACTIVE'
          AND sc.state = ANY($2::conversation.conversation_state[])
        ORDER BY sc.updated_at`,
      [at.toISOString(), ['NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_CUSTOMER', 'WAITING_INTERNAL']],
    );

    const stranded: StrandedCase[] = result.rows.map((row) => ({
      caseId: row.case_id,
      ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
      ownerId: row.current_owner_id,
      // `displayName` is redacted centrally; `ownerName` is not a person's name key by
      // accident — it is deliberately NOT one of the passing keys, so this is logged
      // through a qualified field below rather than raw.
      ownerName: row.display_name,
      state: row.state,
      strandedForSeconds: row.stranded_seconds ?? 0,
    }));

    if (stranded.length > 0) {
      // §32.4 makes any non-zero value the highest-priority alert. Logged at ERROR
      // because it is unreachable customer work, not a housekeeping note.
      this.deps.logger.error('cases owned by an inactive principal', {
        operation: 'sweep.inactive_owner',
        outcome: 'FAILED',
        detail: {
          count: stranded.length,
          oldestStrandedSeconds: stranded[0]?.strandedForSeconds ?? 0,
        },
      });
      for (const item of stranded) {
        this.deps.logger.warn('stranded case', {
          operation: 'sweep.inactive_owner',
          outcome: 'FAILED',
          detail: { caseId: item.caseId, ownerId: item.ownerId, state: item.state },
        });
      }
    }

    // `acted` is zero on purpose: this sweep never repairs. Reporting IS the action.
    return { examined: stranded.length, acted: 0, stranded };
  }
}

/**
 * Releases capacity holds that have expired (ADR-023).
 *
 * A reservation is a hold taken while work is being given to someone. If the attempt
 * dies — the process crashes, the agent closes the tab, the network drops — the hold
 * outlives it and silently consumes capacity. Expiry is read from the clock rather than
 * trusted to a shutdown path, because the shutdown path is exactly what did not run.
 *
 * Any queue entry still RESERVED against a released hold goes back to WAITING, so the
 * work returns to the queue rather than sitting in a state nobody claims from.
 */
export class ReservationExpirySweep {
  constructor(private readonly deps: SweepDeps) {}

  async run(): Promise<SweepResult> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    const client = await this.deps.pool.connect();

    try {
      await client.query('BEGIN');

      const released = await client.query(
        `UPDATE conversation.reservations
            SET released_at = $1, release_reason = 'expired'
          WHERE released_at IS NULL AND expires_at <= $1
          RETURNING reservation_id`,
        [at],
      );

      // Work held against an expired reservation returns to the queue. Without this the
      // entry sits in RESERVED forever: not claimable, not visibly waiting, and not
      // counted in queue depth — the quietest way to lose a customer.
      const requeued = await client.query(
        `UPDATE conversation.queue_entries q
            SET state = 'WAITING', reservation_id = NULL
          WHERE q.state = 'RESERVED'
            AND q.reservation_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation.reservations r
               WHERE r.reservation_id = q.reservation_id AND r.released_at IS NULL)
          RETURNING q.queue_entry_id`,
        [],
      );

      await client.query('COMMIT');

      const acted = (released.rowCount ?? 0) + (requeued.rowCount ?? 0);
      if (acted > 0) {
        this.deps.logger.info('expired reservations released', {
          operation: 'sweep.reservation_expiry',
          outcome: 'SUCCEEDED',
          detail: { released: released.rowCount ?? 0, requeued: requeued.rowCount ?? 0 },
        });
      }

      return { examined: released.rowCount ?? 0, acted };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Runs a sweep on an interval, never overlapping itself.
 *
 * A sweep that takes longer than its interval must not start again on top of the
 * previous run — two concurrent inactive-owner sweeps would double-log, and two
 * reservation sweeps would contend on the same rows for no reason. The timer is
 * unref'd so a housekeeping job never holds the process open.
 */
export function schedule(
  sweep: { run: () => Promise<SweepResult> },
  intervalMs: number,
  logger: Logger,
  label: string,
): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweep.run();
    } catch (error) {
      /**
       * A sweep that throws must not kill the host process or stop the schedule. It is
       * housekeeping; the next tick tries again.
       *
       * The MESSAGE is logged, not just the class. `errorCode: "TypeError"` repeating
       * every second says a sweep is broken and nothing about how — which is exactly
       * what happened the first time the routing sweep hit a bad property access, and
       * cost a debugging round trip that the message alone would have answered.
       *
       * Safe to log: this is our own error text, not a request or response body. The
       * redaction rules bar `payload`/`body` at any depth, and nothing here carries one.
       */
      logger.error('sweep failed', {
        operation: `sweep.${label}`,
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        detail: {
          reason: error instanceof Error ? error.message : String(error),
          // First frame only. A whole stack in a per-tick error log buries the next
          // problem; one frame names the file and line, which is what is needed.
          at: error instanceof Error ? (error.stack?.split('\n')[1]?.trim() ?? 'unknown') : 'unknown',
        },
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
