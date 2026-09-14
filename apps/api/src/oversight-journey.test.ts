/**
 * Communication Oversight, driven over real HTTP.
 *
 * The administrator can read a conversation they are not in, through the ordinary employee
 * message route, and reading it changes NOTHING inside that conversation.
 *
 * ## Why this is a journey test and not a unit test
 *
 * The interesting part is not any one decision — `admin-audit.test.ts` sweeps those against
 * `decide()` directly. It is the seam: the oversight screen reuses the product's own
 * message endpoint, so the guarantees a separate audit surface got for free (no writes in
 * the controller at all) have to be re-established on a route that is full of them.
 *
 * Three things are asserted here and nowhere else:
 *
 *   1. `GET .../messages` answers the administrator, and says `viewerIsParticipant: false`
 *      so the client knows to offer nothing that writes;
 *   2. `POST .../read` is REFUSED for that reader — an inspection must not write read
 *      state, because the watermark a list row ticks from is the lowest position across the
 *      conversation and an inspector sitting at message 1 would un-tick everybody;
 *   3. the participants' own view is byte-for-byte what it was before the inspection.
 *
 * The third is the requirement as the product owner wrote it — "admin inspection must not
 * change employee unread counts, read receipts, delivery status or conversation state" —
 * and it is checked by reading the participants' own endpoints on both sides of the
 * administrator's visit rather than by reasoning about what the code does.
 *
 * ## The ordinary employee is in here too
 *
 * A capability test that only exercises the holder proves half of it. `pete` is a colleague
 * of nobody in the thread, and every assertion about the administrator has its mirror: he is
 * refused the messages, refused the audit surface, and told he holds no audit permission.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed } from '@starlink/database';
import { hashPassword } from '@starlink/security';
import { auditRoutes, employeeRoutes } from '@starlink/shared-contracts';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3213;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `0v51` block belongs to this file alone. */
const OLIVIA = '018f2c5a-0f51-7000-8000-00000000000a';
const NADIA = '018f2c5a-0f51-7000-8000-00000000000b';
const PETE = '018f2c5a-0f51-7000-8000-00000000000c';
const ADA = '018f2c5a-0f51-7000-8000-00000000000d';
const TEAM_ID = 'oversight-journey-team';

const CREDENTIALS = {
  /** Two colleagues with a private one-to-one — the thing an audit is most likely about. */
  olivia: { username: 'oversight.olivia', password: 'oversight-olivia-pw-01' },
  nadia: { username: 'oversight.nadia', password: 'oversight-nadia-pw-001' },
  /** An ordinary employee who is in none of it. Every negative case is his. */
  pete: { username: 'oversight.pete', password: 'oversight-pete-pw-0001' },
  /** The organisation's administrator. One account, the existing role. */
  ada: { username: 'oversight.ada', password: 'oversight-ada-pw-00001' },
};

