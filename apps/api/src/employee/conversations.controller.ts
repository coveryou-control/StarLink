/**
 * Conversation lifecycle, participation and read state (doc §25.2).
 *
 * As with messages, this controller parses and delegates. The one thing it adds is the
 * BR-07 contract: a client must acknowledge that adding someone exposes prior history,
 * and the server refuses without it.
 */
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put,
  Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type pg from 'pg';
import {
  addParticipant,
  createInternalConversation,
  decide,
  removeParticipant,
  renameConversation,
  toActorContext,
  MAX_TITLE_LENGTH,
  type ConversationReader,
  type ConversationStore,
  type ReadStateStore,
} from '@starlink/conversation-domain';
import type { ConversationAuthzReader } from '@starlink/database';
import type {
  EmployeeDirectoryProvider,
  IdentityAuthorizationClient,
  PrincipalKind,
  UUID,
} from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import type { ConversationListCursorCodec } from '@starlink/security';
import {
  AUDIT_WRITER,
  AUTHZ_READER,
  CONVERSATION_LIST_CURSOR_CODEC,
  CONVERSATION_READER,
  CONVERSATION_STORE,
  DATABASE,
  EMPLOYEE_DIRECTORY,
  IDENTITY_CLIENT,
  LOGGER,
  READ_STATE_STORE,
} from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { recordDecision } from '../edge/authorization-metrics.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();

const createSchema = z.object({
  type: z.enum(['INTERNAL_DIRECT', 'INTERNAL_GROUP']),
  participantIds: z.array(uuid).min(1).max(200),
  title: z.string().min(1).max(200).optional(),
});

/**
 * Creating an announcement takes a title and nothing else.
 *
 * No `participantIds`: the audience of an announcement is every active employee, resolved
 * server-side. Letting the caller supply the list would make this a group with a different
 * name, and would let one be addressed to a hand-picked few while looking company-wide to
 * everybody who received it.
 */
const announceSchema = z.object({
  title: z.string().min(1).max(200),
});

/**
 * One flag. There is deliberately no mute — see migration 0018.
 *
 * Kept as an object rather than collapsing to a bare boolean: the next preference that
 * belongs to a person and a conversation goes here beside it, and a bare body would have to
 * be replaced rather than extended.
 */
const preferencesSchema = z.object({
  pinned: z.boolean(),
});

const renameSchema = z.object({
  // Length is bounded in the DOMAIN too — this is the transport's own sanity check, and
  // `MAX_TITLE_LENGTH` is the rule.
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

const addSchema = z.object({
  principalId: uuid,
  /** BR-07: the interface must state that prior history becomes readable. */
  historyExposureAcknowledged: z.boolean(),
});

const readSchema = z.object({ upToSeq: z.number().int().nonnegative() });

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  /**
   * Which list this is — conversations, or announcements.
   *
   * Two destinations over one relation. An announcement is a conversation the caller is a
   * participant of, so it would otherwise arrive in the chat list; whether it belongs there
   * is a product question and the answer is no. Defaulted, so every existing caller keeps
   * the list it already had.
   */
  scope: z.enum(['chats', 'announcements']).default('chats'),
});

