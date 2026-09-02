/**
 * Scoped message search (doc §30, FR-SRCH-1..5).
 *
 * Search is a feature and an exfiltration tool in equal measure, so the rules here are
 * as much about what it refuses as what it returns:
 *
 *   * **FR-SRCH-1/2** — scope is resolved before the query. The provider takes an
 *     `AuthorizedScope` it cannot run without; this function decides what that scope is.
 *   * **FR-SRCH-3** — every search is audited WITH THE TERM. "Someone searched"
 *     answers nothing after an incident; what they searched for is the question.
 *     The audit is written even when the search fails or returns nothing.
 *   * **FR-SRCH-4** — "no matches" and "no data" are different answers. An empty
 *     result is a success; a failed provider is a failure, and the caller must be able
 *     to tell them apart (doc §34.1: an empty result and a failed query must never
 *     render identically).
 *   * **FR-SRCH-5** — very short terms are refused rather than returning everything.
 */
import { SEARCH_MINIMUM_TERM_LENGTH } from '@starlink/shared-contracts';
import type { AuthorizedScope, Page, SearchHit, SearchProvider, UUID } from '@starlink/shared-contracts';

/**
 * Below this, a term matches so much that the result is a corpus dump (FR-SRCH-5).
 *
 * Re-exported from the HTTP contract rather than declared here. It was a literal `3` in
 * this file and a literal `2` in the employee web app's search box, and the gap was
 * invisible from either side: the server's refusal is the uniform §27.3 one, so the client
 * rendered "Search is unavailable" — an outage message — for somebody who had typed two
 * characters. One number, read by both.
 */
export const MINIMUM_TERM_LENGTH = SEARCH_MINIMUM_TERM_LENGTH;

export interface SearchCommand {
  readonly principalId: UUID;
  readonly principalKind: 'EMPLOYEE' | 'CUSTOMER';
  readonly term: string;
  /** Optional narrowing to one thread. Never widens scope. */
  readonly conversationId?: UUID;
  readonly cursor?: string;
  readonly correlationId: string;
}

export type SearchOutcome =
  | { readonly ok: true; readonly page: Page<SearchHit>; readonly matched: boolean }
  | { readonly ok: false; readonly reason: 'TERM_TOO_SHORT' | 'RATE_LIMITED' | 'SEARCH_UNAVAILABLE' };

/** Written for every search attempt, including refusals (FR-SRCH-3). */
export interface SearchAuditEntry {
  readonly principalId: UUID;
  readonly term: string;
  readonly correlationId: string;
  readonly outcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
  readonly resultCount: number;
}

export interface SearchDeps {
  readonly provider: SearchProvider;
  readonly recordSearch: (entry: SearchAuditEntry) => Promise<void>;
  /** Returns false when the caller has exceeded their allowance (§27.5). */
  readonly allowRequest?: (principalId: UUID) => boolean;
}

export async function searchMessages(command: SearchCommand, deps: SearchDeps): Promise<SearchOutcome> {
  const term = command.term.trim();

  if (term.length < MINIMUM_TERM_LENGTH) {
    // Audited even though nothing was searched: a stream of refused two-character
    // probes is itself a signal worth having.
    await deps.recordSearch({
      principalId: command.principalId,
      term,
      correlationId: command.correlationId,
      outcome: 'REFUSED',
      resultCount: 0,
    });
    return { ok: false, reason: 'TERM_TOO_SHORT' };
  }

  if (deps.allowRequest !== undefined && !deps.allowRequest(command.principalId)) {
    await deps.recordSearch({
      principalId: command.principalId,
      term,
      correlationId: command.correlationId,
      outcome: 'REFUSED',
      resultCount: 0,
    });
    return { ok: false, reason: 'RATE_LIMITED' };
  }

  const scope: AuthorizedScope = {
    principalId: command.principalId,
    // Staff participants may read internal notes; a customer never can, on any path
    // (§30.5, ADR-021). Decided HERE, from the principal's kind, rather than taken
    // from anything the caller supplied.
    includeInternal: command.principalKind === 'EMPLOYEE',
    ...(command.conversationId !== undefined ? { conversationIds: [command.conversationId] } : {}),
  };

  const result = await deps.provider.search(scope, term, command.cursor);

  if (!result.ok) {
    await deps.recordSearch({
      principalId: command.principalId,
      term,
      correlationId: command.correlationId,
      outcome: 'FAILED',
      resultCount: 0,
    });
    // Distinct from an empty result. A caller that rendered these identically would
    // tell the user "no matches" when the truth is "we could not look" (§34.1).
    return { ok: false, reason: 'SEARCH_UNAVAILABLE' };
  }

  await deps.recordSearch({
    principalId: command.principalId,
    term,
    correlationId: command.correlationId,
    outcome: 'SUCCEEDED',
    resultCount: result.value.items.length,
  });

  return { ok: true, page: result.value, matched: result.value.items.length > 0 };
}
