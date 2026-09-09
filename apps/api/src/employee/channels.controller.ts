/**
 * Channels — the directory, the access policy, and joining.
 *
 * ## What is NOT in this file, and why that is the point
 *
 * Sending, replying, reacting, attaching, searching, muting, pinning, read state and
 * realtime. A channel is an `INTERNAL_CHANNEL` conversation, so every one of those is the
 * existing controller working unchanged on an existing `conversation_id` —
 * `messages.controller.ts` does not know channels exist and does not need to, because
 * `decide()` does.
 *
 * That is the whole architectural bet, and it is the one `0014_announcements.sql` made
 * first: a second messaging stack is where the authorization check gets forgotten (§38).
 * What is left here is the three questions a room answers about itself.
 *
 * ## The word "channel"
 *
 * Not `ChannelKind`, not `channel_sessions`, not `packages/channels` — those are the
 * external DELIVERY channel (WhatsApp, email, SMS). This is a room. See
 * `0030_channels.sql` for why the collision is left alone rather than renamed.
 */
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  createInternalConversation,
  decide,
  holdsAction,
  toActorContext,
  type ConversationStore,
} from '@starlink/conversation-domain';
import type { ConversationAuthzReader, PgChannelStore } from '@starlink/database';
import type { IdentityAuthorizationClient, PrincipalKind, UUID } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';

import {
  AUDIT_WRITER,
  AUTHZ_READER,
  CHANNEL_STORE,
  CONVERSATION_STORE,
  IDENTITY_CLIENT,
  LOGGER,
} from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';
import { recordDecision } from '../edge/authorization-metrics.js';
import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const uuid = z.string().uuid();

/**
 * The audience, when it is not everybody.
 *
 * Capped at 200 entries. A channel scoped to two hundred named individuals is a channel
 * whose author meant a department, and an uncapped list is a request body somebody can make
 * arbitrarily expensive to evaluate.
 */
const audienceSchema = z
  .array(
    z.object({
      scopeKind: z.enum(['DEPARTMENT', 'TEAM', 'PRINCIPAL']),
      /* Trimmed non-empty, matching the column's CHECK. A blank scope matches nobody's
         department and would be a channel that silently reaches no one (§27.2). */
      scopeId: z.string().trim().min(1).max(120),
    }),
  )
  .max(200)
  .default([]);

const policySchema = z.object({
  purpose: z.enum(['DEPARTMENT', 'TEAM', 'PROJECT', 'OTHER']).default('OTHER'),
  description: z.string().trim().min(1).max(400).optional(),
  visibility: z.enum(['EVERYONE', 'DEPARTMENTS', 'SELECTED']),
  readAccess: z.enum(['ANYONE_WHO_CAN_SEE', 'MEMBERS']),
  postAccess: z.enum(['ANYONE_WHO_CAN_READ', 'MEMBERS', 'ADMINS']),
  audience: audienceSchema,
});

const createSchema = policySchema.extend({
  name: z.string().trim().min(1).max(120),
  /**
   * People to open the room with. OPTIONAL and allowed to be empty, unlike a group.
   *
   * A group with one person in it is a mistake; a channel with one person in it is Monday
   * morning. See `createInternalConversation`.
   */
  memberIds: z.array(uuid).max(200).default([]),
});

const updateSchema = policySchema.extend({
  name: z.string().trim().min(1).max(120),
});

/**
 * What the client is told about one channel.
 *
 * `mayRead` and `mayPost` are CONVENIENCES — they decide whether the composer is drawn and
 * whether the thread is fetched at all. They are not the boundary: every content path
 * re-decides, and that decision is the one that counts. A reader shown a composer that
 * answers 404 learns the product is unreliable, which is a worse failure than not seeing it.
 */
interface ChannelView {
  readonly conversationId: string;
  readonly name: string;
  readonly description?: string;
  readonly purpose: string;
  readonly visibility: string;
  readonly readAccess: string;
  readonly postAccess: string;
  readonly archived: boolean;
  readonly memberCount: number;
  readonly membership: 'ADMIN' | 'MEMBER' | 'NONE';
  readonly unreadCount: number;
  readonly lastActivityAt: string;
  readonly mayRead: boolean;
  readonly mayPost: boolean;
  readonly mayManage: boolean;
  /** True when this person can put themselves in without being invited — see `join`. */
  readonly mayJoin: boolean;
}

