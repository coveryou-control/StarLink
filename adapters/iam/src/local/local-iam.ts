/**
 * Interim identity adapter, backed by PostgreSQL.
 *
 * This is the "TEMPORARY PROVIDER behind the final production interface" the brief
 * calls for (§2, §8): StarLink needs employee identity before Central IAM exists, but
 * nothing outside this file may know that. Every claim it returns is stamped
 * `TEMPORARY_AUTHORITY` so no dashboard, export or incident review can mistake it for
 * canonical employee truth.
 *
 * When IAM arrives, `SL_ADAPTER_IAM=remote` swaps the implementation and nothing else
 * changes (INTEGRATION_CONTRACTS §12).
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '@starlink/database';
import { schema } from '@starlink/database';
import type {
  Delegation,
  HealthReport,
  IdentityAuthorizationClient,
  PrincipalClaims,
  PrincipalStatus,
  Result,
  RoleAssignment,
  Scope,
  ScopeKind,
  TeamRef,
  UUID,
} from '@starlink/shared-contracts';
import { err, ok } from '@starlink/shared-contracts';

/**
 * Identity is an authority: when it cannot answer, we refuse rather than assume
 * (brief §43 invariant 2). Every failure from this adapter is FAIL_CLOSED.
 */
const closed = (code: string, message: string, correlationId = 'local-iam'): Result<never> =>
  err({ code, message, retryable: false, failureClass: 'FAIL_CLOSED', correlationId });

/**
 * One uniform refusal for every authentication failure.
 *
 * Doc §27.1: distinguishing "wrong password" from "no such account" tells an attacker
 * which half they got right and tells a legitimate user nothing they can act on.
 */
const AUTH_REFUSED = () => closed('AUTH_FAILED', 'authentication failed');

export interface LocalIamOptions {
  readonly db: Database;
  /**
   * Verifies a presented secret against the stored hash.
   *
   * Injected rather than implemented here: doc §27.12 requires a memory-hard hash with
   * a per-credential salt, and which one is a security decision that should not be
   * buried in an interim adapter. Phase 2's composition root supplies it.
   */
  readonly verifySecret: (presented: string, storedHash: string) => Promise<boolean>;
}

export class LocalIamAdapter implements IdentityAuthorizationClient {
  constructor(private readonly options: LocalIamOptions) {}

  async resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>> {
    const { db } = this.options;

    const rows = await db
      .select()
      .from(schema.principals)
      .where(eq(schema.principals.principalId, principalId))
      .limit(1);

    const principal = rows[0];
    if (principal === undefined) return closed('PRINCIPAL_NOT_FOUND', 'no such principal');
    if (principal.kind !== 'EMPLOYEE') {
      // A customer principal must never resolve through the employee identity path.
      return closed('PRINCIPAL_NOT_EMPLOYEE', 'no such principal');
    }

    const [teams, roles, delegations, managerChain] = await Promise.all([
      this.loadTeams(principalId),
      this.loadRoles(principalId),
      this.loadDelegations(principalId),
      this.loadManagerChain(principalId),
    ]);

    return ok({
      principalId: principal.principalId,
      employeeId: principal.employeeId ?? '',
      status: principal.status as PrincipalStatus,
      displayName: principal.displayName,
      roles,
      teams,
      department: principal.department ?? '',
      ...(principal.branch !== null ? { branch: principal.branch } : {}),
      managerChain,
      skills: principal.skills,
      products: principal.products,
      languages: principal.languages,
      delegations,
      // Derived from roles rather than stored: a privileged capability that could be
      // set independently of a role assignment would be a grant with no audit trail.
      privilegedCapabilities: roles.flatMap((r) => PRIVILEGED_BY_ROLE[r.role] ?? []),
      effectiveFrom: principal.effectiveFrom.toISOString(),
      ...(principal.effectiveTo !== null ? { effectiveTo: principal.effectiveTo.toISOString() } : {}),
      authority: 'TEMPORARY_AUTHORITY',
      sessionVersion: principal.sessionVersion,
    });
  }

