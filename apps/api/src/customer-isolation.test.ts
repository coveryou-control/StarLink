/**
 * PHASE 4 EXIT CRITERION: customer isolation, at the HTTP boundary.
 *
 * `customer-projection.test.ts` fuzzes the serialiser. This is the other half, and the
 * one that matters more: it runs a REAL customer session against the REAL API and tries
 * to get at things a customer must never see. A projection can be perfect and the route
 * still leak, by loading the wrong row, by accepting an id the caller supplied, or by
 * simply not being behind the guard.
 *
 * The properties, in the order they would actually be attacked:
 *
 *   1. An internal note in the customer's OWN conversation never appears — not as text,
 *      not as a gap, not as a placeholder.
 *   2. Another customer's conversation is indistinguishable from one that does not
 *      exist. Same status, same body (§27.3).
 *   3. An employee cookie does not work on the customer surface, and vice versa.
 *   4. A customer cannot author an internal note by any request shape.
 *   5. Nothing in any customer response carries staff identifiers, case ids, SLA state,
 *      priority, escalation or ownership — checked by planting sentinels in the database
 *      and searching every response body for them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { customerRoutes, employeeRoutes } from '@starlink/shared-contracts';
import { assertDatabaseAllowed } from '@starlink/database';
import { SessionService, hashPassword } from '@starlink/security';
import { purgeConversations } from './test-support/purge-conversations.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const SESSION_SECRET = 'isolation-session-secret-0123456789abcdef';
const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

// `eeee` block: the `dddd` block belongs to the employee-directory fixtures, and
// reusing it made this suite's service_cases block that suite's cleanup — which
// surfaced as eight unrelated tests silently skipping. See fixture-ids.test.ts.
const AGENT = '018f2c5a-eeee-7000-8000-00000000000a';
const AGENT_USER = 'isolation.agent';
const AGENT_PASSWORD = 'isolation-agent-password-1';
const TEAM_ID = 'isolation-team';
const CATEGORY_ID = 'isolation-category';

/** Planted in the database; none may appear in any customer-facing response. */
const SENTINELS = {
  internalNote: 'SENTINEL_INTERNAL_NOTE_policy_looks_mis_sold',
  otherCustomerMessage: 'SENTINEL_OTHER_CUSTOMER_MESSAGE',
  priority: 'SENTINEL_PRIORITY_P1',
  ownerName: 'Isolation Agent',
};

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
/** The API's stdout, for the one test that needs the dev OTP. */
let apiOutput = '';

/**
 * Mints cookies only. Verification happens inside the API against the real database, so
 * this needs no identity source of its own — `issue()` signs, it does not check.
 */
const verifiedSessions = new SessionService({
  secret: SESSION_SECRET,
  identity: {
    async resolvePrincipal() {
      throw new Error('not used: this service only issues');
    },
    async verifyCredential() {
      throw new Error('not used');
    },
    async getSessionVersion() {
      throw new Error('not used');
    },
    async revokeSessions() {
      throw new Error('not used');
    },
    async health() {
      return { status: 'UP' as const, authority: 'MOCK' as const, checkedAt: new Date().toISOString() };
    },
  },
});
const createdPrincipals: string[] = [];
const createdConversations: string[] = [];

