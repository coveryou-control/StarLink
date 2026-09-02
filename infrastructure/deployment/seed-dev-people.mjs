/**
 * Development employee accounts, until HRMS arrives.
 *
 * ## Why this exists
 *
 * StarLink has no user authority of its own and is never going to have one (rule 11):
 * employees come from HRMS through the identity adapter, and `SL_ADAPTER_IAM=local` is the
 * placeholder standing in for it until that API is available. The placeholder reads
 * `identity.principals`, and until somebody puts rows there the product cannot be opened
 * by anybody at all — so signing in currently means borrowing an account the browser test
 * suite created for itself, which is both confusing and fragile (the suite resets its own
 * fixtures).
 *
 * This writes a small set of named accounts for the same purpose, deliberately separate
 * from the test fixtures so that running the suite cannot delete them and using them
 * cannot perturb the suite.
 *
 * ## These accounts are INTERIM, and say so
 *
 * INTEGRATION_CONTRACTS §1 rule 4: an interim identity source must never be mistakable for
 * a canonical one. Every row here is written with `authority = 'TEMPORARY_AUTHORITY'`,
 * which is what makes the directory render "· interim" beside the name. When HRMS lands it
 * becomes the authority, these rows are deleted, and nothing in the application changes —
 * that is the whole point of the adapter sitting behind the final interface.
 *
 * The passwords are printed to the terminal and committed in this file. That is correct
 * for a disposable local database and unacceptable anywhere else, which is why the script
 * refuses to run outside a development environment.
 *
 * ## Re-runnable
 *
 * Every statement is idempotent on a natural key, and the principal ids are fixed rather
 * than random so a second run updates the same rows. Specifically NOT `ON CONFLICT DO
 * NOTHING` against a generated primary key — that pattern never conflicts, and it is how
 * the browser suite's own seed accumulated 866 duplicate role grants per principal before
 * anybody noticed the requests getting slower.
 *
 * Usage:
 *   pnpm seed:people          # create or refresh the accounts
 *   pnpm seed:people --remove # delete them again
 */
import pg from 'pg';
import { hashPassword } from '@starlink/security';

const TEAM_ID = 'dev-internal';
const DEPARTMENT = 'Operations';

/**
 * The people, with fixed ids.
 *
 * UUIDv7-shaped and prefixed `de7` so they are recognisable as development rows at a
 * glance in a query result — there is no other marker on a principal that says where it
 * came from, and "which of these did the seed make" is a question somebody will ask.
 */
/**
 * The lead these three report to, which is the lead among them.
 *
 * `manager_id` is a real column and the information panel's "Reports to" reads it. Leaving
 * it NULL would leave that row permanently absent in development and so permanently
 * untested — and pointing the two agents at the account that is already their team's LEAD
 * is not an invented fact, it is the team role that is two fields above restated in the
 * column the directory reads.
 */
const LEAD_ID = '018f5eed-de70-7000-8000-000000000002';

/*
   `018f5eed-`, not `018f2c5a-`.

   These three used to share the test-fixture prefix, and
   `infrastructure/database/scripts/clean-test-residue.mjs` deletes every principal matching
   it — along with every conversation they created. So the tool for tidying up after an
   interrupted test run also deleted the accounts people sign in with and every thread they
   had, and nothing said it would: CLAUDE.md promises these are "separate from the browser
   suite's fixtures, so running the suite cannot delete them", which was true of the SUITE
   and not of the cleaner.

   A different prefix makes the promise structural rather than a matter of remembering. The
   cleaner also names them explicitly now, so both halves have to be wrong before this
   happens again.
*/

/*
   `branch` and `timezone` are DEVELOPMENT values, like the passwords beside them.

   They are here because a field that is never populated anywhere is a field nobody sees
   fail. HRMS is the system of record for both (rule 11) and these disappear with the rest
   of this fixture when it lands: `pnpm seed:people --remove`.
*/
const PEOPLE = [
  {
    principalId: '018f5eed-de70-7000-8000-000000000001',
    username: 'rishitt.gupta',
    password: 'starlink-dev-rishitt',
    displayName: 'Rishitt Gupta',
    employeeId: 'DEV-0001',
    branch: 'Gurugram',
    timezone: 'Asia/Kolkata',
    managerId: LEAD_ID,
    role: 'AGENT',
    teamRole: 'MEMBER',
  },
  {
    principalId: '018f5eed-de70-7000-8000-000000000002',
    username: 'archit.bali',
    password: 'starlink-dev-archit',
    displayName: 'Archit Bali',
    employeeId: 'DEV-0002',
    branch: 'Gurugram',
    timezone: 'Asia/Kolkata',
    /**
     * One lead, so the role ladder is exercised by more than one identical account.
     * TEAM_LEAD is additive here — the AGENT grant is kept as well, because a lead who
     * cannot read the directory or search cannot use Stage 1 at all.
     */
    role: 'TEAM_LEAD',
    alsoRole: 'AGENT',
    teamRole: 'LEAD',
  },
  {
    principalId: '018f5eed-de70-7000-8000-000000000003',
    username: 'rahul',
    password: 'starlink-dev-rahul',
    displayName: 'Rahul',
    employeeId: 'DEV-0003',
    branch: 'Mumbai',
    timezone: 'Asia/Kolkata',
    managerId: LEAD_ID,
    role: 'AGENT',
    teamRole: 'MEMBER',
  },
];

const remove = process.argv.includes('--remove');

const connectionString = process.env.SL_DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('SL_DATABASE_URL is not set. Point it at a development database and retry.');
  process.exit(1);
}

/**
 * Refuses anywhere that is not development.
 *
 * The passwords below are in version control. A guard that only warned would be a guard
 * that somebody overrides at 6pm; this one exits.
 */
