/**
 * Queue, claim and ownership operations (doc §21.7–21.9, BR-10, BR-15).
 *
 * Every handler here parses, authorises, and delegates to a domain command. The rules
 * live in `packages/routing`; what this file adds is the HTTP shape and the audit
 * correlation.
 *
 * Two properties worth stating because they are easy to lose in a controller:
 *
 *   * **A losing claim is not an ERROR.** The source is precise about what it requires and
 *     what it does not: §21's alternative flow says "the loser is told it is taken, **not
 *     shown an error**" (FR-ROUTE-3), and INTEGRATION_CONTRACTS §6 fixes the BODY —
 *     "losers get `{ outcome: 'ALREADY_ASSIGNED' }`". No status code is specified.
 *
 *     What arrives is 201, which is Nest's default for a POST handler returning a value.
 *     That satisfies the contract — 2xx, with the documented body — though 201 *Created*
 *     is a poor fit for a claim that created nothing. This comment previously said "a
 *     200", which was simply untrue of the code beneath it; corrected 2026-08-29 rather
 *     than changing the status, because the status is client-visible and the source does
 *     not ask for a different one.
 *
 *     The property that matters is why it is 2xx at all: an error status is retried by any
 *     well-behaved client, turning one settled race into a loop.
 *   * **Every ownership change carries a reason.** BR-15. The schema does not enforce it
 *     — `ownership_episodes.reason` is nullable, because a routed assignment has no
 *     human reason — so the commands do, and these handlers refuse without one.
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { decide, decideForTeam, toActorContext } from '@starlink/conversation-domain';
import { recordDecision } from '../edge/authorization-metrics.js';
import { cover, escalate, reassignOnExit, transfer, type CommandDeps } from '@starlink/routing';
import type {
  ConversationAuthzReader,
  PgAdminStore,
  PgTeamLoadReader,
  PgBusinessCalendarReader,
  PgRoutingStore,
  PgSlaReader,
} from '@starlink/database';
import { nextOpening, selectTarget, slaState } from '@starlink/sla';
import type { IdentityAuthorizationClient, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import {
  ADMIN_STORE,
  TEAM_LOAD_READER,
  AUDIT_WRITER,
  CALENDAR_READER,
  AUTHZ_READER,
  IDENTITY_CLIENT,
  LOGGER,
  ROUTING_STORE,
  SLA_READER,
} from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { ConversationNotifier } from '../notifications/conversation-notifier.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();
const reasonSchema = z.string().min(1).max(500);

const claimSchema = z.object({
  /** Makes a retried claim safe — a dropped response must not read as a second claimant. */
  idempotencyKey: z.string().min(1).max(200),
});
const transferSchema = z.object({ toOwner: uuid, reason: reasonSchema });
const escalateSchema = z.object({ toOwner: uuid, reason: reasonSchema });
const coverSchema = z.object({
  covererId: uuid,
  reason: reasonSchema,
  untilIso: z.string().datetime(),
});
const reassignSchema = z.object({ toOwner: uuid, reason: reasonSchema });

@Controller('v1/employee')
@RequireSurface('EMPLOYEE')
export class EmployeeRoutingController {
  constructor(
    @Inject(ROUTING_STORE) private readonly routing: PgRoutingStore,
    @Inject(SLA_READER) private readonly sla: PgSlaReader,
    @Inject(CALENDAR_READER) private readonly calendars: PgBusinessCalendarReader,
    @Inject(ADMIN_STORE) private readonly admin: PgAdminStore,
    @Inject(TEAM_LOAD_READER) private readonly teamLoad: PgTeamLoadReader,
    @Inject(AUTHZ_READER) private readonly authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
  ) {}

