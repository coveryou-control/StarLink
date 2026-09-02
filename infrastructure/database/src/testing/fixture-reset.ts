/**
 * Removing a test team's fixture data, including rows an interrupted run left behind.
 *
 * ## The failure this exists to stop
 *
 * Every database suite in this repository cleans up by the ids its own process recorded.
 * That works exactly until a run is interrupted — Ctrl-C, a killed worker, a throw inside
 * `beforeAll` — after which rows survive whose ids no later process knows. They then hold
 * foreign keys against the team and the principals for ever, and **every subsequent run
 * fails in teardown** with a constraint violation that has nothing to do with what it was
 * testing.
 *
 * That failure is worse than it sounds, because of where it lands. The tests all pass;
 * the suite fails afterwards; the reported error names `service_cases` and a foreign key.
 * It reads as a code regression, it is not one, and the shared development database
 * (CLAUDE.md) makes it everybody's problem rather than one developer's. It cost an hour
 * on 2026-08-28 before the cause was clear.
 *
 * ## Why the team is the handle
 *
 * A test team id is a constant in the test file, so it is the one identifier that
 * survives the process that created it. Everything else — case ids, conversation ids,
 * episode ids — is minted per run and lost with it.
 *
 * ## Why the table list is written out
 *
 * Only four of the thirteen tables referencing `conversations` cascade. The other nine
 * must be deleted first, in order, and the list is spelled out rather than derived from
 * `information_schema` so that a reader can see what is being removed. It is ordered
 * leaf-first: `attachments` before `messages`, because an attachment references the
 * message it was sent on.
 *
 * A table added later and omitted here surfaces as a foreign-key error naming the missing
 * table, which is a loud failure with the answer in it — the right direction for a test
 * helper to fail in.
 */
import type pg from 'pg';

/**
 * Tables referencing `conversation.conversations` with `ON DELETE NO ACTION`, leaf-first.
 *
 * The four that cascade — `case_state_episodes`, `participants`, `read_state`,
 * `sla_notifications` — are deliberately absent: deleting the conversation takes them.
 */
const CONVERSATION_CHILDREN = [
  'attachments',
  'messages',
  'business_links',
  'channel_bindings',
  'escalation_events',
  'ownership_episodes',
  'queue_entries',
  'temporary_access_grants',
  'transfer_events',
] as const;

/**
 * Deletes every conversation and case belonging to `teamId`, and the team's queue.
 *
 * Safe to call when there is nothing to remove, and safe to call from a teardown that
 * has already deleted its own rows by id — the second pass simply matches nothing.
 *
 * Principals and the team row itself are NOT removed: which principals a suite owns is
 * the suite's own business, and this cannot know whether an id belongs to it. Call this
 * before deleting them and the foreign keys will be clear.
 */
export async function resetTeamFixtures(pool: pg.Pool, teamId: string): Promise<void> {
  /**
   * One transaction, with the conversations LOCKED, because the routing sweep races this.
   *
   * The cleanup used to run as a series of separate statements on the pool: select the
   * ids, delete the children (queue entries among them), delete three kinds of outbox
   * row, then delete the conversations. Four round trips separate the queue-entry delete
   * from the conversation delete — and `playwright.config.ts` runs the routing sweep every
   * ONE second, so a conversation cleaned in step two could be re-enqueued before step
   * five ran. The teardown then died with
   *
   *     update or delete on table "conversations" violates foreign key constraint
   *     "queue_entries_conversation_id_fkey" on table "queue_entries"
   *
   * which is what it looks like when a fixture and a live background job disagree about
   * who owns a row. It surfaced on a different spec file each time — whichever happened to
   * be resetting when the sweep fired — which is exactly why it read as flake.
   *
   * `FOR UPDATE` closes the window rather than narrowing it. A foreign-key check from the
   * sweep's own transaction takes `FOR KEY SHARE` on the parent conversation row, and that
   * conflicts with `FOR UPDATE` — so the sweep BLOCKS until this commits, then fails its
   * insert against a conversation that no longer exists. That failure is caught by the
   * per-item handler in `routing.sweep.ts`, costs that one placement, and leaves the rest
   * of its batch alone.
   */
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resetWithin(client, teamId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resetWithin(pool: pg.PoolClient, teamId: string): Promise<void> {
  const conversations = await pool.query<{ conversation_id: string }>(
    `SELECT c.conversation_id
       FROM conversation.conversations c
       JOIN conversation.service_cases sc ON sc.case_id = c.case_id
      WHERE sc.owning_team_id = $1
        FOR UPDATE OF c`,
    [teamId],
  );
  const ids = conversations.rows.map((row) => row.conversation_id);

  if (ids.length > 0) {
    /**
     * Scan verdicts, before the attachments they are verdicts about.
     *
     * `attachment_scan_results` references `attachments` rather than `conversations`, so it
     * is a grandchild and the loop below cannot reach it. It went unnoticed until the
     * browser suite began uploading a file — no e2e had ever created an attachment, so no
     * teardown had ever needed this. It failed exactly as the note above predicts: every
     * test passed, teardown raised `23503`, and the error named the table to add.
     */
    await pool.query(
      `DELETE FROM conversation.attachment_scan_results
        WHERE attachment_id IN (
          SELECT attachment_id FROM conversation.attachments
           WHERE conversation_id = ANY($1::uuid[])
        )`,
      [ids],
    );

    for (const table of CONVERSATION_CHILDREN) {
      await pool.query(
        `DELETE FROM conversation.${table} WHERE conversation_id = ANY($1::uuid[])`,
        [ids],
      );
    }
    await pool.query(
      `DELETE FROM conversation.outbox
        WHERE aggregate_type = 'conversation' AND aggregate_id = ANY($1::uuid[])`,
      [ids],
    );
    /**
     * Notification events are aggregated by PRINCIPAL, not by conversation, so the clause
     * above cannot see them — but their payload names the conversation they are about, and
     * that is derivable.
     *
     * Added 2026-08-29 after `notification.created.v1` and `conversation.queue.arrived.v1`
     * started being emitted (N-27): 187 rows accumulated across one verification run and
     * the relay's own test then failed, because its freshly-seeded row fell outside a
     * hundred-row drain batch full of other suites' leavings. The tests were all correct;
     * the fixtures were not cleaning up after a new write.
     */
    await pool.query(
      `DELETE FROM conversation.outbox
        WHERE aggregate_type = 'principal'
          AND payload->>'targetRef' = ANY($1::text[])`,
      [ids],
    );
    await pool.query(
      `DELETE FROM conversation.notification_outbox WHERE target_ref = ANY($1::text[])`,
      [ids],
    );
    await pool.query(
      `DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`,
      [ids],
    );
  }

  // A queue entry can outlive its conversation only if the fixture made one directly,
  // which several do. Removed by team, for the same reason as everything else here.
  await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [teamId]);

  /**
   * Cases last. A case with no conversation is invisible to every product query and
   * still counts against `countInactiveOwnerConversations`, which reads `service_cases`
   * directly — so a leaked case is exactly what makes §32.3's zero-invariant gauge
   * report a non-zero value in an unrelated suite.
   */
  await pool.query(`DELETE FROM conversation.service_cases WHERE owning_team_id = $1`, [teamId]);
}
