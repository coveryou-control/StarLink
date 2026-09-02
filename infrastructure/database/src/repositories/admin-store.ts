/**
 * Administration queries: deactivation and the inactive-owner invariant.
 *
 * Doc §32.3 names `conversations owned by an inactive principal` as a metric that must
 * read ZERO, and §32.4 makes any non-zero value the highest-priority alert: it is
 * unreachable customer work, and it is the case that silently loses customers (§21.9
 * case C). These queries are what make that measurable rather than aspirational.
 */
import type pg from 'pg';
import type { UUID } from '@starlink/shared-contracts';

export interface OwnedConversation {
  readonly caseId: UUID;
  readonly conversationId?: UUID;
  readonly state: string;
  readonly owningTeamId?: string;
  readonly customerRef?: string;
}

export interface DeactivationOutcome {
  readonly principalId: UUID;
  readonly alreadyInactive: boolean;
  /** Surfaced for reassignment — FR-EMP-3 requires deactivation to reveal every one. */
  readonly ownedOpenConversations: readonly OwnedConversation[];
}

/** States in which work is still live and therefore still needs an owner. */
const OPEN_STATES = ['NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'];

export class PgAdminStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Deactivates a principal and returns the work they were holding.
   *
   * One transaction, because the three effects must not diverge: the status change,
   * the session-version bump that revokes access on the next request (FR-AUTH-2), and
   * the snapshot of owned work. A deactivation that ended sessions but never surfaced
   * the conversations would leave exactly the silent orphan BR-13 forbids.
   *
   * Note what this does NOT do: reassign. Who takes the work is a routing decision
   * (Phase 5, and ultimately the CCS Work Orchestrator), not something an admin
   * endpoint should quietly decide.
   */
  async deactivate(principalId: UUID, _reason: string): Promise<DeactivationOutcome | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const current = await client.query(
        'SELECT status FROM identity.principals WHERE principal_id = $1 FOR UPDATE',
        [principalId],
      );
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const alreadyInactive = current.rows[0].status !== 'ACTIVE';

      await client.query(
        `UPDATE identity.principals
            SET status = 'EXITED',
                session_version = session_version + 1,
                effective_to = COALESCE(effective_to, now()),
                updated_at = now()
          WHERE principal_id = $1`,
        [principalId],
      );

      const owned = await client.query(
        `SELECT sc.case_id, sc.state, sc.owning_team_id, sc.customer_ref,
                (SELECT c.conversation_id FROM conversation.conversations c
                  WHERE c.case_id = sc.case_id
                  ORDER BY c.last_activity_at DESC LIMIT 1) AS conversation_id
           FROM conversation.service_cases sc
          WHERE sc.current_owner_id = $1
            AND sc.state = ANY($2::conversation.conversation_state[])
          ORDER BY sc.created_at`,
        [principalId, OPEN_STATES],
      );

      await client.query('COMMIT');

      return {
        principalId,
        alreadyInactive,
        ownedOpenConversations: owned.rows.map((row) => ({
          caseId: row.case_id,
          ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
          state: row.state,
          ...(row.owning_team_id !== null ? { owningTeamId: row.owning_team_id } : {}),
          ...(row.customer_ref !== null ? { customerRef: row.customer_ref } : {}),
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The invariant gauge. MUST be zero (§32.3).
   *
   * Exposed as a query rather than only as a metric so that an operator, a test and
   * the alert all read the same number from the same place.
   */
  async countInactiveOwnerConversations(): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS c
         FROM conversation.service_cases sc
         JOIN identity.principals p ON p.principal_id = sc.current_owner_id
        WHERE p.status <> 'ACTIVE'
          AND sc.state = ANY($1::conversation.conversation_state[])`,
      [OPEN_STATES],
    );
    return result.rows[0].c as number;
  }

  /**
   * Employee accounts, for the admin console.
   *
   * `kind = 'EMPLOYEE'` is a predicate in the query, not a filter applied afterwards —
   * the same rule the directory follows (§11.7). A customer must not be able to appear
   * in an administrative list by any route, and the safest way to guarantee that is for
   * the database never to return one.
   *
   * `credential_hash` is never selected. It has no administrative use, and a column
   * that is never read cannot be logged, serialised or leaked by a later change that
   * spreads the row.
   */
  async listAccounts(options: { search?: string; limit: number }): Promise<readonly AccountSummary[]> {
    const term = options.search?.trim() ?? '';
    const result = await this.pool.query(
      `SELECT principal_id, employee_id, username, display_name, status, department,
              session_version, authority, effective_from
         FROM identity.principals
        WHERE kind = 'EMPLOYEE'
          AND ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR employee_id ILIKE '%' || $1 || '%')
        ORDER BY display_name
        LIMIT $2`,
      [term, options.limit],
    );

    return result.rows.map((row) => ({
      principalId: row.principal_id,
      ...(row.employee_id !== null ? { employeeId: row.employee_id } : {}),
      ...(row.username !== null ? { username: row.username } : {}),
      displayName: row.display_name,
      status: row.status,
      ...(row.department !== null ? { department: row.department } : {}),
      sessionVersion: row.session_version,
      authority: row.authority,
      effectiveFrom: (row.effective_from as Date).toISOString(),
    }));
  }

  /** Live role×scope grants for one principal. Expired grants are excluded by the clock. */
  async listRoles(principalId: UUID, at: Date): Promise<readonly RoleGrantRecord[]> {
    const result = await this.pool.query(
      `SELECT assignment_id, role, scope_kind, scope_id, effective_from, effective_to, granted_by
         FROM identity.role_assignments
        WHERE principal_id = $1
          AND effective_from <= $2
          AND (effective_to IS NULL OR effective_to > $2)
        ORDER BY role, scope_kind`,
      [principalId, at],
    );

    return result.rows.map((row) => ({
      assignmentId: row.assignment_id,
      role: row.role,
      scopeKind: row.scope_kind,
      ...(row.scope_id !== null ? { scopeId: row.scope_id } : {}),
      effectiveFrom: (row.effective_from as Date).toISOString(),
      ...(row.effective_to !== null ? { effectiveTo: (row.effective_to as Date).toISOString() } : {}),
      grantedBy: row.granted_by,
    }));
  }

  /**
   * Grants a role, and bumps the holder's session version in the SAME transaction.
   *
   * The bump is the point. Claims are resolved at request time, but a live session
   * carries a version stamped at sign-in; without the bump, a newly granted role would
   * apply on some paths and not others depending on what each caches, and — far worse —
   * a *revocation* would leave the old privilege usable until the session expired.
   * Granting and revoking must behave identically here, so both bump.
   */
  async grantRole(input: {
    principalId: UUID;
    role: string;
    scopeKind: 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION';
    scopeId?: string;
    grantedBy: UUID;
    effectiveTo?: Date;
    assignmentId: UUID;
    at: Date;
  }): Promise<RoleGrantRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // A grant to a non-employee, or to nobody, is refused rather than created.
      const holder = await client.query(
        `SELECT kind FROM identity.principals WHERE principal_id = $1 FOR UPDATE`,
        [input.principalId],
      );
      if (holder.rowCount === 0 || holder.rows[0].kind !== 'EMPLOYEE') {
        await client.query('ROLLBACK');
        return undefined;
      }

      // A scoped grant with no scope is not a narrower grant — it is a GLOBAL one
      // wearing a scope's name. Refuse rather than silently widen (FR-AUTHZ-3's
      // posture: an unclear permission is denied, never treated as unrestricted).
      if (input.scopeKind !== 'GLOBAL' && (input.scopeId === undefined || input.scopeId === '')) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const inserted = await client.query(
        `INSERT INTO identity.role_assignments
           (assignment_id, principal_id, role, scope_kind, scope_id, effective_from, effective_to, granted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING assignment_id, role, scope_kind, scope_id, effective_from, effective_to, granted_by`,
        [
          input.assignmentId,
          input.principalId,
          input.role,
          input.scopeKind,
          input.scopeId ?? null,
          input.at,
          input.effectiveTo ?? null,
          input.grantedBy,
        ],
      );

      await client.query(
        `UPDATE identity.principals
            SET session_version = session_version + 1, updated_at = $2
          WHERE principal_id = $1`,
        [input.principalId, input.at],
      );

      await client.query('COMMIT');

      const row = inserted.rows[0];
      return {
        assignmentId: row.assignment_id,
        role: row.role,
        scopeKind: row.scope_kind,
        ...(row.scope_id !== null ? { scopeId: row.scope_id } : {}),
        effectiveFrom: (row.effective_from as Date).toISOString(),
        ...(row.effective_to !== null ? { effectiveTo: (row.effective_to as Date).toISOString() } : {}),
        grantedBy: row.granted_by,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revokes a grant by DATING IT, never by deleting the row.
   *
   * Deleting would erase the fact that the access ever existed, and "who could see this
   * last March" is exactly the question an audit asks (§17.3, and the same discipline as
   * BR-09's dated participation). Access ends immediately because `listRoles` and the
   * decision function both read effectiveness from the clock.
   */
  async revokeRole(assignmentId: UUID, at: Date): Promise<UUID | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const revoked = await client.query(
        `UPDATE identity.role_assignments
            SET effective_to = $2
          WHERE assignment_id = $1
            AND (effective_to IS NULL OR effective_to > $2)
          RETURNING principal_id`,
        [assignmentId, at],
      );
      if (revoked.rowCount === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const principalId = revoked.rows[0].principal_id as UUID;
      // Same bump as the grant path. A revocation that left a live session holding the
      // old privilege would be a revocation in name only.
      await client.query(
        `UPDATE identity.principals
            SET session_version = session_version + 1, updated_at = $2
          WHERE principal_id = $1`,
        [principalId, at],
      );

      await client.query('COMMIT');
      return principalId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface AccountSummary {
  readonly principalId: UUID;
  readonly employeeId?: string;
  readonly username?: string;
  readonly displayName: string;
  readonly status: string;
  readonly department?: string;
  readonly sessionVersion: number;
  readonly authority: string;
  readonly effectiveFrom: string;
}

export interface RoleGrantRecord {
  readonly assignmentId: UUID;
  readonly role: string;
  readonly scopeKind: string;
  readonly scopeId?: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly grantedBy: UUID;
}
