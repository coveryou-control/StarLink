/**
 * PostgreSQL implementation of the conversation ports.
 *
 * As with the message store, no business rule lives here — only the queries the domain
 * asked for. Two of them carry correctness weight and are commented at the call site:
 * the direct-conversation lookup (which must match a pair EXACTLY, not merely overlap)
 * and the monotonic read marker.
 */
import type pg from 'pg';
import type {
  ConversationReader,
  ConversationStore,
  ConversationParticipantRef,
  ConversationSummary,
  ConversationWriteTransaction,
  NewConversation,
  NewParticipant,
  OutboxRow,
  ReadStateStore,
} from '@starlink/conversation-domain';
import type { ConversationType, Timestamp, UUID } from '@starlink/shared-contracts';

class PgConversationTransaction implements ConversationWriteTransaction {
  constructor(private readonly client: pg.PoolClient) {}

  /**
   * Finds the 1:1 between exactly this pair.
   *
   * The `HAVING count(*) = 2` is the important half: without it, a group containing
   * both people would match and two colleagues would find their direct messages
   * landing in a group thread.
   */
  async findDirectConversation(a: UUID, b: UUID): Promise<UUID | undefined> {
    const result = await this.client.query(
      `SELECT c.conversation_id
         FROM conversation.conversations c
         JOIN conversation.participants p ON p.conversation_id = c.conversation_id
        WHERE c.conversation_type = 'INTERNAL_DIRECT'
          AND p.effective_to IS NULL
        GROUP BY c.conversation_id
       HAVING count(*) = 2
          AND bool_or(p.principal_id = $1)
          AND bool_or(p.principal_id = $2)
        LIMIT 1`,
      [a, b],
    );
    return result.rows[0]?.conversation_id as UUID | undefined;
  }

