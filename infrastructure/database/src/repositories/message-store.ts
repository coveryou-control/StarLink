/**
 * PostgreSQL implementation of the messaging ports.
 *
 * This is the adapter side of the hexagon: `packages/messaging` states what must
 * happen inside one unit of work, and this supplies the transaction. Nothing here
 * makes a business decision — if a rule appears in this file that is not in the
 * domain, it is in the wrong place.
 *
 * Three details carry correctness weight and are commented where they occur:
 * the row lock that makes sequence allocation safe, the row-value comparison that
 * makes cursor paging correct under concurrent insertion, and the fact that the outbox
 * insert shares the caller's transaction rather than opening its own.
 */
import type pg from 'pg';
import type {
  ConversationRecord,
  InsertMessage,
  MessageReader,
  MessageRevision,
  MessageRecord,
  MessageStore,
  MessageWriteTransaction,
  OutboxRow,
  ParticipantRecord,
} from '@starlink/messaging';
import type { MessageVisibility, Timestamp, UUID } from '@starlink/shared-contracts';
import { advanceStateIn } from './case-state.js';

const toMessage = (row: Record<string, unknown>): MessageRecord => ({
  messageId: row.message_id as UUID,
  conversationId: row.conversation_id as UUID,
  seq: Number(row.seq),
  visibility: row.visibility as MessageVisibility,
  ...(row.sender_principal_id !== null ? { senderPrincipalId: row.sender_principal_id as UUID } : {}),
  senderKind: row.sender_kind as MessageRecord['senderKind'],
  senderDisplayName: row.sender_display_name as string,
  body: (row.body as string | null) ?? '',
  ...(row.reply_to_message_id !== null ? { replyToMessageId: row.reply_to_message_id as UUID } : {}),
  /*
     Threading. `threadParentId` says this message lives inside another one's thread;
     `alsoSendToChannel` says it appears in the channel's timeline as well.

     `replyCount` and `lastReplyAt` are present only on the channel page, which computes
     them — absent means "this query did not ask", never "zero replies". The two are
     different facts and the "N replies" affordance is drawn from the first.
  */
  /* Only when it is NOT the default. Ninety-nine rows in a hundred are 'TEXT', and a
     field that is present and always the same is a field every reader learns to ignore. */
  ...(row.message_class != null && row.message_class !== 'TEXT'
    ? { messageClass: row.message_class as string }
    : {}),
  ...(row.thread_parent_id != null ? { threadParentId: row.thread_parent_id as UUID } : {}),
  ...(row.also_send_to_channel === true ? { alsoSendToChannel: true } : {}),
  ...(row.reply_count != null ? { replyCount: Number(row.reply_count) } : {}),
  ...(row.last_reply_at != null
    ? { lastReplyAt: (row.last_reply_at as Date).toISOString() }
    : {}),
  createdAt: (row.created_at as Date).toISOString(),
  /**
   * Absent rather than `[]` when the column is NULL. "No mentions" and "not selected by
   * this query" are the same thing to every current reader, and a caller that starts
   * caring can tell them apart by which query it ran.
   */
  ...(row.mentions != null
    ? { mentions: row.mentions as NonNullable<MessageRecord['mentions']> }
    : {}),
  ...(row.client_message_id != null
    ? { clientMessageId: row.client_message_id as string }
    : {}),
  ...(row.edited_at != null ? { editedAt: (row.edited_at as Date).toISOString() } : {}),
  ...(row.redacted_at != null ? { redactedAt: (row.redacted_at as Date).toISOString() } : {}),
});

const toConversation = (row: Record<string, unknown>): ConversationRecord => ({
  conversationId: row.conversation_id as UUID,
  conversationType: row.conversation_type as ConversationRecord['conversationType'],
  // NULL for an internal thread (BR-23's CHECK constraint), so absent rather than null:
  // a caller must handle "has no lifecycle", not read a stand-in.
  ...(row.state != null ? { state: row.state as string } : {}),
  ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
  sensitivity: row.sensitivity as ConversationRecord['sensitivity'],
  lastSeq: Number(row.last_seq),
  ...(row.owning_team_id != null ? { owningTeamId: row.owning_team_id as string } : {}),
  ...(row.owning_department != null ? { owningDepartment: row.owning_department as string } : {}),
  ...(row.current_owner_id != null ? { currentOwnerId: row.current_owner_id as UUID } : {}),
  ...(row.customer_ref !== null ? { customerRef: row.customer_ref as string } : {}),
});

