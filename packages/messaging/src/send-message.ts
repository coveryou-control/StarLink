/**
 * The message write path (brief §15, ADR-007).
 *
 * This is the single most important flow in the product, and its ordering is the
 * architecture's central promise:
 *
 *     authenticate → authorize → validate → PERSIST (message + outbox, one txn)
 *     → COMMIT → acknowledge → everything else is best effort
 *
 * Two rules it exists to make structurally true:
 *
 *   * **Persist before publish.** The caller is acknowledged only after commit. If
 *     realtime, notification or indexing fail afterwards, the message still exists
 *     (P-05). Nothing slow or external happens inside the transaction (brief §16).
 *   * **Idempotent.** A retry after a timeout returns the ORIGINAL message rather than
 *     creating a second one. Mobile clients retry constantly; duplicating a customer's
 *     message because of a network hiccup is not acceptable (brief §15, §34.7).
 */
import {
  decide,
  isInternal,
  mentionRecipients,
  validateMentions,
  type ActorContext,
  type Mention,
  type MentionFailure,
} from '@starlink/conversation-domain';
import type {
  Assurance,
  MessageVisibility,
  PrincipalKind,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import type { InsertMessage, MessageRecord, MessageStore } from './ports.js';

export interface SendMessageCommand {
  readonly conversationId: UUID;
  readonly actor: ActorContext;
  readonly senderDisplayName: string;
  readonly body: string;
  /**
   * Explicit, never inferred. If the caller cannot state it, the send fails rather
   * than defaulting to customer-visible (BR-27, FR-MSG-6).
   */
  readonly visibility: MessageVisibility;
  readonly replyToMessageId?: UUID;
  /**
   * The message this one is a threaded reply to, if any.
   *
   * Containment rather than a quote — see `MessageRecord.threadParentId`. Validated below
   * against the SAME conversation and against the root itself being unthreaded: threads are
   * one level deep on purpose.
   */
  readonly threadParentId?: UUID;
  /**
   * A threaded reply the sender also wants in the channel's timeline.
   *
   * The design's "Also send to channel". Ignored without a parent, because there is nothing
   * to send it back FROM.
   */
  readonly alsoSendToChannel?: boolean;
  /** Idempotency key, unique per (sender, conversation). */
  readonly clientMessageId?: string;
  /**
   * Mentions the client says this message contains, as offsets into `body`.
   *
   * Untrusted. `validateMentions` checks every one against the body's length and the
   * conversation's LIVE participants inside the send transaction, so a mention of somebody
   * who was removed while the message was being typed is refused rather than notified.
   */
  readonly mentions?: readonly Mention[];
  /**
   * Whether a file is being sent with this message.
   *
   * A boolean rather than the ids, because binding is the controller's job (§28.1) and
   * nothing in here needs to know WHICH files — only whether "no words" also means
   * "nothing at all". Without it the domain refuses an attachment-only message, which is
   * an ordinary thing to send.
   */
  readonly hasAttachment?: boolean;
  /**
   * Minimum assurance this operation requires of a customer principal.
   *
   * Omitted means `decide()`'s default of VERIFIED_CUSTOMER. The customer surface
   * states ANONYMOUS for ordinary chat, because §21.5 lets someone ask a question
   * before proving who they are and participation is what makes the thread theirs.
   * Anything that reaches policy, claim or payment data must NOT weaken this.
   */
  readonly requiredAssurance?: Assurance;
  readonly correlationId: string;
}

export type SendFailure =
  | 'CONVERSATION_NOT_FOUND'
  | 'NOT_AUTHORIZED'
  | 'EMPTY_BODY'
  | 'BODY_TOO_LONG'
  | 'REPLY_TARGET_NOT_IN_CONVERSATION'
  /** The thread root is missing, in another conversation, or is itself a threaded reply. */
  | 'THREAD_ROOT_INVALID'
  | 'CUSTOMER_CANNOT_SEND_INTERNAL'
  /** Mention validation, from `validateMentions`. See `mentions.ts` for each case. */
  | MentionFailure;

export type SendResult =
  | {
      readonly ok: true;
      readonly message: MessageRecord;
      readonly duplicate: boolean;
      /**
       * Who this message mentioned, `@all` already expanded and the sender removed.
       *
       * Returned so the CALLER can notify, outside the send transaction. Notifying inside
       * it would put a notification failure on the path of a durable message — rule 1 is
       * that a message is durable before it is delivered, and invariant 9 makes the
       * notification the additive part. Absent when nobody was mentioned.
       */
      readonly mentioned?: readonly UUID[];
    }
  /**
   * `NOT_AUTHORIZED` and `CONVERSATION_NOT_FOUND` must render identically to the
   * caller at the HTTP boundary — existence is not disclosed (§27.3). They are
   * distinguished here only for logs and tests.
   */
  | { readonly ok: false; readonly reason: SendFailure };

export interface SendMessageDeps {
  readonly store: MessageStore;
  readonly now: () => Date;
  readonly newId: () => UUID;
  readonly maxBodyLength?: number;
}

const PREVIEW_LENGTH = 140;

export async function sendMessage(
  command: SendMessageCommand,
  deps: SendMessageDeps,
): Promise<SendResult> {
  const body = command.body.trim();
  // Words, or a file, or both — but not neither. See `hasAttachment` on the command.
  if (body.length === 0 && command.hasAttachment !== true) {
    return { ok: false, reason: 'EMPTY_BODY' };
  }
  const maxLength = deps.maxBodyLength ?? 10_000;
  // Bounded server-side; a client-side limit is a courtesy (doc §27.10).
  if (body.length > maxLength) return { ok: false, reason: 'BODY_TOO_LONG' };

  // A customer principal may never author internal content, on any path (ADR-021).
  if (command.actor.kind === 'CUSTOMER' && command.visibility === 'INTERNAL') {
    return { ok: false, reason: 'CUSTOMER_CANNOT_SEND_INTERNAL' };
  }

  return deps.store.transaction(async (tx) => {
    // ONE instant for the whole decision. Reading the clock twice could place the
    // participation check and `decide()` on opposite sides of an expiry boundary.
    const nowIso = deps.now().toISOString();
    const conversation = await tx.loadConversationForUpdate(command.conversationId);
    if (conversation === undefined) return { ok: false, reason: 'CONVERSATION_NOT_FOUND' };

    const participant = await tx.loadParticipant(command.conversationId, command.actor.principalId);

    // The object check (§18.4 step 3): the conversation is loaded and authorized
    // together, never authorized against an id supplied by the caller.
    //
    // Which permission a send requires depends on WHO is on the other end. In an
    // internal thread there is no customer, so sending is ordinary participation. In a
    // customer conversation, addressing the customer is an exercise of ownership while
    // an internal note is not (P-03, D-04a).
    const action =
      conversation.conversationType === 'INTERNAL_ANNOUNCEMENT'
        ? /*
             An announcement is internal, and posting to one is still not ordinary
             participation. Everybody in the company is a participant of it, so
             `conversation.message.send` — which participation grants — would hand the whole
             company a broadcast. The distinct action is the whole difference between an
             announcement and a group, and it is chosen HERE, on the loaded conversation's
             own type, rather than by anything the caller sent.
          */
          'conversation.announcement.post'
        : isInternal(conversation.conversationType)
          ? 'conversation.message.send'
          : command.visibility === 'INTERNAL'
            ? 'conversation.note.internal'
            : 'conversation.reply.customer';

    const decision = decide({
      actor: command.actor,
      action,
      resource: {
        conversationId: conversation.conversationId,
        conversationType: conversation.conversationType,
        ...(conversation.caseId !== undefined ? { caseId: conversation.caseId } : {}),
        ...(conversation.owningTeamId !== undefined ? { owningTeamId: conversation.owningTeamId } : {}),
        ...(conversation.owningDepartment !== undefined
          ? { owningDepartment: conversation.owningDepartment }
          : {}),
        ...(conversation.currentOwnerId !== undefined ? { currentOwnerId: conversation.currentOwnerId } : {}),
        ...(conversation.customerRef !== undefined ? { customerRef: conversation.customerRef } : {}),
        sensitivity: conversation.sensitivity,
        ...(participant !== undefined ? { participant } : {}),
        /**
         * A customer may only ever write into their OWN conversation.
         *
         * This used to read `conversation.customerRef !== undefined`, which asks a
         * different question: "does this conversation have *a* customer reference?" —
         * true of every customer conversation in the system. Any customer principal
         * could therefore write into any other customer's thread. It was latent only
         * because no customer surface existed to exercise it, and the fuzzed projection
         * tests could not see it: the leak was in the write path, not the serialiser.
         *
         * Ownership is now LIVE PARTICIPATION — a fact we recorded when the conversation
         * was created — rather than a customer reference, which is a claim we later
         * believed. That distinction is also what keeps a verified session from
         * inheriting conversations an unverified one merely attributed to the same
         * customer (see D-30).
         *
         * The key is omitted entirely for employees rather than set to undefined:
         * absent must mean absent, and `exactOptionalPropertyTypes` holds us to it.
         */
        ...(command.actor.kind === 'CUSTOMER'
          ? {
              belongsToActorCustomer:
                participant !== undefined &&
                participant.effectiveFrom <= nowIso &&
                (participant.effectiveTo === undefined || participant.effectiveTo > nowIso),
            }
          : {}),
      },
      now: nowIso,
      targetVisibility: command.visibility,
      /**
       * The assurance this operation requires, declared by the CALLER (§18.4).
       *
       * `decide()` defaults to VERIFIED_CUSTOMER, which is right for anything reaching
       * policy, claim or payment data. It is wrong for writing into a thread you
       * started anonymously: §21.5 allows a customer to ask a question before proving
       * who they are, and participation — not assurance — is what makes the thread
       * theirs. So the customer surface passes ANONYMOUS explicitly rather than
       * inheriting a default written for a different kind of operation.
       */
      ...(command.requiredAssurance !== undefined
        ? { requiredAssurance: command.requiredAssurance }
        : {}),
    });

    if (!decision.allow) return { ok: false, reason: 'NOT_AUTHORIZED' };

    // Idempotency BEFORE insert: a retry must return the original, not race it.
    if (command.clientMessageId !== undefined) {
      const existing = await tx.findByClientMessageId(
        command.conversationId,
        command.actor.principalId,
        command.clientMessageId,
      );
      if (existing !== undefined) return { ok: true, message: existing, duplicate: true };
    }

    if (command.replyToMessageId !== undefined) {
      // FR-MSG-7: a reply references another message in the SAME conversation only.
      // Without this, a reply could point at a thread the sender cannot read, and the
      // quoted context would travel with it.
      const target = await tx.findMessageInConversation(command.conversationId, command.replyToMessageId);
      if (target === undefined) return { ok: false, reason: 'REPLY_TARGET_NOT_IN_CONVERSATION' };
      // A customer-visible reply must not quote an internal note back to the customer.
      if (target.visibility === 'INTERNAL' && command.visibility === 'CUSTOMER_VISIBLE') {
        return { ok: false, reason: 'REPLY_TARGET_NOT_IN_CONVERSATION' };
      }
    }

    /**
     * The thread's root, checked the same way and for a second reason.
     *
     * Same conversation, for the reason a quote target is: a reply must not point at a
     * thread the sender cannot read. And the root must not itself be threaded — a thread of
     * threads is a tree, and a tree is not readable on a phone. One level is the rule every
     * product that tried the alternative has ended up back at.
     *
     * A CUSTOMER-visible reply inside an INTERNAL root is refused for the same reason a
     * quote of one is: the thread's context travels with the reply, and rule 5 is that a
     * customer can never see an internal note.
     */
    if (command.threadParentId !== undefined) {
      const root = await tx.findMessageInConversation(command.conversationId, command.threadParentId);
      if (root === undefined) return { ok: false, reason: 'THREAD_ROOT_INVALID' };
      if (root.threadParentId !== undefined) return { ok: false, reason: 'THREAD_ROOT_INVALID' };
      if (root.visibility === 'INTERNAL' && command.visibility === 'CUSTOMER_VISIBLE') {
        return { ok: false, reason: 'THREAD_ROOT_INVALID' };
      }
    }

    /**
     * Mentions, checked against the conversation as it is RIGHT NOW.
     *
     * Inside the transaction and after the participant load, so the set a mention is
     * validated against is the same set the message is being written to. A colleague
     * removed between composing and sending is refused here rather than being sent a
     * notification pointing at a thread `decide()` will then deny them.
     *
     * `@all` is permitted only in an internal GROUP: on a one-to-one it means the one
     * person already reading the message, and on a customer conversation the participant
     * set includes somebody outside the company — "notify everyone" must never quietly
     * mean that.
     */
    const liveParticipants = await tx.listParticipantIds(command.conversationId);
    const mentionCheck = validateMentions(
      command.mentions ?? [],
      body,
      new Set(liveParticipants),
      conversation.conversationType === 'INTERNAL_GROUP',
    );
    if (!mentionCheck.ok) return { ok: false, reason: mentionCheck.reason };
    const mentions = mentionCheck.mentions;

    const seq = await tx.nextSequence(command.conversationId);
    const insert: InsertMessage & { seq: number } = {
      messageId: deps.newId(),
      conversationId: command.conversationId,
      seq,
      visibility: command.visibility,
      senderPrincipalId: command.actor.principalId,
      senderKind: command.actor.kind as PrincipalKind,
      // Frozen at send time: a message keeps the name in force when it was sent, so a
      // later rename never rewrites history (doc §24.9).
      senderDisplayName: command.senderDisplayName,
      body,
      ...(command.replyToMessageId !== undefined ? { replyToMessageId: command.replyToMessageId } : {}),
      ...(command.threadParentId !== undefined
        ? {
            threadParentId: command.threadParentId,
            /* Only ever true alongside a parent — the store re-checks the same pairing,
               because a flag without a parent would put an ordinary message into the
               timeline predicate twice. */
            ...(command.alsoSendToChannel === true ? { alsoSendToChannel: true } : {}),
          }
        : {}),
      ...(command.clientMessageId !== undefined ? { clientMessageId: command.clientMessageId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    };

    const message = await tx.insertMessage(insert);

    // Same transaction. A committed message whose event never existed is the drift
    // the outbox pattern is here to make impossible (brief §17).
    await tx.appendOutbox({
      eventName: 'message.created.v1',
      eventVersion: 1,
      aggregateType: 'conversation',
      aggregateId: command.conversationId,
      payload: {
        messageId: message.messageId,
        conversationId: command.conversationId,
        seq: message.seq,
        senderKind: message.senderKind,
        visibility: message.visibility,
        channel: 'INTERNAL',
        hasAttachments: false,
      },
      correlationId: command.correlationId,
    });

    /**
     * A separate event for the mention, in the same transaction as the message.
     *
     * NOT folded into `message.created.v1`. §29.2's `NEVER_NOTIFIED` contains
     * `MESSAGE_IN_INTERNAL_GROUP` — a message in a group notifies nobody, and that
     * prohibition is deliberately still true. What is being added is a DIFFERENT event:
     * §29.2's governing sentence is "Notify only what someone must act on", and a message
     * that names you is the case it describes. Naming it separately is what keeps the two
     * distinguishable, so the prohibition on the first is not quietly relaxed by the
     * second.
     *
     * The recipients are resolved here rather than by the notifier because this is where
     * the live participant set already is; `@all` becomes an explicit list, so nothing
     * downstream has to re-derive who "everyone" was at send time.
     */
    const notify = mentionRecipients(mentions, liveParticipants, command.actor.principalId);
    if (notify.length > 0) {
      await tx.appendOutbox({
        eventName: 'message.mentioned.v1',
        eventVersion: 1,
        aggregateType: 'conversation',
        aggregateId: command.conversationId,
        payload: {
          messageId: message.messageId,
          conversationId: command.conversationId,
          seq: message.seq,
          mentionedPrincipalIds: notify,
          // Whether the sender used @all, so the notification can say so. Derived here
          // rather than inferred downstream from the recipient count, which would call a
          // two-person group's individual mention an @all.
          mentionedAll: mentions.some((mention) => mention.kind === 'ALL'),
        },
        correlationId: command.correlationId,
      });
    }

    /**
     * §21.4's `assigned → active` — the arrival half of the lifecycle joining the
     * resolution half.
     *
     * Only the OWNER's own CUSTOMER_VISIBLE reply does it: §21.4 names the owner, and an
     * internal note is not a reply to anybody. A colleague adding context, or the
     * customer writing again, leaves the state alone.
     *
     * Inside the send transaction, so a message that committed without its state change
     * is impossible — that combination is what left conversations stuck ASSIGNED with no
     * route to RESOLVED, because §21.4 has no `assigned → resolved` row.
     */
    if (
      command.visibility === 'CUSTOMER_VISIBLE' &&
      conversation.currentOwnerId !== undefined &&
      conversation.currentOwnerId === command.actor.principalId
    ) {
      await tx.activateOnOwnerReply({
        conversationId: command.conversationId,
        ownerId: command.actor.principalId,
        at: message.createdAt,
      });
    }

    /**
     * The preview is denormalised onto the conversation, and rule 5 governs it: an
     * internal note must never reach a customer surface, so on a customer conversation a
     * note writes a neutral marker instead of its text.
     *
     * An INTERNAL CONVERSATION is a different case, and treating the two alike had a
     * cost. Every message in a colleague thread is `INTERNAL` by construction, so the
     * condition matched all of them and an internal thread's preview was permanently
     * empty — which is why every row in the Stage 1 sidebar showed a name and nothing
     * else. There is no customer in an internal conversation and no customer surface that
     * renders it, so there is nothing for the marker to protect.
     *
     * `isInternal` is an allowlist of known INTERNAL types, so this stays fail-closed: an
     * unrecognised or malformed type is not internal, and the note writes the marker.
     */
    const previewIsSafeToStore =
      message.visibility !== 'INTERNAL' || isInternal(conversation.conversationType);

    await tx.touchConversation(
      command.conversationId,
      message.createdAt,
      previewIsSafeToStore ? body.slice(0, PREVIEW_LENGTH) : '',
    );

    return { ok: true, message, duplicate: false, ...(notify.length > 0 ? { mentioned: notify } : {}) };
  });
}

export const previewOf = (body: string): string => body.slice(0, PREVIEW_LENGTH);
export type { Timestamp };