interface CustomerSession {
  cookie: string;
  principalId: string;
}

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ customer isolation tests SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Isolation Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Isolation Category',$2,true,true) ON CONFLICT (category_id) DO NOTHING`,
    [CATEGORY_ID, TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, username, display_name, department, credential_hash)
     VALUES ($1,'EMPLOYEE',$2,$3,'Service',$4)
     ON CONFLICT (principal_id) DO UPDATE SET credential_hash = EXCLUDED.credential_hash`,
    [AGENT, AGENT_USER, SENTINELS.ownerName, await hashPassword(AGENT_PASSWORD)],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'isolation-cursor-secret-0123456789abcdefg',
      SL_DB_MAX_CONNECTIONS: '5',
    },
    // stdout is captured for ONE test: the end-to-end journey needs the dev OTP, which
    // the sender writes to the log rather than returning (a code in a response body
    // would defeat the point of sending it out of band).
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  api.stdout?.on('data', (chunk: Buffer) => {
    apiOutput += chunk.toString();
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
  if (!ready) console.warn('\n  ⚠ customer isolation tests SKIPPED: the API did not start.\n');
}, 90_000);

/**
 * Cleanup, derived rather than tracked, and safe to run over residue.
 *
 * The first version deleted `service_cases` by a `createdCases` array that nothing ever
 * populated — case ids are generated server-side by intake, so the array stayed empty,
 * the cases survived, and deleting the agent principal then failed on
 * `service_cases_current_owner_id_fkey`. Every test passed and the SUITE still failed.
 *
 * So: scope everything to this suite's team and category, which the server stamps on
 * whatever it creates. That also makes the cleanup self-healing — a run killed halfway
 * leaves rows that the next run removes, instead of leaving a landmine for an unrelated
 * suite (which is exactly what happened to employee-directory).
 *
 * Order follows the foreign keys: children before parents, cases before principals.
 */
afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;

  // Every conversation this suite could have created, however the run ended.
  const owned = `
    SELECT c.conversation_id FROM conversation.conversations c
     LEFT JOIN conversation.service_cases sc ON sc.case_id = c.case_id
     WHERE sc.owning_team_id = $1
        OR sc.category_id = $2
        OR c.conversation_id = ANY($3::uuid[])`;
  const args = [TEAM_ID, CATEGORY_ID, createdConversations];

  try {
    await purgeConversations(pool, owned, args);
    await pool.query(
      `DELETE FROM conversation.service_cases
        WHERE owning_team_id = $1 OR category_id = $2 OR current_owner_id = $3`,
      [TEAM_ID, CATEGORY_ID, AGENT],
    );
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [...createdPrincipals, AGENT],
    ]);
    // Anonymous intake principals from a run that died before tracking them.
    await pool.query(
      /*
         Orphaned in EVERY sense, not just the one that was checked.

         This looked only at `participants`, so a Guest who had CREATED a surviving
         conversation was still deleted — or rather was attempted, refused by
         `conversations_created_by_fkey`, and took the whole teardown down with it. The
         suite's tests all passed and the FILE reported as failed, which is the least
         informative way for a cleanup to break.

         Three references, because three tables point at a principal from the customer side.
      */
      `DELETE FROM identity.principals ip
        WHERE ip.kind = 'CUSTOMER' AND ip.display_name = 'Guest'
          AND NOT EXISTS (SELECT 1 FROM conversation.participants p WHERE p.principal_id = ip.principal_id)
          AND NOT EXISTS (SELECT 1 FROM conversation.conversations c WHERE c.created_by = ip.principal_id)
          AND NOT EXISTS (SELECT 1 FROM conversation.service_cases s WHERE s.current_owner_id = ip.principal_id)`,
    );
    await pool.query(`DELETE FROM conversation.categories WHERE category_id = $1`, [CATEGORY_ID]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

const gate = (name: string, body: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!ready) {
      console.warn(`  ⚠ UNPROVEN: ${name}`);
      ctx.skip();
      return;
    }
    await body();
  });
};

const cookiesOf = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/**
 * A customer who has completed verification.
 *
 * The session is created through the real endpoint — so the principal row, the audit
 * entry and the cookie all exist exactly as in production — and the cookie is then
 * re-minted at PSEUDONYMOUS with the SAME secret the API was spawned with. That is the
 * one step the OTP would otherwise perform, and it is skipped here for a reason: the
 * dev sender only writes the code to a log, and parsing a log line would couple these
 * tests to a `console.log` format.
 *
 * Nothing is bypassed. The API still verifies the signature, the surface and the live
 * session version; only the round trip that raises assurance is short-circuited, and
 * that round trip has 20 tests of its own in `adapters/customer-identity`, plus one
 * end-to-end journey test below.
 */
async function startCustomer(): Promise<CustomerSession> {
  const response = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '+919999911111' }),
  });
  expect(response.status, 'starting a customer session must work').toBe(201);
  const body = (await response.json()) as { principalId: string };
  createdPrincipals.push(body.principalId);

  const { token } = verifiedSessions.issue({
    principalId: body.principalId as never,
    kind: 'CUSTOMER',
    surface: 'CUSTOMER',
    sessionVersion: 1,
    assurance: 'PSEUDONYMOUS',
  });
  return { cookie: `sl_cus_session=${token}`, principalId: body.principalId };
}

/** An ANONYMOUS session — used to prove intake now refuses one. */
async function startUnverifiedCustomer(): Promise<CustomerSession> {
  const response = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile: '+919999922222' }),
  });
  const body = (await response.json()) as { principalId: string };
  createdPrincipals.push(body.principalId);
  return { cookie: cookiesOf(response), principalId: body.principalId };
}

async function intake(session: CustomerSession, message: string): Promise<string> {
  const response = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session.cookie },
    body: JSON.stringify({ categoryId: CATEGORY_ID, subject: 'Isolation subject', message }),
  });
  expect(response.status, 'intake must succeed').toBe(201);
  const body = (await response.json()) as { conversationId: string };
  createdConversations.push(body.conversationId);
  return body.conversationId;
}

async function employeeCookie(): Promise<string> {
  const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AGENT_USER, password: AGENT_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return cookiesOf(response);
}

/** Adds the agent to a conversation and posts an internal note, straight into the DB. */
async function plantInternalNote(conversationId: string): Promise<void> {
  const at = new Date().toISOString();
  await pool!.query(
    `INSERT INTO conversation.participants
       (conversation_id, principal_id, principal_kind, role, added_by, effective_from, added_at)
     VALUES ($1,$2,'EMPLOYEE','OWNER',$2,$3,$3)
     ON CONFLICT DO NOTHING`,
    [conversationId, AGENT, at],
  );
  const seq = await pool!.query(
    `UPDATE conversation.conversations SET last_seq = last_seq + 1
      WHERE conversation_id = $1 RETURNING last_seq`,
    [conversationId],
  );
  await pool!.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
        sender_display_name, body)
     VALUES ($1,$2,$3,'INTERNAL',$4,'EMPLOYEE',$5,$6)`,
    [
      crypto.randomUUID(),
      conversationId,
      seq.rows[0].last_seq,
      AGENT,
      SENTINELS.ownerName,
      SENTINELS.internalNote,
    ],
  );
  // Plant case metadata a customer must never see.
  await pool!.query(
    `UPDATE conversation.service_cases sc
        SET priority = $2, current_owner_id = $3, escalation_level = 3
       FROM conversation.conversations c
      WHERE c.conversation_id = $1 AND sc.case_id = c.case_id`,
    [conversationId, SENTINELS.priority, AGENT],
  );
}

