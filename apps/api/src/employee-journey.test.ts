/**
 * The employee journey, end to end: queue → claim → reply → transfer → resolve → reopen.
 *
 * ## Why this file exists
 *
 * The audit on 2026-08-29 found that every action in this sequence had a guarded, tested
 * endpoint and **no way to be invoked from the product**. An agent could read and reply and
 * nothing else — they could not take work from the queue, hand it on, or finish it. Each
 * endpoint had passing tests; none of them asked whether the sequence worked as a journey.
 *
 * So this drives the whole path over real HTTP against a real database, in the order a
 * person actually does it, using `employeeRoutes` — the same contract the web client
 * imports. A path that is wrong here is wrong in the UI too, which is where the previous
 * generation of this bug lived: four client paths were wrong and one had no server route.
 *
 * ## What it covers, by tracker id
 *
 *   SL-006  the queue is visible at all — "no invisible waiting"
 *   SL-037  claim, and the losing claim rendering as an outcome rather than an error
 *   SL-016  resolve and reopen, including the state machine refusing an invalid move
 *   SL-042  transfer, with BR-15's mandatory reason
 *   SL-043  escalation as a level, never a state
 *   SL-047  the SLA clocks an agent sees
 *   SL-060  in-app notifications reaching the person the work moved to
 *
 * ## What it does NOT cover
 *
 * React rendering. There is no jsdom or testing-library in `employee-web`, so nothing here
 * proves a button is on screen or wired to a handler. The complement is
 * `employee-web/src/lib/ui-consumers.test.ts`, which fails the build if a client method
 * has no component calling it. Between them: the journey is correct and no capability is
 * orphaned — but "the button renders" remains unproven and is recorded as such.
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

const PORT = 3207;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'employee-journey-session-secret-01234';
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `e309` block belongs to this file alone. */
const AGENT = '018f2c5a-e309-7000-8000-00000000000a';
const COLLEAGUE = '018f2c5a-e309-7000-8000-00000000000b';
/** A valid uuid belonging to nobody, for the mention-refusal case. */
const MENTION_OUTSIDER = '018f2c5a-e309-7000-8000-0000000000ff';
const TEAM_ID = 'journey-team';
const CATEGORY_ID = 'journey-category';
const CALENDAR_ID = '018f2c5a-e309-7000-8000-0000000000c1';

