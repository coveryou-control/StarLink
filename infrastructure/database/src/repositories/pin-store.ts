import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * Messages held at the top of a conversation, for everybody in it.
 *
 * ## Not the same thing as a pinned conversation
 *
 * `conversation_preferences.pinned` sorts a CONVERSATION to the top of one person's list
 * and tells nobody anything. This is the other kind: a message every participant sees held
 * above the thread — the address, the decision, the link people keep scrolling back for.
 * Sharing the word "pin" is unfortunate and is what the two tables' names are for.
 *
 * ## What is deliberately absent
 *
 * No unpin timestamp and no tombstone. The audit ledger is the append-only record (rule 8)
 * and already carries the act; keeping dead rows here would make every read filter them
 * out forever to answer a question nobody asks of this table. What is pinned right now is
 * the whole of its job.
 */
export interface PinnedMessageRow {
  readonly messageId: UUID;
  readonly pinnedBy: UUID;
  readonly pinnedByName: string;
  readonly pinnedAt: string;
  /** The pinned message's text, or empty when it has been redacted since. */
  readonly body: string;
  readonly senderPrincipalId: UUID | undefined;
  readonly senderDisplayName: string | undefined;
  /** True when the message has been deleted since it was pinned — see `list`. */
  readonly redacted: boolean;
}

export class PgPinStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Pins a message. Returns whether a row was actually written.
   *
   * `false` means "already pinned", not "failed" — pinning twice is not an error, and two
   * people pinning the same message in the same second must not produce a 500. The first
   * pin keeps its attribution: `DO NOTHING` rather than `DO UPDATE`, because "who pinned
   * this" should be whoever did it first, not whoever pressed it last.
   *
   * `pinnedAt` is supplied by the caller from the application clock, never `now()`. See
   * CLAUDE.md on clocks — every effective instant in this schema comes from the same one.
   */
  async pin(
    conversationId: UUID,
    messageId: UUID,
    pinnedBy: UUID,
    pinnedAt: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.pinned_messages
         (conversation_id, message_id, pinned_by, pinned_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [conversationId, messageId, pinnedBy, pinnedAt],
    );
    return result.rows.length > 0;
  }

  /** Unpins. `false` means it was not pinned, which is not an error either. */
  async unpin(conversationId: UUID, messageId: UUID): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM conversation.pinned_messages
        WHERE conversation_id = $1 AND message_id = $2
       RETURNING message_id`,
      [conversationId, messageId],
    );
    return result.rows.length > 0;
  }

  /**
   * What is pinned here, newest first.
   *
   * ## A redacted pin is reported, not hidden
   *
   * If somebody deletes a message the group had pinned, the pin stays and comes back with
   * `redacted: true` and an empty body. Dropping it silently would make the pin disappear
   * with no explanation, and the group would be left wondering whether they had imagined
   * pinning it. An empty pin saying "this message was deleted" is the honest rendering,
   * and it gives somebody a reason to unpin it.
   *
   * The body is joined here rather than resolved by the caller because a pin is useless
   * without its text — every caller would immediately make the same second query.
   */
  async list(conversationId: UUID): Promise<readonly PinnedMessageRow[]> {
    const result = await this.pool.query(
      `SELECT pm.message_id,
              pm.pinned_by,
              pinner.display_name AS pinned_by_name,
              pm.pinned_at,
              m.body,
              m.redacted_at,
              m.sender_principal_id,
              sender.display_name AS sender_display_name
         FROM conversation.pinned_messages pm
         JOIN conversation.messages m ON m.message_id = pm.message_id
         JOIN identity.principals pinner ON pinner.principal_id = pm.pinned_by
         LEFT JOIN identity.principals sender
           ON sender.principal_id = m.sender_principal_id
        WHERE pm.conversation_id = $1
        ORDER BY pm.pinned_at DESC`,
      [conversationId],
    );

    return result.rows.map((row) => ({
      messageId: row.message_id as UUID,
      pinnedBy: row.pinned_by as UUID,
      pinnedByName: row.pinned_by_name as string,
      pinnedAt: (row.pinned_at as Date).toISOString(),
      /* Emptied here rather than trusted from the column: redaction clears the body on the
         way in, and belt-and-braces costs one comparison on a list that is never long. */
      body: row.redacted_at === null ? ((row.body as string) ?? '') : '',
      senderPrincipalId: (row.sender_principal_id as UUID | null) ?? undefined,
      senderDisplayName: (row.sender_display_name as string | null) ?? undefined,
      redacted: row.redacted_at !== null,
    }));
  }

  /**
   * Which conversation a message belongs to, or `undefined`.
   *
   * The same guard the reaction store needs and for the same reason: without it a caller
   * could authorize against a conversation they are in and then pin a message belonging to
   * one they are not. "No such message" and "not in your conversation" return the same
   * answer, so the caller cannot tell them apart (§27.3).
   */
  async conversationOf(messageId: UUID): Promise<UUID | undefined> {
    const result = await this.pool.query(
      `SELECT conversation_id FROM conversation.messages WHERE message_id = $1`,
      [messageId],
    );
    return (result.rows[0]?.conversation_id as UUID | undefined) ?? undefined;
  }
}

/**
 * Who has read one message, for the "Message info" panel.
 *
 * ## Why this is its own query and not part of the message projection
 *
 * It is a join against every participant, once per message. On a page of fifty messages
 * that is fifty of them, to answer a question somebody asks about one message occasionally.
 * The list already carries the single fact it needs for its tick — the minimum read marker
 * across the others (see `read-receipts.ts`) — and this is the expanded version, loaded
 * only when a panel asks.
 *
 * ## Read means "has read PAST this message"
 *
 * `last_read_seq >= the message's seq`, not equality: read markers advance in jumps, and
 * somebody who opened the thread after twenty more messages arrived has read this one.
 *
 * The sender is excluded. "You have read your own message" is not information, and
 * including it would make a one-to-one report 1 of 2 read when the other person had not
 * opened it — a number that looks like progress and is not.
 */
