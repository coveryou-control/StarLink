/**
 * A customer replying to a conversation they thought was finished (BR-21, BR-22, §22.4).
 *
 * The rules are settled and only the window length is not (D-08):
 *
 *   BR-21 — "A reply inside the reopen window reopens the same thread to the same owner"
 *   BR-22 — "After the window, a new conversation is created with prior history linked
 *            for staff"
 *
 * The decision itself is a pure function in `@starlink/service-case`; what lives here is
 * the writing. Two things it is careful about:
 *
 * **The customer is told nothing.** §21.4's last transition row — a reply arriving after
 * the window — reads "No — it simply continues." From their side this is one continuous
 * relationship, and the split exists so the organisation can measure two pieces of work
 * honestly. A response that announced "we have opened a new conversation" would leak an
 * internal boundary and invite a question nobody needs to answer.
 *
 * **A departed owner does not inherit.** BR-21 says the same owner, but BR-13 says a
 * deactivated principal cannot own work, and reopening onto one would recreate exactly
 * the unreachable work §32.3 monitors with a target of zero. The owner is carried over
 * only if they are still active; otherwise the conversation reopens unowned and the
 * routing sweep places it like any other waiting work.
 */
import type pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { decideReopen, type ReopenDecision } from '@starlink/service-case';

export interface ReopenOutcome {
  /** Where the customer's message should be written. */
  readonly conversationId: UUID;
  readonly decision: ReopenDecision['outcome'];
}

/**
 * Applies BR-21/BR-22 before a customer's message is written.
 *
 * Returns the conversation the message belongs to — the same one when it reopens, a new
 * one when the window has passed. Callers write the message afterwards, so the message
 * itself is never duplicated across the two.
 */
