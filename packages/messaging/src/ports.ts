/**
 * Persistence ports for the message write path.
 *
 * The domain describes what must happen inside one transaction; `apps/api` supplies a
 * PostgreSQL implementation. Keeping this an interface is what lets the write path be
 * unit-tested for its INVARIANTS — persist-before-publish, idempotency, visibility —
 * without a database, while the same contract is exercised against real PostgreSQL in
 * integration tests.
 */
import type { Mention } from '@starlink/conversation-domain';
import type {
  ConversationType,
  MessageVisibility,
  PrincipalKind,
  SensitivityClass,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';

export interface ConversationRecord {
  readonly conversationId: UUID;
  readonly conversationType: ConversationType;
  /**
   * §21.4's lifecycle state. Absent for an internal thread, which has none at all
   * (BR-23, D-15) — so this is optional rather than defaulted, and a caller that needs
   * it must handle the absence rather than reading a stand-in.
   */
  readonly state?: string;
  readonly caseId?: UUID;
  readonly sensitivity: SensitivityClass;
  readonly lastSeq: number;
  readonly owningTeamId?: string;
  readonly owningDepartment?: string;
  readonly currentOwnerId?: UUID;
  readonly customerRef?: string;
}

export interface ParticipantRecord {
  readonly principalId: UUID;
  readonly principalKind: PrincipalKind;
  readonly role: string;
  readonly replyAuthority: boolean;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
}

export interface MessageRecord {
  readonly messageId: UUID;
  readonly conversationId: UUID;
  readonly seq: number;
  readonly visibility: MessageVisibility;
  readonly senderPrincipalId?: UUID;
  readonly senderKind: PrincipalKind;
  readonly senderDisplayName: string;
  readonly body: string;
  readonly replyToMessageId?: UUID;
  readonly createdAt: Timestamp;
  /**
   * The sender's own id for this message, echoed back.
   *
   * Stored since the foundation migration for idempotent retries and never returned. The
   * reader needs it for a different reason: a client that appended an optimistic row has
   * no other way to recognise its own message when the real one arrives, so for the window
   * between the realtime event and the send response it renders BOTH.
   */
  readonly clientMessageId?: string;
  readonly mentions?: readonly Mention[];
  /**
   * The message this one is a threaded reply to.
   *
   * Different from `replyToMessageId`, and the difference is where the message LIVES.
   * A quote is context — the message stays in the channel's timeline and renders with the
   * text it is answering. A thread is containment — the message is out of the timeline and
   * inside the root's own conversation, which is the point of threading a side discussion
   * out of a busy channel.
   */
  /**
   * What KIND of message this is, when it is not an ordinary one.
   *
   * Absent means 'TEXT'. `MEMBERSHIP` is a system note — "Neha added Vikram to the group" —
   * written by the participation change itself and rendered as a centred caption rather than
   * a bubble, because nobody said it.
   */
  readonly messageClass?: string;
  /** When the body was last corrected. Absent means never. */
  readonly editedAt?: Timestamp;
  /** When the message was deleted. Absent means it was not. The row always survives. */
  readonly redactedAt?: Timestamp;
}

/** One entry in a message's history. The kinds are the migration's CHECK constraint. */
export interface MessageRevision {
  readonly revisionId: UUID;
  readonly messageId: UUID;
  readonly kind: 'CORRECTION' | 'REDACTION' | 'TOMBSTONE';
  /** What the body said before. Kept so "what was here" stays answerable (§24.9). */
  readonly previousBody: string;
  readonly actorId: UUID;
}

export interface OutboxRow {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: UUID;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
}

export interface InsertMessage {
  readonly messageId: UUID;
  readonly conversationId: UUID;
  readonly visibility: MessageVisibility;
  readonly senderPrincipalId?: UUID;
  readonly senderKind: PrincipalKind;
  readonly senderDisplayName: string;
  readonly body: string;
  readonly replyToMessageId?: UUID;
  readonly clientMessageId?: string;
  /**
   * Structured mentions, already validated against the conversation's participants.
   *
   * Written in the same statement as the body because a mention is part of what the
   * message SAYS — a second write could fail after the message committed, which is exactly
   * the drift §17 exists to prevent.
   */
  readonly mentions?: readonly Mention[];
}

/**
 * The unit of work for a single message send.
 *
 * Everything on this interface happens inside ONE database transaction. Nothing that
 * can be slow or fail externally belongs here — a provider call inside the transaction
 * is the mistake brief §16 names explicitly.
 */
export interface MessageWriteTransaction {
  loadConversationForUpdate(conversationId: UUID): Promise<ConversationRecord | undefined>;
  loadParticipant(conversationId: UUID, principalId: UUID): Promise<ParticipantRecord | undefined>;
  /** Returns an existing message when this idempotency key has already been used. */
  findByClientMessageId(
    conversationId: UUID,
    senderPrincipalId: UUID,
    clientMessageId: string,
  ): Promise<MessageRecord | undefined>;
  /**
   * Looks a message up WITHIN a conversation.
   *
   * Scoped by conversation deliberately: FR-MSG-7 allows a reply to reference another
   * message in the same conversation only, and a lookup by bare id would make that a
   * check someone could forget rather than one the query shape enforces.
   */
  findMessageInConversation(conversationId: UUID, messageId: UUID): Promise<MessageRecord | undefined>;
  /** Allocates the next per-conversation sequence. Monotonic, gap-free within a thread. */
  nextSequence(conversationId: UUID): Promise<number>;
  insertMessage(message: InsertMessage & { seq: number }): Promise<MessageRecord>;
  /** Written in the SAME transaction as the message; this is what forbids drift. */
  appendOutbox(row: OutboxRow): Promise<void>;
  touchConversation(conversationId: UUID, lastActivityAt: Timestamp, preview: string): Promise<void>;
  /**
   * The LIVE participants of this conversation, ids only.
   *
   * Used to validate mentions and to resolve `@all`. Ids rather than records because that
   * is all either needs, and the set is read on every send in a group.
   */
  listParticipantIds(conversationId: UUID): Promise<readonly UUID[]>;
  /**
   * Loads a message for correction or deletion, locked.
   *
   * `FOR UPDATE`, because the revision records what the body said BEFORE — and two
   * concurrent edits without the lock would each record the other's text as the previous
   * one, leaving a history describing a sequence that never happened.
   *
   * Scoped by conversation for the same reason `findMessageInConversation` is: a bare
   * lookup by id would make "the message is in the thread you authorized against" a check
   * somebody could forget rather than one the query shape enforces.
   */
  loadMessageForRevision(
    conversationId: UUID,
    messageId: UUID,
  ): Promise<MessageRecord | undefined>;
  insertRevision(revision: MessageRevision): Promise<void>;
  applyCorrection(messageId: UUID, body: string, at: Timestamp): Promise<MessageRecord>;
  applyRedaction(messageId: UUID, at: Timestamp): Promise<MessageRecord>;
  /**
   * Recomputes `last_message_preview` from the newest message that still has text.
   *
   * Needed because the preview is denormalised onto the conversation, so deleting the most
   * recent message leaves its words on every conversation list that shows the thread —
   * which defeats the deletion in the one place a colleague is most likely to see it.
   */
  refreshPreview(conversationId: UUID): Promise<void>;
  /**
   * §21.4's `assigned → active`: "Owner | Yes (the reply itself) | No".
   *
   * The owner's first customer-visible reply is what makes a conversation ACTIVE, and it
   * is the ONLY route there on the way in. Without it a conversation assigned to an agent
   * stayed ASSIGNED for ever — and §21.4 permits no `assigned → resolved` row, so the
   * agent could never finish it either.
   *
   * Deliberately conditional inside the implementation rather than here: the caller says
   * "a reply happened", the store decides whether that is a state change. Returns whether
   * it moved, which is `false` on every reply after the first — a normal answer.
   *
   * Not separately audited. §21.4's "Audited" column says No for this row, because the
   * message IS the record (P-06).
   */
  activateOnOwnerReply(input: {
    conversationId: UUID;
    ownerId: UUID;
    at: Timestamp;
  }): Promise<boolean>;
}

export interface MessageStore {
  /** Runs `work` in a transaction, committing on success and rolling back on throw. */
  transaction<T>(work: (tx: MessageWriteTransaction) => Promise<T>): Promise<T>;
}

export interface MessagePage {
  readonly messages: readonly MessageRecord[];
  readonly nextCursor?: string;
}

export interface MessageReader {
  /**
   * Reads one page.
   *
   * `visibility` is a REQUIRED argument, not an option: a customer-facing read that
   * forgets to filter is the worst leak in the product, so the signature does not
   * permit forgetting (ADR-021).
   */
  readPage(query: {
    readonly conversationId: UUID;
    readonly visibility: readonly MessageVisibility[];
    readonly limit: number;
    readonly before?: { readonly createdAt: Timestamp; readonly id: UUID };
  }): Promise<readonly MessageRecord[]>;
}
