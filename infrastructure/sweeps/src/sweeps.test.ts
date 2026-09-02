/**
 * The periodic sweeps, against real PostgreSQL.
 *
 * Two properties matter more than the mechanics:
 *
 *   * The inactive-owner sweep **reports and does not repair.** A sweep that quietly
 *     reassigned a departed colleague's work would hide the failure §32.3's zero-target
 *     exists to expose — and the number would never move, so nobody would ever learn
 *     that departures strand work.
 *   * The reservation sweep **releases rather than deletes**, and returns the work to
 *     the queue. A hold that outlives its attempt consumes an agent's capacity forever:
 *     they look busy, the router stops sending them work, and nothing says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createLogger } from '@starlink/observability';
import { assertDatabaseAllowed, resetTeamFixtures } from '@starlink/database';

import { InactiveOwnerSweep, ReservationExpirySweep, schedule } from './sweeps.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

/** `ae1a` block — owned by this file alone. */
const LEAVER = '018f2c5a-ae1a-7000-8000-00000000000a';
const ACTIVE = '018f2c5a-ae1a-7000-8000-00000000000b';
const TEAM_ID = 'sweeps-team';

let pool: pg.Pool | undefined;
let available = false;
const logger = createLogger({ service: 'sweeps-test', sink: () => undefined });
const cases: string[] = [];
const conversations: string[] = [];

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ sweep tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'Sweeps Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status)
     VALUES ($1,'EMPLOYEE','Sweep Leaver','Service','EXITED'),
            ($2,'EMPLOYEE','Sweep Active','Service','ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE SET status = EXCLUDED.status`,
    [LEAVER, ACTIVE],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query(`DELETE FROM conversation.reservations WHERE principal_id = ANY($1::uuid[])`, [[LEAVER, ACTIVE]]);
    await pool.query(`DELETE FROM conversation.queue_entries WHERE team_id = $1`, [TEAM_ID]);
    await pool.query(`DELETE FROM conversation.conversations WHERE conversation_id = ANY($1::uuid[])`, [conversations]);
    await pool.query(`DELETE FROM conversation.service_cases WHERE case_id = ANY($1::uuid[])`, [cases]);
    // Anything an interrupted run left behind, which this process cannot name by id.
    await resetTeamFixtures(pool, TEAM_ID);
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [[LEAVER, ACTIVE]]);
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
  });
};