export interface MessageReaderRow {
  readonly principalId: UUID;
  readonly displayName: string;
  /** When they last advanced their marker; absent when they have never read the thread. */
  readonly readAt: string | undefined;
  readonly hasRead: boolean;
}

export class PgMessageInfoStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The text and visibility of a message, for forwarding it on.
   *
   * ## Why the visibility comes back with the body
   *
   * Because the caller must not choose it. An internal note forwarded as a customer-
   * visible message is rule 5 broken permanently — a customer reading a colleague's
   * private assessment of them cannot be undone by deleting it afterwards. Returning the
   * two together means a caller cannot forward the text while forgetting what it was.
   *
   * A redacted message comes back with an empty body, and the caller refuses on that:
   * forwarding a deleted message would put a blank bubble in another conversation over
   * somebody's name.
   */
  async forwardable(
    conversationId: UUID,
    messageId: UUID,
  ): Promise<{ readonly body: string; readonly visibility: string } | undefined> {
    const result = await this.pool.query(
      `SELECT body, visibility, redacted_at
         FROM conversation.messages
        WHERE message_id = $1 AND conversation_id = $2`,
      [messageId, conversationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      body: row.redacted_at === null ? ((row.body as string) ?? '') : '',
      visibility: row.visibility as string,
    };
  }

  async readers(
    conversationId: UUID,
    messageId: UUID,
  ): Promise<
    | {
        readonly deliveredAt: string;
        readonly senderPrincipalId: UUID | undefined;
        readonly readers: readonly MessageReaderRow[];
      }
    | undefined
  > {
    const message = await this.pool.query(
      `SELECT seq, created_at, sender_principal_id
         FROM conversation.messages
        WHERE message_id = $1 AND conversation_id = $2`,
      [messageId, conversationId],
    );
    const row = message.rows[0];
    if (row === undefined) return undefined;

    /*
       Three parameters, not four.

       `messageId` is deliberately absent: the message has already been resolved to its
       sequence above, and this query is about the PARTICIPANTS. Passing it anyway is not
       harmless — pg refuses a bind with more parameters than the statement uses
       ("bind message supplies 4 parameters, but prepared statement requires 3"), and the
       route answers 500.

       Both remaining parameters are cast explicitly. `$3` is compared against a bigint
       column and `$2` can legitimately be NULL for a system message, and Postgres cannot
       infer the type of a NULL parameter on its own.
    */
    const readers = await this.pool.query(
      `SELECT p.principal_id,
              ip.display_name,
              rs.last_read_at,
              COALESCE(rs.last_read_seq, 0) >= $3::bigint AS has_read
         FROM conversation.participants p
         JOIN identity.principals ip ON ip.principal_id = p.principal_id
         /* LEFT, so somebody who has never opened the thread is reported as unread rather
            than omitted. An inner join would compute "everybody has read it" over only the
            people who have read something, which is the over-claim the tick rules exist to
            prevent. */
         LEFT JOIN conversation.read_state rs
           ON rs.conversation_id = p.conversation_id AND rs.principal_id = p.principal_id
        WHERE p.conversation_id = $1
          AND p.effective_to IS NULL
          AND p.principal_id IS DISTINCT FROM $2::uuid
        ORDER BY ip.display_name`,
      [conversationId, row.sender_principal_id, Number(row.seq)],
    );

    return {
      deliveredAt: (row.created_at as Date).toISOString(),
      senderPrincipalId: (row.sender_principal_id as UUID | null) ?? undefined,
      readers: readers.rows.map((reader) => ({
        principalId: reader.principal_id as UUID,
        displayName: reader.display_name as string,
        /* Only meaningful when they HAVE read past this message: `last_read_at` is the
           instant of their most recent marker, which for somebody still behind this
           message is a time before they got to it. Reporting it beside "not read" would
           read as a contradiction. */
        readAt:
          reader.has_read === true && reader.last_read_at !== null
            ? (reader.last_read_at as Date).toISOString()
            : undefined,
        hasRead: reader.has_read === true,
      })),
    };
  }
}
