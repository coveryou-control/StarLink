/**
 * Removes fixture rows left behind by interrupted test runs.
 *
 * Integration suites clean up in `afterAll`, which does not run when a suite is killed
 * mid-flight — and during debugging, suites get killed constantly. The residue is
 * harmless until it is not: a leftover `service_cases` row referencing a fixture
 * principal makes ANOTHER suite's cleanup fail on a foreign key, its `beforeAll` throws,
 * and its tests report as skipped with nothing pointing at the real cause. That is
 * exactly how eight employee-directory tests went quiet.
 *
 * Deletion order follows the foreign keys inward-out: messages and participants before
 * conversations, conversations before cases, cases before principals.
 *
 * SAFETY: this only ever touches rows matching the fixture prefix `018f2c5a-` or the
 * known fixture team/category names. It will not remove seeded configuration or anything
 * a human created. The dev database holds synthetic data only (NFR-DAT-6), but a
 * cleanup script that could take real rows with it is not one to run twice.
 *
 *   node infrastructure/database/scripts/clean-test-residue.mjs [--dry-run]
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const CONNECTION = process.env.SL_DATABASE_URL;

if (CONNECTION === undefined || CONNECTION === '') {
  console.error('SL_DATABASE_URL is not set.');
  process.exit(2);
}

/** Fixture principals share this prefix; customer principals created at intake do not. */
const FIXTURE_PREFIX = '018f2c5a-%';

/**
 * The development sign-in accounts, which this script must never remove.
 *
 * They were `018f2c5a-…` — the fixture prefix — so this file deleted all three, and every
 * conversation they had created with them. It reported success while doing it. They have
 * moved to `018f5eed-` (see `seed-dev-people.mjs`), and they are named here as well: a
 * prefix is a convention, and a convention is not what should stand between a cleanup
 * script and the accounts people use.
 */
const DEV_ACCOUNT_PREFIX = '018f5eed-%';
const FIXTURE_TEAMS = ['isolation-team', 'durability-team', 'roles-test-team', 'exit-test-team', 'msgstore-team', 'api-demo-team', 'paging-team'];
const FIXTURE_CATEGORIES = ['isolation-category'];

const pool = new pg.Pool({ connectionString: CONNECTION, max: 3, connectionTimeoutMillis: 15_000 });

/**
 * `--dry-run` counts instead of writing — for EVERY statement, not just the deletes.
 *
 * The preview rewrote a leading `DELETE FROM` into a `SELECT count(*)`. An `UPDATE` does not
 * match that pattern, so the two statements that clear thread and reply links would have run
 * for real inside a dry run: a flag whose whole promise is "nothing will be deleted" quietly
 * writing to the table it was asked not to touch.
 *
 * Both shapes are handled and an unrecognised one THROWS rather than being executed. A dry
 * run that cannot preview a statement must refuse, not fall through to running it.
 */
const previewOf = (sql) => {
  if (/^\s*DELETE FROM/i.test(sql)) return sql.replace(/^(\s*)DELETE FROM/i, '$1SELECT count(*)::int AS c FROM');
  if (/^\s*UPDATE/i.test(sql)) {
    const where = sql.slice(sql.search(/\bWHERE\b/i));
    const table = /^\s*UPDATE\s+([\w.]+)/i.exec(sql)?.[1];
    if (table !== undefined) return `SELECT count(*)::int AS c FROM ${table} ${where}`;
  }
  throw new Error(`dry run cannot preview this statement safely: ${sql.slice(0, 60)}…`);
};

const run = async (label, sql, params = []) => {
  if (DRY_RUN) {
    const preview = await pool.query(previewOf(sql), params);
    console.log(`  [dry-run] ${label}: ${preview.rows[0]?.c ?? 0}`);
    return 0;
  }
  const result = await pool.query(sql, params);
  if (result.rowCount > 0) console.log(`  ${label}: ${result.rowCount}`);
  return result.rowCount;
};

/**
 * Conversations reachable from fixture data: created by a fixture principal, attached to
 * a fixture case, or having a fixture participant. Customer-intake conversations are
 * caught by the participant clause, since their principals are random UUIDs.
 */
const FIXTURE_CONVERSATIONS = `
  SELECT c.conversation_id FROM conversation.conversations c
   WHERE c.created_by::text LIKE $1
      OR c.case_id IN (SELECT case_id FROM conversation.service_cases WHERE owning_team_id = ANY($2::text[]))
      OR c.conversation_id IN (
           SELECT conversation_id FROM conversation.participants
            WHERE principal_id::text LIKE $1)
      OR c.conversation_id IN (
           SELECT p.conversation_id FROM conversation.participants p
             JOIN identity.principals ip ON ip.principal_id = p.principal_id
            WHERE ip.kind = 'CUSTOMER' AND ip.display_name = 'Guest')`;

const args = [FIXTURE_PREFIX, FIXTURE_TEAMS];

console.log(DRY_RUN ? 'Dry run — nothing will be deleted.\n' : 'Cleaning test residue...\n');

let total = 0;
total += await run('outbox rows', `DELETE FROM conversation.outbox WHERE aggregate_id IN (${FIXTURE_CONVERSATIONS})`, args);

