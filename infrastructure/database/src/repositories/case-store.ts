/**
 * Resolution, staff reopen and the state history they write (doc §21.4, BR-19–BR-22).
 *
 * §21.4's transition table is decided in `@starlink/service-case`; this is the writing.
 * The split is the same one every other command in the system uses — the domain says
 * whether a move is permitted and by whom, the store makes it durable — and it matters
 * here because the resolve row is the one §21.4 gives the most conditions: owner or lead
 * only, a reason that IS the outcome, the customer told, and audited.
 *
 * ## Four rows change together, and they are one transaction
 *
 * A resolution touches `conversations.state`, `service_cases`, the append-only
 * `case_state_episodes` series and the capacity hold. Any subset committing alone
 * produces a specific, quiet wrongness:
 *
 *   * conversation without case — the closure sweep joins the two and finds nothing, so
 *     the conversation stays RESOLVED forever and never reaches CLOSED.
 *   * case without episode — the SLA reader derives pause spans from the episode series,
 *     and a missing episode silently changes an elapsed number somebody may dispute.
 *   * episode without conversation — `case_state_no_overlap` would reject the next
 *     transition, so the conversation becomes unresolvable and unreopenable.
 *
 * ## Every write is conditional on the state it was decided against
 *
 * The caller reads the head, asks `transition()`, and passes the state it read back in.
 * If anything moved in between — the other of two leads resolving at the same moment, a
 * customer's reply reviving it, the closure sweep — the `WHERE state = $from` matches
 * nothing and the caller is told, rather than overwriting a decision made on facts that
 * had already changed. This is the same shape as `claimConversation`, and for the same
 * reason: a read followed by an unconditional write is the version that produces two
 * winners.
 */
import type pg from 'pg';
import type { ConversationState, Timestamp, UUID } from '@starlink/shared-contracts';
import { appendOutboxIn } from './outbox-writer.js';

/** What the caller needs in order to ask `transition()` anything. */
export interface CaseHead {
  readonly conversationId: UUID;
  readonly conversationType: string;
  readonly state: ConversationState;
  readonly caseId?: UUID;
  /** From the open ownership episode — the constrained table, not the cached column. */
  readonly ownerId?: UUID;
}

export type LifecycleWrite =
  | { readonly ok: true }
  /**
   * The state moved between the read and the write. A normal outcome, not an error: two
   * leads resolving at once, or a customer reply landing first.
   */
  | { readonly ok: false; readonly reason: 'STATE_CHANGED' };

