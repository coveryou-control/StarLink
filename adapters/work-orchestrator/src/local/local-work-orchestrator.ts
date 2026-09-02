/**
 * The interim Work Orchestrator (doc §21.8, ADR-023, brief §11).
 *
 * StarLink does **not** build a competing work allocator — brief rule 11 forbids a second
 * Work Orchestrator outright. This adapter exists so the §21.8 decision tree has a
 * working reference implementation while CCS is not yet reachable, behind the interface
 * the Phase-10 Remote adapter will implement. Everything it decides is either read from
 * configuration or supplied by the caller; nothing is invented here.
 *
 * It is stamped `TEMPORARY_AUTHORITY` in health, because that is what it is. A system
 * that reports itself as canonical when it is a stand-in is how a stand-in becomes
 * permanent.
 *
 * The concurrency guarantees are the database's, not this class's — see
 * `PgRoutingStore`. What lives here is the mapping between the contract's vocabulary
 * (`RoutingContext`, `Reservation`, `ClaimOutcome`) and the domain's.
 */
import type {
  AgentWorkState,
  CanonicalRef,
  ClaimOutcome,
  QueueMetrics,
  Reservation,
  Result,
  RoutingContext,
  RoutingDecision,
  EscalationRequest,
  HealthReport,
  TransferRequest,
  UUID,
  WorkOrchestratorClient,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';
import { assessAvailability, type Candidate } from './availability.js';
import { route, type FallbackPolicy } from './route.js';

/** The persistence this adapter needs. Implemented by `PgRoutingStore` plus reservations. */
export interface WorkOrchestratorStore {
  enqueue(input: {
    queueEntryId: UUID;
    conversationId: UUID;
    caseId?: UUID;
    teamId: string;
    priority: string;
    afterHours: boolean;
    at: string;
  }): Promise<void>;
  claimQueueEntry(input: {
    queueEntryId: UUID;
    claimedBy: UUID;
    episodeId: UUID;
    idempotencyKey: string;
    at: string;
  }): Promise<
    | { ok: true; conversationId: UUID; reservationId: UUID; replayed: boolean }
    | { ok: false; currentOwner?: UUID }
  >;
  reserve(input: {
    reservationId: UUID;
    principalId: UUID;
    ref: CanonicalRef;
    weight: number;
    ttlSeconds: number;
    at: string;
  }): Promise<{ reservationId: UUID; expiresAt: string }>;
  /**
   * Push-assignment with the ceiling enforced in the same transaction. Separate from
   * `reserve` because the ceiling check and the hold must not be two decisions — see
   * `PgRoutingStore.assignFromRouting`.
   */
  assignFromRouting(input: {
    queueEntryId: UUID;
    principalId: UUID;
    episodeId: UUID;
    reservationId: UUID;
    weight: number;
    ttlSeconds: number;
    reason: string;
    at: string;
  }): Promise<
    | { ok: true; conversationId: UUID; reservationId: UUID }
    | { ok: false; reason: 'AT_CAPACITY' | 'NO_LONGER_WAITING' }
  >;
  release(reservationId: UUID, reason: string, at: string): Promise<void>;
  queueMetrics(teamId: string, at: string): Promise<QueueMetrics>;
}

/**
 * Everything configuration says about routing ONE category.
 *
 * A single lookup rather than three, because it is a single row: `owning_team_id`,
 * `relationship_shaped` and the weight all describe the same category, and three separate
 * callbacks meant three chances for a caller to answer them from inconsistent reads.
 */
export interface CategoryRouting {
  /**
   * Which team handles it (D-17). Absent means UNROUTABLE, never a guess — routing work
   * to "some team" is how it disappears.
   */
  readonly teamId?: string;
  /** D-17. Renewals is relationship-shaped; Fresh Sales is not. */
  readonly relationshipShaped: boolean;
  /**
   * What one conversation of this category costs against a ceiling
   * (`capacity_policies.work_weights`). Brief §12 is explicit that it is never a
   * hard-coded "5 chats".
   */
  readonly weight: number;
}

export interface LocalWorkOrchestratorOptions {
  readonly store: WorkOrchestratorStore;
  /**
   * Configuration for a category. Async because it is a database read in production —
   * every value in it is a business decision this adapter is forbidden to invent.
   */
  readonly categoryRouting: (category: string) => Promise<CategoryRouting>;
  /** Reservation TTL from `capacity_policies`. No default is invented here. */
  readonly reservationTtlSeconds: number;
  /**
   * The §21.9 facts about a PERSON. The adapter cannot source these itself — declared
   * absence is D-05 and account status belongs to identity — so they are supplied.
   *
   * Note what is absent: `teamCalendarOpen`. That is a fact about a TEAM, and the
   * adapter already knows it — see the call site. Leaving it out means a caller cannot
   * answer it inconsistently with the branch that got us here.
   */
  readonly availabilityOf: (
    principalId: UUID,
    at: string,
  ) => Promise<{
    accountActive: boolean;
    onDeclaredAbsence: boolean;
    explicitlyUnavailable: boolean;
    capacity?: { openConversations: number; ceiling: number };
  }>;
  /** The fallback ladder when the designated advisor is unavailable (D-05). */
  readonly fallbackPolicy: FallbackPolicy;
  readonly now?: () => Date;
  readonly newId?: () => UUID;
}

export class LocalWorkOrchestrator implements WorkOrchestratorClient {
  readonly #now: () => Date;
  readonly #newId: () => UUID;

  constructor(private readonly options: LocalWorkOrchestratorOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID() as UUID);
  }

  /**
   * Places work, or explains why it cannot be placed.
   *
   * QUEUED is a first-class success, not a failure (contract note, brief §18.3). Intake
   * never waits synchronously for an agent, so "nobody took it yet" is an outcome the
   * caller acts on rather than an error it retries.
   */
  async requestRouting(context: RoutingContext): Promise<Result<RoutingDecision>> {
    const category = await this.options.categoryRouting(context.intent.category);
    const teamId = category.teamId;
    if (teamId === undefined) {
      return err({
        code: 'CATEGORY_NOT_MAPPED',
        message: 'no team is configured for this category',
        retryable: false,
        // FAIL_CLOSED: an unmapped category must surface, not silently pick a team.
        failureClass: 'FAIL_CLOSED',
        correlationId: context.conversationId,
      });
    }

    const at = this.#now().toISOString();
    const queueEntryId = this.#newId();

    await this.options.store.enqueue({
      queueEntryId,
      conversationId: context.conversationId,
      ...(context.caseId !== undefined ? { caseId: context.caseId } : {}),
      teamId,
      priority: context.priority ?? 'NORMAL',
      afterHours: context.businessHoursState === 'AFTER_HOURS',
      at,
    });

    if (context.businessHoursState === 'AFTER_HOURS') {
      // §23.3: received, stored and queued. No clock, no countdown, and nothing routed
      // to somebody who is not rostered.
      return ok({ outcome: 'DEFERRED_AFTER_HOURS', queueEntryId });
    }

    // ── The §21.8 decision tree ──────────────────────────────────────────────────
    //
    // Steps 2–5 run here. The tree itself is a pure function in `./route.ts` so it can
    // be tested branch by branch; this supplies the facts it needs and acts on the
    // answer. Nothing about the decision is made in this file.
    let designated: Candidate | undefined;
    if (context.relationshipOwner !== undefined) {
      const facts = await this.options.availabilityOf(context.relationshipOwner, at);
      designated = {
        principalId: context.relationshipOwner,
        basis: 'DESIGNATED',
        availability: assessAvailability({
          principalId: context.relationshipOwner,
          ...facts,
          /**
           * True, and derived rather than asked for: this line is only reachable
           * because `businessHoursState` was OPEN, and that was the routing team's
           * calendar answered by the caller. Re-asking would be a second source for one
           * fact, which is how the two answers eventually disagree.
           *
           * The case this does NOT cover is a designated advisor rostered to a
           * different team with different hours. Who the designated employee is and
           * where they sit is D-19, unanswered; when it is answered, the advisor's own
           * calendar becomes the right question and this becomes a lookup.
           */
          teamCalendarOpen: true,
        }),
      };
    }

    const decision = route({
      conversationId: context.conversationId,
      ...(context.caseId !== undefined ? { caseId: context.caseId } : {}),
      categoryId: context.intent.category,
      teamId,
      // Already known to be OPEN — the after-hours branch returned above, and step 1 of
      // the tree is the same question asked earlier by the caller.
      teamCalendarOpen: true,
      categoryIsRelationshipShaped: category.relationshipShaped,
      ...(designated !== undefined ? { designated } : {}),
      fallback: this.options.fallbackPolicy,
      at,
    });

    switch (decision.outcome) {
      case 'ASSIGN': {
        // The queue entry is transitioned, the episode opened and the hold taken in ONE
        // transaction, with the ceiling re-checked inside it. Two conversations routed
        // to the same person in the same instant therefore cannot both succeed against
        // a capacity of one — the facts `assessAvailability` used were read a moment
        // ago, and a moment is long enough.
        const assigned = await this.options.store.assignFromRouting({
          queueEntryId,
          principalId: decision.ownerId,
          episodeId: this.#newId(),
          reservationId: this.#newId(),
          weight: category.weight,
          ttlSeconds: this.options.reservationTtlSeconds,
          reason: decision.path.join(' → '),
          at,
        });

        if (!assigned.ok) {
          /**
           * Neither refusal is an error, and neither leaves the conversation unplaced.
           *
           *   * AT_CAPACITY — the advisor is full. The entry is still WAITING and any
           *     colleague can take it.
           *   * NO_LONGER_WAITING — an agent claimed it from the queue view in the
           *     milliseconds since the enqueue. It has an owner, just not the one the
           *     tree picked.
           *
           * QUEUED is the honest report for both: intake gets "placed, nobody assigned
           * by me", which is the same thing it must act on. The reason carries which
           * happened. Erroring would be worse than imprecise — the caller would retry a
           * conversation that is already fine.
           */
          return ok({
            outcome: 'QUEUED',
            queueEntryId,
            reason: `${decision.path.join(' → ')} → ${assigned.reason}`,
          });
        }

        return ok({
          outcome: 'ASSIGNED',
          principalId: decision.ownerId,
          reservationId: assigned.reservationId,
          // The path the tree took, verbatim. A lead asking "why did this go to Priya?"
          // gets an answer from the decision rather than from log archaeology.
          reason: decision.path.join(' → '),
        });
      }

      case 'QUEUE':
        return ok({ outcome: 'QUEUED', queueEntryId, reason: decision.path.join(' → ') });

      case 'UNROUTABLE':
        // §21.8: "stays QUEUED and VISIBLY UNANSWERED. Never silently held." So this is
        // still a queued outcome — the work is findable — and the path says why nobody
        // took it, which is what a lead needs to act.
        return ok({ outcome: 'QUEUED', queueEntryId, reason: decision.path.join(' → ') });
    }
  }

  /**
   * Atomic claim. Exactly one winner under concurrency (G-06, G-07).
   *
   * `ALREADY_ASSIGNED` is a normal outcome, deliberately not an error — the contract
   * says so, and the distinction matters because an error would be retried, turning a
   * settled race into a loop.
   */
  async claim(
    queueEntryId: UUID,
    principalId: UUID,
    idempotencyKey: string,
  ): Promise<Result<ClaimOutcome>> {
    const at = this.#now().toISOString();
    const outcome = await this.options.store.claimQueueEntry({
      queueEntryId,
      claimedBy: principalId,
      episodeId: this.#newId(),
      idempotencyKey,
      at,
    });

    if (!outcome.ok) {
      return ok({
        outcome: 'ALREADY_ASSIGNED',
        // The winner's identity is legitimate for an employee to see — they need to know
        // who to ask. It is never surfaced to a customer (§11.7).
        currentOwner: outcome.currentOwner ?? principalId,
      });
    }

    return ok({
      outcome: 'CLAIMED',
      conversationId: outcome.conversationId,
      reservationId: outcome.reservationId,
    });
  }

  async reserve(
    principalId: UUID,
    workRef: CanonicalRef,
    weight: number,
    ttlSeconds: number,
  ): Promise<Result<Reservation>> {
    if (weight <= 0) {
      return err({
        code: 'INVALID_WEIGHT',
        message: 'a reservation must consume some capacity',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: principalId,
      });
    }

    const at = this.#now().toISOString();
    const reserved = await this.options.store.reserve({
      reservationId: this.#newId(),
      principalId,
      ref: workRef,
      weight,
      // A TTL of zero or less would be a hold that never expires or never exists; fall
      // back to the configured policy rather than to a number invented here.
      ttlSeconds: ttlSeconds > 0 ? ttlSeconds : this.options.reservationTtlSeconds,
      at,
    });

    return ok({
      reservationId: reserved.reservationId,
      principalId,
      workRef,
      weight,
      expiresAt: reserved.expiresAt,
    });
  }

  async release(reservationId: UUID, reason: string): Promise<Result<void>> {
    await this.options.store.release(reservationId, reason, this.#now().toISOString());
    return ok(undefined);
  }

  async transfer(_request: TransferRequest): Promise<Result<void>> {
    // Transfer lives in `packages/routing` as a domain command with a mandatory reason
    // and a must-succeed audit. Routing it back through this adapter would create a
    // second path to the same state change, which §38 records as the defect that let
    // the reference platform's two authorization paths diverge.
    return err({
      code: 'USE_DOMAIN_COMMAND',
      message: 'transfer is a domain command (packages/routing), not an orchestrator call',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: _request.conversationId,
    });
  }

  async escalate(_request: EscalationRequest): Promise<Result<void>> {
    return err({
      code: 'USE_DOMAIN_COMMAND',
      message: 'escalation is a domain command (packages/routing), not an orchestrator call',
      retryable: false,
      failureClass: 'FAIL_CLOSED',
      correlationId: _request.conversationId,
    });
  }

  async reportAgentState(_principalId: UUID, _state: AgentWorkState): Promise<Result<void>> {
    // Accepted and discarded, deliberately. Agent work state is CCS's to hold (Part IV
    // ownership table); storing it here would be the beginnings of a second authority.
    // Availability for routing comes from the calendar and declared absence (§21.9),
    // never from a self-reported status.
    return ok(undefined);
  }

  async queueSnapshot(teamId: string): Promise<Result<QueueMetrics>> {
    return ok(await this.options.store.queueMetrics(teamId, this.#now().toISOString()));
  }

  async health(): Promise<HealthReport> {
    return {
      status: 'UP',
      authority: 'TEMPORARY_AUTHORITY',
      checkedAt: this.#now().toISOString(),
      detail: 'local work orchestrator: interim reference semantics, replaced by CCS at Phase 10',
    };
  }
}
