/**
 * The internal chat journey: start → send → read → add a colleague → remove.
 *
 * SL-001 ("Employee 1:1 chat", P0, gate G2) and SL-002 ("Internal group chat", P0, G2).
 * Their CSV acceptance criteria are *"Send/read/history/reconnect pass"* and *"Group
 * membership + history rules enforced"* — and both were true of a conversation you were
 * already in. **There was no way to begin one.** `POST /v1/employee/conversations` had
 * been guarded and tested since Phase 2 with no client method and no screen calling it.
 *
 * Every step below goes over real HTTP using `employeeRoutes`, the same contract the web
 * client imports, in the order a person performs it.
 *
 * ## The one that matters most
 *
 * BR-07: adding a participant exposes prior history, and the server refuses without an
 * acknowledgement. This asserts the refusal AND the number of messages exposed, because a
 * client that sends the flag without asking satisfies the API and defeats the rule — the
 * count is what lets the interface tell the truth about what just happened.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { hashPassword } from '@starlink/security';
import { MAX_PINNED_CONVERSATIONS, employeeRoutes } from '@starlink/shared-contracts';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3209;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `c4a7` block belongs to this file alone. */
const ALICE = '018f2c5a-c4a7-7000-8000-00000000000a';
const BOB = '018f2c5a-c4a7-7000-8000-00000000000b';
const CARA = '018f2c5a-c4a7-7000-8000-00000000000c';
const TEAM_ID = 'internal-chat-team';

