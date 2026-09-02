/**
 * PHASE 6: resolving a conversation, end to end (§21.4, BR-19, BR-20, UC-E18, UC-E19).
 *
 * ## Why this file exists at all
 *
 * Every component of the resolve path was built and tested in Phase 6, and the path did
 * not exist. §21.4's transition table was transcribed and unit-tested row for row;
 * `case_state_episodes` was migrated with its exclusion constraint; `conversation.resolve`
 * was in the action vocabulary with negative tests; the reopen-window closure sweep had
 * its own suite. **Nothing called `transition()`, and no route could reach RESOLVED.**
 *
 * The reason the suite stayed green is worth stating, because it is the failure mode this
 * file is built to prevent: the closure sweep's tests seeded RESOLVED rows with raw SQL,
 * and `reopen-flow.test.ts` did the same. A test that manufactures the state it exercises
 * proves the code downstream of that state — and cannot notice that nothing upstream can
 * produce it.
 *
 * So every assertion here starts from an HTTP request. Nothing below writes a state this
 * product could not reach on its own.
 *
 * ## One caveat, added 2026-08-29 after G-15 found what this file could not
 *
 * `openConversation` seeds ACTIVE directly, and at the time this file was written the
 * product could NOT in fact reach ACTIVE: nothing wrote QUEUED, ASSIGNED or ACTIVE, so a
 * real conversation sat at NEW and §21.4 has no `new → resolved` row. The resolve endpoint
 * was therefore unreachable in production while this suite was green (N-44). The header
 * above was right about the principle and this file still fell into it — seeding a state
 * is seeding a state, however carefully the rest is done.
 *
 * That is now fixed, and REACHABILITY is `golden-g15-ai-down.test.ts`'s job: it walks
 * intake → placement → reply → resolve with nothing seeded. This file keeps its narrower
 * purpose — what resolution does once a conversation is legitimately resolvable — and the
 * two are complementary rather than duplicative.
 *
 * ## What is proven
 *
 *   1. An owner can resolve, and the four rows that must move together do (§21.4's row,
 *      the case observation, the append-only episode, and the capacity hold).
 *   2. BR-19's "an outcome is recorded" is enforced, not merely documented.
 *   3. The resolution is AUDITED with the outcome as its reason (§31.1, §31.3).
 *   4. The closure sweep can now close something — the two halves join.
 *   5. §21.4's CLOSED is terminal: a reopen past the window is refused.
 *   6. BR-19's "or a lead" is real, and a mere participant is refused (P-03).
 *   7. BR-23/D-15: an internal thread has no lifecycle to resolve.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { hashPassword } from '@starlink/security';
import { ReopenWindowClosureSweep } from '@starlink/sweeps';
import { employeeRoutes } from '@starlink/shared-contracts';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3203;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `7c1e` block belongs to this file alone. */
const OWNER = '018f2c5a-7c1e-7000-8000-00000000000a';
const LEAD = '018f2c5a-7c1e-7000-8000-00000000000b';
const BYSTANDER = '018f2c5a-7c1e-7000-8000-00000000000c';
const TEAM_ID = 'resolve-flow-team';

const credentials = {
  owner: { username: 'resolve.owner', password: 'resolve-owner-password-1' },
  lead: { username: 'resolve.lead', password: 'resolve-lead-password-1' },
  bystander: { username: 'resolve.bystander', password: 'resolve-bystander-pw-1' },
};

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;

const conversations: string[] = [];
const cases: string[] = [];

const nowIso = (): string => new Date().toISOString();

/**
 * A customer-service conversation in an open state, owned by `ownerId`.
 *
 * Written directly because ARRIVAL is not what this file is about — intake and routing
 * have their own end-to-end tests. Everything from the open state onward goes through
 * HTTP, which is the part that did not exist.
 */
