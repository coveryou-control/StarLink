/**
 * PHASE 5 EXIT CRITERION: the employee-exit reassignment flow, end to end.
 *
 * §21.9 calls case C — departure — "the one that silently loses customers":
 *
 * > "A case owned by a deactivated principal is unreachable work"
 *
 * which is why §32.3 monitors `conversations owned by an inactive principal` with a
 * target of ZERO and §32.4 alerts on any non-zero value. This test walks the whole path
 * against a live API and watches that number go **1 → 0**:
 *
 *   1. An agent owns an open case.
 *   2. They are deactivated. The endpoint surfaces every case they owned and does NOT
 *      reassign — who inherits the work is a routing decision, deliberately separate.
 *   3. The invariant gauge reads non-zero. The work is visibly unreachable, not hidden.
 *   4. A lead reassigns. The gauge returns to zero.
 *
 * Step 3 is the one worth having. A system that reassigned automatically would look
 * tidier and would be worse: nobody would ever see that a departure left work stranded,
 * and the count that is supposed to prove it never happens would never move.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { hashPassword } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3195;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

/** `9d9d` block — owned by this file alone. */
const LEAVER = '018f2c5a-9d9d-7000-8000-00000000000a';
const SUCCESSOR = '018f2c5a-9d9d-7000-8000-00000000000b';
const LEAD = '018f2c5a-9d9d-7000-8000-00000000000c';
const LEAD_USER = 'exit.lead';
const LEAD_PASSWORD = 'exit-lead-password-1';
const TEAM_ID = 'exit-flow-team';

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
let conversationId: string;
const strayCases: string[] = [];
const strayConversations: string[] = [];
let caseId: string;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ employee-exit flow SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Exit Flow Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, username, display_name, department, credential_hash)
     VALUES ($1,'EMPLOYEE',NULL,'Departing Advisor','Service',NULL),
            ($2,'EMPLOYEE',NULL,'Succeeding Advisor','Service',NULL),
            ($3,'EMPLOYEE',$4,'Exit Lead','Service',$5)
     ON CONFLICT (principal_id) DO UPDATE SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
    [LEAVER, SUCCESSOR, LEAD, LEAD_USER, await hashPassword(LEAD_PASSWORD)],
  );
  /**
   * TWO roles, because the flow deliberately spans two permissions.
   *
   * `ADMIN` carries `admin.principal.deactivate`; `TEAM_LEAD` carries
   * `conversation.transfer`. Neither has both, and that is the design rather than an
   * inconvenience — deactivating someone and inheriting their customers are different
   * authorities (D-11). The fixture grants both to one person only because the test
   * needs to walk the whole path; production should not.
   */
  for (const role of ['ADMIN', 'TEAM_LEAD']) {
    await probe.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
       VALUES ($1,$2,$3,'GLOBAL',$2,now() - interval '1 day')
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), LEAD, role],
    );
  }

  caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  const at = new Date().toISOString();
  await probe.query(
    `INSERT INTO conversation.service_cases
       (case_id, state, owning_team_id, current_owner_id, designated_employee_id)
     VALUES ($1,'ACTIVE',$2,$3,$3)`,
    [caseId, TEAM_ID, LEAVER],
  );
  await probe.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, title, last_activity_at)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','Exit flow thread',$3)`,
    [conversationId, caseId, at],
  );
  await probe.query(
    `INSERT INTO conversation.ownership_episodes
       (episode_id, conversation_id, case_id, owner_id, effective_from, assignment_source)
     VALUES ($1,$2,$3,$4,$5,'ROUTED')`,
    [crypto.randomUUID(), conversationId, caseId, LEAVER, at],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: 'exit-flow-session-secret-0123456789abcd',
      SL_CURSOR_SECRET: 'exit-flow-cursor-secret-0123456789abcde',
      SL_DB_MAX_CONNECTIONS: '5',
      // Fast enough that the test observes a tick, slow enough not to hammer the
      // database while the rest of the flow runs.
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '1',
      SL_SWEEP_RESERVATION_SECONDS: '2',
      SL_QUEUE_METRICS_SECONDS: '1',
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
  if (!ready) console.warn('\n  ⚠ employee-exit flow SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    await pool.query(`DELETE FROM conversation.ownership_episodes WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [
      [conversationId, ...strayConversations],
    ]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [
      [caseId, ...strayCases],
    ]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [[LEAD]]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [LEAVER, SUCCESSOR, LEAD],
    ]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const cookiesOf = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