  /** A team's waiting work, oldest first within a priority band (§23.4). */
  @Get('queues/:teamId')
  async queue(
    @Param('teamId') teamId: string,
    @Query('limit') limitRaw: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const session = request.session!;
    // The team named in the PATH is the subject of the decision — see `mayReadTeam`.
    if (!(await this.mayReadTeam(session.principalId, teamId))) return refuse();

    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);
    const entries = await this.routing.queueView(teamId, limit);
    return {
      teamId,
      // No customer content — a queue view is a work list, and the body of a waiting
      // customer's message is not needed to decide whether to take it.
      entries: entries.map((entry) => ({
        queueEntryId: entry.queueEntryId,
        conversationId: entry.conversationId,
        priority: entry.priority,
        afterHours: entry.afterHours,
        enqueuedAt: entry.enqueuedAt,
      })),
    };
  }

  /**
   * A team's load and waiting work in one read (SL-083, doc O-07).
   *
   * O-07: *"Leadership can see load and waiting customers - queue and workload visible
   * without a report request."* The Grafana boards carry the same series for operators;
   * this is the in-product answer for a team lead, who does not have an ops login.
   *
   * ## Behind `queue.read`, not a new permission
   *
   * The queue itself is already gated on `queue.read`, held by AGENT (UC-E10) and
   * TEAM_LEAD. Minting a "leadership" permission to sit in front of this would be deciding
   * a piece of the role catalogue, and that is D-11's and HR's to decide, not this
   * endpoint's. Nothing here is more sensitive than the queue beside it: counts of work in
   * flight, and no customer content whatsoever.
   *
   * ## What is deliberately absent
   *
   * SL-083's acceptance is "no individual vanity leaderboard required". Per-person rows
   * carry only what is open *now*, because that is what answers "who can take this".
   * Nothing cumulative, nothing comparative, and no per-person timings.
   */
  @Get('queues/:teamId/load')
  async teamLoadView(
    @Param('teamId') teamId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const session = request.session!;
    if (!(await this.mayReadTeam(session.principalId, teamId))) return refuse();

    return this.teamLoad.loadFor(teamId, new Date().toISOString());
  }

  /**
   * Claims a waiting conversation. Golden test G-06 at the HTTP boundary.
   *
   * Losing is a 200 with `ALREADY_ASSIGNED`. That is not politeness — an error status
   * would be retried by any well-behaved client, turning one settled race into a loop
   * against a conversation that already has an owner.
   */
  @Post('conversations/:conversationId/claim')
  async claim(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = claimSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    /**
     * The OBJECT check, not the permission check (§18.4 step 3, §46 rule 2).
     *
     * This was `mayDo`, which evaluates `decide()` against a fabricated resource carrying
     * the caller's own principal id as its `conversationId`, `CUSTOMER_SERVICE` as its type
     * and `ORDINARY` as its sensitivity — with no `owningTeamId` at all. Two consequences,
     * pulling in opposite directions and both wrong:
     *
     *   * `scopeCovers` cannot satisfy a TEAM-scoped grant without an owning team, so a
     *     team-scoped AGENT was refused every claim. The fixtures compensated by granting
     *     GLOBAL, which hid the defect and created the next one.
     *   * With a GLOBAL grant, every claim was allowed regardless of the conversation's
     *     team, department or sensitivity — and `claimConversation` filters only on
     *     `state = 'WAITING'`. So an agent could claim a MEDICAL conversation queued to
     *     Claims, and once `current_owner_id` was theirs, `decide()` short-circuits into
     *     the OWNER branch, which deliberately skips sensitivity because an owner is
     *     already inside. Claiming was the way in.
     *
     * Against the real conversation, the grant's scope and `passesSensitivity` both apply,
     * which is what makes sensitivity segmentation mean anything on this path.
     */
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.claim'))) {
      return refuse();
    }

    const outcome = await this.routing.claimConversation({
      conversationId: conversationId.data,
      claimedBy: session.principalId,
      episodeId: crypto.randomUUID(),
      at: new Date().toISOString(),
      // Ties the participation-grant ledger row written inside that transaction to the
      // rest of this request, including the `conversation.claim` row recorded below.
      correlationId: request.correlationId,
    });

    if (!outcome.ok) {
      // NOT_QUEUED renders as a refusal — it is indistinguishable from "no such
      // conversation" and must stay that way (§27.3). ALREADY_ASSIGNED is an answer.
      if (outcome.reason === 'NOT_QUEUED') return refuse();
      return { outcome: 'ALREADY_ASSIGNED' };
    }

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.claim',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
    });

    return { outcome: 'CLAIMED', episodeId: outcome.episode.episodeId };
  }

  @Post('conversations/:conversationId/transfer')
  async transferConversation(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = transferSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.transfer'))) {
      return refuse();
    }

    const result = await transfer(
      {
        conversationId: conversationId.data,
        toOwner: parsed.data.toOwner,
        transferredBy: session.principalId,
        reason: parsed.data.reason,
        at: new Date().toISOString(),
        targetAvailable: await this.isActive(parsed.data.toOwner),
      },
      this.commandDeps(request),
    );

    if (!result.ok) {
      this.logger.info('transfer refused', {
        correlationId: request.correlationId,
        operation: 'conversation.transfer',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      return refuse();
    }
    /**
     * §29.2: "A conversation transferred to/from you | Both parties | In-app + external."
     *
     * After the command committed, and unable to undo it — the notifier writes outbox
     * rows and swallows its own failures (§29.1's P-05 ordering). `previousOwner` comes
     * from the command's result rather than from a re-read: the episode it closed is the
     * one the outgoing owner held, and re-reading would return the new owner.
     */
    await this.notifier.transferred(
      conversationId.data,
      result.value.previousOwner,
      parsed.data.toOwner,
    );

    return { episodeId: result.value.episodeId };
  }

  @Post('conversations/:conversationId/escalate')
  async escalateConversation(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = escalateSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.escalate'))) {
      return refuse();
    }

    const result = await escalate(
      {
        conversationId: conversationId.data,
        toOwner: parsed.data.toOwner,
        escalatedBy: session.principalId,
        reason: parsed.data.reason,
        at: new Date().toISOString(),
        targetAvailable: await this.isActive(parsed.data.toOwner),
      },
      this.commandDeps(request),
    );

    if (!result.ok) return refuse();

    // §29.2: "A conversation escalated to your function | Receiving officer, lead."
    await this.notifier.escalated(conversationId.data, parsed.data.toOwner);

    // The LEVEL is returned to staff and never to a customer (§22.5).
    return { episodeId: result.value.episodeId, level: result.value.level };
  }

  /**
   * Grants cover while the owner is briefly away (§21.9 cases A and D).
   *
   * Ownership does NOT move. The response says so explicitly, because the whole risk
   * here is a UI that presents cover as a hand-off and trains people to expect one.
   */
  @Post('conversations/:conversationId/cover')
  async coverConversation(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = coverSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.transfer'))) {
      return refuse();
    }

    const now = new Date().toISOString();
    const result = await cover(
      {
        conversationId: conversationId.data,
        covererId: parsed.data.covererId,
        grantedBy: session.principalId,
        reason: parsed.data.reason,
        from: now,
        until: parsed.data.untilIso,
      },
      this.commandDeps(request),
    );

    if (!result.ok) return refuse();
    return {
      grantId: result.value.grantId,
      ownerUnchanged: result.value.ownerUnchanged,
      until: parsed.data.untilIso,
    };
  }

  /**
   * Reassigns work owned by a departed colleague (§21.9 case C, FR-EMP-3, BR-13).
   *
   * The counterpart to the deactivation endpoint, which surfaces every open case a
   * leaver owned and deliberately does NOT reassign — who takes the work is a routing
   * decision, and this is where it lives. Until it runs, those cases are unreachable
   * work, which is why §32.3 monitors the count with a target of zero.
   */
  @Post('admin/reassign/:conversationId')
  async reassignFromExit(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = reassignSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    /**
     * Object-checked, like every sibling verb on this controller.
     *
     * This alone used the permission-only path while transfer, escalate, cover, resolve
     * and reopen all used `mayActOn` — so a TEAM_LEAD holding a GLOBAL grant could
     * reassign ANY conversation in the company to themselves, at any sensitivity, in any
     * department. `reassignOnExit` then passes `preserveDesignated: false`, which
     * permanently rewrites the customer's designated advisor: not a reversible action.
     *
     * The endpoint's legitimate purpose — placing work whose owner has left — is unchanged
     * by this. It restricts WHOSE work the caller may place, which is exactly the
     * distinction the permission-only check could not express.
     */
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.transfer'))) {
      return refuse();
    }

    const result = await reassignOnExit(
      {
        conversationId: conversationId.data,
        toOwner: parsed.data.toOwner,
        reassignedBy: session.principalId,
        reason: parsed.data.reason,
        at: new Date().toISOString(),
        targetAvailable: await this.isActive(parsed.data.toOwner),
      },
      this.commandDeps(request),
    );

    if (!result.ok) return refuse();

    // The invariant this endpoint exists to restore, reported back so an operator can
    // see it fall rather than having to go and ask (§32.3).
    const remaining = await this.admin.countInactiveOwnerConversations();
    return { episodeId: result.value.episodeId, inactiveOwnerConversations: remaining };
  }

  /** Ownership history — append-only, so this is the audit answer (§17.3). */
  @Get('conversations/:conversationId/ownership')
  async ownership(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.read'))) {
      return refuse();
    }

    return { episodes: await this.routing.ownershipHistory(conversationId.data) };
  }

  /**
   * The SLA clocks for one conversation (§22.5, §23.5).
   *
   * Computed on read, every time. Nothing is cached and no deadline is stored, so a
   * calendar corrected this morning changes what this returns this afternoon — which is
   * §23.5's whole reason for the model: "a calendar correction fixes history rather than
   * leaving it wrong".
   *
   * Employee-only, and the authorization is the same object check every other route on
   * this controller uses. §22.5 gives the customer "Never" for SLA state, and calls it
   * the row carrying the most risk: "A customer who can see 'first response breached' has
   * been handed a grievance the company generated itself."
   */
  @Get('conversations/:conversationId/sla')
  async slaClocks(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.read'))) {
      return refuse();
    }

    const facts = await this.sla.factsFor(conversationId.data);
    if (facts === undefined || facts.teamId === undefined) return refuse();

    const at = new Date().toISOString() as never;
    const calendars = await this.calendars.historyFor(facts.teamId);
    const targets = await this.sla.targetsFor(
      {
        ...(facts.categoryId !== undefined ? { categoryId: facts.categoryId } : {}),
        teamId: facts.teamId,
      },
      at,
    );

    // §23.5 case B: an after-hours arrival starts no clock until the team opens.
    const startedAt = facts.afterHours ? nextOpening(calendars, facts.arrivedAt) : facts.arrivedAt;

    const clocks = (['FIRST_RESPONSE', 'RESOLUTION'] as const).flatMap((clock) => {
      const target = selectTarget(targets, facts, clock);
      // No configured target means no promise was made (§44.5 D-22). Absent from the
      // response rather than reported as a clock at zero, which would imply one exists.
      if (target === undefined) return [];

      const stoppedAt =
        clock === 'FIRST_RESPONSE' ? facts.firstCustomerVisibleReplyAt : facts.resolvedAt;

      return [
        slaState(
          target,
          {
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(stoppedAt !== undefined ? { stoppedAt } : {}),
            pauses: facts.waitingOnCustomerSpans,
          },
          calendars,
          at,
        ),
      ];
    });

    return {
      conversationId: conversationId.data,
      clocks,
      // Surfaced so an employee can see the number came from a target nobody has signed
      // off (§68 gate 8, D-22). A provisional promise presented as settled is how a
      // placeholder becomes policy.
      provisional: clocks.some((c) => c.provisional),
    };
  }

  /** The ports the domain commands need, bound to this request's correlation id. */
  private commandDeps(request: AuthenticatedRequest): CommandDeps {
    return {
      ownership: {
        currentOwner: async (conversationId) =>
          (await this.routing.currentOwner(conversationId))?.ownerId,
        reassign: async (input) => {
          const episode = await this.routing.reassign({
            ...input,
            episodeId: crypto.randomUUID(),
            // Same reason as `claim`: the participation grant is written inside that
            // transaction and should carry this request's id.
            correlationId: request.correlationId,
          });
          return { episodeId: episode.episodeId };
        },
        grantCover: async (input) => this.routing.grantCover({ ...input, grantId: crypto.randomUUID() }),
        raiseEscalationLevel: async (input) => this.routing.raiseEscalationLevel(input),
      },
      audit: {
        record: async (entry) => {
          await this.audit.record({
            actorId: entry.actorId,
            actorKind: 'EMPLOYEE',
            action: entry.action,
            targetKind: 'conversation',
            targetId: entry.targetId,
            outcome: 'SUCCEEDED',
            reason: entry.reason,
            correlationId: request.correlationId,
            ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          });
        },
      },
    };
  }

  /*
   * `mayDo` used to live here — a permission-only check that ran `decide()` against a
   * FABRICATED resource: the caller's own principal id as `conversationId`, no owning
   * team, and `ORDINARY` asserted rather than read.
   *
   * It has been DELETED rather than kept for a future caller, because every one of its
   * four call sites turned out to be wrong. `conversation.claim` and `admin/reassign`
   * named a conversation in their own path and never checked it; the two queue reads named
   * a team in their own path and never checked that either. A helper whose every use was a
   * defect is not a tool waiting for the right job — it is the wrong shape, and leaving it
   * available is leaving the next person something to reach for.
   *
   * What replaced it: `mayActOn` for anything naming a conversation, `mayReadTeam` for
   * anything naming a team. `routing-authorization.test.ts` fails the build if a handler
   * appears with neither, or if the synthetic resource comes back.
   */

  /**
   * Layer 3 for a TEAM: load the team and authorise against IT.
   *
   * The queue reads used `mayDo`, which asks only "does this person hold `queue.read`
   * anywhere?" and never looked at the `:teamId` in the path. Any employee with the
   * permission — every AGENT has it, per UC-E10 — could read any team's waiting work and
   * its per-person workload. Nothing in the response is customer content, so this is not a
   * content leak; it is the organisation's internal structure and staffing, which §25.3
   * treats as its own thing worth scoping.
   *
   * `decideForTeam` applies the SAME scope semantics `decide` already uses — GLOBAL covers
   * everything, DEPARTMENT and TEAM must both match the subject and be held by the actor,
   * and a CONVERSATION-scoped grant covers no queue at all. No new permission, no new
   * scope kind, and `queue.read` still means what UC-E10 says it means.
   *
   * An unknown team is refused rather than answered with an empty queue: the two are
   * indistinguishable to a caller (§27.3), which is what stops this being a way to
   * enumerate the team list.
   */
  private async mayReadTeam(principalId: UUID, teamId: string): Promise<boolean> {
    const team = await this.teamLoad.contextFor(teamId);
    if (team === undefined) return false;

    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;

    return recordDecision(
      'queue.read',
      decideForTeam({
        actor: toActorContext(claims.value),
        action: 'queue.read',
        team,
        now: new Date().toISOString(),
      }),
    ).allow;
  }

  /** Layer 3: the object check — load the conversation and authorise against IT. */
  private async mayActOn(principalId: UUID, conversationId: UUID, action: string): Promise<boolean> {
    const at = new Date().toISOString();
    const resource = await this.authz.loadForAuthorization(conversationId, principalId, at);
    if (resource === undefined) return false;
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;
    /**
     * Cover grants, loaded for THIS conversation (N-53).
     *
     * `toActorContext` cannot supply these — it receives principal claims and does not
     * know which conversation is being decided — so it hardcoded `temporaryGrants: []`
     * and rung 6 of the ladder was dead in production. `grantCover` had been writing rows
     * since Phase 5 that nothing ever read.
     */
    const temporaryGrants = await this.authz.loadTemporaryGrants(conversationId, principalId, at);
    return recordDecision(
      action,
      decide({
        actor: { ...toActorContext(claims.value), temporaryGrants },
        action,
        resource,
        now: at,
      }),
    ).allow;
  }

  /** A transfer target must be an ACTIVE employee — BR-13, and §21.9 case C's lesson. */
  private async isActive(principalId: UUID): Promise<boolean> {
    const claims = await this.identity.resolvePrincipal(principalId);
    return claims.ok && claims.value.status === 'ACTIVE';
  }
}
