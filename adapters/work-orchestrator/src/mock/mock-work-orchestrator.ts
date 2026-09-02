/**
 * In-memory Work Orchestrator for tests and local development.
 *
 * This is a MOCK, not the LocalWorkOrchestratorAdapter: it implements the contract's
 * observable behaviour (atomic claim, reservations with TTL, queue snapshots) without
 * the full §21.8 routing decision tree, which arrives in Phase 5 backed by PostgreSQL.
 *
 * The claim is the part worth getting right even in a mock, because every consumer is
 * written against the guarantee that exactly one claimant wins.
 */
import type {
  CanonicalRef,
  ClaimOutcome,
  HealthReport,
  QueueMetrics,
  Reservation,
  Result,
  RoutingContext,
  RoutingDecision,
  TransferRequest,
  EscalationRequest,
  AgentWorkState,
  UUID,
  WorkOrchestratorClient,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

interface QueueEntry {
  queueEntryId: UUID;
  conversationId: UUID;
  teamId: string;
  priority: string;
  state: 'WAITING' | 'CLAIMED';
  claimedBy?: UUID;
  enqueuedAt: number;
}

const fail = (code: string, message: string, failureClass: 'FAIL_CLOSED' | 'FAIL_QUEUED'): Result<never> =>
  err({ code, message, retryable: failureClass === 'FAIL_QUEUED', failureClass, correlationId: 'mock' });

export class MockWorkOrchestrator implements WorkOrchestratorClient {
  private readonly queue = new Map<UUID, QueueEntry>();
  private readonly reservations = new Map<UUID, Reservation>();
  private readonly agentStates = new Map<UUID, AgentWorkState>();
  /** Maps an idempotency key to the outcome it already produced. */
  private readonly claimIdempotency = new Map<string, ClaimOutcome>();

  /** Test helper: put work in the queue without going through routing. */
  enqueue(entry: { queueEntryId: UUID; conversationId: UUID; teamId: string; priority?: string }): void {
    this.queue.set(entry.queueEntryId, {
      ...entry,
      priority: entry.priority ?? 'NORMAL',
      state: 'WAITING',
      enqueuedAt: Date.now(),
    });
  }

  async requestRouting(context: RoutingContext): Promise<Result<RoutingDecision>> {
    const queueEntryId = crypto.randomUUID();
    // After hours never routes to a person, and never starts a clock: the message is
    // accepted, persisted and queued, with no response-time promise (doc §23.3).
    if (context.businessHoursState === 'AFTER_HOURS') {
      this.enqueue({ queueEntryId, conversationId: context.conversationId, teamId: 'unassigned' });
      return ok({ outcome: 'DEFERRED_AFTER_HOURS', queueEntryId });
    }
    this.enqueue({ queueEntryId, conversationId: context.conversationId, teamId: 'unassigned' });
    return ok({ outcome: 'QUEUED', queueEntryId, reason: 'mock always queues' });
  }

  async claim(queueEntryId: UUID, principalId: UUID, idempotencyKey: string): Promise<Result<ClaimOutcome>> {
    // A retry of the SAME claim must return the SAME answer. Without this, a network
    // timeout turns a successful claimant into a loser on retry (brief §15).
    const replayed = this.claimIdempotency.get(idempotencyKey);
    if (replayed !== undefined) return ok(replayed);

    const entry = this.queue.get(queueEntryId);
    if (entry === undefined) return fail('QUEUE_ENTRY_NOT_FOUND', 'no such queue entry', 'FAIL_CLOSED');

    // Single-threaded JS gives us the atomicity here that SKIP LOCKED gives the real
    // adapter: the check and the mutation cannot interleave.
    if (entry.state === 'CLAIMED') {
      const outcome: ClaimOutcome = { outcome: 'ALREADY_ASSIGNED', currentOwner: entry.claimedBy as UUID };
      this.claimIdempotency.set(idempotencyKey, outcome);
      return ok(outcome);
    }

    entry.state = 'CLAIMED';
    entry.claimedBy = principalId;
    const reservationId = crypto.randomUUID();
    this.reservations.set(reservationId, {
      reservationId,
      principalId,
      workRef: { system: 'LOCAL', type: 'conversation', id: entry.conversationId },
      weight: 1,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const outcome: ClaimOutcome = { outcome: 'CLAIMED', conversationId: entry.conversationId, reservationId };
    this.claimIdempotency.set(idempotencyKey, outcome);
    return ok(outcome);
  }

  async reserve(
    principalId: UUID,
    workRef: CanonicalRef,
    weight: number,
    ttlSeconds: number,
  ): Promise<Result<Reservation>> {
    const reservation: Reservation = {
      reservationId: crypto.randomUUID(),
      principalId,
      workRef,
      weight,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
    this.reservations.set(reservation.reservationId, reservation);
    return ok(reservation);
  }

  async release(reservationId: UUID, _reason: string): Promise<Result<void>> {
    this.reservations.delete(reservationId);
    return ok(undefined);
  }

  async transfer(request: TransferRequest): Promise<Result<void>> {
    // A reason is mandatory (BR-15): a transfer without one is an unanswerable
    // handover dispute later.
    if (request.reason.trim() === '') {
      return fail('REASON_REQUIRED', 'transfer requires a reason', 'FAIL_CLOSED');
    }
    return ok(undefined);
  }

  async escalate(request: EscalationRequest): Promise<Result<void>> {
    if (request.reason.trim() === '') {
      return fail('REASON_REQUIRED', 'escalation requires a reason', 'FAIL_CLOSED');
    }
    return ok(undefined);
  }

  async reportAgentState(principalId: UUID, state: AgentWorkState): Promise<Result<void>> {
    this.agentStates.set(principalId, state);
    return ok(undefined);
  }

  async queueSnapshot(teamId: string): Promise<Result<QueueMetrics>> {
    const waiting = [...this.queue.values()].filter((e) => e.teamId === teamId && e.state === 'WAITING');
    const oldest = waiting.reduce((acc, e) => Math.min(acc, e.enqueuedAt), Date.now());
    const byPriority: Record<string, number> = {};
    for (const entry of waiting) byPriority[entry.priority] = (byPriority[entry.priority] ?? 0) + 1;
    return ok({
      teamId,
      depth: waiting.length,
      oldestWaitingSeconds: waiting.length === 0 ? 0 : Math.floor((Date.now() - oldest) / 1000),
      byPriority,
      byIntent: {},
      availableCapacityUnits: 0,
    });
  }

  async health(): Promise<HealthReport> {
    return { status: 'UP', authority: 'MOCK', checkedAt: new Date().toISOString() };
  }
}
