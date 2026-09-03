/**
 * PostgreSQL full-text SearchProvider (ADR-014, doc §30).
 *
 * The single rule this file exists to make structural is §30.2:
 *
 *     WRONG:  query the whole corpus, then filter by what the caller may see.
 *             A filter that is forgotten, or that a new code path skips, returns
 *             everything.
 *
 *     RIGHT:  constrain the query to the caller's readable set.
 *             An absent scope returns NOTHING, not everything.
 *
 * Here the scope is a JOIN on live participation. That is stronger than a filter,
 * because there is no version of this query that accidentally omits it — remove the
 * join and the statement no longer resolves the columns it selects.
 *
 * Ordering is by recency, not relevance. Doc §30.3 assesses ranking as a known,
 * accepted gap for V1 ("weaker; acceptable when results are scope-limited and few"),
 * and recency keyset paging reuses the same compound-index discipline as the message
 * page rather than inventing a second, harder-to-verify ordering.
 */
import type pg from 'pg';
import type {
  AuthorizedScope,
  HealthReport,
  Page,
  Result,
  SearchDocument,
  SearchHit,
  SearchProvider,
  Timestamp,
  UUID,
} from '@starlink/shared-contracts';
import { err, likePattern, ok } from '@starlink/shared-contracts';

/** Search is expensive and is the natural bulk-extraction surface (§27.5, FR-SRCH-3). */
const MAX_RESULTS = 50;
/*
   `simple`, not `english`, and the two must agree with migration 0019's generated column.

   `english` deletes stopwords and stems what is left, so "what happended" indexed as
   `'happend'` — findable by "happ" and not by "what", because `plainto_tsquery('english',
   'what')` is the EMPTY query. About 130 of the commonest words in the language were
   silently unsearchable. `simple` keeps every token as typed; the `:*` below recovers the
   part of stemming that was worth having.
*/
const FTS_CONFIG = 'simple';

/**
 * The query, with the LAST lexeme treated as a prefix.
 *
 * `plainto_tsquery` alone matches whole stemmed words, which is right for a search you
 * submit and wrong for one that runs as you type: "rahu" found nothing until the "l"
 * arrived, and "hi" found nothing at all because the box refused to send it. Appending
 * `:*` is Postgres's own search-as-you-type form — "wha" matches "what", "ra" matches
 * "Rahul", and the earlier words in a multi-word term stay exact so "sla numb" narrows
 * rather than widens.
 *
 * Built by casting the parsed query BACK to text and re-parsing, rather than by
 * interpolating the caller's string: `plainto_tsquery` has already stripped the operators
 * (`&`, `|`, `!`, `<->`, parentheses) that make `to_tsquery` a parser, so nothing the
 * caller typed reaches it as syntax. Interpolating `$2` into `to_tsquery` directly would
 * turn a search box into a tsquery-injection surface — the whole reason `plainto_` exists.
 *
 * The CASE is not defensive dressing. A term that is entirely stopwords ("the", "of")
 * parses to the empty tsquery, whose text is `''`; appending `:*` to that yields `:*`,
 * which is a syntax error, and the search would fail rather than return nothing. Empty
 * stays empty, and an empty tsquery matches no rows — which is the honest answer.
 */
const PREFIX_QUERY = `(
  CASE WHEN plainto_tsquery('${FTS_CONFIG}', $2)::text = ''
       THEN plainto_tsquery('${FTS_CONFIG}', $2)
       ELSE (plainto_tsquery('${FTS_CONFIG}', $2)::text || ':*')::tsquery
  END
)`;

interface CursorPosition {
  readonly createdAt: string;
  readonly id: UUID;
}

const degraded = (code: string, message: string): Result<never> =>
  err({
    code,
    message,
    retryable: true,
    // Search failing must not take conversation with it (brief §43).
    failureClass: 'FAIL_DEGRADED',
    correlationId: 'pg-search',
  });

export class PgSearchProvider implements SearchProvider {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * No-op: the index is a generated column, always in step with the row.
   *
   * Present so the interface holds for a future OpenSearch provider, where indexing IS
   * a real operation. A projection that can lag is a projection that can be silently
   * wrong, so V1 deliberately has nothing to fall behind.
   */
  async index(_document: SearchDocument): Promise<Result<void>> {
    return ok(undefined);
  }

  async remove(_documentId: UUID): Promise<Result<void>> {
    // Deleting the message removes the vector with it; retention and erasure act on
    // the row, so there is no separate artefact to forget (§63).
    return ok(undefined);
  }

