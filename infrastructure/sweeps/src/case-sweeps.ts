/**
 * The two case sweeps: closing the reopen window, and §23.6's warning/breach stages.
 *
 * Both exist because the passage of time is not an event anybody sends. A reopen window
 * expires and a target is missed without anyone doing anything, so something has to look.
 *
 * Neither sweep is the source of truth for what it finds. The reopen window and the SLA
 * clock are both COMPUTED — from `resolved_at` and the configured window, and from the
 * case's observations and the calendar in force. A sweep that did not run leaves nothing
 * wrong; the next one reaches the same conclusion. What the sweeps add is the two things
 * a computed value cannot do for itself: write the state change the lifecycle requires,
 * and tell a human once.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { METRICS, metrics, type Logger } from '@starlink/observability';
import {
  selectTarget,
  slaState,
  type BusinessCalendar,
  type SlaClock,
  type SlaState,
  type SlaTarget,
} from '@starlink/sla';

export interface SweepOutcome {
  readonly examined: number;
  readonly acted: number;
}

/* ────────────────────────────── reopen-window closure ────────────────────────────── */

export interface ReopenClosureDeps {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  /** D-08. No default — the window length is the business's (§44.3). */
  readonly windowSeconds: number;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * Moves RESOLVED conversations to CLOSED once their reopen window has passed.
 *
 * §21.4: "resolved → closed | System, on reopen-window expiry | Customer notified: No".
 * The silence matters — closure is an internal boundary that lets two pieces of work be
 * measured separately (BR-22, §22.4). Telling the customer their conversation had closed
 * would announce an internal event and invite a reply they did not need to send.
 *
 * Idempotent by predicate: `WHERE state = 'RESOLVED'` means a conversation reopened
 * between the query and the update is not closed underneath the customer.
 */
export class ReopenWindowClosureSweep {
  constructor(private readonly deps: ReopenClosureDeps) {}

  async run(): Promise<SweepOutcome> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString();
    const cutoff = new Date(Date.parse(at) - this.deps.windowSeconds * 1000).toISOString();

    /**
     * Closed in ONE statement rather than read-then-write.
     *
     * The conditional `state = 'RESOLVED'` is what makes a customer's reply always win a
     * race with the sweep: if they reopened first, the row is ACTIVE and matches nothing.
     * A read followed by a write would close a conversation the customer had just
     * revived, and they would be talking into a thread the system considered finished.
     *
     * The window is compared against the APPLICATION clock, not SQL `now()` — ADR-025.
     * `resolved_at` is written by the application, so the comparison must use the same
     * clock or a minute of skew shifts every boundary.
     */
    const closed = await this.deps.pool.query(
      `UPDATE conversation.conversations c
          SET state = 'CLOSED', updated_at = $1
         FROM conversation.service_cases sc
        WHERE sc.case_id = c.case_id
          AND c.state = 'RESOLVED'
          AND sc.resolved_at IS NOT NULL
          AND sc.resolved_at <= $2
          AND c.conversation_id IN (
            SELECT c2.conversation_id
              FROM conversation.conversations c2
              JOIN conversation.service_cases s2 ON s2.case_id = c2.case_id
             WHERE c2.state = 'RESOLVED' AND s2.resolved_at IS NOT NULL AND s2.resolved_at <= $2
             ORDER BY s2.resolved_at
             LIMIT $3)
        RETURNING c.conversation_id, sc.resolved_at`,
      [at, cutoff, this.deps.batchSize ?? 200],
    );

    // The append-only history the SLA clock reads its pause spans from must agree with
    // the row. Closing the previous episode and opening CLOSED at the same instant leaves
    // no gap and no overlap — the exclusion constraint would reject either.
    for (const row of closed.rows) {
      const conversationId = row.conversation_id as UUID;
      await this.deps.pool.query(
        `UPDATE conversation.case_state_episodes
            SET effective_to = $2
          WHERE conversation_id = $1 AND effective_to IS NULL`,
        [conversationId, at],
      );
      await this.deps.pool.query(
        `INSERT INTO conversation.case_state_episodes
           (episode_id, conversation_id, state, effective_from, reason)
         VALUES ($1,$2,'CLOSED',$3,'reopen window expired')`,
        [crypto.randomUUID(), conversationId, at],
      );
    }

