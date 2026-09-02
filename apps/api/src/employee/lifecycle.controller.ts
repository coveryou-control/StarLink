/**
 * Resolving and reopening a customer conversation (doc §21.4, §11.5 BR-19–BR-22, UC-E18,
 * UC-E19).
 *
 * ## What was missing, and why nothing failed while it was
 *
 * §21.4's transition table was transcribed in `@starlink/service-case` and unit-tested
 * row for row. `case_state_episodes` was migrated with the exclusion constraint that makes
 * the history trustworthy. `conversation.resolve` and `conversation.reopen` were in the
 * action vocabulary with negative tests behind them. The reopen-window closure sweep was
 * built and tested. `decideReopen` was built and tested.
 *
 * And **nothing called `transition()`.** There was no way, from any surface, to move a
 * conversation to RESOLVED. Every piece around the hole was green, which is precisely why
 * the hole was invisible: the domain tests passed because the domain was correct, and the
 * closure sweep's tests passed because they seeded RESOLVED rows with raw SQL. A test that
 * creates the state it is testing cannot notice that nothing else can.
 *
 * Four consequences, all of them silent:
 *
 *   * an agent could never finish a conversation, so the RESOLUTION clock never stopped
 *     and every case eventually breached;
 *   * the closure sweep ran every tick against a predicate nothing could satisfy;
 *   * §29.2's `CUSTOMER_CONVERSATION_ANSWERED` row could never fire;
 *   * N-17's capacity hold was never released, because "release on resolve" needed a
 *     resolve.
 *
 * ## The shape
 *
 * Parse → authorize → ask §21.4 → write conditionally → audit → notify. The order is not
 * arbitrary. Authorization precedes the state read because the object check is the
 * boundary (rule 2). The audit write follows the state write because §31.1 audits what
 * happened, not what was attempted — and the notification follows the audit because
 * §29.3 lets a notification fail and never lets it cost the operation.
 *
 * The §21.4 ACTOR is taken from the authorization decision's `basis` rather than
 * re-derived. `decide()` has already established whether this principal is acting as the
 * owner or under a scoped grant; asking a second source the same question is how the two
 * come to disagree.
 */