  async search(scope: AuthorizedScope, query: string, cursor?: string): Promise<Result<Page<SearchHit>>> {
    const term = query.trim();
    if (term === '') return ok({ items: [] });

    // Escaped, so `%` is a percent sign rather than "everything" — see `likePattern`.
    const params: unknown[] = [scope.principalId, term, likePattern(term)];

    /*
       Two ways to match, ORed.

       The tsquery is anchored to token starts by construction — `:*` is a PREFIX operator,
       so "pend" can never reach "happended" however the configuration is set. People and
       files have always been `ILIKE '%term%'`, so one search box answered two different
       ways depending on which facet you were looking at. The `ILIKE` puts messages on the
       same footing; migration 0019's trigram index is what stops it being a scan.
    */
    const conditions: string[] = [`(m.search_vector @@ ${PREFIX_QUERY} OR m.body ILIKE $3)`];

    if (!scope.includeInternal) {
      // Customer paths never even query internal rows (ADR-021). Excluded here rather
      // than dropped from the result set, so there is no window in which the row was
      // loaded and merely not shown.
      conditions.push(`m.visibility = 'CUSTOMER_VISIBLE'`);
    }

    if (scope.conversationIds !== undefined) {
      // Narrowing only. It can never widen beyond what the join already permits.
      params.push(scope.conversationIds);
      conditions.push(`m.conversation_id = ANY($${params.length}::uuid[])`);
    }

    const position = decodeCursorPosition(cursor);
    if (position !== undefined) {
      params.push(position.createdAt, position.id);
      conditions.push(
        `(m.created_at, m.message_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(MAX_RESULTS + 1);

    try {
      const result = await this.pool.query(
        // The readable set is resolved FIRST, in its own CTE, and the search is then
        // constrained to it — literally the shape §30.2 prescribes. Written this way
        // rather than as a bare participants join because "conversations I may read"
        // is genuinely two things, and the read path already honours both:
        //
        //   * conversations I participate in, and
        //   * customer conversations I currently OWN.
        //
        // An owner who was never added as a participant can open the thread but, with
        // a participants-only join, could not search it — two divergent definitions of
        // the same permission, which is how a search feature quietly stops finding
        // half of someone's work.
        //
        // Deliberately NOT included: team-wide scope grants. A lead has no default
        // read (BR-30, D-11), so widening search to team scope would hand out access
        // the read path itself refuses. Search may be narrower than the read set; it
        // must never be wider.
        `WITH readable AS (
            SELECT conversation_id
              FROM conversation.participants
             WHERE principal_id = $1 AND effective_to IS NULL
            UNION
            SELECT c.conversation_id
              FROM conversation.conversations c
              JOIN conversation.service_cases sc ON sc.case_id = c.case_id
             WHERE sc.current_owner_id = $1
         )
         SELECT m.message_id, m.conversation_id, m.created_at,
                /*
                   Who said it.

                   A result was a fragment of text and nothing else — no author, no time —
                   so two hits from different people in different threads were
                   indistinguishable until you opened them. A LEFT JOIN, because a
                   system-authored message has no sender and must still be findable.
                */
                sender.display_name AS sender_display_name,
                ts_headline('${FTS_CONFIG}', m.body, ${PREFIX_QUERY},
                            'MaxFragments=1, MaxWords=18, MinWords=5, StartSel=<<, StopSel=>>') AS snippet,
                ts_rank(m.search_vector, ${PREFIX_QUERY}) AS rank
           FROM conversation.messages m
           JOIN readable r ON r.conversation_id = m.conversation_id
           LEFT JOIN identity.principals sender ON sender.principal_id = m.sender_principal_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT $${params.length}`,
        params,
      );

      const rows = result.rows.slice(0, MAX_RESULTS);
      const hasMore = result.rows.length > MAX_RESULTS;
      const last = rows[rows.length - 1];

      return ok({
        items: rows.map(
          (row): SearchHit => ({
            documentId: row.message_id,
            conversationId: row.conversation_id,
            snippet: row.snippet ?? '',
            score: Number(row.rank),
            createdAt: (row.created_at as Date).toISOString() as Timestamp,
            ...(row.sender_display_name !== null && row.sender_display_name !== undefined
              ? { senderDisplayName: row.sender_display_name as string }
              : {}),
          }),
        ),
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeCursorPosition((last.created_at as Date).toISOString(), last.message_id) }
          : {}),
      });
    } catch {
      return degraded('SEARCH_FAILED', 'search could not be completed');
    }
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

/**
 * Position cursors are opaque but NOT security-bearing here.
 *
 * A tampered cursor can only move the caller's own window within their own already
 * scoped results — it cannot reach a conversation the join does not permit. The signed
 * cursor at the API boundary (CursorCodec) is what stops a client handing us arbitrary
 * ordering keys; this is the provider-internal encoding beneath it.
 */
const encodeCursorPosition = (createdAt: string, id: UUID): string =>
  Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');

function decodeCursorPosition(cursor?: string): CursorPosition | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPosition;
    return typeof parsed.createdAt === 'string' && typeof parsed.id === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