async function openConversation(
  ownerId: string | null,
  options: { withReservation?: boolean } = {},
): Promise<{ conversationId: string; caseId: string }> {
  const caseId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const at = nowIso();
  cases.push(caseId);
  conversations.push(conversationId);

  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id)
     VALUES ($1,'ACTIVE',$2,$3)`,
    [caseId, TEAM_ID, ownerId],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','Resolve flow thread',$3)`,
    [conversationId, caseId, at],
  );
  await pool!.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from)
     VALUES ($1,$2,'ACTIVE',$3)`,
    [crypto.randomUUID(), conversationId, at],
  );
  if (ownerId !== null) {
    await pool!.query(
      `INSERT INTO conversation.ownership_episodes
         (episode_id, conversation_id, case_id, owner_id, effective_from, assignment_source)
       VALUES ($1,$2,$3,$4,$5,'ROUTED')`,
      [crypto.randomUUID(), conversationId, caseId, ownerId, at],
    );
  }
  if (options.withReservation === true && ownerId !== null) {
    // The hold a claim would have created (migration 0004). Long-lived on purpose, so
    // that a released row proves the resolve released it rather than the TTL expiring.
    await pool!.query(
      `INSERT INTO conversation.reservations
         (reservation_id, principal_id, ref_system, ref_type, ref_id, weight, effective_from, expires_at)
       VALUES ($1,$2,'LOCAL','conversation',$3,1,$4,$4::timestamptz + interval '1 hour')`,
      [crypto.randomUUID(), ownerId, conversationId, at],
    );
  }
  return { conversationId, caseId };
}

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ resolve flow SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Resolve Flow Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$4,'Resolve Owner','Service',$7,'ACTIVE'),
            ($2,'EMPLOYEE',$5,'Resolve Lead','Service',$8,'ACTIVE'),
            ($3,'EMPLOYEE',$6,'Resolve Bystander','Service',$9,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
    [
      OWNER,
      LEAD,
      BYSTANDER,
      credentials.owner.username,
      credentials.lead.username,
      credentials.bystander.username,
      await hashPassword(credentials.owner.password),
      await hashPassword(credentials.lead.password),
      await hashPassword(credentials.bystander.password),
    ],
  );
  /**
   * The owner holds AGENT, which does NOT carry `conversation.resolve` — they reach it
   * through OWNERSHIP, which is §21.4's point. The lead holds TEAM_LEAD, which carries it
   * by BR-19's "or a lead". The bystander holds AGENT and owns nothing.
   */
  for (const [principal, role] of [
    [OWNER, 'AGENT'],
    [LEAD, 'TEAM_LEAD'],
    [BYSTANDER, 'AGENT'],
  ] as const) {
    await probe.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
       VALUES ($1,$2,$3,'GLOBAL',$2,now() - interval '1 day')
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), principal, role],
    );
  }

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: 'resolve-flow-session-secret-0123456789ab',
      SL_CURSOR_SECRET: 'resolve-flow-cursor-secret-0123456789abc',
      SL_DB_MAX_CONNECTIONS: '5',
      // Every sweep quiet. The closure sweep is driven explicitly below, because a test
      // that waits for a timer proves the timer, not the join.
      SL_SWEEP_ROUTING_SECONDS: '3600',
      SL_SWEEP_SLA_SECONDS: '3600',
      SL_SWEEP_REOPEN_SECONDS: '3600',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
      SL_SWEEP_RESERVATION_SECONDS: '3600',
      SL_QUEUE_METRICS_SECONDS: '3600',
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) console.warn('\n  ⚠ resolve flow SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    /**
     * Cleaned by TEAM, not only by the ids this run happened to record.
     *
     * A run that dies part-way through `openConversation` leaves a `service_cases` row
     * whose id no later process knows, and its `current_owner_id` then blocks the
     * principal delete forever — every subsequent run fails in teardown for a reason that
     * has nothing to do with what it was testing. The team is the durable handle.
     */
    const owned = await pool.query<{ conversation_id: string }>(
      `SELECT c.conversation_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.owning_team_id = $1`,
      [TEAM_ID],
    );
    const ids = [...new Set([...conversations, ...owned.rows.map((r) => r.conversation_id)])];

    /**
     * `audit.ledger` rows are deliberately NOT cleaned up. Rule 8 — the ledger is
     * append-only, enforced by role grants and a trigger — so a DELETE here would either
     * fail the teardown or, worse, succeed and prove the enforcement absent.
     */
    await pool.query(`DELETE FROM conversation.reservations WHERE ref_id = ANY($1::text[])`, [ids]);
    for (const table of ['case_state_episodes', 'ownership_episodes', 'participants', 'queue_entries']) {
      await pool.query(`DELETE FROM conversation.${table} WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query(
      `DELETE FROM conversation.notification_outbox WHERE target_ref = ANY($1::text[])`,
      [ids],
    );
    await pool.query(
      `DELETE FROM conversation.outbox WHERE aggregate_id = ANY($1::uuid[])`,
      [ids],
    );
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE owning_team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [
      [OWNER, LEAD, BYSTANDER],
    ]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [OWNER, LEAD, BYSTANDER],
    ]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const cookiesOf = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

