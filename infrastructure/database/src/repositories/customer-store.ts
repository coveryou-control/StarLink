/**
 * The customer side of the database (§21.5, §25.3, ADR-019).
 *
 * Two things here are deliberate and easy to get wrong.
 *
 * **A customer principal is created at intake, not at verification.** Someone can start
 * a conversation before proving who they are (§21.5), and that conversation still needs
 * an author, a participant row and an audit trail. So an ANONYMOUS visitor gets a real
 * `identity.principals` row with `kind = 'CUSTOMER'`, and verification later BINDS a
 * customer reference to it rather than creating a second identity.
 *
 * **Reads are scoped by participation, exactly like an employee's.** Not by
 * `customer_ref`. This matters more than it looks: matching on `customer_ref` would mean
 * that anyone who verifies as customer X inherits every conversation ever attributed to
 * X, including ones created by an unverified session that merely *claimed* to be X.
 * Participation is a fact we recorded; a customer reference is a claim we later believed.
 *
 * The consequence is that a returning customer does not see conversations from a previous
 * session — which is a real product gap, not an oversight, and is exactly what **D-30**
 * asks the business to rule on. Widening this to `customer_ref` is a one-line change and
 * must not be made without that ruling.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import type { InternalConversationRecord, InternalMessageRecord } from '@starlink/conversation-domain';

export interface NewCustomerPrincipal {
  readonly principalId: UUID;
  /** Never a real name unless the customer gave one; "Guest" is the honest default. */
  readonly displayName: string;
  readonly at: Timestamp;
}

export interface IntakeRequest {
  readonly conversationId: UUID;
  readonly caseId: UUID;
  readonly customerPrincipalId: UUID;
  readonly categoryId?: string;
  readonly owningTeamId?: string;
  readonly title?: string;
  /** Present only once the session has proven an identity. */
  readonly customerRef?: string;
  readonly at: Timestamp;
}

export class PgCustomerStore {
  constructor(private readonly pool: pg.Pool) {}

