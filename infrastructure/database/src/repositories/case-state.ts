/**
 * Advancing a conversation through §21.4's ARRIVAL states, and recording the history.
 *
 * ## What was missing
 *
 * §21.4's table has seven states and the product only ever wrote three of them. Intake
 * created `NEW`; `reopenOnReply` and `PgCaseStore` wrote `ACTIVE`, `RESOLVED` and
 * `CLOSED`. **Nothing ever wrote `QUEUED` or `ASSIGNED`**, and nothing moved a conversation
 * out of `NEW` on the way in — so a real conversation stayed `NEW` from intake until
 * somebody resolved it.
 *
 * Which they could not do. `transition()` refuses `NEW → RESOLVED`, because §21.4 has no
 * such row: resolution is only reachable from `ACTIVE`, `WAITING_CUSTOMER` or
 * `WAITING_INTERNAL`. So the resolve endpoint built for BR-19 was unreachable on any
 * conversation the product had actually created. Its tests passed because they seeded
 * `ACTIVE` directly — the same "a test that manufactures the state it exercises cannot
 * notice nothing upstream produces it" trap that hid the missing resolve path itself.
 * Golden test G-15, walking the whole workflow, is what surfaced it.
 *
 * ## Why this is one helper and not five call sites
 *
 * Four writers move a conversation forward — enqueue, claim, routed assignment, and the
 * owner's first customer-visible reply — and each has to do the same three things: move
 * the row conditionally, close the open episode, open the next one at the same instant.
 * `case_state_no_overlap` (migration 0006) rejects a gap or an overlap, so getting the
 * episode pair wrong is not a subtle bug, it is a failed write on an unrelated path later.
 * Written once, it is right once.
 */
import type pg from 'pg';
import type { ConversationState, Timestamp, UUID } from '@starlink/shared-contracts';

export interface AdvanceStateInput {
  readonly conversationId: UUID;
  /**
   * The states this move is permitted FROM, per §21.4.
   *
   * A list rather than one value because the arrival moves legitimately have several
   * sources — a conversation can be assigned straight from `NEW` (routed on arrival) or
   * from `QUEUED` (claimed off a queue), and §21.4 has a row for each.
   *
   * It is also the concurrency guard. The update matches nothing if the conversation has
   * moved on, which is the correct outcome for every racing writer here: a customer's
   * reply reviving a resolved thread must not be undone by a claim that was in flight.
   */
  readonly from: readonly ConversationState[];
  readonly to: ConversationState;
  readonly at: Timestamp;
  /** NULL for a system move (routing, after-hours queueing) — migration 0006's rule. */
  readonly enteredBy?: UUID;
  readonly reason?: string;
}

/**
 * Moves the conversation and records the episode, in the caller's transaction.
 *
 * Returns whether the move happened. `false` is a normal answer, not an error: it means
 * the conversation was not in one of the `from` states, so somebody else moved it first.
 *
 * Takes a `PoolClient` rather than a pool ON PURPOSE. Every caller is already inside a
 * transaction that must include this — a claim that committed without its state change
 * would leave an owner who cannot act, which is precisely the defect this file exists to
 * fix. Accepting a pool would make it possible to call this outside one.
 */
export async function advanceStateIn(
  client: pg.PoolClient,
  input: AdvanceStateInput,
): Promise<boolean> {
  const moved = await client.query(
    `UPDATE conversation.conversations
        SET state = $3, updated_at = $4
      WHERE conversation_id = $1
        AND state = ANY($2::conversation.conversation_state[])`,
    [input.conversationId, input.from, input.to, input.at],
  );
  if (moved.rowCount === 0) return false;

  /**
   * The case row carries the same state (§22.3). Kept in step here rather than by a
   * trigger so the two are visibly one write — `reopenOnReply` and `PgCaseStore` already
   * maintain both, and a third convention would be the drift.
   */
  await client.query(
    `UPDATE conversation.service_cases sc
        SET state = $2, updated_at = $3
       FROM conversation.conversations c
      WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
    [input.conversationId, input.to, input.at],
  );

  // Close the open episode and open the next at the SAME instant: no gap, no overlap.
  // The SLA clock reads its pause spans straight from this series (§23.5, §24.11).
  await client.query(
    `UPDATE conversation.case_state_episodes
        SET effective_to = $2
      WHERE conversation_id = $1 AND effective_to IS NULL`,
    [input.conversationId, input.at],
  );
  await client.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from, entered_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      crypto.randomUUID(),
      input.conversationId,
      input.to,
      input.at,
      input.enteredBy ?? null,
      input.reason ?? null,
    ],
  );

  return true;
}

/**
 * States a conversation may be assigned FROM (§21.4's `new → assigned`, `queued →
 * assigned`).
 *
 * `ASSIGNED` is deliberately absent: re-assigning an already-assigned conversation is a
 * TRANSFER, which is an event with its own reason and audit (§21.4 is explicit that
 * transfer is not a state), and routing it through here would bypass both.
 */
export const ASSIGNABLE_FROM: readonly ConversationState[] = Object.freeze(['NEW', 'QUEUED']);