    if (closed.rowCount !== null && closed.rowCount > 0) {
      this.deps.logger.info('reopen windows expired', {
        operation: 'sweep.reopen_closure',
        outcome: 'SUCCEEDED',
        detail: { closed: closed.rowCount, windowSeconds: this.deps.windowSeconds },
      });
    }

    return { examined: closed.rowCount ?? 0, acted: closed.rowCount ?? 0 };
  }
}

/* ─────────────────────────────── SLA warning and breach ──────────────────────────── */

/** What the sweep needs to read. Implemented by `PgSlaReader` and the calendar reader. */
export interface SlaSweepPorts {
  openCases(limit: number): Promise<readonly UUID[]>;
  factsFor(conversationId: UUID): Promise<
    | {
        conversationId: UUID;
        categoryId?: string;
        teamId?: string;
        arrivedAt: Timestamp;
        afterHours: boolean;
        firstCustomerVisibleReplyAt?: Timestamp;
        resolvedAt?: Timestamp;
        waitingOnCustomerSpans: readonly { from: Timestamp; to?: Timestamp }[];
      }
    | undefined
  >;
  targetsFor(
    scope: { categoryId?: string; teamId?: string },
    at: Timestamp,
  ): Promise<readonly (SlaTarget & { scopeKind: string; scopeId: string })[]>;
  calendarsFor(teamId: string): Promise<readonly BusinessCalendar[]>;
  alreadyNotified(conversationId: UUID, clock: string, level: string): Promise<boolean>;
  recordNotification(input: {
    conversationId: UUID;
    clock: string;
    level: string;
    elapsedSeconds: number;
    at: Timestamp;
  }): Promise<boolean>;
}

/** What §23.6 says to do at each stage. The transport is the caller's concern. */
export interface SlaNotifier {
  /** "notify the OWNER. Nothing else. Quiet nudge." */
  warn(input: { conversationId: UUID; clock: SlaClock; state: SlaState }): Promise<void>;
  /** "flag BREACHED + timestamp; notify OWNER and TEAM LEAD". */
  breach(input: { conversationId: UUID; clock: SlaClock; state: SlaState }): Promise<void>;
  /**
   * §23.6's third stage: "RAISE ESCALATION LEVEL · route per the escalation policy ·
   * AUDITED (FR-AUD-2 · ownership category)".
   *
   * Called only where {@link SlaSweepDeps.autoEscalates} says the category qualifies.
   * Raising a level is an ownership-category event, so the implementation must audit it
   * with a reason — the sweep supplies one rather than leaving the ledger to guess why a
   * level moved with no human behind it.
   */
  escalate(input: {
    conversationId: UUID;
    clock: SlaClock;
    state: SlaState;
    reason: string;
  }): Promise<void>;
}

