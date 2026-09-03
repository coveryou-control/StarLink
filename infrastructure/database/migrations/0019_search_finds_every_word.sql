-- =====================================================================================
-- StarLink migration 0019 — search must find a word that is on the screen
--
-- ## The defect
--
-- 0003 built `search_vector` with the `english` text-search configuration, which is the
-- default choice for prose and the wrong one for a chat log. Two things it does:
--
--   1. It DELETES stopwords. `to_tsvector('english', 'what happended')` is
--      `'happend':2` — the word "what" is not in the index at all, and
--      `plainto_tsquery('english','what')` is the EMPTY query, which matches nothing.
--      So a message reading "what happended" was findable by "happ" and not by "what".
--      The same holds for when, who, is, are, the, a, to, of, and, it, this, that, my,
--      your, we, you, no, not, do, did — a list of about 130 of the most common words in
--      the language, every one of them silently unfindable.
--
--   2. It STEMS. "happended" is stored as "happend", so searching the word as typed
--      missed it too.
--
-- Neither behaviour is wrong for a document corpus, where you want "running" to match
-- "ran" and do not want a hundred hits for "the". Both are wrong for a search box over
-- what colleagues said to each other, where the reasonable expectation is that a word
-- you can see is a word you can find.
--
-- ## The change
--
-- `simple`: lowercase, split on word boundaries, keep everything. No stopword list, no
-- stemmer. Combined with the `:*` prefix match the provider already applies, "sign"
-- still finds "signed" and "signing" — which is most of what the stemmer was buying —
-- and nothing disappears.
--
-- Plus a trigram index, so a term in the MIDDLE of a word is findable as well. A
-- tsvector match is anchored to token starts by construction, so "pend" could never
-- match "happended" however the config was set; the provider ORs an `ILIKE '%term%'`
-- alongside the tsquery, and this index is what keeps that from being a sequential scan.
-- It also makes the messages facet behave like the people and files facets, which have
-- always been ILIKE substring matches — one search box that answered three different
-- ways was its own defect.
--
-- ## Rebuilding a generated column
--
-- A STORED generated column's expression cannot be altered in place, so the column is
-- dropped and re-added. That rewrites the table and recomputes every vector, which is
-- correct and is the reason this is a migration rather than a query change: the index
-- and the query must agree about the configuration, and for the moment between them
-- they would not.
--
-- Data-safe. `search_vector` is derived from `body` and holds nothing of its own — it is
-- recomputed from the same column it was always computed from. No message is touched.
-- =====================================================================================

-- Trigram matching for the substring half. Available on the local build and on Neon.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The index comes with the column; both go, both come back.
DROP INDEX IF EXISTS conversation.messages_search_idx;

ALTER TABLE conversation.messages DROP COLUMN IF EXISTS search_vector;

ALTER TABLE conversation.messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;

-- GIN is the right shape for tsvector containment: the query asks "which rows contain
-- these lexemes", which is exactly what an inverted index answers.
CREATE INDEX messages_search_idx ON conversation.messages USING GIN (search_vector);

/*
   The substring index.

   `gin_trgm_ops` is what makes `body ILIKE '%pend%'` an index lookup rather than a scan
   of every message the caller can read. Trigrams need three characters to narrow
   usefully; below that Postgres falls back to filtering, which the participation JOIN
   and the LIMIT already bound.
*/
CREATE INDEX IF NOT EXISTS messages_body_trgm_idx
  ON conversation.messages USING GIN (body gin_trgm_ops);

COMMENT ON COLUMN conversation.messages.search_vector IS
  'Derived FTS projection (ADR-014), `simple` config — no stopword removal and no '
  'stemming, so every word a person can see is a word they can find. Never authoritative '
  'for permission or retention; authorization is resolved BEFORE the query reaches this '
  'column (FR-SRCH-1).';
