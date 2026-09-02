/**
 * The in-app notification list (doc §19.6, §20.7, §29.2).
 *
 * §29's preamble: **"In-app notification is required for V1."** §29.6 makes it the one
 * channel nobody can switch off — "in-app is not disableable — it is the unread
 * mechanism". Until this controller existed the pipeline wrote in-app rows that no client
 * could read: the required channel of the required feature was write-only, and every
 * test passed because each half was correct on its own.
 *
 * ## What the document specifies, and what it leaves to us
 *
 * §19.6 — "Notification list · **server-owned; the client polls or receives an event** ·
 * actionable items only (§29.2)". §20.7's `Notification created` row adds the rest:
 * received by "the recipient's personal room", **transport required: No**, fallback "
 * notification list on load", authorization "personal room, self only", duplicates
 * "discard known id".
 *
 * So the REST list here is not a lesser alternative to realtime — it is the fallback the
 * table names, and §20.3's rule makes it the authority: "no state exists only in an
 * event; a client that missed every event is correct after a reload." The realtime event
 * is the optional immediacy layer, and is marked *not required*.
 *
 * Per-notification READ state is the one part with no source behind it. It was taken as
 * an engineering decision on 2026-08-28 (N-19) — see migration 0010 for why it is not
 * derived from the conversation's read state.
 *
 * ## Authorization is the recipient predicate, and nothing else
 *
 * "Personal room, self only." There is no conversation to run the §18.4 object check
 * against — a notification is not conversation-scoped, and two of §29.2's rows are not
 * about a conversation at all. So the boundary is that every query is scoped by the
 * principal id **from the session**, never from the path or the body. There is
 * deliberately no `GET /notifications/:principalId`: a route that took a principal id
 * would be one authorization slip away from reading somebody else's.
 */
import { Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { subjectFor } from '@starlink/notifications';
import { z } from 'zod';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { PgNotificationOutbox } from '@starlink/database';
import { NOTIFICATION_OUTBOX } from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z.coerce.boolean().default(false),
});

@Controller('v1/employee/notifications')
@RequireSurface('EMPLOYEE')
export class EmployeeNotificationsController {
  constructor(@Inject(NOTIFICATION_OUTBOX) private readonly outbox: PgNotificationOutbox) {}

  /**
   * This principal's in-app notifications, newest first.
   *
   * Body-free by construction — the outbox never held message content, so there is
   * nothing to filter out here. Each item is a reference and an event name; the thing it
   * points at stays behind the authorization that guards it. A notification list that
   * carried conversation excerpts would be a copy of the inbox with the object check
   * removed, which is the objection §30.4 makes about a search index.
   */
  @Get()
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = listSchema.safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;
    const rows = await this.outbox.listFor(session.principalId as UUID, {
      limit: parsed.data.limit,
      unreadOnly: parsed.data.unreadOnly,
    });

    return {
      notifications: rows.map((row) => ({
        notificationId: row.notificationId,
        event: row.event,
        /**
         * §29.2's "Notified" column, transcribed once in `matrix.ts` and sent from here.
         *
         * The alternative was for the web bundle to hold its own copy of the wording —
         * ADR-026 forbids a browser importing server code, so it would have been a second
         * transcription. Two copies of the product's voice drift, and the one that drifts
         * is the one nobody diffs against §29.2.
         */
        subject: subjectFor(row.event),
        ...(row.targetRef !== undefined ? { targetRef: row.targetRef } : {}),
        payload: row.payload,
        /**
         * §29.5's "'3 new messages', not three notifications". The row is the first
         * event and `coalescedCount` is how many folded into it, so the total is one
         * more — the client renders the number rather than recomputing it.
         */
        count: row.coalescedCount + 1,
        ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
        read: row.readAt !== undefined,
      })),
    };
  }

  /** What the bell shows. Counted in the database so it cannot drift from the list. */
  @Get('count')
  async count(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    return { unread: await this.outbox.unreadCount(session.principalId as UUID) };
  }

  /**
   * Marks one notification read.
   *
   * `changed: false` covers two cases deliberately — already read, and not yours — and
   * says which only in the first sense. Distinguishing them in the response would turn
   * this into an oracle for whether a given notification id exists, which is a small
   * enumeration surface for no benefit to the caller: either way there is nothing further
   * for them to do.
   */
  @Post(':notificationId/read')
  async markRead(
    @Param('notificationId') notificationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const notificationId = z.string().uuid().safeParse(notificationIdRaw);
    if (!notificationId.success) return refuse();

    const session = request.session!;
    const changed = await this.outbox.markRead(
      session.principalId as UUID,
      notificationId.data as UUID,
      new Date().toISOString() as Timestamp,
    );
    return { changed };
  }

  /** Clears the bell in one call, rather than one request per item. */
  @Post('read-all')
  async markAllRead(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const cleared = await this.outbox.markAllRead(
      session.principalId as UUID,
      new Date().toISOString() as Timestamp,
    );
    return { cleared };
  }
}
