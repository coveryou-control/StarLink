/**
 * Conversation creation and participation (doc §11.1–11.2, FR-CONV-*).
 *
 * The rules encoded here are the ones that must survive interpretation by whoever
 * implements a future surface:
 *
 *   * BR-08 — a customer is NEVER a participant in an internal conversation, by any
 *     path. Enforced at creation and at every add, not by trusting callers.
 *   * BR-07 — adding a participant exposes ALL prior history, so the operation reports
 *     how much history is being exposed and refuses unless the caller acknowledged it.
 *   * BR-09 — removing a participant ends future access; it does not un-read what was
 *     read, so participation is ended by dating it, never by deleting the row.
 *   * FR-CONV-4 — internal conversations have no lifecycle (D-15).
 */
import type {
  ConversationType,
  PrincipalKind,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import { isChannelAdminRole } from '@starlink/shared-contracts';
import type { ConversationStore, NewChannelPolicy, NewParticipant } from './ports.js';

/**
 * The types with no customer, no `service_cases` row and therefore no lifecycle (D-15).
 *
 * An announcement is one of them. What makes it different from a group is who may SEND, and
 * that is a permission rather than a property of the thread — see `decide()`, which keeps a
 * SEPARATE and deliberately narrower list for "may any participant manage membership".
 */
const INTERNAL_TYPES: ReadonlySet<ConversationType> = new Set<ConversationType>([
  'INTERNAL_DIRECT',
  'INTERNAL_GROUP',
  'INTERNAL_ANNOUNCEMENT',
  /* A channel: no customer, no case, no lifecycle. What it does have is an access POLICY,
     which is a different axis entirely and lives in `conversation.channels`. */
  'INTERNAL_CHANNEL',
]);

export const isInternal = (type: ConversationType): boolean => INTERNAL_TYPES.has(type);

export interface CreateInternalCommand {
  /**
   * An announcement is created exactly as a group is — a title and a list of people.
   *
   * What differs is who may create one and who is on the list, and both of those are the
   * caller's business: the permission is `decide()`'s, and the audience comes from the
   * directory. This command's job is the same either way, so it takes the type and applies
   * the same rules to it: a title is required, and an empty audience is refused.
   */
  readonly type: 'INTERNAL_DIRECT' | 'INTERNAL_GROUP' | 'INTERNAL_ANNOUNCEMENT' | 'INTERNAL_CHANNEL';
  readonly createdBy: UUID;
  /** Excludes the creator, who is always added. */
  readonly participantIds: readonly UUID[];
  readonly participantKinds: Readonly<Record<UUID, PrincipalKind>>;
  readonly title?: string;
  /**
   * Present exactly when `type` is 'INTERNAL_CHANNEL'.
   *
   * Carried on the create command rather than written afterwards so the policy lands in the
   * same transaction as the room. See `NewChannelPolicy`.
   */
  readonly channel?: NewChannelPolicy;
  readonly correlationId: string;
}

export type CreateFailure =
  | 'CUSTOMER_IN_INTERNAL_CONVERSATION'
  | 'DIRECT_REQUIRES_EXACTLY_ONE_OTHER'
  | 'GROUP_REQUIRES_A_PARTICIPANT'
  | 'TITLE_REQUIRED_FOR_GROUP'
  | 'CHANNEL_REQUIRES_A_POLICY'
  | 'SELF_CONVERSATION';

export type CreateResult =
  | { readonly ok: true; readonly conversationId: UUID; readonly existing: boolean }
  | { readonly ok: false; readonly reason: CreateFailure };

export interface ConversationDeps {
  readonly store: ConversationStore;
  readonly now: () => Date;
  readonly newId: () => UUID;
}

export async function createInternalConversation(
  command: CreateInternalCommand,
  deps: ConversationDeps,
): Promise<CreateResult> {
  const others = [...new Set(command.participantIds)].filter((id) => id !== command.createdBy);

  if (command.type === 'INTERNAL_DIRECT') {
    if (others.length !== 1) return { ok: false, reason: 'DIRECT_REQUIRES_EXACTLY_ONE_OTHER' };
  } else if (command.type === 'INTERNAL_CHANNEL') {
    /*
       A channel may open EMPTY, and that is the difference from a group.

       A group with one person in it is a mistake - there is nobody to talk to and no way
       for anybody to arrive, because a group is joined by being added. A channel is joined
       by being FOUND: somebody opens "Technology", states who may see it, and the
       department walks in. Requiring a founding membership list would make every channel
       start as a group that happens to be discoverable.
    */
    if (command.title === undefined || command.title.trim() === '') {
      return { ok: false, reason: 'TITLE_REQUIRED_FOR_GROUP' };
    }
    /* No policy, no channel. `decide()` refuses a channel it cannot find a policy for, so
       creating one without would produce a room nobody can enter, including its author. */
    if (command.channel === undefined) return { ok: false, reason: 'CHANNEL_REQUIRES_A_POLICY' };
  } else {
    // Groups and announcements alike: somebody to talk to, and a name to find it by.
    if (others.length === 0) return { ok: false, reason: 'GROUP_REQUIRES_A_PARTICIPANT' };
    if (command.title === undefined || command.title.trim() === '') {
      return { ok: false, reason: 'TITLE_REQUIRED_FOR_GROUP' };
    }
  }
  /* Unchanged, including the fact that no branch above can reach it with an empty list
     except a channel - which is allowed to be empty and is therefore excluded. */
  if (command.type !== 'INTERNAL_CHANNEL' && others.length === 0) {
    return { ok: false, reason: 'SELF_CONVERSATION' };
  }

  // BR-08, checked before anything is written. A customer principal reaching an
  // internal thread would expose staff discussion about them to them.
  for (const id of [command.createdBy, ...others]) {
    if (command.participantKinds[id] === 'CUSTOMER') {
      return { ok: false, reason: 'CUSTOMER_IN_INTERNAL_CONVERSATION' };
    }
  }

  return deps.store.transaction(async (tx) => {
    if (command.type === 'INTERNAL_DIRECT') {
      const existing = await tx.findDirectConversation(command.createdBy, others[0] as UUID);
      // Idempotent by design: "open a DM with X" is a navigation action a user will
      // perform many times, and each one must land in the same thread.
      if (existing !== undefined) return { ok: true, conversationId: existing, existing: true };
    }

    const conversationId = deps.newId();
    const participants: NewParticipant[] = [command.createdBy, ...others].map((principalId) => ({
      principalId,
      principalKind: 'EMPLOYEE' as PrincipalKind,
      role: principalId === command.createdBy ? 'CREATOR' : 'PARTICIPANT',
      // Internal threads have no customer to reply to; the flag is meaningful only on
      // customer conversations, where D-04a makes it owner-only by default.
      replyAuthority: false,
    }));

    await tx.insertConversation({
      conversationId,
      conversationType: command.type,
      // Internal conversations carry no state at all (FR-CONV-4, D-15). The database
      // CHECK constraint enforces the same thing from the other side.
      ...(command.title !== undefined ? { title: command.title } : {}),
      createdBy: command.createdBy,
      participants,
      // Application clock, matching what `decide()` will evaluate against.
      createdAt: deps.now().toISOString(),
    });

    if (command.channel !== undefined) {
      await tx.insertChannelPolicy(conversationId, command.channel);
    }

    await tx.appendOutbox({
      eventName: 'conversation.created.v1',
      eventVersion: 1,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      payload: { conversationId, conversationType: command.type, channel: 'INTERNAL' },
      correlationId: command.correlationId,
    });

    return { ok: true, conversationId, existing: false };
  });
}

/* ------------------------------------------------------------- participation */

export interface AddParticipantCommand {
  readonly conversationId: UUID;
  readonly principalId: UUID;
  readonly principalKind: PrincipalKind;
  readonly addedBy: UUID;
  /**
   * The caller states that it has warned the user that prior history will be exposed
   * (BR-07). The API refuses without it, so the warning cannot be skipped by a client
   * that simply forgot to render it.
   */
  readonly historyExposureAcknowledged: boolean;
  /**
   * The two names for the note the thread will carry — "Neha added Vikram to the group".
   *
   * OPTIONAL, and the note is skipped when either is missing. A caller that cannot name
   * both people is a caller that would otherwise write "someone added someone", which is a
   * worse record of a membership change than none: it says something happened and nothing
   * about what.
   *
   * Names, not ids, and frozen at the moment of the change — the same rule §24.9 applies to
   * a message's sender. A later rename must not rewrite what the thread says happened.
   */
  readonly addedByDisplayName?: string;
  readonly displayName?: string;
  readonly correlationId: string;
}

export type AddParticipantFailure =
  | 'CONVERSATION_NOT_FOUND'
  | 'CUSTOMER_IN_INTERNAL_CONVERSATION'
  | 'ALREADY_PARTICIPANT'
  | 'ADDER_NOT_PARTICIPANT'
  | 'HISTORY_EXPOSURE_NOT_ACKNOWLEDGED';

export type AddParticipantResult =
  | { readonly ok: true; readonly messagesExposed: number }
  | { readonly ok: false; readonly reason: AddParticipantFailure };

export async function addParticipant(
  command: AddParticipantCommand,
  deps: ConversationDeps,
): Promise<AddParticipantResult> {
  return deps.store.transaction(async (tx) => {
    const type = await tx.loadConversationType(command.conversationId);
    if (type === undefined) return { ok: false, reason: 'CONVERSATION_NOT_FOUND' };

    if (isInternal(type) && command.principalKind === 'CUSTOMER') {
      return { ok: false, reason: 'CUSTOMER_IN_INTERNAL_CONVERSATION' };
    }

    const participants = await tx.listParticipants(command.conversationId);
    // BR-05: participation is granted by someone already inside the conversation.
    if (!participants.some((p) => p.principalId === command.addedBy)) {
      return { ok: false, reason: 'ADDER_NOT_PARTICIPANT' };
    }
    if (participants.some((p) => p.principalId === command.principalId)) {
      return { ok: false, reason: 'ALREADY_PARTICIPANT' };
    }

    const messagesExposed = await tx.countMessages(command.conversationId);
    if (!command.historyExposureAcknowledged) {
      // Deliberately refused rather than warned-and-proceeded: the interface must say
      // so BEFORE the action, and a server that proceeds anyway makes that optional.
      return { ok: false, reason: 'HISTORY_EXPOSURE_NOT_ACKNOWLEDGED' };
    }

    await tx.addParticipant(
      command.conversationId,
      {
        principalId: command.principalId,
        principalKind: command.principalKind,
        role: 'PARTICIPANT',
        replyAuthority: false,
      },
      command.addedBy,
      // The same clock that `decide()` will later compare against. See the note on the
      // port: a period whose start and end come from different clocks is a period that
      // can be empty, or live before it began.
      deps.now().toISOString(),
    );

    /**
     * A one-to-one with three people in it is a group.
     *
     * §21 treats the two kinds as the same object with a different participant count, and
     * the type was simply never updated when the count crossed — so a thread could have
     * three members, be named after all three, show a stacked avatar, and still be an
     * `INTERNAL_DIRECT` underneath. That is not cosmetic: `renameConversation` refuses
     * anything that is not an `INTERNAL_GROUP`, so the one control that would give the new
     * group a name of its own was correctly hidden, and the product had no way to make it
     * a real group ever again.
     *
     * `participants` was read BEFORE the insert, so three members now means two then.
     *
     * BR-05's idempotency is unaffected either way — `findDirectConversation` matches on
     * `HAVING count(*) = 2`, so a three-person thread was never a candidate for it. This
     * makes the stored type agree with that arithmetic instead of contradicting it.
     */
    if (type === 'INTERNAL_DIRECT' && participants.length >= 2) {
      await tx.promoteDirectToGroup(command.conversationId);
    }

    /*
       The note, in the same transaction as the participation row.

       Screen 03 draws it as a centred caption, and it is the only thing in the thread that
       explains why somebody who was not here yesterday can read yesterday. BR-07 makes that
       exposure the point of the confirmation; this is the part of it the CONVERSATION can
       see, rather than only the person who clicked.
    */
    if (command.addedByDisplayName !== undefined && command.displayName !== undefined) {
      await tx.appendSystemMessage(
        command.conversationId,
        `${command.addedByDisplayName} added ${command.displayName}`,
        deps.now().toISOString(),
      );
    }

    return { ok: true, messagesExposed };
  });
}

export interface RemoveParticipantCommand {
  readonly conversationId: UUID;
  readonly principalId: UUID;
  readonly removedBy: UUID;
  readonly correlationId: string;
}

export type RemoveParticipantResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'NOT_A_PARTICIPANT'
        | 'REMOVER_NOT_PARTICIPANT'
        | 'CANNOT_REMOVE_CUSTOMER'
        | 'CANNOT_REMOVE_SELF'
        /* Only a group's creator may remove somebody from it — see the check itself. */
        | 'NOT_THE_GROUP_ADMIN';
    };