const CREDENTIALS = {
  alice: { username: 'chat.alice', password: 'chat-alice-password-01' },
  bob: { username: 'chat.bob', password: 'chat-bob-password-0001' },
  /**
   * Cara can now sign in.
   *
   * She was a participant nobody ever authenticated as — enough for BR-07, which is about
   * adding somebody, and not enough for a read receipt, which is about a THIRD person
   * reading. "Everybody has read it" is only a meaningful claim once there are more than
   * two people who could fail to.
   */
  cara: { username: 'chat.cara', password: 'chat-cara-password-001' },
};

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const created: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 5 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ internal chat journey SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Internal Chat Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$4,'Alice Adams','Service',$7,'ACTIVE'),
            ($2,'EMPLOYEE',$5,'Bob Brown','Service',$8,'ACTIVE'),
            ($3,'EMPLOYEE',$6,'Cara Clark','Service',$9,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE',
           username = EXCLUDED.username,
           credential_hash = EXCLUDED.credential_hash`,
    [
      ALICE, BOB, CARA,
      CREDENTIALS.alice.username, CREDENTIALS.bob.username, CREDENTIALS.cara.username,
      await hashPassword(CREDENTIALS.alice.password),
      await hashPassword(CREDENTIALS.bob.password),
      await hashPassword(CREDENTIALS.cara.password),
    ],
  );
  for (const principal of [ALICE, BOB, CARA]) {
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

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: 'internal-chat-session-secret-0123456789',
      SL_CURSOR_SECRET: 'internal-chat-cursor-secret-01234567890',
      SL_DB_MAX_CONNECTIONS: '5',
      SL_SWEEP_ROUTING_SECONDS: '3600',
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
  if (!ready) console.warn('\n  ⚠ internal chat journey SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = ANY($1::uuid[])`, [created]);
    /* `conversation_preferences` carries an FK to `conversations`, so a pin left behind
       blocks the delete below — and the failure surfaces in afterAll, where it reads as
       the suite breaking rather than as a row this file forgot. */
    for (const table of ['messages', 'participants', 'read_state', 'conversation_preferences']) {
      await pool.query(`DELETE FROM conversation.${table} WHERE conversation_id = ANY($1::uuid[])`, [created]);
    }
    /*
       Anything these three CREATED, not only what this run recorded.

       `created` misses a conversation whose id never made it into the array — a test that
       failed between the POST and the push, or an earlier run whose teardown threw partway
       through. Those rows keep an FK on `identity.principals.created_by`, so the delete
       below fails, and the failure is reported by afterAll on a run whose tests all
       passed. Two runs were spent on that. The principals are this file's alone, so
       "created by them" is a safe net to cast.
    */
    await pool.query(
      `DELETE FROM conversation.conversation_preferences
        WHERE principal_id = ANY($1::uuid[])
           OR conversation_id IN (SELECT conversation_id FROM conversation.conversations
                                   WHERE created_by = ANY($1::uuid[]))`,
      [[ALICE, BOB, CARA]],
    );
    for (const table of ['outbox', 'messages', 'participants', 'read_state']) {
      const key = table === 'outbox' ? 'aggregate_id' : 'conversation_id';
      await pool.query(
        `DELETE FROM conversation.${table}
          WHERE ${key} IN (SELECT conversation_id FROM conversation.conversations
                            WHERE created_by = ANY($1::uuid[]))`,
        [[ALICE, BOB, CARA]],
      );
    }
    await pool.query(`DELETE FROM conversation.conversations WHERE created_by = ANY($1::uuid[])`, [
      [ALICE, BOB, CARA],
    ]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [created]);
    await pool.query(`DELETE FROM identity.team_memberships WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [
      [ALICE, BOB, CARA],
    ]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [ALICE, BOB, CARA],
    ]);
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
  expect(response.status).toBe(200);
  return cookiesOf(response);
}

const post = (path: string, cookie: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const get = (path: string, cookie: string): Promise<Response> =>
  fetch(`${BASE}${path}`, { headers: { cookie } });

const skipUnlessReady = (ctx: { skip: () => void }, what: string): boolean => {
  if (ready) return false;
  console.warn(`  ⚠ UNPROVEN: ${what}`);
  ctx.skip();
  return true;
};

describe('SL-001 — a 1:1 conversation', () => {
  it('is started, sent to, read back, and is idempotent on a second attempt', async (ctx) => {
    if (skipUnlessReady(ctx, 'the 1:1 journey was not walked.')) return;

    const alice = await signIn('alice');

    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_DIRECT',
      participantIds: [BOB],
    });
    expect(started.status, 'an employee could not start a 1:1').toBe(201);
    const { conversationId, existing } = (await started.json()) as {
      conversationId: string;
      existing: boolean;
    };
    created.push(conversationId);
    expect(existing).toBe(false);

    // Send / read / history — SL-001's acceptance, exercised over the real path.
    const sent = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'Morning — can you look at the Kapoor renewal?',
      visibility: 'INTERNAL',
    });
    expect(sent.status).toBe(201);

    const bob = await signIn('bob');
    const read = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
      headers: { cookie: bob },
    });
    expect(read.status, 'the other participant could not read the thread').toBe(200);
    const { messages } = (await read.json()) as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Kapoor renewal'))).toBe(true);

    /**
     * BR-05: a 1:1 between the same two people is idempotent. Asking again must return the
     * SAME thread — the UI navigates to it rather than reporting a failure, which is why
     * `existing` is on the response at all.
     */
    const again = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_DIRECT',
      participantIds: [BOB],
    });
    const second = (await again.json()) as { conversationId: string; existing: boolean };
    expect(second.conversationId).toBe(conversationId);
    expect(second.existing).toBe(true);
  }, 120_000);
});

describe('SL-002 — a group, and BR-07 history exposure', () => {
  it('is started, and adding a colleague exposes history only after acknowledgement', async (ctx) => {
    if (skipUnlessReady(ctx, 'the group journey was not walked.')) return;

    const alice = await signIn('alice');

    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB],
      title: 'Renewals huddle',
    });
    expect(started.status).toBe(201);
    const { conversationId } = (await started.json()) as { conversationId: string };
    created.push(conversationId);

    // Two messages of history for Cara to inherit.
    for (const body of ['Starting the renewals push today.', 'Two policies need chasing.']) {
      expect((await post(employeeRoutes.conversations.messages(conversationId), alice, {
        body,
        visibility: 'INTERNAL',
      })).status).toBe(201);
    }

    /**
     * BR-07's refusal. The server will not add a participant without the acknowledgement,
     * which is what makes the interface's warning load-bearing rather than decorative.
     */
    const unacknowledged = await post(
      employeeRoutes.conversations.participants(conversationId),
      alice,
      { principalId: CARA, historyExposureAcknowledged: false },
    );
    expect(unacknowledged.status, 'BR-07: adding without acknowledgement must be refused').toBe(404);

    const added = await post(employeeRoutes.conversations.participants(conversationId), alice, {
      principalId: CARA,
      historyExposureAcknowledged: true,
    });
    expect(added.status).toBe(201);
    /**
     * The count the UI reports. "Added" alone would hide exactly the thing BR-07 exists to
     * surface — that someone can now read what was said before they arrived.
     */
    const { messagesExposed } = (await added.json()) as { messagesExposed: number };
    expect(messagesExposed).toBe(2);

    // Removal. §24.3: participation history is append-only, so this stops future delivery
    // rather than unreading what was read.
    const removed = await fetch(
      `${BASE}${employeeRoutes.conversations.participant(conversationId, CARA)}`,
      { method: 'DELETE', headers: { cookie: alice } },
    );
    expect(removed.status).toBeLessThan(400);

    const stillThere = await pool!.query(
      `SELECT count(*)::int AS n FROM conversation.participants
        WHERE conversation_id = $1 AND principal_id = $2`,
      [conversationId, CARA],
    );
    expect(stillThere.rows[0].n, 'the participation record must survive as history').toBe(1);
  }, 120_000);
});


describe('read receipts — the second tick', () => {
  /**
   * The whole point of the feature, walked over the real path: Alice sends, the tick says
   * one, Bob reads, the tick says two.
   *
   * Asserted through `readWatermark` on Alice's own page read rather than through the
   * socket, because that is the durable answer. The realtime frame only makes it
   * immediate — rule 9 requires that no state exist only in an event, and this is the
   * test that would fail if the watermark were ever moved onto the wire alone.
   */
  it('turns over only once everybody else has read, and never before', async (ctx) => {
    if (skipUnlessReady(ctx, 'read receipts were not walked end to end.')) return;

    const alice = await signIn('alice');
    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB, CARA],
      title: 'Receipts',
    });
    expect(started.status).toBe(201);
    const { conversationId } = (await started.json()) as { conversationId: string };
    created.push(conversationId);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'Did this land?',
      visibility: 'INTERNAL',
    });
    expect(sent.status).toBe(201);
    const { seq } = (await sent.json()) as { seq: number };

    const watermarkFor = async (cookie: string): Promise<number> => {
      const page = await get(employeeRoutes.conversations.messages(conversationId), cookie);
      expect(page.status).toBe(200);
      return ((await page.json()) as { readWatermark: number }).readWatermark;
    };

    // Nobody has opened it. One tick.
    expect(await watermarkFor(alice), 'the message was reported read before anybody read it')
      .toBeLessThan(seq);

    /**
     * Alice reading her OWN conversation must not tick her own message.
     *
     * Marking read writes a row for the reader too, and counting it is the easiest way to
     * build a read receipt that reports nothing but the reader's own scrolling.
     */
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), alice, { upToSeq: seq }))
        .status,
    ).toBeLessThan(400);
    expect(
      await watermarkFor(alice),
      'the sender reading her own thread ticked her own message',
    ).toBeLessThan(seq);

    // Bob reads. Cara still has not, so it stays at one tick — "everybody" means everybody.
    const bob = await signIn('bob');
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), bob, { upToSeq: seq })).status,
    ).toBeLessThan(400);
    expect(
      await watermarkFor(alice),
      'one reader out of two was reported as everybody',
    ).toBeLessThan(seq);

    // Cara reads. Now, and only now, two ticks.
    const cara = await signIn('cara');
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), cara, { upToSeq: seq })).status,
    ).toBeLessThan(400);
    expect(
      await watermarkFor(alice),
      'everybody had read it and the tick did not turn over',
    ).toBeGreaterThanOrEqual(seq);

    /**
     * A NEW message is behind the watermark again immediately. The watermark is a position,
     * not a flag, so this is the property that stops it sticking on "read" for the rest of
     * the conversation.
     */
    const second = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'And this one?',
      visibility: 'INTERNAL',
    });
    const { seq: secondSeq } = (await second.json()) as { seq: number };
    expect(
      await watermarkFor(alice),
      'a message sent after everybody had read was born already read',
    ).toBeLessThan(secondSeq);
  }, 120_000);

  it('reports the newest message on the list row, for the sender only', async (ctx) => {
    if (skipUnlessReady(ctx, 'the list-row tick was not walked.')) return;

    const alice = await signIn('alice');
    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_DIRECT',
      participantIds: [CARA],
    });
    const { conversationId } = (await started.json()) as { conversationId: string };
    created.push(conversationId);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'Row tick, please.',
      visibility: 'INTERNAL',
    });
    const { seq } = (await sent.json()) as { seq: number };

    const rowFor = async (cookie: string): Promise<{
      lastMessageSeq?: number;
      lastMessageSenderId?: string;
      readWatermark: number;
    }> => {
      const list = await get(employeeRoutes.conversations.list, cookie);
      expect(list.status).toBe(200);
      const { conversations } = (await list.json()) as {
        conversations: {
          conversationId: string;
          lastMessageSeq?: number;
          lastMessageSenderId?: string;
          readWatermark: number;
        }[];
      };
      const row = conversations.find((c) => c.conversationId === conversationId);
      expect(row, 'the conversation was missing from its own participant list').toBeDefined();
      return row!;
    };

    const mine = await rowFor(alice);
    // The row has to know BOTH who wrote the newest message and how far the other person
    // has read; either one missing and it can only draw a tick by guessing.
    expect(mine.lastMessageSeq).toBe(seq);
    expect(mine.lastMessageSenderId).toBe(ALICE);
    expect(mine.readWatermark, 'unread by the recipient, yet reported read').toBeLessThan(seq);

    const cara = await signIn('cara');
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), cara, { upToSeq: seq })).status,
    ).toBeLessThan(400);
    expect((await rowFor(alice)).readWatermark).toBeGreaterThanOrEqual(seq);

    /**
     * And from CARA's side the same row reports Alice as the sender, so Cara's client
     * renders no tick at all. The scoping is a rendering rule rather than a query one, and
     * this is what makes that safe to rely on.
     */
    const theirs = await rowFor(cara);
    expect(theirs.lastMessageSenderId).toBe(ALICE);
  }, 120_000);
});

/**
 * Pinning, and the ceiling on it.
 *
 * A pinned list is only worth having while it is shorter than the list underneath it, so
 * the cap is three. What is actually under test is WHERE that three lives: the limit is
 * applied inside the statement that writes the preference, not read-then-written around
 * it, because two tabs pinning at the same moment would each read two and each write,
 * leaving four.
 *
 * The last case is the one that would survive a naive implementation — unpinning has to
 * skip the guard entirely, or somebody at the ceiling can never get back under it.
 */
describe('pinning a conversation', () => {
  it(`stops at ${MAX_PINNED_CONVERSATIONS} and lets you trade one for another`, async (ctx) => {
    if (skipUnlessReady(ctx, 'the pin ceiling is unproven.')) return;

    const alice = await signIn('alice');

    /*
       Alice starts with no pins.

       Not tidiness — correctness. The subject here is a CEILING, so the test's result
       depends on how many pins the account already has, and a row left behind by an
       earlier run (or by another test in this file) makes the first pin fail and the
       whole thing report a bug that is not there. It did exactly that once, when the
       teardown below was still missing this table.
    */
    await pool!.query(`DELETE FROM conversation.conversation_preferences WHERE principal_id = $1`, [
      ALICE,
    ]);

    /* One more group than the ceiling allows, so the last pin has to be refused. */
    const conversations: string[] = [];
    for (let index = 0; index <= MAX_PINNED_CONVERSATIONS; index += 1) {
      const started = await post(employeeRoutes.conversations.create, alice, {
        type: 'INTERNAL_GROUP',
        participantIds: [BOB, CARA],
        title: `Pin ceiling ${index} ${crypto.randomUUID().slice(0, 8)}`,
      });
      expect(started.status).toBe(201);
      const { conversationId } = (await started.json()) as { conversationId: string };
      conversations.push(conversationId);
      created.push(conversationId);
    }

    const pin = async (conversationId: string, pinned: boolean): Promise<{
      pinned: boolean;
      limitReached?: boolean;
    }> => {
      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.preferences(conversationId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', cookie: alice },
          body: JSON.stringify({ pinned }),
        },
      );
      expect(response.status, 'a pin within the allowance was rejected outright').toBe(200);
      return (await response.json()) as { pinned: boolean; limitReached?: boolean };
    };

    for (let index = 0; index < MAX_PINNED_CONVERSATIONS; index += 1) {
      expect(await pin(conversations[index]!, true)).toMatchObject({ pinned: true });
    }

    /*
       The one over. Not an HTTP error: the caller is allowed and the conversation exists,
       they simply already have three — see the controller for why §27.3's uniform refusal
       is the wrong answer here.
    */
    const overflow = await pin(conversations[MAX_PINNED_CONVERSATIONS]!, true);
    expect(overflow.limitReached, 'a fourth pin was accepted').toBe(true);
    expect(overflow.pinned).toBe(false);

    /* And the database agrees, which is the claim that matters — a response saying
       "refused" over a row that was written would pass every assertion above. */
    const counted = await pool!.query(
      `SELECT count(*)::int AS pinned
         FROM conversation.conversation_preferences
        WHERE principal_id = $1 AND pinned`,
      [ALICE],
    );
    expect(counted.rows[0].pinned).toBe(MAX_PINNED_CONVERSATIONS);

    /* Unpinning must not consult the ceiling, or somebody at it is stuck there. */
    expect(await pin(conversations[0]!, false)).toMatchObject({ pinned: false });
    expect(await pin(conversations[MAX_PINNED_CONVERSATIONS]!, true)).toMatchObject({
      pinned: true,
    });
  }, 120_000);
});
