/**
 * The two attachment surfaces (doc §28.4, §28.5, ADR-012, D-07).
 *
 * Two controllers in one file, deliberately, and they share NO route prefix — the
 * employee tree is `/v1/employee/**` and the customer tree `/v1/customer/**`, disjoint by
 * §25.3 and ADR-004. Keeping them side by side is a review aid: the difference between
 * what staff and customers may do with a file is the whole of §28.5, and it is easier to
 * see wrong when the two are adjacent than when they are in separate directories.
 *
 * What differs, and it is only these:
 *
 *   * **Who may upload where.** D-07 restricts customers to Claims; the policy enforces
 *     it, and the customer controller passes the conversation's category so it can.
 *   * **Step 4 of §28.4.** A customer may never reach an internal-note attachment. The
 *     actor kind passed to the service is what turns that check on.
 *
 * Everything else — the ladder, the audit, the grant — is one implementation.
 */
import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';
import type { ConversationAuthzReader } from '@starlink/database';
import { decide, toActorContext } from '@starlink/conversation-domain';
import { recordDecision } from '../edge/authorization-metrics.js';
import type { IdentityAuthorizationClient } from '@starlink/shared-contracts';
import { AUTHZ_READER, DATABASE, IDENTITY_CLIENT } from '../tokens.js';
import {
  refuse,
  storageUnavailable,
  RequireSurface,
  type AuthenticatedRequest,
} from '../edge/session.guard.js';
import { AttachmentService } from './attachment-service.js';
import type { AccessPorts } from './attachment-access.js';

const uuid = z.string().uuid();

const intakeSchema = z.object({
  filename: z.string().min(1).max(400),
  declaredMime: z.string().min(1).max(200),
  declaredBytes: z.number().int().positive(),
});

/**
 * Shared plumbing. Not a base controller — Nest would treat inherited decorators
 * unpredictably — just the two lookups both surfaces need.
 */
class AttachmentPlumbing {
  constructor(
    protected readonly attachments: AttachmentService,
    protected readonly authz: ConversationAuthzReader,
    protected readonly identity: IdentityAuthorizationClient,
    protected readonly pool: pg.Pool,
  ) {}

  /**
   * §28.4 step 3, and step 4's input.
   *
   * `mayReadConversation` runs the SAME `decide()` every other read path runs. Writing a
   * second, attachment-specific rule here is exactly how two authorization paths diverge
   * (§38), so this one delegates rather than deciding.
   */
  protected portsFor(at: string, actorKind: 'EMPLOYEE' | 'CUSTOMER'): AccessPorts {
    return {
      /**
       * The two surfaces authorize differently, and they must.
       *
       * An EMPLOYEE goes through the object check: resolve their claims, load the
       * conversation, and ask `decide()` — the same call every other employee read path
       * makes, so the two cannot reach different conclusions (§38).
       *
       * A CUSTOMER does NOT. `LocalIamAdapter.resolvePrincipal` refuses a customer
       * outright — "a customer principal must never resolve through the employee identity
       * path" — so routing them through it would deny every customer, always. Their
       * authority is PARTICIPATION: they may reach a conversation they are currently a
       * live participant in, which is the same rule `customer-conversations.controller`
       * enforces as a join on every read. §21.5's model is that participation grants that
       * conversation and nothing else (rule 3).
       */
      mayReadConversation: async (principalId, conversationId) => {
        if (actorKind === 'CUSTOMER') {
          const row = await this.pool.query(
            `SELECT 1 FROM conversation.participants
              WHERE conversation_id = $1
                AND principal_id = $2
                AND effective_from <= $3
                AND (effective_to IS NULL OR effective_to > $3)`,
            [conversationId, principalId, at],
          );
          return (row.rowCount ?? 0) > 0;
        }

        const resource = await this.authz.loadForAuthorization(conversationId, principalId, at);
        // Undefined is indistinguishable from "may not", by design (§27.3).
        if (resource === undefined) return false;
        const claims = await this.identity.resolvePrincipal(principalId);
        if (!claims.ok) return false;
        return recordDecision(
          'conversation.read',
          decide({
            actor: toActorContext(claims.value),
            action: 'conversation.read',
            resource,
            now: at,
          }),
        ).allow;
      },
      messageVisibility: async (messageId) => {
        const row = await this.pool.query(
          `SELECT visibility FROM conversation.messages WHERE message_id = $1`,
          [messageId],
        );
        return row.rows[0]?.visibility as string | undefined;
      },
    };
  }