@Controller('v1/employee/channels')
@RequireSurface('EMPLOYEE')
export class EmployeeChannelsController {
  constructor(
    @Inject(CHANNEL_STORE) private readonly channels: PgChannelStore,
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    @Inject(AUTHZ_READER) private readonly authz: ConversationAuthzReader,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The object check, in the one shape every controller here uses (§18.4 step 3).
   *
   * Loads the conversation and decides against IT. For a channel the loader brings the
   * access policy along in the same query, which is what makes `decide()` able to answer
   * "may this person post here" without a second lookup it might skip.
   */
  private async mayActOn(principalId: UUID, conversationId: UUID, action: string): Promise<boolean> {
    const at = new Date().toISOString();
    const resource = await this.authz.loadForAuthorization(conversationId, principalId, at);
    if (resource === undefined) return false;
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;
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

  /**
   * Decorates a directory row with what this caller may do with it.
   *
   * Four `decide()` calls per row rather than four rules restated here. Restating them is
   * how the button and the endpoint come to disagree — which is the class of defect §38
   * names, arriving through the front door.
   */
  private async viewOf(
    principalId: UUID,
    row: Awaited<ReturnType<PgChannelStore['directoryFor']>>[number],
  ): Promise<ChannelView> {
    const [mayRead, mayPost, mayManage] = await Promise.all([
      this.mayActOn(principalId, row.conversationId, 'conversation.read'),
      this.mayActOn(principalId, row.conversationId, 'conversation.message.send'),
      this.mayActOn(principalId, row.conversationId, 'channel.manage'),
    ]);

    return {
      conversationId: row.conversationId,
      name: row.name,
      ...(row.description !== undefined ? { description: row.description } : {}),
      purpose: row.purpose,
      visibility: row.visibility,
      readAccess: row.readAccess,
      postAccess: row.postAccess,
      archived: row.archived,
      memberCount: row.memberCount,
      membership: row.membership,
      unreadCount: row.unreadCount,
      lastActivityAt: row.lastActivityAt,
      mayRead,
      mayPost,
      mayManage,
      /*
         Self-join is for a room you can already read.

         An open channel is joined by walking in: membership there is a statement of
         interest, not a grant of access, and it is what puts the room in your list and your
         notifications. A channel readable by MEMBERS ONLY cannot be self-joined — that
         would make "members only" mean "anyone who presses the button", and the whole
         distinction between seeing and reading would collapse. Somebody has to add you, and
         the panel names the administrators so you know who to ask.
      */
      mayJoin: row.membership === 'NONE' && !row.archived && mayRead,
    };
  }

  /** Every channel this person is allowed to know exists. */
  @Get()
  async list(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = z
      .object({ includeArchived: z.enum(['true', 'false']).optional() })
      .safeParse(query ?? {});
    if (!parsed.success) return refuse();

    const session = request.session!;
    const rows = await this.channels.directoryFor(session.principalId, {
      includeArchived: parsed.data.includeArchived === 'true',
    });
    const channels = await Promise.all(rows.map((row) => this.viewOf(session.principalId, row)));
    return { channels };
  }

  /**
   * May this person open a channel at all?
   *
   * Asked before the "New channel" control is drawn, exactly as the announcements panel asks
   * before drawing its own. A convenience; `create` decides again and that one is the
   * boundary.
   */
  @Get('permission')
  async permission(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return { mayCreate: false };
    return {
      mayCreate: holdsAction(
        toActorContext(claims.value),
        'channel.create',
        new Date().toISOString(),
      ),
    };
  }

  /**
   * What an audience may be addressed to.
   *
   * Behind `directory.read`, which is the permission that already governs reading the staff
   * list - department and team NAMES are directory facts, and this returns nothing a person
   * who may page the directory could not already assemble from it. It is not free of
   * authorization, though: `directory.read` was once in the vocabulary and evaluated
   * nowhere, and any new joiner could page the entire staff list.
   *
   * Declared BEFORE `:conversationId`, or Nest matches "scopes" as a conversation id.
   */
  @Get('scopes')
  async scopes(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();
    if (!holdsAction(toActorContext(claims.value), 'directory.read', new Date().toISOString())) {
      return refuse();
    }
    return this.channels.availableScopes();
  }

  /**
   * Opens a channel.
   *
   * ## Why `holdsAction` and not `decide`
   *
   * There is no object yet. `decide()` needs a resource, and the announcement path fabricates
   * one with a random id — which works there because the only rung that can fire is the role
   * grant. It would be actively wrong here: a synthetic channel resource would need a
   * synthetic POLICY, and inventing the policy that decides the question is not a decision.
   *
   * `holdsAction` is the operation-with-no-resource rung, added for exactly this shape and
   * documented at length in `decide.ts`. It still reads the period from the clock, so an
   * expired grant opens nothing.
   */
  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return refuse();

    const session = request.session!;
    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    const at = new Date().toISOString();
    if (!holdsAction(toActorContext(claims.value), 'channel.create', at)) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'channel.create',
        targetKind: 'conversation',
        targetId: session.principalId,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    /*
       An audience is REQUIRED when the visibility says there is one.

       A channel set to DEPARTMENTS with no departments is visible to nobody. The database
       cannot refuse that (the rows arrive after the channel) and `decide()` reads it as a
       deny, which is the safe direction — but shipping a room nobody including its author
       can see is not a safe outcome, it is a support ticket. Refused here, where the caller
       can still be told.
    */
    if (parsed.data.visibility !== 'EVERYONE' && parsed.data.audience.length === 0) {
      return refuse();
    }

    const kinds: Record<UUID, PrincipalKind> = { [session.principalId]: 'EMPLOYEE' };
    for (const id of parsed.data.memberIds) kinds[id as UUID] = 'EMPLOYEE';

    const result = await createInternalConversation(
      {
        type: 'INTERNAL_CHANNEL',
        createdBy: session.principalId,
        participantIds: parsed.data.memberIds as UUID[],
        participantKinds: kinds,
        title: parsed.data.name,
        channel: {
          purpose: parsed.data.purpose,
          ...(parsed.data.description !== undefined
            ? { description: parsed.data.description }
            : {}),
          visibility: parsed.data.visibility,
          readAccess: parsed.data.readAccess,
          postAccess: parsed.data.postAccess,
          audience: parsed.data.audience,
        },
        correlationId: request.correlationId,
      },
      { store: this.store, now: () => new Date(), newId: () => crypto.randomUUID() as UUID },
    );

    if (!result.ok) {
      this.logger.info('channel create refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'channel.create',
        outcome: 'REFUSED',
        errorCode: result.reason,
      });
      /*
         A duplicate NAME arrives here as a unique-violation from the partial index rather
         than as a domain refusal, and it is the one failure worth naming: "that did not
         work" for a channel called Technology when Technology exists is a puzzle, and the
         second attempt produces the same puzzle.
      */
      return refuse();
    }

    /**
     * Audited, like an announcement and unlike an ordinary conversation.
     *
     * §31.1 audits the exercise of AUTHORITY. Opening a thread with two colleagues is not
     * one; creating a company space with a reserved name and a stated access policy, which
     * only some people may do, is.
     */
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'channel.create',
      targetKind: 'conversation',
      targetId: result.conversationId,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: {
        visibility: parsed.data.visibility,
        readAccess: parsed.data.readAccess,
        postAccess: parsed.data.postAccess,
        audience: parsed.data.audience.length,
        members: parsed.data.memberIds.length + 1,
      },
    });

    return { conversationId: result.conversationId };
  }

  /**
   * One channel, for the details panel — including for somebody who is not in it.
   *
   * Absent and forbidden are one answer (§27.3): `describeFor` applies the same visibility
   * predicate the directory does, so a channel this person may not know about is a 404 and
   * not a "you may not see this channel", which would confirm it exists.
   */
  @Get(':conversationId')
  async describe(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();
    const session = request.session!;

    const row = await this.channels.describeFor(conversationId.data as UUID, session.principalId);
    if (row === undefined) return refuse();

    const view = await this.viewOf(session.principalId, row);
    /*
       The audience list is shown only to somebody who may change it.

       "Visible to: Sales, Claims" tells an ordinary reader which other departments can see
       what they write, which is genuinely useful — and it also enumerates the company's team
       names to anybody with an account. The people who need the detail are the ones editing
       it; everybody else gets the summary the three enums already carry.
    */
    const audience = view.mayManage
      ? await this.channels.audienceOf(conversationId.data as UUID)
      : undefined;

    return { channel: view, ...(audience !== undefined ? { audience } : {}) };
  }

  /**
   * Changes the access policy, or the name.
   *
   * A whole-policy replace, audience included. "Who can see this" is one answer, not a set
   * of independently editable rows, and a partial update is how a channel ends up scoped to
   * a department somebody removed from the form three edits ago.
   */
  @Patch(':conversationId')
  async update(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = updateSchema.safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const id = conversationId.data as UUID;

    if (!(await this.mayActOn(session.principalId, id, 'channel.manage'))) {
      await this.audit.record({
        actorId: session.principalId,
        actorKind: 'EMPLOYEE',
        action: 'channel.manage',
        targetKind: 'conversation',
        targetId: id,
        outcome: 'REFUSED',
        correlationId: request.correlationId,
      });
      return refuse();
    }

    if (parsed.data.visibility !== 'EVERYONE' && parsed.data.audience.length === 0) {
      return refuse();
    }

    const changed = await this.channels.updatePolicy(id, {
      purpose: parsed.data.purpose,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      visibility: parsed.data.visibility,
      readAccess: parsed.data.readAccess,
      postAccess: parsed.data.postAccess,
      audience: parsed.data.audience,
    });
    if (!changed) return refuse();

    await this.channels.rename(id, parsed.data.name);

    /**
     * Audited on success, because narrowing or widening who can read a room is an exercise
     * of authority over other people's access — the thing §31.1 exists to record. The
     * BEFORE state is not captured here; the ledger is append-only and the previous values
     * are in the previous entry.
     */
    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'channel.manage',
      targetKind: 'conversation',
      targetId: id,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: {
        visibility: parsed.data.visibility,
        readAccess: parsed.data.readAccess,
        postAccess: parsed.data.postAccess,
        audience: parsed.data.audience.length,
      },
    });

    return { conversationId: id };
  }

  /**
   * Retires a channel, or brings it back.
   *
   * Not a delete. Participation is dated out rather than removed (BR-09/§24.3) and messages
   * are never destroyed; a channel is the same. Archived means: out of the directory for
   * everyone except its members, and refusing anything new.
   */
  @Post(':conversationId/archive')
  async archive(
    @Param('conversationId') conversationIdRaw: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    const parsed = z.object({ archived: z.boolean() }).safeParse(body);
    if (!conversationId.success || !parsed.success) return refuse();

    const session = request.session!;
    const id = conversationId.data as UUID;
    if (!(await this.mayActOn(session.principalId, id, 'channel.manage'))) return refuse();

    const changed = await this.channels.setArchived(id, parsed.data.archived);
    if (!changed) return refuse();

    await this.audit.record({
      actorId: session.principalId,
      actorKind: 'EMPLOYEE',
      action: 'channel.manage',
      targetKind: 'conversation',
      targetId: id,
      outcome: 'SUCCEEDED',
      correlationId: request.correlationId,
      detail: { archived: parsed.data.archived },
    });

    return { conversationId: id, archived: parsed.data.archived };
  }

  /**
   * Puts the caller in a channel they can already read.
   *
   * ## The authorization is `conversation.read`, and that is the whole design
   *
   * Joining does not grant access — it records interest in a room whose access the policy
   * already decided. So the test is "may this person read it", asked of `decide()` against
   * the loaded channel, which is the same question and the same code path the thread itself
   * will ask a moment later.
   *
   * A members-only channel therefore cannot be self-joined, because a non-member cannot read
   * it. That is the intended refusal: otherwise "members only" would mean "anybody who
   * presses the button", and separating visibility from read access would buy nothing.
   */
  @Post(':conversationId/join')
  async join(
    @Param('conversationId') conversationIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const conversationId = uuid.safeParse(conversationIdRaw);
    if (!conversationId.success) return refuse();

    const session = request.session!;
    const id = conversationId.data as UUID;

    const row = await this.channels.describeFor(id, session.principalId);
    if (row === undefined || row.archived) return refuse();
    if (row.membership !== 'NONE') return { conversationId: id, joined: true };

    if (!(await this.mayActOn(session.principalId, id, 'conversation.read'))) return refuse();

    const joined = await this.channels.addSelfAsMember(id, session.principalId, new Date());
    if (!joined) return refuse();

    return { conversationId: id, joined: true };
  }
}