  async createPrincipal(input: NewCustomerPrincipal): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity.principals (principal_id, kind, display_name, authority, effective_from)
       VALUES ($1,'CUSTOMER',$2,'TEMPORARY_AUTHORITY',$3)`,
      [input.principalId, input.displayName, input.at],
    );
  }

  /**
   * Binds a proven customer reference to an existing principal, and bumps the session
   * version.
   *
   * The bump is what makes the assurance change take effect: the cookie carries an
   * assurance stamped at issue, and a raise that did not invalidate the old cookie would
   * leave the pre-verification session usable alongside the new one.
   */
  async bindCustomerRef(
    principalId: UUID,
    customerRef: string,
    at: Timestamp,
  ): Promise<number | undefined> {
    const result = await this.pool.query(
      `UPDATE identity.principals
          SET username = COALESCE(username, $2), updated_at = $3,
              session_version = session_version + 1
        WHERE principal_id = $1 AND kind = 'CUSTOMER'
        RETURNING session_version`,
      [principalId, `customer:${customerRef}`, at],
    );
    // The caller MUST re-issue the cookie with this version. Issuing the old one back
    // would hand the customer a cookie that fails its own version check on the next
    // request — a verification that logs you out.
    return result.rows[0]?.session_version as number | undefined;
  }

  /**
   * Ends every session this customer currently holds, by moving the version past them.
   *
   * `POST /v1/customer/auth/end` used to clear the cookie and invalidate the OTP provider's
   * session, and neither of those reaches a cookie already in somebody's browser: the
   * token stayed valid for the remainder of its TTL. On a shared or kiosk machine that is
   * the whole conversation, readable by the next person to sit down.
   *
   * Incrementing is what makes it irreversible — the old cookie's version can never match
   * again, whereas setting a flag would need a second lookup that something could forget.
   */
  async revokeSessions(principalId: UUID, at: Timestamp): Promise<void> {
    await this.pool.query(
      `UPDATE identity.principals
          SET session_version = session_version + 1, updated_at = $2
        WHERE principal_id = $1 AND kind = 'CUSTOMER'`,
      [principalId, at],
    );
  }

  /** Current session version, for re-issuing a cookie after any change that bumps it. */
  async sessionVersionOf(principalId: UUID): Promise<number | undefined> {
    const result = await this.pool.query(
      `SELECT session_version FROM identity.principals WHERE principal_id = $1 AND kind = 'CUSTOMER'`,
      [principalId],
    );
    return result.rows[0]?.session_version as number | undefined;
  }

  /**
   * Intake: persist the conversation FIRST and fast (§21.5, NFR-PRF-2).
   *
   * No assignment, no routing, no SLA computation on this path. A customer's first
   * message must be durable before anything decides who handles it — the alternative
   * couples "we accepted your message" to a queue being healthy, and the failure mode is
   * a customer who typed a complaint and watched it vanish.
   *
   * `state = 'NEW'` and no owner: unassigned is a legitimate, visible state, not a gap.
   */
  async intake(input: IntakeRequest): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO conversation.service_cases
           (case_id, customer_ref, category_id, owning_team_id, state, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'NEW',$5,$5)`,
        [
          input.caseId,
          input.customerRef ?? null,
          input.categoryId ?? null,
          input.owningTeamId ?? null,
          input.at,
        ],
      );

      await client.query(
        `INSERT INTO conversation.conversations
           (conversation_id, conversation_type, case_id, customer_ref, title, state,
            last_activity_at, participant_count, created_by, created_at, updated_at)
         VALUES ($1,'CUSTOMER_SERVICE',$2,$3,$4,'NEW',$5,1,$6,$5,$5)`,
        [
          input.conversationId,
          input.caseId,
          input.customerRef ?? null,
          input.title ?? null,
          input.at,
          input.customerPrincipalId,
        ],
      );

      await client.query(
        `INSERT INTO conversation.participants
           (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
            effective_from, added_at)
         VALUES ($1,$2,'CUSTOMER','CUSTOMER',true,$2,$3,$3)`,
        [input.conversationId, input.customerPrincipalId, input.at],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The customer's own conversations, scoped by PARTICIPATION.
   *
   * See the note at the top of this file: not by `customer_ref`, and not by anything the
   * caller supplies. The join is the scope (§30.2).
   */
  async listForCustomer(
    principalId: UUID,
    limit: number,
    at: Timestamp,
  ): Promise<readonly InternalConversationRecord[]> {
    const result = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.title, c.state, c.last_activity_at,
              c.last_message_preview, c.case_id, c.customer_ref, sc.priority,
              sc.current_owner_id, sc.owning_team_id, sc.escalation_level,
              -- BR-19's recorded outcome. §22.5 gives the customer this and withholds
              -- resolved_at: "Resolution timestamp | ... | Outcome only".
              sc.outcome_code,
              -- No SLA columns: the clock is computed on read from the case start and
              -- the calendar in force (§23.5, migration 0005). A stored deadline could
              -- not be corrected by fixing a calendar, which is the whole point.
              c.sensitivity, c.participant_count
         FROM conversation.conversations c
         JOIN conversation.participants p
           ON p.conversation_id = c.conversation_id
          AND p.principal_id = $1
          AND p.effective_from <= $3
          AND (p.effective_to IS NULL OR p.effective_to > $3)
         LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        ORDER BY c.last_activity_at DESC, c.conversation_id DESC
        LIMIT $2`,
      [principalId, limit, at],
    );

    // Returned as the INTERNAL record on purpose. The caller projects it through
    // `toCustomerConversationView`, so there is exactly one allow-list rather than a
    // second, subtly different one written in SQL.
    return result.rows.map(
      (row): InternalConversationRecord => ({
        conversationId: row.conversation_id,
        conversationType: row.conversation_type,
        title: row.title,
        state: row.state,
        lastActivityAt: (row.last_activity_at as Date).toISOString() as Timestamp,
        lastMessagePreview: row.last_message_preview,
        ...(row.case_id !== null ? { caseId: row.case_id } : {}),
        ...(row.customer_ref !== null ? { customerRef: row.customer_ref } : {}),
        ...(row.priority !== null ? { priority: row.priority } : {}),
        ...(row.current_owner_id !== null ? { currentOwnerId: row.current_owner_id } : {}),
        ...(row.owning_team_id !== null ? { owningTeamId: row.owning_team_id } : {}),
        escalationLevel: row.escalation_level ?? 0,
        ...(row.outcome_code !== null ? { outcome: row.outcome_code as string } : {}),
        sensitivity: row.sensitivity,
        participantCount: row.participant_count,
      }),
    );
  }

  /**
   * Is this principal a live participant in this conversation?
   *
   * The object check for the customer surface. Returns the conversation only when the
   * participation exists, so "not yours" and "no such conversation" are the same answer
   * at the repository layer as well as in the response (§27.3).
   */
  async loadIfParticipant(
    conversationId: UUID,
    principalId: UUID,
    at: Timestamp,
  ): Promise<InternalConversationRecord | undefined> {
    const rows = await this.listForCustomerConversation(conversationId, principalId, at);
    return rows;
  }

  private async listForCustomerConversation(
    conversationId: UUID,
    principalId: UUID,
    at: Timestamp,
  ): Promise<InternalConversationRecord | undefined> {
    const result = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.title, c.state, c.last_activity_at,
              c.case_id, c.customer_ref, c.sensitivity, c.participant_count,
              sc.outcome_code
         FROM conversation.conversations c
         JOIN conversation.participants p
           ON p.conversation_id = c.conversation_id
          AND p.principal_id = $2
          AND p.effective_from <= $3
          AND (p.effective_to IS NULL OR p.effective_to > $3)
         -- LEFT, because an internal thread has no case and this query serves both.
         LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId, principalId, at],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      conversationId: row.conversation_id,
      conversationType: row.conversation_type,
      title: row.title,
      state: row.state,
      lastActivityAt: (row.last_activity_at as Date).toISOString() as Timestamp,
      ...(row.case_id !== null ? { caseId: row.case_id } : {}),
      ...(row.customer_ref !== null ? { customerRef: row.customer_ref } : {}),
      ...(row.outcome_code !== null ? { outcome: row.outcome_code as string } : {}),
      sensitivity: row.sensitivity,
      participantCount: row.participant_count,
    };
  }

  /**
   * Customer-visible messages only, filtered IN THE QUERY.
   *
   * `visibility = 'CUSTOMER_VISIBLE'` is a predicate, not a post-filter, and not a
   * parameter the caller can widen. The projection in `conversation-domain` drops
   * internal notes as well — that is defence in depth (§18.4 layer 4), and this is the
   * boundary. An internal note must never be loaded into a customer response's memory,
   * let alone serialised out of it.
   */
  async readCustomerMessages(
    conversationId: UUID,
    principalId: UUID,
    limit: number,
    at: Timestamp,
    before?: { createdAt: Timestamp; id: UUID },
  ): Promise<readonly InternalMessageRecord[]> {
    const result = await this.pool.query(
      `SELECT m.message_id, m.conversation_id, m.seq, m.body, m.visibility,
              m.sender_principal_id, m.sender_kind, m.sender_display_name, m.created_at
         FROM conversation.messages m
         JOIN conversation.participants p
           ON p.conversation_id = m.conversation_id
          AND p.principal_id = $2
          AND p.effective_from <= $4
          AND (p.effective_to IS NULL OR p.effective_to > $4)
        WHERE m.conversation_id = $1
          AND m.visibility = 'CUSTOMER_VISIBLE'
          AND ($5::timestamptz IS NULL OR (m.created_at, m.message_id) < ($5::timestamptz, $6::uuid))
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT $3`,
      [conversationId, principalId, limit, at, before?.createdAt ?? null, before?.id ?? null],
    );

    return result.rows.map(
      (row): InternalMessageRecord => ({
        messageId: row.message_id,
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        body: row.body,
        visibility: row.visibility,
        authorId: row.sender_principal_id ?? '',
        authorKind: row.sender_kind,
        authorDisplayName: row.sender_display_name,
        createdAt: (row.created_at as Date).toISOString() as Timestamp,
      }),
    );
  }
}
