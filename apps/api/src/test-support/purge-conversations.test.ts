/**
 * The teardown helper is itself tested, because two versions of it shipped broken.
 *
 * A teardown that fails is not cosmetic: it stops partway, leaves the rows it had not
 * reached, and the next run inherits them. The suites using it assert on counts and on
 * "the only conversation for this team", so inherited rows do not produce a clean failure —
 * they produce a suite that passes until it doesn't, for reasons unrelated to the change
 * under test. That makes this helper load-bearing for the honesty of two other files, and
 * an untested load-bearing helper is what the first two versions were.
 *
 * Both defects it has had are reproduced here as cases, not as prose:
 *
 *   1. **Sibling order.** `attachments.message_id → messages` is a foreign key between two
 *      children of `conversations`. Deleting children in catalog order deleted `messages`
 *      first and failed on `attachments_message_id_fkey`.
 *   2. **Depth.** `message_revisions` and `attachment_scan_results` reference `messages` and
 *      `attachments`, not `conversations`, so a one-level scan could not see them at all —
 *      while the docblock claimed every child was covered "the day it is created".
 *
 * The fixture below builds the full three-level shape on purpose, so a future version that
 * regresses to one level, or that deletes siblings in the wrong order, fails here rather
 * than in some unrelated suite's `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';

import { purgeConversations } from './purge-conversations.js';

const CONNECTION =
  process.env['SL_DATABASE_URL'] ??
  'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** This file owns the `7e7e` id block, so it can never collide with another suite. */
const TEAM = 'purge-helper-team';
/** A second team, to prove the purge does not reach past the caller's predicate. */
const BYSTANDER = 'purge-helper-bystander';

let pool: pg.Pool | undefined;
let available = false;

beforeAll(async () => {
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 3 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    // `service_cases.owning_team_id` is a foreign key, so the fixture needs real teams.
    for (const team of [TEAM, BYSTANDER]) {
      await probe.query(
        `INSERT INTO identity.teams (team_id, display_name) VALUES ($1,$1)
         ON CONFLICT (team_id) DO NOTHING`,
        [team],
      );
    }
  } catch {
    await probe.end().catch(() => undefined);
    console.warn(
      '\n  ⚠ purge-conversations helper check SKIPPED: no PostgreSQL. The teardown used ' +
        'by customer-isolation and intake-burst is therefore UNPROVEN in this run.\n',
    );
  }
});

