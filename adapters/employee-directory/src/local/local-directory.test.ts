/**
 * Directory rules, against real PostgreSQL.
 *
 * The rule that matters most is negative: a customer principal must never appear in
 * the directory by any path (§11.7). It is tested here rather than assumed, because
 * the failure mode is silent — a customer row simply showing up in a colleague search.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { directoryConformance } from '@starlink/shared-contracts';
import { LocalEmployeeDirectory } from './local-directory.js';

const CONNECTION =
  process.env.SL_DATABASE_URL ?? 'postgres://starlink:starlink_dev_only@localhost:5432/starlink';

const SALES = '018f2c5a-dddd-7000-8000-00000000000a';
const CLAIMS = '018f2c5a-dddd-7000-8000-00000000000b';
const EXITED = '018f2c5a-dddd-7000-8000-00000000000c';
const CUSTOMER = '018f2c5a-dddd-7000-8000-00000000000f';
const TEAM_ID = 'directory-test-team';
const ALL = [SALES, CLAIMS, EXITED, CUSTOMER];

let pool: pg.Pool | undefined;
let directory: LocalEmployeeDirectory;
let available = false;

beforeAll(async () => {
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
    directory = new LocalEmployeeDirectory(probe);
  } catch {
    await probe.end().catch(() => undefined);
    console.warn('\n  ⚠ Directory tests SKIPPED: no PostgreSQL at SL_DATABASE_URL.\n');
    return;
  }

  await probe.query('DELETE FROM identity.team_memberships WHERE principal_id = ANY($1::uuid[])', [ALL]);
  await probe.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [ALL]);
  await probe.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);

  await probe.query('INSERT INTO identity.teams (team_id, display_name) VALUES ($1,$2)', [
    TEAM_ID,
    'Directory Team',
  ]);
  await probe.query(
    `INSERT INTO identity.principals (principal_id, kind, display_name, department, status) VALUES
       ($1,'EMPLOYEE','Zarina Directory-Sales','Sales','ACTIVE'),
       ($2,'EMPLOYEE','Zarina Directory-Claims','Claims','ACTIVE'),
       ($3,'EMPLOYEE','Zarina Directory-Gone','Sales','EXITED'),
       ($4,'CUSTOMER','Zarina Directory-Customer',NULL,'ACTIVE')`,
    [SALES, CLAIMS, EXITED, CUSTOMER],
  );
  await probe.query('INSERT INTO identity.team_memberships (team_id, principal_id) VALUES ($1,$2)', [
    TEAM_ID,
    SALES,
  ]);
  /**
   * One contact row, deliberately for SALES only.
   *
   * CLAIMS is left without one because that is the state the whole estate is in until
   * somebody populates it, and §17.2's operation has to behave correctly there — an empty
   * success, not an error. A fixture where everyone has an address would prove the easy
   * half and miss the half that is true today.
   */
  await probe.query(
    `INSERT INTO identity.principal_contacts (principal_id, channel, address)
     VALUES ($1,'EMAIL','zarina.sales@example.invalid')`,
    [SALES],
  );
});

afterAll(async () => {
  if (pool !== undefined && available) {
    await pool.query('DELETE FROM identity.principal_contacts WHERE principal_id = ANY($1::uuid[])', [ALL]);
    await pool.query('DELETE FROM identity.team_memberships WHERE principal_id = ANY($1::uuid[])', [ALL]);
    await pool.query('DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])', [ALL]);
    await pool.query('DELETE FROM identity.teams WHERE team_id = $1', [TEAM_ID]);
  }
  await pool?.end().catch(() => undefined);
});

const withDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    await fn();
  });

