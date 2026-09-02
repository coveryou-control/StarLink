/**
 * Employee identity and authorization contracts (brief §8, ADR-008).
 *
 * StarLink is an authorization CONSUMER. These interfaces are the production shape;
 * the Phase-2 local implementation and the Phase-9 Central IAM implementation satisfy
 * exactly this contract, which is what makes the cutover a configuration change
 * (INTEGRATION_CONTRACTS §12).
 */
import type { Timestamp, UUID } from '../domain/primitives.js';
import type { HealthReporting, Result } from './result.js';
import type { Page } from '../domain/primitives.js';

export type PrincipalStatus = 'ACTIVE' | 'SUSPENDED' | 'EXITED';

/** Where a role applies. Department membership alone grants nothing (BR-29). */
export type ScopeKind = 'GLOBAL' | 'DEPARTMENT' | 'TEAM' | 'CONVERSATION';

export interface Scope {
  readonly kind: ScopeKind;
  readonly id?: string;
}

export interface RoleAssignment {
  readonly role: string;
  readonly scope: Scope;
  readonly effectiveFrom: Timestamp;
  /** Expiry is read from the clock, never from a sweep job having run (doc §17.3). */
  readonly effectiveTo?: Timestamp;
  readonly grantedBy: UUID;
}

export interface Delegation {
  readonly delegationId: UUID;
  readonly fromPrincipal: UUID;
  readonly toPrincipal: UUID;
  readonly capabilities: readonly string[];
  readonly scope: Scope;
  readonly effectiveFrom: Timestamp;
  /** Mandatory: an unbounded delegation is a permanent grant wearing a temporary name. */
  readonly effectiveTo: Timestamp;
  readonly reason: string;
}

export interface TeamRef {
  readonly teamId: string;
  readonly displayName: string;
}

/**
 * The full claim set StarLink needs to make a contextual authorization decision
 * (brief §8). Every field here is eventually HRMS/IAM-sourced.
 */
export interface PrincipalClaims {
  readonly principalId: UUID;
  readonly employeeId: string;
  readonly status: PrincipalStatus;
  readonly displayName: string;
  readonly roles: readonly RoleAssignment[];
  readonly teams: readonly TeamRef[];
  readonly department: string;
  readonly branch?: string;
  /** Reporting hierarchy, nearest manager first. Absent attributes are absent, never blank. */
  readonly managerChain: readonly UUID[];
  readonly skills: readonly string[];
  readonly products: readonly string[];
  readonly languages: readonly string[];
  readonly delegations: readonly Delegation[];
  readonly privilegedCapabilities: readonly string[];
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo?: Timestamp;
  readonly authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY';
  /** Bumped to revoke. Checked on every request and every socket message (ADR-008). */
  readonly sessionVersion: number;
}

export interface IdentityAuthorizationClient extends HealthReporting {
  resolvePrincipal(principalId: UUID): Promise<Result<PrincipalClaims>>;
  /** Local/interim only; the Remote implementation delegates to IAM/SSO. */
  verifyCredential(username: string, secret: string): Promise<Result<{ principalId: UUID }>>;
  getSessionVersion(principalId: UUID): Promise<Result<number>>;
  /**
   * Revocation must be effective on the NEXT request, not at a cache expiry
   * (FR-AUTH-2). Implementations bump the version and emit the control event that
   * causes the realtime gateway to close the principal's sockets.
   */
  revokeSessions(principalId: UUID, reason: string): Promise<Result<void>>;
}

export interface EmployeeDisplay {
  readonly principalId: UUID;
  readonly displayName: string;
  readonly department: string;
  readonly teams: readonly TeamRef[];
  readonly status: PrincipalStatus;
  readonly authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY';

  /**
   * What the employee panel shows about a colleague.
   *
   * Every one of these is OPTIONAL, and that is the contract rather than an oversight: this
   * interface is what HRMS will implement (rule 11 — the adapter is the final interface,
   * the local implementation is the placeholder), and a directory that does not carry a
   * field must be able to say so. The panel renders a row only when its value arrives, so a
   * sparse directory produces a shorter list and never a blank or a guess.
   *
   * `reportsTo` is a NAME, not an id. The panel shows a person, and resolving an id to a
   * name in the client would mean a second directory request per row — for a string the
   * directory already had.
   *
   * `timezone` is an IANA zone. The local time is computed from it where it is shown, so
   * nothing has to be recomputed on a clock tick server-side, and an offset — wrong twice
   * a year — is never stored.
   */
  readonly employeeId?: string;
  readonly reportsTo?: string;
  readonly location?: string;
  readonly timezone?: string;
}

