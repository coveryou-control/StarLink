/**
 * Message send and read (doc §25.2).
 *
 * The controller's job is narrow on purpose: parse, build the actor context, delegate.
 * Every access decision belongs to the domain, evaluated against the object it loads
 * (§18.4 step 3). If authorization logic ever appears in this file, it is in the wrong
 * place.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  editMessage,
  redactMessage,
  sendMessage,
  type MessageReader,
  type MessageStore,
} from '@starlink/messaging';
import {
  decide,
  toActorContext,
  MAX_MENTIONS,
  type ActorContext,
  type ReadStateStore,
} from '@starlink/conversation-domain';
import { recordDecision } from '../edge/authorization-metrics.js';
import type { IdentityAuthorizationClient, MessageVisibility, UUID } from '@starlink/shared-contracts';
import { CursorCodec } from '@starlink/security';
import { METRICS, metrics, type Logger } from '@starlink/observability';
import {
  AUDIT_WRITER,
  CURSOR_CODEC,
  IDENTITY_CLIENT,
  LOGGER,
  MESSAGE_READER,
  MESSAGE_STORE,
  REACTION_STORE,
  PIN_STORE,
  MESSAGE_INFO_STORE,
  READ_STATE_STORE,
} from '../tokens.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';
import { AttachmentService } from '../attachments/attachment-service.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { ConversationNotifier } from '../notifications/conversation-notifier.js';
import type { PgMessageInfoStore, PgPinStore, PgReactionStore } from '@starlink/database';

/** Structural, not the class: the controller needs the two methods, not the pool. */
type ReactionStore = Pick<PgReactionStore, 'forMessages' | 'add' | 'remove' | 'conversationOf'>;

const uuid = z.string().uuid();

const sendSchema = z
  .object({
    /**
     * Empty is allowed HERE and refused below unless a file comes with it.
     *
     * `min(1)` on its own made an attachment-only message unsendable — the composer's
     * arrow stayed dead with a document staged, which is an ordinary thing to want to
     * send. The column is nullable and always was; only this line said otherwise.
     */
    body: z.string().max(10_000),
    visibility: z.enum(['INTERNAL', 'CUSTOMER_VISIBLE']),
    replyToMessageId: uuid.optional(),
    clientMessageId: z.string().min(1).max(200).optional(),
  /** Attachments to bind to this message once it exists (§28.1, ADR-012). */
  attachmentIds: z.array(uuid).max(10).optional(),
  /**
   * Structured mentions, as offsets into `body`.
   *
   * Shape-checked here and MEANING-checked in the domain: `validateMentions` runs inside
   * the send transaction against the conversation's live participants, so a mention of
   * somebody who is not in the thread is refused there rather than trusted here. This
   * schema only guarantees the transport is well formed.
   */
  mentions: z
    .array(
      z.union([
        z.object({
          kind: z.literal('PRINCIPAL'),
          principalId: uuid,
          offset: z.number().int().nonnegative(),
          length: z.number().int().positive(),
        }),
        z.object({
          kind: z.literal('ALL'),
          offset: z.number().int().nonnegative(),
          length: z.number().int().positive(),
        }),
      ]),
    )
    .max(MAX_MENTIONS)
    .optional(),
  })
  /**
   * A message must carry SOMETHING.
   *
   * Words, or a file, or both — but not neither. Expressed as a cross-field rule rather
   * than as `min(1)` on the body, because "empty" only means "nothing to send" when there
   * is also no attachment, and the two fields have to be read together to know that.
   */
  .refine((value) => value.body.trim().length > 0 || (value.attachmentIds?.length ?? 0) > 0, {
    message: 'a message needs a body or an attachment',
  });

/**
 * One emoji, bounded.
 *
 * There is no reaction catalogue and there should not be one — a catalogue is a
 * configuration entity awaiting sign-off (rule 10), where a character is just what the
 * person pressed. The bound stops the column becoming a general-purpose text field on a
 * hot table; it matches the CHECK constraint in migration 0011.
 */
const editSchema = z.object({
  body: z.string().min(1).max(10_000),
});