const ROLE: Readonly<Record<string, string>> = {
  [OLIVIA]: 'AGENT',
  [NADIA]: 'AGENT',
  [PETE]: 'AGENT',
  [ADA]: 'ADMIN',
};

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const created: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({
    connectionString: CONNECTION,
    connectionTimeoutMillis: 15_000,
    max: 5,
  });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ oversight journey SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Oversight Journey Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$5,'Olivia Oak','Service',$9,'ACTIVE'),
            ($2,'EMPLOYEE',$6,'Nadia Nair','Service',$10,'ACTIVE'),
            ($3,'EMPLOYEE',$7,'Pete Prasad','Service',$11,'ACTIVE'),
            ($4,'EMPLOYEE',$8,'Ada Admin','Service',$12,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE',
           username = EXCLUDED.username,
           credential_hash = EXCLUDED.credential_hash`,
    [
      OLIVIA,
      NADIA,
      PETE,
      ADA,
      CREDENTIALS.olivia.username,
      CREDENTIALS.nadia.username,
      CREDENTIALS.pete.username,
      CREDENTIALS.ada.username,
      await hashPassword(CREDENTIALS.olivia.password),
      await hashPassword(CREDENTIALS.nadia.password),
      await hashPassword(CREDENTIALS.pete.password),
      await hashPassword(CREDENTIALS.ada.password),
    ],
  );
  for (const principal of [OLIVIA, NADIA, PETE, ADA]) {
    await probe.query(
      `INSERT INTO identity.team_memberships (team_id, principal_id, role)
       VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`,
      [TEAM_ID, principal],
    );
    await probe.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
       VALUES ($1,$2,$3,'GLOBAL',$2, now() - interval '1 day')
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), principal, ROLE[principal]],
    );
  }

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: 'oversight-journey-session-secret-0123456789',
      SL_CURSOR_SECRET: 'oversight-journey-cursor-secret-01234567890',
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
  if (!ready) console.warn('\n  ⚠ oversight journey SKIPPED: the API did not start.\n');
}, 90_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  const people = [OLIVIA, NADIA, PETE, ADA];
  try {
    await pool.query(`DELETE FROM conversation.outbox WHERE aggregate_id = ANY($1::uuid[])`, [
      created,
    ]);
    await pool.query(
      `DELETE FROM conversation.conversation_preferences
        WHERE principal_id = ANY($1::uuid[])
           OR conversation_id IN (SELECT conversation_id FROM conversation.conversations
                                   WHERE created_by = ANY($1::uuid[]))`,
      [people],
    );
    for (const table of ['outbox', 'messages', 'participants', 'read_state']) {
      const key = table === 'outbox' ? 'aggregate_id' : 'conversation_id';
      await pool.query(
        `DELETE FROM conversation.${table}
          WHERE ${key} IN (SELECT conversation_id FROM conversation.conversations
                            WHERE created_by = ANY($1::uuid[]))`,
        [people],
      );
    }
    await pool.query(`DELETE FROM conversation.conversations WHERE created_by = ANY($1::uuid[])`, [
      people,
    ]);
    /*
       The ledger is NOT cleaned up, and the first version of this file tried to.

       `audit.ledger` refuses DELETE from every connection — a trigger, not a grant (rule 8,
       FR-AUD-1) — so the teardown failed on its own last step and reported a passing run as
       broken. The rows are meant to outlive what they describe: `actor_id` deliberately
       carries no foreign key to `identity.principals`, so deleting these accounts below
       leaves the record of what they did intact, which is the whole point of a ledger.
    */
    await pool.query(`DELETE FROM identity.team_memberships WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [
      people,
    ]);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      people,
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
  expect(response.status, `${who} could not sign in`).toBe(200);
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

interface MessagePage {
  readonly messages: readonly { readonly messageId: string; readonly seq: number }[];
  readonly readWatermark?: number;
  readonly viewerIsParticipant?: boolean;
  readonly state?: string;
  readonly conversationType?: string;
}

/**
 * A private one-to-one between two colleagues, with something said in it.
 *
 * Every test calls this and every test gets the SAME conversation: a 1:1 between two people
 * is idempotent by design (`existing: true`), which is a property of the product rather than
 * an accident here. So nothing below may assert an exact message count or an empty ledger —
 * each call adds two more messages to the thread the previous one used.
 */
