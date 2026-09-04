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

/**
 * Mute, and the two things about it that are easy to get wrong.
 *
 * It is a LEASE, not a switch: migration 0018 removed the boolean deliberately and 0021
 * brought it back with an end on it. So the interesting assertions are not "mute works" —
 * they are that the instant comes from the SERVER (a client sending its own would let a
 * skewed clock mute until yesterday), that an expired mute reads as no mute at all with
 * nothing having to sweep it, and that muting does not disturb the pin sitting in the same
 * row.
 */
describe('muting a conversation', () => {
  it('is a lease the server dates, and leaves the pin alone', async (ctx) => {
    if (skipUnlessReady(ctx, 'the mute lease is unproven.')) return;

    const alice = await signIn('alice');
    await pool!.query(`DELETE FROM conversation.conversation_preferences WHERE principal_id = $1`, [
      ALICE,
    ]);

    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB, CARA],
      title: `Mute ${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(started.status).toBe(201);
    const { conversationId } = (await started.json()) as { conversationId: string };
    created.push(conversationId);

    const preferences = async (body: unknown): Promise<Response> =>
      fetch(`${BASE}${employeeRoutes.conversations.preferences(conversationId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: alice },
        body: JSON.stringify(body),
      });

    const rowFor = async (): Promise<{ pinned: boolean; mutedUntil?: string }> => {
      const list = await get(employeeRoutes.conversations.list, alice);
      const { conversations } = (await list.json()) as {
        conversations: { conversationId: string; pinned: boolean; mutedUntil?: string }[];
      };
      const row = conversations.find((c) => c.conversationId === conversationId);
      expect(row, 'the conversation vanished from its own list').toBeDefined();
      return row!;
    };

    /* Pin first, so the mute below has something it could plausibly clobber. */
    expect((await preferences({ pinned: true })).status).toBe(200);
    expect((await rowFor()).pinned).toBe(true);

    const before = Date.now();
    expect((await preferences({ muteMinutes: 60 })).status).toBe(200);
    const after = Date.now();

    const muted = await rowFor();
    expect(muted.mutedUntil, 'the mute did not come back on the summary').toBeDefined();
    expect(muted.pinned, 'muting cleared the pin in the same row').toBe(true);

    /*
       Dated by the server, within the window this test was running.

       An hour from `before` is the earliest it could legitimately be and an hour from
       `after` the latest; anything outside says the instant came from somewhere other than
       the server's clock at the moment of the write.
    */
    const until = Date.parse(muted.mutedUntil!);
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1_000);
    expect(until).toBeLessThanOrEqual(after + 60 * 60_000 + 1_000);

    /*
       An expired mute is no mute, and nothing had to sweep it.

       The row is aged in place rather than waiting an hour. What is under test is that the
       READ compares against the clock — if it reported any non-null column as "muted", a
       mute set last week would still be silencing this conversation.
    */
    await pool!.query(
      `UPDATE conversation.conversation_preferences
          SET muted_until = now() - interval '1 minute'
        WHERE principal_id = $1 AND conversation_id = $2`,
      [ALICE, conversationId],
    );
    const expired = await rowFor();
    expect(expired.mutedUntil, 'an elapsed mute was still reported as muted').toBeUndefined();
    expect(expired.pinned, 'the pin did not survive the mute expiring').toBe(true);

    /* Unmute is explicit too, and does not need the mute to be live. */
    expect((await preferences({ muteMinutes: null })).status).toBe(200);
    expect((await rowFor()).mutedUntil).toBeUndefined();

    /*
       A duration the menu cannot offer is refused, not clamped.

       MUTE_DURATIONS_MINUTES is the whole reason no mute can outlive a day; if the server
       rounded 100000 down to 1440 instead of refusing it, that ceiling would rest on the
       six buttons the UI happens to draw.
    */
    expect((await preferences({ muteMinutes: 100_000 })).status).toBeGreaterThanOrEqual(400);
    expect((await preferences({})).status, 'an empty change was accepted').toBeGreaterThanOrEqual(
      400,
    );
  }, 120_000);
});

/**
 * Pinning a message, forwarding one, and asking who has read one.
 *
 * The interesting assertions are the authorization ones, not the happy paths:
 *
 *  - A pin is a WRITE to the shared thread even though it adds no text, so it is
 *    authorized with the send action. Somebody who may only read must not be able to
 *    reorder what the participants see.
 *  - Forwarding is two decisions about two objects. A caller who cannot write to the
 *    destination must be refused even when they can read the source perfectly well.
 *  - "Message info" must not report the sender as having read their own message, which is
 *    the shape that makes a one-to-one claim 1-of-2 while nobody has opened it.
 */
