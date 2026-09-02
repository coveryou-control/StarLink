/**
 * Scoped message search (doc §25.2, §30).
 *
 * The controller decides nothing about who may see what — it passes the authenticated
 * principal to the domain, which builds the scope. There is deliberately no way for a
 * request to influence the scope beyond narrowing to one conversation.
 */
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { searchMessages, type RateLimiter, type SearchAuditEntry } from '@starlink/search';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';
import type { SearchProvider } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import type pg from 'pg';
import { AUDIT_WRITER, DATABASE, LOGGER, SEARCH_PROVIDER, SEARCH_RATE_LIMITER } from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const fileQuerySchema = z.object({
  q: z.string().min(SEARCH_MINIMUM_TERM_LENGTH).max(200),
});

const querySchema = z.object({
  q: z.string().min(SEARCH_MINIMUM_TERM_LENGTH).max(200),
  conversationId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(500).optional(),
});

@Controller('v1/employee/search')
@RequireSurface('EMPLOYEE')
export class EmployeeSearchController {
  constructor(
    @Inject(SEARCH_PROVIDER) private readonly provider: SearchProvider,
    @Inject(SEARCH_RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    /* The file search is one statement against one table pair — see `files`. */
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Files by name, in conversations the caller participates in.
   *
   * ## Scope is a JOIN, not a filter
   *
   * The `participants` join is what confines the result, exactly as `listForPrincipal` does
   * for the conversation list — so a file in a thread the caller is not in cannot appear
   * whatever they type. Filtering after the fact would put the boundary in the projection,
   * and §46 rule 2 puts it before the read.
   *
   * ## BOUND only, and no keys
   *
   * §28.1: an unbound upload is reachable by nobody, so it is not a file anybody has
   * shared. And the row carries metadata only — a download still goes through
   * `GET /attachments/:id`, which mints a short-lived audited grant per request.
   *
   * ## Why this is not routed through `searchMessages`
   *
   * That path has a rate limiter and an audit entry shaped around message CONTENT (§30.4).
   * A filename search reads no message body and discloses no message text; auditing it as a
   * content search would make the audit log say something untrue about what was read.
   */
  @Get('files')
  async files(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = fileQuerySchema.safeParse(query);
    if (!parsed.success) return refuse();

    const session = request.session!;
    const term = parsed.data.q.trim();
    /* Empty is not a search. One character is — the JOIN on participation and the LIMIT 25
       below are what bound this, not the length of the term. See
       `SEARCH_MINIMUM_TERM_LENGTH`. */
    if (term.length < SEARCH_MINIMUM_TERM_LENGTH) return { files: [] };

    const result = await this.pool.query(
      `SELECT a.attachment_id, a.original_filename, a.declared_bytes, a.created_at,
              a.conversation_id, p.display_name AS uploaded_by
         FROM conversation.attachments a
         JOIN conversation.participants me
           ON me.conversation_id = a.conversation_id
          AND me.principal_id = $1
          AND me.effective_to IS NULL
         LEFT JOIN identity.principals p ON p.principal_id = a.uploader_id
        WHERE a.state = 'BOUND'
          AND a.message_id IS NOT NULL
          AND a.original_filename ILIKE $2
        ORDER BY a.created_at DESC
        LIMIT 25`,
      [session.principalId, `%${term}%`],
    );

    return {
      files: result.rows.map((row) => ({
        attachmentId: row.attachment_id,
        conversationId: row.conversation_id,
        filename: row.original_filename ?? 'Attachment',
        declaredBytes: Number(row.declared_bytes),
        sharedAt: (row.created_at as Date).toISOString(),
        ...(row.uploaded_by !== null ? { uploadedBy: row.uploaded_by as string } : {}),
      })),
    };
  }

  @Get()
  async search(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) return refuse();

    const session = request.session!;

    const result = await searchMessages(
      {
        principalId: session.principalId,
        // Taken from the verified session, never from the request. A customer cannot
        // ask to be searched as staff.
        principalKind: 'EMPLOYEE',
        term: parsed.data.q,
        ...(parsed.data.conversationId !== undefined ? { conversationId: parsed.data.conversationId } : {}),
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        correlationId: request.correlationId,
      },
      {
        provider: this.provider,
        allowRequest: (principalId) => this.limiter.allow(principalId),
        recordSearch: (entry) => this.writeAudit(entry),
      },
    );

    if (!result.ok) {
      this.logger.info('search refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'search.execute',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      return refuse();
    }

    return {
      // FR-SRCH-4: the caller can distinguish "we looked and found nothing" from
      // "we could not look" — the latter never reaches here, it is a refusal.
      matched: result.matched,
      results: result.page.items.map((hit) => ({
        messageId: hit.documentId,
        conversationId: hit.conversationId,
        snippet: hit.snippet,
        createdAt: hit.createdAt,
        ...(hit.senderDisplayName !== undefined
          ? { senderDisplayName: hit.senderDisplayName }
          : {}),
      })),
      ...(result.page.nextCursor !== undefined ? { nextCursor: result.page.nextCursor } : {}),
    };
  }

  /**
   * FR-SRCH-3: audited WITH THE TERM.
   *
   * "Someone searched" answers nothing after an incident. The term is the question, so
   * it goes in `detail` — which is also why the redaction rules in the logger do not
   * apply here: the audit ledger is a different record with a different retention and
   * a restricted access list (doc §32.1).
   */
  private async writeAudit(entry: SearchAuditEntry): Promise<void> {
    await this.audit.record({
      actorId: entry.principalId,
      actorKind: 'EMPLOYEE',
      action: 'search.execute',
      targetKind: 'search',
      targetId: 'messages',
      outcome: entry.outcome,
      correlationId: entry.correlationId,
      detail: { term: entry.term, resultCount: entry.resultCount },
    });
  }
}
