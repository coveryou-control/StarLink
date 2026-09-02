/**
 * Routes conversations that intake persisted but nothing has placed yet (§21.8, §23.3).
 *
 * ## Why routing is a sweep and not part of intake
 *
 * Intake's contract is P-05 and NFR-PRF-2: *persist first, acknowledge fast, and do not
 * wait for anything*. `customer-conversations.controller.ts` says it in as many words —
 * "coupling acceptance to a queue being healthy means a customer types a complaint and
 * watches it vanish." Calling the orchestrator inside the request would undo that.
 *
 * A fire-and-forget call after the response would keep the latency and lose the
 * durability: a crash between the reply and the call leaves a conversation that exists,
 * is visible to its customer, and is in nobody's queue — the silent loss §21.8 spends a
 * page preventing.
 *
 * So placement is driven from committed state. The query below finds conversations with
 * no queue entry and no owner; whether the process crashed, restarted or never ran, the
 * next tick finds the same work. Nothing is held in memory between the two.
 *
 * ## This is also §23.3's "next business period"
 *
 * Diagram 16 ends with an after-hours conversation waiting for the calendar to open and
 * then being routed. That needs something to look again when the team opens, and this is
 * it — the same sweep, re-asking the same question, getting a different answer because
 * the clock moved. No scheduled job per conversation, no wake-up timer to miss.
 *
 * ## What it deliberately does not do
 *
 * It does not touch conversations that already have a queue entry or an owner, so it is
 * idempotent and safe to run alongside a human claiming from the queue view. And it never
 * starts an SLA clock: §23.5 computes clocks on read from the calendar, so there is
 * nothing to start.
 */