/**
 * Where a forwarded message is going.
 *
 * The destination is in the BODY rather than the path because the authorization is
 * two-sided — read the source, write the destination — and a path naming only one of them
 * invites a handler that checks only one of them.
 *
 * One conversation at a time. A list would make the refusal ambiguous: "some of these
 * went" is not an answer a caller can act on, and the partial-success shape it forces
 * ("forwarded to 2 of 4, and no, we will not say which two") is worse than making the
 * client send four requests it can report on individually.
 */
const forwardSchema = z.object({
  toConversationId: uuid,
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(16),
});

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

@Controller('v1/employee/conversations/:conversationId/messages')
@RequireSurface('EMPLOYEE')
export class EmployeeMessagesController {
  constructor(
    @Inject(MESSAGE_STORE) private readonly store: MessageStore,
    @Inject(MESSAGE_READER) private readonly reader: MessageReader,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(CURSOR_CODEC) private readonly cursors: CursorCodec,
    @Inject(LOGGER) private readonly logger: Logger,
    // Explicit token: `emitDecoratorMetadata` is off, so a bare parameter resolves to
    // undefined and fails at first use rather than at boot.
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(REACTION_STORE) private readonly reactions: ReactionStore,
    @Inject(PIN_STORE) private readonly pins: PgPinStore,
    @Inject(MESSAGE_INFO_STORE) private readonly messageInfoStore: PgMessageInfoStore,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
    @Inject(READ_STATE_STORE) private readonly readState: ReadStateStore,
  ) {}

