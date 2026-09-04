/**
 * Persistence ports for conversation operations.
 *
 * As with messaging, the domain states what must happen inside one unit of work and
 * infrastructure supplies the transaction. Keeping it an interface is what lets the
 * rules below — "a customer is never a participant in an internal conversation",
 * "opening a direct message twice returns the same thread" — be tested as rules rather
 * than as SQL.
 */
import type {
  ConversationState,
  ConversationType,
  PrincipalKind,
  SensitivityClass,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';

/** Just enough of a participant to name them in a list. Never contact details. */
export interface ConversationParticipantRef {
  readonly principalId: UUID;
  readonly displayName: string;
  /**
   * Their role in THIS conversation.
   *
   * `CREATOR` marks whoever started it, and in a group that is the only person permitted
   * to remove members (migration 0023). Optional, because a summary produced before this
   * was carried simply has no answer — and an absent role must read as "not the admin"
   * rather than as "unknown, allow it", which is rule 4 applied to a projection.
   */
  readonly role?: string;
}

export interface ConversationSummary {
  readonly conversationId: UUID;
  readonly conversationType: ConversationType;
  readonly title?: string;
  /**
   * Who else is in this conversation, for naming it in a list.
   *
   * ## Why the summary carries names at all
   *
   * An internal conversation has no title unless somebody types one, and for a colleague
   * chat nobody does — so every direct message in the employee's list rendered as
   * "Untitled conversation" and there was no way to tell two of them apart without
   * opening each. `participantCount` was the only thing the summary knew about
   * participants: a number, never a name.
   *
   * ## Populated for INTERNAL types only
   *
   * A customer conversation is named by its case and its customer, not by who is
   * currently assigned to it, so it needs nothing here — and leaving it absent keeps the
   * payload for the customer workspace byte-identical to what it was before this field
   * existed.
   *
   * ## Why this discloses nothing new
   *
   * `listForPrincipal` reaches a row only through an INNER JOIN on the caller's OWN live
   * participation, so anyone who can see this list is already inside the conversation and
   * may already list its members through the participants panel. Optional, because a
   * caller that does not need it should not pay for the join.
   */
  readonly participants?: readonly ConversationParticipantRef[];
  readonly state?: ConversationState;
  readonly sensitivity: SensitivityClass;
  readonly lastActivityAt: Timestamp;
  readonly lastMessagePreview?: string;
  readonly participantCount: number;
  readonly unreadCount: number;
  /**
   * Enough to draw a tick on the list row, without opening the conversation.
   *
   * A row can show delivery state only if it knows three things about the newest message:
   * its sequence, whether the caller wrote it, and how far everybody else has read. The
   * first two are absent when the conversation has no messages yet.
   *
   * `readWatermark` is not optional and is not a count — see `read-receipts.ts`. It is the
   * lowest read marker among the other active participants, so a zero here means somebody
   * has not read, never that nobody has.
   */
  readonly lastMessageSeq?: number;
  readonly lastMessageSenderId?: UUID;
  readonly readWatermark: number;
  /**
   * This reader's own preference for this thread — where it sits in their list.
   *
   * Not optional, and false is a real answer: an absent flag would make "not pinned"
   * indistinguishable from "this query did not ask", and a switch cannot be drawn from that
   * distinction.
   *
   * The design's CONVERSATION section draws a second switch, "Mute notifications", and
   * StarLink does not have one — being told a conversation needs you is not a per-thread
   * preference. See migration 0018.
   */
  readonly pinned: boolean;
  /**
   * When this reader's mute of the thread runs out; absent when it is not muted.
   *
   * Absent rather than a boolean because the UI has to say WHEN — "muted until 15:40" is
   * actionable and "muted" is a state somebody has to remember setting. An expired mute is
   * reported as absent, so no consumer has to know that an old row can still be sitting in
   * the table.
   */
  readonly mutedUntil?: string;
}

export interface NewParticipant {
  readonly principalId: UUID;
  readonly principalKind: PrincipalKind;
  readonly role: string;
  readonly replyAuthority: boolean;
}

export interface NewConversation {
  readonly conversationId: UUID;
  readonly conversationType: ConversationType;
  readonly title?: string;
  readonly createdBy: UUID;
  readonly participants: readonly NewParticipant[];
  /**
   * When participation begins, on the APPLICATION clock — the same one `decide()` uses.
   * Letting the database default this meant the creator of a conversation could be
   * refused their own thread until the app/database clock skew elapsed.
   */
  readonly createdAt: Timestamp;
}

export interface OutboxRow {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: UUID;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
}

export interface ConversationWriteTransaction {
  /**
   * Finds an existing 1:1 between exactly this pair.
   *
   * Opening a direct message twice must return the SAME thread, or a pair of
   * colleagues quietly ends up with two histories and each sees half the conversation.
   */
  findDirectConversation(a: UUID, b: UUID): Promise<UUID | undefined>;
  insertConversation(conversation: NewConversation): Promise<void>;
  listParticipants(conversationId: UUID): Promise<readonly NewParticipant[]>;
  /**
   * Starts participation AT A CALLER-SUPPLIED INSTANT.
   *
   * `at` is not a convenience for tests. Participation is a time period, and `decide()`
   * evaluates whether now falls inside it using the APPLICATION's clock. If the period's
   * start were stamped by the database's `now()` instead — as it was until this was
   * found — the two ends of the same period would come from two different clocks, and
   * `endParticipation` already takes an `at`. On a server whose clock trails the
   * database's, a participant is then denied the conversation they were just added to
   * until the skew elapses: a real 404 for a real person, resolving itself a minute
   * later, and essentially undiagnosable from the logs.
   */
  addParticipant(
    conversationId: UUID,
    participant: NewParticipant,
    addedBy: UUID,
    at: Timestamp,
  ): Promise<void>;
  /** Ends future access. Does NOT delete the row: who could have read what is history (BR-09). */
  endParticipation(conversationId: UUID, principalId: UUID, at: Timestamp): Promise<boolean>;
  loadConversationType(conversationId: UUID): Promise<ConversationType | undefined>;

  /**
   * Turns a one-to-one that has acquired a third person into a group.
   *
   * Narrowed to `INTERNAL_DIRECT` in the statement itself rather than trusted from the
   * caller, so a concurrent add cannot promote something twice and nothing can reach a
   * customer conversation through this door.
   */
  promoteDirectToGroup(conversationId: UUID): Promise<void>;
  /**
   * Sets the conversation's title, returning false when no row matched.
   *
   * Inside the same transaction as the participation check, so a rename cannot commit
   * against a conversation the caller left between the check and the write.
   */
  setTitle(conversationId: UUID, title: string | undefined): Promise<boolean>;
  /** Count of messages already in the thread — what a new participant will be able to read. */
  countMessages(conversationId: UUID): Promise<number>;
  /**
   * Writes a SYSTEM message into the conversation — "Neha added Vikram to the group".
   *
   * ## Why a message and not an event
   *
   * Because it is what happened in the conversation, and the conversation is where people
   * look for what happened. A membership change recorded only in `participants` is invisible
   * to anybody reading the thread: the new person appears mid-conversation with no
   * explanation, and BR-07's whole point is that they can now read everything above.
   *
   * ## In the CALLER's transaction
   *
   * The same unit of work as the participation row, so the two cannot drift. A membership
   * change with no note, or a note with no membership change, are both worse than either
   * failing — and outside the transaction one of them eventually happens.
   *
   * Returns nothing: nobody replies to it, nothing quotes it, and it has no client id.
   */
  appendSystemMessage(conversationId: UUID, body: string, at: Timestamp): Promise<void>;
  appendOutbox(row: OutboxRow): Promise<void>;
}

export interface ConversationStore {
  transaction<T>(work: (tx: ConversationWriteTransaction) => Promise<T>): Promise<T>;
}

/**
 * Keyset position in the conversation list.
 *
 * `lastActivityAt` alone is not unique — two threads can move in the same millisecond —
 * so the conversation id is carried as the tiebreaker. Without it a page boundary
 * landing between two equal timestamps either skips a thread or repeats one.
 */
export interface ConversationCursor {
  readonly lastActivityAt: Timestamp;
  readonly id: UUID;
}

export interface ConversationReader {
  /** The caller's threads, newest activity first. Scoped by participation, not filtered after. */
  listForPrincipal(
    principalId: UUID,
    limit: number,
    before?: ConversationCursor,
    /**
     * Which list. Announcements are conversations and are deliberately not in the chat list
     * — see the implementation for why the split is a WHERE clause and not a client filter.
     */
    scope?: 'CHATS' | 'ANNOUNCEMENTS',
  ): Promise<readonly ConversationSummary[]>;
}

export interface ReadStateStore {
  /**
   * Advances the read marker.
   *
   * Monotonic: a late-arriving request from a slow client must never move the marker
   * backwards and resurrect messages the person has already seen.
   */
  markRead(principalId: UUID, conversationId: UUID, upToSeq: number, at: Timestamp): Promise<number>;

  /**
   * How far every OTHER active participant has read — the lowest of their markers.
   *
   * This is what the second tick is drawn from. It reads the same table `markRead` writes,
   * from the other side: no new state, and a re-fetch reconstructs exactly what the socket
   * frame reported (rule 9).
   *
   * Zero when anybody has never opened the thread, and zero when there is nobody else. See
   * `read-receipts.ts` for why every ambiguous case has to resolve downward.
   */
  readWatermark(conversationId: UUID, excludingPrincipalId: UUID): Promise<number>;
}
