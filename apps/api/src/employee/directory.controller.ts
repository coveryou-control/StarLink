/**
 * Colleague directory (FR-DIR-*, doc §11.7, §30.2).
 *
 * The adapter behind this has been in the tree since Phase 2 and was never exposed —
 * which is worth saying out loud, because "the directory is built" was true of the
 * adapter and false of the product.
 *
 * Three properties, all enforced below the controller rather than here:
 *
 *   * **Scope before query.** The visibility scope is passed INTO the adapter and
 *     becomes a predicate in the SQL. Fetching everyone and filtering afterwards would
 *     mean the whole company crossed the wire before being narrowed (§30.2).
 *   * **A customer is never in the directory.** `kind = 'EMPLOYEE'` is a predicate in
 *     every directory query, so there is no path — search term, id lookup, or team
 *     listing — by which a customer surfaces (§11.7).
 *   * **Short terms are refused.** A one-character search is a request for the entire
 *     staff list wearing a search's clothes (FR-SRCH-5).
 *
 * Directory search is deliberately NOT audited with its term. Auditing who looked up a
 * colleague's name is surveillance rather than accountability (P-06) — unlike MESSAGE
 * search, which is audited with the term precisely because it reaches content.
 */
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { EmployeeDirectoryProvider, IdentityAuthorizationClient, Timestamp } from '@starlink/shared-contracts';
import type { Logger } from '@starlink/observability';
import { holdsAction, toActorContext } from '@starlink/conversation-domain';
import { EMPLOYEE_DIRECTORY, IDENTITY_CLIENT, LOGGER } from '../tokens.js';
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';

import { refuse, RequireSurface, type AuthenticatedRequest } from '../edge/session.guard.js';

const searchSchema = z.object({
  // Two characters is the floor the adapter enforces; stating it here as well means a
  // short term is a clean 404 rather than an adapter-level refusal shaped differently.
  q: z.string().min(SEARCH_MINIMUM_TERM_LENGTH).max(100),
  visibility: z.enum(['COMPANY', 'DEPARTMENT', 'TEAM']).default('COMPANY'),
  cursor: z.string().min(1).optional(),
});

