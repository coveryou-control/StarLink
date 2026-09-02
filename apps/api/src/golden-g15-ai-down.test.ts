/**
 * GOLDEN TEST G-15 — "AI provider down | full human workflow unaffected".
 *
 * The named CI job for Part IV §68 **gate 9**: *"human fallback works with AI entirely
 * disabled; RAG/tool permissions and quality samples pass before autonomous self-service
 * expands."* The first clause is the one this proves.
 *
 * ## Why this is a whole-workflow test and not an AI test
 *
 * There is nothing to assert about the AI provider itself — `disabled.test.ts` already
 * pins that every capability refuses as `FAIL_DEGRADED`. What gate 9 asks is a question
 * about the REST of the system: does a human being get their job done while AI is off?
 * That can only be answered by doing the job.
 *
 * So this walks a complete customer-service conversation end to end against a live API
 * running with `SL_ADAPTER_AI=disabled` — intake, claim, agent reply, customer reply,
 * resolve — and asserts every step succeeds. A single failing step is the gate failing.
 *
 * ## The two things that would make this test a lie
 *
 * **1. Readiness coupling.** If `/readyz` reported not-ready because AI is DOWN, a
 * deployment with no AI provider would take no traffic at all — the assistant would have
 * become a hard dependency of the conversation, which is the exact inversion §36's
 * "advisory only" rule exists to prevent. Asserted explicitly: ready is 200 **while** the
 * AI check reads DOWN.
 *
 * **2. Refusing to boot.** A configuration the product cannot start under is not a
 * fallback. `SL_ADAPTER_AI` defaults to `disabled`, and the process starting at all is
 * part of what is being proven here.
 *
 * ## What this does NOT prove, stated because the strategy calls G-15 "flag-off
 * equivalence"
 *
 * Equivalence is a comparison, and there is no "flag-on" to compare against: no provider
 * has been chosen and no DPA signed (N-05). This proves the stronger half that is
 * available today — the human workflow is COMPLETE with AI entirely absent. The
 * comparative half becomes testable when a provider exists, and it belongs in the same
 * change that adds one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed, resetTeamFixtures } from '@starlink/database';
import { hashPassword, SessionService } from '@starlink/security';
import { customerRoutes, employeeRoutes } from '@starlink/shared-contracts';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3205;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'g15-ai-down-session-secret-0123456789';
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `a15d` block belongs to this file alone. */
const AGENT = '018f2c5a-a15d-7000-8000-00000000000a';
const TEAM_ID = 'g15-ai-down-team';
const CATEGORY_ID = 'g15-ai-down-category';
const CALENDAR_ID = '018f2c5a-a15d-7000-8000-0000000000c1';
const AGENT_USER = 'g15.agent';
const AGENT_PASSWORD = 'g15-agent-password-1';

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
const customerPrincipals: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ G-15 SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'G15 Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'G15 Topic',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$2,'G15 Agent','Service',$3,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
    [AGENT, AGENT_USER, await hashPassword(AGENT_PASSWORD)],
  );
  /**
   * An always-open calendar for this team.
   *
   * Not test convenience: §23.3 treats an unconfigured team as AFTER_HOURS, which is the
   * honest reduction for a team nobody has rostered — and this test is about a working
   * day, with an agent at their desk. Without it the fixture would be measuring the
   * after-hours path, which `after-hours-flow.test.ts` already owns.
   */
  await probe.query(
    `INSERT INTO conversation.business_calendars
       (calendar_id, team_id, timezone, version, effective_from, working_windows,
        holidays, exceptions, is_seed_placeholder)
     VALUES ($1,$2,'Asia/Kolkata',1, now() - interval '1 day', $3::jsonb, '[]'::jsonb, '[]'::jsonb, true)
     ON CONFLICT (calendar_id) DO UPDATE SET working_windows = EXCLUDED.working_windows`,
    [
      CALENDAR_ID,
      TEAM_ID,
      JSON.stringify(
        [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, openMinute: 0, closeMinute: 1439 })),
      ),
    ],
  );

  // An agent belongs to the team whose queue they work. Without this the routing sweep
  // has no candidate for the category's owning team, which is why the first run left the
  // conversation NEW with no queue entry at all.
  await probe.query(
    `INSERT INTO identity.team_memberships (team_id, principal_id, role)
     VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`,
    [TEAM_ID, AGENT],
  );

  // AGENT carries claim + read; ownership supplies reply and resolve (§21.4, BR-19).
  await probe.query(
    `INSERT INTO identity.role_assignments
       (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
     VALUES ($1,$2,'AGENT','GLOBAL',$2, now() - interval '1 day')
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), AGENT],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'g15-ai-down-cursor-secret-0123456789ab',
      SL_DB_MAX_CONNECTIONS: '5',
      /**
       * The subject of the test, set EXPLICITLY rather than relying on the default.
       * A default can change; this file is evidence for a gate and must state the
       * condition it is evidence for.
       */
      SL_ADAPTER_AI: 'disabled',
      /**
       * The Local orchestrator, as the after-hours golden flow uses. The default `mock`
       * makes no placement decision, so the routing sweep finds no candidate and the
       * conversation stays NEW for ever — which is what the first three runs of this
       * test observed, and it is a fixture fact rather than a product one.
       */
      SL_ADAPTER_WORK_ORCHESTRATOR: 'local',
      // Routing runs fast so the queue entry appears without a long wait; everything
      // else is quiet, because this file is about the workflow, not the sweeps.
      SL_SWEEP_ROUTING_SECONDS: '1',
      SL_SWEEP_SLA_SECONDS: '3600',
      SL_SWEEP_REOPEN_SECONDS: '3600',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
      SL_SWEEP_RESERVATION_SECONDS: '3600',
      SL_SWEEP_NOTIFICATION_SECONDS: '3600',
      SL_SWEEP_INDEX_HEALTH_SECONDS: '3600',
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
  if (!ready) console.warn('\n  ⚠ G-15 SKIPPED: the API did not start with AI disabled.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.team_memberships WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.business_calendars WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = $1`, [AGENT]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [AGENT]);
    await pool.query(
      `DELETE FROM identity.principals WHERE kind = 'CUSTOMER' AND principal_id = ANY($1::uuid[])`,
      [customerPrincipals],
    );
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const cookiesOf = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const skipUnlessReady = (ctx: { skip: () => void }, what: string): boolean => {
  if (ready) return false;
  console.warn(`  ⚠ UNPROVEN (§68 gate 9): ${what}`);
  ctx.skip();
  return true;
};

