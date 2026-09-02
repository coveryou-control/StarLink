/**
 * Administration (doc §25.2, §10.15).
 *
 * Two rules shape this controller:
 *
 *   * **Administration confers no read** (FR-AUTHZ-7). Whoever manages accounts is not
 *     thereby a reader of anyone's messages. Nothing here returns conversation content
 *     — deactivation returns case REFERENCES so the work can be reassigned, not the
 *     conversations themselves.
 *   * **Role assignment and deactivation are audited as MUST-SUCCEED** (FR-ADM-2,
 *     FR-AUD-5). Whoever assigns roles could otherwise grant themselves anything, so an
 *     unaudited administrative action is refused rather than performed quietly.
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { decide, toActorContext } from '@starlink/conversation-domain';
import { recordDecision } from '../edge/authorization-metrics.js';
import type { IdentityAuthorizationClient, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import type { PgAdminStore } from '@starlink/database';
import { ADMIN_STORE, AUDIT_WRITER, IDENTITY_CLIENT, LOGGER } from '../tokens.js';
import { AuditWriteFailed, type AuditWriter } from '../audit/audit-writer.js';
import { ConversationNotifier } from '../notifications/conversation-notifier.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const deactivateSchema = z.object({
  principalId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

const accountsSchema = z.object({
  q: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const grantRoleSchema = z.object({
  principalId: z.string().uuid(),
  role: z.string().min(1).max(80),
  scopeKind: z.enum(['GLOBAL', 'DEPARTMENT', 'TEAM', 'CONVERSATION']),
  scopeId: z.string().min(1).max(120).optional(),
  /** Optional expiry. A grant with an end date is the safer default for cover. */
  effectiveTo: z.string().datetime().optional(),
});

@Controller('v1/employee/admin')
@RequireSurface('EMPLOYEE')
export class EmployeeAdminController {
  constructor(
    @Inject(ADMIN_STORE) private readonly admin: PgAdminStore,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
  ) {}

