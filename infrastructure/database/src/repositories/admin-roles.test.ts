/**
 * Account and role administration, against real PostgreSQL.
 *
 * Role assignment is the most dangerous operation in the product: whoever can grant a
 * role can grant themselves anything, and whoever can revoke one is relied upon to
 * actually end access. So the properties under test here are not "does the row appear"
 * but the three that make a grant trustworthy:
 *
 *   1. **A grant takes effect immediately** — the holder's session version is bumped in
 *      the same transaction, so a live session picks the change up on its next request
 *      rather than at its next sign-in (FR-AUTH-2).
 *   2. **A revocation is the same** — otherwise "revoked" means "revoked in twelve
 *      hours", which is not what anyone reading the audit log will assume.
 *   3. **A revocation is DATED, not deleted** — "who could see this last March" is
 *      exactly what an audit asks, and a deleted row cannot answer it (§17.3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgAdminStore } from './admin-store.js';
import { assertDatabaseAllowed } from '../guard.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const HOLDER = '018f2c5a-b1b1-7000-8000-00000000000a';
const ADMIN = '018f2c5a-b1b1-7000-8000-00000000000b';
const CUSTOMER = '018f2c5a-b1b1-7000-8000-00000000000c';
const TEAM_ID = 'roles-test-team';

let pool: pg.Pool | undefined;
let store: PgAdminStore;
let available = false;

beforeAll(async () => {
  assertDatabaseAllowed(CONNECTION);
  const probe = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  try {
    await probe.query('SELECT 1');
    available = true;
    pool = probe;
    store = new PgAdminStore(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Role administration tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
  }
});

async function wipe(): Promise<void> {
  const p = pool!;
  await p.query(
    'DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[]) OR granted_by = ANY($1::uuid[])',
    [[HOLDER, ADMIN, CUSTOMER]],
  );
  await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
    [HOLDER, ADMIN, CUSTOMER],
  ]);
  await p.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
}

const reset = async (): Promise<void> => {
  const p = pool!;
  await wipe();
  await p.query('INSERT INTO identity.teams (team_id, display_name) VALUES ($1,$2)', [TEAM_ID, 'Roles Team']);
  await p.query(
    `INSERT INTO identity.principals (principal_id, kind, employee_id, display_name, department)
     VALUES ($1,'EMPLOYEE','E-HOLD','Role Holder','Service'),
            ($2,'EMPLOYEE','E-ADMIN','Role Admin','Service'),
            ($3,'CUSTOMER',NULL,'A Customer',NULL)`,
    [HOLDER, ADMIN, CUSTOMER],
  );
};

afterAll(async () => {
  if (pool !== undefined && available) await wipe();
  await pool?.end().catch(() => undefined);
});

/** Skips loudly rather than passing quietly when the database is absent. */
const withDb = (name: string, body: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!available) {
      console.warn(`  ⚠ UNPROVEN: ${name}`);
      ctx.skip();
      return;
    }
    await reset();
    await body();
  });
};

const versionOf = async (principalId: string): Promise<number> => {
  const result = await pool!.query(
    'SELECT session_version FROM identity.principals WHERE principal_id = $1',
    [principalId],
  );
  return result.rows[0].session_version as number;
};

