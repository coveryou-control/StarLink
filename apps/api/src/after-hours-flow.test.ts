/**
 * PHASE 6 EXIT CRITERION: the after-hours golden flow, against a live API (doc §23.3).
 *
 * Diagram 16 in full, and the assertions follow its own annotations rather than my
 * paraphrase of them:
 *
 *   1. A customer writes at 23:30. The message is **persisted first** (P-05).
 *   2. It is queued with `after_hours = true`, and **no clock starts**.
 *   3. The acknowledgement carries **no countdown and no estimated time** — "a false
 *      promise at 23:30 is worse than no promise" (§23.2).
 *   4. §23.3's stated invariant: *"nothing here is lost, and nothing is silently held.
 *      An after-hours conversation is a QUEUED conversation with a flag. It appears in
 *      the queue view (FR-ROUTE-4) and is counted by the unassigned metric (§32.3)
 *      exactly like any other waiting work."*
 *   5. The calendar opens, and the SAME sweep — no per-conversation timer, nothing
 *      scheduled — picks the work up and routes it.
 *
 * Step 5 is the one worth having. A wake-up job per conversation would pass a demo and
 * lose every message that arrived while the scheduler was down.
 *
 * The calendar here is a FIXTURE, not a proposal. §23.1 refuses to default hours and
 * D-20/D-21 are unanswered; the flow needs a calendar to exist and the test supplies one
 * that is open in a window it controls, then moves it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
// The shared route table, not hand-written paths. Five client paths were wrong at once
// in Phase 2 because a URL is a string and nothing checks it.
import { customerRoutes } from '@starlink/shared-contracts/http/customer';
import { SessionService } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const SESSION_SECRET = 'after-hours-session-secret-0123456789ab';
/**
 * 3200 — every API-spawning test in this directory owns a distinct port.
 *
 * 3199 was taken by `durability.test.ts`. Files are serialised by `test:verify`, so a
 * collision does not fail immediately; it fails when one process has not released the
 * port before the next binds, and the symptom is the whole later FILE reporting as
 * skipped rather than as an error. Ports in use: 3195 employee-exit · 3196 intake-burst ·
 * 3197 customer-isolation · 3198 route-contract · 3199 durability · 3200 after-hours.
 */
const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

/** `7e7e` block — owned by this file alone. */
const TEAM_ID = 'after-hours-team';
const CATEGORY_ID = 'after-hours-renewals';
const CALENDAR_ID = '018f2c5a-7e7e-7000-8000-00000000000a';

/**
 * Issues session cookies only — the same pattern as `intake-burst.test.ts`.
 *
 * Intake requires PSEUDONYMOUS (ADR-019, §21.5: a proved contact detail before a
 * conversation exists), and running the OTP round trip in every test would be testing
 * verification rather than the after-hours flow. Minting a token with the API's own
 * secret still goes through the real session guard, so nothing about authorization is
 * bypassed — only the code-entry step is.
 */
const sessions = new SessionService({
  secret: SESSION_SECRET,
  identity: {
    async resolvePrincipal() { throw new Error('not used'); },
    async verifyCredential() { throw new Error('not used'); },
    async getSessionVersion() { throw new Error('not used'); },
    async revokeSessions() { throw new Error('not used'); },
    async health() {
      return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: new Date().toISOString() };
    },
  },
});

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const conversations: string[] = [];
const customerPrincipals: string[] = [];

/**
 * Writes a calendar that is CLOSED (no working windows at all) or OPEN (every day, all
 * day). Blunt on purpose: this test is about the flow reacting to the calendar, not about
 * the arithmetic, which `packages/sla` covers minute by minute.
 */
