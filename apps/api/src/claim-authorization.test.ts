/**
 * Claiming from the queue — authorization, and what the claimer can see afterwards.
 *
 * Two council findings meet on this path, and they compound, which is why one file covers
 * both: the check that decides WHO may claim was evaluated against a fabricated resource,
 * and the claim that succeeded left the conversation invisible to the person who made it.
 *
 * ## Finding 1 — the object check
 *
 * `claim` was gated on `mayDo`, which runs `decide()` against a resource built out of
 * nothing: the caller's own principal id as `conversationId`, `CUSTOMER_SERVICE` as the
 * type, `ORDINARY` as the sensitivity, and no owning team at all. Two failures at once —
 * a TEAM-scoped grant could never match (so fixtures granted GLOBAL to compensate), and a
 * GLOBAL grant then matched everything. `claimConversation` filters only on
 * `state = 'WAITING'`, so an advisor could claim a MEDICAL conversation queued to Claims;
 * once `current_owner_id` was theirs, `decide()` takes the OWNER branch, which skips
 * sensitivity by design because an owner is already inside. **Claiming was the way in.**
 *
 * G-21 tested sensitivity on the READ route, against an already-owned conversation that
 * had never been queued — so the claim path was never exercised at all.
 *
 * ## Finding 2 — the participant row
 *
 * The claim wrote the queue entry, the ownership episode, `current_owner_id` and the case
 * state, and no participant row. The inbox INNER JOINs `conversation.participants`. So a
 * successful claim produced a conversation that was genuinely the agent's and appeared in
 * no list they could see — and it had left the queue view too, because that filters
 * `state = 'WAITING'`. The work was reachable only by deep link or search.
 *
 * ## Why the two are tested together
 *
 * A fix to either one alone still leaves a broken product: authorization that admits the
 * wrong person, or a queue that swallows work. Asserting the pair in sequence — refuse the
 * wrong claimant, admit the right one, then find it in their inbox — is the journey an
 * agent actually performs.
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

const PORT = 3213;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = 'claim-authz-session-secret-0123456789';
const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = resolvePath(here, '..', 'dist', 'main.js');

/** The `6a11` block belongs to this file alone (see the fixture-ids guard). */
const ADVISOR = '018f2c5a-6a11-7000-8000-00000000000a';
const CLAIMS_ADVISOR = '018f2c5a-6a11-7000-8000-00000000000b';
const OUTSIDER = '018f2c5a-6a11-7000-8000-00000000000c';
/** Signed in, no roles — see PEOPLE.roleless. */
const ROLELESS = '018f2c5a-6a11-7000-8000-00000000000e';
const CUSTOMER = '018f2c5a-6a11-7000-8000-00000000000d';

const TEAM = 'claim-authz-team';
/** A second team, so "the scope did not cover it" is a distinct case from "no grant". */
const OTHER_TEAM = 'claim-authz-other-team';
const CATEGORY = 'claim-authz-category';

const PEOPLE = {
  advisor: {
    id: ADVISOR,
    username: 'claim.advisor',
    password: 'claim-advisor-password-1',
    role: 'AGENT',
    team: TEAM,
  },
  claims: {
    id: CLAIMS_ADVISOR,
    username: 'claim.claims',
    password: 'claim-claims-password-01',
    role: 'CLAIMS',
    team: TEAM,
  },
  outsider: {
    id: OUTSIDER,
    username: 'claim.outsider',
    password: 'claim-outsider-password',
    role: 'AGENT',
    team: OTHER_TEAM,
  },
  /**
   * A signed-in employee holding NO role at all.
   *
   * Every other fixture here carries AGENT or CLAIMS, and both of those hold
   * `directory.read` — so a suite built only from them cannot tell an authorised read from
   * an unauthorised one. A new joiner whose roles have not been assigned yet is an
   * ordinary state, not a contrived one, and it is the state that shows whether a route
   * checks anything.
   */
  roleless: {
    id: ROLELESS,
    username: 'claim.roleless',
    password: 'claim-roleless-password',
    role: undefined,
    team: TEAM,
  },
} as const;

let pool: pg.Pool | undefined;
let api: ChildProcess | undefined;
let ready = false;
const cookies: Record<string, string> = {};