describe('granting a role', () => {
  withDb('records the grant and returns it', async () => {
    const granted = await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'TEAM',
      scopeId: TEAM_ID,
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    expect(granted?.role).toBe('SUPERVISOR');
    expect(granted?.scopeKind).toBe('TEAM');
    expect(granted?.scopeId).toBe(TEAM_ID);
  });

  withDb('bumps the holder’s session version, so it applies on their NEXT request', async () => {
    const before = await versionOf(HOLDER);

    await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    // Without this, a live session keeps its stale claims until it expires — and the
    // same code path revokes, where "in twelve hours" would be unacceptable.
    expect(await versionOf(HOLDER)).toBe(before + 1);
  });

  withDb('refuses a scoped grant that carries no scope', async () => {
    // A TEAM grant with no team is not narrower than GLOBAL — it is GLOBAL wearing a
    // scope's name. Refusing matches FR-AUTHZ-3: unclear is denied, never unrestricted.
    const granted = await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'TEAM',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    expect(granted).toBeUndefined();
    expect(await store.listRoles(HOLDER, new Date())).toEqual([]);
  });

  withDb('refuses a grant to a customer principal', async () => {
    const granted = await store.grantRole({
      principalId: CUSTOMER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    expect(granted).toBeUndefined();
  });

  withDb('refuses a grant to a principal that does not exist', async () => {
    const granted = await store.grantRole({
      principalId: crypto.randomUUID(),
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    expect(granted).toBeUndefined();
  });

  withDb('leaves no row behind when it refuses', async () => {
    // The refusal happens mid-transaction, after the principal lock. A rollback that
    // did not happen would leave a live grant nobody asked for.
    const before = await pool!.query('SELECT count(*)::int AS c FROM identity.role_assignments');
    await store.grantRole({
      principalId: CUSTOMER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });
    const after = await pool!.query('SELECT count(*)::int AS c FROM identity.role_assignments');

    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});

describe('listing roles', () => {
  withDb('returns only grants that are live at the given instant', async () => {
    const at = new Date();
    const past = new Date(at.getTime() - 60_000);

    await store.grantRole({
      principalId: HOLDER,
      role: 'LIVE_ROLE',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: past,
    });
    await store.grantRole({
      principalId: HOLDER,
      role: 'EXPIRED_ROLE',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: past,
      effectiveTo: new Date(at.getTime() - 30_000),
    });

    const live = await store.listRoles(HOLDER, at);

    // Expiry is read from the clock: no sweep job's failure can extend access (§17.3).
    expect(live.map((r) => r.role)).toEqual(['LIVE_ROLE']);
  });

  withDb('does not return a grant before it becomes effective', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await store.grantRole({
      principalId: HOLDER,
      role: 'FUTURE_ROLE',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: future,
    });

    expect(await store.listRoles(HOLDER, new Date())).toEqual([]);
    expect((await store.listRoles(HOLDER, new Date(future.getTime() + 1000))).map((r) => r.role)).toEqual([
      'FUTURE_ROLE',
    ]);
  });

  withDb('does not leak another principal’s grants', async () => {
    await store.grantRole({
      principalId: HOLDER,
      role: 'HOLDER_ONLY',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId: crypto.randomUUID(),
      at: new Date(),
    });

    expect(await store.listRoles(ADMIN, new Date())).toEqual([]);
  });
});

describe('revoking a role', () => {
  withDb('ends access immediately and reports whose it was', async () => {
    const assignmentId = crypto.randomUUID();
    await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId,
      at: new Date(Date.now() - 60_000),
    });

    const principalId = await store.revokeRole(assignmentId, new Date());

    expect(principalId).toBe(HOLDER);
    expect(await store.listRoles(HOLDER, new Date())).toEqual([]);
  });

  withDb('DATES the row rather than deleting it', async () => {
    const assignmentId = crypto.randomUUID();
    await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId,
      at: new Date(Date.now() - 60_000),
    });

    await store.revokeRole(assignmentId, new Date());

    // The history must survive: "who could see this last March" is an audit question,
    // and a deleted row cannot answer it.
    const row = await pool!.query(
      'SELECT role, effective_to FROM identity.role_assignments WHERE assignment_id = $1',
      [assignmentId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].effective_to).not.toBeNull();
  });

  withDb('bumps the session version so the privilege stops NOW, not at expiry', async () => {
    const assignmentId = crypto.randomUUID();
    await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId,
      at: new Date(Date.now() - 60_000),
    });
    const afterGrant = await versionOf(HOLDER);

    await store.revokeRole(assignmentId, new Date());

    expect(await versionOf(HOLDER)).toBe(afterGrant + 1);
  });

  withDb('is not repeatable against an already-revoked grant', async () => {
    const assignmentId = crypto.randomUUID();
    await store.grantRole({
      principalId: HOLDER,
      role: 'SUPERVISOR',
      scopeKind: 'GLOBAL',
      grantedBy: ADMIN,
      assignmentId,
      at: new Date(Date.now() - 60_000),
    });
    await store.revokeRole(assignmentId, new Date());

    // A second revoke must not bump the version again — that would be an endless
    // session-invalidation lever for anyone who can call it.
    const version = await versionOf(HOLDER);
    expect(await store.revokeRole(assignmentId, new Date())).toBeUndefined();
    expect(await versionOf(HOLDER)).toBe(version);
  });

  withDb('reports nothing for an assignment that never existed', async () => {
    expect(await store.revokeRole(crypto.randomUUID(), new Date())).toBeUndefined();
  });
});

describe('listing accounts', () => {
  withDb('returns employees and never a customer', async () => {
    /**
     * Searched for rather than paged for, deliberately.
     *
     * This asserted `listAccounts({ limit: 100 })` contained the fixture, which made it
     * a test of how many OTHER employees happen to exist: the query is
     * `ORDER BY display_name LIMIT n`, so the fixture drops off the page as soon as a
     * hundred names sort ahead of it. It failed the first time another file's fixture
     * (`claim-race`, which creates a hundred "Claimer N" principals) overlapped with it.
     *
     * The property under test is unchanged — an employee is returned, a customer never
     * is — and it is now independent of what else is in a shared database.
     */
    const employees = await store.listAccounts({ search: 'Role Holder', limit: 100 });
    expect(employees.map((a) => a.principalId)).toContain(HOLDER);

    // `kind = 'EMPLOYEE'` is a predicate in the query. A customer must not reach an
    // administrative list by any path (§11.7) — including by being searched for
    // BY NAME, which is the path a paged assertion never exercises.
    const hunted = await store.listAccounts({ search: 'A Customer', limit: 100 });
    expect(hunted.map((a) => a.principalId)).not.toContain(CUSTOMER);
    expect(hunted).toHaveLength(0);
  });

  withDb('never returns a credential hash', async () => {
    await pool!.query(`UPDATE identity.principals SET credential_hash = $2 WHERE principal_id = $1`, [
      HOLDER,
      'SENTINEL_CREDENTIAL_HASH',
    ]);

    const accounts = await store.listAccounts({ limit: 100 });

    // The column is never selected, so it cannot be logged or serialised by a later
    // change that spreads the row.
    expect(JSON.stringify(accounts)).not.toContain('SENTINEL_CREDENTIAL_HASH');
    expect(JSON.stringify(accounts)).not.toContain('credential');
  });

  withDb('filters by search term without matching a customer', async () => {
    const byName = await store.listAccounts({ search: 'Role Holder', limit: 50 });
    expect(byName.map((a) => a.principalId)).toEqual([HOLDER]);

    const customerByName = await store.listAccounts({ search: 'A Customer', limit: 50 });
    expect(customerByName).toEqual([]);
  });

  withDb('respects the limit', async () => {
    const one = await store.listAccounts({ limit: 1 });
    expect(one).toHaveLength(1);
  });
});