@Controller('v1/employee/conversations')
@RequireSurface('EMPLOYEE')
export class EmployeeConversationsController {
  constructor(
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    @Inject(CONVERSATION_READER) private readonly reader: ConversationReader,
    @Inject(READ_STATE_STORE) private readonly readState: ReadStateStore,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(CONVERSATION_LIST_CURSOR_CODEC) private readonly listCursors: ConversationListCursorCodec,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(AUTHZ_READER) private readonly authz: ConversationAuthzReader,
    /* An announcement's audience comes from the directory adapter, never from the request
       and never from a query this controller writes itself (rule 11). */
    @Inject(EMPLOYEE_DIRECTORY) private readonly directory: EmployeeDirectoryProvider,
    /* One table, one statement — see `setPreferences`. Reaching for the store's port would
       mean a domain command for a two-boolean upsert that carries no rule. */
    @Inject(DATABASE) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The object check — load the conversation and authorise against IT (§18.4 step 3).
   *
   * The same three lines `routing.controller.ts` uses, for the same reason: a decision made
   * against anything other than the row being acted on is not a decision about it. Kept as
   * a private method per controller rather than a shared helper because the shared thing is
   * `decide()` itself; wrapping it would add a layer between the rule and its call sites.
   */
  private async mayActOn(principalId: UUID, conversationId: UUID, action: string): Promise<boolean> {
    const at = new Date().toISOString();
    const resource = await this.authz.loadForAuthorization(conversationId, principalId, at);
    // Absent and forbidden are one answer (§27.3).
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

  @Get()
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = listSchema.safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;

    let before: { lastActivityAt: string; id: UUID } | undefined;
    if (parsed.data.cursor !== undefined) {
      const decoded = this.listCursors.decode(parsed.data.cursor, session.principalId);
      // An unsigned or replayed cursor is a client-supplied query, not a hint (§38).
      if (!decoded.ok) return refuse();
      before = { lastActivityAt: decoded.cursor.lastActivityAt, id: decoded.cursor.id };
    }

    // Scope is applied by the query's join on participation, not by filtering after.
    const conversations = await this.reader.listForPrincipal(
      session.principalId,
      parsed.data.limit,
      before,
      parsed.data.scope === 'announcements' ? 'ANNOUNCEMENTS' : 'CHATS',
    );

    const last = conversations[conversations.length - 1];
    return {
      conversations,
      // A cursor is offered only when the page was full. Emitting one for a short page
      // would invite a client into an extra round trip that can only come back empty.
      ...(conversations.length === parsed.data.limit && last !== undefined
        ? {
            nextCursor: this.listCursors.encode({
              lastActivityAt: last.lastActivityAt,
              id: last.conversationId,
              principalId: session.principalId,
            }),
          }
        : {}),
    };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;

    // Resolve the KIND of every proposed participant from the identity source rather
    // than trusting the request. BR-08 depends on knowing who is a customer, and a
    // client-supplied kind would make that assertion worthless.
    const kinds: Record<UUID, PrincipalKind> = { [session.principalId]: 'EMPLOYEE' };
    for (const id of parsed.data.participantIds) {
      const claims = await this.identity.resolvePrincipal(id);
      // An unresolvable principal is not an employee as far as this operation is
      // concerned; refusing is safer than guessing.
      if (!claims.ok) return refuse();
      kinds[id] = 'EMPLOYEE';
    }

    const result = await createInternalConversation(
      {
        type: parsed.data.type,
        createdBy: session.principalId,
        participantIds: parsed.data.participantIds,
        participantKinds: kinds,
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) {
      this.logger.info('conversation create refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'conversation.create',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      return refuse();
    }

    return { conversationId: result.conversationId, existing: result.existing };
  }

  /**
   * Opens an announcement (SL — internal chat).
   *
   * ## Authorized before anything is written, by `decide()`
   *
   * Against a synthetic resource of the type being created and with no participant, so the
   * ONLY rung that can allow it is the role grant. That is the point: an announcement has no
   * object to check yet, and the question "may this person open one at all" is exactly a
   * permission question. Asking `decide()` rather than reading the claims directly keeps the
   * answer in the one function every other path uses (§38).
   *
   * ## The audience is resolved here, not sent
   *
   * Every ACTIVE employee becomes a participant, from the directory adapter — see
   * `listActiveEmployees` for why that is a separate operation from a search. The creator is
   * included by the domain command, so they are not added twice.
   *
   * The bound is real and refuses rather than truncates: an announcement that reached the
   * first 2000 employees and silently missed the rest would be worse than one that did not
   * open, because nobody would know which they had.
   */
  @Post('announcements')
  async announce(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = announceSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    const decision = decide({
      actor: toActorContext(claims.value),
      action: 'conversation.announcement.post',
      resource: {
        // Not yet a conversation. A synthetic id keeps the resource shape honest — nothing
        // in this decision can turn on it, because no CONVERSATION-scoped grant can name an
        // id that does not exist yet.
        conversationId: crypto.randomUUID(),
        conversationType: 'INTERNAL_ANNOUNCEMENT',
        sensitivity: 'ORDINARY',
      },
      now: new Date().toISOString(),
    });
    recordDecision('conversation.announcement.post', decision);

    if (!decision.allow) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'conversation.announcement.post',
        targetKind: 'conversation',
        targetId: session.principalId,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const audience = await this.directory.listActiveEmployees();
    if (!audience.ok) return refuse();

    const participantIds = audience.value
      .map((employee) => employee.principalId)
      .filter((id) => id !== session.principalId);

    if (participantIds.length === 0) return refuse();

    const kinds: Record<UUID, PrincipalKind> = { [session.principalId]: 'EMPLOYEE' };
    for (const id of participantIds) kinds[id] = 'EMPLOYEE';

    const result = await createInternalConversation(
      {
        type: 'INTERNAL_ANNOUNCEMENT',
        createdBy: session.principalId,
        participantIds,
        participantKinds: kinds,
        title: parsed.data.title,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) {
      this.logger.info('announcement create refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'conversation.announce',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      return refuse();
    }

    /**
     * Audited, unlike an ordinary conversation.
     *
     * §31.1 audits the exercise of AUTHORITY. Opening a thread with two colleagues is not
     * one; opening one addressed to the entire company, which only a few people may do, is.
     */
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.announcement.post',
      targetKind: 'conversation',
      targetId: result.conversationId,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { audience: participantIds.length + 1 },
    });

    return { conversationId: result.conversationId };
  }

  /**
   * May the caller open an announcement at all?
   *
   * The web application asks before drawing a "New announcement" control, so a reader is
   * never shown a button that answers 404. It is a convenience and not a boundary — the
   * POST above makes the same decision again, and that one is the boundary.
   */
  @Get('announcements/permission')
  async mayAnnounce(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return { mayPost: false };

    const decision = decide({
      actor: toActorContext(claims.value),
      action: 'conversation.announcement.post',
      resource: {
        conversationId: crypto.randomUUID(),
        conversationType: 'INTERNAL_ANNOUNCEMENT',
        sensitivity: 'ORDINARY',
      },
      now: new Date().toISOString(),
    });

    return { mayPost: decision.allow };
  }

  @Post(':conversationId/participants')
  async add(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = addSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;

    /**
     * The object check, before anything is exposed (§18.4 step 3, §46 rule 2).
     *
     * This route had NO authorization of any kind. It enforced only BR-05 — the adder is a
     * participant — inside the domain command, while `decide()` places
     * `conversation.participant.add` in OWNER_ACTIONS and deliberately NOT in
     * PARTICIPANT_ACTIONS, because P-03 is explicit that being in the room is not being in
     * charge of it.
     *
     * On a customer conversation the consequence was direct: any participant could add
     * anyone, and `addParticipant` exposes every prior message to them
     * (`messagesExposed`) with no sensitivity check on that path — so an ORDINARY-cleared
     * colleague could be walked into a MEDICAL thread by someone who had themselves been
     * walked in. It was latent until an ownership path began writing participant rows for
     * claimed conversations; before that the only participant of a customer conversation
     * was the customer, who cannot reach an employee route.
     *
     * `decide()` answers for both kinds of thread — see the INTERNAL branch there — so this
     * is one check, not a special case per conversation type.
     */
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.participant.add'))) {
      /**
       * Audited as a REFUSAL. §31.1 puts participation changes in the audited set, and a
       * refused attempt to widen who can read a conversation is exactly the kind of thing
       * an investigator asks about afterwards.
       */
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'conversation.participant.add',
        targetKind: 'conversation',
        targetId: conversationId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
        detail: { addedPrincipal: parsed.data.principalId },
      });
      return refuse();
    }

    const target = await this.identity.resolvePrincipal(parsed.data.principalId);
    if (!target.ok) return refuse();

    /*
       The two names the thread's own note needs.

       The added principal was resolved a line above for BR-08's kind check, so this is one
       extra lookup and not two. A failed lookup leaves the name absent and the domain skips
       the note rather than writing an anonymous one — see the command.
    */
    const adder = await this.identity.resolvePrincipal(session.principalId);
    const adderName = adder.ok ? adder.value.displayName : undefined;
    const addedName = target.value.displayName;

    const result = await addParticipant(
      {
        conversationId: conversationId.data,
        principalId: parsed.data.principalId,
        principalKind: 'EMPLOYEE',
        addedBy: session.principalId,
        historyExposureAcknowledged: parsed.data.historyExposureAcknowledged,
        /* Both names, so the thread can say what happened — see the command's own note on
           why an unnamed note is worse than none. Absent if either lookup failed. */
        ...(adderName !== undefined ? { addedByDisplayName: adderName } : {}),
        ...(addedName !== undefined ? { displayName: addedName } : {}),
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) return refuse();

    // Participant changes ARE audited: they change who may read prior history
    // (P-06, §31.1). Ordinary message sends are not.
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.participant.add',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { addedPrincipal: parsed.data.principalId, messagesExposed: result.messagesExposed },
    });