export async function reopenOnReply(
  pool: pg.Pool,
  requestedId: UUID,
  /**
   * The replying customer. Required, and used as a predicate rather than for a comparison
   * afterwards — see the join below.
   */
  principalId: UUID,
  windowSeconds: number,
  at: Timestamp,
  newId: () => UUID,
): Promise<ReopenOutcome> {
  /**
   * A conversation that has already been forked is not the place to write (BR-22).
   *
   * ## The defect this closes
   *
   * `forkConversation` clears `resolved_at` on the SHARED case — it has to, because the
   * case is being worked again. But the OLD conversation keeps `state = 'RESOLVED'`, and
   * the two facts together are read by this function as "resolved, but never resolved":
   * the head query finds the row, the RESOLVED gate passes, and `decideReopen` sees no
   * `resolvedAt` and answers STILL_OPEN. The caller then writes the customer's message
   * into the conversation that was superseded — which no queue contains, and which the
   * closure sweep can never close, because that sweep keys on the `resolved_at` the fork
   * has just cleared.
   *
   * The customer sees a thread they are talking into and nobody is reading. Two live
   * threads on one case, and their words in the wrong one.
   *
   * ## Why redirect rather than re-fork
   *
   * The successor already exists and the customer is already a participant of it — the
   * fork copies participation precisely so they can read it. Forking again would make a
   * third conversation for one continuous exchange, and `reopen_count` would count a
   * reopen that never happened.
   *
   * The link is followed rather than inferred from dates, because dates are what got this
   * wrong the first time: `business_links(relation = 'CONTINUES')` is a fact the fork
   * wrote down, and it stays true however the case's timestamps are later edited.
   */
  const conversationId = await latestSuccessorOf(pool, requestedId);
  /**
   * Scope is the query (§30.2), on the mutating path as much as on a read.
   *
   * This SELECT used to be `WHERE c.conversation_id = $1` alone, with a comment asserting
   * that "the caller's authorization has already run". It had not: the only `decide()` on
   * the customer send path lives in `sendMessage`, which runs AFTER this function, and both
   * of the write paths below commit on their own connection. A stranger's reply therefore
   * mutated a real customer's case and then received a 404.
   *
   * The controller now checks participation before calling. This join is the second layer,
   * and it is here rather than only there because the failure was one of ORDER, and an
   * ordering guarantee that lives entirely in the caller is one edit away from being wrong
   * again. A non-participant now finds no row and this function does nothing at all.
   */
  const head = await pool.query(
    `SELECT c.state, c.case_id, c.title, c.customer_ref, sc.resolved_at, sc.current_owner_id,
            owner.status AS owner_status
       FROM conversation.conversations c
       JOIN conversation.participants p
         ON p.conversation_id = c.conversation_id
        AND p.principal_id = $2
        AND p.effective_from <= $3
        AND (p.effective_to IS NULL OR p.effective_to > $3)
       LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
       LEFT JOIN identity.principals owner ON owner.principal_id = sc.current_owner_id
      WHERE c.conversation_id = $1`,
    [conversationId, principalId, at],
  );

  const row = head.rows[0];
  // No row means either "no such conversation" or "not yours" — deliberately the same
  // outcome, and the same "no such thing" the send path goes on to report (§27.3).
  if (row === undefined) return { conversationId, decision: 'STILL_OPEN' };

  const state = row.state as string;
  if (state !== 'RESOLVED' && state !== 'CLOSED') {
    return { conversationId, decision: 'STILL_OPEN' };
  }

  const decision = decideReopen(
    {
      conversationId,
      ...(row.case_id !== null ? { caseId: row.case_id as UUID } : {}),
      ...(row.resolved_at !== null
        ? { resolvedAt: (row.resolved_at as Date).toISOString() as Timestamp }
        : {}),
      ...(row.current_owner_id !== null ? { ownerId: row.current_owner_id as UUID } : {}),
    },
    { windowSeconds },
    at,
  );

  // A CLOSED conversation is terminal (§21.4) whatever the arithmetic says. The window
  // and the state can disagree if the window was lengthened after a case was closed, and
  // the state wins — reviving a closed conversation would undo a boundary already drawn.
  if (state === 'CLOSED' && decision.outcome === 'REOPEN_SAME_THREAD') {
    return {
      conversationId: await forkConversation(pool, conversationId, row, at, newId),
      decision: 'NEW_CONVERSATION_SAME_CASE',
    };
  }

  if (decision.outcome === 'REOPEN_SAME_THREAD') {
    await reviveInPlace(pool, conversationId, row, at);
    return { conversationId, decision: 'REOPEN_SAME_THREAD' };
  }

  if (decision.outcome === 'NEW_CONVERSATION_SAME_CASE') {
    return {
      conversationId: await forkConversation(pool, conversationId, row, at, newId),
      decision: 'NEW_CONVERSATION_SAME_CASE',
    };
  }

  return { conversationId, decision: 'STILL_OPEN' };
}

/**
 * Follows `CONTINUES` links forward to the conversation that superseded this one.
 *
 * Returns the argument unchanged when nothing has superseded it, which is the ordinary
 * case and costs one indexed lookup.
 *
 * The loop is BOUNDED. A cycle in `business_links` — two rows each claiming to continue
 * the other, which nothing in the schema forbids — would otherwise hang the customer send
 * path forever, and a hang on the send path is worse than any wrong answer this function
 * could give. Sixteen is far beyond any real chain: each hop is a customer coming back
 * after a full reopen window had passed.
 */
async function latestSuccessorOf(pool: pg.Pool, conversationId: UUID): Promise<UUID> {
  let current = conversationId;

  for (let hop = 0; hop < 16; hop += 1) {
    const next = await pool.query(
      `SELECT conversation_id
         FROM conversation.business_links
        WHERE ref_system = 'LOCAL' AND ref_type = 'conversation'
          AND relation = 'CONTINUES' AND ref_id = $1::text
        ORDER BY effective_from DESC
        LIMIT 1`,
      [current],
    );

    const successor = next.rows[0]?.conversation_id as UUID | undefined;
    // `successor === current` is a self-link; treated as "no successor" rather than as an
    // error, because refusing the send would cost the customer their message over a bad
    // row they cannot see and did not cause.
    if (successor === undefined || successor === current) return current;
    current = successor;
  }

  return current;
}