async function strandedCase(ownerId: string, state = 'ACTIVE'): Promise<string> {
  const caseId = crypto.randomUUID();
  cases.push(caseId);
  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, state, owning_team_id, current_owner_id, updated_at)
     VALUES ($1,$2,$3,$4, now() - interval '2 hours')`,
    [caseId, state, TEAM_ID, ownerId],
  );
  return caseId;
}

describe('InactiveOwnerSweep', () => {
  withDb('finds a case owned by a deactivated principal', async () => {
    const caseId = await strandedCase(LEAVER);

    const result = await new InactiveOwnerSweep({ pool: pool!, logger }).run();

    expect(result.stranded.map((s) => s.caseId)).toContain(caseId);
    expect(result.stranded.find((s) => s.caseId === caseId)?.ownerId).toBe(LEAVER);
  });

  withDb('reports how long the work has been stranded', async () => {
    // The age is what turns "something is wrong" into "this has been wrong for two
    // hours" — the difference between a number and an actionable alert.
    const caseId = await strandedCase(LEAVER);

    const result = await new InactiveOwnerSweep({ pool: pool!, logger }).run();
    const found = result.stranded.find((s) => s.caseId === caseId);

    expect(found?.strandedForSeconds).toBeGreaterThan(3000);
  });

  withDb('does NOT repair anything', async () => {
    /**
     * The property that matters. A sweep that reassigned would make §32.3's gauge read
     * zero forever, and the organisation would never learn that departures strand work.
     * Reporting IS the action.
     */
    const caseId = await strandedCase(LEAVER);

    const result = await new InactiveOwnerSweep({ pool: pool!, logger }).run();

    expect(result.acted).toBe(0);
    const row = await pool!.query(
      `SELECT current_owner_id FROM conversation.service_cases WHERE case_id = $1`,
      [caseId],
    );
    // Still owned by the person who left. Visibly broken, not quietly fixed.
    expect(row.rows[0].current_owner_id).toBe(LEAVER);
  });

  withDb('ignores cases owned by an ACTIVE principal', async () => {
    const caseId = await strandedCase(ACTIVE);

    const result = await new InactiveOwnerSweep({ pool: pool!, logger }).run();

    expect(result.stranded.map((s) => s.caseId)).not.toContain(caseId);
  });

  withDb('ignores a closed case, even one owned by a leaver', async () => {
    // Finished work needs no owner. Counting it would make the zero-target unreachable
    // and the alert permanent, which is how an alert gets muted.
    const caseId = await strandedCase(LEAVER, 'CLOSED');

    const result = await new InactiveOwnerSweep({ pool: pool!, logger }).run();

    expect(result.stranded.map((s) => s.caseId)).not.toContain(caseId);
  });
});

describe('ReservationExpirySweep', () => {
  /**
   * Stamped from the APPLICATION clock, deliberately — ADR-025.
   *
   * The first version used SQL `now()` and the tests failed against a database whose
   * clock runs ~57 seconds ahead of this machine: a reservation "expired 30 seconds ago"
   * in database time was still 27 seconds in the future by the application clock the
   * sweep compares with, so nothing was ever released.
   *
   * Reservations are CREATED by the application (`LocalWorkOrchestrator.reserve`
   * computes the expiry in JS), so they must be COMPARED against the same clock. The
   * rule generalises past the tables ADR-025 originally named: any timestamp one side
   * writes and the other reads must come from a single clock.
   */
  const reserve = async (expiresInSeconds: number): Promise<string> => {
    const reservationId = crypto.randomUUID();
    const from = new Date(Date.now() - 60_000).toISOString();
    const expires = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    await pool!.query(
      `INSERT INTO conversation.reservations
         (reservation_id, principal_id, ref_system, ref_type, ref_id, weight,
          effective_from, expires_at)
       VALUES ($1,$2,'LOCAL','conversation',$3,1,$4,$5)`,
      [reservationId, ACTIVE, crypto.randomUUID(), from, expires],
    );
    return reservationId;
  };

  withDb('releases a hold that has expired', async () => {
    const expired = await reserve(-30);

    const result = await new ReservationExpirySweep({ pool: pool!, logger }).run();

    expect(result.acted).toBeGreaterThan(0);
    const row = await pool!.query(
      `SELECT released_at, release_reason FROM conversation.reservations WHERE reservation_id = $1`,
      [expired],
    );
    expect(row.rows[0].released_at).not.toBeNull();
    expect(row.rows[0].release_reason).toBe('expired');
  });

  withDb('releases rather than deletes, so capacity history stays answerable', async () => {
    const expired = await reserve(-30);
    await new ReservationExpirySweep({ pool: pool!, logger }).run();

    const row = await pool!.query(
      `SELECT 1 FROM conversation.reservations WHERE reservation_id = $1`,
      [expired],
    );
    // "Why was this agent at capacity at 14:05" needs the row to still exist (§17.3).
    expect(row.rowCount).toBe(1);
  });

  withDb('leaves a live hold alone', async () => {
    const live = await reserve(3600);

    await new ReservationExpirySweep({ pool: pool!, logger }).run();

    const row = await pool!.query(
      `SELECT released_at FROM conversation.reservations WHERE reservation_id = $1`,
      [live],
    );
    expect(row.rows[0].released_at).toBeNull();
  });

  withDb('returns work held against an expired reservation to the queue', async () => {
    // Otherwise the entry sits in RESERVED forever: not claimable, not visibly waiting,
    // and not counted in queue depth — the quietest way to lose a customer.
    const conversationId = crypto.randomUUID();
    const queueEntryId = crypto.randomUUID();
    conversations.push(conversationId);
    await pool!.query(
      `INSERT INTO conversation.conversations
         (conversation_id, conversation_type, state, title, last_activity_at)
       VALUES ($1,'CUSTOMER_SERVICE','QUEUED','reserved thread', now())`,
      [conversationId],
    );
    const expired = await reserve(-30);
    await pool!.query(
      `INSERT INTO conversation.queue_entries
         (queue_entry_id, conversation_id, team_id, priority, state, reservation_id, enqueued_at)
       VALUES ($1,$2,$3,'NORMAL','RESERVED',$4, now())`,
      [queueEntryId, conversationId, TEAM_ID, expired],
    );

    await new ReservationExpirySweep({ pool: pool!, logger }).run();

    const row = await pool!.query(
      `SELECT state, reservation_id FROM conversation.queue_entries WHERE queue_entry_id = $1`,
      [queueEntryId],
    );
    expect(row.rows[0].state).toBe('WAITING');
    expect(row.rows[0].reservation_id).toBeNull();
  });

  withDb('is safe to run when there is nothing to do', async () => {
    await new ReservationExpirySweep({ pool: pool!, logger }).run();
    const second = await new ReservationExpirySweep({ pool: pool!, logger }).run();
    expect(second.acted).toBe(0);
  });
});

describe('schedule', () => {
  it('never overlaps a run with itself', async () => {
    // A sweep slower than its interval must not start on top of the previous run: two
    // reservation sweeps would contend on the same rows for no benefit.
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;

    const slow = {
      async run() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        runs += 1;
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return { examined: 0, acted: 0 };
      },
    };

    const handle = schedule(slow, 5, logger, 'test');
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    expect(runs).toBeGreaterThan(1);
    expect(maxConcurrent).toBe(1);
  });

  it('keeps running after a sweep throws', async () => {
    // Housekeeping that stops at the first error is housekeeping that stopped weeks ago
    // and nobody noticed.
    let calls = 0;
    const failing = {
      async run(): Promise<{ examined: number; acted: number }> {
        calls += 1;
        throw new Error('boom');
      },
    };

    const handle = schedule(failing, 5, logger, 'test');
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(calls).toBeGreaterThan(1);
  });
});
