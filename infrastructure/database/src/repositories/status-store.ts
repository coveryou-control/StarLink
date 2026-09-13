import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

/**
 * What people say they are doing.
 *
 * ## Three different questions, kept apart
 *
 * - **Presence** — does this colleague hold a realtime lease. Inferred from a socket, and
 *   §21.9 forbids reading anything more into it ("a phone entering a lift is not leave").
 * - **Availability** — `identity.agent_states`, which routing reads and which decides who
 *   gets work.
 * - **This** — a sentence the person typed about themselves. Nothing infers it and nothing
 *   routes on it.
 *
 * They are shown together and never merged: somebody can be offline with "in a meeting"
 * set, and online with it too. Collapsing them loses the information the reader wants.
 *
 * ## Expiry needs no sweep
 *
 * An elapsed row reads as AVAILABLE, so nothing has to run for a status to lapse. The
 * comparison is against the application clock passed in, not the database's `now()` — the
 * same rule every other effective period in this codebase follows, and for the same reason
 * (this machine's clock has run a minute behind the managed database).
 */
export interface DeclaredStatusRow {
  readonly principalId: UUID;
  readonly status: string;
  readonly setAt: string;
  /** Absent for AVAILABLE, which is the absence of a claim and cannot go stale. */
  readonly clearsAt: string | undefined;
}

export class PgStatusStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Sets the caller's own status.
   *
   * `clearsAt` is computed by the caller from the server clock. It is required for
   * everything except AVAILABLE — the table has a CHECK saying so, because "the API always
   * sets it" is not a property, and a status that never lapses is the defect the expiry
   * exists to prevent.
   */
  async set(
    principalId: UUID,
    status: string,
    setAt: string,
    clearsAt: string | undefined,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity.declared_status (principal_id, status, set_at, clears_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_id) DO UPDATE
         SET status = EXCLUDED.status,
             set_at = EXCLUDED.set_at,
             clears_at = EXCLUDED.clears_at`,
      [principalId, status, setAt, clearsAt ?? null],
    );
  }

  /**
   * The live statuses among these principals.
   *
   * Only rows that are still true come back, and AVAILABLE is omitted entirely — it is the
   * default, so returning it would make every caller filter it out again. An id with no
   * row and an id whose status has lapsed are the same answer, which is what lets the
   * reader treat "absent" as "nothing to say".
   *
   * Capped by the caller. An unbounded id list is a query whose cost the caller chooses.
   */
  async forPrincipals(ids: readonly UUID[], now: string): Promise<readonly DeclaredStatusRow[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT principal_id, status, set_at, clears_at
         FROM identity.declared_status
        WHERE principal_id = ANY($1::uuid[])
          AND status <> 'AVAILABLE'
          AND (clears_at IS NULL OR clears_at > $2::timestamptz)`,
      [ids, now],
    );
    return result.rows.map((row) => ({
      principalId: row.principal_id as UUID,
      status: row.status as string,
      setAt: (row.set_at as Date).toISOString(),
      clearsAt: row.clears_at === null ? undefined : (row.clears_at as Date).toISOString(),
    }));
  }

  /** The caller's own, including AVAILABLE — a settings screen has to show the default. */
  async mine(principalId: UUID, now: string): Promise<DeclaredStatusRow> {
    const result = await this.pool.query(
      `SELECT principal_id, status, set_at, clears_at
         FROM identity.declared_status
        WHERE principal_id = $1`,
      [principalId],
    );
    const row = result.rows[0];
    const lapsed =
      row !== undefined && row.clears_at !== null && (row.clears_at as Date).toISOString() <= now;

    /* No row, or a lapsed one, is AVAILABLE. Reported rather than written back: the read
       path must not perform a write, and there is nothing to correct — an expired row IS
       available, by definition. */
    if (row === undefined || lapsed) {
      return {
        principalId,
        status: 'AVAILABLE',
        setAt: now,
        clearsAt: undefined,
      };
    }

    return {
      principalId,
      status: row.status as string,
      setAt: (row.set_at as Date).toISOString(),
      clearsAt: row.clears_at === null ? undefined : (row.clears_at as Date).toISOString(),
    };
  }
}