export interface SlaSweepDeps {
  readonly ports: SlaSweepPorts;
  readonly notifier: SlaNotifier;
  readonly logger: Logger;
  /**
   * Whether a breach in this category raises an escalation level automatically (D-25).
   *
   * A function rather than a list, because the answer is configuration and the shape of
   * the answer is the business's. §44.5 recommends "automatic escalation for Claims and
   * Grievance; lead-decides elsewhere", with the reason that "automatic everywhere risks
   * escalation becoming noise the leads learn to ignore" — so the default a caller passes
   * should be narrow, and a category it does not recognise must not escalate.
   */
  readonly autoEscalates: (categoryId: string | undefined) => boolean;
  /** Resolves "became routable" for an after-hours arrival (§23.5 case B). */
  readonly clockStartFor: (
    facts: { arrivedAt: Timestamp; afterHours: boolean },
    calendars: readonly BusinessCalendar[],
  ) => Timestamp | undefined;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * Evaluates every open case's clocks and fires §23.6's stages, once each.
 *
 *     target × warning threshold  →  notify the OWNER. Nothing else. Quiet nudge.
 *     target reached              →  notify OWNER and TEAM LEAD
 *     breach + escalation threshold → raise the escalation level (D-25)
 *
 * All three stages run. The third is gated on {@link SlaSweepDeps.autoEscalates}, which
 * carries D-25's answer: escalate automatically where the business has said to, and
 * otherwise notify and leave the level to a lead. §44.5's reasoning is why the gate
 * exists rather than a blanket rule — "automatic everywhere risks escalation becoming
 * noise the leads learn to ignore" — and a category the predicate does not recognise
 * does not escalate, so the failure direction is a human decision rather than an
 * automatic one nobody asked for.
 *
 * Escalation fires at most once per case per clock, recorded under its own level in
 * `sla_notifications`. A level that climbed on every sweep tick would turn a single late
 * case into an escalation ladder within the hour.
 *
 * ## What the customer is told: nothing
 *
 * §23.6, in capitals in the source: "THE CUSTOMER IS NOT NOTIFIED OF ANY OF THIS. A
 * breach is our failure to manage, not news to deliver." Nothing in this sweep can reach
 * a customer — the notifier's recipients are the owner and the lead, and the customer
 * projection has no vocabulary for a breach at all (§27.16).
 */
export class SlaBreachSweep {
  constructor(private readonly deps: SlaSweepDeps) {}

  async run(): Promise<SweepOutcome> {
    const at = (this.deps.now ?? (() => new Date()))().toISOString() as Timestamp;
    const conversationIds = await this.deps.ports.openCases(this.deps.batchSize ?? 200);

    // One calendar history per team per tick. The calendar cannot change within a tick,
    // and the morning surge would otherwise read the same rows for every case.
    const calendarCache = new Map<string, readonly BusinessCalendar[]>();
    const calendarsFor = async (teamId: string): Promise<readonly BusinessCalendar[]> => {
      const cached = calendarCache.get(teamId);
      if (cached !== undefined) return cached;
      const loaded = await this.deps.ports.calendarsFor(teamId);
      calendarCache.set(teamId, loaded);
      return loaded;
    };

    let acted = 0;

    /**
     * Counted per team and clock, and published even when zero.
     *
     * `alerts.yml` and the dashboards ask for `starlink_sla_at_risk`; a series that never
     * appears evaluates over no data and reads as health. The same mistake the
     * inactive-owner gauge made before it was hosted, so the zero is published
     * deliberately rather than skipped as uninteresting.
     */
    const atRisk = new Map<string, number>();
    const seen = new Set<string>();

    for (const conversationId of conversationIds) {
      const facts = await this.deps.ports.factsFor(conversationId);
      if (facts?.teamId === undefined) continue;

      const calendars = await calendarsFor(facts.teamId);
      const targets = await this.deps.ports.targetsFor(
        {
          ...(facts.categoryId !== undefined ? { categoryId: facts.categoryId } : {}),
          teamId: facts.teamId,
        },
        at,
      );
      // No configured target means no promise was made, so there is nothing to miss.
      // §44.5 D-22: "We will not invent these."
      if (targets.length === 0) continue;

      const startedAt = this.deps.clockStartFor(facts, calendars);
      if (startedAt === undefined) continue; // after hours, before opening: no clock yet

      for (const clock of ['FIRST_RESPONSE', 'RESOLUTION'] as const) {
        const target = selectTarget(targets, facts, clock);
        if (target === undefined) continue;

        const stoppedAt =
          clock === 'FIRST_RESPONSE' ? facts.firstCustomerVisibleReplyAt : facts.resolvedAt;

        const state = slaState(
          target,
          {
            startedAt,
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            pauses: facts.waitingOnCustomerSpans,
          },
          calendars,
          at,
        );

        const key = `${facts.teamId}\u0000${clock}`;
        seen.add(key);
        if (state.status === 'WARNING') atRisk.set(key, (atRisk.get(key) ?? 0) + 1);

        acted += await this.fire(
          conversationId,
          clock,
          state,
          at,
          facts.categoryId,
          facts.teamId,
        );
      }
    }

    for (const key of seen) {
      const [team, clock] = key.split('\u0000') as [string, string];
      metrics.set(METRICS.slaAtRisk, atRisk.get(key) ?? 0, { team, clock });
    }

    return { examined: conversationIds.length, acted };
  }

