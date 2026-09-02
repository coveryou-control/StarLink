/**
 * GOLDEN TESTS G-06 and G-07 — the claim races, against real PostgreSQL.
 *
 * These have been named in the test strategy since Phase 0 with nothing to run against.
 * They are the reason `FOR UPDATE SKIP LOCKED` and the `ownership_no_overlap` exclusion
 * constraint exist, and neither has ever been under real contention until now.
 *
 *   G-06  Two agents claim the same conversation → exactly one winner, the loser gets a
 *         clean ALREADY_ASSIGNED.
 *   G-07  A hundred agents claim from one queue → one winner per item, no deadlock, no
 *         item taken twice.
 *
 * A sequential test cannot see any of this. The failure mode being ruled out — a read
 * followed by a write, two agents both seeing WAITING — passes every test that runs one
 * caller at a time and hands the same customer to two people the first time two of them
 * click at once.
 *
 * BR-10 ("exactly one owner") is additionally checked against the DATABASE rather than
 * the return values, because the constraint is the actual guarantee: if this code were
 * wrong, the commit would fail rather than produce two owners.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgRoutingStore } from './routing-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `6a6a` block — owned by this file alone. */
const TEAM_ID = 'claim-race-team';
const AGENT_PREFIX = '018f2c5a-6a6a-7000-8000-';
const agentId = (n: number): string => `${AGENT_PREFIX}${String(n).padStart(12, '0')}`;

const AGENTS = 100;
const QUEUE_ITEMS = 40;

let pool: pg.Pool | undefined;
let store: PgRoutingStore;
let available = false;
const conversations: string[] = [];
const cases: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  // A generous pool: this file deliberately runs many callers at once, and a pool
  // smaller than the concurrency would serialise them and quietly test nothing.
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 20_000, max: 20 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    store = new PgRoutingStore(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ claim race golden tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Claim Race Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  const values = Array.from({ length: AGENTS }, (_, i) => `('${agentId(i)}','EMPLOYEE','Claimer ${i}','Service')`);
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ${values.join(',')} ON CONFLICT (principal_id) DO NOTHING`,
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.ownership_episodes WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    await pool.query(`DELETE FROM conversation.reservations WHERE principal_id::text LIKE $1`, [`${AGENT_PREFIX}%`]);
    await pool.query(`DELETE FROM conversation.capacity_policies WHERE scope_id LIKE $1`, [`${AGENT_PREFIX}%`]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id::text LIKE $1`, [`${AGENT_PREFIX}%`]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, body: () => Promise<void>, timeout = 120_000): void => {
  it(
    name,
    async (ctx) => {
      if (!available) {
        console.warn(`  ⚠ UNPROVEN: ${name}`);
        ctx.skip();
        return;
      }
      await body();
    },
    timeout,
  );
};

/** One queued conversation, ready to be fought over. */
async function queueOne(index: number): Promise<string> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const at = new Date().toISOString();
  cases.push(caseId);
  conversations.push(conversationId);

  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
    [caseId, TEAM_ID],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED',$3,$4)`,
    [conversationId, caseId, `Race ${index}`, at],
  );
  await store.enqueue({
    queueEntryId: crypto.randomUUID(),
    conversationId,
    caseId,
    teamId: TEAM_ID,
    priority: 'NORMAL',
    afterHours: false,
    at,
  });
  return conversationId;
}

/** A queued conversation, returning both ids the two claim paths need. */
async function seedQueued(title: string): Promise<{ conversationId: string; queueEntryId: string }> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const queueEntryId = crypto.randomUUID();
  const at = new Date().toISOString();
  cases.push(caseId);
  conversations.push(conversationId);

  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
    [caseId, TEAM_ID],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED',$3,$4)`,
    [conversationId, caseId, title, at],
  );
  await store.enqueue({
    queueEntryId,
    conversationId,
    caseId,
    teamId: TEAM_ID,
    priority: 'NORMAL',
    afterHours: false,
    at,
  });
  return { conversationId, queueEntryId };
}

