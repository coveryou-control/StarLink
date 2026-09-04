-- A conversation can have messages pinned in it.
--
-- Asked for on 2026-09-04, for one-to-ones and groups alike. This is not the same feature
-- as `conversation_preferences.pinned`, which sorts a CONVERSATION to the top of one
-- person's list; that one is private and about order. This one is shared and about
-- reference: the address, the decision, the link everybody keeps scrolling back for.
--
-- ## Why it is shared, and what follows from that
--
-- A pin everybody sees is a small act of authorship in somebody else's conversation, so it
-- is recorded like one: who pinned it and when, in a row that survives the unpin. Only a
-- participant may pin, which the application enforces through the same `decide()` call as
-- any other write — participation grants that conversation and nothing else (rule 3).
--
-- ## Why a table and not a column on `conversations`
--
-- `pinned_message_id uuid` would allow exactly one, and the first request after shipping it
-- is always the second pin. More to the point, a column cannot record who pinned it without
-- growing two more columns beside it, and cannot be indexed usefully for "everything pinned
-- here, newest first".
--
-- ## Unpinning deletes the row
--
-- There is no `unpinned_at`. The audit ledger is the append-only record (rule 8) and it
-- already carries the act; keeping tombstones here would mean every read filtering them out
-- forever to answer a question nobody asks of this table. What is pinned right now is the
-- only thing this table is for.
--
-- The FK cascades on message delete because a pin to a message that no longer exists is not
-- a fact worth keeping — and a redacted message keeps its row, so redaction does NOT
-- silently unpin. The reader filters redacted pins out; the pin itself stays, which is
-- correct: somebody deleted the text of something the group had pinned, and that should be
-- visible as an empty pin rather than as nothing at all.

CREATE TABLE IF NOT EXISTS conversation.pinned_messages (
  conversation_id  uuid NOT NULL REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  message_id       uuid NOT NULL REFERENCES conversation.messages(message_id) ON DELETE CASCADE,
  pinned_by        uuid NOT NULL REFERENCES identity.principals(principal_id),
  -- Stamped by the application clock, like every other effective instant in this schema.
  -- See the note in 0021 and CLAUDE.md's "Clocks": a period with ends from two clocks is a
  -- period that can be empty.
  pinned_at        timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

-- The only read: "what is pinned in this conversation", newest first. The primary key
-- already covers the lookup by conversation; this adds the ordering so the answer comes
-- back sorted without a sort.
CREATE INDEX IF NOT EXISTS pinned_messages_recent_idx
  ON conversation.pinned_messages (conversation_id, pinned_at DESC);

COMMENT ON TABLE conversation.pinned_messages IS
  'Messages held at the top of a conversation for everybody in it. Shared, unlike '
  'conversation_preferences.pinned, which is one person''s ordering of their own list. '
  'Unpinning deletes the row; the act itself lives in the audit ledger.';