  /**
   * Deactivates an employee (FR-EMP-2/3).
   *
   * Returns every open case they owned, because a deactivation that ended sessions but
   * left the work invisible is precisely the silent orphan BR-13 forbids. Reassignment
   * itself is a routing decision and is deliberately not made here.
   */
  @Post('deactivate')
  async deactivate(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = deactivateSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'admin.principal.deactivate'))) {
      // Refused attempts at privileged actions are audited: a burst is what probing
      // looks like (§31.3).
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.principal.deactivate',
        targetKind: 'principal',
        targetId: parsed.data.principalId,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const outcome = await this.admin.deactivate(parsed.data.principalId, parsed.data.reason);
    if (outcome === undefined) return refuse();

    try {
      // MUST-SUCCEED: an unattributable deactivation is worse than a refused one.
      await this.audit.record(
        {
          actorId: session.principalId,
          actorKind: 'EMPLOYEE',
          action: 'admin.principal.deactivate',
          targetKind: 'principal',
          targetId: parsed.data.principalId,
          outcome: 'SUCCEEDED',
          reason: parsed.data.reason,
          correlationId: request.correlationId,
          detail: { ownedOpenConversations: outcome.ownedOpenConversations.length },
        },
        { mustSucceed: true },
      );
    } catch (error) {
      if (error instanceof AuditWriteFailed) {
        this.logger.error('deactivation audit failed', {
          correlationId: request.correlationId,
          operation: 'admin.principal.deactivate',
          outcome: 'FAILED',
          errorCode: 'AUDIT_WRITE_FAILED',
        });
      }
      throw error;
    }

    // The employee's sessions are already dead — the store bumped the version, so the
    // next request on any live cookie fails its check (FR-AUTH-2).
    return {
      principalId: outcome.principalId,
      alreadyInactive: outcome.alreadyInactive,
      // References only. No conversation content: administration confers no read.
      ownedOpenConversations: outcome.ownedOpenConversations,
      reassignmentRequired: outcome.ownedOpenConversations.length > 0,
    };
  }

  /**
   * Employee accounts (FR-ADM-1).
   *
   * Returns account METADATA only — never a credential hash, never anything about the
   * conversations these people hold. Administration confers no read (FR-AUTHZ-7), and
   * the most natural way to violate that is an admin list that helpfully includes "12
   * open conversations" with titles attached.
   */
  @Get('accounts')
  async accounts(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = accountsSchema.safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'admin.principal.read'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.principal.read',
        targetKind: 'principal_collection',
        // A list has no single target. `*` says "the collection" explicitly rather than
        // leaving the column empty, which would read as a lost value rather than an
        // absent one when someone reviews the ledger.
        targetId: '*',
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const accounts = await this.admin.listAccounts({
      limit: parsed.data.limit,
      ...(parsed.data.q !== undefined ? { search: parsed.data.q } : {}),
    });
    return { accounts };
  }

  /** Live role×scope grants held by one principal. */
  @Get('roles/:principalId')
  async roles(
    @Param('principalId') principalIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const principalId = z.string().uuid().safeParse(principalIdRaw);
    if (!principalId.success) return refuse();

    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'admin.role.read'))) return refuse();

    const roles = await this.admin.listRoles(principalId.data, new Date());
    return { principalId: principalId.data, roles };
  }

  /**
   * Grants a role×scope (FR-ADM-2).
   *
   * Audited MUST-SUCCEED, and the audit is written BEFORE the response is returned:
   * whoever can assign roles can assign themselves anything, so a grant that happened
   * without a record is the one case where losing the audit is worse than losing the
   * operation.
   */
  @Post('roles')
  async grantRole(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = grantRoleSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'admin.role.assign'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.role.assign',
        targetKind: 'principal',
        targetId: parsed.data.principalId,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const at = new Date();
    const granted = await this.admin.grantRole({
      principalId: parsed.data.principalId,
      role: parsed.data.role,
      scopeKind: parsed.data.scopeKind,
      ...(parsed.data.scopeId !== undefined ? { scopeId: parsed.data.scopeId } : {}),
      grantedBy: session.principalId,
      ...(parsed.data.effectiveTo !== undefined
        ? { effectiveTo: new Date(parsed.data.effectiveTo) }
        : {}),
      assignmentId: crypto.randomUUID(),
      at,
    });
    if (granted === undefined) return refuse();

    await this.audit.record(
      {
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.role.assign',
        targetKind: 'principal',
        targetId: parsed.data.principalId,
        outcome: 'SUCCEEDED',
        correlationId: request.correlationId,
        detail: {
          role: granted.role,
          scopeKind: granted.scopeKind,
          ...(granted.scopeId !== undefined ? { scopeId: granted.scopeId } : {}),
          ...(granted.effectiveTo !== undefined ? { effectiveTo: granted.effectiveTo } : {}),
        },
      },
      { mustSucceed: true },
    );

    /**
     * §29.2: "A role or access change affecting you | The principal | In-app + external."
     *
     * The person whose access changed is told, and only they are. The notification names
     * the KIND of change and nothing else — access facts are read from the directory,
     * behind the authorization that guards them, not carried in a notification.
     *
     * After the audit, deliberately: the ledger entry is MUST-SUCCEED and the
     * notification is not, so the order is the one where a failure costs the less
     * important of the two.
     */
    await this.notifier.roleOrAccessChanged(parsed.data.principalId as UUID, 'ROLE_GRANTED');

    // The holder's sessions were version-bumped inside the same transaction, so the new
    // grant takes effect on their next request rather than at their next sign-in.
    return { granted };
  }

  /**
   * Revokes a grant.
   *
   * Dated, never deleted — "who could see this last March" is exactly what an audit
   * asks, and a deleted row cannot answer it (§17.3).
   */
  @Delete('roles/:assignmentId')
  async revokeRole(
    @Param('assignmentId') assignmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const assignmentId = z.string().uuid().safeParse(assignmentIdRaw);
    if (!assignmentId.success) return refuse();

    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'admin.role.assign'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.role.revoke',
        targetKind: 'role_assignment',
        targetId: assignmentId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const principalId = await this.admin.revokeRole(assignmentId.data, new Date());
    if (principalId === undefined) return refuse();

    await this.audit.record(
      {
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.role.revoke',
        targetKind: 'role_assignment',
        targetId: assignmentId.data,
        outcome: 'SUCCEEDED',
        correlationId: request.correlationId,
        detail: { principalId },
      },
      { mustSucceed: true },
    );

    await this.notifier.roleOrAccessChanged(principalId as UUID, 'ROLE_REVOKED');

    return { revoked: assignmentId.data, principalId };
  }

  /**
   * The invariant gauge, exposed for operators and for the alert in
   * infrastructure/monitoring/alerts.yml. Must read zero (§32.3).
   */
  @Get('inactive-owner-conversations')
  async inactiveOwners(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    if (!(await this.holdsAdminAction(session.principalId, 'load.read'))) return refuse();
    const count = await this.admin.countInactiveOwnerConversations();
    return { count, target: 0, healthy: count === 0 };
  }

  /**
   * Coarse permission check for an administrative operation.
   *
   * There is no conversation to authorize against here, so this is layer 2 of the
   * §18.4 ladder — "does this principal hold the permission in principle". It is
   * deliberately NOT a substitute for the object check, which does not apply to
   * operations that touch no conversation.
   */
  private async holdsAdminAction(principalId: string, action: string): Promise<boolean> {
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;
    return recordDecision(
      action,
      decide({
        actor: toActorContext(claims.value),
        action,
        resource: {
          // A synthetic global resource: administration is not conversation-scoped.
          conversationId: '00000000-0000-0000-0000-000000000000',
          conversationType: 'SYSTEM_INTERACTION',
          sensitivity: 'ORDINARY',
        },
        now: new Date().toISOString(),
      }),
    ).allow;
  }
}
