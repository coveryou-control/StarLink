-- =====================================================================================
-- StarLink migration 0003 — message full-text search
--
-- ADR-014: PostgreSQL FTS first, behind the SearchProvider abstraction, with a
-- dedicated engine deferred until the §30.4 triggers fire.
--
-- A GENERATED column rather than a separate index table, deliberately:
--
--   * It cannot drift. A projection maintained by a job can lag or fail silently, and
--     a search index that is quietly stale is worse than one that is obviously absent
--     — people trust results they can no longer rely on.
--   * There is no rebuild step and no indexing queue to operate in V1.
--
-- When the corpus outgrows this (§30.4), an OpenSearch-class provider becomes a second
-- SearchProvider implementation and THIS column is simply dropped. Nothing else moves,
-- because no caller reaches the index directly.
--
-- Note what is indexed: internal notes too. Staff participants may read them (§30.5),
-- and the customer path excludes them by VISIBILITY at query time, not by omitting them
-- from the index — an index that silently lacked rows would be a second, divergent
-- definition of who can see what.
--
-- Expand-only. Adds a column and an index; changes no existing data.
-- =====================================================================================

ALTER TABLE conversation.messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;

-- GIN is the right shape for tsvector containment: the query asks "which rows contain
-- these lexemes", which is exactly what an inverted index answers.
CREATE INDEX messages_search_idx ON conversation.messages USING GIN (search_vector);

COMMENT ON COLUMN conversation.messages.search_vector IS
  'Derived FTS projection (ADR-014). Never authoritative for permission or retention; '
  'authorization is resolved BEFORE the query reaches this column (FR-SRCH-1).';