afterAll(async () => {
  if (pool !== undefined) {
    /**
     * Conversations first, then their cases — the ordering this whole file is about.
     *
     * The first version of this teardown deleted `service_cases` directly and failed the
     * run with `conversations_case_id_fkey`, which is the same defect class the helper
     * under test exists to remove, committed in the test for it. It passed when this file
     * ran alone and failed in the full suite, because whether a conversation is still
     * around at this point depends on which cases ran. Doing it in dependency order does
     * not depend on that.
     */
    await purgeConversations(
      pool,
      `SELECT c.conversation_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.owning_team_id = ANY($1::text[])`,
      [[TEAM, BYSTANDER]],
    );
    await pool.query(
      `DELETE FROM conversation.service_cases WHERE owning_team_id = ANY($1::text[])`,
      [[TEAM, BYSTANDER]],
    );
    await pool.query(`DELETE FROM identity.teams WHERE team_id = ANY($1::text[])`, [
      [TEAM, BYSTANDER],
    ]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, fn: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await fn();
  });
};

/** A conversation with a message, an attachment on that message, and a row under each. */
async function seedThreeLevels(
  db: pg.Pool,
): Promise<{ conversationId: string; revisionId: string; scanId: string }> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const scanId = crypto.randomUUID();
  const at = new Date().toISOString();

  await db.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id)
     VALUES ($1,'NEW',$2)`,
    [caseId, TEAM],
  );
  await db.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'NEW','purge fixture',$3)`,
    [conversationId, caseId, at],
  );

  // Level 2: a direct child of conversations, and itself a parent.
  await db.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
     VALUES ($1,$2,1,'CUSTOMER_VISIBLE','CUSTOMER','Purge Fixture','hello')`,
    [messageId, conversationId],
  );

  /**
   * Also a direct child of conversations, but with a foreign key to `messages`. This is the
   * pair that made catalog order matter: delete `messages` first and this row blocks it.
   */
  await db.query(
    `INSERT INTO conversation.attachments
       (attachment_id, conversation_id, message_id, uploader_kind, declared_mime, declared_bytes)
     VALUES ($1,$2,$3,'CUSTOMER','application/pdf',123)`,
    [attachmentId, conversationId, messageId],
  );

  // Level 3: reachable only by following the graph past the direct children.
  await db.query(
    `INSERT INTO conversation.message_revisions (revision_id, message_id, revision_kind)
     VALUES ($1,$2,'REDACTION')`,
    [revisionId, messageId],
  );
  await db.query(
    `INSERT INTO conversation.attachment_scan_results (scan_id, attachment_id, verdict, scanner)
     VALUES ($1,$2,'CLEAN','fixture')`,
    [scanId, attachmentId],
  );

  return { conversationId, revisionId, scanId };
}

const OWNED = `SELECT c.conversation_id FROM conversation.conversations c
                 JOIN conversation.service_cases sc ON sc.case_id = c.case_id
                WHERE sc.owning_team_id = $1`;

describe('purgeConversations', () => {
  withDb('removes a conversation whose children have children of their own', async () => {
    const seeded = await seedThreeLevels(pool!);
    const { conversationId } = seeded;

    /**
     * The anti-vacuity control. Without it, a purge that deleted nothing would satisfy
     * every assertion below, because "no rows remain" is trivially true of rows that were
     * never inserted — and this fixture is elaborate enough that a silent insert failure is
     * a real possibility.
     */
    const before = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.message_revisions r
         JOIN conversation.messages m ON m.message_id = r.message_id
        WHERE m.conversation_id = $1`,
      [conversationId],
    );
    expect(before.rows[0].n, 'the fixture did not build the third level').toBe(1);

    // The whole point: this must not throw. Both previous versions did.
    await purgeConversations(pool!, OWNED, [TEAM]);

    const remaining = await pool!.query(
      `SELECT
         (SELECT count(*)::int FROM conversation.conversations WHERE conversation_id = $1) AS conversations,
         (SELECT count(*)::int FROM conversation.messages WHERE conversation_id = $1) AS messages,
         (SELECT count(*)::int FROM conversation.attachments WHERE conversation_id = $1) AS attachments`,
      [conversationId],
    );
    expect(remaining.rows[0]).toEqual({ conversations: 0, messages: 0, attachments: 0 });

    /**
     * Grandchildren are gone too — deleted, not orphaned, and not merely unreferenced.
     *
     * Asserted against THIS fixture's ids, captured before the purge. The first version
     * counted the whole of `message_revisions` and `attachment_scan_results` and expected
     * zero, which is a global assertion wearing a scoped one's clothes: it passed only
     * while no other suite had left a row in either table, and duly failed the first time
     * the browser suite ran an attachment journey in the same database. A test that
     * depends on the rest of the world being empty reports on the world, not on the code.
     */
    const goneRevisions = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.message_revisions WHERE revision_id = $1`,
      [seeded.revisionId],
    );
    const goneScans = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.attachment_scan_results WHERE scan_id = $1`,
      [seeded.scanId],
    );
    expect(goneRevisions.rows[0].n, 'a message revision outlived its message').toBe(0);
    expect(goneScans.rows[0].n, 'a scan result outlived its attachment').toBe(0);
  });

  withDb('is safe to run when there is nothing to purge', async () => {
    // `afterAll` runs whether or not a suite created anything, including after an early
    // failure. A teardown that throws on an empty set turns one red test into two.
    await expect(purgeConversations(pool!, OWNED, ['no-such-team'])).resolves.toBeUndefined();
  });

  withDb('deletes only what the caller selected', async () => {
    /**
     * The purge walks the schema, so the one thing standing between it and another suite's
     * data is the caller's predicate. If the recursion ever widened — a child deleted by
     * table rather than by its link back to the selected rows — this is what would catch it.
     */
    const mine = await seedThreeLevels(pool!);

    const otherCase = crypto.randomUUID();
    const otherConversation = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id)
       VALUES ($1,'NEW',$2)`,
      [otherCase, BYSTANDER],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'NEW','bystander',$3)`,
      [otherConversation, otherCase, new Date().toISOString()],
    );
    await pool!.query(
      `INSERT INTO conversation.messages
         (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
       VALUES ($1,$2,1,'CUSTOMER_VISIBLE','CUSTOMER','Bystander','still here')`,
      [crypto.randomUUID(), otherConversation],
    );

    try {
      await purgeConversations(pool!, OWNED, [TEAM]);

      const gone = await pool!.query(
        `SELECT count(*)::int AS n FROM conversation.conversations WHERE conversation_id = $1`,
        [mine.conversationId],
      );
      expect(gone.rows[0].n, 'the selected conversation survived').toBe(0);

      const survived = await pool!.query(
        `SELECT
           (SELECT count(*)::int FROM conversation.conversations WHERE conversation_id = $1) AS conversations,
           (SELECT count(*)::int FROM conversation.messages WHERE conversation_id = $1) AS messages`,
        [otherConversation],
      );
      expect(
        survived.rows[0],
        'the purge reached rows the caller did not select — another suite would lose data',
      ).toEqual({ conversations: 1, messages: 1 });
    } finally {
      await purgeConversations(pool!, `SELECT $1::uuid`, [otherConversation]);
      await pool!.query(`DELETE FROM conversation.service_cases WHERE case_id = $1`, [otherCase]);
    }
  });
});
