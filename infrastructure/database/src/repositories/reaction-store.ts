import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { UUID } from '@starlink/shared-contracts';

import { appendOutboxIn } from './outbox-writer.js';

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
  async add(
    messageId: UUID,
    principalId: UUID,
    emoji: string,
    conversationId: UUID,
  ): Promise<boolean> {
    return this.writeAndAnnounce(conversationId, messageId, principalId, (client) =>
      client.query(
        `INSERT INTO conversation.message_reactions (message_id, principal_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, principal_id)
         DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()
           WHERE conversation.message_reactions.emoji <> EXCLUDED.emoji
         RETURNING message_id`,
        [messageId, principalId, emoji],
      ),
    );
  }

  async remove(
    messageId: UUID,
    principalId: UUID,
    emoji: string,
    conversationId: UUID,
  ): Promise<boolean> {
    return this.writeAndAnnounce(conversationId, messageId, principalId, (client) =>
      client.query(
        `DELETE FROM conversation.message_reactions
          WHERE message_id = $1 AND principal_id = $2 AND emoji = $3
          RETURNING message_id`,
        [messageId, principalId, emoji],
      ),
    );
  }

  /**
   * The write, and the frame that tells the conversation about it — one transaction.
   *
   * ## Why the event is written here rather than in the route
   *
   * Brief §17: an event that can commit separately from the state change it describes is
   * the drift the transactional outbox exists to prevent. A route that wrote the row and
   * then published would, on a crash between the two, leave a reaction nobody is told
   * about — which is the bug this method was added to fix, made intermittent instead of
   * permanent. Both statements are on one client, so either both land or neither does.
   *
   * ## Why an unchanged tap publishes nothing
   *
   * `RETURNING` is empty when the upsert changed nothing and when the delete matched
   * nothing, and the frame is skipped in both cases. Pressing the same emoji twice is
   * something people do on purpose, and it must not wake every other client in the
   * conversation to re-read a list that is identical.
   */
  private async writeAndAnnounce(
    conversationId: UUID,
    messageId: UUID,
    principalId: UUID,
    write: (client: pg.PoolClient) => Promise<pg.QueryResult>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await write(client);
      const changed = result.rows.length > 0;
      if (changed) {
        await appendOutboxIn(client, {
          eventName: 'message.reacted.v1',
          eventVersion: 1,
          aggregateType: 'conversation',
          aggregateId: conversationId,
          /* Identifiers only — FR-RT-4, and invariant 9's "no state exists only in an
             event". The emoji is deliberately absent: readers re-fetch. */
          payload: { messageId, conversationId, actorPrincipalId: principalId },
          correlationId: randomUUID(),
        });
      }
      await client.query('COMMIT');
      return changed;
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
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
   * Who reacted to ONE message, and with what.
   *
   * ## Why this is a separate read
   *
   * The page listing deliberately sends only `{emoji, count, mine}` — see the comment on
   * the message view. Sending the reactor ids for every message on every page would put a
   * profile of who is paying attention to whom on the wire, continuously, to decorate a
   * list. Asking for one message when somebody actually opens the detail is the same
   * information at a hundredth of the exposure.
   *
   * Ordered oldest first, so the list reads as the order people arrived rather than
   * reshuffling between opens.
   */
  async forMessage(messageId: UUID): Promise<readonly { principalId: UUID; emoji: string; at: string }[]> {
    const result = await this.pool.query(
      `SELECT principal_id, emoji, created_at
         FROM conversation.message_reactions
        WHERE message_id = $1
        ORDER BY created_at ASC, principal_id ASC`,
      [messageId],
    );
    return result.rows.map((row) => ({
      principalId: row.principal_id as UUID,
      emoji: row.emoji as string,
      at: (row.created_at as Date).toISOString(),
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
