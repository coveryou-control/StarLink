/**
 * The communication audit surface: read, and only read.
 *
 * ## Why this is a separate controller rather than a flag on the employee one
 *
 * Because read-only has to be a property of the SHAPE here, and cannot be a property of the
 * role. The auditor IS the organisation's administrator: it can create accounts, assign
 * roles and manage channels, so "this account holds no write action" is not available as a
 * guarantee the way it would be for a dedicated audit account.
 *
 * So the guarantee is structural. Every handler in this file is a `@Get`; there is no
 * `@Post`, `@Patch` or `@Delete`, and `audit-surface-is-read-only.test.ts` reads this source
 * and fails the build if one appears. An administrator who wants to send a message uses the
 * ordinary workspace, as themselves, with their name on it — which is the distinction the
 * whole feature turns on.
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
import { holdsAuditCapability, permitAuditRead } from './audit-access.js';

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
  /**
   * The department somebody in the conversation belongs to.
   *
   * A department is a property of PEOPLE, not of conversations — StarLink has no
   * departmental thread — so this asks "did anybody from Claims take part", which is the
   * question a compliance request actually arrives as. Same shape as `teamId` above, and
   * the same reason it is a participant test rather than a column.
   */
  department: z.string().min(1).max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /**
   * Newest first, or oldest first.
   *
   * Two orders, not a general sort vocabulary. An audit reads a list either from "what has
   * just happened" or from "start at the beginning of the period", and every other ordering
   * anybody proposed (by size, by type, by name) is a filter wearing a sort's clothes.
   */
  sort: z.enum(['recent', 'oldest']).default('recent'),
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
   * anything — every handler below decides for itself, server-side, and hiding a screen is
   * not authorization. This exists so an ordinary employee's workspace does not show a door
   * that would refuse them.
   *
   * Answered by `decide()` rather than by reading a role name off the claims. A check that
   * said `role === 'ADMIN'` would be a second authorization system beside the real one, and
   * the two would disagree the first time the capability moved.
   */
  @Get('permission')
  async permission(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    return { mayAudit: await holdsAuditCapability(this.identity, session.principalId) };
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
    if (parsed.data.department !== undefined) {
      add(
        `EXISTS (SELECT 1 FROM conversation.participants pd
                   JOIN identity.principals pp ON pp.principal_id = pd.principal_id
                  WHERE pd.conversation_id = c.conversation_id AND pp.department = $?)`,
        parsed.data.department,
      );
    }
    /**
     * Everything EXCEPT the kind, kept separately for the tally below.
     *
     * The panel offers "All conversations / Direct / Groups / Channels" as places to stand,
     * and each carries how many are in it — which only means anything if the other filters
     * still apply. Counting after the type clause would make every view but the open one
     * read zero; counting before any filter would make the numbers a lie about what
     * clicking would show.
     */
    if (parsed.data.from !== undefined) add(`c.last_activity_at >= $?`, parsed.data.from);
    if (parsed.data.to !== undefined) add(`c.last_activity_at <= $?`, parsed.data.to);
    /*
       The snapshot is taken HERE, after every other filter and before the kind — so the
       tally counts the same population the list does, narrowed by everything except the one
       thing the tally is counting. The kind is therefore added last, and must stay last:
       `values.slice(0, withoutType.length)` below relies on the placeholders for these
       clauses being a prefix of the array.
    */
    const withoutType = [...where];
    if (parsed.data.type !== undefined) add(`c.conversation_type = $?`, parsed.data.type);

    values.push(parsed.data.limit);
    /**
     * A few names per row, and they are not decoration.
     *
     * `conversations.title` is NULL for a one-to-one and for most groups — those are named
     * after the people in them everywhere else in the product. Without this the oversight
     * list was fifty rows reading "One-to-one", which is a list an audit cannot use: the
     * one question it exists to answer is whose conversation this is.
     *
     * Bounded at four, in the lateral, for the reason the employee list bounds its own at
     * six: a channel has hundreds of members and a row has one line. `participantCount`
     * beside it is the real number, so a truncated list can never be mistaken for the whole
     * membership.
     *
     * Still ONE query. A lateral rather than a second round trip per row, which at fifty
     * rows would be fifty reads of other people's participation to draw one column.
     */
    /**
     * A row that can be READ at a glance: who is in it, what was last said, and by whom.
     *
     * Three laterals rather than three round trips per row. The list is the administrator's
     * whole way into the company's communication, and a list of fifty rows reading
     * "One-to-one" with a date on it is a list nobody can work from — the preview is what
     * makes one thread distinguishable from the next before it is opened.
     *
     * Every one is BOUNDED. Four names, one message, three departments: a channel has
     * hundreds of members and a row has two lines, and `participantCount` beside the names
     * is the real number so a truncated list can never be read as the whole membership.
     *
     * `redacted_at IS NULL` on the preview, because a deleted message's body is cleared for
     * every reader and an audit list is not the place it comes back.
     */
    const rows = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.title, c.state, c.sensitivity,
              c.last_activity_at, c.participant_count, who.names, dept.departments,
              last.body AS last_body, last.sender_name AS last_sender
         FROM conversation.conversations c
         LEFT JOIN LATERAL (
           SELECT array_agg(n.display_name) AS names
             FROM (SELECT p.display_name
                     FROM conversation.participants pa
                     JOIN identity.principals p ON p.principal_id = pa.principal_id
                    WHERE pa.conversation_id = c.conversation_id
                      AND pa.effective_to IS NULL
                    ORDER BY pa.effective_from ASC
                    LIMIT 4) n
         ) who ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(d.department) AS departments
             FROM (SELECT DISTINCT p.department
                     FROM conversation.participants pa
                     JOIN identity.principals p ON p.principal_id = pa.principal_id
                    WHERE pa.conversation_id = c.conversation_id
                      AND pa.effective_to IS NULL
                      AND p.department IS NOT NULL
                    LIMIT 3) d
         ) dept ON true
         LEFT JOIN LATERAL (
           SELECT m.body, sp.display_name AS sender_name
             FROM conversation.messages m
             LEFT JOIN identity.principals sp ON sp.principal_id = m.sender_principal_id
            WHERE m.conversation_id = c.conversation_id
              AND m.redacted_at IS NULL
            ORDER BY m.seq DESC
            LIMIT 1
         ) last ON true
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.last_activity_at ${parsed.data.sort === 'oldest' ? 'ASC' : 'DESC'}
        LIMIT $${values.length}`,
      values,
    );

    /* One extra query, and it is the cheapest form of the question: a grouped count over
       the same population the list is drawn from, with the type clause left out. */
    const tally = await this.pool.query(
      `SELECT c.conversation_type, count(*)::int AS n
         FROM conversation.conversations c
        ${withoutType.length > 0 ? `WHERE ${withoutType.join(' AND ')}` : ''}
        GROUP BY c.conversation_type`,
      values.slice(0, withoutType.length),
    );

    return {
      counts: Object.fromEntries(
        tally.rows.map((row) => [row.conversation_type as string, Number(row.n)]),
      ),
      conversations: rows.rows.map((row) => ({
        conversationId: row.conversation_id as string,
        conversationType: row.conversation_type as string,
        title: row.title as string | null,
        state: row.state as string | null,
        sensitivity: row.sensitivity as string,
        lastActivityAt: (row.last_activity_at as Date).toISOString(),
        participantCount: Number(row.participant_count),
        /* Employees only — `identity.principals` holds no customer, so a customer
           conversation yields the agent's name and a count that exceeds it, which is the
           honest shape rather than a name invented for the other side. */
        participants: (row.names as string[] | null) ?? [],
        departments: (row.departments as string[] | null) ?? [],
        /*
           Trimmed here rather than in the browser. A row shows one line of it, and sending
           a 4,000-character message so the client can throw away 3,900 of it is the kind of
           over-fetch that only shows up on a slow connection with fifty rows.
        */
        lastMessagePreview:
          row.last_body === null || row.last_body === undefined
            ? undefined
            : String(row.last_body).slice(0, 180),
        lastMessageSender: (row.last_sender as string | null) ?? undefined,
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
      /* The department comes from the join that was already here for the name. "Who was in
         it" and "which part of the company were they from" are one question to somebody
         answering a regulator, and the second half was being thrown away. */
      `SELECT pa.principal_id, pa.principal_kind, pa.role, pa.reply_authority,
              pa.effective_from, pa.effective_to, p.display_name, p.department
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
        department: (row.department as string | null) ?? undefined,
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

    /**
     * Who said it, and where — by name.
     *
     * A search hit used to carry a sender UUID and, for the conversation, whatever `title`
     * held: NULL for every one-to-one. So a page of results read as fifty rows of
     * "One-to-one", and the one question somebody searching an audit is asking — who said
     * this — was answerable only by opening each thread.
     *
     * The same two joins the conversation list uses, for the same reason and with the same
     * bound. A customer sender resolves to no name (`identity.principals` holds employees),
     * which the projection reports as absent rather than as somebody else.
     */
    const rows = await this.pool.query(
      `SELECT m.message_id, m.conversation_id, m.sender_principal_id, m.visibility,
              m.created_at, m.body, c.conversation_type, c.title,
              s.display_name AS sender_name, who.names
         FROM conversation.messages m
         JOIN conversation.conversations c ON c.conversation_id = m.conversation_id
         LEFT JOIN identity.principals s ON s.principal_id = m.sender_principal_id
         LEFT JOIN LATERAL (
           SELECT array_agg(n.display_name) AS names
             FROM (SELECT p.display_name
                     FROM conversation.participants pa
                     JOIN identity.principals p ON p.principal_id = pa.principal_id
                    WHERE pa.conversation_id = c.conversation_id
                      AND pa.effective_to IS NULL
                    ORDER BY pa.effective_from ASC
                    LIMIT 4) n
         ) who ON true
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
        senderDisplayName: (row['sender_name'] as string | null) ?? undefined,
        participants: (row['names'] as string[] | null) ?? [],
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
    /* Qualified with the ledger's alias, because the query below joins the principal
       table for a display name and a bare `action` would then be ambiguous to nobody and
       fragile to everybody. */
    if (parsed.data.actorId !== undefined) {
      values.push(parsed.data.actorId);
      where.push(`l.actor_id = $${values.length}`);
    }
    if (parsed.data.action !== undefined) {
      values.push(parsed.data.action);
      where.push(`l.action = $${values.length}`);
    }
    values.push(parsed.data.limit);

    /**
     * The actor's NAME, not only their id.
     *
     * The ledger deliberately stores no name — `actor_id` carries no foreign key, so the
     * record survives the account and cannot be rewritten by renaming somebody. That is the
     * right shape for the table and the wrong shape for a screen: a column of raw UUIDs
     * cannot be read, and "who did this" is the first question anybody asks of an access log.
     *
     * Resolved at READ time and left NULL when the principal is gone, which is honest — a
     * deleted account's trail keeps its id and loses its name, rather than acquiring
     * somebody else's.
     */
    const rows = await this.pool.query(
      `SELECT l.event_id, l.occurred_at, l.actor_id, l.actor_kind, l.action, l.target_kind,
              l.target_id, l.outcome, l.reason, l.correlation_id, l.detail,
              p.display_name AS actor_name
         FROM audit.ledger l
         LEFT JOIN identity.principals p ON p.principal_id = l.actor_id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.occurred_at DESC
        LIMIT $${values.length}`,
      values,
    );

    return {
      events: rows.rows.map((row) => ({
        eventId: row['event_id'] as string,
        occurredAt: (row['occurred_at'] as Date).toISOString(),
        actorId: row['actor_id'] as string | null,
        actorName: (row['actor_name'] as string | null) ?? undefined,
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


