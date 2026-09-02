/**
 * The notification dead letter, and the tooling to replay it (ADR-006, §29.6, §32.4).
 *
 * ADR-006's job-fabric decision ends with "DLQ per queue with replay tooling", and §29.6
 * names the case it exists for: "Permanent failure (invalid address) — row dead-lettered,
 * principal flagged for administrative attention. Not retried forever."
 *
 * A dead letter with no way to see it is a silent failure with extra steps. The row is
 * kept as evidence that somebody was not told something, `starlink_notification_dead_letter`
 * alerts on the count, and this is where an operator reads what is in it and re-sends
 * once the cause is fixed.
 *
 * ## Administration confers no read (FR-AUTHZ-7)
 *
 * Nothing here returns conversation content, and there is nothing to filter out: the
 * outbox payload is body-free by construction — a notification says there is something
 * to look at, and the thing stays behind the authorization that guards it. What comes
 * back is a REFERENCE (`targetRef`), the same shape the deactivation endpoint returns for
 * a leaver's open cases.
 *
 * ## Replay is audited, and the audit is not best-effort
 *
 * Re-sending is an act with an external side effect, so the ledger records who asked for
 * it. Refused attempts are recorded too: a burst of them is what probing looks like
 * (§31.3).
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { decide, toActorContext } from '@starlink/conversation-domain';
import { recordDecision } from '../edge/authorization-metrics.js';
import type { IdentityAuthorizationClient, Timestamp, UUID } from '@starlink/shared-contracts';
import type { PgNotificationOutbox } from '@starlink/database';
import { AUDIT_WRITER, IDENTITY_CLIENT, NOTIFICATION_OUTBOX } from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const replaySchema = z.object({
  /**
   * Why this is being re-sent. Required, because the useful question six months later is
   * not "was it replayed" but "what had been fixed by then".
   */
  reason: z.string().min(1).max(500),
});

@Controller('v1/employee/admin/notifications')
@RequireSurface('EMPLOYEE')
export class NotificationAdminController {
  constructor(
    @Inject(NOTIFICATION_OUTBOX) private readonly outbox: PgNotificationOutbox,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  /**
   * Backlog depth and dead-letter count — the two numbers §32.4 alerts on.
   *
   * Exposed over HTTP as well as through the metrics endpoint so an operator answering a
   * page can get the same figure the alert saw, from the same query, without a Prometheus
   * round trip. A second source that could disagree with the alert would be worse than no
   * endpoint at all, which is why both read `counts()`.
   */
  @Get('counts')
  async counts(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    if (!(await this.holds(session.principalId, 'admin.notification.replay'))) return refuse();
    const counts = await this.outbox.counts();
    return { ...counts, deadLetterTarget: 0, healthy: counts.deadLetter === 0 };
  }

  /** What is in the dead letter. References and reasons; never message content. */
  @Get('dead-letter')
  async deadLetter(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = listSchema.safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.holds(session.principalId, 'admin.notification.replay'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.notification.replay',
        targetKind: 'notification_collection',
        // A list has no single target; `*` says "the collection" rather than leaving the
        // column looking like a lost value.
        targetId: '*',
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const rows = await this.outbox.deadLettered(parsed.data.limit);
    return {
      deadLettered: rows.map((row) => ({
        notificationId: row.notificationId,
        recipientId: row.recipientId,
        recipientKind: row.recipientKind,
        channel: row.channel,
        event: row.event,
        ...(row.targetRef !== undefined ? { targetRef: row.targetRef } : {}),
        attempts: row.attempts,
      })),
    };
  }

  /**
   * Returns one dead-lettered row to the queue.
   *
   * One at a time and by id, not "replay everything". A bulk replay after a week-long
   * provider outage would re-send a week of stale notifications at once — telling people
   * about conversations that have since been resolved, which is the behaviour that
   * teaches a team to ignore the product.
   */
  @Post(':notificationId/replay')
  async replay(
    @Param('notificationId') notificationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const notificationId = z.string().uuid().safeParse(notificationIdRaw);
    const parsed = replaySchema.safeParse(body);
    if (!notificationId.success || !parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.holds(session.principalId, 'admin.notification.replay'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'admin.notification.replay',
        targetKind: 'notification',
        targetId: notificationId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const at = new Date().toISOString() as Timestamp;
    const requeued = await this.outbox.replay(notificationId.data as UUID, at);
    /**
     * `false` means the row was not in DEAD_LETTER — already replayed by a colleague, or
     * never dead in the first place. The conditional UPDATE is what makes two operators
     * clicking at once produce one replay; reporting it plainly is better than a second
     * "queued" that quietly did nothing.
     */
    if (!requeued) return { replayed: false, reason: 'NOT_DEAD_LETTERED' };

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'admin.notification.replay',
      targetKind: 'notification',
      targetId: notificationId.data,
      outcome: 'SUCCEEDED',
      reason: parsed.data.reason,
      correlationId: request.correlationId,
    });

    return { replayed: true, notificationId: notificationId.data };
  }

  /**
   * Layer 2 of the §18.4 ladder — "does this principal hold the permission in principle".
   * There is no conversation to authorize against, so the object check does not apply.
   */
  private async holds(principalId: string, action: string): Promise<boolean> {
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;
    return recordDecision(
      action,
      decide({
        actor: toActorContext(claims.value),
        action,
        resource: {
          conversationId: '00000000-0000-0000-0000-000000000000',
          conversationType: 'SYSTEM_INTERACTION',
          sensitivity: 'ORDINARY',
        },
        now: new Date().toISOString(),
      }),
    ).allow;
  }
}