const CREDENTIALS = {
  agent: { username: 'journey.agent', password: 'journey-agent-password-1' },
  colleague: { username: 'journey.colleague', password: 'journey-colleague-pw-1' },
};

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
    console.warn('\n  ⚠ employee journey SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Journey Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Journey Topic',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$3,'Journey Agent','Service',$5,'ACTIVE'),
            ($2,'EMPLOYEE',$4,'Journey Colleague','Service',$6,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
    [
      AGENT,
      COLLEAGUE,
      CREDENTIALS.agent.username,
      CREDENTIALS.colleague.username,
      await hashPassword(CREDENTIALS.agent.password),
      await hashPassword(CREDENTIALS.colleague.password),
    ],
  );
  for (const principal of [AGENT, COLLEAGUE]) {
    await probe.query(
      `INSERT INTO identity.team_memberships (team_id, principal_id, role)
       VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`,
      [TEAM_ID, principal],
    );
    await probe.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
       VALUES ($1,$2,'AGENT','GLOBAL',$2, now() - interval '1 day')
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), principal],
    );
  }
  /**
   * A CLOSED calendar, deliberately.
   *
   * §23.3 queues an after-hours arrival rather than assigning it, which is what puts a row
   * in the queue for the agent to take. With an open calendar and a free agent the router
   * assigns directly and there is nothing to claim — a legitimate path, and the one G-15
   * covers. This file is about the queue, so it arranges for one.
   */
  await probe.query(
    `INSERT INTO conversation.business_calendars
       (calendar_id, team_id, timezone, version, effective_from, working_windows,
        holidays, exceptions, is_seed_placeholder)
     VALUES ($1,$2,'Asia/Kolkata',1, now() - interval '1 day', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, true)
     ON CONFLICT (calendar_id) DO UPDATE SET working_windows = '[]'::jsonb`,
    [CALENDAR_ID, TEAM_ID],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'employee-journey-cursor-secret-0123456',
      /**
       * A deliberately odd session lifetime, so the cookie assertion below cannot pass by
       * coincidence. 3725 seconds is about an hour — long enough for this suite, and a
       * number that matches no default, no rounding and no other constant in the repo.
       */
      SL_SESSION_TTL_SECONDS: '3725',
      SL_DB_MAX_CONNECTIONS: '5',
      SL_ADAPTER_WORK_ORCHESTRATOR: 'local',
      SL_SWEEP_ROUTING_SECONDS: '1',
      SL_SWEEP_SLA_SECONDS: '3600',
      SL_SWEEP_REOPEN_SECONDS: '3600',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
      SL_SWEEP_RESERVATION_SECONDS: '3600',
      // Notifications must actually be written for SL-060's step; the delivery sweep is
      // what moves them out of PENDING, and in-app has a transport.
      SL_SWEEP_NOTIFICATION_SECONDS: '1',
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
  if (!ready) console.warn('\n  ⚠ employee journey SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    const owned = await pool.query<{ conversation_id: string }>(
      `SELECT c.conversation_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.owning_team_id = $1`,
      [TEAM_ID],
    );
    const ids = owned.rows.map((r) => r.conversation_id);
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = ANY($1::uuid[])`, [ids]);
    await pool.query(
      `DELETE FROM conversation.notification_outbox WHERE recipient_id = ANY($1::uuid[])`,
      [[AGENT, COLLEAGUE]],
    );
    await pool.query(`DELETE FROM conversation.reservations WHERE ref_id = ANY($1::text[])`, [ids]);
    await resetTeamFixtures(pool, TEAM_ID);

    /**
     * The INTERNAL groups this file creates, which `resetTeamFixtures` does not reach.
     *
     * That helper clears work belonging to a TEAM — service cases, queue entries, the
     * conversations hanging off them. An internal group has no case and no team, so the
     * rows survived and `DELETE FROM identity.principals` below then hit
     * `conversations_created_by_fkey`: every test passed and the suite still failed, in
     * teardown, which is a miserable thing to read.
     *
     * Deleted children-first, because none of these cascade from the conversation.
     */
    const internal = await pool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM conversation.conversations
        WHERE created_by = ANY($1::uuid[]) AND conversation_type::text LIKE 'INTERNAL%'`,
      [[AGENT, COLLEAGUE]],
    );
    const internalIds = internal.rows.map((r) => r.conversation_id);
    if (internalIds.length > 0) {
      await pool.query(
        `DELETE FROM conversation.message_reactions
          WHERE message_id IN (SELECT message_id FROM conversation.messages
                                WHERE conversation_id = ANY($1::uuid[]))`,
        [internalIds],
      );
      // Revisions reference the message and do not cascade: the edit and delete cases
      // write them, and without this the message delete below hits the foreign key.
      await pool.query(
        `DELETE FROM conversation.message_revisions
          WHERE message_id IN (SELECT message_id FROM conversation.messages
                                WHERE conversation_id = ANY($1::uuid[]))`,
        [internalIds],
      );
      await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = ANY($1::uuid[])`, [
        internalIds,
      ]);
      await pool.query(
        `DELETE FROM conversation.participants WHERE conversation_id = ANY($1::uuid[])`,
        [internalIds],
      );
      await pool.query(`DELETE FROM conversation.read_state WHERE conversation_id = ANY($1::uuid[])`, [
        internalIds,
      ]);
      await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = ANY($1::uuid[])`, [
        internalIds,
      ]);
      await pool.query(
        `DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`,
        [internalIds],
      );
    }
    await pool.query(`DELETE FROM conversation.business_calendars WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM identity.team_memberships WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [
      [AGENT, COLLEAGUE],
    ]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [AGENT, COLLEAGUE],
    ]);
    await pool.query(
      `DELETE FROM identity.principals WHERE kind = 'CUSTOMER' AND principal_id = ANY($1::uuid[])`,
      [customerPrincipals],
    );
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const cookiesOf = (r: Response): string =>
  (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

async function signIn(who: keyof typeof CREDENTIALS): Promise<string> {
  const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREDENTIALS[who]),
  });
  expect(response.status, `${who} could not sign in`).toBe(200);
  return cookiesOf(response);
}

const post = (path: string, cookie: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

let arrivals = 0;

/** A customer arrives after hours, so the work lands in the team's queue (§23.3). */
async function customerArrives(): Promise<string> {
  arrivals += 1;
  const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: `+9198888${String(arrivals).padStart(5, '0')}` }),
  });
  const { principalId } = (await started.json()) as { principalId: string };
  customerPrincipals.push(principalId);

  const { token } = sessions.issue({
    principalId: principalId as never,
    kind: 'CUSTOMER',
    surface: 'CUSTOMER',
    sessionVersion: 1,
    assurance: 'PSEUDONYMOUS',
  });

  const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sl_cus_session=${token}` },
    body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'I need help with my renewal.' }),
  });
  const body = (await created.json()) as { conversationId: string };
  expect(created.status, `intake failed: ${JSON.stringify(body)}`).toBe(201);
  return body.conversationId;
}