async function aPrivateThread(): Promise<{
  readonly conversationId: string;
  readonly olivia: string;
  readonly nadia: string;
  readonly lastSeq: number;
}> {
  const olivia = await signIn('olivia');
  const nadia = await signIn('nadia');
  const started = await post(employeeRoutes.conversations.create, olivia, {
    type: 'INTERNAL_DIRECT',
    participantIds: [NADIA],
  });
  expect(started.status).toBe(201);
  const { conversationId } = (await started.json()) as { conversationId: string };
  created.push(conversationId);

  for (const body of ['The renewal file is ready.', 'Thanks, I will look this afternoon.']) {
    const sent = await post(employeeRoutes.conversations.messages(conversationId), olivia, {
      body,
      visibility: 'INTERNAL',
    });
    expect(sent.status).toBe(201);
  }

  const page = (await (
    await get(employeeRoutes.conversations.messages(conversationId), olivia)
  ).json()) as MessagePage;
  const lastSeq = page.messages.at(-1)?.seq ?? 0;
  expect(lastSeq).toBeGreaterThan(0);

  /* Nadia reads it to the end, so there is a read receipt for an inspection to disturb.
     `toBeLessThan(400)` rather than a number: Nest answers a POST 201 unless a handler says
     otherwise, and pinning the exact success code here would make this helper fail for a
     reason that has nothing to do with what it is setting up. */
  expect(
    (await post(employeeRoutes.conversations.read(conversationId), nadia, { upToSeq: lastSeq }))
      .status,
  ).toBeLessThan(400);

  return { conversationId, olivia, nadia, lastSeq };
}

describe('the administrator reads a conversation they are not in', () => {
  it('is answered by the ordinary message route, and told they are not a participant', async (ctx) => {
    if (skipUnlessReady(ctx, 'the administrator can open a colleague thread')) return;
    const { conversationId } = await aPrivateThread();
    const ada = await signIn('ada');

    const response = await get(employeeRoutes.conversations.messages(conversationId), ada);
    expect(response.status, 'the administrator was refused a thread they may audit').toBe(200);

    const page = (await response.json()) as MessagePage;

    /* The same transcript the participant sees, compared rather than counted: "the
       administrator can read it" is only interesting if what they read is the conversation. */
    const olivias = (await (
      await get(employeeRoutes.conversations.messages(conversationId), await signIn('olivia'))
    ).json()) as MessagePage;
    expect(page.messages.length, 'the administrator got an empty transcript').toBeGreaterThan(0);
    expect(
      page.messages.map((m) => m.messageId),
      'the administrator saw a different transcript from the participant',
    ).toEqual(olivias.messages.map((m) => m.messageId));
    /**
     * The flag the whole read-only surface hangs from. It is the SERVER's answer, taken
     * from the decision that authorised this very read — a client deriving it from "is
     * this conversation in my list" would be right by accident here and wrong for every
     * channel somebody reads without joining.
     */
    expect(page.viewerIsParticipant, 'the administrator was reported as a participant').toBe(false);
    expect(page.conversationType).toBe('INTERNAL_DIRECT');
  }, 120_000);

  it('still tells a participant that they ARE one', async (ctx) => {
    if (skipUnlessReady(ctx, 'a participant keeps their composer')) return;
    const { conversationId, olivia, nadia } = await aPrivateThread();

    for (const [who, cookie] of [
      ['olivia', olivia],
      ['nadia', nadia],
    ] as const) {
      const page = (await (
        await get(employeeRoutes.conversations.messages(conversationId), cookie)
      ).json()) as MessagePage;
      expect(page.viewerIsParticipant, `${who} lost their own conversation`).toBe(true);
    }
  }, 120_000);

  it('refuses an ordinary employee the same thread', async (ctx) => {
    if (skipUnlessReady(ctx, 'an ordinary employee is refused')) return;
    const { conversationId } = await aPrivateThread();
    const pete = await signIn('pete');

    /* §27.3's uniform refusal: absent and forbidden are one answer. */
    expect(
      (await get(employeeRoutes.conversations.messages(conversationId), pete)).status,
      'an ordinary employee read a colleague one-to-one',
    ).toBe(404);
  }, 120_000);
});