describe('employee exit and reassignment (§21.9 case C)', () => {
  it('surfaces owned work on deactivation, then restores the zero invariant', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: the employee-exit reassignment flow was not exercised.');
      ctx.skip();
      return;
    }

    const signIn = await fetch(`${BASE}/v1/employee/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: LEAD_USER, password: LEAD_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    const cookie = cookiesOf(signIn);

    // ── 1. Deactivate ────────────────────────────────────────────────────────────
    const deactivated = await fetch(`${BASE}/v1/employee/admin/deactivate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ principalId: LEAVER, reason: 'left the company' }),
    });
    expect(deactivated.status).toBe(201);
    const outcome = (await deactivated.json()) as {
      ownedOpenConversations: { caseId: string }[];
      reassignmentRequired: boolean;
    };

    // FR-EMP-3: every open case the leaver owned is surfaced. A deactivation that ended
    // their sessions but left the work invisible is the silent orphan BR-13 forbids.
    expect(outcome.reassignmentRequired).toBe(true);
    expect(outcome.ownedOpenConversations.map((c) => c.caseId)).toContain(caseId);

    // ── 2. The invariant is VISIBLY broken ───────────────────────────────────────
    const before = await fetch(`${BASE}/v1/employee/admin/inactive-owner-conversations`, {
      headers: { cookie },
    });
    const beforeBody = (await before.json()) as { count: number; healthy: boolean };
    // The point of step 2. Unreachable work is reported, not quietly absorbed — §32.4
    // alerts on exactly this number.
    expect(beforeBody.count).toBeGreaterThan(0);
    expect(beforeBody.healthy).toBe(false);

    // ── 3. Reassign ──────────────────────────────────────────────────────────────
    const reassigned = await fetch(`${BASE}/v1/employee/admin/reassign/${conversationId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ toOwner: SUCCESSOR, reason: 'previous advisor left the company' }),
    });
    expect(reassigned.status).toBe(201);

    // ── 4. Zero again ────────────────────────────────────────────────────────────
    const after = (await (
      await fetch(`${BASE}/v1/employee/admin/inactive-owner-conversations`, { headers: { cookie } })
    ).json()) as { count: number; healthy: boolean };
    expect(after.count).toBe(0);
    expect(after.healthy).toBe(true);
  }, 120_000);

  it('publishes the invariant as a scrapeable series, zero included', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: the alert series was not observed on a live process.');
      ctx.skip();
      return;
    }
    /**
     * The half of §32.4 that was missing.
     *
     * `alerts.yml` asks `starlink_inactive_owner_open_conversations > 0`, and until the
     * sweep was hosted NOTHING emitted that series. An alert whose series never appears
     * evaluates over no data and never fires — silence indistinguishable from health,
     * which is precisely the failure the zero-target exists to expose.
     *
     * So the assertion is not "the number is right" (the admin endpoint already proves
     * that). It is that the series EXISTS, on a real process, with a value — including
     * when that value is zero.
     */
    const scraped = await fetch(`${BASE}/metrics`);
    expect(scraped.status).toBe(200);
    expect(scraped.headers.get('content-type')).toContain('text/plain');

    const body = await scraped.text();
    expect(body).toContain('# TYPE starlink_inactive_owner_open_conversations gauge');
    expect(body).toMatch(/^starlink_inactive_owner_open_conversations \d+$/m);
  }, 60_000);

  it('scrapes without a session, because a scraper has none', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // Every other route answers 401 unauthenticated (see route-contract.test.ts). This
    // one must not, or the scrape configuration silently collects nothing.
    const scraped = await fetch(`${BASE}/metrics`);
    expect(scraped.status).toBe(200);
  }, 30_000);

  it('publishes the queue gauges the wait-time alert compares against', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: the queue gauges were not observed on a live process.');
      ctx.skip();
      return;
    }
    /**
     * `CustomerWaitingBeyondStandard` compares `starlink_oldest_waiting_seconds` against
     * a configured threshold. Both halves have to exist for the rule to mean anything,
     * and the gauge half is this one — the threshold is D-22/D-23 and arrives in Phase 6.
     */
    const teamMetricCase = crypto.randomUUID();
    const teamMetricConversation = crypto.randomUUID();
    strayCases.push(teamMetricCase);
    strayConversations.push(teamMetricConversation);
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
      [teamMetricCase, TEAM_ID],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED','queue gauge',now())`,
      [teamMetricConversation, teamMetricCase],
    );
    await pool!.query(
      `INSERT INTO conversation.queue_entries
         (queue_entry_id, conversation_id, case_id, team_id, priority, state, enqueued_at)
       VALUES ($1,$2,$3,$4,'NORMAL','WAITING', now() - interval '90 seconds')`,
      [crypto.randomUUID(), teamMetricConversation, teamMetricCase, TEAM_ID],
    );

    const deadline = Date.now() + 30_000;
    let body = '';
    while (Date.now() < deadline && !body.includes(`starlink_queue_depth{priority="NORMAL",team="${TEAM_ID}"}`)) {
      await new Promise((r) => setTimeout(r, 500));
      body = await (await fetch(`${BASE}/metrics`)).text();
    }

    expect(body).toContain(`starlink_queue_depth{priority="NORMAL",team="${TEAM_ID}"} 1`);
    // The value is not asserted: `enqueued_at` is written by the DATABASE clock and
    // compared against the APPLICATION clock, which on this machine differ by about a
    // minute (ADR-025). What matters is that the series exists and carries a number the
    // alert can compare — the store clamps the difference at zero so a skewed clock
    // cannot produce a queue item from the future.
    const waitingLine = new RegExp(`^starlink_oldest_waiting_seconds\\{team="${TEAM_ID}"\\} \\d+$`, 'm');
    expect(body).toMatch(waitingLine);
  }, 60_000);

  it('runs the sweep on a timer rather than only on request', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: the sweep was not observed running unprompted.');
      ctx.skip();
      return;
    }
    /**
     * A sweep hosted by nothing is a function with a test suite. This strands a case
     * WITHOUT touching any endpoint and waits for the scheduled tick to notice — so it
     * fails if the host is removed, if the interval is not read from configuration, or
     * if `schedule()` stops after its first run.
     */
    const strandedCase = crypto.randomUUID();
    strayCases.push(strandedCase);
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id)
       VALUES ($1,'ACTIVE',$2,$3)`,
      [strandedCase, TEAM_ID, LEAVER],
    );

    const readGauge = async (): Promise<number> => {
      const body = await (await fetch(`${BASE}/metrics`)).text();
      const match = /^starlink_inactive_owner_open_conversations (\d+)$/m.exec(body);
      return match === null ? -1 : Number(match[1]);
    };

    // Interval is one second; allow generously for a slow database round trip.
    const deadline = Date.now() + 30_000;
    let observed = await readGauge();
    while (observed < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      observed = await readGauge();
    }

    expect(observed, 'the scheduled sweep never published a non-zero count').toBeGreaterThan(0);
  }, 60_000);

  it('moves BOTH the owner and the designated employee (the only command that does)', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // §21.9 case C: the designation "must be reassigned". Leaving it pointing at someone
    // who has left means the customer's next contact routes to nobody — the silent loss
    // this whole flow exists to prevent.
    const row = await pool!.query(
      `SELECT current_owner_id, designated_employee_id FROM conversation.service_cases WHERE case_id = $1`,
      [caseId],
    );
    expect(row.rows[0].current_owner_id).toBe(SUCCESSOR);
    expect(row.rows[0].designated_employee_id).toBe(SUCCESSOR);
  });

  it('leaves exactly one live ownership episode, with the departure recorded', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const episodes = await pool!.query(
      `SELECT owner_id, effective_to, assignment_source, reason, previous_owner
         FROM conversation.ownership_episodes
        WHERE conversation_id = $1
        ORDER BY effective_from`,
      [conversationId],
    );

    const live = episodes.rows.filter((r) => r.effective_to === null);
    expect(live).toHaveLength(1);
    expect(live[0].owner_id).toBe(SUCCESSOR);
    expect(live[0].assignment_source).toBe('REASSIGNED_ON_EXIT');
    // Append-only: the leaver's episode is CLOSED, never deleted. "Who owned this in
    // March" has to stay answerable (§17.3).
    const closed = episodes.rows.filter((r) => r.effective_to !== null);
    expect(closed).toHaveLength(1);
    expect(closed[0].owner_id).toBe(LEAVER);
    expect(live[0].previous_owner).toBe(LEAVER);
    expect(live[0].reason).toBe('previous advisor left the company');
  });

  it('refuses to reassign to a deactivated principal', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    // Handing a departed colleague's work to another departed colleague is the same
    // failure with an extra step (BR-13).
    const signIn = await fetch(`${BASE}/v1/employee/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: LEAD_USER, password: LEAD_PASSWORD }),
    });
    const cookie = cookiesOf(signIn);

    const response = await fetch(`${BASE}/v1/employee/admin/reassign/${conversationId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ toOwner: LEAVER, reason: 'should not work' }),
    });

    expect(response.status).toBe(404);
  }, 60_000);
});