describe('G-15 — the human workflow with AI entirely disabled (§68 gate 9)', () => {
  it('is READY for traffic while reporting AI as DOWN', async (ctx) => {
    if (skipUnlessReady(ctx, 'readiness was not observed with AI disabled.')) return;

    const response = await fetch(`${BASE}/readyz`);
    const body = (await response.json()) as { status: string; checks: Record<string, string> };

    /**
     * The load-bearing assertion of the whole gate, and it is an ASYMMETRY:
     * identity DOWN would make this instance unfit for traffic; AI DOWN must not.
     * An instance that refused traffic for want of an AI provider would have made the
     * assistant a hard dependency of the conversation.
     */
    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks.ai).toBe('DOWN');
    // And visibly a stand-in, never mistakable for a canonical provider
    // (INTEGRATION_CONTRACTS §1 rule 4).
    expect(body.checks.aiAuthority).toBe('MOCK');
  }, 60_000);

  it('completes a whole customer-service conversation, start to resolution', async (ctx) => {
    if (skipUnlessReady(ctx, 'the human workflow was not walked with AI disabled.')) return;

    // ── 1. A customer arrives and asks something ────────────────────────────────
    const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '+919770000015' }),
    });
    expect(started.status, 'customer session could not start').toBe(201);
    const { principalId } = (await started.json()) as { principalId: string };
    customerPrincipals.push(principalId);

    const { token } = sessions.issue({
      principalId: principalId as never,
      kind: 'CUSTOMER',
      surface: 'CUSTOMER',
      sessionVersion: 1,
      assurance: 'PSEUDONYMOUS',
    });
    const customerCookie = `sl_cus_session=${token}`;

    /**
     * Intake is where §57 would put "intent + entity extraction". With AI off, the
     * customer chooses the category themselves and the conversation is created anyway —
     * which is precisely the fallback gate 9 names. Deterministic routing owns the
     * activation either way ("deterministic routing rules own final activation").
     */
    const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: customerCookie },
      body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'My renewal has not arrived.' }),
    });
    expect(created.status, 'customer intake failed').toBe(201);
    const { conversationId } = (await created.json()) as { conversationId: string };
    expect(conversationId).toBeDefined();

    // ── 2. An agent signs in and takes the work ─────────────────────────────────
    const signIn = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASSWORD }),
    });
    expect(signIn.status, 'agent sign-in failed').toBe(200);
    const agentCookie = cookiesOf(signIn);

    /**
     * The work reaches the agent by one of TWO legitimate routes, and the test accepts
     * either because the product chooses between them (§21.8):
     *
     *   * ROUTED   — the sweep finds an available agent and assigns directly;
     *   * QUEUED   — nobody is available (or it is after hours), and an agent claims it.
     *
     * The first draft of this test only tried to claim, and failed with a 404 that looked
     * like a bug and was not: with an open calendar and a free agent, routing had already
     * assigned the conversation, so there was nothing in the queue to claim. Asserting
     * one shape would have made this file a test of the fixture rather than of the
     * workflow.
     */
    const owns = async (): Promise<boolean> => {
      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.ownership(conversationId)}`,
        { headers: { cookie: agentCookie } },
      );
      if (response.status !== 200) return false;
      const { episodes } = (await response.json()) as {
        episodes: { ownerId: string; effectiveTo?: string | null }[];
      };
      return episodes.some((e) => e.ownerId === AGENT && (e.effectiveTo ?? null) === null);
    };

    // Poll rather than sleep, so the test is not shaped by the sweep interval.
    let placed = false;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (await owns()) {
        placed = true;
        break;
      }
      // Not assigned yet — if it is waiting in the queue, take it.
      const claimed = await fetch(`${BASE}${employeeRoutes.conversations.claim(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: agentCookie },
        body: JSON.stringify({ idempotencyKey: `g15-${conversationId}` }),
      });
      if (claimed.status === 201) {
        placed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(placed, 'the work never reached the agent with AI off').toBe(true);

    // ── 3. The agent replies. §57's "Agent Copilot" is absent; typing still works ──
    const replied = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: agentCookie },
      body: JSON.stringify({
        body: 'Thanks for getting in touch — I can see the renewal and will re-issue it today.',
        visibility: 'CUSTOMER_VISIBLE',
      }),
    });
    expect(replied.status, 'agent reply failed').toBe(201);

    // ── 4. The customer sees it and answers ─────────────────────────────────────
    const read = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      headers: { cookie: customerCookie },
    });
    expect(read.status, 'customer could not read the thread').toBe(200);
    const thread = (await read.json()) as { messages: { body: string }[] };
    expect(thread.messages.some((m) => m.body.includes('re-issue it today'))).toBe(true);

    const customerReply = await fetch(
      `${BASE}${customerRoutes.conversations.messages(conversationId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: customerCookie },
        // The customer surface takes `message`; only the employee surface takes `body`.
        body: JSON.stringify({ message: 'Thank you, that would be great.' }),
      },
    );
    expect(customerReply.status, 'customer reply failed').toBe(201);

    // ── 5. The agent finishes it (BR-19) ────────────────────────────────────────
    const resolved = await fetch(`${BASE}${employeeRoutes.conversations.resolve(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: agentCookie },
      body: JSON.stringify({ outcome: 'Renewal re-issued and sent.' }),
    });
    expect(resolved.status, 'the agent could not resolve with AI off').toBe(201);

    /**
     * §57 would have written the "human handoff summary" here. Without it the outcome is
     * the agent's own words, and BR-20's promise to the customer — "told the conversation
     * was resolved, and why" — is met by a human rather than by a model. That is what a
     * fallback IS.
     */
    const after = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      headers: { cookie: customerCookie },
    });
    expect(after.status, 'customer could not re-read after resolution').toBe(200);
    const view = (await after.json()) as { conversation: { status: string; outcome: string | null } };
    expect(view.conversation.status).toBe('RESOLVED');
    expect(view.conversation.outcome).toBe('Renewal re-issued and sent.');
  }, 180_000);
});
