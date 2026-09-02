/**
 * GOLDEN G-20 and G-21 — scoped grants and sensitivity segmentation, at the HTTP boundary.
 *
 * `STARLINK_TEST_STRATEGY.md` §2 names both:
 *
 *   * **G-20** — "Unauthorized TL cannot read team customer history; scoped-grant model
 *     holds; attempt audited."
 *   * **G-21** — "Claim-sensitive data hidden from ordinary sales role; sensitivity
 *     segmentation."
 *
 * Both rules are already implemented in `decide()` and unit-tested there. This file exists
 * for the reason G-19 needed two halves: **a decision function can be perfect and the route
 * still leak by loading the wrong row.** Every assertion here goes through the real API,
 * with real sessions, against a real database.
 *
 * ## The two models under test
 *
 * `TEAM_LEAD` deliberately does **not** carry `conversation.read` — "a lead does not read
 * team conversations by default, and oversight is a scoped, audited grant" (BR-30, D-11).
 * A lead holding a team-scoped grant is therefore still refused, and that is G-20: the
 * refusal must come from the *action* being absent, not from the scope failing to match.
 *
 * `AGENT` does carry `conversation.read`, so an ordinary advisor with a team-scoped grant
 * can read an ordinary conversation in their team. Give the same conversation a MEDICAL
 * sensitivity and the same read must fail, because `SENSITIVITY_ROLES.MEDICAL` requires
 * CLAIMS, COMPLIANCE or LEGAL. That is G-21, and the CLAIMS advisor beside them proves the
 * refusal is about sensitivity rather than about the conversation being unreachable.
 *
 * ## Why refusals are checked for indistinguishability
 *
 * §27.3: "not permitted" and "does not exist" are one answer. A sensitivity refusal that
 * looked different from a missing conversation would tell an ordinary advisor that a
 * medical conversation exists in their team — which is most of what the segmentation was
 * protecting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertDatabaseAllowed, resetTeamFixtures } from '@starlink/database';
import { employeeRoutes } from '@starlink/shared-contracts/http/employee';
import { hashPassword } from '@starlink/security';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'scoped-reads-session-secret-0123456789';
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `5c09` block belongs to this file alone (see the fixture-ids guard). */
const OWNER = '018f2c5a-5c09-7000-8000-00000000000a';
const LEAD = '018f2c5a-5c09-7000-8000-00000000000b';
const ADVISOR = '018f2c5a-5c09-7000-8000-00000000000c';
const CLAIMS_ADVISOR = '018f2c5a-5c09-7000-8000-00000000000d';
const CUSTOMER = '018f2c5a-5c09-7000-8000-00000000000e';
const TEAM_ID = 'scoped-reads-team';
const CATEGORY_ID = 'scoped-reads-category';

const PEOPLE = {
  owner: { id: OWNER, username: 'scoped.owner', password: 'scoped-owner-password-1', role: 'AGENT' },
  lead: { id: LEAD, username: 'scoped.lead', password: 'scoped-lead-password-01', role: 'TEAM_LEAD' },
  advisor: { id: ADVISOR, username: 'scoped.advisor', password: 'scoped-advisor-pw-01', role: 'AGENT' },
  claims: { id: CLAIMS_ADVISOR, username: 'scoped.claims', password: 'scoped-claims-pw-01', role: 'CLAIMS' },
} as const;

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const cookies: Record<string, string> = {};
let ordinaryConversation = '';
let medicalConversation = '';

async function signIn(who: keyof typeof PEOPLE): Promise<string> {
  const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: PEOPLE[who].username, password: PEOPLE[who].password }),
  });
  expect(response.ok, `${who} should be able to sign in (got ${response.status})`).toBe(true);
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