/*
   Everything that points AT a message, before the messages.

   The delete order was messages-first and it worked for as long as no fixture conversation
   had a file in it. The attachment suite has put one there since, and the run then died on
   `attachments_message_id_fkey` partway through — leaving the residue it exists to remove,
   and with it the accumulated conversations that make the browser suite's reconnect test
   fail for reasons that have nothing to do with reconnecting.

   `message_reactions` is absent from this list on purpose: it is `ON DELETE CASCADE`, the
   only one of the five that is, so naming it here would be a delete that never has anything
   to do.

   Scan results before attachments, attachments before messages: the same foreign keys
   inward-out discipline the file header describes, one level deeper than it went.
*/
total += await run(
  'attachment scan results',
  `DELETE FROM conversation.attachment_scan_results
    WHERE attachment_id IN (
      SELECT attachment_id FROM conversation.attachments
       WHERE conversation_id IN (${FIXTURE_CONVERSATIONS}))`,
  args,
);
total += await run('attachments', `DELETE FROM conversation.attachments WHERE conversation_id IN (${FIXTURE_CONVERSATIONS})`, args);
total += await run(
  'message revisions',
  `DELETE FROM conversation.message_revisions
    WHERE message_id IN (
      SELECT message_id FROM conversation.messages
       WHERE conversation_id IN (${FIXTURE_CONVERSATIONS}))`,
  args,
);
total += await run(
  'delivery state',
  `DELETE FROM conversation.delivery_state
    WHERE message_id IN (
      SELECT message_id FROM conversation.messages
       WHERE conversation_id IN (${FIXTURE_CONVERSATIONS}))`,
  args,
);
/* A threaded reply points at another message in the same conversation, so the set deletes
   as one — but only once nothing outside it points in. Cleared rather than ordered,
   because "delete the roots last" is not expressible in a single statement. */
total += await run(
  'thread links',
  `UPDATE conversation.messages SET thread_parent_id = NULL
    WHERE conversation_id IN (${FIXTURE_CONVERSATIONS}) AND thread_parent_id IS NOT NULL`,
  args,
);
total += await run(
  'reply links',
  `UPDATE conversation.messages SET reply_to_message_id = NULL
    WHERE conversation_id IN (${FIXTURE_CONVERSATIONS}) AND reply_to_message_id IS NOT NULL`,
  args,
);
total += await run('messages', `DELETE FROM conversation.messages WHERE conversation_id IN (${FIXTURE_CONVERSATIONS})`, args);
total += await run('read state', `DELETE FROM conversation.read_state WHERE conversation_id IN (${FIXTURE_CONVERSATIONS})`, args);
total += await run('participants', `DELETE FROM conversation.participants WHERE conversation_id IN (${FIXTURE_CONVERSATIONS})`, args);
total += await run('conversations', `DELETE FROM conversation.conversations WHERE conversation_id IN (${FIXTURE_CONVERSATIONS})`, args);

// Cases are freed once the conversations referencing them are gone.
total += await run(
  'service cases',
  `DELETE FROM conversation.service_cases
    WHERE owning_team_id = ANY($2::text[])
       OR current_owner_id::text LIKE $1
       OR designated_employee_id::text LIKE $1
       OR category_id = ANY($3::text[])`,
  [FIXTURE_PREFIX, FIXTURE_TEAMS, FIXTURE_CATEGORIES],
);

total += await run(
  'role assignments',
  `DELETE FROM identity.role_assignments
    WHERE (principal_id::text LIKE $1 OR granted_by::text LIKE $1)
      AND principal_id::text NOT LIKE $2`,
  [FIXTURE_PREFIX, DEV_ACCOUNT_PREFIX],
);
total += await run(
  'team memberships',
  `DELETE FROM identity.team_memberships WHERE principal_id::text LIKE $1 AND principal_id::text NOT LIKE $2`,
  [FIXTURE_PREFIX, DEV_ACCOUNT_PREFIX],
);
total += await run(
  'fixture principals',
  `DELETE FROM identity.principals WHERE principal_id::text LIKE $1 AND principal_id::text NOT LIKE $2`,
  [FIXTURE_PREFIX, DEV_ACCOUNT_PREFIX],
);
// Anonymous customers created by intake: random ids, but always named 'Guest' and never
// referenced once their conversations are gone.
/*
   ORPHANED, and now checked rather than assumed.

   The name promised it and the statement did not: it removed every Guest, including ones
   whose conversation had survived this run — a conversation created outside the fixture
   set, or one whose deletion had already failed. The FK refused, the script died, and
   everything after it (categories, teams) was left behind by a cleanup that reported an
   error about customers.

   `created_by` is the reference that bit; participation is the other way a Guest is still
   in use. Both are checked, so what is deleted is what the label has always claimed.
*/
total += await run(
  'orphaned guest customers',
  `DELETE FROM identity.principals p
    WHERE p.kind = 'CUSTOMER' AND p.display_name = 'Guest'
      AND NOT EXISTS (SELECT 1 FROM conversation.conversations c WHERE c.created_by = p.principal_id)
      AND NOT EXISTS (SELECT 1 FROM conversation.participants q WHERE q.principal_id = p.principal_id)
      AND NOT EXISTS (SELECT 1 FROM conversation.service_cases s WHERE s.current_owner_id = p.principal_id)`,
);
total += await run('fixture categories', `DELETE FROM conversation.categories WHERE category_id = ANY($1::text[])`, [FIXTURE_CATEGORIES]);
total += await run('fixture teams', `DELETE FROM identity.teams WHERE team_id = ANY($1::text[])`, [FIXTURE_TEAMS]);

console.log(`\n${DRY_RUN ? 'Would remove' : 'Removed'} ${total} rows.`);
await pool.end();