describe('customer isolation at the HTTP boundary', () => {
  gate('intake refuses a customer who has not proved a contact detail', async () => {
    // §21.5 places identity before routing and ADR-019 requires PSEUDONYMOUS to start
    // a conversation. Before this, a visitor could file a complaint we had no way to
    // answer, on the one surface §27.5 names as an abuse target. (D-02 — the business
    // has not yet ratified the screen ORDER; both orderings satisfy the documents.)
    const unverified = await startUnverifiedCustomer();

    const response = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: unverified.cookie },
      body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'Anonymous complaint.' }),
    });

    expect(response.status).toBe(404);
    const leaked = await pool!.query(
      `SELECT count(*)::int AS c FROM conversation.messages WHERE body = 'Anonymous complaint.'`,
    );
    expect(leaked.rows[0].c).toBe(0);
  });

  gate('category browsing needs no session at all', async () => {
    // §21.5: abandoning at the topic step must disclose nothing — so it must not even
    // create a principal.
    const response = await fetch(`${BASE}${customerRoutes.categories}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { categories: { categoryId: string }[] };
    expect(body.categories.some((c) => c.categoryId === CATEGORY_ID)).toBe(true);
  });

  gate('the whole verification journey works end to end, OTP included', async () => {
    /**
     * The one test that walks the real path rather than minting a cookie: browse topics
     * with no session → supply a mobile → receive a code → verify → chat.
     *
     * Everything else in this file short-circuits the OTP, so without this the raised
     * assurance bar would be proven only against a shortcut that skips the very step
     * that raises it.
     */
    const before = apiOutput.length;

    // 1. Topics, with no session at all.
    expect((await fetch(`${BASE}${customerRoutes.categories}`)).status).toBe(200);

    // 2. Supply a contact detail — this is where the session is created.
    const started = await fetch(`${BASE}${customerRoutes.auth.startSession}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '+919999977777' }),
    });
    expect(started.status).toBe(201);
    const cookie = cookiesOf(started);
    createdPrincipals.push(((await started.json()) as { principalId: string }).principalId);

    // 3. Ask for a code.
    const begun = await fetch(`${BASE}${customerRoutes.auth.verifyStart}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'OTP_MOBILE' }),
    });
    expect(begun.status).toBe(201);
    const { challengeId } = (await begun.json()) as { challengeId: string };

    // 4. Read the code from the dev log. It is deliberately NOT in the response — a
    // one-time code returned to the caller is not out of band, and the whole point of
    // sending it to the phone is that only the phone's holder sees it.
    await new Promise((r) => setTimeout(r, 250));
    const code = /\[dev-otp\][^\n]*: (\d{6})/.exec(apiOutput.slice(before))?.[1];
    expect(code, 'no dev OTP was logged; the sender may have changed').toBeDefined();

    // 5. An intake BEFORE verifying is refused.
    const early = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'too early' }),
    });
    expect(early.status).toBe(404);

    // 6. Verify.
    const completed = await fetch(`${BASE}${customerRoutes.auth.verifyComplete}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ challengeId, code }),
    });
    expect(completed.status).toBe(201);
    const verifiedCookie = cookiesOf(completed);
    const outcome = (await completed.json()) as { assurance: string; recognised: boolean };
    // No customer master exists yet, so a proven contact is PSEUDONYMOUS — real
    // evidence, unrecognised person. Honest, and visibly different from VERIFIED.
    expect(outcome.assurance).toBe('PSEUDONYMOUS');
    expect(outcome.recognised).toBe(false);

    // 7. Now intake works.
    const intake = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: verifiedCookie },
      body: JSON.stringify({ categoryId: CATEGORY_ID, message: 'Now I can ask my question.' }),
    });
    expect(intake.status).toBe(201);
    createdConversations.push(((await intake.json()) as { conversationId: string }).conversationId);
  });

  gate('an internal note never reaches the customer who owns the conversation', async () => {
    const customer = await startCustomer();
    const conversationId = await intake(customer, 'I have a question about my renewal.');
    await plantInternalNote(conversationId);

    const response = await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
      headers: { cookie: customer.cookie },
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    // Not the text, and not a placeholder marking where it was: the timing and volume of
    // internal discussion is most of the leak (§27.16).
    expect(text).not.toContain(SENTINELS.internalNote);
    expect(text).not.toContain('INTERNAL');
    expect(text).not.toContain(SENTINELS.ownerName);
    // The customer's own message IS there, so this is not passing by returning nothing.
    expect(text).toContain('I have a question about my renewal.');
  });

  gate('no customer response carries case, SLA, priority, escalation or owner data', async () => {
    const customer = await startCustomer();
    const conversationId = await intake(customer, 'Another question.');
    await plantInternalNote(conversationId);

    const bodies: string[] = [];
    for (const url of [
      `${BASE}${customerRoutes.conversations.list}`,
      `${BASE}${customerRoutes.conversations.messages(conversationId)}`,
      `${BASE}${customerRoutes.categories}`,
    ]) {
      const response = await fetch(url, { headers: { cookie: customer.cookie } });
      bodies.push(await response.text());
    }

    const combined = bodies.join('\n');
    for (const forbidden of [
      SENTINELS.priority,
      SENTINELS.ownerName,
      AGENT,
      'slaBreached',
      'escalationLevel',
      'caseId',
      'customerRef',
      'owningTeamId',
      'currentOwnerId',
      'sensitivity',
    ]) {
      expect(combined, `leaked: ${forbidden}`).not.toContain(forbidden);
    }
  });

  gate('another customer’s conversation is indistinguishable from one that does not exist', async () => {
    const alice = await startCustomer();
    const bob = await startCustomer();
    const aliceConversation = await intake(alice, 'Alice private message.');

    const asBob = await fetch(`${BASE}${customerRoutes.conversations.messages(aliceConversation)}`, {
      headers: { cookie: bob.cookie },
    });
    const nonexistent = await fetch(
      `${BASE}${customerRoutes.conversations.messages('018f2c5a-0000-7000-8000-00000000ffff')}`,
      { headers: { cookie: bob.cookie } },
    );

    // Same status AND same body: a difference in either is an existence oracle (§27.3).
    expect(asBob.status).toBe(nonexistent.status);
    expect(await asBob.text()).toBe(await nonexistent.text());
    expect(asBob.status).toBe(404);
  });

  gate('a customer cannot post into another customer’s conversation', async () => {
    const alice = await startCustomer();
    const bob = await startCustomer();
    const aliceConversation = await intake(alice, 'Alice message.');

    const response = await fetch(`${BASE}${customerRoutes.conversations.messages(aliceConversation)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: bob.cookie },
      body: JSON.stringify({ message: 'Bob should not be able to write here.' }),
    });

    expect(response.status).toBe(404);
    const stored = await pool!.query(
      `SELECT count(*)::int AS c FROM conversation.messages WHERE conversation_id = $1 AND body LIKE 'Bob%'`,
      [aliceConversation],
    );
    expect(stored.rows[0].c).toBe(0);
  });

  gate('a customer cannot write into a VERIFIED customer’s conversation', async () => {
    /**
     * The regression for a real hole.
     *
     * `belongsToActorCustomer` was computed as `conversation.customerRef !== undefined`
     * — "does this conversation have *a* customer reference?", which is true of every
     * customer conversation in the system. Any customer principal could therefore write
     * into any other customer's thread.
     *
     * Reproducing it needs a conversation that HAS a customer reference; two anonymous
     * intakes both have NULL and are denied for the wrong reason, so the plain
     * cross-customer test above would pass against the broken code. This one plants the
     * reference that makes the old condition true.
     */
    const alice = await startCustomer();
    const bob = await startCustomer();
    const aliceConversation = await intake(alice, 'Alice verified thread.');

    await pool!.query(
      `UPDATE conversation.conversations SET customer_ref = $2 WHERE conversation_id = $1`,
      [aliceConversation, 'CCS:customer:alice-1'],
    );

    const response = await fetch(`${BASE}${customerRoutes.conversations.messages(aliceConversation)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: bob.cookie },
      body: JSON.stringify({ message: 'SENTINEL_BOB_WROTE_INTO_ALICES_THREAD' }),
    });

    expect(response.status).toBe(404);
    const leaked = await pool!.query(
      `SELECT count(*)::int AS c FROM conversation.messages
        WHERE conversation_id = $1 AND body LIKE 'SENTINEL_BOB%'`,
      [aliceConversation],
    );
    expect(leaked.rows[0].c, 'Bob wrote into Alice’s conversation').toBe(0);
  });

  gate('a customer cannot author an internal note by any request shape', async () => {
    const customer = await startCustomer();
    const conversationId = await intake(customer, 'Opening message.');

    // The handler cannot express INTERNAL, so these must all land as CUSTOMER_VISIBLE
    // or be refused — never as an internal note authored by a customer.
    for (const body of [
      { message: 'attempt 1', visibility: 'INTERNAL' },
      { message: 'attempt 2', visibility: 'internal' },
      { message: 'attempt 3', Visibility: 'INTERNAL' },
    ]) {
      await fetch(`${BASE}${customerRoutes.conversations.messages(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: customer.cookie },
        body: JSON.stringify(body),
      });
    }

    const internal = await pool!.query(
      `SELECT count(*)::int AS c FROM conversation.messages
        WHERE conversation_id = $1 AND visibility = 'INTERNAL'`,
      [conversationId],
    );
    expect(internal.rows[0].c).toBe(0);
  });

  gate('an employee cookie does not work on the customer surface', async () => {
    const cookie = await employeeCookie();

    const response = await fetch(`${BASE}${customerRoutes.conversations.list}`, {
      headers: { cookie },
    });

    // Surfaces are disjoint: the guard reads a DIFFERENT cookie name per surface, so an
    // employee session is simply absent here rather than privileged.
    expect(response.status).toBe(401);
  });

  gate('a customer cookie does not work on the employee surface', async () => {
    const customer = await startCustomer();

    for (const path of [
      employeeRoutes.conversations.list,
      employeeRoutes.directory.search,
      employeeRoutes.admin.accounts,
    ]) {
      const response = await fetch(`${BASE}${path}`, { headers: { cookie: customer.cookie } });
      expect(response.status, `customer reached ${path}`).toBe(401);
    }
  });

  gate('category browsing works at ANONYMOUS assurance and marks provisional taxonomy', async () => {
    const customer = await startCustomer();

    const response = await fetch(`${BASE}${customerRoutes.categories}`, {
      headers: { cookie: customer.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      categories: { categoryId: string; provisional: boolean; owningTeamId?: string }[];
    };

    const seeded = body.categories.find((c) => c.categoryId === CATEGORY_ID);
    // §21.5: browsing precedes identity, so this must work before verification.
    expect(seeded).toBeDefined();
    // D-17/D-18 are unresolved; a placeholder must SAY it is one.
    expect(seeded?.provisional).toBe(true);
    // Internal structure is not the customer's (§25.3).
    expect(seeded?.owningTeamId).toBeUndefined();
  });

  gate('intake refuses an unknown category rather than defaulting one', async () => {
    const customer = await startCustomer();

    const response = await fetch(`${BASE}${customerRoutes.conversations.intake}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: customer.cookie },
      body: JSON.stringify({ categoryId: 'no-such-category', message: 'hello' }),
    });

    // Defaulting would file the request under something nobody chose and route it to the
    // wrong team once Phase 5 exists.
    expect(response.status).toBe(404);
  });

  gate('the customer sees only their own conversations in the list', async () => {
    const alice = await startCustomer();
    const bob = await startCustomer();
    await intake(alice, 'Alice thread.');
    const bobConversation = await intake(bob, 'Bob thread.');

    const response = await fetch(`${BASE}${customerRoutes.conversations.list}`, {
      headers: { cookie: bob.cookie },
    });
    const body = (await response.json()) as { conversations: { conversationId: string }[] };

    expect(body.conversations.map((c) => c.conversationId)).toEqual([bobConversation]);
  });
});