/** A customer conversation owned by `OWNER`, at a given sensitivity. */
async function seedConversation(sensitivity: string): Promise<string> {
  const conversationId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO conversation.service_cases
       (case_id, category_id, priority, owning_team_id, current_owner_id, state, sensitivity, created_at)
     VALUES ($1,$2,'NORMAL',$3,$4,'ACTIVE',$5, now())`,
    [caseId, CATEGORY_ID, TEAM_ID, OWNER, sensitivity],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, sensitivity, customer_ref, created_at, last_seq)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE',$3,$4, now(), 1)`,
    [conversationId, caseId, sensitivity, CUSTOMER],
  );
  // Composite primary key (conversation_id, principal_id) - there is no participant_id.
  await pool!.query(
    `INSERT INTO conversation.participants
       (conversation_id, principal_id, principal_kind, role, reply_authority, effective_from)
     VALUES ($1,$2,'EMPLOYEE','OWNER',true, now() - interval '1 hour'),
            ($1,$3,'CUSTOMER','CUSTOMER',true, now() - interval '1 hour')`,
    [conversationId, OWNER, CUSTOMER],
  );
  await pool!.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
        sender_display_name, body, created_at)
     VALUES ($1,$2,1,'CUSTOMER_VISIBLE',$3,'CUSTOMER','Customer','A message worth protecting.', now())`,
    [crypto.randomUUID(), conversationId, CUSTOMER],
  );
  return conversationId;
}

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ G-20/G-21 SKIPPED: no PostgreSQL.\n');
    return;
  }

  await resetTeamFixtures(probe, TEAM_ID);

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Scoped Reads','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Scoped Topic',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );

  for (const person of Object.values(PEOPLE)) {
    await probe.query(
      `INSERT INTO identity.principals
         (principal_id, kind, username, display_name, department, credential_hash, status)
       VALUES ($1,'EMPLOYEE',$2,$3,'Service',$4,'ACTIVE')
       ON CONFLICT (principal_id) DO UPDATE
         SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
      [person.id, person.username, person.username, await hashPassword(person.password)],
    );
    await probe.query(
      `INSERT INTO identity.team_memberships (team_id, principal_id, role)
       VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`,
      [TEAM_ID, person.id],
    );
    /**
     * TEAM-scoped, not GLOBAL. The scope has to COVER the conversation for the refusals
     * below to mean anything: a grant that missed the team would refuse for the wrong
     * reason and the test would prove nothing about either model.
     */
    await probe.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, scope_id, granted_by, effective_from)
       VALUES ($1,$2,$3,'TEAM',$4,$2, now() - interval '1 day')
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), person.id, person.role, TEAM_ID],
    );
  }

  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, status)
     VALUES ($1,'CUSTOMER','Customer','ACTIVE') ON CONFLICT (principal_id) DO NOTHING`,
    [CUSTOMER],
  );

  ordinaryConversation = await seedConversation('ORDINARY');
  medicalConversation = await seedConversation('MEDICAL');

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'scoped-reads-cursor-secret-0123456789',
      SL_DB_MAX_CONNECTIONS: '5',
      SL_ADAPTER_WORK_ORCHESTRATOR: 'local',
      SL_SWEEP_ROUTING_SECONDS: '3600',
      SL_SWEEP_SLA_SECONDS: '3600',
      SL_SWEEP_REOPEN_SECONDS: '3600',
      SL_SWEEP_INACTIVE_OWNER_SECONDS: '3600',
      SL_SWEEP_RESERVATION_SECONDS: '3600',
      SL_SWEEP_NOTIFICATION_SECONDS: '3600',
      SL_SWEEP_INDEX_HEALTH_SECONDS: '3600',
      SL_SWEEP_ATTACHMENT_SCAN_SECONDS: '3600',
      SL_SWEEP_ATTACHMENT_EXPIRY_SECONDS: '3600',
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
  if (!ready) {
    console.warn('\n  ⚠ G-20/G-21 SKIPPED: the API did not start.\n');
    return;
  }

  for (const who of Object.keys(PEOPLE) as (keyof typeof PEOPLE)[]) {
    cookies[who] = await signIn(who);
  }
}, 120_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [CUSTOMER]);
  } finally {
    await pool.end();
  }
});

const read = (conversationId: string, who: string): Promise<Response> =>
  fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
    headers: { cookie: cookies[who] ?? '' },
  });

/** Skips loudly rather than passing quietly when the environment is missing. */
const gate = (name: string, fn: () => Promise<void>): void =>
  it(name, async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    await fn();
  });

describe('G-20 — an unauthorised team lead cannot read team customer history', () => {
  gate('the owner can read their own conversation (the control)', async () => {
    const response = await read(ordinaryConversation, 'owner');
    expect(response.status, 'the owner must be able to read what they own').toBe(200);
  });

  gate('a TEAM_LEAD with a team-scoped grant is still refused', async () => {
    /**
     * The scope covers the conversation and the lead is a member of the team. The refusal
     * therefore comes from `TEAM_LEAD` not carrying `conversation.read` at all — oversight
     * is a separate, explicitly granted, audited capability (BR-30). If a future role edit
     * quietly adds team-wide read to TEAM_LEAD, this is the test that fails.
     */
    const response = await read(ordinaryConversation, 'lead');
    expect(response.status, 'a lead does not read team conversations by default').toBe(404);
  });

  gate('the refusal is indistinguishable from a conversation that does not exist (§27.3)', async () => {
    const refused = await read(ordinaryConversation, 'lead');
    const missing = await read(crypto.randomUUID(), 'lead');
    expect(refused.status).toBe(missing.status);
    expect(await refused.text()).toBe(await missing.text());
  });

  gate('the attempt is audited', async () => {
    // "Attempt audited" is half of G-20's criterion: an oversight model that refuses
    // silently leaves nobody able to answer who tried.
    const audited = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit.ledger
        WHERE actor_id = $1 AND target_id = $2::text AND outcome = 'REFUSED'`,
      [LEAD, ordinaryConversation],
    );
    expect(Number(audited.rows[0]?.count ?? '0'), 'the refused read should be in the ledger').toBeGreaterThan(0);
  });
});

describe('G-21 — claim-sensitive data is hidden from an ordinary advisor', () => {
  gate('an ordinary advisor CAN read an ordinary conversation in their team', async () => {
    // The control that gives the next assertion its meaning: the advisor's grant covers
    // this conversation, so a refusal below is about sensitivity and nothing else.
    const response = await read(ordinaryConversation, 'advisor');
    expect(response.status, 'AGENT carries conversation.read and the scope covers it').toBe(200);
  });

  gate('the same advisor is refused the MEDICAL conversation', async () => {
    const response = await read(medicalConversation, 'advisor');
    expect(response.status, 'sensitivity segmentation must hold at the route').toBe(404);
  });

  gate('a CLAIMS advisor, with the same scope, CAN read it', async () => {
    /**
     * The other half of the segmentation. Without this the previous assertion would also
     * pass if the conversation were simply unreachable to everyone — which would be a
     * broken route rather than a working policy.
     */
    const response = await read(medicalConversation, 'claims');
    expect(response.status, 'CLAIMS is a MEDICAL sensitivity role').toBe(200);
  });

  gate('the owner is unaffected by sensitivity', async () => {
    // §"Participants and the current owner are unaffected — they are already inside the
    // conversation." An owner locked out of their own medical case would be a new defect.
    const response = await read(medicalConversation, 'owner');
    expect(response.status).toBe(200);
  });

  gate('the sensitivity refusal is indistinguishable from absence (§27.3)', async () => {
    const refused = await read(medicalConversation, 'advisor');
    const missing = await read(crypto.randomUUID(), 'advisor');
    expect(refused.status).toBe(missing.status);
    expect(await refused.text()).toBe(await missing.text());
  });
});
