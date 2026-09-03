/**
 * Interim employee directory, backed by PostgreSQL.
 *
 * Like the IAM adapter, this stands in for HRMS behind the final interface and stamps
 * everything `TEMPORARY_AUTHORITY`. Two rules matter more than the queries:
 *
 *   * **A customer is never in the directory, by any path** (§11.7 — a customer cannot
 *     search or browse the employee directory). The `kind = 'EMPLOYEE'` predicate is in
 *     every query here, not applied by the caller.
 *   * **Directory visibility is configurable, default company-wide** (FR-EMP-5, D-11).
 *     The scope is applied in the query rather than by filtering results, so a narrower
 *     policy later is a change of predicate, not a change of call sites.
 */
import type pg from 'pg';
import type {
  ContactChannels,
  DirectoryScope,
  EmployeeDirectoryProvider,
  EmployeeDisplay,
  HealthReport,
  Page,
  Result,
  UUID,
} from '@starlink/shared-contracts';
import { err, likePattern, ok, SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';

const notFound = (): Result<never> =>
  err({
    code: 'PRINCIPAL_NOT_FOUND',
    message: 'no such principal',
    retryable: false,
    failureClass: 'FAIL_CLOSED',
    correlationId: 'local-directory',
  });

interface DirectoryRow {
  principal_id: string;
  display_name: string;
  department: string | null;
  status: string;
  teams: { teamId: string; displayName: string }[] | null;
  /* Nullable in the table and nullable here — see `toDisplay` for why absent and empty
     are kept apart. */
  employee_id: string | null;
  branch: string | null;
  timezone: string | null;
  reports_to: string | null;
}

const toDisplay = (row: DirectoryRow): EmployeeDisplay => ({
  principalId: row.principal_id,
  displayName: row.display_name,
  department: row.department ?? '',
  teams: row.teams ?? [],
  status: row.status as EmployeeDisplay['status'],
  authority: 'TEMPORARY_AUTHORITY',
  /*
     Absent rather than empty when the column is NULL.

     "The directory has no employee number for this person" and "their employee number is
     the empty string" are different facts, and the panel renders the row only for the
     second. Three of these four have been columns on `identity.principals` since the
     foundation migration and were never read by anything.
  */
  ...(row.employee_id != null ? { employeeId: row.employee_id } : {}),
  ...(row.reports_to != null ? { reportsTo: row.reports_to } : {}),
  ...(row.branch != null ? { location: row.branch } : {}),
  ...(row.timezone != null ? { timezone: row.timezone } : {}),
});

/** Teams are aggregated in SQL so the directory is one round trip, not one per person. */
const TEAMS_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('teamId', t.team_id, 'displayName', t.display_name))
      FROM identity.team_memberships tm
      JOIN identity.teams t ON t.team_id = tm.team_id
     WHERE tm.principal_id = p.principal_id
  ), '[]'::json) AS teams`;

export class LocalEmployeeDirectory implements EmployeeDirectoryProvider {
  constructor(private readonly pool: pg.Pool) {}

  async getEmployee(principalId: UUID): Promise<Result<EmployeeDisplay>> {
    const result = await this.pool.query(
      `SELECT p.principal_id, p.display_name, p.department, p.status,
         p.employee_id, p.branch, p.timezone,
         (SELECT m.display_name FROM identity.principals m WHERE m.principal_id = p.manager_id) AS reports_to, ${TEAMS_SUBQUERY}
         FROM identity.principals p
        WHERE p.principal_id = $1 AND p.kind = 'EMPLOYEE'`,
      [principalId],
    );
    const row = result.rows[0];
    return row === undefined ? notFound() : ok(toDisplay(row));
  }

  /**
   * Searches the directory.
   *
   * Short terms are refused rather than returning everyone (FR-SRCH-5) — an unbounded
   * directory dump is the cheapest possible reconnaissance, and it is also the query
   * that would quietly become a full scan.
   */
  async searchDirectory(
    query: string,
    scope: DirectoryScope,
    cursor?: string,
  ): Promise<Result<Page<EmployeeDisplay>>> {
    const term = query.trim();
    /*
       Empty is refused; one character is not.

       This was a floor of two, on the reasoning that a one-character search is a request
       for the entire staff list wearing a search's clothes. What actually bounds that is
       below and unchanged: the scope predicate, the ACTIVE-employee condition, and the page
       limit. A single letter returns one page of people this caller is already entitled to
       look up — the same thing two letters returns, only sooner. See
       `SEARCH_MINIMUM_TERM_LENGTH`.
    */
    if (term.length < SEARCH_MINIMUM_TERM_LENGTH) {
      return err({
        code: 'QUERY_TOO_SHORT',
        message: 'search term must not be empty',
        retryable: false,
        failureClass: 'FAIL_CLOSED',
        correlationId: 'local-directory',
      });
    }

    // Scope is a predicate, not a post-filter. An absent scope returns nothing rather
    // than everything (the §30.2 discipline, applied to the directory).
    /*
       Name, department, employee ID and branch — because that is what the field says.

       Three placeholders in the employee surface read "name or department" and this
       matched `display_name` alone, so typing "Operations" into a box that offers to
       search departments returned nobody. The results rendered the department on every
       row, one line under the field that could not find it.

       Employee ID and branch come along for the same reason: they are shown on the person
       and they are what somebody has in front of them when they are looking for a
       colleague they cannot name.

       `likePattern` rather than an interpolated `%${term}%`: unescaped, a search for a
       single `%` returned every active employee in the company.
    */
    const conditions = [
      `p.kind = 'EMPLOYEE'`,
      `p.status = 'ACTIVE'`,
      `(p.display_name ILIKE $1
        OR p.department ILIKE $1
        OR p.employee_id ILIKE $1
        OR p.branch ILIKE $1)`,
    ];
    const params: unknown[] = [likePattern(term)];

    if (scope.visibility === 'DEPARTMENT') {
      params.push(scope.requestedBy);
      conditions.push(
        `p.department IS NOT NULL AND p.department =
           (SELECT department FROM identity.principals WHERE principal_id = $${params.length})`,
      );
    } else if (scope.visibility === 'TEAM') {
      params.push(scope.requestedBy);
      conditions.push(
        `EXISTS (SELECT 1 FROM identity.team_memberships a
                   JOIN identity.team_memberships b ON b.team_id = a.team_id
                  WHERE a.principal_id = p.principal_id AND b.principal_id = $${params.length})`,
      );
    }

    if (cursor !== undefined) {
      params.push(cursor);
      // Keyset on display name; stable because the ordering is total with the id.
      conditions.push(`p.display_name > $${params.length}`);
    }

    const limit = 50;
    params.push(limit + 1);

    const result = await this.pool.query(
      `SELECT p.principal_id, p.display_name, p.department, p.status,
         p.employee_id, p.branch, p.timezone,
         (SELECT m.display_name FROM identity.principals m WHERE m.principal_id = p.manager_id) AS reports_to, ${TEAMS_SUBQUERY}
         FROM identity.principals p
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.display_name, p.principal_id
        LIMIT $${params.length}`,
      params,
    );

    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const last = rows[rows.length - 1];

    return ok({
      items: rows.map(toDisplay),
      ...(hasMore && last !== undefined ? { nextCursor: last.display_name as string } : {}),
    });
  }

  /**
   * Everyone, for an announcement's audience.
   *
   * Bounded rather than unbounded, and the bound is deliberate: a workspace with more
   * employees than this needs a broadcast that is not a participant row per person, and a
   * query that silently returned 50,000 rows would let that decision be deferred until the
   * day it fails. `LIMIT` + the check at the call site turns "too big for this design" into
   * an answer rather than a slow outage.
   */
  async listActiveEmployees(): Promise<Result<readonly EmployeeDisplay[]>> {
    const result = await this.pool.query(
      `SELECT p.principal_id, p.display_name, p.department, p.status,
         p.employee_id, p.branch, p.timezone,
         (SELECT m.display_name FROM identity.principals m WHERE m.principal_id = p.manager_id) AS reports_to, ${TEAMS_SUBQUERY}
         FROM identity.principals p
        WHERE p.kind = 'EMPLOYEE' AND p.status = 'ACTIVE'
        ORDER BY p.display_name, p.principal_id
        LIMIT 2000`,
      [],
    );
    return ok(result.rows.map(toDisplay));
  }

  async listTeamMembers(teamId: string): Promise<Result<readonly EmployeeDisplay[]>> {
    const result = await this.pool.query(
      `SELECT p.principal_id, p.display_name, p.department, p.status,
         p.employee_id, p.branch, p.timezone,
         (SELECT m.display_name FROM identity.principals m WHERE m.principal_id = p.manager_id) AS reports_to, ${TEAMS_SUBQUERY}
         FROM identity.principals p
         JOIN identity.team_memberships tm ON tm.principal_id = p.principal_id
        WHERE tm.team_id = $1 AND p.kind = 'EMPLOYEE' AND p.status = 'ACTIVE'
        ORDER BY p.display_name`,
      [teamId],
    );
    return ok(result.rows.map(toDisplay));
  }

  /**
   * §17.2's fifth operation, against StarLink's own store.
   *
   * The principal is checked first and separately from the contacts. The two absences
   * mean different things and must not collapse into one answer: an unknown principal is
   * an error, while a known principal with no contact row is a normal empty result that
   * the notification path is required to handle (§29.6). Returning "not found" for the
   * second would make an unpopulated directory look like a broken one.
   *
   * A customer is not reachable here, by the same `kind = 'EMPLOYEE'` predicate every
   * other query in this file carries (§11.7). Customer contact data is a different
   * question with a different owner, and it must not become answerable through the
   * employee directory by omission.
   */
  async resolveContactChannels(principalId: UUID): Promise<Result<ContactChannels>> {
    const principal = await this.pool.query(
      `SELECT 1 FROM identity.principals WHERE principal_id = $1 AND kind = 'EMPLOYEE'`,
      [principalId],
    );
    if (principal.rowCount === 0) return notFound();

    const contacts = await this.pool.query(
      `SELECT channel, address FROM identity.principal_contacts WHERE principal_id = $1`,
      [principalId],
    );

    const byChannel = new Map<string, string>(
      contacts.rows.map((row) => [row.channel as string, row.address as string]),
    );
    const email = byChannel.get('EMAIL');
    const mobile = byChannel.get('MOBILE');

    return ok({
      principalId,
      ...(email !== undefined ? { email } : {}),
      ...(mobile !== undefined ? { mobile } : {}),
      // TEMPORARY_AUTHORITY throughout this adapter: HRMS is the system of record when it
      // arrives (A-13), and a caller must be able to tell a placeholder from the truth.
      authority: 'TEMPORARY_AUTHORITY',
    });
  }

  async health(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      await this.pool.query('SELECT 1');
      return { status: 'UP', authority: 'TEMPORARY_AUTHORITY', checkedAt };
    } catch {
      return { status: 'DOWN', authority: 'TEMPORARY_AUTHORITY', checkedAt };
    }
  }
}
