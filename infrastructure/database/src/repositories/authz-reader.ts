/**
 * Read-only conversation facts for an authorization decision.
 *
 * Separate from `PgMessageStore.loadConversationForUpdate` on purpose. That one takes
 * `FOR UPDATE` because the write path needs the row locked while it allocates a
 * sequence; a READ has no such need, and taking a row lock to answer "may this person
 * look at this?" would serialise every reader behind every writer on the same thread —
 * which on a busy conversation is exactly when it hurts.
 *
 * Loading the conversation and deciding against it stays a single operation either way
 * (§18.4 step 3): callers get the facts, never an id they then re-query.
 */
import type pg from 'pg';
import type { ParticipantFacts, ResourceContext, TemporaryGrant } from '@starlink/conversation-domain';
import type { Timestamp, UUID } from '@starlink/shared-contracts';

export interface ConversationAuthzReader {
  /** Returns undefined when the conversation does not exist — indistinguishable, to the caller, from "may not". */
  loadForAuthorization(
    conversationId: UUID,
    principalId: UUID,
    at?: string,
  ): Promise<ResourceContext | undefined>;

  /**
   * Live temporary grants this principal holds over THIS conversation (N-53).
   *
   * Separate from `loadForAuthorization` because the two feed different halves of the
   * decision: a temporary grant is a fact about the ACTOR, and `decide()` reads it from
   * `actor.temporaryGrants`, while the resource context describes the conversation.
   *
   * Conversation-scoped, so it cannot live in `toActorContext` — that function is handed
   * principal claims and has no idea which conversation is being decided. That is exactly
   * why the field sat hardcoded to `[]` with a comment promising a loader "in Phase 5":
   * the natural place to build it was the one place that knows both.
   */
  loadTemporaryGrants(
    conversationId: UUID,
    principalId: UUID,
    at?: string,
  ): Promise<readonly TemporaryGrant[]>;
}

export class PgConversationAuthzReader implements ConversationAuthzReader {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Cover, and any other time-boxed capability, as `decide()` expects to receive it.
   *
   * `grantCover` has written `conversation.temporary_access_grants` since Phase 5 and
   * **nothing has ever read the table** — the only statement against it in the repository
   * was the INSERT. So a lead could grant cover, the row landed, an audit row was written,
   * the UI reported success, and the covering colleague was refused every action, because
   * `toActorContext` supplied an empty array and rung 6 of the ladder had nothing to match.
   *
   * Three filters, each load-bearing:
   *   * `revoked_at IS NULL` — a withdrawn cover stops immediately, not at expiry.
   *   * the period is read from the CLOCK, so no sweep's failure can extend access
   *     (property 4 of the decision function).
   *   * `conversation_id` matches, or is NULL for a case-wide grant — the same either/or
   *     `decide()` applies, kept identical so the two cannot drift.
   */
  async loadTemporaryGrants(
    conversationId: UUID,
    principalId: UUID,
    at?: string,
  ): Promise<readonly TemporaryGrant[]> {
    const now = at ?? new Date().toISOString();
    const rows = await this.pool.query(
      `SELECT g.grant_id, g.capability, g.conversation_id, g.case_id,
              g.effective_from, g.effective_to
         FROM conversation.temporary_access_grants g
         LEFT JOIN conversation.conversations c ON c.conversation_id = $1
        WHERE g.principal_id = $2
          AND g.revoked_at IS NULL
          AND g.effective_from <= $3
          AND g.effective_to > $3
          AND (g.conversation_id = $1 OR (g.conversation_id IS NULL AND g.case_id = c.case_id))`,
      [conversationId, principalId, now],
    );

    return rows.rows.map((row) => ({
      grantId: row.grant_id as UUID,
      capability: row.capability as TemporaryGrant['capability'],
      ...(row.conversation_id !== null ? { conversationId: row.conversation_id as UUID } : {}),
      ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
      effectiveFrom: (row.effective_from as Date).toISOString() as Timestamp,
      effectiveTo: (row.effective_to as Date).toISOString() as Timestamp,
    }));
  }

  async loadForAuthorization(
    conversationId: UUID,
    principalId: UUID,
    /** One instant for the whole projection; defaults to now. Injected so tests can pin it. */
    at: string = new Date().toISOString(),
  ): Promise<ResourceContext | undefined> {
    const result = await this.pool.query(
      `SELECT c.conversation_id, c.conversation_type, c.case_id, c.sensitivity, c.customer_ref,
              sc.owning_team_id, sc.current_owner_id, t.department AS owning_department,
              p.role AS participant_role, p.principal_kind AS participant_kind,
              p.reply_authority, p.effective_from, p.effective_to
         FROM conversation.conversations c
         LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
         LEFT JOIN identity.teams t ON t.team_id = sc.owning_team_id
         LEFT JOIN conversation.participants p
                ON p.conversation_id = c.conversation_id AND p.principal_id = $2
        WHERE c.conversation_id = $1`,
      [conversationId, principalId],
    );

    const row = result.rows[0];
    if (row === undefined) return undefined;

    const participant: ParticipantFacts | undefined =
      row.participant_role === null
        ? undefined
        : {
            role: row.participant_role,
            replyAuthority: row.reply_authority,
            effectiveFrom: (row.effective_from as Date).toISOString(),
            ...(row.effective_to !== null
              ? { effectiveTo: (row.effective_to as Date).toISOString() }
              : {}),
          };

    /**
     * Ownership for a CUSTOMER principal, from live participation.
     *
     * This was missing entirely, and the effect was a silent one-way door: `decide()`
     * refuses a customer whose `belongsToActorCustomer` is not `true`, so every customer
     * subscribe to the realtime gateway was denied — including to their own
     * conversation. It failed CLOSED, so nothing leaked and nothing broke visibly; the
     * customer surface simply had no working socket, and would have stayed that way
     * after Redis arrived.
     *
     * Computed the same way as the write path in `sendMessage`: participation is a fact
     * we recorded, `customer_ref` is a claim we later believed. Deriving it from the
     * reference is what let any customer write into any customer's thread (see the note
     * in send-message.ts) — the same mistake would be waiting here.
     *
     * Set only for a CUSTOMER participant. For an employee the key stays absent, since
     * `decide()` never reads it on that path and an absent value must mean absent.
     */
    const isLiveCustomerParticipant =
      participant !== undefined &&
      row.participant_kind === 'CUSTOMER' &&
      participant.effectiveFrom <= at &&
      (participant.effectiveTo === undefined || participant.effectiveTo > at);

    return {
      conversationId: row.conversation_id,
      conversationType: row.conversation_type,
      ...(row.case_id !== null ? { caseId: row.case_id } : {}),
      ...(row.owning_team_id !== null ? { owningTeamId: row.owning_team_id } : {}),
      ...(row.owning_department !== null ? { owningDepartment: row.owning_department } : {}),
      ...(row.current_owner_id !== null ? { currentOwnerId: row.current_owner_id } : {}),
      ...(row.customer_ref !== null ? { customerRef: row.customer_ref } : {}),
      sensitivity: row.sensitivity,
      ...(participant !== undefined ? { participant } : {}),
      ...(row.participant_kind === 'CUSTOMER'
        ? { belongsToActorCustomer: isLiveCustomerParticipant }
        : {}),
    };
  }
}
