/**
 * Search scope, against real PostgreSQL.
 *
 * The decisive test is the second one: a non-participant searching for a term that
 * DOES exist gets nothing. That is the difference between scope-before-query and
 * filter-after-query, and it is invisible to a unit test with a stubbed provider —
 * the only way to know the join is really there is to run it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiresTls } from '../client.js';
import pg from 'pg';
import { PgSearchProvider } from './search-provider.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const INSIDER = '018f2c5a-bbbb-7000-8000-00000000000a';
const OUTSIDER = '018f2c5a-bbbb-7000-8000-00000000000b';
const CUSTOMER = '018f2c5a-bbbb-7000-8000-00000000000c';
const TEAM_ID = 'search-test-team';
const ALL = [INSIDER, OUTSIDER, CUSTOMER];

let pool: pg.Pool | undefined;
let provider: PgSearchProvider;
let available = false;
let conversationId: string;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({
    connectionString: CONNECTION,
    connectionTimeoutMillis: 10_000,
    /*
       `requiresTls`, not a substring match on "localhost".

       This read `CONNECTION.includes('localhost')`, so pointing SL_DATABASE_URL at
       `127.0.0.1` — the same loopback database, and the spelling that works when the host
       resolves ::1 first — demanded verified TLS from a server that has none. The
       connection failed, the `catch` below called it "no PostgreSQL", and eleven tests
       skipped rather than failing. `test:verify` caught it; nothing else would have.

       The client already answers this question correctly for all three loopback
       spellings, so this asks it rather than approximating it.
    */
    ...(requiresTls(CONNECTION) ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    provider = new PgSearchProvider(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Search tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await cleanup(probe);

  await probe.query('INSERT INTO identity.teams (team_id, display_name) VALUES ($1,$2)', [
    TEAM_ID,
    'Search Team',
  ]);
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name) VALUES
       ($1,'EMPLOYEE','Search Insider'), ($2,'EMPLOYEE','Search Outsider'), ($3,'CUSTOMER','Search Customer')`,
    ALL,
  );

  const caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await probe.query(
    `INSERT INTO conversation.service_cases (case_id, owning_team_id, current_owner_id, state, customer_ref)
     VALUES ($1,$2,$3,'ACTIVE','CCS:customer:search')`,
    [caseId, TEAM_ID, INSIDER],
  );
  await probe.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, customer_ref, last_seq)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','CCS:customer:search',2)`,
    [conversationId, caseId],
  );
  // Only the insider participates. The outsider is a valid employee with no seat here.
  await probe.query(
    `INSERT INTO conversation.participants (conversation_id, principal_id, principal_kind, role)
     VALUES ($1,$2,'EMPLOYEE','PARTICIPANT')`,
    [conversationId, INSIDER],
  );

  await probe.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
     VALUES
       (gen_random_uuid(), $1, 1, 'CUSTOMER_VISIBLE', 'EMPLOYEE', 'Search Insider',
        'Your renewal premium has been recalculated for the policy'),
       (gen_random_uuid(), $1, 2, 'INTERNAL', 'EMPLOYEE', 'Search Insider',
        'Internal note: escalate this renewal to the retention desk')`,
    [conversationId],
  );
});

const cleanup = async (p: pg.Pool): Promise<void> => {
  await p.query(
    `DELETE FROM conversation.messages WHERE conversation_id IN
       (SELECT conversation_id FROM conversation.conversations WHERE customer_ref = 'CCS:customer:search')`,
  );
  await p.query(
    `DELETE FROM conversation.participants WHERE conversation_id IN
       (SELECT conversation_id FROM conversation.conversations WHERE customer_ref = 'CCS:customer:search')`,
  );
  await p.query(`DELETE FROM conversation.conversations WHERE customer_ref = 'CCS:customer:search'`);
  await p.query('DELETE FROM conversation.service_cases WHERE owning_team_id = $1', [TEAM_ID]);
  await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [ALL]);
  await p.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
};

afterAll(async () => {
  if (pool !== undefined && available) await cleanup(pool);
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await fn();
  });

describe('scope before query (§30.2, FR-SRCH-1/2)', () => {
  withDb('a participant finds their own conversation', async () => {
    const result = await provider.search({ principalId: INSIDER, includeInternal: true }, 'renewal');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBeGreaterThan(0);
  });

  withDb('a NON-participant finds nothing, though the term certainly exists', async () => {
    // The decisive assertion. If scope were a post-filter that someone forgot, this
    // would return the insider's messages. An absent scope must return NOTHING, not
    // everything.
    const result = await provider.search({ principalId: OUTSIDER, includeInternal: true }, 'renewal');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(0);
  });

  withDb('a principal who is not in the database at all finds nothing', async () => {
    const result = await provider.search({ principalId: crypto.randomUUID(), includeInternal: true }, 'renewal');
    expect(result.ok && result.value.items).toHaveLength(0);
  });

  withDb('the OWNER can search a conversation they never joined as a participant', async () => {
    // Caught end-to-end: a participants-only scope meant an owner could open a thread
    // but not search it — two divergent definitions of "may read". The owner here has
    // no participant row at all; ownership alone must be enough.
    const ownerOnly = crypto.randomUUID();
    const caseId = crypto.randomUUID();
    const convId = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO identity.principals (principal_id, kind, display_name) VALUES ($1,'EMPLOYEE','Owner Only')`,
      [ownerOnly],
    );
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, owning_team_id, current_owner_id, state, customer_ref)
       VALUES ($1,$2,$3,'ACTIVE','CCS:customer:search')`,
      [caseId, TEAM_ID, ownerOnly],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, customer_ref, last_seq)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','CCS:customer:search',1)`,
      [convId, caseId],
    );
    await pool!.query(
      `INSERT INTO conversation.messages
         (message_id, conversation_id, seq, visibility, sender_kind, sender_display_name, body)
       VALUES (gen_random_uuid(), $1, 1, 'CUSTOMER_VISIBLE', 'EMPLOYEE', 'Owner Only',
               'A distinctive marmalade term for the owner scope test')`,
      [convId],
    );

    const mine = await provider.search({ principalId: ownerOnly, includeInternal: true }, 'marmalade');
    expect(mine.ok && mine.value.items.length).toBeGreaterThan(0);

    // ...and it is still scoped: someone else's ownership grants nothing.
    const theirs = await provider.search({ principalId: OUTSIDER, includeInternal: true }, 'marmalade');
    expect(theirs.ok && theirs.value.items).toHaveLength(0);

    // Children before parents: service_cases holds an FK to the owning principal.
    await pool!.query('DELETE FROM conversation.messages WHERE conversation_id = $1', [convId]);
    await pool!.query('DELETE FROM conversation.conversations WHERE conversation_id = $1', [convId]);
    await pool!.query('DELETE FROM conversation.service_cases WHERE case_id = $1', [caseId]);
    await pool!.query('DELETE FROM identity.principals WHERE principal_id = $1', [ownerOnly]);
  });
});

