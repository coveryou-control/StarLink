/**
 * The availability reader, against real PostgreSQL.
 *
 * Two of these assert what the reader does NOT do, and they matter more than the rest.
 * §21.9 is unusually emphatic: availability is declared or derived from the calendar,
 * never inferred from a socket, and the ceiling is an unanswered business question
 * (D-05). A reader that helpfully filled either gap would be inventing a staffing policy
 * — and a system that invents one does not look like it is guessing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Timestamp, UUID } from '@starlink/shared-contracts';
import { assertDatabaseAllowed } from '../guard.js';
import { resetTeamFixtures } from '../testing/fixture-reset.js';
import { PgAvailabilityReader } from './availability-reader.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `af11` block — owned by this file alone. */
const ACTIVE = '018f2c5a-af11-7000-8000-00000000000a' as UUID;
const EXITED = '018f2c5a-af11-7000-8000-00000000000b' as UUID;
const CAPPED = '018f2c5a-af11-7000-8000-00000000000c' as UUID;
const ADVISOR = '018f2c5a-af11-7000-8000-00000000000d' as UUID;
/** N-52: a team whose capacity policy is the only one its members have. */
const TEAM = 'avail-reader-team';
const UNKNOWN = '018f2c5a-af11-7000-8000-0000000000ff' as UUID;
const TEAM_ID = 'availability-team';

let pool: pg.Pool | undefined;
let reader: PgAvailabilityReader;
let available = false;
const cases: string[] = [];
const conversations: string[] = [];

const now = (): Timestamp => new Date().toISOString() as Timestamp;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 5 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    reader = new PgAvailabilityReader(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ availability reader tests SKIPPED: no PostgreSQL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Availability Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','Avail Active','Service','ACTIVE'),
            ($2,'EMPLOYEE','Avail Exited','Service','EXITED'),
            ($3,'EMPLOYEE','Avail Capped','Service','ACTIVE'),
            ($4,'EMPLOYEE','Avail Advisor','Service','ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE SET status = EXCLUDED.status`,
    [ACTIVE, EXITED, CAPPED, ADVISOR],
  );
  await probe.query(
    `INSERT INTO conversation.capacity_policies
       (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
     VALUES ($1,'PRINCIPAL',$2,4,'{}'::jsonb,true)`,
    [crypto.randomUUID(), CAPPED],
  );

  /**
   * N-52's fixture: a TEAM-scoped policy and a member who has no policy of their own.
   *
   * This is the shape the seed actually writes, and the shape all three readers used to
   * resolve as NULL. `ADVISOR` deliberately gets no PRINCIPAL row, so the only ceiling
   * available is the team's.
   */
  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name) VALUES ($1,'Avail Team')
     ON CONFLICT (team_id) DO NOTHING`,
    [TEAM],
  );
  await probe.query(
    `INSERT INTO identity.team_memberships (team_id, principal_id, role)
     VALUES ($1,$2,'MEMBER'), ($1,$3,'MEMBER') ON CONFLICT DO NOTHING`,
    [TEAM, ADVISOR, CAPPED],
  );
  await probe.query(
    `INSERT INTO conversation.capacity_policies
       (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
     VALUES ($1,'TEAM',$2,6,'{}'::jsonb,true)`,
    [crypto.randomUUID(), TEAM],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.reservations WHERE principal_id = ANY($1::uuid[])`, [
      [ACTIVE, EXITED, CAPPED, ADVISOR],
    ]);
    await pool.query(`DELETE FROM conversation.capacity_policies WHERE scope_id = ANY($1::text[])`, [
      [CAPPED, TEAM],
    ]);
    await pool.query(`DELETE FROM identity.team_memberships WHERE team_id = $1`, [TEAM]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [
      conversations,
    ]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    // Anything an interrupted run left behind, which this process cannot name by id.
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [
      [ACTIVE, EXITED, CAPPED, ADVISOR],
    ]);
    await pool.query(`DELETE FROM identity.teams WHERE team_id = $1`, [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, body: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      console.warn(`  ⚠ UNPROVEN: ${name}`);
      ctx.skip();
      return;
    }
    await body();
  }, 30_000);
};

