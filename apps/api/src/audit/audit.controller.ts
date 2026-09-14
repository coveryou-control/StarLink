/**
 * The communication audit surface: read, and only read.
 *
 * ## Why this is a separate controller rather than a flag on the employee one
 *
 * Because read-only should be a property of the SHAPE, not a rule somebody has to keep
 * remembering. Every handler here is a `@Get`; there is no `@Post`, `@Patch` or `@Delete` in
 * the file, and adding one would be visible in a diff in a way that adding a branch inside
 * an existing write handler is not. The employee API would have refused these writes anyway
 * — `SUPERADMIN` holds no write action and `decide()` denies what it was not granted — but
 * "the role cannot" and "the surface has no such door" are different guarantees and this
 * feature deserves both.
 *
 * ## What it deliberately does NOT do
 *
 * No read receipts, no marking anything read, no notifications, no presence, no typing.
 * Every one of those is a WRITE performed by a read path elsewhere in the product, and each
 * would be visible to the people being audited — an audit that announces itself to its
 * subject is not an audit. They are absent rather than suppressed: this file calls the
 * readers directly and never touches `READ_STATE_STORE`, `ConversationNotifier` or the
 * realtime gateway, so there is nothing to switch off and nothing to forget to switch off.
 *
 * `GET /conversations/:id/messages` on the employee tree does not mark anything read either
 * — that is `POST /read`, a separate call — so reusing `MessageReader` here carries no
 * hidden write with it.
 *
 * ## Every handler asks `decide()` and writes a ledger row
 *
 * Through `permitAuditRead`, which does both and refuses uniformly. Nothing in this file
 * decides authorization for itself.
 */
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import type { MessageReader } from '@starlink/messaging';
import type { IdentityAuthorizationClient, UUID } from '@starlink/shared-contracts';

import {
  AUDIT_RATE_LIMITER,
  AUDIT_WRITER,
  DATABASE,
  IDENTITY_CLIENT,
  MESSAGE_READER,
} from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';
import type { AuditWriter } from './audit-writer.js';
import { permitAuditRead } from './audit-access.js';

const uuid = z.string().uuid();

/**
 * A synthetic target for the reads that are not about one conversation.
 *
 * The employee list and the ledger have no conversation in question, and `decide()` needs a
 * resource. A fixed, obviously-not-real id keeps the ledger honest: a row naming this id is
 * a surface-wide read, not a thread somebody opened.
 */
const WHOLE_COMPANY = '00000000-0000-0000-0000-000000000000';

const conversationFilter = z.object({
  /** Conversations this person took part in, at any time. */
  employeeId: uuid.optional(),
  teamId: z.string().min(1).max(120).optional(),
  type: z
    .enum([
      'INTERNAL_DIRECT',
      'INTERNAL_GROUP',
      'INTERNAL_CHANNEL',
      'INTERNAL_ANNOUNCEMENT',
      'CUSTOMER_SERVICE',
      'CUSTOMER_SALES',
      'CUSTOMER_RENEWAL',
      'CUSTOMER_CLAIM',
      'CUSTOMER_GRIEVANCE',
      'CUSTOMER_GENERAL',
    ])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const messageFilter = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Message kind, so an audit can ask for "the files" or "the voice notes" alone. */
  kind: z.enum(['ALL', 'TEXT', 'ATTACHMENT', 'VOICE']).default('ALL'),
});