const environment = process.env.SL_ENV ?? 'dev';
if (environment !== 'dev' && environment !== 'test' && environment !== 'local') {
  console.error(
    `Refusing to run: SL_ENV is "${environment}". These accounts have passwords committed to ` +
      'the repository and exist only for local development.',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 2 });

try {
  if (remove) {
    const ids = PEOPLE.map((p) => p.principalId);
    // Order matters: the grants and memberships reference the principal.
    await pool.query(`DELETE FROM identity.role_assignments WHERE principal_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM identity.team_memberships WHERE principal_id = ANY($1::uuid[])`, [ids]);
    /* And the reporting line, which points from one of these rows at another: the delete
       below is a single statement over the whole set, but the FK is checked per row, so a
       row still naming its manager blocks the manager's own removal. */
    await pool.query(
      `UPDATE identity.principals SET manager_id = NULL WHERE principal_id = ANY($1::uuid[])`,
      [ids],
    );
    await pool.query(`DELETE FROM identity.principals WHERE principal_id = ANY($1::uuid[])`, [ids]);
    console.log(`Removed ${PEOPLE.length} development accounts.`);
    process.exit(0);
  }

  await pool.query(
    `INSERT INTO identity.teams (team_id, display_name, department, authority)
     VALUES ($1, 'Internal (development)', $2, 'TEMPORARY_AUTHORITY')
     ON CONFLICT (team_id) DO NOTHING`,
    [TEAM_ID, DEPARTMENT],
  );

  for (const person of PEOPLE) {
    /**
     * Hashed with the application's own function, not a hand-rolled scrypt call.
     *
     * §27.12 fixes the encoded form — algorithm, cost parameters and per-credential salt,
     * all carried in the string — and a seed that produced a *nearly* correct hash would
     * fail at sign-in with an indistinguishable "wrong password", which is a miserable
     * thing to debug. Importing the real one means the format cannot drift.
     */
    const credentialHash = await hashPassword(person.password);

    await pool.query(
      `INSERT INTO identity.principals
         (principal_id, kind, employee_id, username, display_name, status, department,
          branch, timezone, credential_hash, authority, effective_from)
       VALUES ($1, 'EMPLOYEE', $2, $3, $4, 'ACTIVE', $5, $6, $7, $8,
               'TEMPORARY_AUTHORITY', now() - interval '1 day')
       ON CONFLICT (principal_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             department = EXCLUDED.department,
             branch = EXCLUDED.branch,
             timezone = EXCLUDED.timezone,
             status = 'ACTIVE',
             credential_hash = EXCLUDED.credential_hash,
             updated_at = now()`,
      [
        person.principalId,
        person.employeeId,
        person.username,
        person.displayName,
        DEPARTMENT,
        person.branch,
        person.timezone,
        credentialHash,
      ],
    );

    await pool.query(
      `INSERT INTO identity.team_memberships (team_id, principal_id, role)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [TEAM_ID, person.principalId, person.teamRole],
    );

    for (const role of [person.role, person.alsoRole].filter(Boolean)) {
      /**
       * Idempotent on the NATURAL key. See the file header: `ON CONFLICT DO NOTHING`
       * against a generated `assignment_id` never conflicts, and re-running this every
       * morning would quietly pile up grants that `decide()` loads on every request.
       */
      await pool.query(
        `INSERT INTO identity.role_assignments
           (assignment_id, principal_id, role, scope_kind, granted_by, effective_from)
         SELECT gen_random_uuid(), $1, $2, 'GLOBAL', $1, now() - interval '1 day'
          WHERE NOT EXISTS (
            SELECT 1 FROM identity.role_assignments
             WHERE principal_id = $1 AND role = $2 AND scope_kind = 'GLOBAL'
          )`,
        [person.principalId, role],
      );
    }
  }

  /**
   * Reporting lines, AFTER every row exists.
   *
   * `manager_id` references this same table, so the row it points at has to be there first —
   * and the first person in the list reports to the second. This was written inside the loop
   * above, which made it a "second statement" and not a second PASS: the first insert tried
   * to point at a lead who did not exist yet and the whole seed died on
   * `principals_manager_id_fkey`.
   *
   * Out here it is independent of the order the array happens to be written in, which is the
   * coupling the loop version claimed to avoid and did not.
   *
   * A lead reports to nobody, and that is left NULL: the panel draws no "Reports to" row
   * rather than inventing one.
   */
  for (const person of PEOPLE) {
    if (person.managerId === undefined) continue;
    await pool.query(
      `UPDATE identity.principals SET manager_id = $2, updated_at = now()
        WHERE principal_id = $1`,
      [person.principalId, person.managerId],
    );
  }

  /**
   * The effective clock, stated.
   *
   * Every row above is stamped `now() - interval '1 day'`. CLAUDE.md records why: this
   * machine's clock has run behind the managed database, and a participation or grant
   * stamped "now" can read as not-yet-effective to a `decide()` using the application
   * clock — which shows up as a 404 on your own conversation until the skew elapses. A
   * day of backdating removes the whole class of confusion from a seed.
   */
  console.log('\nDevelopment accounts ready. All are marked INTERIM until HRMS provides the real');
  console.log('directory — the employee surface shows "· interim" beside each name.\n');
  const width = Math.max(...PEOPLE.map((p) => p.username.length));
  for (const person of PEOPLE) {
    console.log(
      `  ${person.username.padEnd(width)}  ${person.password.padEnd(22)}  ${person.displayName} (${person.role})`,
    );
  }
  console.log('\nSign in at the employee surface with any of the above.');
  console.log('Remove them again with:  pnpm seed:people --remove\n');
} finally {
  await pool.end();
}