/** A live hold of the given weight. Expiry is app-clocked, per ADR-025. */
const hold = async (principalId: UUID, weight: number): Promise<void> => {
  await pool!.query(
    `INSERT INTO conversation.reservations
       (reservation_id, principal_id, ref_system, ref_type, ref_id, weight, effective_from, expires_at)
     VALUES ($1,$2,'LOCAL','conversation',$3,$4,$5,$6)`,
    [
      crypto.randomUUID(),
      principalId,
      crypto.randomUUID(),
      weight,
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
};

describe('PgAvailabilityReader', () => {
  withDb('reports an active account as active', async () => {
    const facts = await reader.factsFor(ACTIVE, now());
    expect(facts.accountActive).toBe(true);
  });

  withDb('reports a deactivated account as inactive (BR-13)', async () => {
    const facts = await reader.factsFor(EXITED, now());
    expect(facts.accountActive).toBe(false);
  });

  withDb('treats an unknown principal as unavailable rather than as an error', async () => {
    // Fail closed. The alternative is routing work to somebody who does not exist.
    const facts = await reader.factsFor(UNKNOWN, now());
    expect(facts.accountActive).toBe(false);
  });

  withDb('omits capacity entirely when no ceiling is configured', async () => {
    /**
     * D-05 is unanswered, and `undefined` is how that is said. Reporting a ceiling of
     * zero would make every employee permanently unavailable — an invented staffing
     * policy arrived at by accident, which is the worst way to arrive at one.
     */
    const facts = await reader.factsFor(ACTIVE, now());
    expect(facts.capacity).toBeUndefined();
  });

  withDb('resolves a TEAM-scoped ceiling for a member with no policy of their own', async () => {
    /**
     * N-52, and the reason no agent had a ceiling at all.
     *
     * `capacity_policies` is scoped, and this reader hardcoded `scope_kind = 'PRINCIPAL'`
     * while the seed writes TEAM rows. Every lookup therefore returned NULL, and an absent
     * ceiling is correctly read as "no ceiling" — so the capacity feature was inert on any
     * seeded database while reading as built. Every existing capacity test passed because
     * each one inserts its own PRINCIPAL row first, which is exactly the blind spot.
     *
     * D-05 (2026-08-31) makes capacity a configurable model with a team default and a
     * per-person override, so the ceiling must resolve through the team when the person
     * has none.
     */
    const facts = await reader.factsFor(ADVISOR, now());
    expect(
      facts.capacity?.ceiling,
      'a team-scoped capacity policy was ignored — the agent has no ceiling at all',
    ).toBe(6);
  });

  withDb('lets a PRINCIPAL policy override the team default', async () => {
    /**
     * The precedence, and the positive control for the case above: `CAPPED` belongs to the
     * same team (ceiling 6) and carries its own policy of 4. If the fallback were ordered
     * the other way, or matched indiscriminately, this would read 6.
     */
    const facts = await reader.factsFor(CAPPED, now());
    expect(facts.capacity?.ceiling, 'the per-person override lost to the team default').toBe(4);
  });

  withDb('sums LIVE reservation weights rather than counting conversations', async () => {
    // Brief §12: never a hard-coded "5 chats". A claim costs more than a renewal
    // question, so the load is a sum of weights.
    await hold(CAPPED, 1);
    await hold(CAPPED, 2);

    const facts = await reader.factsFor(CAPPED, now());
    expect(facts.capacity).toEqual({ openConversations: 3, ceiling: 4 });
  });

  withDb('excludes a released hold from the load', async () => {
    // Released, not deleted (§17.3) — so the row is still there and must not count.
    await hold(ACTIVE, 5);
    await pool!.query(
      `UPDATE conversation.reservations SET released_at = now(), release_reason = 'test'
        WHERE principal_id = $1`,
      [ACTIVE],
    );
    await pool!.query(
      `INSERT INTO conversation.capacity_policies
         (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
       VALUES ($1,'PRINCIPAL',$2,9,'{}'::jsonb,true)`,
      [crypto.randomUUID(), ACTIVE],
    );

    const facts = await reader.factsFor(ACTIVE, now());
    expect(facts.capacity?.openConversations).toBe(0);

    await pool!.query(`DELETE FROM conversation.capacity_policies WHERE scope_id = $1`, [ACTIVE]);
  });

  withDb('excludes an expired hold from the load', async () => {
    // Expiry is compared against the APPLICATION clock the reservation was written
    // with, not SQL `now()` — ADR-025, learned from a database running ~57s ahead.
    await pool!.query(
      `INSERT INTO conversation.reservations
         (reservation_id, principal_id, ref_system, ref_type, ref_id, weight, effective_from, expires_at)
       VALUES ($1,$2,'LOCAL','conversation',$3,7,$4,$5)`,
      [
        crypto.randomUUID(),
        ADVISOR,
        crypto.randomUUID(),
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
      ],
    );
    await pool!.query(
      `INSERT INTO conversation.capacity_policies
         (policy_id, scope_kind, scope_id, capacity_units, work_weights, is_seed_placeholder)
       VALUES ($1,'PRINCIPAL',$2,9,'{}'::jsonb,true)`,
      [crypto.randomUUID(), ADVISOR],
    );

    const facts = await reader.factsFor(ADVISOR, now());
    expect(facts.capacity?.openConversations).toBe(0);

    await pool!.query(`DELETE FROM conversation.capacity_policies WHERE scope_id = $1`, [ADVISOR]);
  });

  withDb('reports declared absence as false rather than guessing it', async () => {
    /**
     * There is no table for leave, off-shift or "unavailable" — that is D-05, still
     * open. The reader says so by reporting `false`, which is a fact about what is
     * recorded, not a claim that the person is at their desk.
     *
     * The alternative — deriving it from a socket, a heartbeat or a last-seen time — is
     * the one thing §21.9 forbids outright: "a phone entering a lift is not leave."
     */
    const facts = await reader.factsFor(ACTIVE, now());
    expect(facts.onDeclaredAbsence).toBe(false);
    expect(facts.explicitlyUnavailable).toBe(false);
  });

  withDb('has no way to report presence at all', async () => {
    // Structural, not disciplinary. The returned shape carries no socket, heartbeat or
    // last-seen field, so a future contributor cannot consult one by accident.
    const facts = await reader.factsFor(ACTIVE, now());
    const keys = Object.keys(facts);
    for (const forbidden of ['lastSeenAt', 'connected', 'socketId', 'heartbeatAt', 'presence']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  withDb('reads the designated employee from the case (D-19)', async () => {
    const caseId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    cases.push(caseId);
    conversations.push(conversationId);
    await pool!.query(
      `INSERT INTO conversation.service_cases
         (case_id, state, owning_team_id, designated_employee_id)
       VALUES ($1,'ACTIVE',$2,$3)`,
      [caseId, TEAM_ID, ADVISOR],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'ACTIVE','designated',now())`,
      [conversationId, caseId],
    );

    expect(await reader.designatedEmployee(conversationId as UUID)).toBe(ADVISOR);
  });

  withDb('returns nothing when no designation has been recorded', async () => {
    // A new prospect has no advisor, and that is normal rather than an error (§21.7).
    const caseId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    cases.push(caseId);
    conversations.push(conversationId);
    await pool!.query(
      `INSERT INTO conversation.service_cases (case_id, state, owning_team_id) VALUES ($1,'NEW',$2)`,
      [caseId, TEAM_ID],
    );
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, case_id, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE',$2,'QUEUED','no designation',now())`,
      [conversationId, caseId],
    );

    expect(await reader.designatedEmployee(conversationId as UUID)).toBeUndefined();
  });
});