  /**
   * Sends at most one notification per case per clock per stage.
   *
   * The record is written FIRST and the notification sent only if the insert claimed the
   * row. Two sweep instances racing therefore produce one notification: the loser's
   * insert conflicts and it sends nothing. The cost of that ordering is that a crash
   * between the insert and the send loses a notification — which is the right way round,
   * because §23.6's stages are nudges, and a lead receiving the same breach alert every
   * minute for an afternoon is how alerts stop being read.
   */
  private async fire(
    conversationId: UUID,
    clock: SlaClock,
    state: SlaState,
    at: Timestamp,
    categoryId: string | undefined,
    teamId: string,
  ): Promise<number> {
    const level =
      state.status === 'BREACHED' ? 'BREACH' : state.status === 'WARNING' ? 'WARNING' : undefined;
    if (level === undefined) return 0;

    let acted = 0;

    if (await this.claim(conversationId, clock, level, state, at)) {
      if (level === 'BREACH') {
        await this.deps.notifier.breach({ conversationId, clock, state });
        // Counted once per case per clock, because the claim above gates it. A gauge
        // recomputed each tick would count the same breach for as long as it lasted.
        metrics.increment(METRICS.slaBreaches, 1, { team: teamId, clock });
      } else {
        await this.deps.notifier.warn({ conversationId, clock, state });
      }
      this.log(conversationId, clock, level, state);
      acted += 1;
    }

    /**
     * §23.6's third stage, and the only one that changes state rather than telling
     * somebody. Gated on D-25's answer, and claimed under its OWN level so it fires once
     * even though the case stays breached for as long as it takes to answer.
     *
     * Attempted independently of whether the breach notification was claimed above: a
     * process that crashed after notifying and before escalating must still escalate on
     * the next tick, and coupling the two would leave that case notified and unescalated
     * forever.
     */
    if (level === 'BREACH' && this.deps.autoEscalates(categoryId)) {
      if (await this.claim(conversationId, clock, 'ESCALATION', state, at)) {
        await this.deps.notifier.escalate({
          conversationId,
          clock,
          state,
          // A reason, because §23.6 audits this under the ownership category and an
          // ownership change with no stated cause is unanswerable six months later.
          reason: `${clock} target breached by ${Math.abs(state.remainingSeconds)}s (automatic, D-25)`,
        });
        this.log(conversationId, clock, 'ESCALATION', state);
        acted += 1;
      }
    }

    return acted;
  }

  /**
   * Records the intent to act, and reports whether THIS caller won the right to.
   *
   * Written before the action and only acted on if the insert claimed the row, so two
   * sweep instances racing produce one notification: the loser's insert conflicts and it
   * does nothing.
   */
  private async claim(
    conversationId: UUID,
    clock: SlaClock,
    level: string,
    state: SlaState,
    at: Timestamp,
  ): Promise<boolean> {
    if (await this.deps.ports.alreadyNotified(conversationId, clock, level)) return false;
    return this.deps.ports.recordNotification({
      conversationId,
      clock,
      level,
      elapsedSeconds: state.elapsedSeconds,
      at,
    });
  }

  private log(conversationId: UUID, clock: SlaClock, level: string, state: SlaState): void {
    this.deps.logger.info('sla stage reached', {
      operation: 'sweep.sla',
      outcome: 'SUCCEEDED',
      detail: {
        conversationId,
        clock,
        level,
        elapsedSeconds: state.elapsedSeconds,
        // A stage fired against an unratified target is worth seeing in the log that
        // explains it (§68 gate 8).
        provisionalTarget: state.provisional,
      },
    });
  }
}