@Controller('v1/employee/directory')
@RequireSurface('EMPLOYEE')
export class EmployeeDirectoryController {
  constructor(
    @Inject(EMPLOYEE_DIRECTORY) private readonly directory: EmployeeDirectoryProvider,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityAuthorizationClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Layer 2, and until now there was no layer at all.
   *
   * Both routes below were reachable by ANY authenticated employee — including one holding
   * no roles whatsoever — because `@RequireSurface('EMPLOYEE')` authenticates and does not
   * authorize. `'directory.read'` was declared in the action vocabulary and granted to
   * AGENT and TEAM_LEAD, and was evaluated nowhere in the product: a permission that
   * existed only as documentation, on the route that returns the entire staff list.
   *
   * There is no conversation here, so this is a capability check rather than an object
   * check, and it says so. See `holdsAction`.
   */
  private async mayReadDirectory(principalId: string): Promise<boolean> {
    const claims = await this.identity.resolvePrincipal(principalId);
    if (!claims.ok) return false;
    return holdsAction(
      toActorContext(claims.value),
      'directory.read',
      new Date().toISOString() as Timestamp,
    );
  }

  @Get()
  async search(@Query() query: unknown, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const parsed = searchSchema.safeParse(query);
    if (!parsed.success) return refuse();

    const session = request.session!;
    if (!(await this.mayReadDirectory(session.principalId))) return refuse();
    const result = await this.directory.searchDirectory(
      parsed.data.q,
      // `requestedBy` comes from the verified session, never from the request: a caller
      // must not be able to search as someone with a wider scope than their own.
      { requestedBy: session.principalId, visibility: parsed.data.visibility },
      parsed.data.cursor,
    );

    if (!result.ok) {
      this.logger.info('directory search refused', {
        correlationId: request.correlationId,
        principalId: session.principalId,
        operation: 'directory.search',
        outcome: 'REFUSED',
        errorCode: result.error.code,
      });
      return refuse();
    }

    return {
      entries: result.value.items.map(toEntry),
      ...(result.value.nextCursor !== undefined ? { nextCursor: result.value.nextCursor } : {}),
    };
  }

  /**
   * The colleagues on the caller's own teams.
   *
   * ## Why this exists beside `search`
   *
   * People opened as an empty box: nothing was listed until you typed two characters, so
   * the answer to "who can I message" was "somebody you can already name". That is a poor
   * directory and it is not what FR-SRCH-5 was protecting against — that rule refuses a
   * one-character SEARCH because it is a request for the whole staff list. This is not a
   * search. It is the membership of the teams the caller is already in, which the session
   * already carries.
   *
   * ## Why the teams come from the session and not from a parameter
   *
   * A `teamId` in the path would let any employee list any team by guessing an id. The
   * teams are read from the caller's own resolved claims, so the scope is not a thing the
   * caller can widen — the same reason `listForPrincipal` joins participation rather than
   * filtering after the fact (§30.2).
   *
   * The caller is excluded, and so is anybody the adapter reports twice: somebody on two
   * of your teams is one colleague.
   */
  @Get('colleagues')
  async colleagues(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const session = request.session!;
    // The same guard the search route uses; a second implementation of "may this person
    // read the directory" is a second thing to keep in step.
    if (!(await this.mayReadDirectory(session.principalId))) return refuse();

    const claims = await this.identity.resolvePrincipal(session.principalId);
    if (!claims.ok) return refuse();

    const seen = new Map<string, { readonly displayName: string; readonly entry: Record<string, unknown> }>();
    for (const team of claims.value.teams) {
      const members = await this.directory.listTeamMembers(team.teamId);
      /**
       * A team that cannot be listed is skipped, not fatal. The directory is an adapter
       * behind an interim provider (rule 11), and one unavailable team must not turn the
       * whole People pane into an error when the other three answered.
       */
      if (!members.ok) continue;
      for (const member of members.value) {
        if (member.principalId === session.principalId) continue;
        if (seen.has(member.principalId)) continue;
        seen.set(member.principalId, { displayName: member.displayName, entry: toEntry(member) });
      }
    }

    // Sorted by name, because an unordered list of colleagues re-orders itself between
    // two loads for no reason a reader can see.
    return {
      entries: [...seen.values()]
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((row) => row.entry),
    };
  }

  @Get(':principalId')
  async getOne(
    @Param('principalId') principalIdRaw: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    const principalId = z.string().uuid().safeParse(principalIdRaw);
    if (!principalId.success) return refuse();

    // Before the lookup, not after: a refusal that arrived only once the record had been
    // fetched would still distinguish "exists" from "does not" by timing (§27.3).
    const session = request.session!;
    if (!(await this.mayReadDirectory(session.principalId))) return refuse();

    const result = await this.directory.getEmployee(principalId.data);
    // Absent, inactive and not-an-employee all render identically: a lookup that
    // distinguished them would confirm the existence of a customer by their id.
    if (!result.ok) return refuse();

    return { employee: toEntry(result.value) };
  }
}

/**
 * The directory projection.
 *
 * Named fields only. The adapter's record is close to what a customer-facing leak would
 * look like if this ever grew a customer surface, and an allow-list is what stops a
 * later column arriving here by default.
 */
function toEntry(employee: {
  principalId: string;
  displayName: string;
  department: string;
  teams: readonly { teamId: string; displayName: string }[];
  status: string;
  authority: string;
  employeeId?: string;
  reportsTo?: string;
  location?: string;
  timezone?: string;
}): Record<string, unknown> {
  return {
    principalId: employee.principalId,
    displayName: employee.displayName,
    department: employee.department,
    teams: employee.teams.map((team) => ({ teamId: team.teamId, displayName: team.displayName })),
    status: employee.status,
    /*
       The panel's DETAILS list. Each is present only when the directory supplied it — see
       `EmployeeDisplay` for why absence is part of the contract rather than a gap.
    */
    ...(employee.employeeId !== undefined ? { employeeId: employee.employeeId } : {}),
    ...(employee.reportsTo !== undefined ? { reportsTo: employee.reportsTo } : {}),
    ...(employee.location !== undefined ? { location: employee.location } : {}),
    ...(employee.timezone !== undefined ? { timezone: employee.timezone } : {}),
    // Surfaced so a caller can see this is interim data, not HRMS truth (§12).
    authority: employee.authority,
  };
}