describe('pinning, forwarding and message info', () => {
  it('pins for everybody, forwards with both sides authorized, and reports readers', async (ctx) => {
    if (skipUnlessReady(ctx, 'pins, forwards and message info are unproven.')) return;

    const alice = await signIn('alice');
    const bob = await signIn('bob');

    const group = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB, CARA],
      title: `Pins ${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(group.status).toBe(201);
    const { conversationId } = (await group.json()) as { conversationId: string };
    created.push(conversationId);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'The office address is 4th floor, Tower B.',
      visibility: 'INTERNAL',
    });
    expect(sent.status).toBe(201);
    const { messageId } = (await sent.json()) as { messageId: string };

    /* --- pinning ------------------------------------------------------------------ */

    const pinned = await fetch(
      `${BASE}${employeeRoutes.conversations.pin(conversationId, messageId)}`,
      { method: 'PUT', headers: { cookie: alice } },
    );
    expect(pinned.status, 'a participant could not pin in their own conversation').toBe(200);

    const listed = await get(employeeRoutes.conversations.pins(conversationId), bob);
    expect(listed.status).toBe(200);
    const { pins } = (await listed.json()) as {
      pins: { messageId: string; pinnedByName: string; body: string; redacted: boolean }[];
    };
    /* Shared, which is the whole difference from a pinned CONVERSATION: Bob sees a pin
       Alice set, and sees who set it. */
    expect(pins).toHaveLength(1);
    expect(pins[0]!.messageId).toBe(messageId);
    expect(pins[0]!.pinnedByName).toBe('Alice Adams');
    expect(pins[0]!.body).toContain('4th floor');

    /* Pinning twice is not an error, and the first pin keeps its attribution. */
    const again = await fetch(
      `${BASE}${employeeRoutes.conversations.pin(conversationId, messageId)}`,
      { method: 'PUT', headers: { cookie: bob } },
    );
    expect(again.status).toBe(200);
    expect((await again.json()) as { changed: boolean }).toMatchObject({ changed: false });

    /*
       A message from ANOTHER conversation cannot be pinned here, even by somebody who
       belongs to both. Without this check the object test passes against a conversation
       the caller is in while the write lands in one they may not touch.
    */
    const other = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB],
      title: `Elsewhere ${crypto.randomUUID().slice(0, 8)}`,
    });
    const { conversationId: otherId } = (await other.json()) as { conversationId: string };
    created.push(otherId);
    const crossed = await fetch(
      `${BASE}${employeeRoutes.conversations.pin(otherId, messageId)}`,
      { method: 'PUT', headers: { cookie: alice } },
    );
    expect(crossed.status, 'a message was pinned into a conversation it is not in').toBe(404);

    /* --- message info -------------------------------------------------------------- */

    const info = await get(
      employeeRoutes.conversations.messageInfo(conversationId, messageId),
      alice,
    );
    expect(info.status).toBe(200);
    const readers = (await info.json()) as {
      deliveredAt: string;
      readers: { principalId: string; displayName: string; hasRead: boolean }[];
    };
    expect(readers.deliveredAt).toBeTruthy();
    /* Bob and Cara, and NOT Alice: "you have read your own message" is not information,
       and counting it would make this report 1 of 3 before anybody opened anything. */
    expect(readers.readers.map((r) => r.principalId).sort()).toEqual([BOB, CARA].sort());
    expect(readers.readers.every((r) => !r.hasRead)).toBe(true);

    /* Bob reads, and only Bob turns over. */
    const page = await get(employeeRoutes.conversations.messages(conversationId), bob);
    const { messages } = (await page.json()) as { messages: { seq: number }[] };
    const newest = Math.max(...messages.map((m) => m.seq));
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), bob, { upToSeq: newest }))
        .status,
    ).toBeLessThan(400);

    const after = (await (
      await get(employeeRoutes.conversations.messageInfo(conversationId, messageId), alice)
    ).json()) as { readers: { principalId: string; hasRead: boolean; readAt?: string }[] };
    expect(after.readers.find((r) => r.principalId === BOB)?.hasRead).toBe(true);
    expect(after.readers.find((r) => r.principalId === BOB)?.readAt).toBeTruthy();
    expect(after.readers.find((r) => r.principalId === CARA)?.hasRead).toBe(false);
    /* No time beside "not read": a marker instant there would contradict the word. */
    expect(after.readers.find((r) => r.principalId === CARA)?.readAt).toBeUndefined();

    /* --- forwarding ---------------------------------------------------------------- */

    const forwarded = await post(
      employeeRoutes.conversations.forward(conversationId, messageId),
      alice,
      { toConversationId: otherId },
    );
    expect(forwarded.status, 'a forward between two of her own conversations failed').toBe(201);

    const destination = await get(employeeRoutes.conversations.messages(otherId), alice);
    const { messages: copied } = (await destination.json()) as {
      messages: { body: string; senderPrincipalId?: string }[];
    };
    const copy = copied.find((m) => m.body.includes('4th floor'));
    expect(copy, 'the forwarded text did not arrive').toBeDefined();
    /* Authored by whoever forwarded it. Attributing it to the original sender would put
       words in their mouth in a thread they are not in. */
    expect(copy!.senderPrincipalId).toBe(ALICE);

    /* Forwarding into a conversation the caller is NOT in is refused, even though they
       can plainly read the source. */
    const cara = await signIn('cara');
    const caraOnly = await post(employeeRoutes.conversations.create, cara, {
      type: 'INTERNAL_DIRECT',
      participantIds: [BOB],
    });
    const { conversationId: caraId } = (await caraOnly.json()) as { conversationId: string };
    created.push(caraId);

    const intruder = await post(
      employeeRoutes.conversations.forward(conversationId, messageId),
      alice,
      { toConversationId: caraId },
    );
    expect(
      intruder.status,
      'a message was forwarded into a conversation the sender is not in',
    ).toBeGreaterThanOrEqual(400);

    /* Forwarding to the thread it is already in is a no-op dressed as a feature. */
    const samePlace = await post(
      employeeRoutes.conversations.forward(conversationId, messageId),
      alice,
      { toConversationId: conversationId },
    );
    expect(samePlace.status).toBeGreaterThanOrEqual(400);

    /* --- unpinning ------------------------------------------------------------------ */

    const unpinned = await fetch(
      `${BASE}${employeeRoutes.conversations.pin(conversationId, messageId)}`,
      { method: 'DELETE', headers: { cookie: bob } },
    );
    expect(unpinned.status, 'somebody other than the pinner could not unpin').toBe(200);
    const empty = (await (
      await get(employeeRoutes.conversations.pins(conversationId), alice)
    ).json()) as { pins: unknown[] };
    expect(empty.pins).toHaveLength(0);
  }, 180_000);
});

/**
 * Only a group's creator may remove somebody from it.
 *
 * Until 2026-09-04 any participant could end any other participant's access, so the newest
 * member of a twelve-person group could remove the other eleven — and BR-05, which needs a
 * live participant to re-add them, was the only thing between that and permanent.
 *
 * The rule lives in the DOMAIN rather than the controller, so what is under test is that
 * it holds for the operation and not merely for one route. The two cases that matter are
 * the refusal (a member who is not the creator) and the non-regression (the creator can
 * still remove, and a one-to-one is untouched by any of this).
 */
describe('removing somebody from a group', () => {
  it('is the admin\'s alone, and the admin is whoever created it', async (ctx) => {
    if (skipUnlessReady(ctx, 'the group admin rule is unproven.')) return;

    const alice = await signIn('alice');
    const bob = await signIn('bob');

    /* Alice creates it, so Alice is the admin. */
    const group = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB, CARA],
      title: `Admin ${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(group.status).toBe(201);
    const { conversationId } = (await group.json()) as { conversationId: string };
    created.push(conversationId);

    /* The summary carries the role, so the panel can mark the admin without a second
       read. If this stops arriving the badge silently disappears and nothing else fails. */
    const list = await get(employeeRoutes.conversations.list, bob);
    const { conversations } = (await list.json()) as {
      conversations: {
        conversationId: string;
        participants?: { principalId: string; role?: string }[];
      }[];
    };
    const seenByBob = conversations.find((c) => c.conversationId === conversationId);
    expect(
      seenByBob?.participants?.find((p) => p.principalId === ALICE)?.role,
      'the creator role did not reach the conversation summary',
    ).toBe('CREATOR');

    /* Bob is a member, not the admin. He may not remove Cara. */
    const refused = await fetch(
      `${BASE}${employeeRoutes.conversations.participant(conversationId, CARA)}`,
      { method: 'DELETE', headers: { cookie: bob } },
    );
    expect(
      refused.status,
      'a plain member removed somebody from a group',
    ).toBeGreaterThanOrEqual(400);

    /* And Cara is still there — the refusal was not merely a status code over a write that
       happened anyway. */
    const stillThere = await get(employeeRoutes.conversations.list, bob);
    const { conversations: after } = (await stillThere.json()) as {
      conversations: { conversationId: string; participantCount: number }[];
    };
    expect(
      after.find((c) => c.conversationId === conversationId)?.participantCount,
      'the participant count moved despite the refusal',
    ).toBe(3);

    /* Alice created it, so Alice can. */
    const allowed = await fetch(
      `${BASE}${employeeRoutes.conversations.participant(conversationId, CARA)}`,
      { method: 'DELETE', headers: { cookie: alice } },
    );
    expect(allowed.status, 'the group creator could not remove a member').toBe(204);

    /*
       A one-to-one is untouched.

       The rule is scoped to INTERNAL_GROUP on purpose — a direct message has no membership
       to administer — and a check written too broadly would break adding a third person
       and then changing your mind, which is the ordinary way a group gets made.
    */
    const direct = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_DIRECT',
      participantIds: [BOB],
    });
    const { conversationId: directId } = (await direct.json()) as { conversationId: string };
    created.push(directId);

    const added = await post(employeeRoutes.conversations.participants(directId), alice, {
      principalId: CARA,
      historyExposureAcknowledged: true,
    });
    expect(added.status).toBeLessThan(400);

    /*
       Adding a third person makes it a group — the type is updated when the count crosses
       — so removing Cara again is now the ADMIN's call, and Alice created this one too.
    */
    const undone = await fetch(
      `${BASE}${employeeRoutes.conversations.participant(directId, CARA)}`,
      { method: 'DELETE', headers: { cookie: alice } },
    );
    expect(undone.status, 'the creator could not undo their own addition').toBe(204);
  }, 180_000);
});