/** Polls the team queue until the routing sweep has placed this conversation in it. */
async function waitForQueue(cookie: string, conversationId: string): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}${employeeRoutes.queues.one(TEAM_ID)}`, {
      headers: { cookie },
    });
    if (response.status === 200) {
      const { entries } = (await response.json()) as {
        entries: { conversationId: string }[];
      };
      if (entries.some((e) => e.conversationId === conversationId)) return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const skipUnlessReady = (ctx: { skip: () => void }, what: string): boolean => {
  if (ready) return false;
  console.warn(`  ⚠ UNPROVEN: ${what}`);
  ctx.skip();
  return true;
};

/**
 * The session cookie's lifetime, asserted on the wire (FR-AUTH-3, §26.1, §27.1).
 *
 * ## Why here, and why exactly
 *
 * `cookieOptionsFor` takes seconds and returns the milliseconds Express wants. Both call
 * sites have got that boundary wrong, in opposite directions and within two days:
 *
 *   * the customer surface passed seconds straight through, so a 30-minute session died
 *     after 1.8 seconds;
 *   * the employee handler then rebuilt the options by hand and multiplied by 1000 a
 *     SECOND time, so a 12-hour session became roughly 500 days.
 *
 * Neither was caught, for the same underlying reason: `session.test.ts` pins the HELPER,
 * and every API suite builds its `Cookie` header by hand — a hand-built header carries no
 * expiry, so nothing between the helper and the browser ever looked at `Max-Age`.
 *
 * This asserts the emitted `Max-Age` is EXACTLY the configured lifetime in seconds. An
 * exact equality rather than a range is the point: the ×1000 regression satisfies any
 * lower bound you would naturally write, which is precisely how the browser assertion
 * (`> 3600`) passed over 500 days.
 */
describe('the employee session cookie', () => {
  it('emits Max-Age in seconds, exactly the configured lifetime', async (ctx) => {
    if (skipUnlessReady(ctx, 'the session cookie was not observed on the wire.')) return;

    const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CREDENTIALS.agent),
    });
    expect(response.status).toBe(200);

    const setCookie = (response.headers.getSetCookie?.() ?? []).find((c) =>
      c.startsWith('sl_emp_session='),
    );
    expect(setCookie, 'no employee session cookie was set').toBeDefined();

    const maxAge = /(?:^|;\s*)Max-Age=(-?\d+)/i.exec(setCookie ?? '')?.[1];
    expect(maxAge, `no Max-Age in: ${setCookie ?? ''}`).toBeDefined();

    // The HTTP attribute is SECONDS. `SL_SESSION_TTL_SECONDS` is 3725 for this suite.
    expect(
      Number(maxAge),
      `Max-Age is ${maxAge ?? '?'}s. 3_725_000 is the seconds→milliseconds conversion ` +
        'applied twice; 3 is it applied to a value that was already milliseconds.',
    ).toBe(3725);
  });

  it('sets the flags §27.1 requires on the same response', async (ctx) => {
    // Kept beside the lifetime so that a rewrite of this handler has to keep both — the
    // regression above arrived in a hand-rebuilt options object that dropped nothing else,
    // and the next one might.
    if (skipUnlessReady(ctx, 'the session cookie flags were not observed on the wire.')) return;

    const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CREDENTIALS.agent),
    });
    const setCookie =
      (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('sl_emp_session=')) ?? '';

    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Strict/i);
    expect(setCookie).toMatch(/;\s*Path=\//i);
  });

  it('clears the cookie on sign-out rather than shortening it', async (ctx) => {
    if (skipUnlessReady(ctx, 'sign-out cookie clearing was not observed.')) return;

    const cookie = await signIn('agent');
    const out = await fetch(`${BASE}${employeeRoutes.auth.signOut}`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(out.status).toBe(204);

    const cleared =
      (out.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('sl_emp_session=')) ?? '';
    expect(cleared, 'sign-out did not clear the session cookie').not.toBe('');

    /**
     * The expiry must be in the PAST, not merely present.
     *
     * This asserted `/Expires=|Max-Age=0/` and claimed in a comment to catch "a
     * multiplication bug pushing it into the future". It could not: every `res.cookie` with
     * a `maxAge` emits an `Expires=` attribute, so a cookie set to expire in 500 days
     * satisfied that regex exactly as well as one set to 1970. The assertion tested the
     * attribute's presence and the comment described a test of its value.
     */
    const expiresAt = /(?:^|;\s*)Expires=([^;]+)/i.exec(cleared)?.[1];
    const maxAge = /(?:^|;\s*)Max-Age=(-?\d+)/i.exec(cleared)?.[1];

    expect(
      expiresAt !== undefined || maxAge !== undefined,
      `sign-out set no expiry at all: ${cleared}`,
    ).toBe(true);

    if (expiresAt !== undefined) {
      expect(
        Date.parse(expiresAt),
        `sign-out set an expiry of ${expiresAt} — a cookie that outlives the sign-out`,
      ).toBeLessThan(Date.now());
    }
    if (maxAge !== undefined) {
      expect(Number(maxAge), `sign-out set Max-Age=${maxAge}`).toBeLessThanOrEqual(0);
    }
  });
});

describe('the employee journey', () => {
  it('runs queue → claim → reply → transfer → resolve → reopen, with notifications', async (ctx) => {
    if (skipUnlessReady(ctx, 'the employee journey was not walked against a live API.')) return;

    const agent = await signIn('agent');
    const colleague = await signIn('colleague');
    const conversationId = await customerArrives();

    // ── SL-006. The queue is visible, and the conversation is in it ───────────────
    expect(
      await waitForQueue(agent, conversationId),
      'the conversation never appeared in the team queue — this is "invisible waiting"',
    ).toBe(true);

    // ── SL-037. The agent takes it ───────────────────────────────────────────────
    const claimed = await post(employeeRoutes.conversations.claim(conversationId), agent, {
      idempotencyKey: `journey-${conversationId}`,
    });
    expect(claimed.status).toBe(201);
    expect((await claimed.json()) as { outcome: string }).toMatchObject({ outcome: 'CLAIMED' });

    /**
     * A second claim by the OTHER agent is a losing race, and §44 makes that a 200 with
     * ALREADY_ASSIGNED rather than an error — an error status would be retried by any
     * well-behaved client, turning one settled race into a loop.
     */
    const lost = await post(employeeRoutes.conversations.claim(conversationId), colleague, {
      idempotencyKey: `journey-lost-${conversationId}`,
    });
    /**
     * The property that matters is that a losing claim is NOT an error status — an error
     * would be retried by any well-behaved client, turning one settled race into a loop.
     *
     * The exact code is 201, because Nest's default for a POST handler that returns a
     * value is 201 and this one does not override it. `routing.controller.ts` describes it
     * as "a 200", so the comment and the behaviour disagree; 201 Created is also the wrong
     * semantic for a claim that created nothing. Recorded rather than changed here —
     * altering a status code is a client-visible change and belongs in its own decision,
     * not inside a test that was written to observe the journey.
     */
    expect(lost.status, 'a losing claim must not be an error status').toBeLessThan(400);
    expect((await lost.json()) as { outcome: string }).toMatchObject({
      outcome: 'ALREADY_ASSIGNED',
    });

    // ── The reply. §21.4's `assigned → active` — "the reply itself" ──────────────
    const replied = await post(employeeRoutes.conversations.messages(conversationId), agent, {
      body: 'I can see the renewal and will sort it out today.',
      visibility: 'CUSTOMER_VISIBLE',
    });
    expect(replied.status).toBe(201);

    const afterReply = await fetch(
      `${BASE}${employeeRoutes.conversations.messages(conversationId)}`,
      { headers: { cookie: agent } },
    );
    expect(afterReply.status).toBe(200);
    // The state the action panel reads to decide between Resolve and Reopen.
    expect((await afterReply.json()) as { state?: string }).toMatchObject({ state: 'ACTIVE' });

    // ── SL-047. The SLA an agent sees ────────────────────────────────────────────
    const sla = await fetch(`${BASE}${employeeRoutes.conversations.sla(conversationId)}`, {
      headers: { cookie: agent },
    });
    expect(sla.status, 'the agent could not read the SLA state').toBe(200);

    // ── SL-042. Transfer, with BR-15's mandatory reason ──────────────────────────
    const noReason = await post(employeeRoutes.conversations.transfer(conversationId), agent, {
      toOwner: COLLEAGUE,
    });
    expect(noReason.status, 'BR-15: a transfer without a reason must be refused').toBe(404);

    const transferred = await post(employeeRoutes.conversations.transfer(conversationId), agent, {
      toOwner: COLLEAGUE,
      reason: 'colleague handles renewals for this product',
    });
    expect(transferred.status).toBe(201);

    // ── SL-016. The new owner finishes it, and BR-19 demands an outcome ──────────
    const blankOutcome = await post(employeeRoutes.conversations.resolve(conversationId), colleague, {
      outcome: '   ',
    });
    expect(blankOutcome.status, 'BR-19: an outcome is not optional').toBe(404);

    const resolved = await post(employeeRoutes.conversations.resolve(conversationId), colleague, {
      outcome: 'Renewal re-issued and confirmed with the customer.',
    });
    expect(resolved.status, 'the new owner could not resolve').toBe(201);

    // ── SL-016. And can put it back ──────────────────────────────────────────────
    const reopened = await post(employeeRoutes.conversations.reopen(conversationId), colleague, {
      reason: 'customer says the document still has not arrived',
    });
    expect(reopened.status).toBe(201);
    expect((await reopened.json()) as { outcome: string }).toMatchObject({ outcome: 'REOPENED' });

    // ── SL-060. The person the work moved to was told ────────────────────────────
    /**
     * §29.2: "A conversation transferred to/from you | Both parties | In-app + external."
     * The bell reads exactly this endpoint, so a count that never moves is a bell that
     * never rings — which is the state the surface was in until 2026-08-29.
     */
    type Notice = { event: string; subject: string; targetRef?: string };

    /**
     * Polled, because delivery is ASYNCHRONOUS by design.
     *
     * §29.1's P-05 writes the notification record first and attempts delivery afterwards,
     * and `listFor` returns only rows the sweep has marked SENT. So a read immediately
     * after the transfer legitimately shows nothing — the notification exists, it has not
     * been delivered yet. Asserting on the first read would have tested the sweep's
     * interval rather than the notification.
     */
    let transferNotice: Notice | undefined;
    const notifyDeadline = Date.now() + 20_000;
    while (Date.now() < notifyDeadline) {
      const notifications = await fetch(`${BASE}${employeeRoutes.notifications.list}`, {
        headers: { cookie: colleague },
      });
      expect(notifications.status).toBe(200);
      const { notifications: rows } = (await notifications.json()) as {
        notifications: Notice[];
      };
      transferNotice = rows.find((n) => n.event === 'TRANSFERRED');
      if (transferNotice !== undefined) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(transferNotice, 'the receiving colleague was never notified of the transfer').toBeDefined();
    // §29.2's own phrase, sent by the API so the wording exists in one place.
    expect(transferNotice!.subject).toBe('Transfer into or out of your ownership');
    expect(transferNotice!.targetRef).toBe(conversationId);

    const count = await fetch(`${BASE}${employeeRoutes.notifications.count}`, {
      headers: { cookie: colleague },
    });
    expect(((await count.json()) as { unread: number }).unread).toBeGreaterThan(0);
  }, 180_000);

  it('escalates as a level, never as a state (SL-043, §21.4)', async (ctx) => {
    if (skipUnlessReady(ctx, 'escalation was not exercised over the journey path.')) return;

    const agent = await signIn('agent');
    const conversationId = await customerArrives();
    expect(await waitForQueue(agent, conversationId)).toBe(true);

    await post(employeeRoutes.conversations.claim(conversationId), agent, {
      idempotencyKey: `esc-${conversationId}`,
    });

    const escalated = await post(employeeRoutes.conversations.escalate(conversationId), agent, {
      toOwner: COLLEAGUE,
      reason: 'grievance — needs a specialist',
    });
    expect(escalated.status).toBe(201);
    const body = (await escalated.json()) as { level: number };
    expect(body.level).toBeGreaterThan(0);

    /**
     * §21.4 is emphatic that escalation is a LEVEL on an orthogonal axis, not a state:
     * "a case can be ESCALATED and WAITING and BREACHED at once." So the conversation's
     * lifecycle state must be untouched by the escalation.
     */
    const state = await pool!.query(
      `SELECT c.state, sc.escalation_level
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    expect(state.rows[0].escalation_level).toBeGreaterThan(0);
    expect(['NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE']).toContain(state.rows[0].state);
  }, 180_000);
});

