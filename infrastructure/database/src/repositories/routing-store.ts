/**
 * Queue, claim and ownership persistence (doc §21.7–21.9, BR-10, ADR-023).
 *
 * Three concurrency guarantees live here, and each is enforced by the DATABASE rather
 * than by application discipline — because every one of them is a race that only shows
 * under load, and by then it has already produced two owners or a lost conversation.
 *
 *   * **Exactly one claimer per conversation.** A conditional `UPDATE ... WHERE state =
 *     'WAITING'` — the loser updates zero rows and is told ALREADY_ASSIGNED. Not a read
 *     followed by a write, which is the version that produces two winners.
 *   * **Exactly one owner at any instant.** The `ownership_no_overlap` GiST exclusion
 *     constraint (migration 0001) makes two overlapping episodes uncommittable. BR-10 is
 *     therefore true even if this code is wrong.
 *   * **No two agents pulling the same queue item.** `FOR UPDATE SKIP LOCKED` — the
 *     canonical pattern, and the one the 100-simultaneous-claim golden test exercises.
 *
 * Ownership history is append-only and dated. An episode is CLOSED, never deleted or
 * overwritten: "who owned this in March" is an audit question, and a mutated row cannot
 * answer it (§17.3, the same discipline as participation and role grants).
 */
import { effectiveCapacityUnits } from './capacity-scope.js';
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { advanceStateIn, ASSIGNABLE_FROM } from './case-state.js';
import { appendOutboxIn } from './outbox-writer.js';

/**
 * Mirrors the `conversation.assignment_source` enum in migration 0001, EXACTLY.
 *
 * The first version of this type invented its own spellings — `TRANSFERRED` for
 * `TRANSFER`, `ADMIN` for `LEAD_ASSIGNED` — and omitted `REASSIGNED_ON_EXIT` entirely.
 * TypeScript cannot catch that: the enum lives in SQL, so a mismatch is a runtime
 * insert failure on a path (transfer, escalation, employee exit) that no unit test
 * touches. `assignment-source.test.ts` now asserts the two agree.
 */
export type AssignmentSource =
  | 'ROUTED'
  | 'CLAIMED'
  | 'LEAD_ASSIGNED'
  | 'REASSIGNED_ON_EXIT'
  | 'COVER'
  | 'ESCALATION'
  | 'TRANSFER';

export interface QueueEntry {
  readonly queueEntryId: UUID;
  readonly conversationId: UUID;
  readonly caseId?: UUID;
  readonly teamId: string;
  readonly priority: string;
  readonly state: 'WAITING' | 'RESERVED' | 'CLAIMED' | 'CANCELLED';
  readonly afterHours: boolean;
  readonly enqueuedAt: Timestamp;
}

export interface OwnershipEpisode {
  readonly episodeId: UUID;
  readonly conversationId: UUID;
  readonly ownerId: UUID;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly assignmentSource: AssignmentSource;
  readonly reason?: string;
  readonly previousOwner?: UUID;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly episode: OwnershipEpisode }
  /** Somebody else got there first. The expected outcome for every loser of a race. */
  | { readonly ok: false; readonly reason: 'ALREADY_ASSIGNED' }
  | { readonly ok: false; readonly reason: 'NOT_QUEUED' };