  @Post()
  async send(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = sendSchema.safeParse(body);
    // A malformed id is a refusal, never an internal error (doc §27.10).
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    const actor: ActorContext = toActorContext(claims.value);

    /**
     * NFR-PRF-2's acknowledgement clock starts here, not at the top of the handler.
     *
     * The target is "the time from the request reaching the send path to the durable
     * acknowledgement", and parsing plus the identity lookup above are neither. Including
     * them would measure a different thing from the one the SLO names, and the alert
     * (`SendAckLatencyBreach`, p95 > 300ms) would drift with an unrelated cache miss.
     */
    const startedAt = Date.now();

    const result = await sendMessage(
      {
        conversationId: conversationId.data,
        actor,
        ...(parsed.data.mentions !== undefined ? { mentions: parsed.data.mentions } : {}),
        senderDisplayName: claims.value.displayName,
        body: parsed.data.body,
        visibility: parsed.data.visibility as MessageVisibility,
        hasAttachment: (parsed.data.attachmentIds?.length ?? 0) > 0,
        ...(parsed.data.replyToMessageId !== undefined
          ? { replyToMessageId: parsed.data.replyToMessageId }
          : {}),
        ...(parsed.data.clientMessageId !== undefined
          ? { clientMessageId: parsed.data.clientMessageId }
          : {}),
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) {
      this.logger.info('message send refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'message.send',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      // Every domain failure renders as the same refusal: "you may not" and "it does
      // not exist" must be indistinguishable (§27.3).
      return refuse();
    }

    /**
     * The durable acknowledgement, observed (§32.4's "error rate or latency breaching
     * NFR targets"; NFR-PRF-2's p95 = 300ms).
     *
     * Recorded only on SUCCESS. A refusal returns in microseconds because it never
     * touched the database, so counting refusals would drag the percentile down and make
     * a degrading send path look healthier the more it refused — which is precisely
     * backwards. The histogram was declared and never observed until 2026-08-29, so
     * `SendAckLatencyBreach` had no series to evaluate.
     */
    metrics.observe(METRICS.messageSendAck, (Date.now() - startedAt) / 1000);


    /**
     * Attachments are bound AFTER the message exists, and a failure to bind never fails
     * the send.
     *
     * §28.1 makes binding the moment a file becomes reachable, so it needs a message to
     * bind to — the order is forced. What is a choice is what happens when a file is not
     * ready: it is still being scanned, or it was rejected, or it belongs to another
     * conversation. Holding the MESSAGE until every file is clean would make the text
     * hostage to the file, which is the opposite of §34's degradation rule and brief §43
     * invariant 9.
     *
     * So the send succeeds and the response says which attachments actually attached.
     * A surface can then say "still checking your document" and retry, instead of the
     * customer watching their message vanish because a scanner was slow.
     */
    const attached =
      parsed.data.attachmentIds !== undefined && parsed.data.attachmentIds.length > 0
        ? await this.attachments.bindAll({
            attachmentIds: parsed.data.attachmentIds,
            messageId: result.message.messageId,
            conversationId: conversationId.data,
          })
        : { bound: [], notBound: [] };

    /**
     * A message with no words needs its preview recomputed once the file is attached.
     *
     * The send path writes the preview from the BODY, inside the same transaction — which
     * is right, and which for an attachment-only message writes an empty string, because
     * binding necessarily happens afterwards. Left there, the conversation list shows the
     * message before it and then falls back to the conversation's kind, so the row says
     * nothing happened when something did.
     *
     * Only when there is nothing else to show, and never fatal: the message is already
     * sent and committed, and a stale sidebar line is not worth failing a delivered
     * message over.
     */
    if (parsed.data.body.trim() === '' && attached.bound.length > 0) {
      await this.store
        .transaction(async (tx) => tx.refreshPreview(conversationId.data))
        .catch(() => undefined);
    }

    /**
     * Mention notifications, AFTER the message is durable and outside its transaction.
     *
     * Rule 1: a message is durable before it is delivered, never the reverse. The send has
     * already committed by the time this runs, so a notification outage costs the
     * notification and not the message (invariant 9) — which is also why it is awaited but
     * never allowed to fail the response.
     *
     * `result.mentioned` was resolved inside the send transaction against the live
     * participant set, so `@all` is already an explicit list and the sender is already
     * removed.
     */
    if (result.mentioned !== undefined) {
      await this.notifier
        .mentioned(conversationId.data, result.message.messageId, result.mentioned)
        .catch((error: unknown) => {
          this.logger.warn('mention notification failed', {
            correlationId: request.correlationId,
            operation: 'message.mention.notify',
            outcome: 'FAILED',
            errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          });
        });
    }

    return {
      messageId: result.message.messageId,
      seq: result.message.seq,
      createdAt: result.message.createdAt,
      duplicate: result.duplicate,
      attachedIds: attached.bound,
      // Named so the surface cannot mistake "not attached" for "attached". An empty
      // list here is the normal case; a non-empty one needs showing to the sender.
      notAttachedIds: attached.notBound,
    };
  }

  @Get()
  async page(
    @Param('conversationId') conversationIdRaw: string,
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = pageSchema.safeParse(query);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    // Authorize the READ before touching message content, by loading the conversation
    // and deciding against it — the same object check the write path performs.
    /**
     * Captured from the SAME load the authorization uses, rather than re-read.
     *
     * The employee surface needs the lifecycle state to know which action to offer — §21.4
     * permits resolve only from an open state and reopen only from RESOLVED — and a second
     * read could return a state the authorization did not see.
     */
    let lifecycleState: string | undefined;
    let conversationType: string | undefined;

    const authorized = await this.store.transaction(async (tx) => {
      const conversation = await tx.loadConversationForUpdate(conversationId.data);
      if (conversation === undefined) return false;
      lifecycleState = conversation.state ?? undefined;
      conversationType = conversation.conversationType;
      const participant = await tx.loadParticipant(conversationId.data, session.principalId);
      return recordDecision(
        'conversation.read',
        decide({
        actor: toActorContext(claims.value),
        action: 'conversation.read',
        resource: {
          conversationId: conversation.conversationId,
          conversationType: conversation.conversationType,
          ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
          ...(conversation.owningTeamId !== undefined ? { owningTeamId: conversation.owningTeamId } : {}),
          ...(conversation.owningDepartment !== undefined
            ? { owningDepartment: conversation.owningDepartment }
            : {}),
          ...(conversation.currentOwnerId !== undefined
            ? { currentOwnerId: conversation.currentOwnerId }
            : {}),
          sensitivity: conversation.sensitivity,
          ...(participant !== undefined ? { participant } : {}),
        },
        now: new Date().toISOString(),
        }),
      ).allow;
    });

    if (!authorized) {
      /**
       * A refused read of a customer's history is audited (P-06, §31.3, golden G-20).
       *
       * P-06 makes "who read a customer's history" the question an incident asks, and
       * the refused attempts are half that answer - a burst against one conversation is
       * what probing looks like. The admin routes have recorded refusals since they were
       * written; this path counted them as a metric and wrote nothing to the ledger, so
       * the one question the ledger exists for could not be answered about reads.
       *
       * Only the employee surface records here. A customer being refused someone else's
       * conversation is already covered by the isolation tests, and auditing every such
       * probe would let an outsider write to the ledger at will.
       */
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'conversation.read',
        targetKind: 'conversation',
        targetId: conversationId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    let before: { createdAt: string; id: string } | undefined;
    if (parsed.data.cursor !== undefined) {
      const decoded = this.cursors.decode(parsed.data.cursor, conversationId.data);
      // An unsigned or replayed cursor is a client-supplied query, not a hint (§38).
      if (!decoded.ok) return refuse();
      before = { createdAt: decoded.cursor.createdAt, id: decoded.cursor.id };
    }

    const messages = await this.reader.readPage({
      conversationId: conversationId.data,
      // Staff may read both classes here; the CUSTOMER route tree passes only
      // CUSTOMER_VISIBLE, and that difference is enforced by the query, not the client.
      visibility: ['CUSTOMER_VISIBLE', 'INTERNAL'],
      limit: parsed.data.limit,
      ...(before !== undefined ? { before } : {}),
    });

    /**
     * §34.4: "Metadata lives in the database, so the conversation still shows *that* a
     * file exists — its absence is legible rather than mysterious."
     *
     * Until 2026-08-29 the message page carried no attachment metadata at all, so a
     * recipient could not see that a colleague had attached anything, let alone open it.
     * The whole Phase 7 pipeline was reachable in one direction only.
     *
     * Read per message rather than joined into the page query: an attachment is rare
     * relative to messages, and the filter below means a page with none costs nothing.
     * Filenames only — never a key, never a URL. A download URL is issued one object at a
     * time, after §28.4's full ladder, and is audited at issuance (ADR-012, FR-ATT-5), so
     * putting one in a list response would be handing out grants nobody asked for.
     */
    const attachmentsByMessage = new Map<string, { attachmentId: string; originalFilename?: string; declaredBytes: number; state: string }[]>();
    for (const record of await this.attachments.forMessages(messages.map((m) => m.messageId))) {
      const list = attachmentsByMessage.get(record.messageId!) ?? [];
      list.push(record);
      attachmentsByMessage.set(record.messageId!, list);
    }

    /**
     * Reactions for the whole page in ONE query, grouped by message and then by emoji.
     *
     * Per-message would be fifty round trips to render an ornament, which is exactly the
     * shape §38 measures against. Grouped here rather than in the client so every surface
     * gets the same shape, and `mine` is computed against the reader — the ids themselves
     * never leave the server.
     */
    const reactionsByMessage = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    for (const row of await this.reactions.forMessages(messages.map((m) => m.messageId))) {
      const list = reactionsByMessage.get(row.messageId) ?? [];
      const existing = list.find((entry) => entry.emoji === row.emoji);
      if (existing === undefined) {
        list.push({
          emoji: row.emoji,
          count: 1,
          mine: row.principalId === session.principalId,
        });
      } else {
        existing.count += 1;
        if (row.principalId === session.principalId) existing.mine = true;
      }
      reactionsByMessage.set(row.messageId, list);
    }

    const last = messages[messages.length - 1];

    /**
     * How far everybody else has read — the second tick.
     *
     * Read here rather than pushed only over the socket, because rule 9 requires that no
     * state exist only in an event: the frame makes the tick immediate, and this is what
     * makes it correct after a reload, a reconnect, or with realtime switched off
     * entirely. One aggregate over the participants of one conversation, on a page read
     * that is already loading messages, senders, reactions and mentions.
     */
    const readWatermark = await this.readState.readWatermark(
      conversationId.data,
      session.principalId,
    );

    return {
      readWatermark,
      /**
       * §21.4's state, for the action panel. NULL for an internal thread, which has no
       * lifecycle at all (BR-23, D-15) — absent rather than a placeholder, so the client
       * renders no controls instead of disabled ones.
       */
      ...(lifecycleState !== undefined ? { state: lifecycleState } : {}),
      /**
       * The KIND of conversation, which the state alone cannot express.
       *
       * An internal thread has no lifecycle state, and neither does a page that has
       * not loaded yet - so a client inferring "internal" from a missing state cannot
       * tell the two apart, and renders the wrong composer until the fetch lands.
       * BR-23 makes the kind the real fact; this returns it.
       */
      conversationType,
      messages: messages.map((m) => ({
        messageId: m.messageId,
        seq: m.seq,
        visibility: m.visibility,
        // The sender's id is exposed on the EMPLOYEE surface only, so a client can mark
        // its own messages without guessing from the display name — two colleagues can
        // share a name, and "(you)" attached to the wrong message is worse than absent.
        // The CUSTOMER surface projection deliberately omits it: handing a customer
        // staff principal ids lets them correlate agents across conversations.
        ...(m.senderPrincipalId !== undefined ? { senderPrincipalId: m.senderPrincipalId } : {}),
        senderDisplayName: m.senderDisplayName,
        body: m.body,
        /**
         * UC-E16's reply reference (SL-008).
         *
         * The column, the index and the write path all existed; this projection did not
         * return it, so a reply was stored correctly and then rendered as an ordinary
         * message. SL-008's acceptance is that the reference REMAINS VALID - it cannot
         * remain anything if no reader ever sees it.
         *
         * An id, never the quoted body: the parent is already on the page the client is
         * holding, and re-sending its text here would be a second copy of content whose
         * visibility was decided elsewhere.
         */
        ...(m.replyToMessageId !== undefined ? { replyToMessageId: m.replyToMessageId } : {}),
        /* Only when it is not an ordinary message — see the record's own note on why the
           common case sends nothing. */
        ...(m.messageClass !== undefined ? { messageClass: m.messageClass } : {}),
        /**
         * Structured mentions, exactly as stored.
         *
         * The renderer needs the OFFSETS, not just the ids: reconstructing which run of
         * characters to mark by searching the body for a display name is how "@Priya Nair"
         * inside a quotation gets highlighted as a mention of somebody who was never
         * mentioned, and how two colleagues with one name become indistinguishable.
         */
        ...(m.mentions !== undefined && m.mentions.length > 0 ? { mentions: m.mentions } : {}),
        /**
         * Edited and deleted, both as facts rather than as an absence.
         *
         * A deleted message arrives with an empty body and `redactedAt` set — the client
         * renders "this message was deleted" rather than an empty bubble, which would look
         * like a rendering fault. `editedAt` is what puts "edited" beside the timestamp;
         * without it a corrected message silently differs from what somebody remembers
         * reading.
         */
        /*
           The sender's own id for the message, echoed back so a client can recognise its
           own optimistic row. Sent on the EMPLOYEE surface only — it is a value that
           client chose, and it is meaningless (and needlessly correlatable) to anybody
           else. See `MessageRecord.clientMessageId`.
        */
        ...(m.clientMessageId !== undefined ? { clientMessageId: m.clientMessageId } : {}),
        ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
        ...(m.redactedAt !== undefined ? { redactedAt: m.redactedAt } : {}),
        /**
         * Reactions, grouped by emoji, with whether the reader is one of them.
         *
         * The principal ids are NOT sent. A client needs to know the count and whether to
         * highlight its own chip, and sending the full list would put "who reacted to
         * what" on the wire for every message on every page — a small profile of who is
         * paying attention to whom, for an ornament.
         */
        ...(reactionsByMessage.has(m.messageId)
          ? { reactions: reactionsByMessage.get(m.messageId) }
          : {}),
        ...(attachmentsByMessage.has(m.messageId)
          ? {
              attachments: (attachmentsByMessage.get(m.messageId) ?? []).map((a) => ({
                attachmentId: a.attachmentId,
                filename: a.originalFilename ?? 'attachment',
                declaredBytes: a.declaredBytes,
                /**
                 * §28.1: BOUND is the only state a recipient may reach. Sent so the
                 * interface can say "still being checked" rather than offering a download
                 * that will be refused — an explicit state, not a broken link (§34.4).
                 */
                state: a.state,
              })),
            }
          : {}),
        createdAt: m.createdAt,
      })),
      ...(messages.length === parsed.data.limit && last !== undefined
        ? {
            nextCursor: this.cursors.encode({
              createdAt: last.createdAt,
              id: last.messageId,
              conversationId: conversationId.data,
            }),
          }
        : {}),
    };
  }
  /**
   * Adds or removes a reaction (SL — internal chat).
   *
   * ## Authorized against the CONVERSATION, not the message
   *
   * Participation is a property of the thread, so the message is resolved to its
   * conversation first and `decide()` is asked about that. An unknown message id and a
   * message in a thread the caller cannot reach return the SAME refusal — the caller must
   * not be able to tell "no such message" from "not yours" (§27.3).
   *
   * ## Not audited
   *
   * §31.1 audits the exercise of AUTHORITY. A reaction is ordinary activity by somebody
   * already in the room — the same footing as sending a message, which is also not
   * audited. Recording every emoji would bury the entries an investigation actually reads.
   *
   * ## Idempotent
   *
   * The table's primary key is the whole tuple, so reacting twice is one row and
   * un-reacting something you never reacted to is a no-op. `changed` says whether anything
   * moved; both are 200, because neither is an error.
   */
  /**
   * Corrects a message (SL — internal chat).
   *
   * Two checks, in two places, and they answer different questions. `mayReactTo` — the
   * conversation-level object check — answers "may this person act in this thread at all",
   * which is the boundary (§46 rule 2). `editMessage` then answers "and is this message
   * theirs", which is a rule about the OPERATION and belongs with it, so every future
   * caller gets it too.
   *
   * Reusing the react check rather than adding a third action is deliberate: both are the
   * same authority — ordinary participation in an internal conversation — and a separate
   * `conversation.message.edit` action would be a grant somebody has to remember to give
   * for no distinction anybody makes.
   */
  @Patch(':messageId')
  async edit(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const messageId = uuid.safeParse(messageIdRaw);
    const parsed = editSchema.safeParse(body);
    if (!conversationId.success || !messageId.success || !parsed.success) return refuse();

    if (!(await this.mayReactTo(conversationId.data, request))) return refuse();

    const result = await editMessage(
      {
        conversationId: conversationId.data,
        messageId: messageId.data,
        actorId: request.session!.principalId,
        body: parsed.data.body,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    /**
     * `UNCHANGED` is not a failure the caller needs to see differently.
     *
     * Saving an editor without changing anything is an ordinary thing to do, and telling
     * somebody off for it would be noise. The message is returned as it stands, which is
     * what the client would render either way.
     */
    if (!result.ok && result.reason === 'UNCHANGED') return { edited: false };
    if (!result.ok) return refuse();

    return { edited: true, editedAt: result.message.editedAt };
  }

  /**
   * Deletes a message — a REDACTION, not a row removal.
   *
   * The row survives with its body blanked, because the per-conversation sequence must
   * stay gap-free (the client's gap detector reads a hole as a missed message and
   * re-fetches forever), a reply pointing at it must still resolve, and what was there
   * stays answerable from `message_revisions`. Idempotent: deleting twice succeeds and
   * writes one revision.
   */
  @Delete(':messageId')
  async remove(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const messageId = uuid.safeParse(messageIdRaw);
    if (!conversationId.success || !messageId.success) return refuse();

    if (!(await this.mayReactTo(conversationId.data, request))) return refuse();

    const result = await redactMessage(
      {
        conversationId: conversationId.data,
        messageId: messageId.data,
        actorId: request.session!.principalId,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) return refuse();
    return { redacted: true };
  }

  /**
   * Who has read this message, and when it was delivered — the "Message info" panel.
   *
   * Authorized with `conversation.read` on the conversation the message is in, and the
   * message is proved to BE in that conversation first. Without that, a caller could
   * authorize against a thread they belong to and read the receipts of a message in one
   * they do not — the object check would pass and the answer would come from somewhere
   * else. Unknown and not-yours give the same refusal (§27.3).
   *
   * Its own route rather than fields on the message projection: the read state is a join
   * against every participant, and doing it per row would pay for fifty of them to answer
   * a question somebody asks about one.
   */
  @Get(':messageId/info')
  async messageInfo(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const messageId = uuid.safeParse(messageIdRaw);
    if (!conversationId.success || !messageId.success) return refuse();

    if (!(await this.mayReadIn(conversationId.data, request))) return refuse();

    const info = await this.messageInfoStore.readers(conversationId.data, messageId.data);
    if (info === undefined) return refuse();
    return info;
  }

  /**
   * Sends an existing message on to another conversation.
   *
   * ## Both sides are authorized, separately
   *
   * Forwarding is a read of one conversation and a write to another, and the two are
   * different decisions about different objects. Checking only the destination would let
   * somebody copy text out of a thread they may not read; checking only the source would
   * let them write into a thread they are not in. Both, in that order, and the refusal is
   * identical either way so the caller cannot map out which conversations exist.
   *
   * ## An internal note does not become a customer-visible message
   *
   * The forwarded copy is sent with the SOURCE's visibility, and a note may only land in a
   * conversation where notes are possible. Rule 5 is the one rule in this file that would
   * fail silently and permanently: a customer reading a colleague's private assessment of
   * them cannot be undone by deleting it afterwards. `sendMessage` refuses an internal
   * note in a conversation that cannot hold one, so the domain is the boundary here — this
   * passes the visibility through rather than choosing one.
   *
   * ## It is a new message, not a reference
   *
   * The destination gets its own row, its own sequence and its own author: the person who
   * forwarded it. Deleting the original does not empty the copy, and the copy carries no
   * claim to be the original — attributing it to the first sender in a thread they are not
   * in would put words in their mouth in front of people they never addressed.
   */
  @Post(':messageId/forward')
  async forward(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const messageId = uuid.safeParse(messageIdRaw);
    const parsed = forwardSchema.safeParse(body);
    if (!conversationId.success || !messageId.success || !parsed.success) return refuse();

    /* The message must be in the conversation named in the path, or the read check below
       is authorizing against the wrong object. */
    const owner = await this.pins.conversationOf(messageId.data);
    if (owner === undefined || owner !== conversationId.data) return refuse();

    /* Forwarding to the thread it is already in is a no-op dressed as a feature. */
    if (parsed.data.toConversationId === conversationId.data) return refuse();

    if (!(await this.mayReadIn(conversationId.data, request))) return refuse();

    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    const source = await this.messageInfoStore.forwardable(
      conversationId.data,
      messageId.data,
    );
    /* A deleted message has no text to forward, and forwarding an empty body would put a
       blank bubble in another conversation over somebody's name. */
    if (source === undefined || source.body.trim() === '') return refuse();

    const result = await sendMessage(
      {
        conversationId: parsed.data.toConversationId,
        actor: toActorContext(claims.value),
        senderDisplayName: claims.value.displayName,
        body: source.body,
        visibility: source.visibility as MessageVisibility,
        hasAttachment: false,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) {
      this.logger.info('forward refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'message.forward',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      return refuse();
    }

    return { messageId: result.message.messageId, conversationId: parsed.data.toConversationId };
  }

  /**
   * May this caller READ this conversation?
   *
   * The same shape as `mayReactTo` below, with the read action — loaded and decided
   * against what it loaded, so the check is visible in the handler that needs it rather
   * than hidden behind a shared tail.
   */
  private async mayReadIn(conversationId: UUID, request: AuthenticatedRequest): Promise<boolean> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return false;

    return this.store.transaction(async (tx) => {
      const conversation = await tx.loadConversationForUpdate(conversationId);
      if (conversation === undefined) return false;
      const participant = await tx.loadParticipant(conversationId, session.principalId);
      return recordDecision(
        'conversation.read',
        decide({
          actor: toActorContext(claims.value),
          action: 'conversation.read',
          resource: {
            conversationId: conversation.conversationId,
            conversationType: conversation.conversationType,
            ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
            ...(conversation.owningTeamId !== undefined
              ? { owningTeamId: conversation.owningTeamId }
              : {}),
            ...(conversation.currentOwnerId !== undefined
              ? { currentOwnerId: conversation.currentOwnerId }
              : {}),
            sensitivity: conversation.sensitivity,
            ...(participant !== undefined ? { participant } : {}),
          },
          now: new Date().toISOString(),
        }),
      ).allow;
    });
  }

  @Post(':messageId/reactions')
  async react(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const target = await this.resolveReactionTarget(conversationIdRaw, messageIdRaw, body);
    if (target === undefined) return refuse();

    // The object check, with its answer used here rather than inside a shared tail. The
    // authorization guard requires exactly that, and it is right to: a handler that hands
    // its whole body to a helper is a handler whose enforcement cannot be read locally.
    if (!(await this.mayReactTo(target.conversationId, request))) return refuse();

    const changed = await this.reactions.add(
      target.messageId,
      request.session!.principalId,
      target.emoji,
    );
    return { changed };
  }

  @Delete(':messageId/reactions')
  async unreact(
    @Param('conversationId') conversationIdRaw: string,
    @Param('messageId') messageIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const target = await this.resolveReactionTarget(conversationIdRaw, messageIdRaw, body);
    if (target === undefined) return refuse();

    if (!(await this.mayReactTo(target.conversationId, request))) return refuse();

    const changed = await this.reactions.remove(
      target.messageId,
      request.session!.principalId,
      target.emoji,
    );
    return { changed };
  }

  /**
   * Parses the two ids and the emoji, and proves the message is IN the named conversation.
   *
   * That last part is not decoration. Without it a caller could authorize against a
   * conversation they are in and then react to a message belonging to one they are not —
   * the object check would pass and the write would land somewhere else entirely. An
   * unknown message and a message in another thread return the same `undefined`, so the
   * caller cannot tell "no such message" from "not yours" (§27.3).
   *
   * Deliberately NOT the authorization: this resolves, and `mayReactTo` decides. Keeping
   * them apart is what lets each route show its own check.
   */
  private async resolveReactionTarget(
    conversationIdRaw: string,
    messageIdRaw: string,
    body: unknown,
  ): Promise<{ conversationId: UUID; messageId: UUID; emoji: string } | undefined> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const messageId = uuid.safeParse(messageIdRaw);
    const parsed = reactionSchema.safeParse(body);
    if (!conversationId.success || !messageId.success || !parsed.success) return undefined;

    const owner = await this.reactions.conversationOf(messageId.data);
    if (owner === undefined || owner !== conversationId.data) return undefined;

    return {
      conversationId: conversationId.data,
      messageId: messageId.data,
      emoji: parsed.data.emoji,
    };
  }

  /**
   * May this caller react in this conversation?
   *
   * Loads the conversation and its participation and decides against WHAT IT LOADED — the
   * same shape as `mayActOn` in the conversations controller, and the property the
   * authorization guard derives rather than a spelling it recognises.
   */
  private async mayReactTo(conversationId: UUID, request: AuthenticatedRequest): Promise<boolean> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return false;

    return this.store.transaction(async (tx) => {
      const conversation = await tx.loadConversationForUpdate(conversationId);
      if (conversation === undefined) return false;
      const participant = await tx.loadParticipant(conversationId, session.principalId);
      return recordDecision(
        'conversation.message.react',
        decide({
          actor: toActorContext(claims.value),
          action: 'conversation.message.react',
          resource: {
            conversationId: conversation.conversationId,
            conversationType: conversation.conversationType,
            ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
            ...(conversation.owningTeamId !== undefined
              ? { owningTeamId: conversation.owningTeamId }
              : {}),
            ...(conversation.currentOwnerId !== undefined
              ? { currentOwnerId: conversation.currentOwnerId }
              : {}),
            sensitivity: conversation.sensitivity,
            ...(participant !== undefined ? { participant } : {}),
          },
          now: new Date().toISOString(),
        }),
      ).allow;
    });
  }

}
