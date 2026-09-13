-- An announcement the whole company should keep seeing.
--
-- ## Not the same pin as either of the two already here
--
-- StarLink already has two things called a pin, and this is a third. They are genuinely
-- three different facts and the names are what keep them apart:
--
--   * `conversation_preferences.pinned` sorts a CONVERSATION to the top of ONE person's
--     list and tells nobody else anything.
--   * `conversation.pinned_messages` holds a MESSAGE above a thread for everybody in it.
--   * This holds an ANNOUNCEMENT at the top of the board for everybody in the company,
--     and only somebody who may publish one can set it.
--
-- The first is a preference, the second is a message, and this is an editorial decision
-- about a notice. Sharing a table with either would mean one query answering two questions.
--
-- ## Why a table rather than a column on conversations
--
-- The same shape `conversation.channels` uses, for the same reason: `conversations` is the
-- row every conversation type shares, and a column that is meaningful for one of six types
-- is a column five of them carry NULL in and every reader has to know to ignore. It also
-- keeps `pinned_by` and `pinned_at` beside each other, which a nullable column pair on the
-- shared table would not.
--
-- ## Unpinning DELETES the row
--
-- Deliberately, and it is worth saying why it does not offend rule 8. The audit ledger is
-- the append-only record of who did what, and pinning is audited there; this table is
-- current state — "what is pinned right now" — exactly as `pinned_messages` is, and that
-- table's own note makes the same argument. Keeping dead rows here would make every read
-- filter them out forever to answer a question nobody asks of it.

CREATE TABLE conversation.announcement_pins (
  conversation_id uuid PRIMARY KEY
                    REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  pinned_by       uuid NOT NULL REFERENCES identity.principals(principal_id),
  pinned_at       timestamptz NOT NULL DEFAULT now()
);

-- The board's own ordering: pinned first, newest first within each group.
CREATE INDEX announcement_pins_at_idx ON conversation.announcement_pins (pinned_at DESC);