export async function removeParticipant(
  command: RemoveParticipantCommand,
  deps: ConversationDeps,
): Promise<RemoveParticipantResult> {
  return deps.store.transaction(async (tx) => {
    const participants = await tx.listParticipants(command.conversationId);
    if (!participants.some((p) => p.principalId === command.removedBy)) {
      return { ok: false, reason: 'REMOVER_NOT_PARTICIPANT' };
    }

    /**
     * The customer cannot be removed from their own conversation.
     *
     * Nothing checked WHO was being removed, so an owner could end the customer's
     * participation — and participation is what authorizes on the customer surface, so
     * every read and every reply then returned "no such conversation" to the person the
     * conversation is about. There is no way back: `POST /participants` resolves the
     * target through the employee identity source, which refuses a customer principal and
     * hardcodes `principalKind: 'EMPLOYEE'` regardless, and the fork path copies only live
     * rows. The customer is locked out of their own thread, permanently, by one request.
     *
     * Refused in the domain rather than in the controller so it holds for every surface
     * that ever calls this — the controller is one caller, and this is a rule about the
     * operation.
     */
    const target = participants.find((p) => p.principalId === command.principalId);
    if (target?.principalKind === 'CUSTOMER') {
      return { ok: false, reason: 'CANNOT_REMOVE_CUSTOMER' };
    }

    /**
     * Nor can somebody remove themselves.
     *
     * An owner removing their own participation leaves `current_owner_id` naming them
     * while `listForPrincipal` — which INNER JOINs live participation — stops showing it.
     * The conversation is theirs, accountable to them, and absent from their inbox: the
     * "owns work they cannot find" defect, reachable through a different door. They cannot
     * re-add themselves either, because BR-05 requires a LIVE participant to grant
     * participation and they have just ended their own.
     *
     * Leaving a conversation is a real thing an employee might want, but it is a transfer
     * — someone else has to hold it — and that route exists. This one does not become it
     * by accident.
     */
    if (command.principalId === command.removedBy) {
      return { ok: false, reason: 'CANNOT_REMOVE_SELF' };
    }

    /**
     * In a GROUP, only the creator may remove somebody.
     *
     * Asked for on 2026-09-04, and it closes a real hole rather than adding a courtesy:
     * until now any participant could end any other participant's access, so the newest
     * member of a twelve-person group could remove the other eleven, and only BR-05
     * (which needs a live participant to re-add them) stood between that and permanent.
     *
     * `CREATOR` is the role `createInternalConversation` has always written for whoever
     * started the conversation — migration 0023 explains why no second word was invented
     * for it, and why there is deliberately no way to appoint a second admin.
     *
     * ## Why only for a group
     *
     * A one-to-one has no membership to administer. A CUSTOMER conversation runs on
     * OWNERSHIP (§21) — a different model with an exclusion constraint behind it, where an
     * owner or a lead removing a colleague is the ordinary case. Layering a creator rule
     * on top would be a second authority over one object, which rule 11 forbids.
     *
     * ## Why it lives in the domain
     *
     * The controller is one caller. This is a rule about the operation, so it holds for
     * every surface that ever performs it — the same reasoning as the two rules above.
     */
    const conversationType = await tx.loadConversationType(command.conversationId);
    if (conversationType === 'INTERNAL_GROUP') {
      const remover = participants.find((p) => p.principalId === command.removedBy);
      if (remover?.role !== 'CREATOR') {
        return { ok: false, reason: 'NOT_THE_GROUP_ADMIN' };
      }
    }

    // Ends future access by dating the participation, never by deleting it: what a
    // person COULD have read has to stay answerable after the fact (BR-09, §24.3).
    const ended = await tx.endParticipation(
      command.conversationId,
      command.principalId,
      deps.now().toISOString(),
    );
    return ended ? { ok: true } : { ok: false, reason: 'NOT_A_PARTICIPANT' };
  });
}

