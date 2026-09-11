/**
 * PHASE 2 EXIT CRITERION: message durability across an API death.
 *
 * "Kill the API after commit → the message survives, and the event heals via the relay."
 *
 * This is invariant #1 of the whole system — *a message is durable before it is
 * delivered, never the reverse* — and it is the one claim that cannot be demonstrated
 * by a unit test, because what is under test is what happens when the process stops
 * existing. So this test spawns the real API as a child process and SIGKILLs it. No
 * graceful shutdown, no `finally` block, no chance to flush anything: SIGKILL cannot be
 * trapped, which is the point. A test that sent SIGTERM would be testing our shutdown
 * handler, not durability.
 *
 * The two halves:
 *
 *   1. **Durable.** After the kill, the message row is in the database and its outbox
 *      row is still PENDING. Nothing was lost, and nothing was published — the send was
 *      acknowledged on the strength of the commit alone (P-05).
 *   2. **Heals.** A relay started afterwards — a different process, with no knowledge of
 *      the dead one — drains that outbox row and publishes the event. Delivery is
 *      recovered without the original process ever coming back.
 *
 * The dangerous alternative this rules out is publish-then-commit, or publishing inline
 * from the request handler: either would make this exact sequence lose the event
 * permanently, and nothing in the response to the caller would have said so.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { OutboxRelay } from '@starlink/outbox-relay';
import { MockEventPublisher } from '@starlink/adapter-event-bus';
import { InProcessBackplane } from '@starlink/adapter-realtime-backplane';
import { createLogger } from '@starlink/observability';
import { assertDatabaseAllowed } from '@starlink/database';
import { hashPassword } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const TEAM_ID = 'durability-team';
const SENDER_ID = '018f2c5a-7777-7000-8000-0000000000a1';
const PEER_ID = '018f2c5a-7777-7000-8000-0000000000a2';
const USERNAME = 'durability.sender';
const PASSWORD = 'durability-test-password-1';
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolve(here, '..', 'dist', 'main.js');

let pool: pg.Pool | undefined;
let available = false;
let api: ChildProcess | undefined;
let conversationId: string;
let caseId: string;

const logger = createLogger({ service: 'durability-test', sink: () => undefined });

async function waitForReady(timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ durability test SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Durability Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, username, display_name, department, credential_hash)
     VALUES ($1,'EMPLOYEE',$3,'Durability Sender','Service',$4),
            ($2,'EMPLOYEE',NULL,'Durability Peer','Service',NULL)
     ON CONFLICT (principal_id) DO UPDATE SET credential_hash = EXCLUDED.credential_hash`,
    [SENDER_ID, PEER_ID, USERNAME, await hashPassword(PASSWORD)],
  );

  caseId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await probe.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id)
     VALUES ($1,'ACTIVE',$2,$3)`,
    [caseId, TEAM_ID, SENDER_ID],
  );
  await probe.query(
    `INSERT INTO conversation.conversations (conversation_id, conversation_type, case_id, state, title)
     VALUES ($1,'INTERNAL_GROUP',NULL,NULL,'Durability thread')`,
    [conversationId],
  );
  await probe.query(
    // `effective_from` is stamped from THIS process's clock, exactly as the application
    // now does. Leaving it to the database default would make this test depend on the
    // dev machine and the database agreeing about the time — which is the bug that sent
    // me looking here in the first place.
    `INSERT INTO conversation.participants
       (conversation_id, principal_id, principal_kind, role, added_by, effective_from, added_at)
     VALUES ($1,$2,'EMPLOYEE','MEMBER',$2,$4,$4), ($1,$3,'EMPLOYEE','MEMBER',$2,$4,$4)`,
    [conversationId, SENDER_ID, PEER_ID, new Date().toISOString()],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: 'durability-session-secret-0123456789abcdef',
      SL_CURSOR_SECRET: 'durability-cursor-secret-0123456789abcdef',
      SL_DB_MAX_CONNECTIONS: '4',
    },
    stdio: 'ignore',
  });

  if (!(await waitForReady())) {
    available = false;
    console.warn('\n  ⚠ durability test SKIPPED: the API did not become ready.\n');
  }
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM conversation.messages WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM conversation.participants WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = $1`, [caseId]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1)`, [[SENDER_ID, PEER_ID]]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

describe('message durability across an API kill (Phase 2 exit criterion)', () => {
  it('keeps the message and heals the event after SIGKILL', async (ctx) => {
    if (!available) {
      // A gate that did not run must never report green. Say what is unproven.
      console.warn(
        '  ⚠ UNPROVEN: durability across an API kill was not exercised (no database or API).',
      );
      ctx.skip();
      return;
    }

    // --- sign in against the real, running API -------------------------------------
    const signIn = await fetch(`${BASE}/v1/employee/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(signIn.status, 'sign-in must succeed for this test to mean anything').toBe(200);
    const cookie = (signIn.headers.getSetCookie?.() ?? []).join('; ');
    expect(cookie).toContain('sl_emp_session');

    // --- send a message ------------------------------------------------------------
    const idempotencyKey = `durability-${crypto.randomUUID()}`;
    const sent = await fetch(`${BASE}/v1/employee/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        body: 'This message must outlive the process that accepted it.',
        visibility: 'INTERNAL',
        idempotencyKey,
      }),
    });
    expect(sent.status).toBe(201);
    const { messageId } = (await sent.json()) as { messageId: string };
    expect(messageId).toBeTruthy();

    /**
     * Reserve this conversation's outbox rows before anything else can claim them.
     *
     * ## Why this is here
     *
     * This test was intermittently failing on `the event must be pending, not silently
     * dropped: expected 0 to be greater than 0`, and it was read as a flaky race in the
     * product. It is not. The realtime gateway runs the system's ONLY `OutboxRelay`
     * (`apps/realtime-gateway/src/main.ts`), on a timer, against this same database —
     * so when the dev stack is up, that relay publishes this test's event during the
     * seconds this test spends killing the API, and the row is `PUBLISHED` by the time
     * the assertion below reads it. Nothing was dropped; something else delivered it.
     *
     * The evidence is visible in any dev database: `conversation.outbox` holds tens of
     * thousands of rows and zero `PENDING` ones, because the relay keeps it at zero.
     *
     * ## Why a lock rather than a looser assertion
     *
     * "The event is still waiting" is half of what rule 1 means here, so weakening it to
     * "the event exists in some state" would remove the thing being tested. Instead the
     * test claims its own rows the same way the relay claims work — the relay selects
     * `FOR UPDATE SKIP LOCKED`, so a row this transaction holds is one it will skip.
     * That is the mechanism working as designed, not a trick.
     *
     * The window is not zero: another relay could still claim the row between the send
     * committing and this lock. It is now the round-trip of one already-returned HTTP
     * response rather than the several seconds a SIGKILL and its exit wait take, and the
     * check below names the cause if it ever loses that race.
     */
    const reserved = await pool!.connect();
    await reserved.query('BEGIN');
    await reserved.query(
      `SELECT outbox_id FROM conversation.outbox WHERE aggregate_id = $1 FOR UPDATE`,
      [conversationId],
    );

    // --- kill the API the instant it has acknowledged -------------------------------
    // SIGKILL, not SIGTERM: SIGKILL cannot be trapped, so no shutdown hook, no flush,
    // no `finally`. Whatever is true after this line was true in the DATABASE before it.
    api!.kill('SIGKILL');
    const died = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      api!.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(died, 'the API process must actually be dead').toBe(true);
    // And prove it: the port must no longer answer.
    await expect(fetch(`${BASE}/healthz`)).rejects.toThrow();

    // --- half 1: the message is DURABLE ---------------------------------------------
    const stored = await pool!.query(
      `SELECT message_id, body, visibility FROM conversation.messages WHERE message_id = $1`,
      [messageId],
    );
    expect(stored.rowCount, 'the committed message must survive the kill').toBe(1);
    expect(stored.rows[0].body).toBe('This message must outlive the process that accepted it.');

    // ...and its event is still WAITING, not lost and not yet delivered.
    /* Read through the connection holding the lock: another relay cannot have moved
       these rows, so what this sees is what SIGKILL left behind. */
    const pending = await reserved.query(
      `SELECT outbox_id, state FROM conversation.outbox
        WHERE aggregate_id = $1 AND state = 'PENDING'`,
      [conversationId],
    );

    if (pending.rowCount === 0) {
      /**
       * Say WHICH of the two possible failures this is, rather than leaving the next
       * person to conclude that rule 1 is broken.
       *
       * A row that is PUBLISHED was delivered by somebody else — the dev realtime
       * gateway's relay, almost certainly — and the invariant held. A row that is
       * missing entirely is the real defect this test exists to catch.
       */
      const any = await reserved.query(
        `SELECT state, count(*)::int AS n FROM conversation.outbox
          WHERE aggregate_id = $1 GROUP BY state`,
        [conversationId],
      );
      const states = any.rows.map((r) => `${r.state}=${r.n}`).join(', ') || 'no rows at all';
      expect.fail(
        `the event was not PENDING after the kill (${states}). If it is PUBLISHED, ` +
          `another OutboxRelay drained it — the realtime gateway runs one against this ` +
          `same database — and this is an isolation problem in the test environment, ` +
          `not a durability failure. If there are no rows, the event really was lost ` +
          `and rule 1 is broken.`,
      );
    }
    expect(pending.rowCount, 'the event must be pending, not silently dropped').toBeGreaterThan(0);

    /* Released before half 2: the relay below must be able to claim these very rows,
       and a lock this test is still holding would make it skip them — which would turn
       the isolation fix into a different false failure. */
    await reserved.query('ROLLBACK');
    reserved.release();

    // --- half 2: a DIFFERENT process heals delivery ----------------------------------
    const publisher = new MockEventPublisher();
    const relay = new OutboxRelay({
      pool: pool!,
      publisher,
      backplane: new InProcessBackplane(),
      logger,
      batchSize: 20,
    });

    /**
     * Drain until THIS conversation's event appears, not once.
     *
     * `drainOnce` takes a batch (20 here), and the outbox is shared with every other suite
     * and every manual session that has ever used this database. A single drain therefore
     * publishes the twenty OLDEST pending rows, which on a database with a backlog are
     * somebody else's — so the assertion below failed with "expected 0 to be greater
     * than 0" while the relay was working perfectly. Measured: 166 pending rows against a
     * batch of 20.
     *
     * That was a test-isolation defect wearing a durability failure's clothes, and it is
     * worth fixing rather than papering over, because this is a Phase 2 exit criterion —
     * a gate that fails for an unrelated reason teaches people to re-run it until it
     * passes, which is precisely how a real durability regression would get through.
     *
     * The loop is bounded so a genuinely undelivered event still fails, and it asserts
     * progress on every pass so a relay that publishes nothing cannot spin here.
     */
    const findHealed = (): readonly unknown[] =>
      publisher
        .publishedEvents()
        .filter(
          (event) => (event.payload as { conversationId?: string }).conversationId === conversationId,
        );

    let totalPublished = 0;
    for (let pass = 0; pass < 40 && findHealed().length === 0; pass += 1) {
      const drained = await relay.drainOnce();
      totalPublished += drained.published;
      // An empty batch means the queue is exhausted; draining again cannot help.
      if (drained.published === 0) break;
    }

    expect(totalPublished, 'the relay must publish the orphaned event').toBeGreaterThan(0);

    const healed = findHealed();
    expect(healed.length, 'the event for this conversation must have been delivered').toBeGreaterThan(0);

    // The event carries identifiers, never the body (FR-RT-4) — worth asserting here
    // because this is the one path where a body could plausibly have been stashed to
    // survive the crash.
    expect(JSON.stringify(healed)).not.toContain('must outlive the process');

    const settled = await pool!.query(
      `SELECT state FROM conversation.outbox WHERE aggregate_id = $1`,
      [conversationId],
    );
    expect(settled.rows.every((row) => row.state === 'PUBLISHED')).toBe(true);
  }, 120_000);
});
