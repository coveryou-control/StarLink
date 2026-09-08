import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * Starred messages — one person's private bookmarks.
 *
 * ## Private by construction
 *
 * The key is `(message_id, principal_id)`, so a star belongs to the reader rather than to
 * the message. Nobody else can see it, no count is exposed, and two people starring the
 * same message are two independent facts. That is the difference between this and a
 * reaction, which is a public mark and is deliberately counted.
 *
 * ## Idempotent
 *
 * Starring twice is one row and not an error; un-starring something never starred is a
 * no-op. The caller uses the returned boolean to decide whether anything changed, not
 * whether to report a failure.
 */
export interface StarredMessageRow {
  readonly messageId: UUID;
  readonly conversationId: UUID;
  readonly body: string;
  readonly senderPrincipalId: UUID;
  readonly sentAt: string;
  readonly senderDisplayName: string;
  readonly starredAt: string;
}

export class PgStarStore {
  constructor(private readonly pool: pg.Pool) {}

  async add(messageId: UUID, principalId: UUID): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.message_stars (message_id, principal_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [messageId, principalId],
    );
    return result.rows.length > 0;
  }

  async remove(messageId: UUID, principalId: UUID): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM conversation.message_stars
        WHERE message_id = $1 AND principal_id = $2
        RETURNING message_id`,
      [messageId, principalId],
    );
    return result.rows.length > 0;
  }

  /**
   * Which of these messages the reader has starred.
   *
   * One query for the page rather than one per message, for the same reason reactions are
   * fetched that way: a fifty-message page would otherwise be fifty round trips to render
   * a bookmark.
   */
  async minedOn(messageIds: readonly UUID[], principalId: UUID): Promise<ReadonlySet<UUID>> {
    if (messageIds.length === 0) return new Set();
    const result = await this.pool.query(
      `SELECT message_id
         FROM conversation.message_stars
        WHERE principal_id = $1 AND message_id = ANY($2::uuid[])`,
      [principalId, messageIds],
    );
    return new Set(result.rows.map((row) => row.message_id as UUID));
  }

  /**
   * Everything this reader has starred, newest bookmark first.
   *
   * ## Why the participation join is not optional
   *
   * A star is a pointer into a conversation, and read access is a property of the
   * CONVERSATION, not of the bookmark. Someone removed from a thread keeps rows here — the
   * star was a fact when they made it — so without the join this query would hand back
   * messages they may no longer read. Rule 2 says authorization is evaluated before content
   * is read on every path, and a list view is a path.
   *
   * Deleted-for-me messages are excluded for the same reason: the reader has already said
   * they do not want to see them.
   */
  async listFor(principalId: UUID, limit: number): Promise<readonly StarredMessageRow[]> {
    const result = await this.pool.query(
      `SELECT m.message_id,
              m.conversation_id,
              m.body,
              m.sender_principal_id,
              m.created_at,
              m.sender_display_name,
              s.created_at AS starred_at
         FROM conversation.message_stars s
         JOIN conversation.messages m ON m.message_id = s.message_id
         JOIN conversation.participants p
           ON p.conversation_id = m.conversation_id
          AND p.principal_id = s.principal_id
          AND p.effective_to IS NULL
    LEFT JOIN conversation.hidden_messages h
           ON h.message_id = m.message_id
          AND h.principal_id = s.principal_id
        WHERE s.principal_id = $1
          AND h.message_id IS NULL
          AND m.redacted_at IS NULL
     ORDER BY s.created_at DESC
        LIMIT $2`,
      [principalId, limit],
    );
    return result.rows.map((row) => ({
      messageId: row.message_id as UUID,
      conversationId: row.conversation_id as UUID,
      body: row.body as string,
      senderPrincipalId: row.sender_principal_id as UUID,
      sentAt: (row.created_at as Date).toISOString(),
      senderDisplayName: row.sender_display_name as string,
      starredAt: (row.starred_at as Date).toISOString(),
    }));
  }

  /**
   * The conversation a message belongs to.
   *
   * Starring is authorized against the CONVERSATION, so the route has to resolve the
   * message to its thread before it can ask `decide()` anything. `undefined` for an unknown
   * message lets the route refuse without disclosing whether the id exists (§27.3).
   */
  async conversationOf(messageId: UUID): Promise<UUID | undefined> {
    const result = await this.pool.query(
      'SELECT conversation_id FROM conversation.messages WHERE message_id = $1',
      [messageId],
    );
    return result.rows[0]?.conversation_id as UUID | undefined;
  }
}

/**
 * Archiving a conversation, per person.
 *
 * ## Not leaving, and not hiding it from anyone else
 *
 * `archived_at` lives on PARTICIPATION, so two colleagues in one thread can disagree about
 * whether it is on their list. Participation itself is untouched: the thread stays readable,
 * authorization is unchanged, and the archive is a view filter rather than a permission.
 *
 * A timestamp rather than a boolean, for the same reason `effective_to` is one — "when" is
 * strictly more information than "whether" and costs the same to store.
 */
export class PgArchiveStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Archives or restores, and reports whether anything moved.
   *
   * The `IS DISTINCT FROM` guard is what makes the boolean meaningful: without it,
   * archiving something already archived would rewrite the timestamp and report a change,
   * so a double tap would look like an action and move the row's date.
   */
  async set(conversationId: UUID, principalId: UUID, archived: boolean, at: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE conversation.participants
          SET archived_at = $3
        WHERE conversation_id = $1
          AND principal_id = $2
          AND effective_to IS NULL
          AND (archived_at IS NULL) = $4
        RETURNING conversation_id`,
      [conversationId, principalId, archived ? at : null, archived],
    );
    return result.rows.length > 0;
  }

  /** The conversations this reader has archived. */
  async archivedIds(principalId: UUID): Promise<ReadonlySet<UUID>> {
    const result = await this.pool.query(
      `SELECT conversation_id
         FROM conversation.participants
        WHERE principal_id = $1 AND effective_to IS NULL AND archived_at IS NOT NULL`,
      [principalId],
    );
    return new Set(result.rows.map((row) => row.conversation_id as UUID));
  }
}