/* ------------------------------------------------------------------------ leaving ---- */

export interface LeaveConversationCommand {
  readonly conversationId: UUID;
  readonly principalId: UUID;
  readonly correlationId: string;
}

export type LeaveConversationFailure = 'NOT_A_PARTICIPANT' | 'NOT_AN_INTERNAL_GROUP';

export type LeaveConversationResult =
  | {
      readonly ok: true;
      /** Set when the leaver was the group's creator and the role had to pass on. */
      readonly creatorPassedTo?: UUID;
    }
  | { readonly ok: false; readonly reason: LeaveConversationFailure };

/**
 * Leaving a group you are in.
 *
 * ## Why this is not `removeParticipant` with yourself as the target
 *
 * That command refuses self-removal outright, and it is right to. Its reasoning is about
 * OWNED conversations: an owner who ends their own participation still holds
 * `current_owner_id`, so the thread stays accountable to them while `listForPrincipal` —
 * which inner-joins live participation — stops showing it to them. Work they own and
 * cannot find, which is the defect rule 7 exists to prevent. It also refuses anybody but
 * the group's creator, because otherwise the newest member of a twelve-person group could
 * remove the other eleven.
 *
 * Neither reason reaches a person leaving an internal group. There is no owner to strand:
 * `current_owner_id` comes from `service_cases`, and an internal conversation has none. And
 * leaving is not an exercise of authority over anybody else — it is the one membership
 * change that needs no permission over another person, which is exactly why the creator
 * rule must not apply to it.
 *
 * So it is a separate command rather than a hole cut in that one. Both guards there stay
 * exactly as strict as they were.
 *
 * ## Groups only
 *
 * Not a one-to-one: leaving one leaves the other person talking into a thread that can
 * never be answered, and the thing somebody actually wants there is to stop seeing it,
 * which is archive. Not a customer conversation: those run on ownership and the way out of
 * one is a transfer, which exists.
 *
 * ## The creator handing over
 *
 * `CREATOR` is the only role permitted to remove somebody from a group (migration 0023).
 * A creator who leaves therefore takes the group's only administrator with them, and the
 * remaining members keep a thread nobody can ever manage. The role passes to the
 * longest-standing remaining participant — the group's version of rule 7: the accountable
 * position is reassigned, never left empty.
 *
 * The LAST person may still leave, and then nobody holds it. That is not an orphan; it is
 * an empty room. The history stays answerable either way, because participation is dated
 * rather than deleted (BR-09, §24.3).
 */