async function signIn(who: keyof typeof credentials): Promise<string> {
  const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials[who]),
  });
  expect(response.status).toBe(200);
  return cookiesOf(response);
}

const post = (path: string, cookie: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const skipUnlessReady = (ctx: { skip: () => void }, what: string): boolean => {
  if (ready) return false;
  console.warn(`  ⚠ UNPROVEN: ${what}`);
  ctx.skip();
  return true;
};

describe('resolving a conversation (§21.4, BR-19)', () => {
  it('moves the four rows that must move together, and releases the capacity hold', async (ctx) => {
    if (skipUnlessReady(ctx, 'the resolve path was not exercised against a live API.')) return;

    const cookie = await signIn('owner');
    const { conversationId, caseId } = await openConversation(OWNER, { withReservation: true });

    const response = await post(employeeRoutes.conversations.resolve(conversationId), cookie, {
      outcome: 'Policy document re-issued and emailed to the customer.',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ outcome: 'RESOLVED', from: 'ACTIVE' });

    // 1. §21.4's row.
    const conversation = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(conversation.rows[0].state).toBe('RESOLVED');

    /**
     * 2. The case observation. `resolved_at` is what stops the RESOLUTION clock and what
     * the closure sweep compares its cutoff against — a resolution that moved the
     * conversation and not this would leave a case that breaches forever and can never
     * close.
     */
    const serviceCase = await pool!.query(
      `SELECT state, resolved_at, outcome_code FROM conversation.service_cases WHERE case_id = $1`,
      [caseId],
    );
    expect(serviceCase.rows[0].state).toBe('RESOLVED');
    expect(serviceCase.rows[0].resolved_at).not.toBeNull();
    expect(serviceCase.rows[0].outcome_code).toBe(
      'Policy document re-issued and emailed to the customer.',
    );

    /**
     * 3. The append-only history, with no gap. The SLA clock reads its pause spans from
     * this series, so a missing `effective_to` on the previous episode would overlap and
     * a missing episode would silently change an elapsed number.
     */
    const episodes = await pool!.query(
      `SELECT state, effective_to, entered_by, reason
         FROM conversation.case_state_episodes
        WHERE conversation_id = $1 ORDER BY effective_from`,
      [conversationId],
    );
    expect(episodes.rows.map((r) => r.state)).toEqual(['ACTIVE', 'RESOLVED']);
    expect(episodes.rows[0].effective_to).not.toBeNull();
    expect(episodes.rows[1].effective_to).toBeNull();
    // §21.4 requires a reason on this row, and the migration says it is recorded here.
    expect(episodes.rows[1].entered_by).toBe(OWNER);
    expect(episodes.rows[1].reason).toContain('re-issued');

    /**
     * 4. N-17 — the hold is released because the work has finished. Live capacity is a
     * query over unreleased rows, so before this the agent stayed "at capacity" until a
     * 120-second TTL expired and then dropped to zero while still holding the work.
     */
    const reservation = await pool!.query(
      `SELECT released_at, release_reason FROM conversation.reservations WHERE ref_id = $1`,
      [conversationId],
    );
    expect(reservation.rows[0].released_at).not.toBeNull();
    expect(reservation.rows[0].release_reason).toBe('resolved');

    /**
     * §31.1 lists "Lifecycle — resolve (with outcome) · reopen · close" among what is
     * audited, and §31.3 requires the reason "where the action requires one (transfer,
     * escalation, resolution)".
     */
    const audit = await pool!.query(
      `SELECT action, outcome, reason FROM audit.ledger
        WHERE target_id = $1 AND action = 'conversation.resolve'`,
      [conversationId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].outcome).toBe('SUCCEEDED');
    expect(audit.rows[0].reason).toContain('re-issued');

    /**
     * §10's `conversation.resolved.v1`, emitted from the REAL path — an HTTP resolve, not
     * a seeded row.
     *
     * The relay has routed this event to the customer as customer-visible since Phase 3,
     * with a passing test, and **nothing had ever emitted it**: the audit on 2026-08-29
     * found 14 of the 16 catalogue events in that state. A customer watching their own
     * conversation therefore saw no change when it was resolved and had to refresh.
     *
     * Asserted on the outbox rather than on the backplane because the outbox is the
     * durable record; whether the relay then delivered it is `outbox-relay.test.ts`'s
     * question, and P-05 makes the ordering between them the point.
     */
    const events = await pool!.query(
      `SELECT event_name, aggregate_type, payload
         FROM conversation.outbox
        WHERE aggregate_id = $1 AND event_name = 'conversation.resolved.v1'`,
      [conversationId],
    );
    expect(events.rowCount, 'no resolved event reached the outbox').toBe(1);
    const payload = events.rows[0].payload as Record<string, unknown>;
    expect(events.rows[0].aggregate_type).toBe('conversation');
    expect(payload.caseId).toBe(caseId);
    expect(payload.actorId).toBe(OWNER);
    // The outcome travels with the event: §10's row is
    // "conversation_id, case_id, outcome_code, actor".
    expect(payload.outcomeCode).toBe('Policy document re-issued and emailed to the customer.');
  }, 120_000);

  it('refuses a resolution with no outcome — BR-19', async (ctx) => {
    if (skipUnlessReady(ctx, 'the outcome requirement was not exercised.')) return;

    const cookie = await signIn('owner');
    const { conversationId } = await openConversation(OWNER);

    for (const body of [{}, { outcome: '' }, { outcome: '   ' }]) {
      const response = await post(
        employeeRoutes.conversations.resolve(conversationId),
        cookie,
        body,
      );
      expect(response.status).toBe(404);
    }

    // Still open. A refused resolve must not half-apply.
    const after = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(after.rows[0].state).toBe('ACTIVE');
  }, 120_000);

  it('reports a lost race as an outcome, not an error', async (ctx) => {
    if (skipUnlessReady(ctx, 'the concurrent-resolve path was not exercised.')) return;

    const cookie = await signIn('owner');
    const { conversationId } = await openConversation(OWNER);
    const body = { outcome: 'Answered.' };

    const first = await post(employeeRoutes.conversations.resolve(conversationId), cookie, body);
    expect(first.status).toBe(201);

    /**
     * The second attempt is refused by §21.4's table rather than by the conditional
     * write: RESOLVED → RESOLVED is `ALREADY_IN_STATE`, which never reaches the store. A
     * 404 rather than a 200, because from the caller's side nothing about their request
     * was valid — and the STATE_CHANGED outcome exists for the narrower case where the
     * state moved between the read and the write.
     */
    const second = await post(employeeRoutes.conversations.resolve(conversationId), cookie, body);
    expect(second.status).toBe(404);

    // Exactly one episode, so the append-only history did not gain a duplicate.
    const episodes = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.case_state_episodes
        WHERE conversation_id = $1 AND state = 'RESOLVED'`,
      [conversationId],
    );
    expect(episodes.rows[0].n).toBe(1);
  }, 120_000);

  it('produces something the closure sweep can actually close', async (ctx) => {
    if (skipUnlessReady(ctx, 'the resolve → close join was not exercised.')) return;

    const cookie = await signIn('owner');
    const { conversationId } = await openConversation(OWNER);

    expect(
      (await post(employeeRoutes.conversations.resolve(conversationId), cookie, { outcome: 'Done.' }))
        .status,
    ).toBe(201);

    /**
     * The sweep is driven directly with a zero window so the assertion is deterministic.
     * This is the join the gap broke: §21.4's `resolved → closed` row was implemented and
     * ran every tick against a predicate — `state = 'RESOLVED'` — that nothing in the
     * product could satisfy.
     */
    const sweep = new ReopenWindowClosureSweep({
      pool: pool!,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
      windowSeconds: 0,
    });
    const outcome = await sweep.run();
    expect(outcome.acted).toBeGreaterThan(0);

    const after = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(after.rows[0].state).toBe('CLOSED');

    // §21.4: CLOSED is terminal for the conversation. A staff reopen past the window is
    // refused by the transition table, not by a second window calculation here that could
    // disagree with the sweep's.
    const reopened = await post(employeeRoutes.conversations.reopen(conversationId), cookie, {
      reason: 'the customer rang back',
    });
    expect(reopened.status).toBe(404);
  }, 120_000);
});

describe('who may resolve (BR-19, P-03)', () => {
  it('permits a team lead, and refuses a colleague who merely holds AGENT', async (ctx) => {
    if (skipUnlessReady(ctx, 'the BR-19 actor rules were not exercised.')) return;

    const { conversationId } = await openConversation(OWNER);

    /**
     * P-03: an advisor who may answer is not thereby able to close. `AGENT` carries
     * `conversation.read` and `conversation.claim` and nothing that ends a conversation,
     * so this refusal comes from the authorization ladder before §21.4 is consulted.
     */
    const bystander = await signIn('bystander');
    expect(
      (await post(employeeRoutes.conversations.resolve(conversationId), bystander, {
        outcome: 'I think this is done.',
      })).status,
    ).toBe(404);

    // BR-19's second half: "Only the owner OR A LEAD may resolve."
    const lead = await signIn('lead');
    const response = await post(employeeRoutes.conversations.resolve(conversationId), lead, {
      outcome: 'Closed on the owner’s behalf while they are on leave.',
    });
    expect(response.status).toBe(201);

    const episodes = await pool!.query(
      `SELECT entered_by FROM conversation.case_state_episodes
        WHERE conversation_id = $1 AND state = 'RESOLVED'`,
      [conversationId],
    );
    expect(episodes.rows[0].entered_by).toBe(LEAD);
  }, 120_000);

  it('reopens on staff initiative, undoing the resolution and counting it', async (ctx) => {
    if (skipUnlessReady(ctx, 'the staff reopen path was not exercised.')) return;

    const cookie = await signIn('owner');
    const { conversationId, caseId } = await openConversation(OWNER);

    await post(employeeRoutes.conversations.resolve(conversationId), cookie, {
      outcome: 'Answered in full.',
    });

    // §21.4 requires a reason "if staff-initiated", and this endpoint always is.
    expect(
      (await post(employeeRoutes.conversations.reopen(conversationId), cookie, { reason: '  ' }))
        .status,
    ).toBe(404);

    const response = await post(employeeRoutes.conversations.reopen(conversationId), cookie, {
      reason: 'the outcome was wrong — the endorsement never went out',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ outcome: 'REOPENED' });

    /**
     * The resolution is UNDONE rather than annotated. `resolved_at` must be cleared or
     * the resolution clock stays stopped at a time in the past and the closure sweep
     * closes the conversation again on its next tick.
     */
    const serviceCase = await pool!.query(
      `SELECT state, resolved_at, outcome_code, reopen_count
         FROM conversation.service_cases WHERE case_id = $1`,
      [caseId],
    );
    expect(serviceCase.rows[0].state).toBe('ACTIVE');
    expect(serviceCase.rows[0].resolved_at).toBeNull();
    expect(serviceCase.rows[0].outcome_code).toBeNull();
    expect(serviceCase.rows[0].reopen_count).toBe(1);

    const episodes = await pool!.query(
      `SELECT state FROM conversation.case_state_episodes
        WHERE conversation_id = $1 ORDER BY effective_from`,
      [conversationId],
    );
    expect(episodes.rows.map((r) => r.state)).toEqual(['ACTIVE', 'RESOLVED', 'ACTIVE']);

    const audit = await pool!.query(
      `SELECT reason FROM audit.ledger WHERE target_id = $1 AND action = 'conversation.reopen'`,
      [conversationId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].reason).toContain('endorsement');

    // §10's `conversation.reopened.v1` — also customer-visible at the relay, also never
    // emitted before 2026-08-29.
    const reopened = await pool!.query(
      `SELECT payload FROM conversation.outbox
        WHERE aggregate_id = $1 AND event_name = 'conversation.reopened.v1'`,
      [conversationId],
    );
    expect(reopened.rowCount, 'no reopened event reached the outbox').toBe(1);
    expect((reopened.rows[0].payload as Record<string, unknown>).trigger).toBe('STAFF_REOPEN');
  }, 120_000);

  it('refuses to resolve an internal thread — BR-23, D-15', async (ctx) => {
    if (skipUnlessReady(ctx, 'the internal-conversation guard was not exercised.')) return;

    const conversationId = crypto.randomUUID();
    conversations.push(conversationId);
    /**
     * `state` is NULL, and it has to be: `conversations_state_presence` (migration 0001)
     * makes BR-23 a CHECK constraint — an internal conversation may not carry a lifecycle
     * state at all. So the database enforces this one row of §21.4 independently of the
     * application, and the guard below is defence in depth over a rule that is already
     * structural.
     */
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, state, title, last_activity_at)
       VALUES ($1,'INTERNAL_GROUP',NULL,'Underwriting huddle',$2)`,
      [conversationId, nowIso()],
    );

    /**
     * The LEAD is used deliberately. Their GLOBAL TEAM_LEAD grant carries
     * `conversation.resolve`, so the authorization ladder ALLOWS this — and the refusal
     * therefore comes from `isLifecycleBearing`, which is the thing under test. §21.4:
     * internal chat has "None. A thread exists and stays open indefinitely."
     */
    const lead = await signIn('lead');
    expect(
      (await post(employeeRoutes.conversations.resolve(conversationId), lead, {
        outcome: 'wrapping up the huddle',
      })).status,
    ).toBe(404);

    const after = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(after.rows[0].state).toBeNull();
  }, 120_000);
});
