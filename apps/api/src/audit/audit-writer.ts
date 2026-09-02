/**
 * The audit ledger writer (doc §31, FR-AUD-2/5).
 *
 * Two rules this file exists to make structural:
 *
 *  1. **Security-critical actions fail if the audit write fails.** An unaudited role
 *     assignment is worse than a refused one (§31.5). The `mustSucceed` flag is not a
 *     convenience — it is the difference between accountability and the appearance of it.
 *  2. **Message content never enters the ledger.** The ledger says *who read what*, not
 *     *what it said*; the message store already holds the content, and duplicating it
 *     into a record with different retention creates two copies with two policies
 *     (§31.3).
 *
 * What is NOT audited matters as much: ordinary internal message sends. Auditing them
 * is surveillance, not accountability (P-06, P-08).
 */
import type pg from 'pg';
import type { PrincipalKind, UUID } from '@starlink/shared-contracts';
import { METRICS, metrics, type Logger } from '@starlink/observability';

export type AuditOutcome = 'SUCCEEDED' | 'REFUSED' | 'FAILED';

export interface AuditEvent {
  readonly actorId?: UUID;
  readonly actorKind: PrincipalKind;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly outcome: AuditOutcome;
  readonly reason?: string;
  readonly correlationId: string;
  /** Bounded, structured, and never message content. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export class AuditWriteFailed extends Error {
  constructor(action: string, cause: unknown) {
    super(`audit write failed for security-critical action "${action}"`);
    this.name = 'AuditWriteFailed';
    this.cause = cause;
  }
}

export class AuditWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly contextRetentionDays = 180,
  ) {}

  /**
   * Records an event.
   *
   * @param mustSucceed when true, a write failure THROWS and the caller must abort the
   * action. Use it for the ownership, authorization and administration categories of
   * §31.1 — the ones where an unattributable change is unacceptable.
   */
  async record(event: AuditEvent, options: { mustSucceed?: boolean } = {}): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit.ledger
           (event_id, actor_id, actor_kind, action, target_kind, target_id, outcome, reason, correlation_id, detail)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          event.actorId ?? null,
          event.actorKind,
          event.action,
          event.targetKind,
          event.targetId,
          event.outcome,
          event.reason ?? null,
          event.correlationId,
          event.detail ?? null,
        ],
      );
    } catch (error) {
      if (options.mustSucceed === true) throw new AuditWriteFailed(event.action, error);
      /**
       * Non-critical: the action proceeds, but this is alerted on (§32.4, threshold
       * "> 0", "Accountability is degraded (FR-AUD-5)") because a silently degraded
       * audit trail is exactly what an incident cannot tolerate.
       *
       * The counter is what makes that alert real. It was declared in the metrics
       * catalogue and written by nothing until 2026-08-29, so `AuditWriteFailures`
       * evaluated over an absent series and could never fire — the alert for "we have
       * stopped being able to record who did what" was itself unable to speak.
       */
      metrics.increment(METRICS.auditWriteFailures, 1);
      this.logger.error('audit write failed', {
        correlationId: event.correlationId,
        operation: event.action,
        outcome: 'FAILED',
        errorCode: 'AUDIT_WRITE_FAILED',
      });
    }
  }

  /**
   * Stores identifying request context SEPARATELY from the ledger, with its own
   * shorter retention (doc §31.4).
   *
   * A retention obligation says "delete identifying data after N days"; an audit
   * obligation says "the ledger is immutable". Held in one record those conflict and
   * immutability is what quietly breaks. Split, both hold: "who did what" survives,
   * "from which address" ages out.
   */
  async recordRequestContext(context: RequestContext): Promise<void> {
    const expires = new Date(Date.now() + this.contextRetentionDays * 24 * 60 * 60 * 1000);
    try {
      await this.pool.query(
        `INSERT INTO audit.request_context (correlation_id, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (correlation_id) DO NOTHING`,
        [context.correlationId, context.ipAddress ?? null, context.userAgent ?? null, expires],
      );
    } catch {
      // Context is a convenience for investigators; losing it must not fail a request.
      this.logger.warn('request context write failed', { correlationId: context.correlationId });
    }
  }
}