describe('a customer session can actually be ended', () => {
  /**
   * Signing out did nothing to a cookie that had already been copied.
   *
   * `SessionService.verify` returned `ok` for any non-EMPLOYEE token on signature and
   * expiry alone, skipping the version comparison its own comments call "THE check". So
   * `POST /auth/end` cleared the browser's copy, invalidated the OTP provider's record,
   * and left the token itself valid for the rest of its TTL — on a shared or kiosk
   * machine, that is the entire conversation, readable by whoever sits down next, with no
   * server-side way to stop them.
   *
   * The same gap silently disabled the assurance raise: `bindCustomerRef` bumps
   * `session_version` precisely so the pre-verification cookie stops working, and nothing
   * read the bump.
   */
  it('the cookie stops working after sign-out', async (ctx) => {
    if (!ready) {
      console.warn('  ⚠ UNPROVEN: customer session revocation');
      ctx.skip();
      return;
    }

    const customer = await startCustomer();

    // The control: it works BEFORE signing out. Without this the assertion below is
    // satisfied by a cookie that never worked at all.
    const before = await fetch(`${BASE}${customerRoutes.conversations.list}`, {
      headers: { cookie: customer.cookie },
    });
    expect(before.status, 'the session did not work even before sign-out').toBe(200);

    const ended = await fetch(`${BASE}${customerRoutes.auth.endSession}`, {
      method: 'POST',
      headers: { cookie: customer.cookie },
    });
    expect(ended.status).toBe(204);

    /**
     * The same cookie, replayed — as a copy taken from a shared browser would be. The
     * `clearCookie` in the response cannot reach it.
     */
    const after = await fetch(`${BASE}${customerRoutes.conversations.list}`, {
      headers: { cookie: customer.cookie },
    });
    expect(
      after.status,
      'the cookie still authenticates after sign-out — clearing the browser copy is not ' +
        'revocation, and a copy of it reads the whole conversation',
    ).toBe(401);
  });
});