import type pg from 'pg';
import type { Result, RoutingDecision, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { METRICS, metrics } from '@starlink/observability';
import type { BusinessHours } from './business-hours.js';

/** The narrow slice of the orchestrator this sweep needs. */
export interface RoutingPort {
  requestRouting(context: {
    conversationId: UUID;
    caseId?: UUID;
    intent: { category: string };
    relationshipOwner?: UUID;
    channel: 'WEBSITE';
    businessHoursState: 'OPEN' | 'AFTER_HOURS';
    priority?: string;
  }): Promise<Result<RoutingDecision>>;
}

/**
 * How the sweep tells somebody. §29.2's two rows that placement can trigger.
 *
 * Optional so the sweep stays testable without a notification stack, and because §29.3 is
 * explicit that "an adapter that is absent, misconfigured or failing costs a NOTIFICATION.
 * It never costs a MESSAGE" — nor, here, a placement.
 */
export interface RoutingNotifier {
  /** §29.2: "A customer conversation assigned to you | Owner | In-app + external if away". */
  assigned(input: { principalId: UUID; conversationId: UUID }): Promise<void>;
  /** §29.2: "A new conversation in your team's queue | Team | In-app". */
  queued(input: { teamId: string; conversationId: UUID }): Promise<void>;
}

export interface RoutingSweepDeps {
  readonly pool: pg.Pool;
  readonly orchestrator: RoutingPort;
  readonly businessHours: BusinessHours;
  readonly logger: Logger;
  readonly notifier?: RoutingNotifier;
  readonly now?: () => Date;
  /**
   * How many to place per tick. A bound rather than a business rule: the opening surge
   * (§23.4) can be hundreds at 10:00, and routing them in one transaction-per-item burst
   * would spike the pool that customer requests share. Whatever is left is picked up on
   * the next tick, in the same order.
   */
  readonly batchSize?: number;
}

export interface RoutingSweepResult {
  readonly examined: number;
  readonly acted: number;
  /**
   * Items whose placement threw, as opposed to being refused.
   *
   * Separate from the difference between `examined` and `acted`, because that difference
   * is dominated by ordinary skips — an unmapped category, a team with no calendar, an
   * orchestrator refusal — none of which is a fault. This number is, and it is the one an
   * operator should react to.
   */
  readonly failed: number;
}

interface Unplaced {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  readonly categoryId: string;
  readonly designatedEmployeeId?: UUID;
}

export class RoutingSweep {
  constructor(private readonly deps: RoutingSweepDeps) {}

  async run(): Promise<RoutingSweepResult> {
    const at = (this.deps.now ?? (() => new Date()))();
    const batchSize = this.deps.batchSize ?? 100;

    /**
     * Oldest first — §23.4's rule, applied at the point where it actually decides who is
     * served first: *"the customer who waited longest is served first"*, and *"after-hours
     * arrivals do not jump ahead of business-hours work already waiting."* Ordering by
     * arrival gives both, because an overnight arrival is by definition older than the
     * morning's and an already-queued conversation is not re-examined at all.
     *
     * Priority bands are D-24 and unanswered; §23.4 says so explicitly — *"without them,
     * 'oldest first' is the whole rule"* — so that is the whole rule here.
     */
    const unplaced = await this.deps.pool.query(
      `SELECT c.conversation_id, c.case_id, sc.category_id, sc.designated_employee_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_type = 'CUSTOMER_SERVICE'
          AND c.state NOT IN ('RESOLVED','CLOSED')
          AND sc.category_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM conversation.queue_entries q
             WHERE q.conversation_id = c.conversation_id
               AND q.state <> 'CANCELLED')
          AND NOT EXISTS (
            SELECT 1 FROM conversation.ownership_episodes oe
             WHERE oe.conversation_id = c.conversation_id
               AND oe.effective_to IS NULL)
        ORDER BY c.created_at ASC
        LIMIT $1`,
      [batchSize],
    );

    const items: Unplaced[] = unplaced.rows.map((row) => ({
      conversationId: row.conversation_id as UUID,
      ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
      categoryId: row.category_id as string,
      ...(row.designated_employee_id !== null
        ? { designatedEmployeeId: row.designated_employee_id as UUID }
        : {}),
    }));

    if (items.length === 0) return { examined: 0, acted: 0, failed: 0 };

    // One business-hours answer per TEAM per tick, not per conversation: the calendar
    // cannot change within a tick, and the opening surge would otherwise read the same
    // rows hundreds of times.
    const teamOfCategory = await this.teamsFor(items.map((i) => i.categoryId));
    const hoursByTeam = new Map<string, Awaited<ReturnType<BusinessHours['stateFor']>>>();
    let teamsWithoutCalendar = 0;
    for (const teamId of new Set(teamOfCategory.values())) {
      const answer = await this.deps.businessHours.stateFor(teamId, at);
      hoursByTeam.set(teamId, answer);
      if (answer.basis === 'NO_CALENDAR') teamsWithoutCalendar += 1;
    }
    // Surfaced as a number, so an unconfigured team is a visible gap rather than a team
    // whose work quietly never gets placed. See `business-hours.ts`.
    metrics.set(METRICS.teamsWithoutCalendar, teamsWithoutCalendar);

    let acted = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const teamId = teamOfCategory.get(item.categoryId);
        if (teamId === undefined) {
          // The category maps to no team (D-17 unmapped). The orchestrator would refuse
          // FAIL_CLOSED; skipping here keeps the refusal out of the log on every tick
          // forever, and the conversation stays visible as unassigned either way.
          continue;
        }
        const hours = hoursByTeam.get(teamId);
        if (hours === undefined) continue;

        const decision = await this.deps.orchestrator.requestRouting({
          conversationId: item.conversationId,
          ...(item.caseId !== undefined ? { caseId: item.caseId } : {}),
          intent: { category: item.categoryId },
          ...(item.designatedEmployeeId !== undefined
            ? { relationshipOwner: item.designatedEmployeeId }
            : {}),
          channel: 'WEBSITE',
          businessHoursState: hours.state,
        });

        if (!decision.ok) {
          this.deps.logger.warn('routing refused', {
            operation: 'sweep.routing',
            outcome: 'FAILED',
            errorCode: decision.error.code,
            detail: { conversationId: item.conversationId, teamName: teamId },
          });
          continue;
        }

        acted += 1;

        /**
         * Told, after the placement is committed — never before, and never in a way that
         * can undo it (§29.1's P-05 ordering). The notifier writes an outbox row and
         * returns; a failure here is swallowed by the service and logged, because a
         * conversation that was placed has been placed whether or not anyone was told.
         */
        if (this.deps.notifier !== undefined) {
          if (decision.value.outcome === 'ASSIGNED') {
            await this.deps.notifier.assigned({
              principalId: decision.value.principalId,
              conversationId: item.conversationId,
            });
          } else {
            // QUEUED and DEFERRED_AFTER_HOURS both put work in front of a team. The
            // after-hours case is deliberately included: §23.3 keeps the conversation
            // visible in the queue, and a team arriving in the morning should see it.
            await this.deps.notifier.queued({ teamId, conversationId: item.conversationId });
          }
        }

        this.deps.logger.info('conversation placed', {
          operation: 'sweep.routing',
          outcome: 'SUCCEEDED',
          detail: {
            conversationId: item.conversationId,
            teamName: teamId,
            outcome: decision.value.outcome,
            basis: hours.basis,
            // Recorded because a placement made against a placeholder calendar is a
            // placement made against a guess, and that should be visible in the log that
            // explains it.
            provisionalCalendar: hours.provisional,
          },
        });
      } catch (error) {
        /**
         * One item, not the batch.
         *
         * Nothing in this loop was wrapped until the participation ledger write moved
         * INSIDE `assignFromRouting`'s transaction, which is where it has to be — the
         * grant and its audit row are one fact (§31.1). But that put a write that can
         * fail on a path with no catch anywhere on it: `LocalWorkOrchestrator` contains
         * no try/catch at all, so a single rejected INSERT propagated out of
         * `requestRouting` and out of `run()`, and the remaining items of a batch of 100
         * went unplaced for that tick.
         *
         * **What it does NOT mean, corrected.** An earlier version of this comment said
         * the failure repeated "in the same position, forever". It does not, and the
         * truth is worth knowing because it is less dramatic and more insidious.
         * `requestRouting` COMMITS the queue entry in its own transaction before it ever
         * reaches `assignFromRouting`, and the selection above excludes any conversation
         * already holding a non-CANCELLED queue entry. So a failed item does not retry:
         * it leaves this sweep's scope permanently, sitting WAITING and unowned, and the
         * batch behind it is picked up on the following tick. The item is not lost — it
         * is claimable by hand from the queue — but nothing will ever place it
         * automatically, and this log line is the only trace that anything went wrong.
         *
         * Catching here is not a softening of rule 1 or of fail-closed. The assign
         * transaction rolled back, `acted` does not count it, and it is logged as FAILED
         * rather than swallowed. What changes is the blast radius: a failing item costs
         * one placement instead of the rest of the tick's.
         */
        failed += 1;
        this.deps.logger.error('placement failed', {
          operation: 'sweep.routing',
          outcome: 'FAILED',
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          detail: {
            conversationId: item.conversationId,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return { examined: items.length, acted, failed };
  }

  /** category → owning team, for the categories in this batch only. */
  private async teamsFor(categoryIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const distinct = [...new Set(categoryIds)];
    const result = await this.deps.pool.query(
      `SELECT category_id, owning_team_id FROM conversation.categories
        WHERE category_id = ANY($1::text[]) AND owning_team_id IS NOT NULL`,
      [distinct],
    );
    return new Map(result.rows.map((row) => [row.category_id as string, row.owning_team_id as string]));
  }
}