export class PgRoutingStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Places a conversation in a team's queue.
   *
   * `afterHours` is carried on the row rather than recomputed later: whether the clock
   * should have started is a fact about the moment of arrival, and a calendar corrected
   * next week must not silently rewrite it (§23.5).
   */
  async enqueue(input: {
    queueEntryId: UUID;
    conversationId: UUID;
    caseId?: UUID;
    teamId: string;
    priority: string;
    afterHours: boolean;
    at: Timestamp;
    /** Ties §20.7's queue-arrival event back to the request that caused it. */
    correlationId?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conversation.queue_entries
           (queue_entry_id, conversation_id, case_id, team_id, priority, state, after_hours, enqueued_at)
         VALUES ($1,$2,$3,$4,$5,'WAITING',$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          input.queueEntryId,
          input.conversationId,
          input.caseId ?? null,
          input.teamId,
          input.priority,
          input.afterHours,
          input.at,
        ],
      );

      /**
       * §21.4's `new → queued`: "System, when no owner can be assigned, or after hours
       * (§23.3)". In the SAME transaction as the queue row, because a queue entry whose
       * conversation still reads NEW is a conversation the lifecycle cannot advance --
       * and §21.4 offers no route out of NEW except through QUEUED or ASSIGNED.
       *
       * `entered_by` is NULL: nobody did this, the absence of an available owner did.
       */
      await advanceStateIn(client, {
        conversationId: input.conversationId,
        from: ['NEW'],
        to: 'QUEUED',
        at: input.at,
        reason: input.afterHours ? 'queued after hours' : 'queued for the team',
      });

      /**
       * §20.7's **Queue arrival**, published to the team room (N-27).
       *
       * The room has been joinable since Phase 3 and nothing ever published to it, so a
       * queue view subscribing received silence and only ever updated on reload. §20.2:
       * "a queue that needs refreshing is a queue that grows."
       *
       * In the same transaction as the queue row, so a conversation that is in the queue
       * and a team that was told about it cannot disagree.
       */
      await appendOutboxIn(client, {
        eventName: 'conversation.queue.arrived.v1',
        aggregateType: 'conversation',
        aggregateId: input.conversationId,
        payload: {
          conversationId: input.conversationId,
          teamId: input.teamId,
          priority: input.priority,
          afterHours: input.afterHours,
        },
        correlationId: input.correlationId ?? 'routing-sweep',
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claims ONE named conversation. Golden test G-06.
   *
   * The whole guarantee is in the `WHERE state = 'WAITING'`: the database serialises
   * concurrent updates to the row, so the second one sees a state that is no longer
   * WAITING and matches nothing. Zero rows updated IS the answer, not an error to retry.
   *
   * A read-then-write version of this would pass every sequential test and hand the same
   * customer to two agents the first time two people clicked at once.
   */
  async claimConversation(input: {
    conversationId: UUID;
    claimedBy: UUID;
    episodeId: UUID;
    at: Timestamp;
    /**
     * The request's correlation id, so the participation grant this writes to the ledger
     * joins to the rest of that request. Optional because the store is also driven from
     * tests and sweeps that have none; one is minted when it is absent, which keeps the
     * NOT NULL column honest without inventing a shared id.
     */
    correlationId?: string;
  }): Promise<ClaimOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimed = await client.query(
        `UPDATE conversation.queue_entries
            SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3
          WHERE conversation_id = $1 AND state = 'WAITING'
          RETURNING queue_entry_id, case_id`,
        [input.conversationId, input.claimedBy, input.at],
      );

      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        // Distinguish "someone beat me" from "this was never queued" for the caller's
        // logs. Both render identically at the HTTP boundary.
        // On the SAME client, deliberately. Asking the pool for a second connection
        // while still holding one deadlocks the pool the moment concurrency reaches its
        // size: every caller holds one client and waits for a second that only another
        // caller can release. It surfaced as "timeout exceeded when trying to connect"
        // under 25 concurrent claimants — exactly the load this path exists for.
        const exists = await client.query(
          `SELECT 1 FROM conversation.queue_entries WHERE conversation_id = $1`,
          [input.conversationId],
        );
        return {
          ok: false,
          reason: exists.rowCount === 0 ? 'NOT_QUEUED' : 'ALREADY_ASSIGNED',
        };
      }

      const episode = await this.openEpisodeIn(client, {
        episodeId: input.episodeId,
        conversationId: input.conversationId,
        caseId: claimed.rows[0].case_id ?? undefined,
        ownerId: input.claimedBy,
        assignmentSource: 'CLAIMED',
        at: input.at,
      });

      /**
       * The cached owner column, and the two things that go with it.
       *
       * **This was missing, and it broke the primary path.** The episode above is the
       * constrained truth, but `decide()` reads `currentOwnerId`, which the authorization
       * reader takes from `service_cases.current_owner_id`. Without this UPDATE an agent
       * who won a claim owned the conversation by the exclusion constraint and was
       * refused by the authorization ladder when they tried to reply to the customer --
       * because AGENT alone does not carry `conversation.reply.customer`; ownership does.
       *
       * `assignFromRouting` had always written it. Only the HTTP claim endpoint -- the
       * one agents actually use -- did not, and `claim-race.test.ts` could not see it: it
       * proves exactly-one-winner at the store level and never asks whether the winner
       * can then do anything.
       */
      // Without this the claimer owns a conversation their own inbox cannot show them.
      // Before the `service_cases` write below, so this method takes `conversations`
      // first — see the lock-ordering note in `reassign`.
      await this.ensureOwnerParticipantIn(client, {
        conversationId: input.conversationId,
        principalId: input.claimedBy,
        addedBy: input.claimedBy,
        at: input.at,
        // Self-service: the claimer is both actor and subject.
        grantedBy: {
          actorId: input.claimedBy,
          actorKind: 'EMPLOYEE',
          /**
           * The conversation id, not a fresh UUID.
           *
           * §31.5's forensic reconstruction joins the ledger on `correlation_id`, so a
           * minted random value produces a row that joins to nothing — visible in the
           * table, useless in the query the table exists for. The conversation is the
           * thing every row on this path has in common, and it is what the other SYSTEM
           * writers already use.
           */
          correlationId: input.correlationId ?? input.conversationId,
          reason: 'claimed from the queue',
        },
      });

      await client.query(
        `UPDATE conversation.service_cases sc
            SET current_owner_id = $2, updated_at = $3
           FROM conversation.conversations c
          WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
        [input.conversationId, input.claimedBy, input.at],
      );

      // §21.4's `queued → assigned`: "Advisor claims, or a lead assigns."
      await advanceStateIn(client, {
        conversationId: input.conversationId,
        from: ASSIGNABLE_FROM,
        to: 'ASSIGNED',
        at: input.at,
        enteredBy: input.claimedBy,
        reason: 'claimed from the queue',
      });

      await client.query('COMMIT');
      return { ok: true, episode };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Takes the next waiting item from a team's queue. Golden test G-07.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes a hundred simultaneous callers produce a
   * hundred DIFFERENT items rather than ninety-nine deadlocks: a caller that finds a row
   * locked steps over it instead of waiting behind it.
   *
   * Order is oldest-first within a priority band (§23.4) — the index
   * `queue_entries_claim_idx` exists for exactly this query.
   */
  async claimNextFromQueue(input: {
    teamId: string;
    claimedBy: UUID;
    episodeId: UUID;
    at: Timestamp;
    /** Joins the ledger row to the request that caused it (§31.5). */
    correlationId?: string;
  }): Promise<ClaimOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimed = await client.query(
        `UPDATE conversation.queue_entries q
            SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3
          WHERE q.queue_entry_id = (
                  SELECT inner_q.queue_entry_id
                    FROM conversation.queue_entries inner_q
                   WHERE inner_q.team_id = $1 AND inner_q.state = 'WAITING'
                   ORDER BY inner_q.priority, inner_q.enqueued_at
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
          RETURNING q.conversation_id, q.case_id`,
        [input.teamId, input.claimedBy, input.at],
      );

      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'NOT_QUEUED' };
      }

      const episode = await this.openEpisodeIn(client, {
        episodeId: input.episodeId,
        conversationId: claimed.rows[0].conversation_id,
        caseId: claimed.rows[0].case_id ?? undefined,
        ownerId: input.claimedBy,
        assignmentSource: 'CLAIMED',
        at: input.at,
      });

      /**
       * The owner is a participant, and the grant is audited — the same two facts every
       * other ownership path writes.
       *
       * This method opened an episode and stopped there. An owner with no participant row
       * is the defect `ensureOwnerParticipantIn`'s own header describes: `listForPrincipal`
       * INNER JOINs live participation, so the conversation is genuinely theirs and appears
       * in no list they can see, while `decide()`'s participant rung refuses them the
       * reading a participant would get. And a grant with no ledger row leaves §31.1 unable
       * to answer who was given access.
       *
       * Three of the five ownership paths were converted when the audit was made atomic;
       * these last two were not, so the invariant held for the routes people happened to
       * use rather than for the class.
       */
      await this.ensureOwnerParticipantIn(client, {
        conversationId: claimed.rows[0].conversation_id as UUID,
        principalId: input.claimedBy,
        addedBy: input.claimedBy,
        at: input.at,
        grantedBy: {
          actorId: input.claimedBy,
          actorKind: 'EMPLOYEE',
          reason: 'claimed the next conversation from the queue',
          // Falls back to the conversation id rather than a fresh UUID: §31.5's forensic
          // query joins on this column, and a random value joins to nothing.
          correlationId: input.correlationId ?? (claimed.rows[0].conversation_id as string),
        },
      });

      await client.query('COMMIT');
      return { ok: true, episode };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Hands a conversation to a new owner.
   *
   * Closes the current episode and opens the next AT THE SAME INSTANT, inside one
   * transaction. That is not tidiness: the exclusion constraint uses a half-open range
   * `[from, to)`, so closing at exactly the instant the next opens leaves no gap where
   * the conversation had no owner and no overlap where it had two.
   *
   * `preserveDesignated` is the cover/transfer distinction (§21.7). A COVER changes who
   * is accountable today and leaves the relationship alone; a TRANSFER moves both. Get
   * this backwards and a customer permanently loses their advisor because he took a day
   * off — "cover does not destroy the relationship."
   */
  async reassign(input: {
    conversationId: UUID;
    toOwner: UUID;
    episodeId: UUID;
    assignmentSource: AssignmentSource;
    reason: string;
    assignedBy: UUID;
    at: Timestamp;
    /** COVER leaves `service_cases.designated_employee_id` untouched. */
    preserveDesignated: boolean;
    /** See `claimConversation`: ties the participation ledger row to the request. */
    correlationId?: string;
  }): Promise<OwnershipEpisode> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const previous = await client.query(
        `UPDATE conversation.ownership_episodes
            SET effective_to = $2, next_owner = $3
          WHERE conversation_id = $1 AND effective_to IS NULL
          RETURNING owner_id`,
        [input.conversationId, input.at, input.toOwner],
      );
      const previousOwner = previous.rows[0]?.owner_id as UUID | undefined;

      const episode = await this.openEpisodeIn(client, {
        episodeId: input.episodeId,
        conversationId: input.conversationId,
        ownerId: input.toOwner,
        assignmentSource: input.assignmentSource,
        at: input.at,
        reason: input.reason,
        assignedBy: input.assignedBy,
        ...(previousOwner !== undefined ? { previousOwner } : {}),
      });

      /**
       * The OUTGOING owner stops being the owner — before anything else touches this
       * conversation's rows.
       *
       * ## The defect this closes
       *
       * When this method began writing a participant row for the incoming owner, nothing
       * ended the OUTGOING one's. That row is `role='OWNER', reply_authority=true,
       * effective_to=NULL`, and `decide.ts` grants `conversation.reply.customer` from
       * exactly that field:
       *
       *     if (action === 'conversation.reply.customer' && participant?.replyAuthority)
       *
       * So every transfer and escalation left the previous agent able to write to that
       * customer indefinitely — P-03 and D-04a's owner-only rule defeated after any
       * hand-off, and a straight widening, because before the participant row existed the
       * rung never fired at all.
       *
       * ## Why DEMOTED and not dated out
       *
       * BR-09 dates participation rather than deleting it, and ending the row here would
       * strip the previous owner's read access — retroactively removing the conversation
       * from their own history, which is both unhelpful during a hand-over and not what
       * BR-09 asks for. P-03 states the correct middle: participation grants reading and
       * internal notes, NOT replying to the customer. That is precisely `role='PARTICIPANT'`
       * with `reply_authority = false`.
       *
       * Cover does not reach this code at all — `packages/routing/src/commands.ts` routes
       * it to `grantCover`, and its own header says "COVER DOES NOT MOVE OWNERSHIP". Only
       * transfer, escalate and reassign-on-exit arrive here, and all three genuinely move
       * it.
       */
      if (previousOwner !== undefined && previousOwner !== input.toOwner) {
        await client.query(
          `UPDATE conversation.participants
              SET role = 'PARTICIPANT', reply_authority = false
            WHERE conversation_id = $1 AND principal_id = $2 AND effective_to IS NULL`,
          [input.conversationId, previousOwner],
        );
      }

      /**
       * The incoming owner joins, and this runs BEFORE the `service_cases` writes below.
       *
       * ## Why the order matters
       *
       * `ensureOwnerParticipantIn` ends with an `UPDATE conversation.conversations` to
       * recount participants. Placed after the `service_cases` updates, it made this method
       * lock `service_cases` then `conversations` — the reverse of every other multi-table
       * writer in the codebase (`message-store.ts` and `case-state.ts` both take
       * `conversations` first, and `case-store.ts`'s resolve/reopen follow them).
       *
       * Two lock orders on one pair of rows is an ABBA deadlock. An agent replying while a
       * lead escalates the same conversation deadlocks on `40P01` inside a second, and
       * nothing in this repository retries a deadlock — it surfaces as a 500, losing the
       * customer's message and silently not performing the transfer.
       *
       * Every writer here now touches `conversations` before `service_cases`.
       */
      await this.ensureOwnerParticipantIn(client, {
        conversationId: input.conversationId,
        principalId: input.toOwner,
        addedBy: input.assignedBy,
        at: input.at,
        grantedBy: {
          actorId: input.assignedBy,
          actorKind: 'EMPLOYEE',
          reason: input.reason,
          correlationId: input.correlationId ?? input.conversationId,
        },
      });

      await client.query(
        `UPDATE conversation.service_cases sc
            SET current_owner_id = $2, updated_at = $3
           FROM conversation.conversations c
          WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
        [input.conversationId, input.toOwner, input.at],
      );

      if (!input.preserveDesignated) {
        await client.query(
          `UPDATE conversation.service_cases sc
              SET designated_employee_id = $2, updated_at = $3
             FROM conversation.conversations c
            WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
          [input.conversationId, input.toOwner, input.at],
        );
      }

      await client.query('COMMIT');
      return episode;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claims a queue entry BY ITS ID, idempotently. The Work Orchestrator contract's
   * `claim(queueEntryId, principalId, idempotencyKey)`.
   *
   * The idempotency key is what separates "I am retrying because the network dropped"
   * from "I am a second person clicking". Without it a retried claim reads as a losing
   * claimant, and the agent who actually won is told someone else has their
   * conversation — which is worse than the race it looks like.
   *
   * Recorded in `idempotency_records` rather than on the queue row, because the answer
   * must survive the row moving on: the entry is CLAIMED by the time a retry arrives,
   * so the row alone can no longer distinguish the winner's retry from a stranger.
   */
  async claimQueueEntry(input: {
    queueEntryId: UUID;
    claimedBy: UUID;
    episodeId: UUID;
    idempotencyKey: string;
    at: Timestamp;
    /** Joins the ledger row to the request that caused it (§31.5). */
    correlationId?: string;
  }): Promise<
    | { ok: true; conversationId: UUID; reservationId: UUID; replayed: boolean }
    | { ok: false; currentOwner?: UUID }
  > {
    const scope = `claim:${input.queueEntryId}`;

    // A replay returns the ORIGINAL result, not a fresh attempt.
    const seen = await this.pool.query(
      `SELECT result_payload FROM conversation.idempotency_records
        WHERE scope = $1 AND idempotency_key = $2`,
      [scope, input.idempotencyKey],
    );
    if (seen.rowCount !== null && seen.rowCount > 0) {
      const payload = seen.rows[0].result_payload as { conversationId: UUID; reservationId: UUID };
      return { ok: true, ...payload, replayed: true };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimed = await client.query(
        `UPDATE conversation.queue_entries
            SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3
          WHERE queue_entry_id = $1 AND state = 'WAITING'
          RETURNING conversation_id, case_id`,
        [input.queueEntryId, input.claimedBy, input.at],
      );

      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        // Same client — see the note in `claimConversation`.
        const holder = await client.query(
          `SELECT claimed_by FROM conversation.queue_entries WHERE queue_entry_id = $1`,
          [input.queueEntryId],
        );
        const currentOwner = holder.rows[0]?.claimed_by as UUID | null | undefined;
        return currentOwner === null || currentOwner === undefined
          ? { ok: false }
          : { ok: false, currentOwner };
      }

      const conversationId = claimed.rows[0].conversation_id as UUID;
      await this.openEpisodeIn(client, {
        episodeId: input.episodeId,
        conversationId,
        caseId: claimed.rows[0].case_id ?? undefined,
        ownerId: input.claimedBy,
        assignmentSource: 'CLAIMED',
        at: input.at,
      });

      /**
       * Participation and its audit row, in this same transaction.
       *
       * This is the Work Orchestrator contract's `claim()` and it is wired into the DI
       * graph, so it is a live path even though no route reaches it today. Leaving it
       * without a participant row would mean the invariant depended on which entry point a
       * caller happened to use — exactly the shape that put the other three paths wrong.
       */
      await this.ensureOwnerParticipantIn(client, {
        conversationId,
        principalId: input.claimedBy,
        addedBy: input.claimedBy,
        at: input.at,
        grantedBy: {
          actorId: input.claimedBy,
          actorKind: 'EMPLOYEE',
          reason: 'claimed a queue entry',
          correlationId: input.correlationId ?? conversationId,
        },
      });

      // The reservation the contract hands back. Written in the SAME transaction as the
      // claim, so a crash between them cannot leave a claimed entry with no hold.
      const reservationId = crypto.randomUUID() as UUID;
      await client.query(
        `INSERT INTO conversation.reservations
           (reservation_id, principal_id, ref_system, ref_type, ref_id, weight,
            effective_from, expires_at)
         VALUES ($1,$2,'LOCAL','conversation',$3,1,$4, $4::timestamptz + interval '120 seconds')
         ON CONFLICT DO NOTHING`,
        [reservationId, input.claimedBy, conversationId, input.at],
      );

      await client.query(
        `INSERT INTO conversation.idempotency_records (scope, idempotency_key, result_ref, result_payload)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (scope, idempotency_key) DO NOTHING`,
        [scope, input.idempotencyKey, conversationId, JSON.stringify({ conversationId, reservationId })],
      );

      await client.query('COMMIT');
      return { ok: true, conversationId, reservationId, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A time-boxed capability on ONE conversation. NOT an ownership change (§21.9 A/D).
   *
   * `effective_to` is NOT NULL in the schema and required here: an open-ended cover is
   * an unaudited second owner, and the difference between "Priya is covering until 1pm"
   * and "Priya can read this forever" is the entire point of the mechanism.
   */
  async grantCover(input: {
    grantId: UUID;
    conversationId: UUID;
    principalId: UUID;
    capability: string;
    reason: string;
    grantedBy: UUID;
    from: Timestamp;
    until: Timestamp;
  }): Promise<{ grantId: UUID }> {
    await this.pool.query(
      `INSERT INTO conversation.temporary_access_grants
         (grant_id, principal_id, conversation_id, capability, reason, granted_by,
          effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.grantId,
        input.principalId,
        input.conversationId,
        input.capability,
        input.reason,
        input.grantedBy,
        input.from,
        input.until,
      ],
    );
    return { grantId: input.grantId };
  }

  /**
   * Raises the escalation LEVEL (§21.4).
   *
   * A level, not a state: a case can be escalated AND active AND waiting at once, and
   * modelling escalation as a state makes that case unrepresentable the moment two
   * things are true of it.
   */
  async raiseEscalationLevel(input: {
    conversationId: UUID;
    reason: string;
    at: Timestamp;
  }): Promise<{ level: number }> {
    const result = await this.pool.query(
      `UPDATE conversation.service_cases sc
          SET escalation_level = sc.escalation_level + 1, updated_at = $2
         FROM conversation.conversations c
        WHERE c.conversation_id = $1 AND sc.case_id = c.case_id
        RETURNING sc.escalation_level`,
      [input.conversationId, input.at],
    );
    // A conversation with no case has no level to raise. Report zero rather than
    // inventing one — the escalation still happened as an ownership move and an audit.
    return { level: (result.rows[0]?.escalation_level as number | undefined) ?? 0 };
  }

  /** The live episode, or nothing when the conversation is unassigned. */
  async currentOwner(conversationId: UUID): Promise<OwnershipEpisode | undefined> {
    const result = await this.pool.query(
      `SELECT episode_id, conversation_id, owner_id, effective_from, effective_to,
              assignment_source, reason, previous_owner
         FROM conversation.ownership_episodes
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toEpisode(row);
  }

  /** Full history, newest first. Append-only, so this is the audit answer. */
  async ownershipHistory(conversationId: UUID): Promise<readonly OwnershipEpisode[]> {
    const result = await this.pool.query(
      `SELECT episode_id, conversation_id, owner_id, effective_from, effective_to,
              assignment_source, reason, previous_owner
         FROM conversation.ownership_episodes
        WHERE conversation_id = $1
        ORDER BY effective_from DESC`,
      [conversationId],
    );
    return result.rows.map(toEpisode);
  }

  /** The team's waiting work, in the order it should be taken. */
  async queueView(teamId: string, limit: number): Promise<readonly QueueEntry[]> {
    const result = await this.pool.query(
      `SELECT queue_entry_id, conversation_id, case_id, team_id, priority, state,
              after_hours, enqueued_at
         FROM conversation.queue_entries
        WHERE team_id = $1 AND state = 'WAITING'
        ORDER BY priority, enqueued_at
        LIMIT $2`,
      [teamId, limit],
    );
    return result.rows.map((row) => ({
      queueEntryId: row.queue_entry_id,
      conversationId: row.conversation_id,
      ...(row.case_id !== null ? { caseId: row.case_id } : {}),
      teamId: row.team_id,
      priority: row.priority,
      state: row.state,
      afterHours: row.after_hours,
      enqueuedAt: (row.enqueued_at as Date).toISOString() as Timestamp,
    }));
  }

  /**
   * The router PUSHING work at a named person, with the capacity ceiling enforced
   * atomically (§21.8 step 4, §21.9 capacity row, D-05).
   *
   * Distinct from `claimQueueEntry` for two reasons, and both matter:
   *
   *   * The episode is stamped `ROUTED`, not `CLAIMED`. "The system gave this to me"
   *     and "I took this" are different facts, and the ownership ledger is the place
   *     a lead reads them back from.
   *   * **The ceiling is re-checked inside the transaction.** `assessAvailability`
   *     answers from facts read a moment earlier, which is a classic
   *     time-of-check/time-of-use gap: two conversations routed to the same person in
   *     the same instant both see a load of two against a ceiling of three, and both
   *     assign. The advisory lock serialises capacity decisions per principal, so the
   *     second one sees the first one's hold. Without it, a ceiling is a suggestion.
   *
   * A refusal is NOT an error. It means the router should queue instead, which is a
   * perfectly good outcome — the alternative, erroring, would drop the conversation.
   */
  async assignFromRouting(input: {
    queueEntryId: UUID;
    principalId: UUID;
    episodeId: UUID;
    reservationId: UUID;
    weight: number;
    ttlSeconds: number;
    reason: string;
    at: Timestamp;
    /** See `claimConversation`. The sweep has none, so one is minted per placement. */
    correlationId?: string;
  }): Promise<
    | { ok: true; conversationId: UUID; reservationId: UUID }
    | { ok: false; reason: 'AT_CAPACITY' | 'NO_LONGER_WAITING' }
  > {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Serialises capacity decisions for THIS principal only — two routings to
      // different people never wait on each other. Transaction-scoped, so it is
      // released by COMMIT or ROLLBACK and cannot be leaked by an early return.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `capacity:${input.principalId}`,
      ]);

      const capacity = await client.query(
        `SELECT ${effectiveCapacityUnits('$1')} AS ceiling,
                COALESCE((SELECT sum(r.weight)::int
                            FROM conversation.reservations r
                           WHERE r.principal_id = $1::uuid
                             AND r.released_at IS NULL
                             AND r.expires_at > $2), 0) AS held`,
        [input.principalId, input.at],
      );
      const ceiling = capacity.rows[0].ceiling as number | null;
      const held = capacity.rows[0].held as number;

      // No configured ceiling means NO ceiling — not a ceiling of zero, which would
      // make every employee permanently unavailable. The policy is D-05 and unanswered;
      // absence of an answer must not become an answer.
      if (ceiling !== null && held + input.weight > ceiling) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'AT_CAPACITY' };
      }

      const claimed = await client.query(
        `UPDATE conversation.queue_entries
            SET state = 'CLAIMED', claimed_by = $2, claimed_at = $3
          WHERE queue_entry_id = $1 AND state = 'WAITING'
          RETURNING conversation_id, case_id`,
        [input.queueEntryId, input.principalId, input.at],
      );

      if (claimed.rowCount === 0) {
        // An agent pulled it from the queue view between the enqueue and this update.
        // Rare, entirely legitimate, and the right answer is to leave it with them.
        await client.query('ROLLBACK');
        return { ok: false, reason: 'NO_LONGER_WAITING' };
      }

      const conversationId = claimed.rows[0].conversation_id as UUID;
      await this.openEpisodeIn(client, {
        episodeId: input.episodeId,
        conversationId,
        caseId: claimed.rows[0].case_id ?? undefined,
        ownerId: input.principalId,
        assignmentSource: 'ROUTED',
        reason: input.reason,
        at: input.at,
      });

      // Same transaction as the claim and the ceiling check. A hold written afterwards
      // could fail on its own and leave an assignment consuming no capacity — which is
      // how a ceiling silently stops being enforced.
      await client.query(
        `INSERT INTO conversation.reservations
           (reservation_id, principal_id, ref_system, ref_type, ref_id, weight,
            effective_from, expires_at)
         VALUES ($1,$2,'LOCAL','conversation',$3,$4,$5, $5::timestamptz + make_interval(secs => $6))`,
        [
          input.reservationId,
          input.principalId,
          conversationId,
          input.weight,
          input.at,
          input.ttlSeconds,
        ],
      );

      // The routed path needs this as much as the claimed one — more so, since it is the
      // path the router uses for every conversation nobody picks up by hand. Before the
      // `service_cases` write, per the lock-ordering note in `reassign`.
      await this.ensureOwnerParticipantIn(client, {
        conversationId,
        principalId: input.principalId,
        addedBy: input.principalId,
        at: input.at,
        /**
         * The router, not a person. This is the path the council found unaudited, and it is
         * the ordinary one — every customer conversation nobody claims by hand is placed
         * here. `SYSTEM` with no actor id is the accurate answer; naming the assignee as
         * the actor would say they granted themselves access, which is not what happened.
         */
        grantedBy: {
          actorKind: 'SYSTEM',
          reason: input.reason,
          // The conversation, not a fresh UUID: §31.5 joins the ledger on this column and
          // a minted value joins to nothing. This is the majority path — most rows in the
          // table come from here — so it is the one that most needs to be reconstructible.
          correlationId: input.correlationId ?? conversationId,
        },
      });

      await client.query(
        `UPDATE conversation.service_cases sc
            SET current_owner_id = $2, updated_at = $3
           FROM conversation.conversations c
          WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
        [conversationId, input.principalId, input.at],
      );

      // §21.4's `new → assigned` / `queued → assigned`, by the router rather than a
      // person -- so `entered_by` stays NULL (migration 0006: "NULL for a system
      // transition ... inventing one would put a person's name against something nobody
      // did").
      await advanceStateIn(client, {
        conversationId,
        from: ASSIGNABLE_FROM,
        to: 'ASSIGNED',
        at: input.at,
        reason: 'assigned by routing',
      });

      await client.query('COMMIT');
      return { ok: true, conversationId, reservationId: input.reservationId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Queue depth and waiting age for every team that has work, in one query.
   *
   * One query rather than one per team on purpose: the caller is a scrape publisher on
   * a timer, and a fan-out over teams turns a cheap gauge into a load source that grows
   * with the organisation.
   *
   * A team with an empty queue is absent from the result rather than reported as zero.
   * That is the honest shape for a snapshot — the publisher decides whether a missing
   * team means "nothing waiting" or "no such team", and it has the roster to tell them
   * apart. Inventing rows here would not.
   */
  async queueDepthByTeam(
    at: Timestamp,
  ): Promise<readonly { teamId: string; priority: string; waiting: number; oldestSeconds: number }[]> {
    const result = await this.pool.query(
      `SELECT team_id,
              priority,
              count(*)::int AS waiting,
              COALESCE(EXTRACT(EPOCH FROM ($1::timestamptz - min(enqueued_at))), 0)::int AS oldest
         FROM conversation.queue_entries
        WHERE state = 'WAITING'
        GROUP BY team_id, priority`,
      [at],
    );
    return result.rows.map((row) => ({
      teamId: row.team_id as string,
      priority: row.priority as string,
      waiting: row.waiting as number,
      // A clock-skew guard, not a cosmetic one: `at` comes from the application and
      // `enqueued_at` may have been written by either clock. A negative age would read
      // as a queue item from the future (ADR-025).
      oldestSeconds: Math.max(0, row.oldest as number),
    }));
  }

  /**
   * Open customer conversations with no live ownership episode.
   *
   * Not the same as queue depth: an item can be out of the queue and still unowned —
   * a released reservation, a transfer that half-completed. §32.3 watches this because
   * work nobody owns is work nobody is looking at.
   */
  async unassignedConversationCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n
         FROM conversation.conversations c
        WHERE c.conversation_type = 'CUSTOMER_SERVICE'
          AND c.state NOT IN ('RESOLVED','CLOSED')
          AND NOT EXISTS (
            SELECT 1 FROM conversation.ownership_episodes oe
             WHERE oe.conversation_id = c.conversation_id AND oe.effective_to IS NULL
          )`,
    );
    return result.rows[0].n as number;
  }

  /**
   * Makes the new owner a PARTICIPANT, in the caller's transaction.
   *
   * ## Why ownership is not enough on its own
   *
   * Ownership lives in `ownership_episodes` and the cached `service_cases.current_owner_id`.
   * The employee inbox does not read either: `listForPrincipal` INNER JOINs
   * `conversation.participants`. So every path that granted ownership without a
   * participant row produced a conversation that was genuinely the agent's and appeared in
   * no list they could see.
   *
   * The claim path was the visible instance — claim from the queue, and the sidebar still
   * reads "Nothing here yet"; reload and the conversation is gone from the list AND from
   * the queue, because the queue view filters `state = 'WAITING'` and the claim just
   * changed it. But `assignFromRouting` and `reassign` had the same omission, and
   * `assignFromRouting` is the path the router uses — which became the DEFAULT path the
   * moment `SL_ADAPTER_WORK_ORCHESTRATOR` stopped defaulting to the in-memory mock. Fixing
   * only the claim would have left the common case broken.
   *
   * ## Two details that are load-bearing
   *
   * **`reply_authority = true`.** An owner may reply to the customer, and `decide()` reads
   * that from participation for the participant branch. Writing the row without it would
   * produce an owner who can see the conversation and not answer it.
   *
   * **`DO UPDATE` revives a dated row rather than conflicting.** A previous owner who was
   * removed, or an earlier participation that was ended, leaves a row on the composite
   * primary key. Without the upsert the second assignment throws and the whole transfer
   * rolls back.
   *
   * ## Why `effective_from` is written only when the row was dead
   *
   * The table is keyed (conversation_id, principal_id), so there is exactly ONE period per
   * pair and overwriting its start erases history. A colleague who joined in March and is
   * handed ownership in August would have their participation recorded as beginning in
   * August — and "could they read this on 5 March?" would answer no. That is BR-09's
   * question, and it is the kind asked in an audit rather than in a bug report.
   *
   * The first version of this upsert set it unconditionally, which was harmless while the
   * only caller was an explicit re-add and became ordinary the moment claim and transfer
   * started using it. A genuinely re-added participant does still need a new start date, so
   * the CASE applies it only where the row had been dated out.
   *
   * (The SQL below carries a one-line comment rather than this explanation because a
   * backtick inside a template literal terminates the string — see CLAUDE.md.)
   */
  private async ensureOwnerParticipantIn(
    client: pg.PoolClient,
    input: {
      conversationId: UUID;
      principalId: UUID;
      addedBy: UUID;
      at: Timestamp;
      /**
       * Who granted this participation, for the ledger.
       *
       * Required, not optional. §31.1 puts participation changes in the audited set because
       * they change who may read prior history, and the one path that granted them without
       * a record — the routing sweep — was invisible precisely because nothing forced the
       * question. A required argument makes the next ownership path answer it too.
       *
       * `SYSTEM` with no `actorId` is the honest answer for the router: migration 0006 says
       * the same thing about `entered_by` — "inventing one would put a person's name
       * against something nobody did".
       */
      grantedBy: { actorId?: UUID; actorKind: 'EMPLOYEE' | 'SYSTEM'; reason: string; correlationId: string };
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, reply_authority, added_by,
          effective_from, added_at)
       VALUES ($1,$2,'EMPLOYEE','OWNER',true,$3,$4,$4)
       ON CONFLICT (conversation_id, principal_id)
       DO UPDATE SET effective_to = NULL,
                     -- Only a DEAD row gets a new start date. See the note above.
                     effective_from = CASE
                       WHEN conversation.participants.effective_to IS NULL
                         THEN conversation.participants.effective_from
                       ELSE $4
                     END,
                     role = 'OWNER',
                     reply_authority = true,
                     added_by = EXCLUDED.added_by`,
      [input.conversationId, input.principalId, input.addedBy, input.at],
    );

    // Kept consistent the same way `addParticipant` does it — recounted rather than
    // incremented, so a revived row cannot double-count.
    await client.query(
      `UPDATE conversation.conversations
          SET participant_count = (SELECT count(*) FROM conversation.participants
                                    WHERE conversation_id = $1 AND effective_to IS NULL)
        WHERE conversation_id = $1`,
      [input.conversationId],
    );

    /**
     * The ledger row, in the SAME transaction as the grant it describes.
     *
     * ## Why here and not through `AuditWriter`
     *
     * `AuditWriter` holds its own pool, so its writes commit independently of the action
     * they record. That is fine for a controller recording something it has already done —
     * and it is the wrong shape here, because this grant happens on three paths and the one
     * that matters most has no controller at all: the routing sweep places conversations
     * with no request, no session and no correlation id, so nothing was written and "who was
     * given access to this conversation, when, and on what basis" was unanswerable from the
     * ledger for the majority of conversations. For an IRDAI-audited insurer holding claims
     * and medical content, that is the question the ledger exists for.
     *
     * Writing it on the caller's client makes the two atomic in both directions: a failed
     * ledger write aborts the transaction, so a grant is never made without a record (§31.5
     * fail-closed, not weakened — strengthened, because `AuditWriter` without `mustSucceed`
     * would have let it through); and a rolled-back placement takes its ledger row with it,
     * so there is never a record of access that was not granted.
     *
     * The action is `conversation.participant.add` — the same one
     * `conversations.controller.ts` records for a manual add, because it is the same act.
     * It does NOT replace the `conversation.claim` / `conversation.transfer` rows those
     * paths already write: those say what a person did, this says who can now read what.
     */
    await client.query(
      `INSERT INTO audit.ledger
         (event_id, actor_id, actor_kind, action, target_kind, target_id, outcome, reason,
          correlation_id, detail)
       VALUES (gen_random_uuid(), $1, $2, 'conversation.participant.add', 'conversation', $3,
               'SUCCEEDED', $4, $5, $6::jsonb)`,
      [
        input.grantedBy.actorId ?? null,
        input.grantedBy.actorKind,
        input.conversationId,
        input.grantedBy.reason,
        input.grantedBy.correlationId,
        JSON.stringify({ addedPrincipal: input.principalId, role: 'OWNER' }),
      ],
    );
  }

  private async openEpisodeIn(
    client: pg.PoolClient,
    input: {
      episodeId: UUID;
      conversationId: UUID;
      caseId?: UUID;
      ownerId: UUID;
      assignmentSource: AssignmentSource;
      at: Timestamp;
      reason?: string;
      assignedBy?: UUID;
      previousOwner?: UUID;
    },
  ): Promise<OwnershipEpisode> {
    const result = await client.query(
      `INSERT INTO conversation.ownership_episodes
         (episode_id, conversation_id, case_id, owner_id, effective_from, reason,
          assigned_by, assignment_source, previous_owner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING episode_id, conversation_id, owner_id, effective_from, effective_to,
                 assignment_source, reason, previous_owner`,
      [
        input.episodeId,
        input.conversationId,
        input.caseId ?? null,
        input.ownerId,
        input.at,
        input.reason ?? null,
        input.assignedBy ?? null,
        input.assignmentSource,
        input.previousOwner ?? null,
      ],
    );
    return toEpisode(result.rows[0]);
  }
}

function toEpisode(row: Record<string, unknown>): OwnershipEpisode {
  return {
    episodeId: row.episode_id as UUID,
    conversationId: row.conversation_id as UUID,
    ownerId: row.owner_id as UUID,
    effectiveFrom: (row.effective_from as Date).toISOString() as Timestamp,
    ...(row.effective_to !== null
      ? { effectiveTo: (row.effective_to as Date).toISOString() as Timestamp }
      : {}),
    assignmentSource: row.assignment_source as AssignmentSource,
    ...(row.reason !== null ? { reason: row.reason as string } : {}),
    ...(row.previous_owner !== null ? { previousOwner: row.previous_owner as UUID } : {}),
  };
}
