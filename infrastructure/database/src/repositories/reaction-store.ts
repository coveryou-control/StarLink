import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * Reactions on messages.
 *
 * ## Idempotent by construction
 *
 * The table's primary key is `(message_id, principal_id, emoji)`, so adding a reaction is
 * an upsert that does nothing on conflict and removing one is a delete of a row the caller
 * can name without reading it first. Double-tapping is not an error and a slow network
 * cannot produce two of the same reaction — which matters because this is the one control
 * in the product people will press twice on purpose.
 */
export interface ReactionRow {
  readonly messageId: UUID;
  readonly emoji: string;
  readonly principalId: UUID;
}

export class PgReactionStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Adds a reaction. Returns whether a row was actually inserted.
   *
   * `false` means "already there", not "failed" — the caller uses it to decide whether
   * anything changed worth broadcasting, not whether to report an error.
   */
  async add(messageId: UUID, principalId: UUID, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.message_reactions (message_id, principal_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [messageId, principalId, emoji],
    );
    return result.rows.length > 0;
  }

  async remove(messageId: UUID, principalId: UUID, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM conversation.message_reactions
        WHERE message_id = $1 AND principal_id = $2 AND emoji = $3
        RETURNING message_id`,
      [messageId, principalId, emoji],
    );
    return result.rows.length > 0;
  }

  /**
   * Every reaction on a page of messages, in one query.
   *
   * One query for the page rather than one per message: a fifty-message page would
   * otherwise be fifty round trips to render an ornament, which is exactly the shape §38
   * measures against. Ordered so the client's grouping is stable between reads — an
   * unordered result makes the emoji chips reshuffle on every poll.
   */
  async forMessages(messageIds: readonly UUID[]): Promise<readonly ReactionRow[]> {
    if (messageIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT message_id, principal_id, emoji
         FROM conversation.message_reactions
        WHERE message_id = ANY($1::uuid[])
        ORDER BY emoji, created_at`,
      [messageIds],
    );
    return result.rows.map((row) => ({
      messageId: row.message_id as UUID,
      principalId: row.principal_id as UUID,
      emoji: row.emoji as string,
    }));
  }

  /**
   * The conversation a message belongs to.
   *
   * Reacting is authorized against the CONVERSATION — that is where participation lives —
   * so the route has to resolve the message to its thread before it can ask `decide()`
   * anything. Returning `undefined` for an unknown message means the route refuses without
   * disclosing whether the id exists (§27.3).
   */
  async conversationOf(messageId: UUID): Promise<UUID | undefined> {
    const result = await this.pool.query(
      'SELECT conversation_id FROM conversation.messages WHERE message_id = $1',
      [messageId],
    );
    return result.rows[0]?.conversation_id as UUID | undefined;
  }
}