  async verifyCredential(username: string, secret: string): Promise<Result<{ principalId: UUID }>> {
    const { db, verifySecret } = this.options;

    /**
     * A work email is accepted, and matched on its local part.
     *
     * The sign-in screen asks for "Work email", which is what HRMS will authenticate on when
     * it arrives (rule 11 — the adapter is the final interface). This placeholder holds a
     * `username`, so `archit.bali@coveryou.co.in` would have been an account that does not
     * exist while `archit.bali` worked, and the label would have been a lie on the one screen
     * nobody can get past.
     *
     * Taking the local part makes both true rather than changing what is stored: a bare
     * username still signs in, and so does the same person's address. It is deliberately not
     * a domain check — this adapter has no business deciding which domains are the company's,
     * and the credential is what authenticates either way.
     */
    const at = username.indexOf('@');
    const identifier = at > 0 ? username.slice(0, at) : username;

    const rows = await db
      .select({
        principalId: schema.principals.principalId,
        credentialHash: schema.principals.credentialHash,
        status: schema.principals.status,
      })
      .from(schema.principals)
      .where(and(eq(schema.principals.username, identifier), eq(schema.principals.kind, 'EMPLOYEE')))
      .limit(1);

    const principal = rows[0];

    // Compare even when the account is unknown, against a dummy hash, so that the
    // response time does not disclose whether the username exists (§27.12 requires
    // the same timing characteristics for both cases).
    const hash = principal?.credentialHash ?? DUMMY_HASH;
    const matches = await verifySecret(secret, hash);

    if (principal === undefined || principal.credentialHash === null || !matches) return AUTH_REFUSED();
    // A deactivated account cannot authenticate, and is refused identically (FR-EMP-2).
    if (principal.status !== 'ACTIVE') return AUTH_REFUSED();

    return ok({ principalId: principal.principalId });
  }

  async getSessionVersion(principalId: UUID): Promise<Result<number>> {
    const rows = await this.options.db
      .select({ sessionVersion: schema.principals.sessionVersion })
      .from(schema.principals)
      .where(eq(schema.principals.principalId, principalId))
      .limit(1);

    const found = rows[0];
    if (found === undefined) return closed('PRINCIPAL_NOT_FOUND', 'no such principal');
    return ok(found.sessionVersion);
  }

