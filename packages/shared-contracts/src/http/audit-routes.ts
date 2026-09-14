/**
 * The communication audit route table.
 *
 * Its own file and its own base, deliberately. `/v1/employee` is what employees use and
 * `/v1/audit` is what the one auditor uses, and keeping them apart is the same argument the
 * controller makes: the read-only guarantee should be visible in the shape of the thing, not
 * only in the checks inside it. A path under `/v1/employee/audit/...` would sit in the same
 * tree as every write route in the product.
 *
 * There is no write route here because there is no write handler. If one ever appears in
 * this file it should be as obvious in review as it would be in the controller.
 */

export const AUDIT_API_BASE = '/v1/audit';

export const auditRoutes = Object.freeze({
  /**
   * Whether this session may use the surface at all.
   *
   * Asked so the workspace can omit a door it would refuse. It is NOT what protects
   * anything — every route below decides for itself, server-side, and hiding a screen is
   * not authorization.
   */
  permission: `${AUDIT_API_BASE}/permission`,
  /** Every employee account, with the teams and department each sits in. */
  employees: `${AUDIT_API_BASE}/employees`,
  /** Departments and teams, so an audit can browse rather than guess at ids. */
  teams: `${AUDIT_API_BASE}/teams`,
  /**
   * Conversations, filtered by employee, team, type and date range.
   *
   * A query builder rather than a bare string, because five optional filters assembled by
   * hand at the call site is five chances to spell one of them differently from the schema
   * that parses it.
   */
  conversations: (filter: {
    readonly employeeId?: string;
    readonly teamId?: string;
    readonly type?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
  }): string => {
    const params = new URLSearchParams();
    if (filter.employeeId !== undefined) params.set('employeeId', filter.employeeId);
    if (filter.teamId !== undefined) params.set('teamId', filter.teamId);
    if (filter.type !== undefined) params.set('type', filter.type);
    if (filter.from !== undefined) params.set('from', filter.from);
    if (filter.to !== undefined) params.set('to', filter.to);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return `${AUDIT_API_BASE}/conversations${query === '' ? '' : `?${query}`}`;
  },
  /** Who is, and was, in one conversation — including participations that have ended. */
  participants: (conversationId: string): string =>
    `${AUDIT_API_BASE}/conversations/${conversationId}/participants`,
  /** The complete history of one conversation, both visibilities. */
  messages: (conversationId: string, filter: { readonly kind?: string; readonly limit?: number }): string => {
    const params = new URLSearchParams();
    if (filter.kind !== undefined && filter.kind !== 'ALL') params.set('kind', filter.kind);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return `${AUDIT_API_BASE}/conversations/${conversationId}/messages${query === '' ? '' : `?${query}`}`;
  },
  /** Message search across the whole company. */
  search: (term: string, limit?: number): string =>
    `${AUDIT_API_BASE}/search?q=${encodeURIComponent(term)}${limit === undefined ? '' : `&limit=${limit}`}`,
  /** The ledger, including the auditor's own reads. */
  log: (filter: { readonly actorId?: string; readonly action?: string; readonly limit?: number }): string => {
    const params = new URLSearchParams();
    if (filter.actorId !== undefined) params.set('actorId', filter.actorId);
    if (filter.action !== undefined) params.set('action', filter.action);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    return `${AUDIT_API_BASE}/log${query === '' ? '' : `?${query}`}`;
  },
});