describe('the directory never discloses customers (§11.7)', () => {
  withDb('a customer with a matching name does not appear in search results', async () => {
    const result = await directory.searchDirectory('Zarina Directory', {
      requestedBy: SALES,
      visibility: 'COMPANY',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.items.map((i) => i.principalId);
    expect(ids).not.toContain(CUSTOMER);
    expect(ids).toContain(SALES);
  });

  withDb('a customer cannot be fetched by id through the directory', async () => {
    const result = await directory.getEmployee(CUSTOMER);
    expect(result.ok).toBe(false);
  });
});

describe('search behaviour', () => {
  withDb('refuses a very short term rather than returning everyone (FR-SRCH-5)', async () => {
    // An unbounded directory dump is the cheapest reconnaissance available, and also
    // the query that would quietly become a full scan.
    const result = await directory.searchDirectory('Z', { requestedBy: SALES, visibility: 'COMPANY' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('QUERY_TOO_SHORT');
  });

  withDb('excludes inactive employees', async () => {
    const result = await directory.searchDirectory('Zarina Directory', {
      requestedBy: SALES,
      visibility: 'COMPANY',
    });
    if (!result.ok) throw new Error('search failed');
    expect(result.value.items.map((i) => i.principalId)).not.toContain(EXITED);
  });

  withDb('applies department scope as a predicate, not a post-filter', async () => {
    const result = await directory.searchDirectory('Zarina Directory', {
      requestedBy: SALES,
      visibility: 'DEPARTMENT',
    });
    if (!result.ok) throw new Error('search failed');
    const ids = result.value.items.map((i) => i.principalId);
    expect(ids).toContain(SALES);
    // Claims is a different department, so it is never queried, not merely hidden.
    expect(ids).not.toContain(CLAIMS);
  });

  withDb('stamps results as TEMPORARY_AUTHORITY until HRMS arrives', async () => {
    const result = await directory.getEmployee(SALES);
    expect(result.ok && result.value.authority).toBe('TEMPORARY_AUTHORITY');
  });

  withDb('resolves team membership in the same round trip', async () => {
    const result = await directory.getEmployee(SALES);
    if (!result.ok) throw new Error('lookup failed');
    expect(result.value.teams.map((t) => t.teamId)).toContain(TEAM_ID);
  });

  withDb('lists active team members only', async () => {
    const result = await directory.listTeamMembers(TEAM_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });
});

describe('contact channels — §17.2’s fifth operation', () => {
  withDb('returns the stored address for a principal that has one', async () => {
    const result = await directory.resolveContactChannels(SALES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBe('zarina.sales@example.invalid');
    // TEMPORARY_AUTHORITY, not CANONICAL: HRMS is the system of record when it arrives
    // (A-13), and a caller must be able to tell a placeholder from the truth.
    expect(result.value.authority).toBe('TEMPORARY_AUTHORITY');
  });

  withDb('returns an empty record for a principal with no contact row', async () => {
    /**
     * The case the whole estate is in today. An error here would make every notification
     * to an unpopulated principal look like a broken directory rather than a missing
     * address, and §29.6 wants the second: "invalid address — row dead-lettered,
     * principal flagged for administrative attention."
     */
    const result = await directory.resolveContactChannels(CLAIMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBeUndefined();
  });

  withDb('refuses a CUSTOMER principal, like every other query here (§11.7)', async () => {
    /**
     * The negative that matters. Customer contact data has a different owner and a
     * different consent regime (D-31, Part IV §58); it must not become reachable through
     * the employee directory because a predicate was forgotten on one new method.
     */
    const result = await directory.resolveContactChannels(CUSTOMER);
    expect(result.ok).toBe(false);
  });

  withDb('refuses a principal that does not exist', async () => {
    const result = await directory.resolveContactChannels('018f2c5a-dddd-7000-8000-0000000000ff');
    expect(result.ok).toBe(false);
  });
});

/**
 * The same behavioural contract the HRMS adapter will have to satisfy at Phase 9.
 *
 * §17.2's promise is that "a second implementation satisfies the same interface and no
 * other component changes". That promise is only worth something if both implementations
 * are held to one suite — otherwise the second one satisfies the TYPES and diverges on
 * the behaviour that matters, which here is the difference between an unknown principal
 * and a known one with no address.
 */
directoryConformance({ describe, it, expect: expect as never }, async () => {
  if (!available) throw new Error('database unavailable');
  return {
    adapter: directory,
    knownPrincipalId: SALES as never,
    principalWithoutContacts: CLAIMS as never,
    unknownPrincipalId: '018f2c5a-dddd-7000-8000-0000000000fe' as never,
  };
});