/**
 * Both halves of what an ownership grant owes: the participant row that makes the work
 * findable, and the ledger row that accounts for the access.
 *
 * `path` is in every message because the point of the caller is that these must hold for
 * EVERY entry point — a failure has to say which one regressed.
 */
async function expectGranted(
  seeded: { conversationId: string },
  owner: string,
  path: string,
): Promise<void> {
  const participant = await pool!.query(
    `SELECT role, reply_authority FROM conversation.participants
      WHERE conversation_id = $1 AND principal_id = $2 AND effective_to IS NULL`,
    [seeded.conversationId, owner],
  );
  expect(
    participant.rowCount,
    `${path} opened an ownership episode and wrote no participant row — the owner cannot ` +
      'see this conversation in their own inbox',
  ).toBe(1);
  expect(participant.rows[0].role).toBe('OWNER');
  expect(participant.rows[0].reply_authority).toBe(true);

  const ledger = await pool!.query(
    `SELECT actor_kind, outcome, correlation_id FROM audit.ledger
      WHERE action = 'conversation.participant.add' AND target_id = $1`,
    [seeded.conversationId],
  );
  expect(
    ledger.rowCount,
    `${path} granted participation and wrote no audit row (§31.1)`,
  ).toBe(1);
  expect(ledger.rows[0].actor_kind).toBe('EMPLOYEE');
  expect(ledger.rows[0].outcome).toBe('SUCCEEDED');
  // Joinable, not a minted value: §31.5's reconstruction is a join on this column.
  expect(
    ledger.rows[0].correlation_id,
    `${path} wrote a correlation id that joins to nothing`,
  ).toBe(seeded.conversationId);
}

