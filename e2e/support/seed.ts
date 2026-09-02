/**
 * Fixtures for the browser suite.
 *
 * Two employees on one team: an AGENT (who takes work) and a TEAM_LEAD (who resolves
 * work they do not own — BR-19). Both are real rows with real credential hashes, because
 * every sign-in in this suite goes through the real form.
 *
 * The calendar is deliberately CLOSED (`working_windows: []`). §23.3 queues an
 * after-hours arrival rather than assigning it, which is what puts a row in the queue for
 * the agent to claim through the UI. With an open calendar and a free agent the router
 * assigns directly and there is nothing for the browser to take — a legitimate path, but
 * not the one SL-006 asks to be visible.
 */
import pg from 'pg';
import { hashPassword } from '@starlink/security';
// The subpath, not the barrel: the package index re-exports a namespace
// (`export * as schema`), which Playwright's CommonJS transform cannot lower.
import { resetTeamFixtures } from '@starlink/database/testing';

import { CATEGORY_ID, CONNECTION, CREDENTIALS, IDS, TEAM_ID } from './env.js';

export async function connect(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: CONNECTION, connectionTimeoutMillis: 15_000, max: 6 });
  await pool.query('SELECT 1');
  return pool;
}

export async function seed(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO identity.teams (team_id, display_name, department)
     VALUES ($1,'E2E Browser Team','Service') ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID],
  );
  await pool.query(
    `INSERT INTO conversation.categories
       (category_id, display_name, owning_team_id, active, is_seed_placeholder)
     VALUES ($1,'Browser Topic',$2,true,true)
     ON CONFLICT (category_id) DO UPDATE SET owning_team_id = EXCLUDED.owning_team_id`,
    [CATEGORY_ID, TEAM_ID],
  );
  await pool.query(
    `INSERT INTO identity.principals
       (principal_id, kind, username, display_name, department, credential_hash, status)
     VALUES ($1,'EMPLOYEE',$4,'E2E Agent','Service',$7,'ACTIVE'),
            ($2,'EMPLOYEE',$5,'E2E Lead','Service',$8,'ACTIVE'),
            ($3,'EMPLOYEE',$6,'E2E Colleague','Service',$9,'ACTIVE')
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'ACTIVE', credential_hash = EXCLUDED.credential_hash`,
    [
      IDS.agent,
      IDS.lead,
      IDS.colleague,
      CREDENTIALS.agent.username,
      CREDENTIALS.lead.username,
      CREDENTIALS.colleague.username,
      await hashPassword(CREDENTIALS.agent.password),
      await hashPassword(CREDENTIALS.lead.password),
      await hashPassword(CREDENTIALS.colleague.password),
    ],
  );

  for (const [principal, role] of [
    [IDS.agent, 'AGENT'],
    [IDS.lead, 'TEAM_LEAD'],
    [IDS.colleague, 'AGENT'],
  ] as const) {
    await pool.query(
      `INSERT INTO identity.team_memberships (team_id, principal_id, role)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [TEAM_ID, principal, role === 'TEAM_LEAD' ? 'LEAD' : 'MEMBER'],
    );
    /**
     * Idempotent on the NATURAL key, not on the surrogate one.
     *
     * This was `ON CONFLICT DO NOTHING` against a freshly generated `assignment_id`, so
     * there was never a conflict to do nothing about: every run of the browser suite
     * inserted another identical GLOBAL grant. By 2026-08-31 the seeded agent had 866 of
     * them and the two other fixtures had 847 apiece.
     *
     * That is not merely untidy. `decide()` loads a principal's role grants on every
     * authorized request, so each run made every request in the suite slower than the
     * last — the wall clock went 2.2 to 3.4 to 4.5 minutes over three runs with no code
     * change between them, and the realtime reconnect test, which has a 30-second budget,
     * started failing at a different step each time. A fixture that degrades the system
     * it is testing produces exactly this: a suite that is not flaky so much as slowly
     * poisoned.
     *
     * `WHERE NOT EXISTS` rather than a unique constraint because the table legitimately
     * allows several grants of one role at different scopes; only this GLOBAL seed pair
     * needs to be at-most-once.
     */
    await pool.query(
      `INSERT INTO identity.role_assignments
         (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
       SELECT $1,$2,$3,'GLOBAL',$2, now() - interval '1 day'
        WHERE NOT EXISTS (
          SELECT 1 FROM identity.role_assignments
           WHERE principal_id = $2 AND role = $3 AND scope_kind = 'GLOBAL'
        )`,
      [crypto.randomUUID(), principal, role],
    );
  }

  await pool.query(
    `INSERT INTO conversation.business_calendars
       (calendar_id, team_id, timezone, version, effective_from, working_windows,
        holidays, exceptions, is_seed_placeholder)
     VALUES ($1,$2,'Asia/Kolkata',1, now() - interval '1 day', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, true)
     ON CONFLICT (calendar_id) DO UPDATE SET working_windows = '[]'::jsonb`,
    [IDS.calendar, TEAM_ID],
  );
}

/**
 * Cleans by TEAM, which is the only handle that survives a browser run dying mid-test.
 * Shared with the integration suites so there is one description of what a fixture owns.
 */
export async function cleanup(pool: pg.Pool): Promise<void> {
  await resetTeamFixtures(pool, TEAM_ID);
}
