/**
 * Employee exit, against real PostgreSQL.
 *
 * Doc §21.9 calls case C — departure — "the one that silently loses customers", and
 * §32.3 sets the target for inactive-owner conversations at zero. These tests exist so
 * that claim is measured rather than asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgAdminStore } from './admin-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const LEAVER = '018f2c5a-aaaa-7000-8000-00000000000a';
const STAYER = '018f2c5a-aaaa-7000-8000-00000000000b';
const TEAM_ID = 'exit-test-team';

let pool: pg.Pool | undefined;
let store: PgAdminStore;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  // 15s, not 2s. A short probe timeout does not fail a run — it makes the suite SKIP,
  // which proves nothing while looking green. These were written against a local socket
  // where 2s was generous; against a managed database (with a possible cold start) it is
  // not. A long timeout costs nothing when the database is up: it only delays the moment
  // we admit we cannot reach one.
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    store = new PgAdminStore(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Employee-exit tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
  }
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query('DELETE FROM conversation.service_cases WHERE owning_team_id = $1', [TEAM_ID]);
    await pool.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
      [LEAVER, STAYER],
    ]);
    await pool.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

const reset = async (): Promise<void> => {
  const p = pool!;
  await p.query('DELETE FROM conversation.service_cases WHERE owning_team_id = $1', [TEAM_ID]);
  await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [[LEAVER, STAYER]]);
  await p.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
  await p.query('INSERT INTO identity.teams (team_id, display_name) VALUES ($1, $2)', [TEAM_ID, 'Exit Team']);
  await p.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department)
     VALUES ($1,'EMPLOYEE','The Leaver','Service'), ($2,'EMPLOYEE','The Stayer','Service')`,
    [LEAVER, STAYER],
  );
};

const givenCase = async (ownerId: string, state: string): Promise<string> => {
  const caseId = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO conversation.service_cases (case_id, owning_team_id, current_owner_id, state, customer_ref)
     VALUES ($1,$2,$3,$4,'CCS:customer:exit')`,
    [caseId, TEAM_ID, ownerId, state],
  );
  return caseId;
};

const withDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await reset();
    await fn();
  });

describe('employee exit (FR-EMP-2/3, BR-13)', () => {
  withDb('surfaces every open conversation the leaver owned', async () => {
    await givenCase(LEAVER, 'ACTIVE');
    await givenCase(LEAVER, 'WAITING_CUSTOMER');
    await givenCase(LEAVER, 'QUEUED');
    // Closed work needs no owner and must not appear as outstanding.
    await givenCase(LEAVER, 'CLOSED');
    // Someone else's work must not be swept up.
    await givenCase(STAYER, 'ACTIVE');

    const outcome = await store.deactivate(LEAVER, 'left the company');
    expect(outcome).toBeDefined();
    expect(outcome!.ownedOpenConversations).toHaveLength(3);
    expect(outcome!.ownedOpenConversations.every((c) => c.state !== 'CLOSED')).toBe(true);
  });

  withDb('ends access immediately by bumping the session version (FR-AUTH-2)', async () => {
    const before = await pool!.query(
      'SELECT session_version, status FROM identity.principals WHERE principal_id = $1',
      [LEAVER],
    );
    await store.deactivate(LEAVER, 'left');
    const after = await pool!.query(
      'SELECT session_version, status FROM identity.principals WHERE principal_id = $1',
      [LEAVER],
    );
    expect(after.rows[0].status).toBe('EXITED');
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);
  });

  withDb('keeps the principal record, so historical authorship stays attributable', async () => {
    // Brief §49: history remains company property and the exited employee remains the
    // historical actor. Deleting the row would rewrite authorship.
    await store.deactivate(LEAVER, 'left');
    const row = await pool!.query('SELECT display_name FROM identity.principals WHERE principal_id = $1', [
      LEAVER,
    ]);
    expect(row.rows[0].display_name).toBe('The Leaver');
  });

  withDb('is safe to run twice', async () => {
    await store.deactivate(LEAVER, 'left');
    const second = await store.deactivate(LEAVER, 'left again');
    expect(second?.alreadyInactive).toBe(true);
  });

  withDb('returns undefined for an unknown principal rather than inventing one', async () => {
    expect(await store.deactivate(crypto.randomUUID(), 'nobody')).toBeUndefined();
  });
});

describe('the inactive-owner invariant (§32.3, target zero)', () => {
  withDb('counts work stranded on an inactive owner', async () => {
    await givenCase(LEAVER, 'ACTIVE');
    await givenCase(LEAVER, 'ASSIGNED');
    expect(await store.countInactiveOwnerConversations()).toBe(0);

    await store.deactivate(LEAVER, 'left');
    // This is the alert condition: the work is now unreachable until reassigned.
    expect(await store.countInactiveOwnerConversations()).toBe(2);
  });

  withDb('returns to zero once the work is reassigned', async () => {
    const caseId = await givenCase(LEAVER, 'ACTIVE');
    await store.deactivate(LEAVER, 'left');
    expect(await store.countInactiveOwnerConversations()).toBe(1);

    await pool!.query('UPDATE conversation.service_cases SET current_owner_id = $2 WHERE case_id = $1', [
      caseId,
      STAYER,
    ]);
    expect(await store.countInactiveOwnerConversations()).toBe(0);
  });

  withDb('ignores closed work, which needs no owner', async () => {
    await givenCase(LEAVER, 'CLOSED');
    await givenCase(LEAVER, 'RESOLVED');
    await store.deactivate(LEAVER, 'left');
    expect(await store.countInactiveOwnerConversations()).toBe(0);
  });
});