  async insertConversation(conversation: NewConversation): Promise<void> {
    await this.client.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, title, created_by, participant_count)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        conversation.conversationId,
        conversation.conversationType,
        conversation.title ?? null,
        conversation.createdBy,
        conversation.participants.length,
      ],
    );
    for (const participant of conversation.participants) {
      await this.client.query(
        `INSERT INTO conversation.participants
           (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
            effective_from, added_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [
          conversation.conversationId,
          participant.principalId,
          participant.principalKind,
          participant.role,
          participant.replyAuthority,
          conversation.createdBy,
          conversation.createdAt,
        ],
      );
    }
  }

  async listParticipants(conversationId: UUID): Promise<readonly NewParticipant[]> {
    const result = await this.client.query(
      `SELECT principal_id, principal_kind, role, reply_authority
         FROM conversation.participants
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    return result.rows.map((row) => ({
      principalId: row.principal_id,
      principalKind: row.principal_kind,
      role: row.role,
      replyAuthority: row.reply_authority,
    }));
  }

  async addParticipant(
    conversationId: UUID,
    participant: NewParticipant,
    addedBy: UUID,
    at: Timestamp,
  ): Promise<void> {
    // `effective_from` is stamped from the APPLICATION clock, not the database's
    // `now()`. `decide()` evaluates the period against the application clock, and
    // `endParticipation` already supplies its own `at` — leaving the start on the
    // database clock meant one period had two clocks, so a server running behind the
    // database refused the conversation to someone who had just been added to it.
    /**
     * ## Why the DO UPDATE now writes role and reply_authority
     *
     * It used to set only effective_to, effective_from and added_by, so a revived row KEPT
     * whatever role and authority it had been dated out with. That was harmless while the
     * only participant of a customer conversation was the customer — and became a privilege
     * escalation the moment the ownership paths began writing OWNER with reply_authority
     * true for whoever claimed the work.
     *
     * The sequence: A claims X and gets OWNER / reply_authority true; A is removed, so the
     * row is dated out with those values intact; X is transferred to B, and the demotion in
     * the routing store matches only LIVE rows so A’s is untouched; anyone then re-adds A
     * as a plain participant. The domain command passes PARTICIPANT and false, the SQL
     * discarded both, and decide() reads reply_authority straight off that row — so A could
     * address the customer again on a conversation B now owns.
     *
     * EXCLUDED is the row the caller asked for, which is the whole reason it is passed.
     *
     * ## And why every branch below is guarded on the row being dead
     *
     * The first version of this fix applied EXCLUDED unconditionally, and `ON CONFLICT
     * (conversation_id, principal_id)` matches the LIVE row just as readily as the dead
     * one. The domain command hardcodes `role: 'PARTICIPANT', replyAuthority: false`
     * (`conversations.ts`), so `POST /participants` naming somebody already in the
     * conversation rewrote them to those values — and naming the current OWNER demoted
     * them: `reply_authority` went false while `ownership_episodes` and
     * `service_cases.current_owner_id` still said they owned the work. `decide()` reads
     * reply authority straight off this row, so the owner silently lost the ability to
     * answer their own customer, with nothing anywhere reporting it.
     *
     * `effective_from = $7` was wrong on a live row for a second reason. Overwriting the
     * start of a period that is still running erases when it began, so BR-09's question —
     * "could they read this on 5 March?" — starts answering no for a participation that
     * never lapsed. `ensureOwnerParticipantIn` guards exactly this and explains why; the
     * two upserts on one table were contradicting each other, and the unguarded one was
     * the human-facing endpoint.
     *
     * So a live row is left alone entirely, which makes re-adding an existing participant
     * an honest no-op, and only a dead row is revived with the caller's values.
     */
    await this.client.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
          effective_from, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (conversation_id, principal_id)
       DO UPDATE SET effective_to = NULL,
                     -- Only a DEAD row is being revived. Everything below leaves a LIVE
                     -- row exactly as it was; see the second note above.
                     effective_from = CASE
                       WHEN conversation.participants.effective_to IS NULL
                         THEN conversation.participants.effective_from
                       ELSE $7
                     END,
                     added_by = CASE
                       WHEN conversation.participants.effective_to IS NULL
                         THEN conversation.participants.added_by
                       ELSE EXCLUDED.added_by
                     END,
                     role = CASE
                       WHEN conversation.participants.effective_to IS NULL
                         THEN conversation.participants.role
                       ELSE EXCLUDED.role
                     END,
                     reply_authority = CASE
                       WHEN conversation.participants.effective_to IS NULL
                         THEN conversation.participants.reply_authority
                       ELSE EXCLUDED.reply_authority
                     END`,
      [
        conversationId,
        participant.principalId,
        participant.principalKind,
        participant.role,
        participant.replyAuthority,
        addedBy,
        at,
      ],
    );
    await this.client.query(
      `UPDATE conversation.conversations
          SET participant_count = (SELECT count(*) FROM conversation.participants
                                    WHERE conversation_id = $1 AND effective_to IS NULL)
        WHERE conversation_id = $1`,
      [conversationId],
    );
  }

  /** Dates the participation rather than deleting it (BR-09). */
  async endParticipation(conversationId: UUID, principalId: UUID, at: Timestamp): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE conversation.participants
          SET effective_to = $3
        WHERE conversation_id = $1 AND principal_id = $2 AND effective_to IS NULL
        RETURNING principal_id`,
      [conversationId, principalId, at],
    );
    if (result.rowCount === 0) return false;
    await this.client.query(
      `UPDATE conversation.conversations
          SET participant_count = (SELECT count(*) FROM conversation.participants
                                    WHERE conversation_id = $1 AND effective_to IS NULL)
        WHERE conversation_id = $1`,
      [conversationId],
    );
    return true;
  }

  async loadConversationType(conversationId: UUID): Promise<ConversationType | undefined> {
    const result = await this.client.query(
      'SELECT conversation_type FROM conversation.conversations WHERE conversation_id = $1',
      [conversationId],
    );
    return result.rows[0]?.conversation_type as ConversationType | undefined;
  }

  /**
   * Promotes a one-to-one that now has three people in it.
   *
   * The type guard is in the WHERE clause, not in the caller: two concurrent adds would
   * otherwise both read INTERNAL_DIRECT and both write, and nothing here may be reachable
   * from a customer conversation. `state` is untouched — the
   * `conversations_state_presence` check requires NULL for both internal kinds, so the row
   * satisfies it before and after.
   */
  async promoteDirectToGroup(conversationId: UUID): Promise<void> {
    await this.client.query(
      `UPDATE conversation.conversations
          SET conversation_type = 'INTERNAL_GROUP', updated_at = now()
        WHERE conversation_id = $1
          AND conversation_type = 'INTERNAL_DIRECT'`,
      [conversationId],
    );
  }

  /**
   * Sets the title, reporting whether a row matched.
   *
   * `RETURNING` rather than checking `rowCount`, so the caller learns the difference
   * between "renamed" and "no such conversation" — the second is a refusal the API has to
   * surface, not a silent success.
   */
  async setTitle(conversationId: UUID, title: string | undefined): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE conversation.conversations
          SET title = $2, updated_at = now()
        WHERE conversation_id = $1
        RETURNING conversation_id`,
      [conversationId, title ?? null],
    );
    return result.rows.length > 0;
  }

  async countMessages(conversationId: UUID): Promise<number> {
    const result = await this.client.query(
      'SELECT count(*)::int AS c FROM conversation.messages WHERE conversation_id = $1',
      [conversationId],
    );
    return result.rows[0].c as number;
  }

  async appendSystemMessage(conversationId: UUID, body: string, at: string): Promise<void> {
    /*
       One statement for the sequence, and it is safe on its own.

       `UPDATE ... SET last_seq = last_seq + 1 RETURNING` takes the row lock itself, so two
       concurrent membership changes serialise here exactly as two concurrent sends do in
       the message store. The two allocators are deliberately the same statement; if either
       ever grows a rule, both have to.
    */
    const seq = await this.client.query(
      `UPDATE conversation.conversations
          SET last_seq = last_seq + 1, last_activity_at = $2
        WHERE conversation_id = $1
        RETURNING last_seq`,
      [conversationId, at],
    );
    const next = seq.rows[0];
    if (next === undefined) return;

    await this.client.query(
      `INSERT INTO conversation.messages
         (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
          sender_display_name, message_class, body, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'INTERNAL', NULL, 'SYSTEM', 'StarLink',
               'MEMBERSHIP', $3, $4)`,
      [conversationId, Number(next.last_seq), body, at],
    );
  }

  async appendOutbox(row: OutboxRow): Promise<void> {
    await this.client.query(
      `INSERT INTO conversation.outbox
         (outbox_id, event_name, event_version, aggregate_type, aggregate_id, payload, correlation_id)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6)`,
      [row.eventName, row.eventVersion, row.aggregateType, row.aggregateId, row.payload, row.correlationId],
    );
  }
}

export class PgConversationStore implements ConversationStore {
  constructor(private readonly pool: pg.Pool) {}

  async transaction<T>(work: (tx: ConversationWriteTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgConversationTransaction(client));
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

export class PgConversationReader implements ConversationReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The caller's threads.
   *
   * Scope is applied by JOINING participation, not by fetching everything and
   * filtering — the same discipline as scope-before-query in search (§30.2). A
   * forgotten filter would return the company's conversations; an absent join returns
   * nothing.
   */
  /**
   * The caller's conversations, newest activity first.
   *
   * `scope` splits announcements out of the chat list rather than filtering them in the
   * client. They are conversations in every technical sense and a different thing to a
   * reader — an announcement to the whole company would otherwise sit at the top of
   * everybody's chat list every time anybody read it, and a person looking for the thread
   * they were in the middle of would find a notice board.
   *
   * Applied in the WHERE clause, so a page is a page: a client-side filter would return
   * fewer than `limit` rows and then page against a cursor that had already skipped past
   * them.
   */
  async listForPrincipal(
    principalId: UUID,
    limit: number,
    before?: { readonly lastActivityAt: string; readonly id: UUID },
    scope: 'CHATS' | 'ANNOUNCEMENTS' = 'CHATS',
  ): Promise<readonly ConversationSummary[]> {
    // Row-value keyset, matching the message pager. `(a, b) < ($3, $4)` stays an index
    // range scan; the equivalent OR-expansion does not, and OFFSET degrades linearly
    // with depth. `last_activity_at` alone is not unique — two threads can move in the
    // same millisecond — so the id is the tiebreaker that stops a row being skipped or
    // repeated across pages.
    const result = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.title, c.state, c.sensitivity,
              c.last_activity_at, c.last_message_preview, c.participant_count,
              COALESCE((SELECT count(*) FROM conversation.messages m
                         WHERE m.conversation_id = c.conversation_id
                           AND m.seq > COALESCE(rs.last_read_seq, 0)
                           AND m.sender_principal_id IS DISTINCT FROM $1), 0)::int AS unread_count,
              /*
                 The second tick, on a list row.

                 The lowest read marker among the OTHER active participants — see
                 "read-receipts.ts" for why it is a minimum and why a missing row counts as
                 zero. "LEFT JOIN" rather than an inner one for exactly that reason: an
                 inner join would silently drop the person who has never opened the thread,
                 and the minimum would then be taken over only the people who HAVE read,
                 which is the over-claim the whole rule exists to prevent.

                 "COALESCE" on the aggregate handles the other empty case: a conversation
                 with nobody else in it, where MIN over no rows is NULL.
              */
              COALESCE((SELECT MIN(COALESCE(ors.last_read_seq, 0))
                          FROM conversation.participants op2
                          LEFT JOIN conversation.read_state ors
                            ON ors.conversation_id = op2.conversation_id
                           AND ors.principal_id = op2.principal_id
                         WHERE op2.conversation_id = c.conversation_id
                           AND op2.effective_to IS NULL
                           AND op2.principal_id <> $1), 0)::bigint AS read_watermark,
              /*
                 Who wrote the newest message, so a row knows whether a tick belongs to it
                 at all. "c.last_seq" is already maintained for realtime gap detection, so
                 only the sender needs looking up — one index seek on (conversation_id,
                 seq), once per row of a page.
              */
              c.last_seq,
              newest.sender_principal_id AS last_message_sender_id,
              others.names AS participant_names,
              COALESCE(cp.pinned, false) AS pinned,
              cp.muted_until
         FROM conversation.conversations c
         JOIN conversation.participants p
           ON p.conversation_id = c.conversation_id
          AND p.principal_id = $1
          AND p.effective_to IS NULL
         LEFT JOIN conversation.read_state rs
           ON rs.conversation_id = c.conversation_id AND rs.principal_id = $1
         /* This reader's own preferences for this thread. LEFT, because the overwhelming
            majority of conversations have no row — see the table's own note on why. */
         LEFT JOIN conversation.conversation_preferences cp
           ON cp.conversation_id = c.conversation_id AND cp.principal_id = $1
         /*
            Who else is here, so a direct message can be named after the person rather
            than rendering as "Untitled conversation".

            LATERAL, not a grouped join: it runs once per row of the page (LIMIT 50), and
            a plain GROUP BY would aggregate across the whole candidate set before the
            keyset range had narrowed it.

            INTERNAL types only. A customer conversation is named by its case, needs none
            of this, and skipping it keeps the customer-workspace payload exactly as it
            was. The caller is excluded: the list is theirs, and their own name in it says
            nothing.

            Bounded at six. A large group needs a count, not sixty names in a sidebar
            row, and an unbounded array here would be an unbounded response.
         */
         LEFT JOIN LATERAL (
              SELECT json_agg(json_build_object(
                       'principalId', ip.principal_id,
                       'displayName', ip.display_name
                     ) ORDER BY ip.display_name) AS names
                FROM (
                  SELECT op.principal_id
                    FROM conversation.participants op
                   WHERE op.conversation_id = c.conversation_id
                     AND op.effective_to IS NULL
                     AND op.principal_id <> $1
                   ORDER BY op.principal_id
                   LIMIT 6
                ) picked
                JOIN identity.principals ip ON ip.principal_id = picked.principal_id
         ) others ON c.conversation_type::text LIKE 'INTERNAL%'
         /*
            Who wrote the message the PREVIEW is showing - the same one, not merely the
            newest row.

            No backticks in here: this SQL is a JS template literal, and one would end the
            string. The symptom is a parse error on the line AFTER the comment, which
            points at innocent code.

            last_message_preview is derived from the newest NON-REDACTED message (see
            refreshPreview), and this lateral had no such filter. Delete the last message
            in a group and the row then showed the previous message's text under the
            deleter's name: a sentence one person wrote, attributed to another. The
            attribution draws the "Name: text" prefix on a group row, so a wrong name is a
            visible lie rather than a missing detail.

            A system note (a membership change) carries no sender, so this yields NULL and
            the row falls back to the bare preview. That is the honest outcome: nobody
            said it.
         */
         LEFT JOIN LATERAL (
              SELECT lm.sender_principal_id
                FROM conversation.messages lm
               WHERE lm.conversation_id = c.conversation_id
                 AND lm.redacted_at IS NULL
               ORDER BY lm.seq DESC
               LIMIT 1
         ) newest ON true
        WHERE ($3::timestamptz IS NULL
               OR (c.last_activity_at, c.conversation_id) < ($3::timestamptz, $4::uuid))
          AND (CASE WHEN $5::text = 'ANNOUNCEMENTS'
                    THEN c.conversation_type = 'INTERNAL_ANNOUNCEMENT'
                    ELSE c.conversation_type <> 'INTERNAL_ANNOUNCEMENT' END)
        /*
           Pinned first, then newest activity — and the keyset above has to agree with it or
           paging skips rows. It does: the cursor is only ever taken from the LAST row of a
           page, so a boundary inside the pinned block compares pinned to pinned and one
           after it compares unpinned to unpinned. Somebody with more pinned conversations
           than a page holds pages through them the same way.

           No backticks in here. This is a JS template literal, and one would end the string
           at the comment - see the platform note in CLAUDE.md.
        */
        ORDER BY COALESCE(cp.pinned, false) DESC, c.last_activity_at DESC, c.conversation_id DESC
        LIMIT $2`,
      [principalId, limit, before?.lastActivityAt ?? null, before?.id ?? null, scope],
    );

    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      conversationType: row.conversation_type,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.state !== null ? { state: row.state } : {}),
      sensitivity: row.sensitivity,
      lastActivityAt: (row.last_activity_at as Date).toISOString(),
      ...(row.last_message_preview !== null ? { lastMessagePreview: row.last_message_preview } : {}),
      participantCount: row.participant_count,
      unreadCount: row.unread_count,
      /* Always present, unlike most of this projection: false is a real answer here and
         "absent" would make every unset conversation indistinguishable from a query that
         did not ask. */
      pinned: row.pinned === true,
      /*
         Present only while the mute has not run out.

         An expired row is left in the table on purpose — nothing has to sweep it, because
         a mute whose instant has passed is indistinguishable from no mute at all. Filtered
         here rather than in SQL so the comparison happens against the SAME clock that
         every other effective period in this codebase is read against, rather than the
         database's `now()`; the two have differed by a minute on a dev machine before, and
         a mute that is over is not something to be wrong about in either direction.
      */
      ...(row.muted_until !== null &&
      row.muted_until !== undefined &&
      (row.muted_until as Date).getTime() > Date.now()
        ? { mutedUntil: (row.muted_until as Date).toISOString() }
        : {}),
      // `bigint` arrives from pg as a string; left as one, every comparison against a
      // message sequence would be lexicographic, and "9" > "10".
      readWatermark: Number(row.read_watermark),
      ...(row.last_seq !== null && Number(row.last_seq) > 0
        ? { lastMessageSeq: Number(row.last_seq) }
        : {}),
      ...(row.last_message_sender_id !== null && row.last_message_sender_id !== undefined
        ? { lastMessageSenderId: row.last_message_sender_id }
        : {}),
      // Absent rather than empty when the join did not run: "not asked" and "nobody else
      // is here" are different facts, and the UI's fallback depends on telling them apart.
      ...(row.participant_names !== null && row.participant_names !== undefined
        ? { participants: row.participant_names as ConversationParticipantRef[] }
        : {}),
    }));
  }
}