export interface DirectoryScope {
  readonly requestedBy: UUID;
  readonly visibility: 'COMPANY' | 'DEPARTMENT' | 'TEAM';
}

/**
 * Where a principal can be reached (§17.2's "contact channels").
 *
 * Every field is optional and an absent one means "not held", never "none" — §17.2's
 * companion rule for organisational attributes is "absent attributes are absent, never
 * blank", and the same applies here. A caller that needs an address must handle its
 * absence; it must not treat an empty string as one.
 */
export interface ContactChannels {
  readonly principalId: UUID;
  readonly email?: string;
  readonly mobile?: string;
  /**
   * Which system supplied this. `TEMPORARY_AUTHORITY` while StarLink's own store answers
   * (§17.2: "V1 implements this against StarLink's own store"); `CANONICAL` once HRMS
   * does (A-13). A caller can therefore tell a placeholder from a system of record
   * without knowing which adapter is wired.
   */
  readonly authority: 'CANONICAL' | 'TEMPORARY_AUTHORITY';
}

export interface EmployeeDirectoryProvider extends HealthReporting {
  getEmployee(principalId: UUID): Promise<Result<EmployeeDisplay>>;
  searchDirectory(query: string, scope: DirectoryScope, cursor?: string): Promise<Result<Page<EmployeeDisplay>>>;
  listTeamMembers(teamId: string): Promise<Result<readonly EmployeeDisplay[]>>;
  /**
   * Every active employee — the audience of an announcement, and nothing else.
   *
   * ## Why this is not `searchDirectory` with an empty term
   *
   * Because that is refused on purpose. FR-SRCH-5 declines a short search term precisely so
   * the directory cannot be dumped, and quietly widening it would remove that protection
   * for every caller in order to serve one.
   *
   * This asks a different question. It is not "who is in the company, show me" — the result
   * never reaches a browser — it is "who must receive this", answered server-side and used
   * only to write participant rows. An announcement's audience is everyone by definition;
   * an announcement to a hand-picked list is a group.
   *
   * ACTIVE only. A deactivated account is not an audience, and giving one a participant row
   * would put a departed colleague into the membership of every announcement made after they
   * left.
   */
  listActiveEmployees(): Promise<Result<readonly EmployeeDisplay[]>>;
  /**
   * §17.2's fifth operation: **"resolve contact channels"**.
   *
   * A separate operation rather than fields on {@link EmployeeDisplay}, and the
   * distinction is deliberate. `searchDirectory` is used by ordinary directory browsing;
   * putting addresses on its result would hand every employee's email to every search,
   * for a feature that needs it in one place. Part IV §58 makes the same argument for
   * customer contact data — "raw mobile/email/PII exposure is separate capability,
   * purpose-bound" — and the shape of it holds for staff.
   *
   * Returning a record with no addresses is a NORMAL result, not an error: nobody has
   * populated the store yet, and the notification path is required to cope (§29.6 —
   * "permanent failure (invalid address) — row dead-lettered, principal flagged for
   * administrative attention"). An implementation must not error merely because a
   * principal has no contact row.
   */
  resolveContactChannels(principalId: UUID): Promise<Result<ContactChannels>>;
}

export interface HierarchyScope {
  readonly principalId: UUID;
  readonly teams: readonly string[];
  readonly departments: readonly string[];
  readonly branches: readonly string[];
  readonly reports: readonly UUID[];
}

export interface HierarchyScopeProvider extends HealthReporting {
  resolveScope(principalId: UUID): Promise<Result<HierarchyScope>>;
  isWithinScope(actor: UUID, subject: UUID): Promise<Result<boolean>>;
}

export interface DelegationRequest {
  readonly fromPrincipal: UUID;
  readonly toPrincipal: UUID;
  readonly capabilities: readonly string[];
  readonly scope: Scope;
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo: Timestamp;
  readonly reason: string;
  readonly grantedBy: UUID;
}

export interface DelegationProvider extends HealthReporting {
  activeDelegations(principalId: UUID): Promise<Result<readonly Delegation[]>>;
  grant(request: DelegationRequest): Promise<Result<Delegation>>;
  revoke(delegationId: UUID, reason: string): Promise<Result<void>>;
}