const searchQuery = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ledgerQuery = z.object({
  actorId: uuid.optional(),
  action: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@Controller('v1/audit')
@RequireSurface('EMPLOYEE')
export class AuditController {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(MESSAGE_READER) private readonly messages: MessageReader,
    @Inject(AUDIT_RATE_LIMITER) private readonly limiter: { allow: (key: string) => boolean },
  ) {}

  private deps(): { identity: IdentityAuthorizationClient; audit: AuditWriter } {
    return { identity: this.identity, audit: this.audit };
  }

  /**
   * One gate for every handler: rate limit, then decide, then record.
   *
   * Written once rather than repeated per endpoint, because a surface where each door does
   * its own checks is a surface where one door eventually does fewer. The rate limit comes
   * FIRST so a caller being throttled cannot also fill the ledger with rows — a limiter
   * placed after the audit write would turn a burst into two problems.
   */
  private async mayRead(
    request: AuthenticatedRequest,
    action: Parameters<typeof permitAuditRead>[1]['action'],
    target: { kind: string; id: string },
  ): Promise<boolean> {
    const session = request.session!;
    if (!this.limiter.allow(session.principalId)) {
      /**
       * Throttling IS an audit event here.
       *
       * On any other surface a rate limit is an operational nuisance. On this one, the
       * credential being driven faster than a person can read is the signal that matters —
       * so it goes in the ledger rather than only into a metric.
       */
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action,
        targetKind: target.kind,
        targetId: target.id,
        outcome: 'REFUSED',
        reason: 'RATE_LIMITED',
        correlationId: request.correlationId,
      });
      return false;
    }

    return permitAuditRead(this.deps(), {
      principalId: session.principalId,
      action,
      correlationId: request.correlationId,
      target,
    });
  }

  /**
   * Whether this session may use the audit surface at all.
   *
   * The frontend asks so it can show the audit navigation or not. It is NOT what protects
   * anything — every handler below decides for itself, and hiding a screen is not
   * authorization. This exists so the ordinary employee's workspace does not show a door
   * that would refuse them.
   */
  @Get('permission')
  async permission(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return { mayAudit: false };
    const actor = toActor(claims.value);
    return { mayAudit: actor };
  }

  /** Every employee account in the company, with the teams and department each sits in. */
  @Get('employees')
  async employees(@Req() request: AuthenticatedRequest): Promise<unknown> {
    if (!(await this.mayRead(request, 'admin.principal.read', { kind: 'audit_surface', id: WHOLE_COMPANY }))) {
      return refuse();
    }

    const rows = await this.pool.query(
      `SELECT p.principal_id, p.display_name, p.employee_id, p.status, p.department,
              p.authority,
              COALESCE(json_agg(DISTINCT m.team_id) FILTER (WHERE m.team_id IS NOT NULL), '[]') AS teams
         FROM identity.principals p
         LEFT JOIN identity.team_memberships m ON m.principal_id = p.principal_id
        WHERE p.kind = 'EMPLOYEE'
        GROUP BY p.principal_id
        ORDER BY p.display_name ASC`,
    );

    return {
      employees: rows.rows.map((row) => ({
        principalId: row.principal_id as string,
        displayName: row.display_name as string,
        employeeCode: row.employee_id as string | null,
        status: row.status as string,
        department: row.department as string | null,
        authority: row.authority as string,
        teams: row.teams as string[],
      })),
    };
  }

  /** The departments and teams, so an audit can browse rather than guess at ids. */
  @Get('teams')
  async teams(@Req() request: AuthenticatedRequest): Promise<unknown> {
    if (!(await this.mayRead(request, 'directory.read', { kind: 'audit_surface', id: WHOLE_COMPANY }))) {
      return refuse();
    }

    const rows = await this.pool.query(
      `SELECT m.team_id, COUNT(DISTINCT m.principal_id) AS members,
              COALESCE(MIN(p.department), '') AS department
         FROM identity.team_memberships m
         LEFT JOIN identity.principals p ON p.principal_id = m.principal_id
        GROUP BY m.team_id
        ORDER BY m.team_id ASC`,
    );

    return {
      teams: rows.rows.map((row) => ({
        teamId: row.team_id as string,
        members: Number(row.members),
        department: row.department as string,
      })),
    };
  }

  /**
   * Conversations, filtered the five ways the brief asks for.
   *
   * Employee, team, type and date range — and every filter is applied in SQL rather than by
   * fetching and narrowing, for the same reason the customer surface does it: a query that
   * loads first and filters after is one refactor away from returning what it loaded.
   */
  @Get('conversations')
  async conversations(
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const parsed = conversationFilter.safeParse(query);
    if (!parsed.success) return refuse();

    if (!(await this.mayRead(request, 'conversation.read', { kind: 'audit_surface', id: WHOLE_COMPANY }))) {
      return refuse();
    }

    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      values.push(value);
      where.push(clause.replace('$?', `$${values.length}`));
    };

    if (parsed.data.employeeId !== undefined) {
      add(
        `EXISTS (SELECT 1 FROM conversation.participants pp
                  WHERE pp.conversation_id = c.conversation_id AND pp.principal_id = $?)`,
        parsed.data.employeeId,
      );
    }
    if (parsed.data.teamId !== undefined) {
      add(
        `EXISTS (SELECT 1 FROM conversation.participants pt
                   JOIN identity.team_memberships tm ON tm.principal_id = pt.principal_id
                  WHERE pt.conversation_id = c.conversation_id AND tm.team_id = $?)`,
        parsed.data.teamId,
      );
    }
    if (parsed.data.type !== undefined) add(`c.conversation_type = $?`, parsed.data.type);
    if (parsed.data.from !== undefined) add(`c.last_activity_at >= $?`, parsed.data.from);
    if (parsed.data.to !== undefined) add(`c.last_activity_at <= $?`, parsed.data.to);

    values.push(parsed.data.limit);
    const rows = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.title, c.state, c.sensitivity,
              c.last_activity_at, c.participant_count
         FROM conversation.conversations c
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.last_activity_at DESC
        LIMIT $${values.length}`,
      values,
    );

    return {
      conversations: rows.rows.map((row) => ({
        conversationId: row.conversation_id as string,
        conversationType: row.conversation_type as string,
        title: row.title as string | null,
        state: row.state as string | null,
        sensitivity: row.sensitivity as string,
        lastActivityAt: (row.last_activity_at as Date).toISOString(),
        participantCount: Number(row.participant_count),
      })),
    };
  }

  /** Who is, and was, in one conversation — including participations that have ended. */
  @Get('conversations/:conversationId/participants')
  async participants(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();

    if (!(await this.mayRead(request, 'conversation.read', { kind: 'conversation', id: conversationId.data }))) {
      return refuse();
    }

    const rows = await this.pool.query(
      `SELECT pa.principal_id, pa.principal_kind, pa.role, pa.reply_authority,
              pa.effective_from, pa.effective_to, p.display_name
         FROM conversation.participants pa
         LEFT JOIN identity.principals p ON p.principal_id = pa.principal_id
        WHERE pa.conversation_id = $1
        ORDER BY pa.effective_from ASC`,
      [conversationId.data],
    );

    return {
      participants: rows.rows.map((row) => ({
        principalId: row.principal_id as string,
        principalKind: row.principal_kind as string,
        displayName: (row.display_name as string | null) ?? undefined,
        role: row.role as string,
        replyAuthority: row.reply_authority as boolean,
        effectiveFrom: (row.effective_from as Date).toISOString(),
        effectiveTo:
          row.effective_to === null ? undefined : (row.effective_to as Date).toISOString(),
      })),
    };
  }

  /**
   * The complete history of one conversation — both visibilities.
   *
   * `INTERNAL` as well as `CUSTOMER_VISIBLE`, which is the whole point: an internal note is
   * the thing an audit most often needs and the thing no other non-participant read
   * returns. Rule 5 is untouched — that rule is about a CUSTOMER never seeing an internal
   * note, and this surface refuses customer principals at the session guard and again at
   * `decide()`'s third rung.
   */
  @Get('conversations/:conversationId/messages')
  async messageHistory(
    @Param('conversationId') conversationIdRaw: string,
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = messageFilter.safeParse(query);
    if (!conversationId.success || !parsed.success) return refuse();

    if (
      !(await this.mayRead(request, 'privileged.conversation.read', {
        kind: 'conversation',
        id: conversationId.data,
      }))
    ) {
      return refuse();
    }

    const page = await this.messages.readPage({
      conversationId: conversationId.data as UUID,
      visibility: ['CUSTOMER_VISIBLE', 'INTERNAL'],
      limit: parsed.data.limit,
    });

    /* Attachments and voice notes, by message. Metadata only — never a key and never a URL.
       A download is issued one object at a time through the handler below, after its own
       decision and its own ledger row (ADR-012, FR-ATT-5), so returning grants in a list
       would be handing out access nobody asked for. */
    const ids = page.map((message) => message.messageId);
    const files =
      ids.length === 0
        ? { rows: [] as Record<string, unknown>[] }
        : await this.pool.query(
            `SELECT attachment_id, message_id, original_filename, declared_mime, sniffed_mime,
                    declared_bytes, duration_ms, state
               FROM conversation.attachments
              WHERE message_id = ANY($1::uuid[])`,
            [ids],
          );

    const byMessage = new Map<string, Record<string, unknown>[]>();
    for (const row of files.rows) {
      const key = row['message_id'] as string;
      const list = byMessage.get(key) ?? [];
      list.push({
        attachmentId: row['attachment_id'] as string,
        filename: row['original_filename'] as string | null,
        /* The SNIFFED type where the scanner established one, the declared type
           otherwise. Section 28.2 is explicit that a declared type is never trusted, and
           an audit that labelled a file by what its uploader claimed would be
           reporting the claim rather than the file. */
        contentType: (row['sniffed_mime'] ?? row['declared_mime']) as string | null,
        bytes: row['declared_bytes'] === null ? undefined : Number(row['declared_bytes']),
        durationMs: row['duration_ms'] === null ? undefined : Number(row['duration_ms']),
        state: row['state'] as string,
      });
      byMessage.set(key, list);
    }

    const kind = parsed.data.kind;
    const messages = page
      .map((message) => ({
        messageId: message.messageId,
        senderPrincipalId: message.senderPrincipalId,
        senderKind: message.senderKind,
        senderDisplayName: message.senderDisplayName,
        visibility: message.visibility,
        body: message.body,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        redactedAt: message.redactedAt,
        replyToMessageId: message.replyToMessageId,
        attachments: byMessage.get(message.messageId) ?? [],
      }))
      .filter((message) => {
        if (kind === 'ALL') return true;
        const attachments = message.attachments as { contentType?: string | null }[];
        if (kind === 'TEXT') return attachments.length === 0;
        if (kind === 'VOICE') {
          return attachments.some((a) => (a.contentType ?? '').startsWith('audio/'));
        }
        return attachments.length > 0;
      });

    return { conversationId: conversationId.data, messages };
  }

  /**
   * Message search, across the whole company.
   *
   * The ordinary employee search is scoped to what the caller participates in. This is the
   * same index without that narrowing, which is why it needs its own door and its own
   * ledger row rather than a widening flag on the existing one — a flag is one bug away
   * from widening somebody else's search too.
   */
  @Get('search')
  async search(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = searchQuery.safeParse(query);
    if (!parsed.success) return refuse();

    if (!(await this.mayRead(request, 'search.execute', { kind: 'audit_surface', id: WHOLE_COMPANY }))) {
      return refuse();
    }

    const rows = await this.pool.query(
      `SELECT m.message_id, m.conversation_id, m.sender_principal_id, m.visibility,
              m.created_at, m.body, c.conversation_type, c.title
         FROM conversation.messages m
         JOIN conversation.conversations c ON c.conversation_id = m.conversation_id
        WHERE m.redacted_at IS NULL
          AND m.search_vector @@ websearch_to_tsquery('simple', $1)
        ORDER BY m.created_at DESC
        LIMIT $2`,
      [parsed.data.q, parsed.data.limit],
    );

    return {
      results: rows.rows.map((row) => ({
        messageId: row['message_id'] as string,
        conversationId: row['conversation_id'] as string,
        conversationType: row['conversation_type'] as string,
        title: row['title'] as string | null,
        senderPrincipalId: row['sender_principal_id'] as string | null,
        visibility: row['visibility'] as string,
        createdAt: (row['created_at'] as Date).toISOString(),
        body: row['body'] as string | null,
      })),
    };
  }

  /**
   * The ledger, including this account's own reads.
   *
   * An auditor who could not see their own trail would be an auditor nobody could audit.
   * The table is append-only by role grant and trigger (rule 8), so reading it here cannot
   * become editing it.
   */
  @Get('log')
  async log(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = ledgerQuery.safeParse(query);
    if (!parsed.success) return refuse();

    if (!(await this.mayRead(request, 'audit.query', { kind: 'audit_ledger', id: WHOLE_COMPANY }))) {
      return refuse();
    }

    const values: unknown[] = [];
    const where: string[] = [];
    if (parsed.data.actorId !== undefined) {
      values.push(parsed.data.actorId);
      where.push(`actor_id = $${values.length}`);
    }
    if (parsed.data.action !== undefined) {
      values.push(parsed.data.action);
      where.push(`action = $${values.length}`);
    }
    values.push(parsed.data.limit);

    const rows = await this.pool.query(
      `SELECT event_id, occurred_at, actor_id, actor_kind, action, target_kind, target_id,
              outcome, reason, correlation_id, detail
         FROM audit.ledger
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY occurred_at DESC
        LIMIT $${values.length}`,
      values,
    );

    return {
      events: rows.rows.map((row) => ({
        eventId: row['event_id'] as string,
        occurredAt: (row['occurred_at'] as Date).toISOString(),
        actorId: row['actor_id'] as string | null,
        actorKind: row['actor_kind'] as string,
        action: row['action'] as string,
        targetKind: row['target_kind'] as string,
        targetId: row['target_id'] as string,
        outcome: row['outcome'] as string,
        reason: row['reason'] as string | null,
        correlationId: row['correlation_id'] as string,
        detail: row['detail'] as unknown,
      })),
    };
  }
}

/** Does this principal hold the audit grant? Used only to decide whether to offer the door. */
function toActor(claims: { roles: readonly { role: string }[] }): boolean {
  return claims.roles.some((assignment) => assignment.role === 'SUPERADMIN');
}