export class PgReadStateStore implements ReadStateStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Advances the read marker, never retreats it.
   *
   * `GREATEST` is the whole point: read marking is debounced client-side (FR-READ-4),
   * so requests can arrive out of order. Without this, a slow request carrying an
   * older sequence would resurrect messages the person has already seen.
   */
  async markRead(
    principalId: UUID,
    conversationId: UUID,
    upToSeq: number,
    at: Timestamp,
  ): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO conversation.read_state (principal_id, conversation_id, last_read_seq, last_read_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (principal_id, conversation_id)
       DO UPDATE SET last_read_seq = GREATEST(conversation.read_state.last_read_seq, EXCLUDED.last_read_seq),
                     last_read_at = EXCLUDED.last_read_at
       RETURNING last_read_seq`,
      [principalId, conversationId, upToSeq, at],
    );
    return Number(result.rows[0].last_read_seq);
  }

  /**
   * How far everybody else has read.
   *
   * Same table, opposite question — see the port's own note. The `LEFT JOIN` is the
   * load-bearing part: a participant with no read_state row has to count as zero rather
   * than disappear from the minimum, or a thread where one person has never looked would
   * report the reading of the people who have.
   */
  async readWatermark(conversationId: UUID, excludingPrincipalId: UUID): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MIN(COALESCE(rs.last_read_seq, 0)), 0)::bigint AS watermark
         FROM conversation.participants p
         LEFT JOIN conversation.read_state rs
           ON rs.conversation_id = p.conversation_id AND rs.principal_id = p.principal_id
        WHERE p.conversation_id = $1
          AND p.effective_to IS NULL
          AND p.principal_id <> $2`,
      [conversationId, excludingPrincipalId],
    );
    return Number(result.rows[0]?.watermark ?? 0);
  }
}
