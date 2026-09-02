/**
 * The customer conversation surface (§21.5, §25.3, ADR-021).
 *
 * Three rules run through every handler here:
 *
 * **Scope is the query.** Every read joins the customer's participation. Nothing is
 * fetched and then filtered, and no handler accepts an identifier that widens what is
 * loaded — a customer supplies a conversation id, and the join decides whether it exists
 * as far as they are concerned (§30.2, §27.3).
 *
 * **Visibility is filtered in SQL, and again in the projection.** `visibility =
 * 'CUSTOMER_VISIBLE'` is a predicate in the message query; the projection then drops
 * anything that is not customer-visible a second time. That is not redundancy for its
 * own sake — the query is the boundary (§18.4 layer 3) and the projection is the last
 * line (layer 4), and an internal note should never reach a customer response's memory,
 * let alone its body.
 *
 * **Assurance is declared per operation, not globally.** Browsing categories and
 * starting a conversation are ANONYMOUS (§21.5): a customer with a question should not
 * have to prove who they are before asking it. Reading an existing thread requires only
 * participation, because participation is a fact we recorded rather than a claim we
 * believed. Anything that would reach policy, claim or payment data requires
 * VERIFIED_CUSTOMER — and no such route exists yet, so none is pretended at.
 */
import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  toCustomerConversationView,
  toCustomerMessagePage,
} from '@starlink/conversation-domain';
import { sendMessage, type MessageStore } from '@starlink/messaging';
import type { PgCategoryReader, PgCustomerStore } from '@starlink/database';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import pg from 'pg';
import {
  CATEGORY_READER,
  CONFIG,
  CUSTOMER_STORE,
  DATABASE,
  LOGGER,
  MESSAGE_STORE,
} from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Public, refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';
import { reopenOnReply } from './reopen-on-reply.js';
import { AttachmentService } from '../attachments/attachment-service.js';
import { ConversationNotifier } from '../notifications/conversation-notifier.js';

const uuid = z.string().uuid();

const intakeSchema = z.object({
  // Optional: §21.5 allows starting without choosing, and an unchosen category is
  // honest. Guessing one would file the request under something nobody picked and send
  // it to the wrong team once routing exists.
  categoryId: z.string().min(1).max(120).optional(),
  subject: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(10_000),
});

const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30) });
const sendSchema = z.object({
  message: z.string().min(1).max(10_000),
  clientMessageId: z.string().min(1).max(200).optional(),
  /** Claims only, by D-07 — enforced when the grant was issued, not here. */
  attachmentIds: z.array(uuid).max(10).optional(),
});

@Controller('v1/customer')
@RequireSurface('CUSTOMER')
export class CustomerConversationsController {
  constructor(
    @Inject(CUSTOMER_STORE) private readonly customers: PgCustomerStore,
    @Inject(CATEGORY_READER) private readonly categories: PgCategoryReader,
    @Inject(MESSAGE_STORE) private readonly messages: MessageStore,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(ConversationNotifier) private readonly notifier: ConversationNotifier,
  ) {}

  /**
   * Category browsing — PUBLIC, before any session exists (§21.5).
   *
   * The journey §21.5 describes is: pick a topic, then establish identity, then route.
   * Browsing therefore precedes not just identity but the SESSION — so no principal row and no audit entry is created for someone who opens
   * the widget, reads the topics and closes it. §21.5's own reason: "a customer who
   * abandons at the category step has disclosed nothing."
   *
   * Public is safe here because the list is non-sensitive by construction: topic names
   * shown to every visitor of the website anyway. The owning team is NOT included —
   * that is internal structure (§25.3).
   *
   * `provisional` is passed through rather than hidden. The taxonomy is unsigned-off
   * (D-17/D-18), and a surface that presented placeholder categories as settled would
   * put "General enquiry (placeholder)" in front of a real customer with no warning.
   */
  @Public()
  @Get('categories')
  async listCategories(): Promise<unknown> {
    const categories = await this.categories.listSelectable();
    return {
      categories: categories.map((category) => ({
        categoryId: category.categoryId,
        displayName: category.displayName,
        ...(category.parentId !== undefined ? { parentId: category.parentId } : {}),
        // The owning team is NOT exposed: internal structure is not the customer's
        // (§25.3), and it would let them infer the shape of the organisation.
        provisional: category.provisional,
      })),
    };
  }