export async function leaveConversation(
  command: LeaveConversationCommand,
  deps: ConversationDeps,
): Promise<LeaveConversationResult> {
  return deps.store.transaction(async (tx) => {
    const conversationType = await tx.loadConversationType(command.conversationId);
    /*
       Groups and CHANNELS, and nothing else.

       A channel is the clearest case there is for leaving: somebody joined the Marketing
       room, stopped needing it, and wants it out of their list. Refusing would leave the
       only way out being to ask an administrator to remove them, for a room they let
       themselves into.

       The other types are unchanged and each is refused for its own reason: leaving a 1:1
       leaves the other person talking into a thread that can never be answered (archive is
       the way out of one), a customer conversation's exit is a TRANSFER because somebody
       must stay accountable, and an announcement's participants are the whole company.
    */
    if (conversationType !== 'INTERNAL_GROUP' && conversationType !== 'INTERNAL_CHANNEL') {
      return { ok: false, reason: 'NOT_AN_INTERNAL_GROUP' };
    }

    const participants = await tx.listParticipants(command.conversationId);
    const leaver = participants.find((p) => p.principalId === command.principalId);
    if (leaver === undefined) return { ok: false, reason: 'NOT_A_PARTICIPANT' };

    /*
       Chosen BEFORE the participation is ended, from the ordered list the store returns,
       so the successor is the earliest-joined of the people who are staying.

       A CHANNEL passes the role on only when the last administrator is walking out. A
       group has exactly one CREATOR, so "the creator is leaving" and "the last
       administrator is leaving" are the same sentence there; a channel can have several,
       and moving the role every time one of them leaves would hand authority to somebody
       who did not ask for it while three other administrators were still in the room.
    */
    const administratorsRemaining = participants.filter(
      (p) => p.principalId !== command.principalId && isChannelAdminRole(p.role),
    );
    const shouldPassOn =
      conversationType === 'INTERNAL_CHANNEL'
        ? isChannelAdminRole(leaver.role) && administratorsRemaining.length === 0
        : leaver.role === 'CREATOR';
    const successor = shouldPassOn
      ? participants.find((p) => p.principalId !== command.principalId)
      : undefined;

    const ended = await tx.endParticipation(
      command.conversationId,
      command.principalId,
      deps.now().toISOString(),
    );
    if (!ended) return { ok: false, reason: 'NOT_A_PARTICIPANT' };

    if (successor !== undefined) {
      /* 'CREATOR' on a group because that is the one word a group's administration is
         spelled with (0023 is emphatic about not adding a second). 'ADMIN' on a channel
         because the successor did not create it, and a room whose history says three
         different people created it is a room whose history is wrong. `isChannelAdminRole`
         accepts both, which is why the predicate exists. */
      await tx.setParticipantRole(
        command.conversationId,
        successor.principalId,
        conversationType === 'INTERNAL_CHANNEL' ? 'ADMIN' : 'CREATOR',
      );
    }

    return successor === undefined ? { ok: true } : { ok: true, creatorPassedTo: successor.principalId };
  });
}