describe('inspecting leaves no trace inside the conversation', () => {
  it('refuses to write read state for an audit read', async (ctx) => {
    if (skipUnlessReady(ctx, 'the administrator cannot mark a thread read')) return;
    const { conversationId, lastSeq } = await aPrivateThread();
    const ada = await signIn('ada');

    /**
     * The route allows `conversation.read`, and the audit rung grants the administrator
     * exactly that action — which is what made this route the hole. It refuses on the
     * BASIS of the decision rather than on the verdict: marking a thread read is an
     * assertion of having participated, and an inspection is not one.
     */
    expect(
      (await post(employeeRoutes.conversations.read(conversationId), ada, { upToSeq: lastSeq }))
        .status,
      'an audit read wrote read state into somebody else conversation',
    ).toBe(404);

    const rows = await pool!.query(
      `SELECT 1 FROM conversation.read_state WHERE conversation_id = $1 AND principal_id = $2`,
      [conversationId, ADA],
    );
    expect(rows.rowCount, 'a read_state row exists for a reader who is not in the thread').toBe(0);
  }, 120_000);

  it('changes no participant unread count, receipt, state or watermark', async (ctx) => {
    if (skipUnlessReady(ctx, 'an inspection perturbs nothing')) return;
    const { conversationId, olivia, nadia, lastSeq } = await aPrivateThread();

    const viewOf = async (cookie: string): Promise<unknown> => {
      const page = (await (
        await get(employeeRoutes.conversations.messages(conversationId), cookie)
      ).json()) as MessagePage;
      const list = (await (await get(employeeRoutes.conversations.list, cookie)).json()) as {
        conversations: readonly {
          conversationId: string;
          unreadCount: number;
          lastMessageSeq?: number;
        }[];
      };
      const row = list.conversations.find((c) => c.conversationId === conversationId);
      return {
        readWatermark: page.readWatermark,
        state: page.state,
        messages: page.messages.length,
        unreadCount: row?.unreadCount,
        lastMessageSeq: row?.lastMessageSeq,
      };
    };

    const before = { olivia: await viewOf(olivia), nadia: await viewOf(nadia) };

    /* The whole visit: the list, the thread, the roster, the transcript and an attempt to
       mark it read. Everything the oversight screen does when somebody opens a row. */
    const ada = await signIn('ada');
    expect((await get(auditRoutes.conversations({ limit: 50 }), ada)).status).toBe(200);
    expect((await get(employeeRoutes.conversations.messages(conversationId), ada)).status).toBe(200);
    expect((await get(auditRoutes.participants(conversationId), ada)).status).toBe(200);
    expect((await get(auditRoutes.messages(conversationId, { limit: 200 }), ada)).status).toBe(200);
    await post(employeeRoutes.conversations.read(conversationId), ada, { upToSeq: lastSeq });

    const after = { olivia: await viewOf(olivia), nadia: await viewOf(nadia) };

    /* Deep equality on the whole picture rather than field by field: a new field that an
       inspection perturbs should fail this test on the day it is added. */
    expect(after, 'an administrator inspection changed what the participants see').toEqual(before);
  }, 120_000);

  it('cannot send, react or add anybody', async (ctx) => {
    if (skipUnlessReady(ctx, 'the administrator cannot write into the thread')) return;
    const { conversationId, olivia } = await aPrivateThread();
    const page = (await (
      await get(employeeRoutes.conversations.messages(conversationId), olivia)
    ).json()) as MessagePage;
    const messageId = page.messages.at(-1)!.messageId;
    const ada = await signIn('ada');

    /* The screen offers none of these — but the requirement is explicit that the
       restriction must not be the screen. These are the three writes a reader of a thread
       would otherwise reach for. */
    expect(
      (
        await post(employeeRoutes.conversations.messages(conversationId), ada, {
          body: 'A note from the administrator.',
          visibility: 'INTERNAL',
        })
      ).status,
      'the administrator posted into a conversation they are auditing',
    ).toBe(404);

    expect(
      (await post(employeeRoutes.conversations.reactions(conversationId, messageId), ada, {
        emoji: '👍',
      })).status,
      'the administrator reacted to a message in a conversation they are auditing',
    ).toBe(404);

    expect(
      (await post(employeeRoutes.conversations.participants(conversationId), ada, {
        principalId: PETE,
        historyExposureAcknowledged: true,
      })).status,
      'the administrator added somebody to a conversation they are auditing',
    ).toBe(404);
  }, 120_000);
});