  /**
   * Revocation is a version bump.
   *
   * FR-AUTH-2 requires it to be effective on the NEXT request, not at a cache expiry.
   * Because every request re-reads the version, incrementing it invalidates every
   * outstanding session for this principal atomically, including live sockets once the
   * gateway re-checks.
   */
  async revokeSessions(principalId: UUID, _reason: string): Promise<Result<void>> {
    const updated = await this.options.db
      .update(schema.principals)
      .set({ sessionVersion: sql`${schema.principals.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(schema.principals.principalId, principalId))
      .returning({ principalId: schema.principals.principalId });

    if (updated.length === 0) return closed('PRINCIPAL_NOT_FOUND', 'no such principal');
    return ok(undefined);
  }

  async health(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      await this.options.db.execute(sql`SELECT 1`);
      return { status: 'UP', authority: 'TEMPORARY_AUTHORITY', checkedAt };
    } catch {
      return {
        status: 'DOWN',
        authority: 'TEMPORARY_AUTHORITY',
        checkedAt,
        detail: 'identity store unreachable',
      };
    }
  }

  /* ------------------------------------------------------------------ loaders */

  private async loadTeams(principalId: UUID): Promise<TeamRef[]> {
    const rows = await this.options.db
      .select({ teamId: schema.teams.teamId, displayName: schema.teams.displayName })
      .from(schema.teamMemberships)
      .innerJoin(schema.teams, eq(schema.teams.teamId, schema.teamMemberships.teamId))
      .where(eq(schema.teamMemberships.principalId, principalId));
    return rows;
  }

  private async loadRoles(principalId: UUID): Promise<RoleAssignment[]> {
    const now = new Date();
    const rows = await this.options.db
      .select()
      .from(schema.roleAssignments)
      .where(
        and(
          eq(schema.roleAssignments.principalId, principalId),
          // Expiry is read from the clock, so no sweep job's failure can silently
          // extend someone's access (doc §17.3).
          or(isNull(schema.roleAssignments.effectiveTo), sql`${schema.roleAssignments.effectiveTo} > ${now}`),
          /**
           * And the START of the period, which was missing.
           *
           * Only `effectiveTo` was filtered, so a role dated to begin in the future was
           * returned as a grant held TODAY. A planned move into Claims next quarter, or a
           * pre-dated assignment entered by an administrator, therefore counted immediately
           * — and it counted for `passesSensitivity`, which is the gate on restricted
           * medical, legal and grievance detail.
           *
           * A period has two ends. Reading one of them is not reading the period.
           */
          sql`${schema.roleAssignments.effectiveFrom} <= ${now}`,
        ),
      );

    return rows.map((row) => ({
      role: row.role,
      scope: buildScope(row.scopeKind as ScopeKind, row.scopeId),
      effectiveFrom: row.effectiveFrom.toISOString(),
      ...(row.effectiveTo !== null ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
      grantedBy: row.grantedBy,
    }));
  }

  private async loadDelegations(principalId: UUID): Promise<Delegation[]> {
    const now = new Date();
    const rows = await this.options.db
      .select()
      .from(schema.delegations)
      .where(
        and(
          eq(schema.delegations.toPrincipal, principalId),
          isNull(schema.delegations.revokedAt),
          sql`${schema.delegations.effectiveTo} > ${now}`,
        ),
      );

    return rows.map((row) => ({
      delegationId: row.delegationId,
      fromPrincipal: row.fromPrincipal,
      toPrincipal: row.toPrincipal,
      capabilities: row.capabilities,
      scope: buildScope(row.scopeKind as ScopeKind, row.scopeId),
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo.toISOString(),
      reason: row.reason,
    }));
  }

  /**
   * Walks the manager edge, nearest first.
   *
   * Bounded explicitly: a cycle in the reporting line is a data defect, not a reason
   * to hang a request.
   */
  private async loadManagerChain(principalId: UUID): Promise<UUID[]> {
    const chain: UUID[] = [];
    const seen = new Set<UUID>([principalId]);
    let current = principalId;

    for (let depth = 0; depth < MAX_MANAGER_DEPTH; depth += 1) {
      const rows = await this.options.db
        .select({ managerId: schema.principals.managerId })
        .from(schema.principals)
        .where(eq(schema.principals.principalId, current))
        .limit(1);

      const managerId = rows[0]?.managerId;
      if (managerId === null || managerId === undefined || seen.has(managerId)) break;
      chain.push(managerId);
      seen.add(managerId);
      current = managerId;
    }
    return chain;
  }
}

const MAX_MANAGER_DEPTH = 12;

const buildScope = (kind: ScopeKind, id: string | null): Scope =>
  id === null ? { kind } : { kind, id };

/**
 * Which roles carry privileged capabilities.
 *
 * Deliberately a small, reviewable table rather than a database column: this is the
 * set that grants access beyond ordinary participation, and it should be visible in
 * code review. Note that no role here implies unrestricted PII access — Super Admin is
 * absent by design (brief §9).
 */
const PRIVILEGED_BY_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  COMPLIANCE: ['audit.query', 'privileged.customer.history.read'],
  LEGAL: ['audit.query', 'privileged.customer.history.read'],
  GRIEVANCE: ['privileged.customer.history.read'],
});

/**
 * A structurally valid hash that no secret matches, used so that an unknown username
 * costs the same work as a known one.
 */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
