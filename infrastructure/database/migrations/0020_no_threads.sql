-- =====================================================================================
-- StarLink migration 0020 — threads removed
--
-- Migration 0016 added one-level threading: `thread_parent_id` on a message, plus an
-- `also_send_to_channel` flag for the design's "Also send to channel" checkbox. The
-- product decision is that an internal chat does not need them, so the columns go with
-- the feature.
--
-- ## Why the columns are dropped rather than left in place
--
-- A nullable column nothing writes is not free. It is a shape the next person has to
-- reason about — the timeline predicate read it, the page LATERAL counted against it, and
-- the index-health probe explained a query built around it. Leaving it would leave every
-- one of those readers a plausible reason to come back. It is also the same choice made
-- for per-conversation mute in 0018, and for the same reason: reinstating the feature
-- should be a deliberate schema change, not a matter of noticing that the column was
-- still there.
--
-- ## What this deletes
--
-- The containment relationship, and nothing else. Every message survives with its body,
-- its author, its timestamp and its place in the conversation's `seq` order. A reply that
-- was inside a thread becomes an ordinary message in the conversation, at the position it
-- was always sent at — it stops being nested and does not stop existing.
--
-- That is the honest cost of the change and it is not reversible from here: after this
-- runs, which message was a reply to which is no longer recorded. On this database the
-- rows affected are development fixtures.
--
-- Contracting, deliberately. Expand-only is the rule for a column something might still
-- read; nothing reads these after this commit, and the code that did is gone in the same
-- change rather than a release later.
-- =====================================================================================

-- The partial index that served the thread page.
DROP INDEX IF EXISTS conversation.messages_thread_idx;

ALTER TABLE conversation.messages
  DROP COLUMN IF EXISTS thread_parent_id,
  DROP COLUMN IF EXISTS also_send_to_channel;