  /**
   * Intake — persist FIRST and fast (NFR-PRF-2).
   *
   * No assignment, no routing, no SLA computation on this path. The customer's first
   * message must be durable before anything decides who handles it; coupling acceptance
   * to a queue being healthy means a customer types a complaint and watches it vanish.
   * The conversation is created unassigned in state NEW, which is a legitimate visible
   * state rather than a gap.
   */
  @Post('conversations')
  async intake(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = intakeSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;

    // An unknown or inactive category is refused, never defaulted.
    let owningTeamId: string | undefined;
    if (parsed.data.categoryId !== undefined) {
      const category = await this.categories.findSelectable(parsed.data.categoryId);
      if (category === undefined) return refuse();
      owningTeamId = category.owningTeamId;
    }

    const conversationId = crypto.randomUUID() as UUID;
    const caseId = crypto.randomUUID() as UUID;
    const at = new Date().toISOString();

    await this.customers.intake({
      conversationId,
      caseId,
      customerPrincipalId: session.principalId,
      ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
      ...(owningTeamId !== undefined ? { owningTeamId } : {}),
      ...(parsed.data.subject !== undefined ? { title: parsed.data.subject } : {}),
      at,
    });

    // The opening message goes through the SAME write path as any other, so the outbox
    // row, the sequence and the idempotency record all behave identically. A separate
    // intake write path would be a second place for the durability invariant to be got
    // wrong (ADR-007).
    const sent = await sendMessage(
      {
        conversationId,
        actor: {
          principalId: session.principalId,
          kind: 'CUSTOMER',
          status: 'ACTIVE',
          teams: [],
          departments: [],
          grants: [],
          delegations: [],
          temporaryGrants: [],
          ...(session.assurance !== undefined ? { assurance: session.assurance } : {}),
        },
        senderDisplayName: 'You',
        body: parsed.data.message,
        visibility: 'CUSTOMER_VISIBLE',
        /**
         * PSEUDONYMOUS: the customer has proved control of a contact detail.
         *
         * Required by the DOCUMENTS, not yet ratified by the business (D-02 remains
         * PROPOSED). §21.5 places identity before routing, ADR-019 says "starting a
         * general conversation = PSEUDONYMOUS", and §27.5 names intake an abuse target.
         * This was ANONYMOUS, which contradicted all three and let a visitor file a
         * complaint we had no way to reply to.
         *
         * PSEUDONYMOUS rather than VERIFIED_CUSTOMER on purpose: proving a mobile is
         * enough to start talking. Being RECOGNISED as an existing customer is a
         * stronger claim, and demanding it would turn away every prospect.
         */
        requiredAssurance: 'PSEUDONYMOUS',
        correlationId: request.correlationId,
      },
      { store: this.messages, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!sent.ok) {
      this.logger.warn('intake message refused after conversation created', {
        correlationId: request.correlationId,
        operation: 'customer.intake',
        outcome: 'FAILED',
        errorCode: sent.reason,
      });
      return refuse();
    }

    return { conversationId, status: 'OPEN' };
  }

  @Get('conversations')
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = pageSchema.safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;
    const records = await this.customers.listForCustomer(
      session.principalId,
      parsed.data.limit,
      new Date().toISOString(),
    );

    // The repository returns the INTERNAL record and the projection narrows it, so
    // there is one allow-list rather than a second one written in SQL that could drift.
    return { conversations: records.map(toCustomerConversationView) };
  }

  @Get('conversations/:conversationId/messages')
  async messagePage(
    @Param('conversationId') conversationIdRaw: string,
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = pageSchema.safeParse(query ?? {});
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString();

    // Participation is checked before content is read (§18.4 step 3, rule 2 of §46).
    const conversation = await this.customers.loadIfParticipant(
      conversationId.data,
      session.principalId,
      at,
    );
    if (conversation === undefined) return refuse();

    const records = await this.customers.readCustomerMessages(
      conversationId.data,
      session.principalId,
      parsed.data.limit,
      at,
    );

    const messages = toCustomerMessagePage(records, session.principalId);
    return {
      conversation: toCustomerConversationView(conversation),
      // Oldest-first for reading; the query pages newest-first.
      messages: [...messages].sort((a, b) => a.seq - b.seq),
    };
  }