async function signIn(who: keyof typeof PEOPLE): Promise<string> {
  const response = await fetch(`${BASE}${employeeRoutes.auth.signIn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: PEOPLE[who].username, password: PEOPLE[who].password }),
  });
  expect(response.ok, `${who} should be able to sign in (got ${response.status})`).toBe(true);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/**
 * A conversation WAITING in `teamId`'s queue at a given sensitivity, owned by nobody.
 *
 * State `QUEUED` with a matching open episode, because `advanceStateIn` moves only from
 * `NEW`/`QUEUED` — a fixture in the wrong state would make the claim fail for a reason
 * that has nothing to do with authorization.
 */
async function queuedConversation(teamId: string, sensitivity: string): Promise<string> {
  const conversationId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const at = new Date(Date.now() - 60_000).toISOString();

  await pool!.query(
    `INSERT INTO conversation.service_cases
       (case_id, category_id, priority, owning_team_id, state, sensitivity, created_at)
     VALUES ($1,$2,'NORMAL',$3,'QUEUED',$4,$5)`,
    [caseId, CATEGORY, teamId, sensitivity, at],
  );
  await pool!.query(
    `INSERT INTO conversation.conversations
       (conversation_id, conversation_type, case_id, state, sensitivity, customer_ref,
        created_at, last_activity_at, last_seq, participant_count)
     VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED',$3,$4,$5,$5,1,1)`,
    [conversationId, caseId, sensitivity, CUSTOMER, at],
  );
  await pool!.query(
    `INSERT INTO conversation.participants
       (conversation_id, principal_id, principal_kind, role, reply_authority, effective_from)
     VALUES ($1,$2,'CUSTOMER','CUSTOMER',true,$3)`,
    [conversationId, CUSTOMER, at],
  );
  await pool!.query(
    `INSERT INTO conversation.case_state_episodes
       (episode_id, conversation_id, state, effective_from)
     VALUES ($1,$2,'QUEUED',$3)`,
    [crypto.randomUUID(), conversationId, at],
  );
  await pool!.query(
    `INSERT INTO conversation.queue_entries
       (queue_entry_id, conversation_id, case_id, team_id, priority, state, enqueued_at)
     VALUES ($1,$2,$3,$4,'NORMAL','WAITING',$5)`,
    [crypto.randomUUID(), conversationId, caseId, teamId, at],
  );
  await pool!.query(
    `INSERT INTO conversation.messages
       (message_id, conversation_id, seq, visibility, sender_principal_id, sender_kind,
        sender_display_name, body, created_at)
     VALUES ($1,$2,1,'CUSTOMER_VISIBLE',$3,'CUSTOMER','Customer','Please help with this.',$4)`,
    [crypto.randomUUID(), conversationId, CUSTOMER, at],
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
    console.warn('\n  ⚠ claim authorization SKIPPED: no PostgreSQL.\n');
    return;
  }

  for (const team of [TEAM, OTHER_TEAM]) await resetTeamFixtures(probe, team);

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Claim Authz','Service'), ($2,'Claim Authz Other','Service')
     ON CONFLICT (team_id) DO NOTHING`,
    [TEAM, OTHER_TEAM],
  );
  await probe.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Claim Authz Topic',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY, TEAM],
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
      [person.team, person.id],
    );
    /**
     * TEAM-scoped, never GLOBAL. This is the point of the whole file: with the synthetic
     * resource a TEAM grant could not match anything, so the suite that existed granted
     * GLOBAL and could not have detected either defect.
     */
    // `roleless` deliberately gets none: that absence is what two of the cases below test.
    if (person.role !== undefined) {
      await probe.query(
        `INSERT INTO identity.role_assignments
           (assignment_id, principal_id, role, scope_kind, scope_id, granted_by, effective_from)
         VALUES ($1,$2,$3,'TEAM',$4,$2, now() - interval '1 day')
         ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), person.id, person.role, person.team],
      );
    }
  }

  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, status)
     VALUES ($1,'CUSTOMER','Customer','ACTIVE') ON CONFLICT (principal_id) DO NOTHING`,
    [CUSTOMER],
  );

  api = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      SL_ENV: 'test',
      SL_LOG_LEVEL: process.env.SL_CLAIM_DEBUG === '1' ? 'debug' : 'error',
      SL_API_PORT: String(PORT),
      SL_DATABASE_URL: CONNECTION,
      SL_SESSION_SECRET: SESSION_SECRET,
      SL_CURSOR_SECRET: 'claim-authz-cursor-secret-0123456789ab',
      SL_DB_MAX_CONNECTIONS: '5',
      // Every sweep quiet: this file is about one request, and a router that placed the
      // fixture conversations would change the state the assertions depend on.
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
    stdio: process.env.SL_CLAIM_DEBUG === '1' ? 'inherit' : 'ignore',
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
    console.warn('\n  ⚠ claim authorization SKIPPED: the API did not start.\n');
    return;
  }

  for (const who of Object.keys(PEOPLE) as (keyof typeof PEOPLE)[]) cookies[who] = await signIn(who);
}, 120_000);

afterAll(async () => {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  if (pool === undefined) return;
  try {
    for (const team of [TEAM, OTHER_TEAM]) await resetTeamFixtures(pool, team);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = $1`, [CUSTOMER]);
  } finally {
    await pool.end().catch(() => undefined);
  }
});

/**
 * `idempotencyKey` is REQUIRED by `claimSchema`, and omitting it produces the same 404 as
 * a refusal — which is correct for the product (§27.3) and treacherous for a test. The
 * first version of this file sent `{}`, so every claim was refused at the schema and the
 * negative cases passed without exercising authorization at all. Generated per call, since
 * a repeated key is a retry of the SAME claim and must return the same answer.
 */