  /** The conversation's category, for D-07's Claims-only restriction. */
  protected async categoryOf(conversationId: UUID): Promise<string | undefined> {
    const row = await this.pool.query(
      `SELECT sc.category_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    return (row.rows[0]?.category_id as string | null) ?? undefined;
  }
}

@Controller('v1/employee')
@RequireSurface('EMPLOYEE')
export class EmployeeAttachmentsController extends AttachmentPlumbing {
  constructor(
    // Explicit, like every other injection in this app. `emitDecoratorMetadata` is off
    // by design (see the tsconfig), so a bare `attachments: AttachmentService` resolves
    // to `undefined` and throws at first use rather than failing at boot.
    @Inject(AttachmentService) attachments: AttachmentService,
    @Inject(AUTHZ_READER) authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) identity: IdentityAuthorizationClient,
    @Inject(DATABASE) pool: pg.Pool,
  ) {
    super(attachments, authz, identity, pool);
  }

  @Post('conversations/:conversationId/attachments')
  async requestUpload(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = intakeSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString();
    // Authorized against the CONVERSATION before anything is granted: the right to
    // attach is the right to write here, and §28.1 rejects before bytes exist.
    if (!(await this.portsFor(at, 'EMPLOYEE').mayReadConversation(session.principalId, conversationId.data))) {
      return refuse();
    }

    const grant = await this.attachments.grantUpload({
      conversationId: conversationId.data,
      uploaderId: session.principalId,
      uploaderKind: 'EMPLOYEE',
      declaredMime: parsed.data.declaredMime,
      declaredBytes: parsed.data.declaredBytes,
      filename: parsed.data.filename,
      correlationId: request.correlationId,
    });

    /**
     * §34.4: an upload fails EXPLICITLY when storage is down, so the user keeps their
     * message and can retry. Reachable only after the conversation check above passed,
     * so it discloses nothing the 404 was protecting (see `storageUnavailable`).
     */
    if (!grant.ok && grant.refusal === 'STORAGE_UNAVAILABLE') storageUnavailable();
    if (!grant.ok) return refuse();
    return {
      attachmentId: grant.attachmentId,
      uploadUrl: grant.uploadUrl,
      expiresAt: grant.expiresAt,
    };
  }

  @Post('attachments/:attachmentId/uploaded')
  async markUploaded(
    @Param('attachmentId') attachmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const attachmentId = uuid.safeParse(attachmentIdRaw);
    if (!attachmentId.success) return refuse();
    const ok = await this.attachments.markUploaded(attachmentId.data, request.session!.principalId);
    return ok ? { state: 'QUARANTINED' } : refuse();
  }

  /**
   * "Is my file ready to send yet?" — the uploader's own view of their own upload.
   *
   * §28.1 binds only a CLEAN attachment, and the scan is a sweep away. Without this the
   * composer had no way to know, so it called a file "ready to send" as soon as the bytes
   * landed; sending then produced a message with no attachment while the interface said
   * otherwise. This is the missing signal, not a new capability: the same state already
   * travels in every message projection, to everyone who can read the thread.
   *
   * Uploader-only, exactly as `markUploaded` is — an unbound attachment has no
   * participants to authorise against, because it is reachable by nobody until it is bound.
   */
  /**
   * What has been shared in this conversation — the panel's "Shared files".
   *
   * ## Authorized exactly like reading the conversation
   *
   * The list is message content by another name: knowing that a file called
   * `Q3-headcount.xlsx` was shared in a thread is knowing something about that thread. So
   * it goes through `mayReadConversation`, which for an employee is the same `decide()`
   * object check every other read path makes — not a separate rule that could drift from
   * it (§38).
   *
   * ## BOUND only
   *
   * §28.1 makes binding the moment a file becomes reachable. Anything earlier is either
   * still being scanned or was rejected, and neither belongs in a list of what people have
   * shared — an unbound upload is reachable by nobody, including its uploader's colleagues.
   *
   * ## No keys
   *
   * Metadata only, exactly as the message projection carries it (§34.4). A download still
   * goes through `GET /attachments/:id`, which mints a short-lived grant per request;
   * putting one here would make this endpoint a way to enumerate durable links.
   */
  @Get('conversations/:conversationId/attachments')
  async sharedFiles(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();

    const at = new Date().toISOString();
    const ports = this.portsFor(at, 'EMPLOYEE');
    const allowed = await ports.mayReadConversation(
      request.session!.principalId,
      conversationId.data,
    );
    if (!allowed) return refuse();

    const result = await this.pool.query(
      `SELECT a.attachment_id, a.original_filename, a.declared_bytes, a.created_at,
              p.display_name AS uploaded_by
         FROM conversation.attachments a
         LEFT JOIN identity.principals p ON p.principal_id = a.uploader_id
        WHERE a.conversation_id = $1
          AND a.message_id IS NOT NULL
          AND a.state = 'BOUND'
        ORDER BY a.created_at DESC
        LIMIT 50`,
      [conversationId.data],
    );

    return {
      files: result.rows.map((row) => ({
        attachmentId: row.attachment_id,
        filename: row.original_filename ?? 'Attachment',
        declaredBytes: Number(row.declared_bytes),
        sharedAt: (row.created_at as Date).toISOString(),
        ...(row.uploaded_by !== null ? { uploadedBy: row.uploaded_by as string } : {}),
      })),
    };
  }

  @Get('attachments/:attachmentId/status')
  async status(
    @Param('attachmentId') attachmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const attachmentId = uuid.safeParse(attachmentIdRaw);
    if (!attachmentId.success) return refuse();

    const state = await this.attachments.uploadState(
      attachmentId.data,
      request.session!.principalId,
    );
    return state === undefined ? refuse() : { state };
  }

  @Get('attachments/:attachmentId')
  async download(
    @Param('attachmentId') attachmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const attachmentId = uuid.safeParse(attachmentIdRaw);
    if (!attachmentId.success) return refuse();

    const outcome = await this.attachments.grantDownload({
      attachmentId: attachmentId.data,
      actor: { principalId: request.session!.principalId, kind: 'EMPLOYEE' },
      ports: this.portsFor(new Date().toISOString(), 'EMPLOYEE'),
      correlationId: request.correlationId,
    });

    /**
     * Every AUTHORIZATION refusal renders identically (§27.3) — the distinction lives in
     * the audit ledger, not on the wire. Storage being down is not one of those: §34.4
     * requires "an explicit error naming the attachment as temporarily unavailable, not
     * a broken image or a silent blank", and the ladder has already run by this point.
     */
    if (!outcome.ok && outcome.refusal === 'STORAGE_UNAVAILABLE') storageUnavailable();
    return outcome.ok ? { url: outcome.url, filename: outcome.filename } : refuse();
  }
}

@Controller('v1/customer')
@RequireSurface('CUSTOMER')
export class CustomerAttachmentsController extends AttachmentPlumbing {
  constructor(
    // Explicit, like every other injection in this app. `emitDecoratorMetadata` is off
    // by design (see the tsconfig), so a bare `attachments: AttachmentService` resolves
    // to `undefined` and throws at first use rather than failing at boot.
    @Inject(AttachmentService) attachments: AttachmentService,
    @Inject(AUTHZ_READER) authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) identity: IdentityAuthorizationClient,
    @Inject(DATABASE) pool: pg.Pool,
  ) {
    super(attachments, authz, identity, pool);
  }

  @Post('conversations/:conversationId/attachments')
  async requestUpload(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = intakeSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString();
    if (!(await this.portsFor(at, 'CUSTOMER').mayReadConversation(session.principalId, conversationId.data))) {
      return refuse();
    }

    /**
     * The category is loaded and passed so the POLICY can apply D-07 — it is not checked
     * here. Putting "customers may only attach in Claims" in a controller would leave the
     * second controller free to forget it; putting it in the policy means both surfaces
     * ask the same function and neither can answer differently.
     */
    const categoryId = await this.categoryOf(conversationId.data);

    const grant = await this.attachments.grantUpload({
      conversationId: conversationId.data,
      ...(categoryId !== undefined ? { categoryId } : {}),
      uploaderId: session.principalId,
      uploaderKind: 'CUSTOMER',
      declaredMime: parsed.data.declaredMime,
      declaredBytes: parsed.data.declaredBytes,
      filename: parsed.data.filename,
      correlationId: request.correlationId,
    });

    /**
     * §34.4: an upload fails EXPLICITLY when storage is down, so the user keeps their
     * message and can retry. Reachable only after the conversation check above passed,
     * so it discloses nothing the 404 was protecting (see `storageUnavailable`).
     */
    if (!grant.ok && grant.refusal === 'STORAGE_UNAVAILABLE') storageUnavailable();
    if (!grant.ok) return refuse();
    return {
      attachmentId: grant.attachmentId,
      uploadUrl: grant.uploadUrl,
      expiresAt: grant.expiresAt,
    };
  }

  @Post('attachments/:attachmentId/uploaded')
  async markUploaded(
    @Param('attachmentId') attachmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const attachmentId = uuid.safeParse(attachmentIdRaw);
    if (!attachmentId.success) return refuse();
    const ok = await this.attachments.markUploaded(attachmentId.data, request.session!.principalId);
    return ok ? { state: 'QUARANTINED' } : refuse();
  }

  @Get('attachments/:attachmentId')
  async download(
    @Param('attachmentId') attachmentIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const attachmentId = uuid.safeParse(attachmentIdRaw);
    if (!attachmentId.success) return refuse();

    const outcome = await this.attachments.grantDownload({
      attachmentId: attachmentId.data,
      // CUSTOMER — this is what turns §28.4 step 4 on. An internal-note attachment in
      // this customer's own conversation is refused here and nowhere else.
      actor: { principalId: request.session!.principalId, kind: 'CUSTOMER' },
      ports: this.portsFor(new Date().toISOString(), 'CUSTOMER'),
      correlationId: request.correlationId,
    });

    // §34.4, as above. The customer surface degrades the same way the employee one does.
    if (!outcome.ok && outcome.refusal === 'STORAGE_UNAVAILABLE') storageUnavailable();
    return outcome.ok ? { url: outcome.url, filename: outcome.filename } : refuse();
  }
}