class PgWriteTransaction implements MessageWriteTransaction {
  constructor(private readonly client: pg.PoolClient) {}

  /**
   * Loads the conversation and LOCKS the row.
   *
   * The lock is what makes `nextSequence` safe: two concurrent sends on the same
   * thread serialise here, so they cannot be handed the same sequence number. Locking
   * per conversation rather than globally means unrelated threads never contend.
   *
   * The case is joined in because authorization needs the owning team and current
   * owner at the same moment it needs the conversation (doc §17.4 — the object is
   * loaded and authorized together).
   */
  async loadConversationForUpdate(conversationId: UUID): Promise<ConversationRecord | undefined> {
    const result = await this.client.query(
      `SELECT c.conversation_id, c.conversation_type, c.state, c.case_id, c.sensitivity, c.last_seq, c.customer_ref,
              sc.owning_team_id, sc.current_owner_id, t.department AS owning_department
         FROM conversation.conversations c
         LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
         LEFT JOIN identity.teams t ON t.team_id = sc.owning_team_id
        WHERE c.conversation_id = $1
        FOR UPDATE OF c`,
      [conversationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toConversation(row);
  }

  async loadParticipant(conversationId: UUID, principalId: UUID): Promise<ParticipantRecord | undefined> {
    const result = await this.client.query(
      `SELECT principal_id, principal_kind, role, reply_authority, effective_from, effective_to
         FROM conversation.participants
        WHERE conversation_id = $1 AND principal_id = $2`,
      [conversationId, principalId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      principalId: row.principal_id,
      principalKind: row.principal_kind,
      role: row.role,
      replyAuthority: row.reply_authority,
      effectiveFrom: (row.effective_from as Date).toISOString(),
      ...(row.effective_to !== null ? { effectiveTo: (row.effective_to as Date).toISOString() } : {}),
    };
  }

  async findByClientMessageId(
    conversationId: UUID,
    senderPrincipalId: UUID,
    clientMessageId: string,
  ): Promise<MessageRecord | undefined> {
    const result = await this.client.query(
      `SELECT * FROM conversation.messages
        WHERE conversation_id = $1 AND sender_principal_id = $2 AND client_message_id = $3`,
      [conversationId, senderPrincipalId, clientMessageId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toMessage(row);
  }

  async findMessageInConversation(conversationId: UUID, messageId: UUID): Promise<MessageRecord | undefined> {
    const result = await this.client.query(
      `SELECT * FROM conversation.messages WHERE conversation_id = $1 AND message_id = $2`,
      [conversationId, messageId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toMessage(row);
  }

  /** Safe because the conversation row is already locked by loadConversationForUpdate. */
  async nextSequence(conversationId: UUID): Promise<number> {
    const result = await this.client.query(
      `UPDATE conversation.conversations
          SET last_seq = last_seq + 1
        WHERE conversation_id = $1
        RETURNING last_seq`,
      [conversationId],
    );
    return Number(result.rows[0].last_seq);
  }

  async insertMessage(message: InsertMessage & { seq: number }): Promise<MessageRecord> {
    const result = await this.client.query(
      `INSERT INTO conversation.messages
         (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
          sender_display_name, body, reply_to_message_id, client_message_id, mentions,
          thread_parent_id, also_send_to_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        message.messageId,
        message.conversationId,
        message.seq,
        message.visibility,
        message.senderPrincipalId ?? null,
        message.senderKind,
        message.senderDisplayName,
        message.body,
        message.replyToMessageId ?? null,
        message.clientMessageId ?? null,
        /**
         * NULL rather than `[]` for a message with no mentions, matching the column's own
         * note: the overwhelming majority of rows have none, and an empty array costs a
         * jsonb header on every row of the largest table in the schema. Readers treat the
         * two identically.
         */
        message.mentions !== undefined && message.mentions.length > 0
          ? JSON.stringify(message.mentions)
          : null,
        message.threadParentId ?? null,
        /* Meaningless without a parent, and stored false rather than trusted: a client that
           sent the flag on an unthreaded message would otherwise put a row in the timeline
           twice over by a predicate that reads it. */
        message.threadParentId !== undefined && message.alsoSendToChannel === true,
      ],
    );
    return toMessage(result.rows[0]);
  }

  /**
   * Shares the caller's transaction.
   *
   * If this opened its own connection the message could commit while the event did
   * not, which is exactly the drift brief §17 exists to prevent.
   */
  async appendOutbox(row: OutboxRow): Promise<void> {
    await this.client.query(
      `INSERT INTO conversation.outbox
         (outbox_id, event_name, event_version, aggregate_type, aggregate_id, payload, correlation_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [row.eventName, row.eventVersion, row.aggregateType, row.aggregateId, row.payload, row.correlationId],
    );
  }

  /** Live participants only: `effective_to IS NULL` is what makes participation current. */
  async listParticipantIds(conversationId: UUID): Promise<readonly UUID[]> {
    const result = await this.client.query(
      `SELECT principal_id FROM conversation.participants
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    return result.rows.map((row) => row.principal_id as UUID);
  }

  /** Locked, and scoped to the conversation — see the port's own note on both. */
  async loadMessageForRevision(
    conversationId: UUID,
    messageId: UUID,
  ): Promise<MessageRecord | undefined> {
    const result = await this.client.query(
      `SELECT * FROM conversation.messages
        WHERE conversation_id = $1 AND message_id = $2
        FOR UPDATE`,
      [conversationId, messageId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toMessage(row);
  }

  async insertRevision(revision: MessageRevision): Promise<void> {
    await this.client.query(
      `INSERT INTO conversation.message_revisions
         (revision_id, message_id, revision_kind, previous_body, actor_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        revision.revisionId,
        revision.messageId,
        revision.kind,
        revision.previousBody,
        revision.actorId,
      ],
    );
  }

  /**
   * Replaces the body and stamps `edited_at`.
   *
   * `search_vector` is a GENERATED column over `body`, so the full-text index follows this
   * write with no second statement to forget.
   */
  async applyCorrection(messageId: UUID, body: string, at: Timestamp): Promise<MessageRecord> {
    const result = await this.client.query(
      `UPDATE conversation.messages SET body = $2, edited_at = $3
        WHERE message_id = $1 RETURNING *`,
      [messageId, body, at],
    );
    return toMessage(result.rows[0]);
  }

  /**
   * Blanks the body and stamps `redacted_at`. The ROW survives.
   *
   * Deleting it would leave a gap in the per-conversation sequence — which the client's
   * gap detector reads as a missed message and re-fetches forever — and would break any
   * reply pointing at it. The text is gone from `search_vector` for free, because the
   * generated column reads `coalesce(body, '')`.
   */
  async applyRedaction(messageId: UUID, at: Timestamp): Promise<MessageRecord> {
    const result = await this.client.query(
      `UPDATE conversation.messages SET body = NULL, redacted_at = $2
        WHERE message_id = $1 RETURNING *`,
      [messageId, at],
    );
    return toMessage(result.rows[0]);
  }

  /**
   * Rewrites the denormalised preview from the newest message that still has text.
   *
   * `COALESCE(..., '')` rather than leaving it: a conversation whose every message has
   * been deleted shows no preview at all, which is correct — there is nothing to preview.
   * Redacted rows are excluded by `redacted_at IS NULL`, not by testing the body, because
   * an internal note on a customer conversation also stores an empty preview and must not
   * be resurrected here.
   */
  /**
   * Recomputes the sidebar's copy of the newest message.
   *
   * ## A message with no words still has to say something
   *
   * An attachment sent with no covering note has an empty body, and the previous version
   * of this took the newest message with a body AT ALL — so the row went on showing the
   * message before it, and then fell back to the word "Direct message" when there was no
   * earlier one. Either way the list said nothing had happened when something had.
   *
   * So the newest message is chosen first and its preview derived second: its text if it
   * has any, otherwise the name of the file it carries. `NULLIF(trim(...))` is what makes
   * "a body of spaces" behave like no body rather than like a preview of nothing.
   */
  async refreshPreview(conversationId: UUID): Promise<void> {
    await this.client.query(
      `UPDATE conversation.conversations c
          SET last_message_preview = COALESCE((
                SELECT COALESCE(
                         NULLIF(left(trim(m.body), 200), ''),
                         (SELECT a.original_filename
                            FROM conversation.attachments a
                           WHERE a.message_id = m.message_id
                           ORDER BY a.created_at
                           LIMIT 1),
                         ''
                       )
                  FROM conversation.messages m
                 WHERE m.conversation_id = c.conversation_id
                   AND m.redacted_at IS NULL
                 ORDER BY m.seq DESC
                 LIMIT 1
              ), '')
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
  }

  async touchConversation(conversationId: UUID, lastActivityAt: Timestamp, preview: string): Promise<void> {
    await this.client.query(
      `UPDATE conversation.conversations
          SET last_activity_at = $2, last_message_preview = $3, updated_at = now()
        WHERE conversation_id = $1`,
      [conversationId, lastActivityAt, preview],
    );
  }

  /**
   * §21.4's `assigned → active`, in the same transaction as the reply that causes it.
   *
   * Conditional on ASSIGNED, so it fires once: the second reply matches nothing and
   * returns false. That is also what keeps it safe against the other writers — a
   * conversation the customer has just reopened is ACTIVE already, and one resolved a
   * moment ago must not be dragged back by a reply still in flight.
   *
   * `entered_by` is the owner: unlike queueing and routed assignment, a person did this.
   */
  async activateOnOwnerReply(input: {
    conversationId: UUID;
    ownerId: UUID;
    at: Timestamp;
  }): Promise<boolean> {
    return advanceStateIn(this.client, {
      conversationId: input.conversationId,
      from: ['ASSIGNED'],
      to: 'ACTIVE',
      at: input.at,
      enteredBy: input.ownerId,
      reason: 'first customer-visible reply',
    });
  }
}

export class PgMessageStore implements MessageStore {
  constructor(private readonly pool: pg.Pool) {}

  async transaction<T>(work: (tx: MessageWriteTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgWriteTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PgMessageReader implements MessageReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * A page of a conversation — the channel's timeline, or one thread inside it.
   *
   * ## The timeline excludes threaded replies, and that is the whole feature
   *
   * A side conversation threaded off a busy channel is out of the channel by definition;
   * leaving it in would make the thread a rendering flourish rather than a place. The one
   * exception is the design's own "Also send to channel", which is a per-message decision
   * the sender made and is read from the row rather than inferred.
   *
   * ## The counts are computed with the page, not stored
   *
   * `reply_count` and `last_reply_at` come from a LATERAL over the thread index, once per
   * row of a page of at most fifty. A stored counter would be a second copy of a fact these
   * rows already carry, wrong from the first write path that forgot to bump it.
   *
   * They are attached ONLY on the channel page. On a thread page every row would carry a
   * zero, and a zero is indistinguishable from "not asked" to a reader that renders "N
   * replies" from it.
   */
  async readPage(query: {
    conversationId: UUID;
    visibility: readonly MessageVisibility[];
    limit: number;
    before?: { createdAt: Timestamp; id: UUID };
    /** The root whose replies to read. Absent means the channel's own timeline. */
    threadParentId?: UUID;
  }): Promise<readonly MessageRecord[]> {
    const params: unknown[] = [query.conversationId, query.visibility, query.limit];
    let keyset = '';

    if (query.before !== undefined) {
      // Row-value comparison, not `created_at < x OR (created_at = x AND id < y)`.
      // It reads better AND it matches the composite index directly, so the keyset
      // stays an index range scan rather than a filter. This is the property that
      // keeps rows-examined proportional to rows-returned (doc §38).
      params.push(query.before.createdAt, query.before.id);
      keyset = `AND (m.created_at, m.message_id) < ($4::timestamptz, $5::uuid)`;
    }

    const inThread = query.threadParentId !== undefined;
    if (inThread) {
      params.push(query.threadParentId);
    }

    const scope = inThread
      ? `AND m.thread_parent_id = $${params.length}::uuid`
      : `AND (m.thread_parent_id IS NULL OR m.also_send_to_channel)`;

    /* The thread summary is dead weight on a thread page — see the note above — so the
       LATERAL is only in the channel query. */
    const summary = inThread
      ? ''
      : `LEFT JOIN LATERAL (
             SELECT count(*)::int AS reply_count, max(r.created_at) AS last_reply_at
               FROM conversation.messages r
              WHERE r.thread_parent_id = m.message_id
           ) t ON m.thread_parent_id IS NULL`;

    const result = await this.pool.query(
      `SELECT m.*${inThread ? '' : ', t.reply_count, t.last_reply_at'}
         FROM conversation.messages m
         ${summary}
        WHERE m.conversation_id = $1
          AND m.visibility = ANY($2::conversation.message_visibility[])
          ${scope}
          ${keyset}
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT $3`,
      params,
    );
    return result.rows.map(toMessage);
  }
}