    return { messagesExposed: result.messagesExposed };
  }

  /**
   * Renames an internal group (SL-002).
   *
   * ## Why PATCH and why only the title
   *
   * A conversation's other fields are set by the flows that own them — ownership by
   * routing, state by §21.4, participants by their own routes — and a general "update the
   * conversation" body would be a door into all of them. The schema admits one key.
   *
   * ## Where each rule lives
   *
   * `decide()` answers "may this person act on this conversation at all", which is the
   * object check and is the boundary (§46 rule 2). Everything ELSE about renaming — that
   * the conversation is an internal group, that the renamer is a live participant, that
   * the title is neither empty nor absurd — is in `renameConversation`, because those are
   * rules about the OPERATION and this controller is one caller of it.
   *
   * ## Audited
   *
   * §31.1 audits changes to a conversation's identity, and a rename is one: a thread
   * somebody later has to argue from should be able to say what it was called and who
   * changed it. Both outcomes are recorded — a refused rename is exactly what an
   * investigator asks about when a thread's name is disputed.
   */
  @Patch(':conversationId')
  async rename(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = renameSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;

    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.rename'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'conversation.rename',
        targetKind: 'conversation',
        targetId: conversationId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    const result = await renameConversation(
      {
        conversationId: conversationId.data,
        title: parsed.data.title,
        renamedBy: session.principalId,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    if (!result.ok) return refuse();

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.rename',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { title: result.title },
    });

    return { title: result.title };
  }

  /**
   * Ends someone's participation.
   *
   * ## Two defects fixed here together, because one hides the other
   *
   * It performed no authorization — any participant could remove any other, including the
   * OWNER of a customer conversation, which puts that conversation back in the state where
   * its owner cannot find it in their own inbox.
   *
   * And it was `@HttpCode(204)` returning `void` on EVERY path: a malformed id, a domain
   * refusal and a real removal were indistinguishable to the caller, so the interface said
   * "they will not receive new messages here" whether or not anything had happened. An
   * authorization check on a handler that reports success regardless is not enforcement —
   * it is a refusal nobody is told about.
   */
  @Delete(':conversationId/participants/:principalId')
  @HttpCode(204)
  async remove(
    @Param('conversationId') conversationIdRaw: string,
    @Param('principalId') principalIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const principalId = uuid.safeParse(principalIdRaw);
    if (!conversationId.success || !principalId.success) return refuse();

    const session = request.session!;

    if (
      !(await this.mayActOn(session.principalId, conversationId.data, 'conversation.participant.remove'))
    ) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'conversation.participant.remove',
        targetKind: 'conversation',
        targetId: conversationId.data,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
        detail: { removedPrincipal: principalId.data },
      });
      return refuse();
    }

    const result = await removeParticipant(
      {
        conversationId: conversationId.data,
        principalId: principalId.data,
        removedBy: session.principalId,
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() },
    );

    // A domain refusal is a refusal, not a silent 204. `NOT_A_PARTICIPANT` in particular
    // is the ordinary mistake — removing somebody who was never in the conversation — and
    // the person doing it should be told, not congratulated.
    if (!result.ok) return refuse();

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'conversation.participant.remove',
      targetKind: 'conversation',
      targetId: conversationId.data,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { removedPrincipal: principalId.data },
    });
  }

  /**
   * This reader's mute and pin for one thread — the design's CONVERSATION switches.
   *
   * ## Authorized like a read, because that is what it discloses
   *
   * The row it writes is the caller's own, but the route still has to prove the
   * conversation is theirs to have an opinion about: without the object check it would
   * answer 200 for a real thread the caller may not see and blow up on a foreign key for an
   * id that does not exist, which is an enumeration oracle wearing a preference's clothes.
   * `markRead` below carries the same note and the same check for the same reason.
   *
   * ## PUT, and it states the whole preference
   *
   * The client holds the state and sends it, rather than PATCHing whichever control was
   * pressed: a read-modify-write per toggle would race with the next one, and this way the
   * row is whatever the panel last showed.
   */
  @Put(':conversationId/preferences')
  async setPreferences(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = preferencesSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.read'))) {
      return refuse();
    }

    await this.pool.query(
      `INSERT INTO conversation.conversation_preferences
         (principal_id, conversation_id, pinned, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (principal_id, conversation_id) DO UPDATE
         SET pinned = EXCLUDED.pinned, updated_at = now()`,
      [session.principalId, conversationId.data, parsed.data.pinned],
    );

    return { pinned: parsed.data.pinned };
  }

  @Post(':conversationId/read')
  async markRead(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = readSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;

    /**
     * The object check, on a route that had none at all.
     *
     * This looked harmless — read state is personal, and the row it writes is the
     * caller’s own. But `read_state.conversation_id` carries a NOT NULL foreign key to
     * `conversation.conversations` and there is no global exception filter, so the route
     * answered a question it must not:
     *
     *   * a real conversation the caller may not see  → 200, and a persisted row;
     *   * an id that does not exist                    → FK violation → 500.
     *
     * Any authenticated employee could therefore enumerate valid conversation ids by
     * response code — the exact distinction §27.3 exists to erase, reached through the one
     * route nobody thought carried content. It also let them write read state into a
     * stranger’s conversation.
     *
     * `conversation.read` is the right action: marking a thread read is an assertion about
     * having read it, and the person must be entitled to do that.
     */
    if (!(await this.mayActOn(session.principalId, conversationId.data, 'conversation.read'))) {
      return refuse();
    }

    // Read state is personal and idempotent, and is deliberately NOT audited —
    // auditing ordinary reading is surveillance, not accountability (P-06).
    const lastReadSeq = await this.readState.markRead(
      session.principalId,
      conversationId.data,
      parsed.data.upToSeq,
      new Date().toISOString(),
    );
    return { lastReadSeq };
  }
}
