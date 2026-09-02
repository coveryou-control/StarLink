/**
 * PHASE 6: reopening after resolution, end to end (BR-21, BR-22, §21.4, §22.4).
 *
 * Both branches of the same customer action — a reply to a conversation they were told
 * was resolved:
 *
 *   BR-21 — inside the window: the SAME thread, back to ACTIVE, same owner.
 *   BR-22 — after it: a NEW conversation, the SAME case, prior history linked for staff.
 *
 * The property that binds them is that the customer is never told which happened.
 * §21.4's last transition row says "No — it simply continues", and the assertions below
 * check the response body for that rather than trusting the handler to be discreet.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { customerRoutes } from '@starlink/shared-contracts/http/customer';
import { SessionService } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const SESSION_SECRET = 'reopen-flow-session-secret-0123456789';
const PORT = 3201;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

/** `re0p` is not hex; this file owns the `4e09` block. */
const TEAM_ID = 'reopen-flow-team';
const CATEGORY_ID = 'reopen-flow-category';
const OWNER = '018f2c5a-4e09-7000-8000-00000000000a';
const DEPARTED = '018f2c5a-4e09-7000-8000-00000000000b';

/** Two days, so "inside" and "outside" are both easy to construct. */
const WINDOW_SECONDS = 2 * 24 * 3600;

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
    console.warn('\n  ⚠ reopen flow SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Reopen Flow Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Reopen Flow',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','Reopen Owner','Service','ACTIVE'),
            ($2,'EMPLOYEE','Departed Owner','Service','EXITED')
     ON CONFLICT (principal_id) DO UPDATE SET status = EXCLUDED.status`,
    [OWNER, DEPARTED],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'reopen-flow-cursor-secret-0123456789ab',
      SL_DB_MAX_CONNECTIONS: '5',
      SL_REOPEN_WINDOW_SECONDS: String(WINDOW_SECONDS),
      // Quiet: this file is about the reply path, not about placement.
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
  if (!ready) console.warn('\n  ⚠ reopen flow SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    const owned = await pool.query<{ conversation_id: string }>(
      `SELECT c.conversation_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE sc.category_id = $1`,
      [CATEGORY_ID],
    );
    const ids = owned.rows.map((r) => r.conversation_id);
    for (const table of ['case_state_episodes', 'sla_notifications', 'business_links', 'queue_entries', 'messages', 'participants', 'read_state']) {
      await pool.query(`DELETE FROM conversation.${table} WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_type = 'conversation' AND aggregate_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [[OWNER, DEPARTED]]);
    await pool.query(`DELETE FROM identity.principals WHERE kind = 'CUSTOMER' AND principal_id = ANY($1::uuid[])`, [customerPrincipals]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

let arrivals = 0;

/** A verified customer with one conversation, resolved N seconds ago by `ownerId`. */
async function resolvedConversation(
  resolvedSecondsAgo: number,
  ownerId: string,
): Promise<{ conversationId: string; caseId: string; cookie: string }> {
  arrivals += 1;
  const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: `+9197777${String(arrivals).padStart(5, '0')}` }),
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
  const cookie = `sl_cus_session=${token}`;

  const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'my original question' }),
  });
  const body = (await created.json()) as { conversationId: string };
  if (created.status >= 400 || body.conversationId === undefined) {
    throw new Error(`intake failed (${created.status}): ${JSON.stringify(body)}`);
  }

  // Resolve it directly: the employee resolve endpoint is a separate surface, and this
  // file is about what happens on the CUSTOMER's next reply.
  const resolvedAt = new Date(Date.now() - resolvedSecondsAgo * 1000).toISOString();
  const caseRow = await pool!.query(
    `SELECT case_id FROM conversation.conversations WHERE conversation_id = $1`,
    [body.conversationId],
  );
  const caseId = caseRow.rows[0].case_id as string;

  await pool!.query(`UPDATE conversation.conversations SET state = 'RESOLVED' WHERE conversation_id = $1`, [body.conversationId]);
  await pool!.query(
    `UPDATE conversation.service_cases
        SET state = 'RESOLVED', resolved_at = $2, current_owner_id = $3, outcome_code = 'ANSWERED'
      WHERE case_id = $1`,
    [caseId, resolvedAt, ownerId],
  );
  await pool!.query(
    `INSERT INTO conversation.case_state_episodes (episode_id, conversation_id, state, effective_from)
     VALUES ($1,$2,'RESOLVED',$3)`,
    [crypto.randomUUID(), body.conversationId, resolvedAt],
  );

  return { conversationId: body.conversationId, caseId, cookie };
}