import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { decide, toActorContext, type Decision } from '@starlink/conversation-domain';
import { isLifecycleBearing, transition, type LifecycleActor } from '@starlink/service-case';
import type { ConversationAuthzReader, PgCaseStore } from '@starlink/database';
import type {
  ConversationType,
  IdentityAuthorizationClient,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { AUDIT_WRITER, AUTHZ_READER, CASE_STORE, IDENTITY_CLIENT, LOGGER } from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { ConversationNotifier } from '../notifications/conversation-notifier.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';
import { recordDecision } from '../edge/authorization-metrics.js';

const uuid = z.string().uuid();

/**
 * BR-19's "an outcome is recorded", and §21.4's "Reason required: Yes — the outcome".
 *
 * Bounded but not enumerated. The document requires an outcome and never lists outcome
 * codes; whether they should become a closed administrable vocabulary the way categories
 * are is a business question nobody has been asked, and answering it here would be
 * inventing one (rule 10). `.min(1)` after trimming is the part that IS decided — a blank
 * outcome is not an outcome, and `transition()` refuses it independently.
 */
const resolveSchema = z.object({ outcome: z.string().trim().min(1).max(2000) });

/** §21.4: `resolved → active` requires a reason "if staff-initiated", which this is. */
const reopenSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

@Controller('v1/employee/conversations')
@RequireSurface('EMPLOYEE')
export class EmployeeLifecycleController {
  constructor(
    @Inject(CASE_STORE) private readonly cases: PgCaseStore,
    @Inject(AUTHZ_READER) private readonly authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
  ) {}

  /**
   * UC-E18 — "Owner | Resolve / close | With an outcome | P0".
   *
   * §21.4 permits this from ACTIVE, WAITING_CUSTOMER and WAITING_INTERNAL. The `from`
   * state is read here and passed to both the decision and the write, so a conversation
   * that moved in between is refused rather than resolved against stale facts.
   */
  @Post(':conversationId/resolve')
  async resolve(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = resolveSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString() as Timestamp;

    const decision = await this.authorize(
      session.principalId,
      conversationId.data,
      'conversation.resolve',
      at,
    );
    if (decision === undefined) return refuse();

    const head = await this.cases.head(conversationId.data);
    // Authorization succeeded against a resource the authz reader could load, so an
    // absent head here is a race with a delete, not a missing check.
    if (head === undefined) return refuse();

    /**
     * §21.4 and D-15: internal chat has "None. A thread exists and stays open
     * indefinitely" — no states, no resolve/close, no SLA, no case (BR-23).
     *
     * A refusal rather than a 400. Which conversations are internal is not a fact a
     * caller is entitled to probe from the shape of an error (§27.3).
     */
    if (!isLifecycleBearing(head.conversationType as ConversationType)) return refuse();
    /**
     * A customer-service conversation always has a case (§22.4) and §10's resolved event
     * requires it. Refusing rather than emitting an event with a hole: a consumer that
     * received `caseId: null` would have to guess, and the outbox is a contract.
     */
    if (head.caseId === undefined) return refuse();

    const permitted = transition({
      from: head.state,
      to: 'RESOLVED',
      actor: actorFor(decision),
      reason: parsed.data.outcome,
    });
    if (!permitted.ok) {
      this.logger.info('resolve refused', {
        operation: 'conversation.resolve',
        outcome: 'REFUSED',
        errorCode: permitted.refusal,
        detail: { conversationId: conversationId.data, from: head.state },
      });
      return refuse();
    }

    const written = await this.cases.resolve({
      conversationId: conversationId.data,
      from: head.state,
      resolvedBy: session.principalId,
      outcome: parsed.data.outcome,
      at,
      caseId: head.caseId!,
      correlationId: request.correlationId,
    });
    /**
     * Lost a race — another lead resolved it, or a customer's reply revived it between
     * the read and the write. Reported as an outcome rather than an error, for the reason
     * the claim endpoint reports `ALREADY_ASSIGNED` as one: an error status is retried by
     * any well-behaved client, and retrying a settled race produces a loop.
     */
    if (!written.ok) return { outcome: 'STATE_CHANGED' };

    /**
     * §21.4's "Audited: Yes", and §31.3's "Reason — where the action requires one
     * (transfer, escalation, resolution)". The outcome IS the reason; §31.1 lists
     * "Lifecycle — resolve (with outcome) · reopen · close" among what is audited.
     */
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.resolve',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      reason: parsed.data.outcome,
      correlationId: request.correlationId,
      detail: { from: head.state, basis: decision.basis },
    });

    // §29.2's customer row. Writes nothing until D-31 and N-07 land — see the notifier.
    await this.notifier.resolved(conversationId.data);

    return { outcome: 'RESOLVED', from: head.state };
  }

  /**
   * UC-E19 — "Owner, customer | Reopen | Inside a bounded window | P0", the staff half.
   *
   * The customer half is `reopenOnReply`, which runs on their next message and does more:
   * BR-22's fork past the window, and BR-21's "the same owner unless they have left".
   * Neither applies to a staff reopen. Past the window the conversation is CLOSED, and
   * §21.4 makes CLOSED terminal — `transition()` refuses it with
   * `CONVERSATION_IS_CLOSED`, so the window is enforced by the state rather than by a
   * second arithmetic here that could disagree with the sweep's.
   */
  @Post(':conversationId/reopen')
  async reopen(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = reopenSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString() as Timestamp;

    const decision = await this.authorize(
      session.principalId,
      conversationId.data,
      'conversation.reopen',
      at,
    );
    if (decision === undefined) return refuse();

    const head = await this.cases.head(conversationId.data);
    if (head === undefined) return refuse();
    if (!isLifecycleBearing(head.conversationType as ConversationType)) return refuse();
    if (head.caseId === undefined) return refuse();

    const permitted = transition({
      from: head.state,
      to: 'ACTIVE',
      actor: actorFor(decision),
      reason: parsed.data.reason,
      // §21.4's "Yes, if staff-initiated". This endpoint is only reachable from the
      // employee surface, so it always is.
      staffInitiated: true,
    });
    if (!permitted.ok) {
      this.logger.info('reopen refused', {
        operation: 'conversation.reopen',
        outcome: 'REFUSED',
        errorCode: permitted.refusal,
        detail: { conversationId: conversationId.data, from: head.state },
      });
      return refuse();
    }

    const written = await this.cases.reopen({
      conversationId: conversationId.data,
      reopenedBy: session.principalId,
      reason: parsed.data.reason,
      at,
      caseId: head.caseId!,
      correlationId: request.correlationId,
    });
    if (!written.ok) return { outcome: 'STATE_CHANGED' };

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.reopen',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      reason: parsed.data.reason,
      correlationId: request.correlationId,
      detail: { from: head.state, basis: decision.basis },
    });

    /**
     * §21.4's `resolved → active` row says "Customer notified: Yes" — but §29.2 has no
     * row for it, and §29.2 is the notification matrix. The customer learns of it the way
     * they learn of everything else about their own conversation: the status they read
     * goes back to being looked at. Adding a notification §29.2 does not list would be
     * inventing a product decision about when a customer's phone lights up.
     */
    return { outcome: 'REOPENED' };
  }

  /**
   * Layer 3, the object check (rule 2) — returns the DECISION, not a boolean.
   *
   * The basis is needed downstream to pick §21.4's actor, and returning it here is what
   * keeps that a single answer. `undefined` means refused, and the caller must not be
   * able to tell "no such conversation" from "not allowed" (§27.3).
   */
  private async authorize(
    principalId: UUID,
    conversationId: UUID,
    action: string,
    at: Timestamp,
  ): Promise<(Decision & { allow: true }) | undefined> {
    const resource = await this.authz.loadForAuthorization(conversationId, principalId, at);
    if (resource === undefined) return undefined;
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return undefined;
    /**
     * Cover grants, loaded for THIS conversation (N-53).
     *
     * `toActorContext` cannot supply these — it receives principal claims and does not
     * know which conversation is being decided — so it hardcoded `temporaryGrants: []`
     * and rung 6 of the ladder was dead in production. `grantCover` had been writing rows
     * since Phase 5 that nothing ever read.
     */
    const temporaryGrants = await this.authz.loadTemporaryGrants(conversationId, principalId, at);
    const decision = recordDecision(
      action,
      decide({
        actor: { ...toActorContext(claims.value), temporaryGrants },
        action,
        resource,
        now: at,
      }),
    );
    return decision.allow ? decision : undefined;
  }
}

/**
 * §21.4's actor, from the basis on which the action was authorized.
 *
 * `OWNER` is the accountable holder. Everything else that can reach a resolve is an
 * authority granted over the work rather than held by owning it — a team lead's scope
 * grant (BR-19's "or a lead"), a delegation, or a cover grant — and §21.4 models all of
 * those as `LEAD`.
 *
 * `PARTICIPANT` and `CUSTOMER_OWN` cannot appear: resolve and reopen are absent from
 * `PARTICIPANT_ACTIONS`, and a customer cannot reach an `@RequireSurface('EMPLOYEE')`
 * route. They map to `LEAD` anyway rather than being thrown on, because the transition
 * table is the second gate and refusing there is safer than refusing here — `LEAD` is not
 * a widening: every transition open to LEAD is one BR-19 already permits.
 */
const actorFor = (decision: Decision & { allow: true }): LifecycleActor =>
  decision.basis === 'OWNER' ? 'OWNER' : 'LEAD';
