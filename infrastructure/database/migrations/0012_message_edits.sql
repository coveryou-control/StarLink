-- =====================================================================================
-- 0012 — when a message was last corrected
--
-- `message_revisions` already records THAT a message was corrected, who did it and what
-- it said before; `messages.redacted_at` already records a deletion. What was missing was
-- a cheap way for the read projection to say "edited" beside a message.
--
-- ## Why a column and not a join
--
-- The alternative is `EXISTS (SELECT 1 FROM message_revisions WHERE ... kind='CORRECTION')`
-- on every row of every page. That is a correlated subquery on the hottest read in the
-- product to answer a question whose answer is one timestamp — and the revisions table is
-- an append-only history that grows without bound, so the subquery gets slower forever
-- while the answer never changes shape.
--
-- The history stays authoritative. This is a denormalisation of its most recent row,
-- written in the same transaction as the revision it summarises.
--
-- ## Nullable, no default
--
-- NULL means "never edited", which is almost every message. A default would put a
-- timestamp on rows that were never corrected and make the column a lie.
-- =====================================================================================

ALTER TABLE conversation.messages
  ADD COLUMN edited_at timestamptz;

COMMENT ON COLUMN conversation.messages.edited_at IS
  'When the body was last corrected. NULL means never. The authoritative history is '
  'conversation.message_revisions; this is a denormalisation of its latest CORRECTION '
  'so the message page does not need a correlated subquery per row.';
