/**
 * Work Orchestrator contract (brief §11, INTEGRATION_CONTRACTS §6).
 *
 * StarLink does NOT build a competing work allocator. This interface is the seam:
 * the Phase-5 LocalWorkOrchestratorAdapter implements the full §21.8 decision tree as
 * reference semantics, and the Phase-10 Remote adapter delegates to CCS Work
 * Orchestrator. Routing rules live in configuration and in the adapter — never
 * scattered through controllers or UI.
 */
import type {
  AgentWorkState,
  CanonicalRef,
  ChannelKind,
  SensitivityClass,
  Timestamp,
  UUID,
} from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';

export interface RoutingContext {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  readonly intent: { readonly category: string; readonly subCategory?: string };
  readonly product?: string;
  readonly language?: string;
  readonly priority?: string;
  readonly customerRef?: CanonicalRef;
  /** The designated relationship advisor, if the customer has one (doc §21.7). */
  readonly relationshipOwner?: UUID;
  readonly activeBusinessObjects?: readonly CanonicalRef[];
  readonly channel: ChannelKind;
  readonly sensitivity?: SensitivityClass;
  readonly slaTargetRef?: string;
  readonly businessHoursState: 'OPEN' | 'AFTER_HOURS';
  readonly requiredSkills?: readonly string[];
}

/**
 * QUEUED is a first-class success, not a failure.
 *
 * Intake never waits synchronously for an agent (brief §18.3). A conversation that
 * cannot be assigned is visibly queued, never silently held.
 */
export type RoutingDecision =
  | { readonly outcome: 'ASSIGNED'; readonly principalId: UUID; readonly reservationId: UUID; readonly reason: string }
  | { readonly outcome: 'QUEUED'; readonly queueEntryId: UUID; readonly queuePosition?: number; readonly reason: string }
  | { readonly outcome: 'DEFERRED_AFTER_HOURS'; readonly queueEntryId: UUID };

/**
 * Claim outcome. Exactly one claimant wins (brief §44).
 *
 * The loser is TOLD IT IS TAKEN — this is a normal outcome, not an error, and the
 * distinction matters because an error would be retried.
 */
export type ClaimOutcome =
  | { readonly outcome: 'CLAIMED'; readonly conversationId: UUID; readonly reservationId: UUID }
  | { readonly outcome: 'ALREADY_ASSIGNED'; readonly currentOwner: UUID };

export interface Reservation {
  readonly reservationId: UUID;
  readonly principalId: UUID;
  readonly workRef: CanonicalRef;
  readonly weight: number;
  readonly expiresAt: Timestamp;
}

export interface TransferRequest {
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  readonly fromPrincipal: UUID;
  readonly toPrincipal?: UUID;
  readonly toTeam?: string;
  /** Mandatory (BR-15). A transfer without a reason is an unanswerable handover dispute. */
  readonly reason: string;
  readonly actor: UUID;
}

export interface EscalationRequest {
  readonly conversationId: UUID;
  readonly caseId: UUID;
  readonly toLevel: number;
  readonly toTeam?: string;
  readonly reason: string;
  readonly actor: UUID;
}

export interface QueueMetrics {
  readonly teamId: string;
  readonly depth: number;
  readonly oldestWaitingSeconds: number;
  readonly byPriority: Readonly<Record<string, number>>;
  readonly byIntent: Readonly<Record<string, number>>;
  readonly availableCapacityUnits: number;
}

export interface WorkOrchestratorClient extends HealthReporting {
  requestRouting(context: RoutingContext): Promise<Result<RoutingDecision>>;
  /**
   * Atomic claim. Implementations MUST guarantee exactly one winner under concurrency
   * (golden tests G-06, G-07). The idempotency key makes a retried claim safe.
   */
  claim(queueEntryId: UUID, principalId: UUID, idempotencyKey: string): Promise<Result<ClaimOutcome>>;
  /** Weighted capacity reservation with TTL; expiry returns the work to the queue (ADR-023). */
  reserve(principalId: UUID, workRef: CanonicalRef, weight: number, ttlSeconds: number): Promise<Result<Reservation>>;
  release(reservationId: UUID, reason: string): Promise<Result<void>>;
  transfer(request: TransferRequest): Promise<Result<void>>;
  escalate(request: EscalationRequest): Promise<Result<void>>;
  reportAgentState(principalId: UUID, state: AgentWorkState): Promise<Result<void>>;
  queueSnapshot(teamId: string): Promise<Result<QueueMetrics>>;
}