/**
 * "Delete for me" hides a message from ONE person.
 *
 * The claim worth testing is not that it disappears — it is that it disappears for exactly
 * one reader. A per-principal hide that leaked into everybody's page would be a redaction
 * with a misleading label, and somebody would use it believing the opposite.
 *
 * The second claim is that the record does not move. Rule 8 makes the audit ledger
 * append-only and BR-09 makes what a person COULD have read answerable afterwards; a hide
 * writes a row about a reader and must leave conversation.messages exactly as it was.
 */
describe('deleting a message for yourself', () => {
  it('hides it from one reader and from nobody else, and leaves the record alone', async (ctx) => {
    if (skipUnlessReady(ctx, 'delete-for-me is unproven.')) return;

    const alice = await signIn('alice');
    const bob = await signIn('bob');

    const started = await post(employeeRoutes.conversations.create, alice, {
      type: 'INTERNAL_GROUP',
      participantIds: [BOB, CARA],
      title: `Hide ${crypto.randomUUID().slice(0, 8)}`,
    });
    const { conversationId } = (await started.json()) as { conversationId: string };
    created.push(conversationId);

    const sent = await post(employeeRoutes.conversations.messages(conversationId), alice, {
      body: 'Something Bob would rather not keep seeing.',
      visibility: 'INTERNAL',
    });
    expect(sent.status).toBe(201);
    const { messageId } = (await sent.json()) as { messageId: string };

    const bodiesFor = async (cookie: string): Promise<string[]> => {
      const page = await get(employeeRoutes.conversations.messages(conversationId), cookie);
      expect(page.status).toBe(200);
      const { messages } = (await page.json()) as { messages: { body: string }[] };
      return messages.map((m) => m.body);
    };

    expect(await bodiesFor(bob)).toContain('Something Bob would rather not keep seeing.');

    /* Bob hides somebody ELSE's message, which is the common case — the thing you want out
       of your timeline is usually not one you wrote. */
    const hidden = await post(
      employeeRoutes.conversations.hideMessage(conversationId, messageId),
      bob,
      {},
    );
    expect(hidden.status, 'a reader could not hide a message from their own view').toBeLessThan(
      400,
    );

    expect(
      await bodiesFor(bob),
      'the message was still in the page of the person who hid it',
    ).not.toContain('Something Bob would rather not keep seeing.');

    /* Alice wrote it and Cara is just another reader. Neither is affected. */
    expect(
      await bodiesFor(alice),
      'one person hiding a message removed it from the author view',
    ).toContain('Something Bob would rather not keep seeing.');

    const cara = await signIn('cara');
    expect(
      await bodiesFor(cara),
      'one person hiding a message removed it from a third party view',
    ).toContain('Something Bob would rather not keep seeing.');

    /*
       And the message itself is untouched — not redacted, not emptied. This is the
       assertion that separates a hide from a delete, and it is checked against the table
       rather than the API so a projection change cannot make it pass wrongly.
    */
    const stored = await pool!.query(
      `SELECT body, redacted_at FROM conversation.messages WHERE message_id = $1`,
      [messageId],
    );
    expect(stored.rows[0].body).toBe('Something Bob would rather not keep seeing.');
    expect(stored.rows[0].redacted_at, 'hiding redacted the message').toBeNull();

    /* Hiding twice is not an error. A double-click must not produce a 500. */
    const again = await post(
      employeeRoutes.conversations.hideMessage(conversationId, messageId),
      bob,
      {},
    );
    expect(again.status).toBeLessThan(400);
  }, 180_000);
});
