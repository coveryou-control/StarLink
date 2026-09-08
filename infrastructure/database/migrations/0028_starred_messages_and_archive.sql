-- ---------------------------------------------------------------------------------------
-- 0028 — starred messages, and archived conversations
--
-- Two capabilities asked for on 2026-09-08, both of which the new sidebar names and neither
-- of which existed. They are in one migration because they are one idea applied twice: a
-- private mark that one person puts on something, visible to nobody else.
--
-- ## Neither introduces a business value
--
-- Rule 10 forbids inventing SLA targets, categories, thresholds and the like. A star is a
-- person's own bookmark and an archive is a person's own tidying — neither sets a policy,
-- names a category or decides anything for anybody else. They are the same class of fact as
-- a reaction (0011), which is why they are stored the same way.
--
-- ## Starred messages: a table
--
-- `(message_id, principal_id)` and nothing else. The star belongs to the reader, not to the
-- message, so it cannot be a column on `messages` — a column would be one value shared by
-- everyone in the thread, which is the opposite of what a private bookmark is. It would also
-- put a mutable, contended field on the one table the whole product only ever appends to.
--
-- The key is the whole tuple, so starring twice is idempotent and un-starring is a delete of
-- a row the caller can name without reading it first.
--
-- `ON DELETE CASCADE` because a bookmark pointing at a message that no longer exists is not
-- a fact worth keeping. The audit ledger is where durable history lives (rule 8).
--
-- ## Archive: a column on participation, not on the conversation
--
-- Archiving is per PERSON. Two colleagues in the same thread must be able to disagree about
-- whether it is on their list, and a column on `conversations` would let one of them decide
-- for the other — the same reasoning that put mute on participation rather than on the
-- thread. `conversation.participants` already carries exactly this kind of per-person state.
--
-- A timestamp rather than a boolean, for the same reason `effective_to` is one: "when" is
-- strictly more information than "whether", it costs the same to store, and a support
-- question about a thread that vanished from someone's list is answerable with it.
--
-- Archiving is NOT leaving. Participation is untouched, the thread stays readable, and a new
-- message brings it back — which is the behaviour every product with this control has, and
-- the reason it can be an ordinary column rather than a change to the authorization model.
-- ---------------------------------------------------------------------------------------

BEGIN;

CREATE TABLE conversation.message_stars (
  message_id   uuid NOT NULL REFERENCES conversation.messages(message_id) ON DELETE CASCADE,
  principal_id uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, principal_id)
);

-- The dominant read is "everything I have starred, newest first", across every conversation
-- — the Favourites view is that query and nothing else.
CREATE INDEX message_stars_principal_idx
  ON conversation.message_stars (principal_id, created_at DESC);

ALTER TABLE conversation.participants
  ADD COLUMN archived_at timestamptz;

-- The conversation list reads "my threads, not archived" on every load, so the partial index
-- carries the common case and costs nothing for the rows it excludes.
CREATE INDEX participants_unarchived_idx
  ON conversation.participants (principal_id)
  WHERE archived_at IS NULL AND effective_to IS NULL;

COMMIT;