/** BR-21: the same thread, back to ACTIVE, to the same owner if they can still hold it. */
async function reviveInPlace(
  pool: pg.Pool,
  conversationId: UUID,
  row: Record<string, unknown>,
  at: Timestamp,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Conditional on RESOLVED, so a closure sweep running in the same instant cannot
    // close it underneath the customer — whichever lands second matches nothing.
    const revived = await client.query(
      `UPDATE conversation.conversations
          SET state = 'ACTIVE', updated_at = $2, last_activity_at = $2
        WHERE conversation_id = $1 AND state = 'RESOLVED'`,
      [conversationId, at],
    );
    if (revived.rowCount === 0) {
      await client.query('ROLLBACK');
      return;
    }

    /**
     * The resolution is UNDONE, and the reopen counted.
     *
     * `resolved_at` must be cleared or the resolution clock would stay stopped at a time
     * in the past while the case is open again, and the closure sweep would close it
     * immediately. `reopen_count` is incremented because §22.3 lists it on the case and
     * it is the number that shows a case being reopened repeatedly — which is a signal
     * about the quality of the resolution, not about the customer.
     */
    await client.query(
      `UPDATE conversation.service_cases
          SET state = 'ACTIVE', resolved_at = NULL, outcome_code = NULL,
              reopen_count = reopen_count + 1, updated_at = $2,
              current_owner_id = $3
        WHERE case_id = $1`,
      [
        row.case_id,
        at,
        // BR-21's "same owner", unless BR-13 forbids it. A deactivated owner is dropped
        // and the routing sweep places the conversation like any other waiting work.
        row.owner_status === 'ACTIVE' ? row.current_owner_id : null,
      ],
    );

    /**
     * A dropped owner's ownership EPISODE is closed too, not just the case pointer.
     *
     * Setting `current_owner_id = NULL` above while the episode stays open produces a
     * conversation that is owned and unowned at once, depending on which source you ask —
     * and the two consumers that matter disagree in the worst possible direction. The
     * routing sweep skips anything holding a live episode, so it never places the
     * conversation; `InactiveOwnerSweep` joins through `current_owner_id`, which is now
     * NULL, so it never counts it either. The conversation is ACTIVE, in no queue, owned
     * by a departed employee, and `inactive_owner_open_conversations` reads zero — rule 7
     * broken and its own detector blinded.
     */
    if (row.owner_status !== 'ACTIVE') {
      await client.query(
        `UPDATE conversation.ownership_episodes
            SET effective_to = $2
          WHERE conversation_id = $1 AND effective_to IS NULL`,
        [conversationId, at],
      );
    }

    await closeAndOpenEpisode(client, conversationId, 'ACTIVE', at, 'reopened by customer reply');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * BR-22: a new conversation against the SAME case, with the previous one linked.
 *
 * The case is deliberately reused rather than recreated — §22.4's whole point is that one
 * case spans many conversations, so a customer coming back about the same problem does
 * not become a second, unrelated piece of work.
 */
async function forkConversation(
  pool: pg.Pool,
  previousId: UUID,
  row: Record<string, unknown>,
  at: Timestamp,
  newId: () => UUID,
): Promise<UUID> {
  const conversationId = newId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, customer_ref, title, state,
          last_activity_at, participant_count, created_at, updated_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,$3,$4,'NEW',$5,1,$5,$5)`,
      [conversationId, row.case_id, row.customer_ref, row.title, at],
    );

    // Everyone who was on the previous conversation carries over, effective now. Without
    // this the customer could not read their own new conversation — participation is what
    // authorizes, and a fork with no participants is invisible to the person who caused it.
    await client.query(
      `INSERT INTO conversation.participants
         (conversation_id, principal_id, principal_kind, role, reply_authority, added_by, effective_from)
       SELECT $1, p.principal_id, p.principal_kind, p.role, p.reply_authority, p.added_by, $2
         FROM conversation.participants p
        WHERE p.conversation_id = $3
          AND p.effective_from <= $2
          AND (p.effective_to IS NULL OR p.effective_to > $2)
       ON CONFLICT (conversation_id, principal_id) DO NOTHING`,
      [conversationId, at, previousId],
    );

    /**
     * Recount, because the INSERT above wrote the literal 1.
     *
     * That literal was accidentally right while a customer conversation had exactly one
     * participant — the customer. Once the ownership paths began writing an OWNER row on
     * claim, every fork shipped a count of 1 against two or more live rows, and nothing
     * recounted until the next membership change. The employee inbox renders that number.
     *
     * Counted the same way `addParticipant` does it, from the rows themselves.
     */
    await client.query(
      `UPDATE conversation.conversations
          SET participant_count = (SELECT count(*) FROM conversation.participants
                                    WHERE conversation_id = $1 AND effective_to IS NULL)
        WHERE conversation_id = $1`,
      [conversationId],
    );

    // "with prior history linked for staff" (BR-22). The link is what lets an employee
    // see the earlier thread; the customer is shown nothing about it.
    await client.query(
      `INSERT INTO conversation.business_links
         (link_id, conversation_id, ref_system, ref_type, ref_id, relation, effective_from)
       VALUES ($1,$2,'LOCAL','conversation',$3,'CONTINUES',$4)
       ON CONFLICT DO NOTHING`,
      [newId(), conversationId, previousId, at],
    );

    /**
     * The case is worked again, and this is a reopen even though the thread is new.
     *
     * `current_owner_id` is re-decided here rather than left alone, and that is BR-13, not
     * tidiness. This file's header promises "a departed owner does not inherit", and only
     * `reviveInPlace` was keeping the promise — the fork left the case pointing at whoever
     * owned it before, ACTIVE or not. Since the same statement also moves the case back to
     * an OPEN state, a fork onto a leaver put the case straight into the population
     * `InactiveOwnerSweep` counts, which rule 7 requires to read zero.
     */
    await client.query(
      `UPDATE conversation.service_cases
          SET state = 'ACTIVE', resolved_at = NULL, outcome_code = NULL,
              reopen_count = reopen_count + 1, updated_at = $2,
              current_owner_id = $3
        WHERE case_id = $1`,
      [row.case_id, at, row.owner_status === 'ACTIVE' ? row.current_owner_id : null],
    );

    /**
     * The superseded conversation stops being owned.
     *
     * Ownership lives on the CONVERSATION as an episode and on the case as
     * `current_owner_id`, and the fork moves the work to a new conversation. Leaving the
     * old episode open makes the two disagree permanently: `PgCaseStore.head` and the
     * notification recipients read the episode and name the old owner, while `decide()`
     * reads the case and sees whoever this statement just set. Worse, the routing sweep
     * skips any conversation with a live episode, so an old conversation left owned by a
     * departed employee is invisible to every sweep at once — unplaceable by routing and
     * uncounted by the rule-7 metric, which joins through `current_owner_id`.
     */
    await client.query(
      `UPDATE conversation.ownership_episodes
          SET effective_to = $2
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [previousId, at],
    );

    await client.query(
      `INSERT INTO conversation.case_state_episodes
         (episode_id, conversation_id, state, effective_from, reason)
       VALUES ($1,$2,'NEW',$3,'continues a conversation whose reopen window had passed')`,
      [newId(), conversationId, at],
    );

    await client.query('COMMIT');
    return conversationId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Closes the live episode and opens the next at the same instant — no gap, no overlap. */
async function closeAndOpenEpisode(
  client: pg.PoolClient,
  conversationId: UUID,
  state: string,
  at: Timestamp,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE conversation.case_state_episodes
        SET effective_to = $2
      WHERE conversation_id = $1 AND effective_to IS NULL`,
    [conversationId, at],
  );
  await client.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [crypto.randomUUID(), conversationId, state, at, reason],
  );
}