/**
 * The internal-chat capabilities added on 2026-09-01: renaming a group, reacting to a
 * message, and structured mentions with their notification.
 *
 * Driven over real HTTP against real PostgreSQL, in the same harness as the journey above,
 * because every one of them spans a schema change, a domain rule, an authorization
 * decision and a projection — and each of those is separately unit-tested precisely
 * because a green unit suite proves nothing about whether they are wired together.
 */
describe('internal chat: rename, reactions, mentions', () => {
  const withDb = (name: string, body: () => Promise<void>): void => {
    it(
      name,
      async (ctx) => {
        if (!ready) {
          console.warn(`  ⚠ UNPROVEN: ${name}`);
          ctx.skip();
          return;
        }
        await body();
      },
      60_000,
    );
  };

  const patch = (path: string, cookie: string, body: unknown): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  const del = (path: string, cookie: string, body: unknown): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  /** A fresh internal group between the two fixtures. */
  const makeGroup = async (cookie: string): Promise<string> => {
    const created = await post(employeeRoutes.conversations.create, cookie, {
      type: 'INTERNAL_GROUP',
      participantIds: [COLLEAGUE],
      title: 'Before',
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { conversationId: string }).conversationId;
  };

  interface PageMessage {
    readonly messageId: string;
    readonly mentions?: unknown;
    readonly reactions?: unknown;
  }

  const messagesOf = async (cookie: string, conversationId: string): Promise<PageMessage[]> => {
    const page = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    return ((await page.json()) as { messages: PageMessage[] }).messages;
  };

  withDb('renames a group, and the new name is what the list returns', async () => {
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);

    const renamed = await patch(employeeRoutes.conversations.rename(conversationId), cookie, {
      title: 'Q3 renewals huddle',
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ title: 'Q3 renewals huddle' });

    // Persisted, not merely echoed: read it back through the list projection.
    const list = await fetch(`${BASE}${employeeRoutes.conversations.list}`, { headers: { cookie } });
    const body = (await list.json()) as {
      conversations: { conversationId: string; title?: string }[];
    };
    const found = body.conversations.find((c) => c.conversationId === conversationId);
    expect(found?.title).toBe('Q3 renewals huddle');
  });

  withDb('refuses a rename from somebody who is not in the group', async () => {
    /**
     * The authorization that matters. `decide()` refuses a non-participant, and the
     * refusal is indistinguishable from "no such conversation" (§27.3).
     */
    const owner = await signIn('agent');
    const conversationId = await makeGroup(owner);
    const colleague = await signIn('colleague');

    const removed = await del(
      employeeRoutes.conversations.participant(conversationId, COLLEAGUE),
      owner,
      {},
    );
    expect(removed.status).toBe(204);

    const refused = await patch(employeeRoutes.conversations.rename(conversationId), colleague, {
      title: 'Not mine to name',
    });
    expect(refused.status).toBe(404);
  });

  withDb('refuses renaming a one-to-one', async () => {
    // A direct message is named after the person you are talking to; a title would
    // override that with something only one of the two chose.
    const cookie = await signIn('agent');
    const created = await post(employeeRoutes.conversations.create, cookie, {
      type: 'INTERNAL_DIRECT',
      participantIds: [COLLEAGUE],
    });
    const { conversationId } = (await created.json()) as { conversationId: string };

    const refused = await patch(employeeRoutes.conversations.rename(conversationId), cookie, {
      title: 'Anything',
    });
    expect(refused.status).toBe(404);
  });

  withDb('reacts, is idempotent, and un-reacts', async () => {
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);
    const sent = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: 'Numbers are in.',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const first = await post(
      employeeRoutes.conversations.reactions(conversationId, messageId),
      cookie,
      { emoji: '👍' },
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ changed: true });

    // Pressing it twice is one row, not an error: the primary key is the whole tuple.
    const again = await post(
      employeeRoutes.conversations.reactions(conversationId, messageId),
      cookie,
      { emoji: '👍' },
    );
    expect(await again.json()).toEqual({ changed: false });

    const messages = await messagesOf(cookie, conversationId);
    const message = messages.find((m) => m.messageId === messageId);
    expect(message?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);

    const gone = await del(
      employeeRoutes.conversations.reactions(conversationId, messageId),
      cookie,
      { emoji: '👍' },
    );
    expect(await gone.json()).toEqual({ changed: true });
    const after = await messagesOf(cookie, conversationId);
    expect(after.find((m) => m.messageId === messageId)?.reactions).toBeUndefined();
  });

  withDb('refuses a reaction on a message in another conversation', async () => {
    /**
     * The route names both ids, and the message must be IN the named conversation.
     * Without that check a caller could authorize against a thread they are in and write
     * a reaction onto a message belonging to one they are not.
     */
    const cookie = await signIn('agent');
    const mine = await makeGroup(cookie);
    const other = await makeGroup(cookie);
    const sent = await post(employeeRoutes.conversations.messages(other), cookie, {
      body: 'Elsewhere.',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const refused = await post(
      employeeRoutes.conversations.reactions(mine, messageId),
      cookie,
      { emoji: '👍' },
    );
    expect(refused.status).toBe(404);
  });

  withDb('stores mentions structurally and returns them on the page', async () => {
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: '@Journey Colleague can you check this',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'PRINCIPAL', principalId: COLLEAGUE, offset: 0, length: 18 }],
    });
    expect(sent.status).toBe(201);
    const { messageId } = (await sent.json()) as { messageId: string };

    const messages = await messagesOf(cookie, conversationId);
    /**
     * The OFFSETS come back, not just the ids: the renderer needs to know which run of
     * characters to mark, and re-deriving that by searching for a display name is how a
     * quoted name gets highlighted as a mention nobody made.
     */
    expect(messages.find((m) => m.messageId === messageId)?.mentions).toEqual([
      { kind: 'PRINCIPAL', principalId: COLLEAGUE, offset: 0, length: 18 },
    ]);
  });

  withDb('refuses a mention of somebody who is not in the conversation', async () => {
    /**
     * The dangerous case: a mention is a notification, and a notification points at a
     * conversation. Mentioning an outsider would send them a link `decide()` then refuses,
     * telling them a conversation exists and who is in it.
     */
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);

    const refused = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: '@Nobody at all',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'PRINCIPAL', principalId: MENTION_OUTSIDER, offset: 0, length: 7 }],
    });
    expect(refused.status).toBe(404);
  });

  withDb('@all notifies every other member, and never the sender', async () => {
    /**
     * The whole point of structured mentions. `@all` is expanded at SEND time against the
     * live participant set, so this asserts the NOTIFICATION landed — not merely that the
     * message stored an array.
     */
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);

    const countFor = async (principalId: string): Promise<number> => {
      const result = await pool!.query(
        `SELECT count(*)::int AS n FROM conversation.notification_outbox
          WHERE recipient_id = $1 AND event_name = 'MENTIONED'`,
        [principalId],
      );
      return result.rows[0].n as number;
    };

    const beforeColleague = await countFor(COLLEAGUE);
    const beforeSender = await countFor(AGENT);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: '@all standup moved to 10',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'ALL', offset: 0, length: 4 }],
    });
    expect(sent.status).toBe(201);

    expect(await countFor(COLLEAGUE), '@all did not notify the other member').toBe(
      beforeColleague + 1,
    );
    /**
     * §29.2's `NEVER_NOTIFIED` includes `OWN_ACTION`. The sender is covered by their own
     * `@all` and must not be told about it.
     */
    expect(await countFor(AGENT), 'the sender was notified of their own @all').toBe(beforeSender);
  });

  withDb('refuses @all on a one-to-one', async () => {
    // It would mean the one person already reading the message.
    const cookie = await signIn('agent');
    const created = await post(employeeRoutes.conversations.create, cookie, {
      type: 'INTERNAL_DIRECT',
      participantIds: [COLLEAGUE],
    });
    const { conversationId } = (await created.json()) as { conversationId: string };

    const refused = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: '@all hello',
      visibility: 'INTERNAL',
      mentions: [{ kind: 'ALL', offset: 0, length: 4 }],
    });
    expect(refused.status).toBe(404);
  });
  withDb('edits a message, keeps the previous text, and re-indexes it for search', async () => {
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);
    const sent = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: 'the aardvark figure is wrong',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const edited = await patch(
      employeeRoutes.conversations.message(conversationId, messageId),
      cookie,
      { body: 'the pangolin figure is wrong' },
    );
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { edited: boolean }).edited).toBe(true);

    const messages = await messagesOf(cookie, conversationId);
    const message = messages.find((m) => m.messageId === messageId) as
      | (PageMessage & { body?: string; editedAt?: string })
      | undefined;
    expect(message?.body).toBe('the pangolin figure is wrong');
    expect(message?.editedAt, 'the edit was not marked').toBeDefined();

    // The previous text survives for an investigation (§24.9).
    const history = await pool!.query(
      `SELECT revision_kind, previous_body FROM conversation.message_revisions
        WHERE message_id = $1`,
      [messageId],
    );
    expect(history.rows).toEqual([
      { revision_kind: 'CORRECTION', previous_body: 'the aardvark figure is wrong' },
    ]);

    /**
     * `search_vector` is GENERATED over `body`, so the index follows the edit with no
     * second write. Asserted against the column directly because that is the property —
     * the search endpoint is rate-limited and scoped, and this is about the index.
     */
    const indexed = await pool!.query(
      `SELECT search_vector @@ plainto_tsquery('english', 'pangolin') AS has_new,
              search_vector @@ plainto_tsquery('english', 'aardvark') AS has_old
         FROM conversation.messages WHERE message_id = $1`,
      [messageId],
    );
    expect(indexed.rows[0].has_new, 'the corrected text is not searchable').toBe(true);
    expect(indexed.rows[0].has_old, 'the replaced text is still searchable').toBe(false);
  });

  withDb('refuses an edit of somebody else’s message', async () => {
    // Editing another person's words is impersonation; there is no role that permits it.
    const owner = await signIn('agent');
    const conversationId = await makeGroup(owner);
    const sent = await post(employeeRoutes.conversations.messages(conversationId), owner, {
      body: 'mine to write',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const colleague = await signIn('colleague');
    const refused = await patch(
      employeeRoutes.conversations.message(conversationId, messageId),
      colleague,
      { body: 'not mine to change' },
    );
    expect(refused.status).toBe(404);

    const messages = await messagesOf(owner, conversationId);
    expect(
      (messages.find((m) => m.messageId === messageId) as { body?: string } | undefined)?.body,
      'a refused edit changed the message',
    ).toBe('mine to write');
  });

  withDb('deletes a message: the row survives, the text does not', async () => {
    const cookie = await signIn('agent');
    const conversationId = await makeGroup(cookie);
    const sent = await post(employeeRoutes.conversations.messages(conversationId), cookie, {
      body: 'a rhinoceros slipped into this sentence',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const removed = await del(
      employeeRoutes.conversations.message(conversationId, messageId),
      cookie,
      {},
    );
    expect(removed.status).toBe(200);

    /**
     * The ROW survives. Deleting it would leave a gap in the per-conversation sequence,
     * which the client's gap detector reads as a missed message and re-fetches forever.
     */
    const messages = await messagesOf(cookie, conversationId);
    const message = messages.find((m) => m.messageId === messageId) as
      | (PageMessage & { body?: string; redactedAt?: string })
      | undefined;
    expect(message, 'the message row was removed from the thread').toBeDefined();
    expect(message?.redactedAt).toBeDefined();
    expect(message?.body).toBe('');

    const gone = await pool!.query(
      `SELECT search_vector @@ plainto_tsquery('english', 'rhinoceros') AS found
         FROM conversation.messages WHERE message_id = $1`,
      [messageId],
    );
    expect(gone.rows[0].found, 'a deleted message is still findable by its text').toBe(false);

    const history = await pool!.query(
      `SELECT revision_kind, previous_body FROM conversation.message_revisions
        WHERE message_id = $1`,
      [messageId],
    );
    expect(history.rows[0].revision_kind).toBe('REDACTION');
    expect(history.rows[0].previous_body).toBe('a rhinoceros slipped into this sentence');

    /**
     * And the conversation-list preview no longer carries the deleted words.
     *
     * The preview is denormalised onto the conversation, so without a refresh the deleted
     * text stays on every sidebar showing this thread — which is the one place a colleague
     * is most likely to see it, and defeats the deletion entirely.
     */
    const preview = await pool!.query(
      'SELECT last_message_preview FROM conversation.conversations WHERE conversation_id = $1',
      [conversationId],
    );
    expect(
      preview.rows[0].last_message_preview,
      'the deleted text is still in the conversation-list preview',
    ).not.toContain('rhinoceros');
  });

  withDb('refuses deleting somebody else’s message', async () => {
    // Deleting another person's message is moderation — a policy nobody has decided.
    const owner = await signIn('agent');
    const conversationId = await makeGroup(owner);
    const sent = await post(employeeRoutes.conversations.messages(conversationId), owner, {
      body: 'still here',
      visibility: 'INTERNAL',
    });
    const { messageId } = (await sent.json()) as { messageId: string };

    const colleague = await signIn('colleague');
    const refused = await del(
      employeeRoutes.conversations.message(conversationId, messageId),
      colleague,
      {},
    );
    expect(refused.status).toBe(404);

    const messages = await messagesOf(owner, conversationId);
    expect(
      (messages.find((m) => m.messageId === messageId) as { body?: string } | undefined)?.body,
    ).toBe('still here');
  });
});