const reply = async (conversationId: string, cookie: string, text: string): Promise<Response> =>
  fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ message: text }),
  });

/**
 * A second, unrelated customer holding a genuine session and participating in nothing.
 *
 * `POST /v1/customer/auth/session` is `@Public()`, so this is not a privileged position —
 * it is what any anonymous visitor to the website can obtain, which is the whole point of
 * the isolation cases below.
 */
async function stranger(): Promise<string> {
  arrivals += 1;
  const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: `+9197777${String(arrivals).padStart(5, '0')}` }),
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
  return `sl_cus_session=${token}`;
}

/** Everything a reopen would move, read straight from the database. */
async function snapshot(conversationId: string, caseId: string) {
  const row = await pool!.query(
    `SELECT c.state, sc.resolved_at, sc.outcome_code, sc.reopen_count
       FROM conversation.conversations c
       JOIN conversation.service_cases sc ON sc.case_id = c.case_id
      WHERE c.conversation_id = $1`,
    [conversationId],
  );
  const siblings = await pool!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM conversation.conversations WHERE case_id = $1`,
    [caseId],
  );
  const messages = await pool!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM conversation.messages WHERE conversation_id = $1`,
    [conversationId],
  );
  return {
    state: row.rows[0].state as string,
    resolvedAt: row.rows[0].resolved_at as Date | null,
    outcome: row.rows[0].outcome_code as string | null,
    reopenCount: row.rows[0].reopen_count as number,
    conversationsOnCase: siblings.rows[0]!.count,
    messages: messages.rows[0]!.count,
  };
}