/* ---------------------------------------------------------------------- renaming ---- */

export interface RenameConversationCommand {
  readonly conversationId: UUID;
  readonly title: string;
  readonly renamedBy: UUID;
  readonly correlationId: string;
}

export type RenameConversationFailure =
  | 'CONVERSATION_NOT_FOUND'
  | 'NOT_A_PARTICIPANT'
  | 'NOT_AN_INTERNAL_GROUP'
  | 'TITLE_INVALID';

export type RenameConversationResult =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: RenameConversationFailure };

/**
 * The longest a group name may be.
 *
 * Bounds a column and a sidebar row, not a policy — the same kind of limit as the message
 * body's 10,000. Long enough for a real team name, short enough that the list stays a list.
 */
export const MAX_TITLE_LENGTH = 120;

/**
 * Renames an internal group.
 *
 * ## Groups only, and internal ones
 *
 * A one-to-one is named after the person you are talking to; a title on it would override
 * that with something only one of the two chose, and the other would see their colleague's
 * conversation renamed under them with no way to tell who did it. A CUSTOMER conversation
 * is named by its case and its customer (§21.7) — renaming one would put a staff-chosen
 * label on a record the customer is party to.
 *
 * So this refuses anything that is not `INTERNAL_GROUP`, in the domain rather than in the
 * controller: the controller is one caller, and this is a rule about the operation.
 *
 * ## Any participant may rename
 *
 * An internal group has no owner — §21.4 gives it no lifecycle state at all (BR-23, D-15)
 * — so there is no owner to reserve this for, and inventing a "group admin" would be
 * inventing a role, which is D-11's and HR's. Participation is the authority, which is the
 * same authority that lets somebody add a colleague and expose the entire history to them.
 */
export async function renameConversation(
  command: RenameConversationCommand,
  deps: ConversationDeps,
): Promise<RenameConversationResult> {
  const title = command.title.trim();
  if (title === '' || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: 'TITLE_INVALID' };
  }

  return deps.store.transaction(async (tx) => {
    const type = await tx.loadConversationType(command.conversationId);
    if (type === undefined) return { ok: false, reason: 'CONVERSATION_NOT_FOUND' };
    if (type !== 'INTERNAL_GROUP') return { ok: false, reason: 'NOT_AN_INTERNAL_GROUP' };

    const participants = await tx.listParticipants(command.conversationId);
    if (!participants.some((p) => p.principalId === command.renamedBy)) {
      return { ok: false, reason: 'NOT_A_PARTICIPANT' };
    }

    const updated = await tx.setTitle(command.conversationId, title);
    return updated ? { ok: true, title } : { ok: false, reason: 'CONVERSATION_NOT_FOUND' };
  });
}

export type { Timestamp };