const claim = (conversationId: string, who: keyof typeof PEOPLE): Promise<Response> =>
  fetch(`${BASE}${employeeRoutes.conversations.claim(conversationId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '' },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });

const inbox = async (who: keyof typeof PEOPLE): Promise<string[]> => {
  const response = await fetch(`${BASE}${employeeRoutes.conversations.list}`, {
    headers: { cookie: cookies[who] ?? '' },
  });
  expect(response.status, 'the inbox itself must be readable').toBe(200);
  const body = (await response.json()) as { conversations: { conversationId: string }[] };
  return body.conversations.map((c) => c.conversationId);
};

describe('claiming from the queue', () => {
  const gate = (name: string, body: () => Promise<void>, timeout = 60_000): void =>
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

  describe('the object check', () => {
    gate('an advisor scoped to the team may claim an ordinary conversation', async () => {
      /**
       * The positive control, and it is doing real work: with the synthetic resource this
       * FAILED for a team-scoped grant, because `scopeCovers` cannot match a TEAM scope
       * against a resource with no owning team. Every other case here would pass against a
       * check that simply refused everybody.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      const response = await claim(conversationId, 'advisor');

      expect(response.status).toBe(201);
      expect((await response.json()) as { outcome: string }).toMatchObject({ outcome: 'CLAIMED' });
    });

    gate('an ordinary advisor may NOT claim a medical conversation (G-21 at the claim)', async () => {
      /**
       * `SENSITIVITY_ROLES.MEDICAL` requires CLAIMS, COMPLIANCE or LEGAL. Against the real
       * conversation `passesSensitivity` runs; against the synthetic one it never could,
       * because the fabricated resource asserted `ORDINARY`.
       */
      const conversationId = await queuedConversation(TEAM, 'MEDICAL');

      expect(await (await claim(conversationId, 'advisor')).status).toBe(404);

      // And the refusal left the work where it was, for somebody who may take it.
      const entry = await pool!.query(
        `SELECT state, claimed_by FROM conversation.queue_entries WHERE conversation_id = $1`,
        [conversationId],
      );
      expect(entry.rows[0].state, 'a refused claim must not consume the queue entry').toBe('WAITING');
      expect(entry.rows[0].claimed_by).toBeNull();
    });

    gate('a claims advisor MAY claim the same medical conversation', async () => {
      // The control that makes the previous case about sensitivity rather than about the
      // conversation being unreachable.
      const conversationId = await queuedConversation(TEAM, 'MEDICAL');
      const response = await claim(conversationId, 'claims');

      expect(response.status).toBe(201);
      expect((await response.json()) as { outcome: string }).toMatchObject({ outcome: 'CLAIMED' });
    });

    gate('an advisor scoped to another team may NOT claim this team\'s work', async () => {
      // The scope half. `outsider` holds AGENT — the same role as `advisor` — scoped to a
      // team that does not own this conversation.
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');

      expect(await (await claim(conversationId, 'outsider')).status).toBe(404);

      const entry = await pool!.query(
        `SELECT state FROM conversation.queue_entries WHERE conversation_id = $1`,
        [conversationId],
      );
      expect(entry.rows[0].state).toBe('WAITING');
    });

    gate('a refused claim is indistinguishable from a conversation that does not exist', async () => {
      // §27.3. A distinguishable refusal would tell an ordinary advisor that a medical
      // conversation exists in their team, which is most of what the segmentation protects.
      const medical = await queuedConversation(TEAM, 'MEDICAL');
      const absent = crypto.randomUUID();

      const refused = await claim(medical, 'advisor');
      const missing = await claim(absent, 'advisor');

      expect(refused.status).toBe(missing.status);
      expect(await refused.text()).toBe(await missing.text());
    });
  });

  /**
   * The team queue endpoints (§25.3, UC-E10).
   *
   * Both were gated on a permission-only check that never looked at the `:teamId` in the
   * path, so any employee holding `queue.read` — which every AGENT holds — could read any
   * team's waiting work and its per-person workload. No customer content is in either
   * response; what leaked is the organisation's structure and staffing.
   *
   * The fixtures make this testable at all: `advisor` and `outsider` hold the SAME role
   * with the SAME permission, scoped to different teams. Any suite granting GLOBAL — as
   * the browser seed does, legitimately — cannot tell the two apart.
   */
  describe('reading a team queue', () => {
    const queue = (teamId: string, who: keyof typeof PEOPLE): Promise<Response> =>
      fetch(`${BASE}${employeeRoutes.queues.one(teamId)}`, { headers: { cookie: cookies[who] ?? '' } });

    const load = (teamId: string, who: keyof typeof PEOPLE): Promise<Response> =>
      fetch(`${BASE}${employeeRoutes.queues.load(teamId)}`, { headers: { cookie: cookies[who] ?? '' } });

    gate('a member reads their own team\'s queue', async () => {
      // The positive control. Without it every case below would pass over a check that
      // refused everybody, which is the other way to "close" this hole.
      const response = await queue(TEAM, 'advisor');
      expect(response.status).toBe(200);
      expect((await response.json()) as { teamId: string }).toMatchObject({ teamId: TEAM });
    });

    gate('and their own team\'s load', async () => {
      const response = await load(TEAM, 'advisor');
      expect(response.status).toBe(200);
      expect((await response.json()) as { teamId: string }).toMatchObject({ teamId: TEAM });
    });

    gate('but NOT another team\'s queue', async () => {
      expect(await (await queue(OTHER_TEAM, 'advisor')).status).toBe(404);
    });

    gate('and NOT another team\'s load — which names its people', async () => {
      /**
       * The more sensitive of the two: `members` carries every colleague's display name
       * and what they are carrying right now. SL-083 is explicit that this is not a
       * leaderboard, and a leaderboard is exactly what it becomes if anyone can read any
       * team's copy of it.
       */
      expect(await (await load(OTHER_TEAM, 'advisor')).status).toBe(404);
    });

    gate('the other team\'s own member can read it, so the refusal is about scope', async () => {
      // `outsider` holds the same AGENT role and the same `queue.read`, scoped elsewhere.
      expect(await (await queue(OTHER_TEAM, 'outsider')).status).toBe(200);
      expect(await (await queue(TEAM, 'outsider')).status).toBe(404);
    });

    gate('an unknown team is refused, not answered with an empty queue', async () => {
      /**
       * §27.3, applied to team names. An empty 200 for a team that does not exist and a
       * 404 for one the caller may not see would together enumerate the organisation's
       * team list for anyone with a session.
       */
      const missing = await queue('no-such-team-at-all', 'advisor');
      const forbidden = await queue(OTHER_TEAM, 'advisor');

      expect(missing.status).toBe(forbidden.status);
      expect(await missing.text()).toBe(await forbidden.text());
    });
  });

  /**
   * What a former owner may do after handing the conversation on (P-03, D-04a).
   *
   * Writing an OWNER participant row on claim closed the invisible-inbox defect and opened
   * this one: `reassign` wrote the INCOMING owner's row and left the outgoing one's alone,
   * `role='OWNER'` and `reply_authority=true` with no end date. `decide()` grants
   * `conversation.reply.customer` from exactly that field, so every transfer and escalation
   * left the previous agent able to write to that customer indefinitely.
   *
   * It was a straight widening — before the participant row existed, that rung never fired
   * on a claimed conversation at all — and no test asserted anything about a former owner,
   * which is why it shipped.
   */
  describe('after a transfer, the previous owner', () => {
    /** Claims as `advisor`, then transfers to `claims`. Returns the conversation id. */
    const claimThenTransfer = async (): Promise<string> => {
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.transfer(conversationId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookies.advisor ?? '' },
          body: JSON.stringify({ toOwner: CLAIMS_ADVISOR, reason: 'better suited to claims' }),
        },
      );
      expect(response.status, 'the owner should be able to transfer their own conversation').toBe(
        201,
      );
      return conversationId;
    };

    gate('may NOT reply to the customer', async () => {
      // The defect, stated as the customer experiences it: a message from an agent who
      // handed their case to somebody else, arriving with that agent's name on it.
      const conversationId = await claimThenTransfer();

      const reply = await fetch(
        `${BASE}${employeeRoutes.conversations.messages(conversationId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookies.advisor ?? '' },
          body: JSON.stringify({
            body: 'One more thing from me.',
            visibility: 'CUSTOMER_VISIBLE',
          }),
        },
      );

      expect(
        reply.status,
        'a former owner still has customer-reply authority — P-03 and D-04a are defeated ' +
          'after every hand-off',
      ).toBe(404);
    });

    gate('keeps read access and internal notes — participation is dated, not deleted', async () => {
      /**
       * The other half, and the reason this is a DEMOTION rather than an ending. BR-09
       * dates participation rather than deleting it, and P-03 says participation grants
       * reading and internal context — just not the customer. Ending the row would strip
       * the previous owner's own history of a conversation they genuinely worked.
       */
      const conversationId = await claimThenTransfer();

      const page = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
        headers: { cookie: cookies.advisor ?? '' },
      });
      expect(page.status, 'the former owner should still be able to read the thread').toBe(200);

      const note = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies.advisor ?? '' },
        body: JSON.stringify({ body: 'Context for whoever picks this up.', visibility: 'INTERNAL' }),
      });
      expect(note.status, 'a former owner should still be able to leave internal context').toBe(201);
    });

    gate('is recorded as demoted, with their start date intact (BR-09)', async () => {
      const conversationId = await claimThenTransfer();

      const rows = await pool!.query(
        `SELECT principal_id, role, reply_authority, effective_from, effective_to
           FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = ANY($2::uuid[])
          ORDER BY principal_id`,
        [conversationId, [ADVISOR, CLAIMS_ADVISOR]],
      );
      const byId = new Map(rows.rows.map((r) => [r.principal_id as string, r]));

      const former = byId.get(ADVISOR);
      expect(former, 'the former owner should still have a participation row').toBeDefined();
      expect(former?.role).toBe('PARTICIPANT');
      expect(former?.reply_authority).toBe(false);
      // Dated, not deleted: the row is still live so the history of who could read this
      // conversation, and from when, survives the hand-off.
      expect(former?.effective_to).toBeNull();

      const incoming = byId.get(CLAIMS_ADVISOR);
      expect(incoming?.role).toBe('OWNER');
      expect(incoming?.reply_authority).toBe(true);
    });

    gate('cannot even reach the removed-and-re-added escalation any more', async () => {
      /**
       * This case used to drive the escalation end to end: claim, the owner removes
       * THEMSELVES (leaving a dated-out row still holding OWNER and reply_authority), the
       * conversation is transferred (the demotion matches only LIVE rows, so it never
       * reaches the dead one), and the ex-owner is re-added — coming back with authority
       * over a customer somebody else now owns.
       *
       * The upsert fix closed the last step: a revived row takes the caller's role and
       * authority. Forbidding self-removal closes the FIRST step, so the sequence no longer
       * has a beginning — the only way to date out an owner's row was for the owner to do
       * it to themselves, and everyone else is refused by the object check.
       *
       * So this now asserts the precondition is unreachable, which is the stronger claim.
       * The upsert semantics themselves are still guarded, at the level where a caller can
       * still reach them: `infrastructure/database/.../participation-upsert.test.ts` drives
       * the dead-row and live-row branches directly against the store, and both fail under
       * mutation. Neither guard is removed; the outer one moved earlier in the chain.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      const removed = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, ADVISOR)}`,
        { method: 'DELETE', headers: { cookie: cookies.advisor ?? '' } },
      );
      expect(
        removed.status,
        'the owner removed themselves — this is the first step of the escalation, and it ' +
          'also strands the conversation in nobody’s inbox',
      ).toBe(404);

      const row = await pool!.query(
        `SELECT role, reply_authority, effective_to FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );
      expect(row.rows[0]?.effective_to, 'the participation was ended anyway').toBeNull();
      expect(row.rows[0]?.role).toBe('OWNER');
      expect(row.rows[0]?.reply_authority).toBe(true);
    });

    gate('and the new owner CAN reply — so the refusal is about ownership', async () => {
      // The control. Without it every case above would pass against a build that refused
      // the customer-reply action to everybody.
      const conversationId = await claimThenTransfer();

      const reply = await fetch(
        `${BASE}${employeeRoutes.conversations.messages(conversationId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookies.claims ?? '' },
          body: JSON.stringify({ body: 'I have your case now.', visibility: 'CUSTOMER_VISIBLE' }),
        },
      );
      expect(reply.status).toBe(201);
    });
  });

  /**
   * Who may widen access to a customer conversation (P-03, §31.1).
   *
   * `POST /participants` performed no authorization at all: it enforced only BR-05 — the
   * adder is a participant — while `decide()` places `conversation.participant.add` in
   * OWNER_ACTIONS and deliberately not in PARTICIPANT_ACTIONS. Adding somebody exposes
   * every prior message to them, so on a customer conversation that meant a colleague who
   * had themselves been walked in could walk in anyone else.
   */
  describe('adding a participant to a customer conversation', () => {
    const add = (conversationId: string, who: keyof typeof PEOPLE, principalId: string) =>
      fetch(`${BASE}${employeeRoutes.conversations.participants(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies[who] ?? '' },
        body: JSON.stringify({ principalId, historyExposureAcknowledged: true }),
      });

    gate('the OWNER may add a colleague', async () => {
      // The positive control. Without it every refusal below would pass against a build
      // that refused everybody.
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      const response = await add(conversationId, 'advisor', CLAIMS_ADVISOR);
      expect(response.status).toBe(201);
      expect((await response.json()) as { messagesExposed: number }).toHaveProperty(
        'messagesExposed',
      );
    });

    gate('a PARTICIPANT who is not the owner may NOT add anyone else', async () => {
      /**
       * The defect. `claims` is added by the owner above, so they are genuinely inside the
       * conversation and BR-05 is satisfied — which is exactly why BR-05 alone was not
       * enough. P-03: being in the room is not being in charge of it.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');
      expect((await add(conversationId, 'advisor', CLAIMS_ADVISOR)).status).toBe(201);

      const response = await add(conversationId, 'claims', OUTSIDER);
      expect(
        response.status,
        'a participant widened access to a customer conversation they do not own',
      ).toBe(404);

      // And nothing was written: the refusal and the absence of an effect are one event.
      const rows = await pool!.query(
        `SELECT 1 FROM conversation.participants WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, OUTSIDER],
      );
      expect(rows.rowCount).toBe(0);
    });

    gate('a stranger to the conversation may NOT add anyone', async () => {
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      expect((await add(conversationId, 'outsider', CLAIMS_ADVISOR)).status).toBe(404);
    });

    gate('the refusal is audited', async () => {
      /**
       * §31.1 puts participation changes in the audited set. A REFUSED attempt to widen
       * who can read a conversation is precisely what an investigator asks about, and it
       * was recorded nowhere because the check did not exist.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');
      await add(conversationId, 'outsider', CLAIMS_ADVISOR);

      const audited = await pool!.query(
        `SELECT outcome FROM audit.ledger
          WHERE action = 'conversation.participant.add' AND target_id = $1 AND actor_id = $2`,
        [conversationId, OUTSIDER],
      );
      expect(audited.rows.map((r) => r.outcome)).toContain('REFUSED');
    });

    gate('a non-owner may NOT remove the owner', async () => {
      /**
       * The mirror, and the reason it matters: removing the OWNER's participation puts the
       * conversation back in the state where its own owner cannot find it in their inbox —
       * the defect a previous round closed, reachable by a different route.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');
      await add(conversationId, 'advisor', CLAIMS_ADVISOR);

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, ADVISOR)}`,
        { method: 'DELETE', headers: { cookie: cookies.claims ?? '' } },
      );
      expect(response.status).toBe(404);

      const still = await pool!.query(
        `SELECT effective_to FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );
      expect(still.rows[0]?.effective_to, 'the owner was removed by a participant').toBeNull();
    });

    gate('re-adding somebody already here does not demote them', async () => {
      /**
       * A regression this round introduced, and the reason the revival upsert is guarded.
       *
       * `addParticipant`'s `ON CONFLICT (conversation_id, principal_id)` was given
       * `role = EXCLUDED.role, reply_authority = EXCLUDED.reply_authority` to close a
       * privilege escalation on DEAD rows — a removed ex-owner used to be revived still
       * carrying OWNER and reply authority. Correct as far as it went, and the conflict
       * clause matches the LIVE row just as readily.
       *
       * The domain command hardcodes `role: 'PARTICIPANT', replyAuthority: false`, so
       * `POST /participants` naming somebody already in the conversation rewrote them to
       * those values. Naming the current OWNER demoted them: `reply_authority` went false
       * while `ownership_episodes` and `service_cases.current_owner_id` still said they
       * owned the work. `decide()` reads reply authority off that row, so the owner
       * silently lost the ability to answer their own customer — no error, no audit, and
       * nothing that reads as a permission change.
       *
       * `effective_from` was overwritten on the same row, which is BR-09's question
       * ("could they read this on 5 March?") starting to answer no for a participation
       * that never lapsed.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const before = await pool!.query(
        `SELECT role, reply_authority, effective_from FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );
      expect(before.rows[0]?.role, 'the claim did not write an OWNER participant').toBe('OWNER');

      /**
       * Two layers, and this asserts both.
       *
       * The domain refuses first: `addParticipant` returns `ALREADY_PARTICIPANT` when the
       * target holds a live row, so the HTTP path never reaches the upsert. That is worth
       * pinning here — a reviewer read the escalation as live over this route, and it is
       * not; the guard below it is what makes it safe, and a guard nobody has located is
       * one somebody removes.
       *
       * The store's `CASE` is the second layer, tested directly in
       * `infrastructure/database` where a caller can reach a live row without passing
       * through the domain command at all.
       */
      const response = await add(conversationId, 'advisor', ADVISOR);
      expect(response.status, 'a duplicate add was accepted rather than refused').toBe(404);

      const after = await pool!.query(
        `SELECT role, reply_authority, effective_from FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );

      expect(after.rows[0].role, 'the sitting owner was demoted by a duplicate add').toBe('OWNER');
      expect(
        after.rows[0].reply_authority,
        'the owner lost reply authority over their own customer conversation, while the ' +
          'case still records them as the owner',
      ).toBe(true);
      expect(
        after.rows[0].effective_from.toISOString(),
        'the start of a participation that never lapsed was overwritten (BR-09)',
      ).toBe(before.rows[0].effective_from.toISOString());
    });

    gate('the customer cannot be removed from their own conversation', async () => {
      /**
       * Nothing checked WHO was being removed. An owner could end the CUSTOMER's
       * participation — and on the customer surface participation is what authorizes, so
       * every read and every reply then returns "no such conversation" to the person the
       * conversation is about.
       *
       * It is irreversible through the API: `POST /participants` resolves the target
       * through the employee identity source, which refuses a customer principal, and the
       * BR-22 fork copies only live rows. One request locks a customer out of their own
       * thread for good.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, CUSTOMER)}`,
        { method: 'DELETE', headers: { cookie: cookies.advisor ?? '' } },
      );
      expect(response.status, 'the owner removed the customer from their own conversation').toBe(404);

      const still = await pool!.query(
        `SELECT effective_to FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, CUSTOMER],
      );
      expect(
        still.rows[0]?.effective_to,
        'the customer was dated out and can no longer read their own thread',
      ).toBeNull();
    });

    gate('an owner cannot remove themselves and strand the conversation', async () => {
      /**
       * `current_owner_id` would still name them while `listForPrincipal` — which INNER
       * JOINs live participation — stopped showing it: work that is theirs, accountable to
       * them, and absent from their inbox. They could not re-add themselves either, since
       * BR-05 requires a live participant to grant participation.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');
      expect(await inbox('advisor'), 'the claim did not land').toContain(conversationId);

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, ADVISOR)}`,
        { method: 'DELETE', headers: { cookie: cookies.advisor ?? '' } },
      );
      expect(response.status).toBe(404);

      expect(
        await inbox('advisor'),
        'the owner removed themselves and the conversation vanished from their inbox',
      ).toContain(conversationId);
    });

    gate('but a colleague who was added CAN still be removed', async () => {
      /**
       * The positive control. Without it both refusals above are satisfied by a build where
       * removal never works at all — which would break the operation the endpoint exists
       * for while looking like a security improvement.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');
      expect((await add(conversationId, 'advisor', CLAIMS_ADVISOR)).status).toBe(201);

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, CLAIMS_ADVISOR)}`,
        { method: 'DELETE', headers: { cookie: cookies.advisor ?? '' } },
      );
      expect(response.status, 'an ordinary removal stopped working').toBe(204);

      const ended = await pool!.query(
        `SELECT effective_to FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, CLAIMS_ADVISOR],
      );
      expect(ended.rows[0]?.effective_to).not.toBeNull();
    });

    gate('a removal that changes nothing is reported as a refusal, not a success', async () => {
      // The handler returned 204 on every path — a malformed id, a domain refusal and a
      // real removal were indistinguishable, so the interface said "they will not receive
      // new messages here" whether or not anything had happened.
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const response = await fetch(
        `${BASE}${employeeRoutes.conversations.participant(conversationId, OUTSIDER)}`,
        { method: 'DELETE', headers: { cookie: cookies.advisor ?? '' } },
      );
      expect(response.status, 'removing somebody who was never here reported success').toBe(404);
    });
  });

  /**
   * The routing sweep grants participation, and the ledger has to say so (§31.1, P-06).
   *
   * `assignFromRouting` is the ordinary path — every customer conversation nobody claims by
   * hand is placed there — and it acquired the participation write without acquiring an
   * audit row, because it has no controller, no session and no request to hang one on. For
   * an IRDAI-audited insurer, "who was given access to this conversation, when, and on what
   * basis" is the question the ledger exists to answer.
   */
  describe('the participation grant is audited', () => {
    gate('a claim records who was granted access, in the same breath as the claim', async () => {
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      const rows = await pool!.query(
        `SELECT actor_id, actor_kind, outcome, detail, correlation_id
           FROM audit.ledger
          WHERE action = 'conversation.participant.add' AND target_id = $1`,
        [conversationId],
      );
      expect(rows.rowCount, 'the participation grant was not recorded').toBe(1);
      expect(rows.rows[0].actor_kind).toBe('EMPLOYEE');
      expect(rows.rows[0].actor_id).toBe(ADVISOR);
      expect(rows.rows[0].outcome).toBe('SUCCEEDED');
      expect((rows.rows[0].detail as { addedPrincipal: string }).addedPrincipal).toBe(ADVISOR);

      // Joinable to the rest of the request: the claim's own row carries the same id.
      const claimRow = await pool!.query(
        `SELECT correlation_id FROM audit.ledger
          WHERE action = 'conversation.claim' AND target_id = $1`,
        [conversationId],
      );
      expect(claimRow.rows[0]?.correlation_id).toBe(rows.rows[0].correlation_id);
    });

    gate('a transfer records the grant against the person who made it', async () => {
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      await fetch(`${BASE}${employeeRoutes.conversations.transfer(conversationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies.advisor ?? '' },
        body: JSON.stringify({ toOwner: CLAIMS_ADVISOR, reason: 'better suited to claims' }),
      });

      const rows = await pool!.query(
        `SELECT detail FROM audit.ledger
          WHERE action = 'conversation.participant.add' AND target_id = $1 AND actor_id = $2`,
        [conversationId, ADVISOR],
      );
      // Two grants on this conversation now: the claim and the transfer. The transfer's
      // names the incoming owner as the principal who gained access.
      expect(
        rows.rows.map((r) => (r.detail as { addedPrincipal: string }).addedPrincipal),
      ).toContain(CLAIMS_ADVISOR);
    });

    gate('a placement that rolls back leaves no ledger row behind', async () => {
      /**
       * Atomicity, injected — and injected at the only point where the property has any
       * content.
       *
       * This test used to claim successfully and then count one participant row and one
       * ledger row. That is worth nothing: it is the same state the preceding case already
       * asserts, and it holds just as well when the two writes are on SEPARATE connections,
       * which is the arrangement it exists to rule out.
       *
       * The first replacement broke the LEDGER write and asserted no participant row
       * survived. That was also worthless, and measurably so — moving the ledger write onto
       * `this.pool` left it green. Of course it did: a throw from the ledger INSERT aborts
       * the surrounding transaction wherever the INSERT was issued, so both arrangements
       * roll the participation back. The direction was wrong.
       *
       * The direction that separates them is the other one. Let the ledger write SUCCEED,
       * then fail the transaction after it. On one connection the ledger row dies with the
       * rest; on a second connection it has already committed on its own and survives as an
       * orphan — an audit row asserting a grant that never happened. §31.1 makes the ledger
       * the answer to "who let them in", and an answer describing a grant that does not
       * exist is worse than no answer.
       *
       * `case_state_episodes` is the injection point because `advanceStateIn` writes it
       * after `ensureOwnerParticipantIn` has already written the ledger row, inside the
       * same transaction, on the claim path.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');

      /**
       * The id is baked into the function body rather than read from a session setting,
       * because the API serves this request on whichever pooled connection it likes and a
       * `SET` on the test's own connection would not be there. A literal applies on every
       * connection, which is what fault injection through a pool requires.
       */
      await pool!.query(`
        CREATE OR REPLACE FUNCTION conversation.break_after_ledger() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.conversation_id = '${conversationId}' THEN
            RAISE EXCEPTION 'injected failure after the ledger write';
          END IF;
          RETURN NEW;
        END;
        $fn$;`);
      await pool!.query(`
        CREATE TRIGGER break_after_ledger BEFORE INSERT ON conversation.case_state_episodes
          FOR EACH ROW EXECUTE FUNCTION conversation.break_after_ledger();`);

      try {
        const refused = await claim(conversationId, 'advisor');
        expect(
          refused.status,
          'the claim reported success while its own transaction was failing',
        ).toBeGreaterThanOrEqual(400);

        const grants = await pool!.query(
          `SELECT count(*)::int AS n FROM audit.ledger
            WHERE action = 'conversation.participant.add' AND target_id = $1`,
          [conversationId],
        );
        expect(
          grants.rows[0].n,
          'the ledger kept a participation grant for a placement that rolled back. The ' +
            'audit row and the grant are not in one transaction, so the ledger now ' +
            'describes access nobody was ever given.',
        ).toBe(0);

        // The other half of "neither exists without the other", now that the ledger half
        // is the discriminating one.
        const participants = await pool!.query(
          `SELECT count(*)::int AS n FROM conversation.participants
            WHERE conversation_id = $1 AND principal_id = $2`,
          [conversationId, ADVISOR],
        );
        expect(participants.rows[0].n, 'the participation grant survived the rollback').toBe(0);
      } finally {
        // In `finally` because a trigger left on this table would fail every later test in
        // the file for a reason none of them names.
        await pool!.query(
          'DROP TRIGGER IF EXISTS break_after_ledger ON conversation.case_state_episodes',
        );
        await pool!.query('DROP FUNCTION IF EXISTS conversation.break_after_ledger()');
      }
    });

    gate('and the same claim SUCCEEDS once the ledger works again', async () => {
      /**
       * The positive control for the case above, and not a formality: without it, a build in
       * which `claim` refused everything — a broken fixture, a dropped cookie, a migration
       * that never ran — would satisfy every assertion up there perfectly. "It failed and
       * wrote nothing" is only evidence of atomicity if the same call succeeds and writes
       * both when nothing is injected.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      const participants = await pool!.query(
        `SELECT count(*)::int AS n FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );
      const grants = await pool!.query(
        `SELECT count(*)::int AS n FROM audit.ledger
          WHERE action = 'conversation.participant.add' AND target_id = $1
            AND detail->>'addedPrincipal' = $2`,
        [conversationId, ADVISOR],
      );
      expect(participants.rows[0].n).toBe(1);
      expect(grants.rows[0].n).toBe(1);
    });
  });

  describe('what the claimer can see afterwards', () => {
    gate('the claimed conversation appears in the claimer\'s inbox', async () => {
      /**
       * The finding, stated as the agent experiences it: claim a conversation and the
       * sidebar still reads "Nothing here yet".
       *
       * Asserted against the inbox ROUTE rather than against the participants table, so it
       * fails if the join, the projection or the row ever disagree again — the table was
       * never the thing that was broken, the joining of the two was.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      expect(await inbox('advisor')).not.toContain(conversationId);

      expect((await claim(conversationId, 'advisor')).status).toBe(201);

      expect(
        await inbox('advisor'),
        'a claimed conversation that is in no list is work an agent cannot find',
      ).toContain(conversationId);
    });

    gate('and the claimer can read it', async () => {
      // Ownership without participation also failed `decide()`'s participant branch. This
      // is the second half of "can they actually work it".
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const page = await fetch(`${BASE}${employeeRoutes.conversations.messages(conversationId)}`, {
        headers: { cookie: cookies.advisor ?? '' },
      });
      expect(page.status).toBe(200);
      const body = (await page.json()) as { messages: { body: string }[] };
      expect(body.messages.map((m) => m.body)).toContain('Please help with this.');
    });

    gate('the participation is dated by the application clock, not the database', async () => {
      /**
       * ADR-025. `decide()` evaluates the period against the application clock, and this
       * machine has run about a minute behind the managed database — a row stamped by
       * `now()` was "not yet effective" and the claimer got a 404 on their own conversation
       * until the skew elapsed.
       */
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const row = await pool!.query(
        `SELECT effective_from, effective_to, role, reply_authority
           FROM conversation.participants
          WHERE conversation_id = $1 AND principal_id = $2`,
        [conversationId, ADVISOR],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].effective_to).toBeNull();
      expect(row.rows[0].role).toBe('OWNER');
      // An owner who cannot answer the customer is not an owner (BR-12).
      expect(row.rows[0].reply_authority).toBe(true);
      expect(
        new Date(row.rows[0].effective_from as Date).getTime(),
        'effective_from must already be in effect when the response is returned',
      ).toBeLessThanOrEqual(Date.now());
    });

    gate('the participant count stays truthful', async () => {
      const conversationId = await queuedConversation(TEAM, 'ORDINARY');
      await claim(conversationId, 'advisor');

      const row = await pool!.query(
        `SELECT c.participant_count,
                (SELECT count(*) FROM conversation.participants p
                  WHERE p.conversation_id = c.conversation_id AND p.effective_to IS NULL) AS live
           FROM conversation.conversations c WHERE c.conversation_id = $1`,
        [conversationId],
      );
      expect(Number(row.rows[0].participant_count)).toBe(Number(row.rows[0].live));
      // The customer, plus the advisor who just claimed it.
      expect(Number(row.rows[0].live)).toBe(2);
    });
  });

  describe('the staff directory', () => {
    /**
     * `GET /v1/employee/directory` performed NO authorization of any kind.
     *
     * `@RequireSurface('EMPLOYEE')` authenticates; it does not authorize. So any signed-in
     * employee could page the entire staff list — names, department, team, status — and then
     * fetch any principal by id. `'directory.read'` was declared in the action vocabulary and
     * granted to AGENT and TEAM_LEAD, and was evaluated nowhere in the product: a permission
     * that existed only as documentation, guarding the route that returns everyone.
     *
     * The guard in `routing-authorization.test.ts` could not catch it either — that scan
     * asserts on handlers whose path names a `:conversationId` or a `:teamId`, and these name
     * a `:principalId`. Worth stating plainly: the structural guard covers a defect SHAPE,
     * and this route is a different shape.
     */
    const directory = (path: string, who: keyof typeof PEOPLE): Promise<Response> =>
      fetch(`${BASE}/v1/employee/directory${path}`, { headers: { cookie: cookies[who] ?? '' } });

    gate('an employee holding no role cannot read the directory', async () => {
      const response = await directory('?q=cl&visibility=COMPANY', 'roleless');
      expect(
        response.status,
        'a signed-in employee with no roles paged the entire staff list',
      ).toBe(404);
    });

    gate('nor fetch a single principal by id', async () => {
      // The second route, because a fix applied to one handler and not its sibling is this
      // repository's most repeated mistake.
      const response = await directory(`/${ADVISOR}`, 'roleless');
      expect(response.status, 'a role-less employee resolved a colleague by id').toBe(404);
    });

    gate('an AGENT can, because AGENT holds directory.read', async () => {
      /**
       * The positive control, and not a formality: `directory.read` is held by AGENT and
       * TEAM_LEAD, whose grants here are TEAM-scoped. A check copied from
       * `holdsAdminAction` — which decides against a synthetic resource with no owning team —
       * would deny every one of them, and the two cases above would pass perfectly while the
       * directory was broken for everybody.
       */
      const response = await directory('?q=cl&visibility=COMPANY', 'advisor');
      expect(
        response.status,
        'the check denied a role that genuinely holds directory.read',
      ).toBe(200);
    });
  });
});