describe('the oversight surface is the administrator alone', () => {
  it('tells the administrator they hold it and an employee they do not', async (ctx) => {
    if (skipUnlessReady(ctx, 'the permission answer is role-shaped')) return;
    const ada = await signIn('ada');
    const pete = await signIn('pete');

    const adaAnswer = (await (await get(auditRoutes.permission, ada)).json()) as {
      mayAudit: boolean;
    };
    expect(adaAnswer.mayAudit).toBe(true);

    /* Answered rather than refused: the question "may I" is one every session may ask, and
       a 404 here would leave the sidebar unable to tell "no" from "the API is down" — which
       is the difference between omitting a row and reporting a broken product. */
    const peteAnswer = (await (await get(auditRoutes.permission, pete)).json()) as {
      mayAudit: boolean;
    };
    expect(peteAnswer.mayAudit).toBe(false);
  }, 120_000);

  it('refuses every oversight read to an ordinary employee', async (ctx) => {
    if (skipUnlessReady(ctx, 'the oversight routes are closed to employees')) return;
    const { conversationId } = await aPrivateThread();
    const pete = await signIn('pete');

    /* `search` is the one that matters most: an earlier version gated on the HANDLER's
       action, and every AGENT holds `search.execute` — so an ordinary employee got the
       company-wide message index. The gate is the CAPABILITY now. */
    for (const route of [
      auditRoutes.employees,
      auditRoutes.teams,
      auditRoutes.conversations({ limit: 10 }),
      auditRoutes.participants(conversationId),
      auditRoutes.messages(conversationId, { limit: 10 }),
      auditRoutes.search('renewal'),
      auditRoutes.log({ limit: 10 }),
    ]) {
      expect((await get(route, pete)).status, `an ordinary employee reached ${route}`).toBe(404);
    }
  }, 120_000);

  it('records the administrator read in the ledger before the content is returned', async (ctx) => {
    if (skipUnlessReady(ctx, 'the read is written to the ledger')) return;
    const { conversationId } = await aPrivateThread();
    const ada = await signIn('ada');

    expect((await get(auditRoutes.messages(conversationId, { limit: 200 }), ada)).status).toBe(200);

    /* One refused write, made HERE rather than relied upon from the test above: a check that
       only passes because another test ran first is a check that starts failing the day
       somebody runs one test on its own. */
    expect(
      (
        await post(employeeRoutes.conversations.messages(conversationId), ada, {
          body: 'Refused, and recorded.',
          visibility: 'INTERNAL',
        })
      ).status,
    ).toBe(404);

    /* By ACTION, not "every row for this conversation": the administrator's refused writes
       are recorded against the same target, and they are supposed to be — a ledger that only
       held the successes would be the wrong half of the record. */
    const rows = await pool!.query(
      `SELECT outcome FROM audit.ledger
        WHERE actor_id = $1 AND target_id = $2 AND action = 'privileged.conversation.read'`,
      [ADA, conversationId],
    );
    expect(rows.rowCount, 'an audit read left no ledger entry').toBeGreaterThan(0);
    expect(
      rows.rows.every((r: { outcome: string }) => r.outcome === 'SUCCEEDED'),
      'an allowed audit read was not recorded as SUCCEEDED',
    ).toBe(true);

    /* And the refusals are there too. The requirement is that every ADMIN audit access is
       recorded; a refused one is an access attempt and the more interesting row. */
    const refusals = await pool!.query(
      `SELECT 1 FROM audit.ledger
        WHERE actor_id = $1 AND target_id = $2 AND outcome = 'REFUSED'`,
      [ADA, conversationId],
    );
    expect(refusals.rowCount, 'the refused writes left no trace').toBeGreaterThan(0);
  }, 120_000);
});
