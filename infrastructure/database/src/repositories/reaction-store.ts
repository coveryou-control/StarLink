import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * Reactions on messages.
 *
 * ## One per person, enforced by the key
 *
 * The primary key is `(message_id, principal_id)` — see migration 0027. A person has one
 * reaction to a message, and choosing another REPLACES it; a second row for the same
 * person is not merely discouraged, it cannot be stored. That is deliberate: a
 * read-then-write in the route would be a race between two taps on two devices, and the
 * loser would be a duplicate nobody could account for.
 *
 * ## Idempotent by construction
 *
 * Adding is an upsert and removing is a delete of a row the caller can name without
 * reading it first. Double-tapping the same emoji is not an error and a slow network
 * cannot produce a duplicate — which matters because this is the one control in the
 * product people will press twice on purpose.
 */
export interface ReactionRow {
  readonly messageId: UUID;
  readonly emoji: string;
  readonly principalId: UUID;
}

export class PgReactionStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Sets this person's reaction to a message, replacing whatever it was.
   *
   * Returns whether anything actually changed. `false` means "you already had exactly this
   * one" — the caller uses it to decide whether there is something worth broadcasting, not
   * whether to report an error.
   *
   * The `WHERE` on the conflict clause is what makes that distinction possible: without it
   * an unchanged re-tap would still UPDATE the row and report a change, and every duplicate
   * tap would push a realtime frame to the whole conversation.
   */
  async add(messageId: UUID, principalId: UUID, emoji: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO conversation.message_reactions (message_id, principal_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, principal_id)
       DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()
         WHERE conversation.message_reactions.emoji <> EXCLUDED.emoji
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
