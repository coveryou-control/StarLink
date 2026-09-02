/**
 * LocalIamAdapter against the SAME conformance suite the mock passes.
 *
 * This is the point of the conformance kit: two implementations, one behavioural
 * contract. If the interim adapter and the mock diverge, the Phase 9 cutover to
 * Central IAM would be a rewrite rather than a configuration change.
 *
 * Requires PostgreSQL. Skips loudly without one, never passes silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '@starlink/database';
import { identityConformance } from '@starlink/shared-contracts';
import { LocalIamAdapter } from './local-iam.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

let handle: DatabaseHandle | undefined;
let available = false;

/** Stand-in for the real password hasher; the adapter takes it as a dependency. */
const verifySecret = async (presented: string, storedHash: string): Promise<boolean> =>
  storedHash === `plain:${presented}`;

const PRINCIPAL_ID = '018f2c5a-1111-7000-8000-000000000001';
const MANAGER_ID = '018f2c5a-1111-7000-8000-000000000002';
const CUSTOMER_ID = '018f2c5a-1111-7000-8000-000000000003';
const TEAM_ID = 'conformance-support';

beforeAll(async () => {
  try {
    // See the note in local-directory.test.ts: a short probe timeout turns an
    // unreachable database into a silent skip rather than a visible failure.
    handle = createDatabase({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000 });
    await handle.pool.query('SELECT 1');
    available = true;
  } catch {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    console.warn('\n  ⚠ LocalIamAdapter conformance SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  const p = handle.pool;
  await p.query('DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])', [
    [PRINCIPAL_ID, MANAGER_ID],
  ]);
  await p.query('DELETE FROM identity.team_memberships WHERE principal_id = ANY($1::uuid[])', [
    [PRINCIPAL_ID, MANAGER_ID],
  ]);
  await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
    [PRINCIPAL_ID, MANAGER_ID, CUSTOMER_ID],
  ]);
  await p.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);

  await p.query('INSERT INTO identity.teams (team_id, display_name, department) VALUES ($1,$2,$3)', [
    TEAM_ID,
    'Conformance Support',
    'Service',
  ]);
  await p.query(
    `INSERT INTO identity.principals
       (principal_id, kind, employee_id, username, display_name, department, credential_hash)
     VALUES ($1,'EMPLOYEE','E-MGR','conf.manager','Conformance Manager','Service',NULL)`,
    [MANAGER_ID],
  );
  await p.query(
    `INSERT INTO identity.principals
       (principal_id, kind, employee_id, username, display_name, department, manager_id, credential_hash, skills)
     VALUES ($1,'EMPLOYEE','E-CONF','conf.agent','Conformance Agent','Service',$2,$3,$4)`,
    [PRINCIPAL_ID, MANAGER_ID, 'plain:correct-horse', ['claims']],
  );
  // A customer principal, to prove the employee path refuses it.
  await p.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name) VALUES ($1,'CUSTOMER','A Customer')`,
    [CUSTOMER_ID],
  );
  await p.query('INSERT INTO identity.team_memberships (team_id, principal_id) VALUES ($1,$2)', [
    TEAM_ID,
    PRINCIPAL_ID,
  ]);
  await p.query(
    `INSERT INTO identity.role_assignments (assignment_id, principal_id, role, scope_kind, scope_id, granted_by)
     VALUES (gen_random_uuid(), $1, 'COMPLIANCE', 'TEAM', $2, $3)`,
    [PRINCIPAL_ID, TEAM_ID, MANAGER_ID],
  );
  // An already-expired assignment, which must not appear in the claims.
  await p.query(
    `INSERT INTO identity.role_assignments
       (assignment_id, principal_id, role, scope_kind, scope_id, granted_by, effective_from, effective_to)
     VALUES (gen_random_uuid(), $1, 'EXPIRED_ROLE', 'GLOBAL', NULL, $2, now() - interval '10 days', now() - interval '1 day')`,
    [PRINCIPAL_ID, MANAGER_ID],
  );
});

afterAll(async () => {
  if (handle !== undefined && available) {
    const p = handle.pool;
    await p.query('DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])', [
      [PRINCIPAL_ID, MANAGER_ID],
    ]);
    await p.query('DELETE FROM identity.team_memberships WHERE principal_id = ANY($1::uuid[])', [
      [PRINCIPAL_ID, MANAGER_ID],
    ]);
    await p.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [
      [PRINCIPAL_ID, MANAGER_ID, CUSTOMER_ID],
    ]);
    await p.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
  }
  await handle?.close().catch(() => undefined);
});

identityConformance({ describe, it, expect: expect as never }, async () => {
  if (handle === undefined) throw new Error('database unavailable');
  return {
    adapter: new LocalIamAdapter({ db: handle.db, verifySecret }),
    knownPrincipalId: PRINCIPAL_ID,
    validCredential: { username: 'conf.agent', secret: 'correct-horse' },
  };
});

const withDb = (name: string, fn: (h: DatabaseHandle) => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available || handle === undefined) {
      ctx.skip();
      return;
    }
    await fn(handle);
  });

describe('LocalIamAdapter specifics', () => {
  withDb('stamps every claim TEMPORARY_AUTHORITY', async (h) => {
    // Nothing may present the interim store as canonical employee truth (brief §48).
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const result = await adapter.resolvePrincipal(PRINCIPAL_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.authority).toBe('TEMPORARY_AUTHORITY');
    expect((await adapter.health()).authority).toBe('TEMPORARY_AUTHORITY');
  });

  withDb('omits an expired role assignment without any sweep having run', async (h) => {
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const result = await adapter.resolvePrincipal(PRINCIPAL_ID);
    if (!result.ok) throw new Error('resolve failed');
    const roles = result.value.roles.map((r) => r.role);
    expect(roles).toContain('COMPLIANCE');
    expect(roles).not.toContain('EXPIRED_ROLE');
  });

  withDb('resolves teams and the manager chain', async (h) => {
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const result = await adapter.resolvePrincipal(PRINCIPAL_ID);
    if (!result.ok) throw new Error('resolve failed');
    expect(result.value.teams.map((t) => t.teamId)).toContain(TEAM_ID);
    expect(result.value.managerChain).toEqual([MANAGER_ID]);
    expect(result.value.skills).toContain('claims');
  });

  withDb('derives privileged capabilities from roles, not from a settable column', async (h) => {
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const result = await adapter.resolvePrincipal(PRINCIPAL_ID);
    if (!result.ok) throw new Error('resolve failed');
    expect(result.value.privilegedCapabilities).toContain('audit.query');
  });

  withDb('refuses a customer principal through the employee identity path', async (h) => {
    // FR-CUST-1: a customer is a distinct kind, never an employee record with a flag.
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const result = await adapter.resolvePrincipal(CUSTOMER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failureClass).toBe('FAIL_CLOSED');
  });

  withDb('refuses authentication for a deactivated account, identically', async (h) => {
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    await h.pool.query('UPDATE identity.principals SET status = $1 WHERE principal_id = $2', [
      'EXITED',
      PRINCIPAL_ID,
    ]);
    try {
      const exited = await adapter.verifyCredential('conf.agent', 'correct-horse');
      const unknown = await adapter.verifyCredential('nobody.at.all', 'whatever');
      expect(exited.ok).toBe(false);
      // Same refusal shape: deactivation must not be discoverable by probing.
      if (!exited.ok && !unknown.ok) {
        expect(exited.error.code).toBe(unknown.error.code);
        expect(exited.error.message).toBe(unknown.error.message);
      }
    } finally {
      await h.pool.query('UPDATE identity.principals SET status = $1 WHERE principal_id = $2', [
        'ACTIVE',
        PRINCIPAL_ID,
      ]);
    }
  });

  withDb('revocation is effective on the next read', async (h) => {
    // FR-AUTH-2: effective on the next request, not at a cache expiry.
    const adapter = new LocalIamAdapter({ db: h.db, verifySecret });
    const before = await adapter.getSessionVersion(PRINCIPAL_ID);
    await adapter.revokeSessions(PRINCIPAL_ID, 'test');
    const after = await adapter.resolvePrincipal(PRINCIPAL_ID);
    if (!before.ok || !after.ok) throw new Error('unexpected failure');
    expect(after.value.sessionVersion).toBe(before.value + 1);
  });
});