describe('G-06 — two agents claim the same conversation', () => {
  withDb('produces exactly one winner and one clean ALREADY_ASSIGNED', async () => {
    const conversationId = await queueOne(1);
    const at = new Date().toISOString();

    const [first, second] = await Promise.all([
      store.claimConversation({ conversationId, claimedBy: agentId(0), episodeId: crypto.randomUUID(), at }),
      store.claimConversation({ conversationId, claimedBy: agentId(1), episodeId: crypto.randomUUID(), at }),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser gets a clean, specific answer — not a deadlock, a timeout or a crash.
    expect(losers[0]!.ok === false && losers[0]!.reason).toBe('ALREADY_ASSIGNED');
  });

  withDb('leaves exactly one live ownership episode (BR-10)', async () => {
    const conversationId = await queueOne(2);
    const at = new Date().toISOString();

    await Promise.all([
      store.claimConversation({ conversationId, claimedBy: agentId(2), episodeId: crypto.randomUUID(), at }),
      store.claimConversation({ conversationId, claimedBy: agentId(3), episodeId: crypto.randomUUID(), at }),
    ]);

    // Asked of the DATABASE, not of the return values: the exclusion constraint is the
    // guarantee, and this is the question an auditor would ask.
    const live = await pool!.query(
      `SELECT owner_id FROM conversation.ownership_episodes
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    expect(live.rowCount).toBe(1);
  });

  withDb('refuses a second claim after the first has settled', async () => {
    const conversationId = await queueOne(3);
    const at = new Date().toISOString();

    const first = await store.claimConversation({
      conversationId,
      claimedBy: agentId(4),
      episodeId: crypto.randomUUID(),
      at,
    });
    const second = await store.claimConversation({
      conversationId,
      claimedBy: agentId(5),
      episodeId: crypto.randomUUID(),
      at: new Date().toISOString(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok === false && second.reason).toBe('ALREADY_ASSIGNED');
  });

  withDb('reports NOT_QUEUED for a conversation that was never queued', async () => {
    const outcome = await store.claimConversation({
      conversationId: crypto.randomUUID(),
      claimedBy: agentId(6),
      episodeId: crypto.randomUUID(),
      at: new Date().toISOString(),
    });

    expect(outcome.ok === false && outcome.reason).toBe('NOT_QUEUED');
  });
});

describe('G-07 — a hundred agents claim from one queue', () => {
  withDb(
    'gives each item to exactly one agent, with no deadlock and nothing taken twice',
    async () => {
      for (let i = 0; i < QUEUE_ITEMS; i += 1) await queueOne(100 + i);

      const at = new Date().toISOString();
      // A hundred callers against forty items. Sixty must come away empty-handed, and
      // they must do so cleanly rather than blocking behind a lock.
      const results = await Promise.all(
        Array.from({ length: AGENTS }, (_, i) =>
          store.claimNextFromQueue({
            teamId: TEAM_ID,
            claimedBy: agentId(i),
            episodeId: crypto.randomUUID(),
            at,
          }),
        ),
      );

      const claimed = results.filter((r) => r.ok);
      expect(claimed).toHaveLength(QUEUE_ITEMS);

      // No conversation handed out twice.
      const claimedConversations = claimed.map((r) => (r.ok ? r.episode.conversationId : ''));
      expect(new Set(claimedConversations).size).toBe(QUEUE_ITEMS);

      // Everyone who missed out got a clean answer, not an exception.
      const empty = results.filter((r) => !r.ok);
      expect(empty).toHaveLength(AGENTS - QUEUE_ITEMS);
      expect(empty.every((r) => r.ok === false && r.reason === 'NOT_QUEUED')).toBe(true);

      // And the database agrees: one live episode per claimed conversation.
      const live = await pool!.query(
        `SELECT conversation_id, count(*)::int AS c
           FROM conversation.ownership_episodes
          WHERE conversation_id = ANY($1::uuid[]) AND effective_to IS NULL
          GROUP BY conversation_id`,
        [claimedConversations],
      );
      expect(live.rowCount).toBe(QUEUE_ITEMS);
      expect(live.rows.every((row) => row.c === 1)).toBe(true);
    },
    180_000,
  );

  withDb('leaves nothing WAITING once the queue is drained', async () => {
    const remaining = await pool!.query(
      `SELECT count(*)::int AS c FROM conversation.queue_entries
        WHERE team_id = $1 AND state = 'WAITING'`,
      [TEAM_ID],
    );
    // A row stuck in WAITING with no claimer is work nobody will ever see again.
    expect(remaining.rows[0].c).toBe(0);
  });
});

describe('ADR-023 — the capacity ceiling under simultaneous routing', () => {
  /**
   * The same shape of race as G-06, one layer up.
   *
   * `assignFromRouting` decides against an AGGREGATE — the sum of a person's live
   * reservation weights — rather than against a single row, so the conditional-UPDATE
   * trick that makes claiming safe does not apply. A read of the sum followed by an
   * insert is a read-then-write, and twenty of them at once against a ceiling of one
   * will put a dozen conversations on somebody who can hold one.
   *
   * Written at high concurrency deliberately. The first version of this test raced two
   * callers and passed WITHOUT the advisory lock: two sequential awaits through a
   * connection pool rarely interleave in the narrow window that matters, so it proved
   * nothing while looking like it proved everything. Twenty callers do interleave, and
   * the failure was reproduced by removing the lock before this was kept.
   */
  const CEILING_HOLDER = agentId(0);
  const CONTENDERS = 20;

  withDb('admits exactly one assignment against a ceiling of one', async () => {
    await pool!.query(
      `INSERT INTO conversation.capacity_policies
         (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
       VALUES ($1,'PRINCIPAL',$2,1,'{}'::jsonb,true)
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), CEILING_HOLDER],
    );

    const entries = await Promise.all(
      Array.from({ length: CONTENDERS }, async (_unused, i) => {
        const caseId = crypto.randomUUID();
        const conversationId = crypto.randomUUID();
        const queueEntryId = crypto.randomUUID();
        const at = new Date().toISOString();
        cases.push(caseId);
        conversations.push(conversationId);
        await pool!.query(
          `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
          [caseId, TEAM_ID],
        );
        await pool!.query(
          `INSERT INTO conversation.conversations
             (conversation_id, conversation_type, case_id, state, title, last_activity_at)
           VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED',$3,$4)`,
          [conversationId, caseId, `Capacity race ${i}`, at],
        );
        await store.enqueue({
          queueEntryId,
          conversationId,
          caseId,
          teamId: TEAM_ID,
          priority: 'NORMAL',
          afterHours: false,
          at,
        });
        return queueEntryId;
      }),
    );

    const at = new Date().toISOString();
    const results = await Promise.all(
      entries.map((queueEntryId) =>
        store.assignFromRouting({
          queueEntryId,
          principalId: CEILING_HOLDER,
          episodeId: crypto.randomUUID(),
          reservationId: crypto.randomUUID(),
          weight: 1,
          ttlSeconds: 120,
          reason: 'capacity race',
          at,
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'AT_CAPACITY')).toHaveLength(CONTENDERS - 1);

    // Asserted against the DATABASE, not the return values: the ceiling is only real if
    // the rows agree with it.
    const held = await pool!.query(
      `SELECT COALESCE(sum(weight),0)::int AS held FROM conversation.reservations
        WHERE principal_id = $1 AND released_at IS NULL AND expires_at > now()`,
      [CEILING_HOLDER],
    );
    expect(held.rows[0].held).toBe(1);

    // Nineteen conversations stayed WAITING and are still claimable. The ceiling
    // refuses an assignment; it never swallows the work.
    const waiting = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.queue_entries
        WHERE queue_entry_id = ANY($1::uuid[]) AND state = 'WAITING'`,
      [entries],
    );
    expect(waiting.rows[0].n).toBe(CONTENDERS - 1);
  });

  withDb('audits the participation it grants, as SYSTEM with no actor', async () => {
    /**
     * The ordinary path, and until now the untested one.
     *
     * `claimConversation` and `reassign` both grant participation on behalf of a PERSON,
     * and both are covered. `assignFromRouting` is how every customer conversation that
     * nobody claims by hand gets its owner — the routing sweep's path, which is to say
     * most conversations — and it was the only one of the three with no test of its audit
     * row at all. The code was written and reviewed; nothing executed it.
     *
     * Two things are asserted that the other two paths cannot check, because only this one
     * has no human behind it:
     *
     *   * `actor_kind = 'SYSTEM'`. §31.2 distinguishes what a person did from what the
     *     system did, and a placement recorded as an EMPLOYEE action would name whoever
     *     happened to be nearby as having granted access they never granted.
     *   * `actor_id IS NULL`. There is no person, and inventing one — the new owner, say —
     *     would make the ledger assert that the recipient authorised their own access.
     *     The column is nullable (`0001_foundation.sql:670`) precisely for this.
     */
    const caseId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const queueEntryId = crypto.randomUUID();
    const owner = agentId(1);
    const at = new Date().toISOString();
    cases.push(caseId);
    conversations.push(conversationId);

    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
      [caseId, TEAM_ID],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED',$3,$4)`,
      [conversationId, caseId, 'Swept into place', at],
    );
    await store.enqueue({
      queueEntryId,
      conversationId,
      caseId,
      teamId: TEAM_ID,
      priority: 'NORMAL',
      afterHours: false,
      at,
    });

    const placed = await store.assignFromRouting({
      queueEntryId,
      principalId: owner,
      episodeId: crypto.randomUUID(),
      reservationId: crypto.randomUUID(),
      weight: 1,
      ttlSeconds: 120,
      reason: 'placed by the routing sweep',
      at,
    });
    // Without this the assertions below would pass over an empty ledger whenever the
    // placement was refused for an unrelated reason — capacity, a stale queue entry.
    expect(placed.ok, 'the placement was refused, so there is nothing to audit').toBe(true);

    const ledger = await pool!.query(
      `SELECT actor_id, actor_kind, outcome, detail
         FROM audit.ledger
        WHERE action = 'conversation.participant.add' AND target_id = $1`,
      [conversationId],
    );

    expect(
      ledger.rowCount,
      'the sweep granted participation and wrote no audit row — §31.1 requires that ' +
        'participation changes are audited, and this is the path most of them take',
    ).toBe(1);
    expect(ledger.rows[0].actor_kind).toBe('SYSTEM');
    expect(
      ledger.rows[0].actor_id,
      'a machine placement was attributed to a person',
    ).toBeNull();
    expect(ledger.rows[0].outcome).toBe('SUCCEEDED');
    expect((ledger.rows[0].detail as { addedPrincipal: string }).addedPrincipal).toBe(owner);
  });

  withDb('every ownership path writes the participant row and its ledger entry', async () => {
    /**
     * The invariant as a property of the CLASS, not of the three paths that were converted.
     *
     * When the ledger write was made atomic with the grant, three of the five methods that
     * open an ownership episode were updated and two were not — `claimNextFromQueue` and
     * `claimQueueEntry`, the latter wired into the DI graph as the Work Orchestrator
     * contract's `claim()`. Both opened an episode and wrote neither a participant row nor
     * an audit row, reproducing exactly the defect `ensureOwnerParticipantIn` exists to
     * prevent: an owner whose own inbox cannot show them the conversation, holding access
     * that §31.1 cannot account for.
     *
     * Driving both here rather than asserting on one is the point — a per-path test is what
     * let two paths sit unconverted while the suite stayed green.
     */
    const owner = agentId(2);

    /**
     * Path 1: claimNextFromQueue — takes whatever is at the HEAD of the team's queue.
     *
     * Asserted against the conversation it actually claimed rather than the one seeded
     * here, because earlier cases in this file leave WAITING entries behind and the head
     * is very often one of those. Seeding one and assuming it was taken is the same
     * `.first()` mistake that makes the browser suite flake; the return value is the only
     * honest answer to "which conversation did this claim".
     */
    await seedQueued('head of the queue');
    const claimedNext = await store.claimNextFromQueue({
      teamId: TEAM_ID,
      claimedBy: owner,
      episodeId: crypto.randomUUID(),
      at: new Date().toISOString(),
    });
    expect(claimedNext.ok, 'nothing was claimable — the assertions below would pass over nothing').toBe(true);
    await expectGranted(
      { conversationId: (claimedNext as { ok: true; episode: { conversationId: string } }).episode.conversationId },
      owner,
      'claimNextFromQueue',
    );

    // Path 2: claimQueueEntry — the contract's claim(), by queue entry id.
    const second = await seedQueued('claimed by entry id');
    const claimedEntry = await store.claimQueueEntry({
      queueEntryId: second.queueEntryId,
      claimedBy: owner,
      episodeId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      at: new Date().toISOString(),
    });
    expect(claimedEntry.ok, 'the queue entry was not claimable').toBe(true);
    await expectGranted(second, owner, 'claimQueueEntry');
  });

});

describe('BR-10 — the database refuses two simultaneous owners', () => {
  withDb('rejects an overlapping episode even when inserted directly', async () => {
    /**
     * The constraint tested on its own terms, bypassing the store entirely.
     *
     * Every guarantee above depends on `ownership_no_overlap` actually being enforced.
     * If the constraint were dropped in a future migration, the tests above could still
     * pass by luck of timing — this one could not.
     */
    const conversationId = await queueOne(900);
    const at = new Date().toISOString();
    await store.claimConversation({
      conversationId,
      claimedBy: agentId(10),
      episodeId: crypto.randomUUID(),
      at,
    });

    await expect(
      pool!.query(
        `INSERT INTO conversation.ownership_episodes
           (episode_id, conversation_id, owner_id, effective_from, assignment_source)
         VALUES ($1,$2,$3,$4,'LEAD_ASSIGNED')`,
        [crypto.randomUUID(), conversationId, agentId(11), at],
      ),
    ).rejects.toThrow(/ownership_no_overlap|exclusion/i);
  });
});