  @Post('conversations/:conversationId/messages')
  async send(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = sendSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const at = new Date().toISOString() as Timestamp;

    /**
     * Authorization runs FIRST, before anything is decided or written (§18.4 step 3,
     * §46 rule 2).
     *
     * This line was missing until 2026-08-30 and it was the repository's most serious
     * defect. `reopenOnReply` below MUTATES — it revives a resolved conversation or forks
     * a new one — and it ran before `sendMessage`, which held the only `decide()` on this
     * path. Its own SELECT was `WHERE c.conversation_id = $1` with no participation
     * predicate, and both of its write paths take their own connection and COMMIT. So the
     * sequence for a stranger was: mutate, commit, THEN fail authorization, THEN return a
     * clean 404 while the writes stood.
     *
     * `POST /v1/customer/auth/session` is `@Public()`, so the attacker did not even need
     * an account: any anonymous party with a conversation id could revive a resolved
     * claim (clearing `resolved_at` and `outcome_code`, incrementing `reopen_count`) or
     * fork a new conversation onto a real customer's case. It also broke idempotency —
     * the fork ran per POST, so a retried request produced a second conversation.
     *
     * The same call the read path uses, deliberately: one participation check, written
     * once, so the two cannot drift.
     */
    const existing = await this.customers.loadIfParticipant(
      conversationId.data,
      session.principalId,
      at,
    );
    if (existing === undefined) return refuse();

    /**
     * BR-21/BR-22, applied BEFORE the message is written and AFTER the check above.
     *
     * A reply inside the reopen window revives this thread; one after it continues on a
     * new conversation against the same case. Either way the message is written exactly
     * once, to whichever conversation the rules chose — which is why this runs before the
     * send rather than after it.
     *
     * The customer is told nothing about which happened. §21.4's last transition row:
     * "No — it simply continues."
     */
    const target = await reopenOnReply(
      this.pool,
      conversationId.data,
      session.principalId,
      this.config.SL_REOPEN_WINDOW_SECONDS,
      at,
      () => crypto.randomUUID() as UUID,
    );

    const sent = await sendMessage(
      {
        conversationId: target.conversationId,
        actor: {
          principalId: session.principalId,
          kind: 'CUSTOMER',
          status: 'ACTIVE',
          teams: [],
          departments: [],
          grants: [],
          delegations: [],
          temporaryGrants: [],
          ...(session.assurance !== undefined ? { assurance: session.assurance } : {}),
        },
        senderDisplayName: 'You',
        body: parsed.data.message,
        // A customer surface CANNOT express INTERNAL. Not "must not" — the value is not
        // reachable from this handler, so no request body, however malformed, produces
        // an internal note authored by a customer (ADR-021).
        visibility: 'CUSTOMER_VISIBLE',
        // Same bar as intake. A conversation cannot be created below PSEUDONYMOUS, so
        // a participant is already there — but stating it keeps the two paths from
        // drifting apart if one is ever changed.
        requiredAssurance: 'PSEUDONYMOUS',
        ...(parsed.data.clientMessageId !== undefined
          ? { clientMessageId: parsed.data.clientMessageId }
          : {}),
        correlationId: request.correlationId,
      },
      { store: this.messages, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!sent.ok) return refuse();

    /**
     * `conversationId` is echoed because a fork means the customer's next poll must look
     * somewhere new — the widget follows the id it is given rather than the one it sent.
     * That is a mechanical redirect, not a disclosure: nothing in the response says a
     * conversation was closed, forked or continued, and the status the customer sees is
     * the same vocabulary as always (§22.5, D-26).
     */

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
            messageId: sent.message.messageId,
            // The conversation the message actually landed in, which a reopen may have
            // changed. Binding against the requested id would attach a document to a
            // conversation the message is not in, and `bind` requires the two to match.
            conversationId: target.conversationId,
          })
        : { bound: [], notBound: [] };

    /**
     * §29.2: "A customer replied on a conversation you own | Owner | In-app + external
     * if away."
     *
     * Raised against the conversation the message actually landed in, which a reopen may
     * have changed — telling the owner about the closed half of a fork would send them
     * to a thread with nothing new in it.
     *
     * Only for a genuine send. A duplicate is the same message arriving twice on a
     * retried request, and §29.2's "not notified" list starts with things that are not
     * new information.
     *
     * Nothing about this can fail the send: the notifier writes outbox rows and swallows
     * its own failures. The customer's message is durable either way (P-05), which is the
     * ordering §29.1 calls the one thing never to reverse.
     */
    if (!sent.duplicate) {
      await this.notifier.customerReplied(target.conversationId);
    }

    return {
      conversationId: target.conversationId,
      messageId: sent.message.messageId,
      seq: sent.message.seq,
      duplicate: sent.duplicate,
      attachedIds: attached.bound,
      notAttachedIds: attached.notBound,
    };
  }
}