describe('reopening after resolution', () => {
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

  /**
   * The isolation cases.
   *
   * Until 2026-08-30 `reopenOnReply` ran BEFORE the only `decide()` on this path, loaded
   * the conversation with no participation predicate, and committed on its own connection.
   * A stranger's POST therefore mutated a real customer's case and then received a clean
   * 404 — the refusal was honest about the read and silent about the write.
   *
   * These assert the property the fix has to hold: **the refusal and the absence of any
   * mutation are the same event.** Checking only the status code would pass against the
   * broken version, which is precisely how it survived; every case below reads the rows
   * back afterwards.
   */
  gate('a stranger cannot revive a resolved conversation (rule 2, rule 3)', async () => {
    const { conversationId, caseId, cookie } = await resolvedConversation(3600, OWNER);
    const before = await snapshot(conversationId, caseId);
    // The fixture is only meaningful if it really is revivable by its owner.
    expect(before.state).toBe('RESOLVED');

    const response = await reply(conversationId, await stranger(), 'let me back in');

    // §27.3: the same refusal a nonexistent conversation gets.
    expect(response.status).toBe(404);

    const after = await snapshot(conversationId, caseId);
    expect(after, 'a refused reply must leave NOTHING behind').toEqual(before);

    // And the legitimate participant is unaffected — the check scopes, it does not lock.
    expect((await reply(conversationId, cookie, 'it is me')).status).toBe(201);
  });

  gate('a stranger cannot fork a new conversation onto a case (BR-22 path)', async () => {
    /**
     * The other write path, and the more damaging one: `forkConversation` INSERTs a
     * conversation, copies the participants of the original into it, links the history and
     * increments the case's reopen count. A stranger doing this attached a brand-new
     * thread to somebody else's case.
     */
    const { conversationId, caseId } = await resolvedConversation(5 * 24 * 3600, OWNER);
    const before = await snapshot(conversationId, caseId);
    expect(before.conversationsOnCase).toBe('1');

    const response = await reply(conversationId, await stranger(), 'picking this up again');
    expect(response.status).toBe(404);

    const after = await snapshot(conversationId, caseId);
    expect(after.conversationsOnCase, 'no conversation may be forked by a non-participant').toBe('1');
    expect(after, 'a refused reply must leave NOTHING behind').toEqual(before);
  });

  gate('a stranger cannot write a message to an open conversation either', async () => {
    // The same check guards the ordinary path, not only the reopen branches — otherwise
    // the fix would read as being about reopening rather than about authorization.
    const { conversationId, caseId, cookie } = await resolvedConversation(3600, OWNER);
    await reply(conversationId, cookie, 'reopening it myself');

    const before = await snapshot(conversationId, caseId);
    expect(before.state).toBe('ACTIVE');

    expect((await reply(conversationId, await stranger(), 'hello?')).status).toBe(404);
    expect(await snapshot(conversationId, caseId)).toEqual(before);
  });

  gate('BR-21 — a reply inside the window reopens the same thread', async () => {
    const { conversationId, cookie } = await resolvedConversation(3600, OWNER);

    const response = await reply(conversationId, cookie, 'actually, one more thing');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { conversationId: string };

    // The SAME conversation. Not a new one.
    expect(body.conversationId).toBe(conversationId);

    const row = await pool!.query(
      `SELECT c.state, sc.resolved_at, sc.reopen_count, sc.current_owner_id
         FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].state).toBe('ACTIVE');
    // The resolution is undone, or the resolution clock stays stopped in the past and
    // the closure sweep closes it again immediately.
    expect(row.rows[0].resolved_at).toBeNull();
    expect(row.rows[0].reopen_count).toBe(1);
    // BR-21's "to the same owner".
    expect(row.rows[0].current_owner_id).toBe(OWNER);
  });

  gate('BR-21 — does not reopen onto an owner who has left (BR-13)', async () => {
    /**
     * BR-21 says the same owner; BR-13 says a deactivated principal cannot own work.
     * Reopening onto one would recreate exactly the unreachable work §32.3 monitors with
     * a target of zero, so the thread reopens unowned and routing places it.
     */
    const { conversationId, cookie } = await resolvedConversation(3600, DEPARTED);

    await reply(conversationId, cookie, 'are you still there?');

    const row = await pool!.query(
      `SELECT c.state, sc.current_owner_id FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].state).toBe('ACTIVE');
    expect(row.rows[0].current_owner_id).toBeNull();
  });

  gate('BR-22 — a reply after the window continues on a new conversation, same case', async () => {
    const { conversationId, caseId, cookie } = await resolvedConversation(5 * 24 * 3600, OWNER);

    const response = await reply(conversationId, cookie, 'this came up again');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { conversationId: string };

    // A DIFFERENT conversation…
    expect(body.conversationId).not.toBe(conversationId);

    const fresh = await pool!.query(
      `SELECT case_id, state FROM conversation.conversations WHERE conversation_id = $1`,
      [body.conversationId],
    );
    // …against the SAME case. §22.4: one case spans many conversations, so a customer
    // returning about the same problem is not a second unrelated piece of work.
    expect(fresh.rows[0].case_id).toBe(caseId);

    // The old conversation is untouched — history, not a thing to revive.
    const old = await pool!.query(
      `SELECT state FROM conversation.conversations WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(old.rows[0].state).toBe('RESOLVED');
  });

  gate('BR-22 — a SECOND reply to the old id goes to the fork, not into the dead thread', async () => {
    /**
     * The half of item 5 that lived on the server, and was documented rather than fixed.
     *
     * `forkConversation` clears `resolved_at` on the SHARED case — it must, the case is
     * being worked again — while the old conversation keeps `state = 'RESOLVED'`. Read back
     * together those two facts say "resolved, but never resolved": the head query finds the
     * row, the RESOLVED gate passes, and `decideReopen` sees no `resolvedAt` and answers
     * STILL_OPEN. The reply was then written INTO the superseded conversation — which no
     * queue contains, which no agent is working, and which the closure sweep can never
     * close because that sweep keys on the `resolved_at` the fork just cleared.
     *
     * Two live threads on one case, the customer talking into the wrong one.
     *
     * It was reachable by anything that kept the id it first sent to: a retried POST, a
     * second tab, a native client, a proxy replay. The widget was patched to follow the
     * returned id, which fixed the common path and left the defect — so the correctness of
     * BR-22 rested on a React component never failing a GET.
     *
     * `reopenOnReply` now follows the `CONTINUES` link forward before deciding anything.
     */
    const { conversationId, caseId, cookie } = await resolvedConversation(5 * 24 * 3600, OWNER);

    const first = (await (await reply(conversationId, cookie, 'first time back')).json()) as {
      conversationId: string;
    };
    expect(first.conversationId, 'the fork did not happen — this tests nothing').not.toBe(
      conversationId,
    );

    // The customer's client did NOT learn the new id — it replies to the one it still holds.
    const second = await reply(conversationId, cookie, 'and one more thing');
    expect(second.status).toBe(201);
    const body = (await second.json()) as { conversationId: string };

    expect(
      body.conversationId,
      'the reply was accepted into the superseded conversation. Nobody is working it and ' +
        'no queue contains it, so the customer is talking to nobody.',
    ).toBe(first.conversationId);

    // Asserted against the row, not the response: the response could be right while the
    // write went elsewhere, and it is the WRITE that strands the customer.
    const written = await pool!.query(
      `SELECT conversation_id FROM conversation.messages WHERE body = $1`,
      ['and one more thing'],
    );
    expect(written.rowCount).toBe(1);
    expect(written.rows[0].conversation_id).toBe(first.conversationId);

    // And no third conversation was made: the successor is followed, not re-forked, so
    // `reopen_count` does not count a reopen that never happened.
    const onCase = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.conversations WHERE case_id = $1`,
      [caseId],
    );
    expect(onCase.rows[0].n, 'the second reply forked again instead of following').toBe(2);
  });

  gate('BR-22 — links the prior conversation for staff', async () => {
    const { conversationId, cookie } = await resolvedConversation(5 * 24 * 3600, OWNER);
    const body = (await (await reply(conversationId, cookie, 'again please')).json()) as {
      conversationId: string;
    };

    const link = await pool!.query(
      `SELECT ref_id, relation FROM conversation.business_links WHERE conversation_id = $1`,
      [body.conversationId],
    );
    expect(link.rows[0].ref_id).toBe(conversationId);
    expect(link.rows[0].relation).toBe('CONTINUES');
  });

  gate('BR-22 — the customer can read the conversation they were moved to', async () => {
    // Participation is what authorizes. A fork with no participants would be invisible
    // to the very person who caused it.
    const { conversationId, cookie } = await resolvedConversation(5 * 24 * 3600, OWNER);
    const body = (await (await reply(conversationId, cookie, 'hello again')).json()) as {
      conversationId: string;
    };

    const page = await fetch(`${BASE}${customerRoutes.conversations.messages(body.conversationId)}`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const messages = (await page.json()) as { messages: { body: string }[] };
    expect(messages.messages.map((m) => m.body)).toContain('hello again');
  });

  gate('tells the customer nothing about which rule applied', async () => {
    /**
     * §21.4's last transition row: "No — it simply continues." Whether a thread was
     * revived or forked is an internal boundary for measuring work (BR-22, §22.4), and
     * a response announcing it would leak that boundary and invite a question nobody
     * needs to answer.
     */
    const inside = await resolvedConversation(3600, OWNER);
    const outside = await resolvedConversation(5 * 24 * 3600, OWNER);

    const a = await (await reply(inside.conversationId, inside.cookie, 'one')).text();
    const b = await (await reply(outside.conversationId, outside.cookie, 'two')).text();

    for (const body of [a, b]) {
      const text = body.toLowerCase();
      for (const forbidden of ['reopen', 'closed', 'window', 'expired', 'new conversation', 'continued', 'fork']) {
        expect(text, `the reply response must not mention "${forbidden}"`).not.toContain(forbidden);
      }
    }

    // Both are ordinary message acknowledgements, differing only in the id they carry.
    expect(JSON.parse(a)).toHaveProperty('messageId');
    expect(JSON.parse(b)).toHaveProperty('messageId');
  });

  gate('an ordinary reply to an open conversation is unaffected', async () => {
    // The common case must not pay for the rare one: a reply to a live conversation goes
    // where it was sent, with nothing reopened and no counter moved.
    arrivals += 1;
    const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: `+9197777${String(arrivals).padStart(5, '0')}` }),
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
    const cookie = `sl_cus_session=${token}`;

    const created = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'first' }),
    });
    const { conversationId } = (await created.json()) as { conversationId: string };

    const body = (await (await reply(conversationId, cookie, 'second')).json()) as {
      conversationId: string;
    };
    expect(body.conversationId).toBe(conversationId);

    const row = await pool!.query(
      `SELECT sc.reopen_count FROM conversation.conversations c
         JOIN conversation.service_cases sc ON sc.case_id = c.case_id
        WHERE c.conversation_id = $1`,
      [conversationId],
    );
    expect(row.rows[0].reopen_count).toBe(0);
  });
});