export class PgCaseStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * The facts §21.4 needs, in one read.
   *
   * The owner comes from `ownership_episodes` rather than `service_cases.current_owner_id`
   * for the reason the notification recipients do the same: the episode table carries the
   * exclusion constraint, so it cannot disagree with itself, and the cached column is a
   * convenience maintained beside it.
   */
  async head(conversationId: UUID): Promise<CaseHead | undefined> {
    const result = await this.pool.query(
      `SELECT c.conversation_type, c.state, c.case_id, oe.owner_id
         FROM conversation.conversations c
         LEFT JOIN conversation.ownership_episodes oe
                ON oe.conversation_id = c.conversation_id AND oe.effective_to IS NULL
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      conversationId,
      conversationType: row.conversation_type as string,
      state: row.state as ConversationState,
      ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
      ...(row.owner_id !== null && row.owner_id !== undefined
        ? { ownerId: row.owner_id as UUID }
        : {}),
    };
  }

  /**
   * §21.4's `* → resolved`, from whichever open state the caller read.
   *
   * `outcome` is BR-19's "an outcome is recorded" and §21.4's "Reason required: Yes — the
   * outcome". It is stored in three places on purpose, because three different questions
   * ask for it: `service_cases.outcome_code` is what §22.5 shows the customer,
   * `case_state_episodes.reason` is what the history says happened, and the audit ledger
   * is §31.3's "Reason — where the action requires one (transfer, escalation,
   * resolution)". The ledger write is the caller's, because it also carries the
   * correlation id.
   *
   * **`outcome_code` holds free text, deliberately.** The document says an outcome is
   * *recorded* and that the customer is told *why* (BR-19, BR-20); it never enumerates
   * outcome codes anywhere. Whether resolution outcomes should become a closed,
   * administrable vocabulary — the way categories are — is a business decision nobody has
   * been asked, so inventing a code list here would be inventing a business value
   * (rule 10). Free text satisfies the rule as written and a vocabulary can be layered
   * over it later.
   */
  async resolve(input: {
    conversationId: UUID;
    /** The state the caller read and asked `transition()` about. */
    from: ConversationState;
    resolvedBy: UUID;
    outcome: string;
    at: Timestamp;
    /** §10's event carries it; the caller already read it from the head. */
    caseId: UUID;
    correlationId: string;
  }): Promise<LifecycleWrite> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const moved = await client.query(
        `UPDATE conversation.conversations
            SET state = 'RESOLVED', updated_at = $3
          WHERE conversation_id = $1 AND state = $2`,
        [input.conversationId, input.from, input.at],
      );
      if (moved.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'STATE_CHANGED' };
      }

      /**
       * `resolved_at` is an OBSERVATION, and migration 0005 is explicit that observations
       * stay while derived deadlines do not. It stops the resolution clock, and it is the
       * closure sweep's cutoff — so a resolution that failed to write it would leave a
       * conversation the sweep can never close and a clock that never stops.
       *
       * Stamped by the APPLICATION, never `now()` — ADR-025. The sweep compares against
       * the same clock, and a minute of skew between the two moves every reopen-window
       * boundary by a minute.
       */
      await client.query(
        `UPDATE conversation.service_cases sc
            SET state = 'RESOLVED', resolved_at = $2, outcome_code = $3, updated_at = $2
           FROM conversation.conversations c
          WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
        [input.conversationId, input.at, input.outcome],
      );

      await closeAndOpenEpisode(
        client,
        input.conversationId,
        'RESOLVED',
        input.at,
        input.outcome,
        input.resolvedBy,
      );

      await releaseHolds(client, input.conversationId, input.at, 'resolved');

      /**
       * §10's `conversation.resolved.v1`, in the SAME transaction as the resolution.
       *
       * The relay has routed this event to the customer as customer-visible since Phase 3
       * — with a passing test — and **nothing had ever emitted it**, so a customer watching
       * their own conversation saw no change when it was resolved. They would have had to
       * refresh. Correctness was never at risk (invariant 9: recovery is re-fetch), but
       * the immediacy the design specifies was simply absent.
       *
       * Written here rather than by the controller for P-05's reason: an event that could
       * commit separately from the state change it describes is the drift the transactional
       * outbox exists to make impossible.
       */
      await appendOutboxIn(client, {
        eventName: 'conversation.resolved.v1',
        aggregateType: 'conversation',
        aggregateId: input.conversationId,
        payload: {
          conversationId: input.conversationId,
          caseId: input.caseId,
          outcomeCode: input.outcome,
          actorId: input.resolvedBy,
        },
        correlationId: input.correlationId,
      });

      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * §21.4's `resolved → active` where a STAFF member initiated it (UC-E19).
   *
   * The customer's half of this row lives in `reopenOnReply` and does more: BR-22's fork
   * past the window, and BR-21's "same owner unless they have left". Neither applies here.
   * A staff reopen is inside the window by construction — outside it the conversation is
   * CLOSED and §21.4 makes that terminal — and the owner does not move, because nobody
   * asked for it to. The one thing this shares with the customer path is that the
   * resolution is UNDONE rather than annotated: `resolved_at` must be cleared or the
   * resolution clock stays stopped in the past and the closure sweep closes the
   * conversation again on its next tick.
   */
  async reopen(input: {
    conversationId: UUID;
    reopenedBy: UUID;
    /** §21.4 requires one "if staff-initiated", which this always is. */
    reason: string;
    at: Timestamp;
    caseId: UUID;
    correlationId: string;
  }): Promise<LifecycleWrite> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const moved = await client.query(
        `UPDATE conversation.conversations
            SET state = 'ACTIVE', updated_at = $2, last_activity_at = $2
          WHERE conversation_id = $1 AND state = 'RESOLVED'`,
        [input.conversationId, input.at],
      );
      if (moved.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'STATE_CHANGED' };
      }

      // `reopen_count` is incremented for the same reason the customer path increments it
      // (§22.3): it is the number that shows a case coming back repeatedly, which is a
      // signal about the quality of the resolution.
      await client.query(
        `UPDATE conversation.service_cases sc
            SET state = 'ACTIVE', resolved_at = NULL, outcome_code = NULL,
                reopen_count = sc.reopen_count + 1, updated_at = $2
           FROM conversation.conversations c
          WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
        [input.conversationId, input.at],
      );

      await closeAndOpenEpisode(
        client,
        input.conversationId,
        'ACTIVE',
        input.at,
        input.reason,
        input.reopenedBy,
      );

      // §10's `conversation.reopened.v1` — also customer-visible at the relay, and also
      // never emitted until now.
      await appendOutboxIn(client, {
        eventName: 'conversation.reopened.v1',
        aggregateType: 'conversation',
        aggregateId: input.conversationId,
        payload: {
          conversationId: input.conversationId,
          caseId: input.caseId,
          trigger: 'STAFF_REOPEN',
        },
        correlationId: input.correlationId,
      });

      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Closes the live episode and opens the next at the same instant — no gap, no overlap.
 *
 * `case_state_no_overlap` would reject either, which is the point: the pause spans the
 * SLA clock subtracts are read straight from this series, and a gap would make an elapsed
 * number quietly wrong rather than visibly broken.
 */
async function closeAndOpenEpisode(
  client: pg.PoolClient,
  conversationId: UUID,
  state: ConversationState,
  at: Timestamp,
  reason: string,
  enteredBy: UUID,
): Promise<void> {
  await client.query(
    `UPDATE conversation.case_state_episodes
        SET effective_to = $2
      WHERE conversation_id = $1 AND effective_to IS NULL`,
    [conversationId, at],
  );
  await client.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from, entered_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [crypto.randomUUID(), conversationId, state, at, enteredBy, reason],
  );
}

/**
 * Releases the capacity hold, because the work has finished (N-17).
 *
 * Migration 0004: "It is released, not deleted — `released_at` is set rather than the row
 * removed, so 'why was this agent at capacity at 14:05' stays answerable." Live capacity
 * is a query over unreleased rows, so this is what makes a finished conversation stop
 * counting against the person who finished it.
 *
 * By `ref_id` rather than by reservation id: the caller does not have one, and the unique
 * partial index guarantees at most one live hold per (principal, work) anyway. The
 * predicate is unconditional on principal for a reason — a conversation transferred after
 * it was reserved leaves the hold with the PREVIOUS owner, and releasing only the
 * resolver's would leave that one to expire on its TTL.
 *
 * **This closes the code half of N-17 and not the whole of it.** The hold still carries
 * `capacity_policies.reservation_ttl_sec` (seeded at 120s), so in the ordinary case it
 * expires long before anyone resolves anything, and the ceiling still measures
 * simultaneous PLACEMENT rather than sustained workload. Making the hold last as long as
 * the work needs that TTL lengthened to a crash-safety-net duration, which is a capacity
 * policy value and part of the unanswered D-05.
 */
async function releaseHolds(
  client: pg.PoolClient,
  conversationId: UUID,
  at: Timestamp,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE conversation.reservations
        SET released_at = $2, release_reason = $3
      WHERE ref_system = 'LOCAL' AND ref_type = 'conversation' AND ref_id = $1
        AND released_at IS NULL`,
    [conversationId, at, reason],
  );
}