describe('internal notes (§30.5, ADR-021)', () => {
  withDb('staff search reaches internal notes', async () => {
    const result = await provider.search({ principalId: INSIDER, includeInternal: true }, 'retention desk');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBeGreaterThan(0);
  });

  withDb('a customer-shaped scope NEVER reaches an internal note', async () => {
    // Excluded at the query, so there is no window in which the row was loaded and
    // merely not displayed.
    const result = await provider.search({ principalId: INSIDER, includeInternal: false }, 'retention desk');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(0);
  });

  withDb('the same scope still finds customer-visible content', async () => {
    const result = await provider.search({ principalId: INSIDER, includeInternal: false }, 'premium');
    expect(result.ok && result.value.items.length).toBeGreaterThan(0);
  });
});

describe('narrowing and results', () => {
  withDb('a conversation id narrows but cannot widen', async () => {
    const elsewhere = await provider.search(
      { principalId: INSIDER, includeInternal: true, conversationIds: [crypto.randomUUID()] },
      'renewal',
    );
    expect(elsewhere.ok && elsewhere.value.items).toHaveLength(0);

    const here = await provider.search(
      { principalId: INSIDER, includeInternal: true, conversationIds: [conversationId] },
      'renewal',
    );
    expect(here.ok && here.value.items.length).toBeGreaterThan(0);
  });

  withDb('returns a highlighted snippet rather than the whole message', async () => {
    const result = await provider.search({ principalId: INSIDER, includeInternal: true }, 'premium');
    if (!result.ok) throw new Error('search failed');
    const hit = result.value.items[0];
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('<<');
    expect(hit!.conversationId).toBe(conversationId);
  });

  withDb('an unmatched term is an empty success, not an error', async () => {
    const result = await provider.search(
      { principalId: INSIDER, includeInternal: true },
      'zzzznonexistentterm',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(0);
  });

  withDb('the GIN index matches the search query shape', async () => {
    // Sequential scan is CORRECT on a table this small — the planner is right that an
    // index lookup would cost more than reading two rows. So asserting the plan the
    // planner happens to pick would test the row count, not the schema.
    //
    // What matters, and what would actually regress, is whether the index is
    // APPLICABLE to this query shape: change `search_vector @@ plainto_tsquery(...)`
    // to something the GIN index cannot serve and search silently becomes a full scan
    // at production size. Asking the planner to prefer an index isolates that.
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT m.message_id FROM conversation.messages m
          WHERE m.search_vector @@ plainto_tsquery('english', 'renewal')`,
      );
      expect(JSON.stringify(plan.rows[0]['QUERY PLAN'])).toContain('messages_search_idx');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