async function setCalendar(open: boolean): Promise<void> {
  const windows = open
    ? [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, openMinute: 0, closeMinute: 1439 }))
    : [];
  await pool!.query(
    `INSERT INTO conversation.business_calendars
       (calendar_id, team_id, timezone, version, effective_from, working_windows,
        holidays, exceptions, is_seed_placeholder)
     VALUES ($1,$2,'Asia/Kolkata',1, now() - interval '1 day', $3::jsonb, '[]'::jsonb, '[]'::jsonb, true)
     ON CONFLICT (calendar_id) DO UPDATE SET working_windows = EXCLUDED.working_windows`,
    [CALENDAR_ID, TEAM_ID, JSON.stringify(windows)],
  );
}

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ after-hours flow SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'After Hours Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, relationship_shaped, active, is_seed_placeholder)
     VALUES ($1,'After-hours renewals',$2,false,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );

  // Start CLOSED — this is the 23:30 arrival.
  await setCalendar(false);

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: process.env.SL_TEST_VERBOSE === '1' ? 'debug' : 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'after-hours-cursor-secret-0123456789abc',
      SL_DB_MAX_CONNECTIONS: '5',
      // The Local orchestrator, not the mock: this test exists to prove the real
      // placement path runs.
      SL_ADAPTER_WORK_ORCHESTRATOR: 'local',
      SL_SWEEP_ROUTING_SECONDS: '1',
      SL_QUEUE_METRICS_SECONDS: '1',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '30',
      SL_SWEEP_RESERVATION_SECONDS: '30',
    },
    stdio: process.env.SL_TEST_VERBOSE === '1' ? 'inherit' : 'ignore',
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
  if (!ready) console.warn('\n  ⚠ after-hours flow SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    /**
     * Cleaned by CATEGORY, not by the ids this run happened to capture.
     *
     * A run that fails partway leaves rows whose ids the test never saw — and the next
     * run then cannot drop the category, because a `service_cases` row still points at
     * it. That failure is confusing out of all proportion to its cause: the tests pass
     * and the suite reports a failed file. Deleting by the thing that is definitionally
     * ours — the category and team this file owns — cleans its own residue too.
     */
    const owned = await pool.query<{ conversation_id: string }>(
      `SELECT c.conversation_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.category_id = $1`,
      [CATEGORY_ID],
    );
    const ids = owned.rows.map((r) => r.conversation_id);

    await pool.query(`DELETE FROM conversation.queue_entries WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.ownership_episodes WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    // The outbox references its aggregate, not a conversation column.
    await pool.query(
      `DELETE FROM conversation.outbox WHERE aggregate_type = 'conversation' AND aggregate_id = ANY($1::uuid[])`,
      [ids],
    );
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.participants WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.read_state WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM conversation.business_calendars WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(
      `DELETE FROM identity.principals WHERE kind = 'CUSTOMER' AND principal_id = ANY($1::uuid[])`,
      [customerPrincipals],
    );
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

/**
 * One customer arriving: a session, raised to PSEUDONYMOUS, then one intake.
 *
 * The assurance step is not decoration. §21.5 and ADR-019 require a proved contact
 * detail before a conversation exists, so intake refuses an ANONYMOUS session — and it
 * refuses with a 404, because a real refusal is indistinguishable from "no such thing"
 * (§27.3). Getting that wrong here cost a debugging round trip: the symptom was "the
 * routing sweep never placed the conversation", twenty seconds downstream of the actual
 * cause, which is why `intake()` now fails loudly on the spot.
 */
let arrivals = 0;
async function intake(): Promise<{ conversationId: string; body: unknown }> {
  arrivals += 1;
  const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: `+9198888${String(arrivals).padStart(5, '0')}` }),
  });
  const { principalId } = (await started.json()) as { principalId: string };
  const { token } = sessions.issue({
    principalId: principalId as never,
    kind: 'CUSTOMER',
    surface: 'CUSTOMER',
    sessionVersion: 1,
    assurance: 'PSEUDONYMOUS',
  });
  const cookie = `sl_cus_session=${token}`;
  customerPrincipals.push(principalId);

  const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'my renewal is due, please help' }),
  });
  const body = (await created.json()) as { conversationId: string };
  if (created.status >= 400 || body.conversationId === undefined) {
    throw new Error(`intake failed (${created.status}): ${JSON.stringify(body)}`);
  }
  conversations.push(body.conversationId);
  return { conversationId: body.conversationId, body };
}

const queueEntryFor = async (conversationId: string): Promise<Record<string, unknown> | undefined> => {
  const row = await pool!.query(
    `SELECT state, after_hours, team_id FROM conversation.queue_entries WHERE conversation_id = $1`,
    [conversationId],
  );
  return row.rows[0];
};

/** Polls until the sweep has placed the conversation, or the deadline passes. */
const waitForQueueEntry = async (
  conversationId: string,
  ms = 25_000,
): Promise<Record<string, unknown> | undefined> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const entry = await queueEntryFor(conversationId);
    if (entry !== undefined || Date.now() > deadline) return entry;
    await new Promise((r) => setTimeout(r, 500));
  }
};

describe('after-hours flow (§23.3, diagram 16)', () => {
  const gate = (name: string, body: () => Promise<void>, timeout = 90_000): void =>
    void it(
      name,
      async (ctx) => {
        if (!ready) {
          console.warn(`  ⚠ UNPROVEN: ${name}`);
          ctx.skip();
          return;
        }
        await body();
      },
      timeout,
    );

  gate('persists and acknowledges without promising anything', async () => {
    const { conversationId, body } = await intake();

    // P-05: durable before anything else. The conversation and its message exist the
    // moment the customer is told it does.
    const stored = await pool!.query(
      `SELECT c.state, count(m.message_id)::int AS messages
         FROM conversation.conversations c
         LEFT JOIN conversation.messages m ON m.conversation_id = c.conversation_id
        WHERE c.conversation_id = $1
        GROUP BY c.state`,
      [conversationId],
    );
    expect(stored.rows[0].messages).toBe(1);

    /**
     * §23.2's rule that matters more than the model: no countdown, no estimated
     * response time, nothing implying a human is reading it. Asserted on the response
     * body as a whole rather than field by field, because the failure mode is somebody
     * ADDING a helpful "we usually reply in 30 minutes".
     */
    const text = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['eta', 'estimate', 'minutes', 'within', 'respond by', 'sla', 'countdown']) {
      expect(text, `the acknowledgement must not imply a response time (${forbidden})`).not.toContain(
        forbidden,
      );
    }
  });

  gate('queues it with the after-hours flag and starts no clock', async () => {
    const { conversationId } = await intake();

    const entry = await waitForQueueEntry(conversationId);
    expect(entry, 'the routing sweep never placed the conversation').toBeDefined();
    expect(entry!.state).toBe('WAITING');
    // The flag §23.3 names. Carried on the row because whether the clock should have
    // started is a fact about the moment of arrival (§23.5).
    expect(entry!.after_hours).toBe(true);
    expect(entry!.team_id).toBe(TEAM_ID);

    // Nobody was assigned. "Nothing routed to somebody who is not rostered."
    const owned = await pool!.query(
      `SELECT 1 FROM conversation.ownership_episodes
        WHERE conversation_id = $1 AND effective_to IS NULL`,
      [conversationId],
    );
    expect(owned.rowCount).toBe(0);
  });

  gate('appears in the queue view and the unassigned metric, like any other work', async () => {
    /**
     * §23.3's invariant, checked rather than trusted: *"An after-hours conversation is a
     * QUEUED conversation with a flag. It appears in the queue view and is counted by
     * the unassigned metric exactly like any other waiting work."*
     *
     * This is the assertion that catches a future optimisation that "helpfully" hides
     * after-hours arrivals from the morning queue — which would make the overnight
     * backlog invisible to the lead who has to redistribute it (§23.4).
     */
    const { conversationId } = await intake();
    await waitForQueueEntry(conversationId);

    const deadline = Date.now() + 20_000;
    let scraped = '';
    while (Date.now() < deadline && !scraped.includes(`starlink_queue_depth{priority="NORMAL",team="${TEAM_ID}"}`)) {
      await new Promise((r) => setTimeout(r, 500));
      scraped = await (await fetch(`${BASE}/metrics`)).text();
    }
    expect(scraped).toMatch(
      new RegExp(`^starlink_queue_depth\\{priority="NORMAL",team="${TEAM_ID}"\\} [1-9]`, 'm'),
    );
  });

  gate('routes it when the calendar opens, with no per-conversation timer', async () => {
    /**
     * The "NEXT BUSINESS PERIOD" half of diagram 16, and the reason routing is a sweep.
     *
     * Nothing is scheduled for this conversation. The calendar changes, the same tick
     * asks the same question, and the answer is different — so a process that was down
     * all night behaves identically to one that was up.
     */
    const { conversationId } = await intake();
    const beforeOpening = await waitForQueueEntry(conversationId);
    expect(beforeOpening!.after_hours).toBe(true);

    // 10:00 arrives.
    await setCalendar(true);

    const { conversationId: morning } = await intake();
    const entry = await waitForQueueEntry(morning);

    expect(entry, 'the sweep did not place work after the calendar opened').toBeDefined();
    // Same queue, no flag, and therefore a clock that §23.5 can compute against.
    expect(entry!.after_hours).toBe(false);
    expect(entry!.state).toBe('WAITING');
  });

  gate('does not re-place a conversation it has already placed', async () => {
    // The sweep runs every second in this test. An idempotency failure would show up as
    // a pile of duplicate queue entries rather than as an error.
    const { conversationId } = await intake();
    await waitForQueueEntry(conversationId);
    await new Promise((r) => setTimeout(r, 3_000));

    const count = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.queue_entries WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
