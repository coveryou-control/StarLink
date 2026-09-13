-- "Delete for me" — hiding a message from your own view and nobody else's.
--
-- Asked for on 2026-09-04, as the other half of the delete dialog. Until now delete meant
-- one thing: redaction, which clears the body for every reader and is the right answer for
-- "I did not mean to send that". This is the different question — "I do not want to see
-- this any more" — which is about one person's view and says nothing to anybody else.
--
-- ## Why it is a row here and not a change to the message
--
-- The message is untouched. A redaction is an edit to a shared object, recorded in the
-- audit ledger and visible to everyone; a hide is a fact about ONE READER. Storing it on
-- the message would mean either a per-principal column (impossible) or a flag that leaks
-- one person's choice into everybody's read.
--
-- ## What it deliberately is not
--
-- It is not a way to leave the record. Rule 8 makes the audit ledger append-only and BR-09
-- makes what a person COULD have read answerable after the fact; both are about the
-- LEDGER and neither is touched by this. The message stays in `conversation.messages`, the
-- audit trail stays complete, and an export or an investigation sees everything it saw
-- before. What changes is one person's timeline in one client.
--
-- Nor is it deletion for the other party, and the interface must never suggest it is. The
-- dialog names both options side by side precisely so that nobody presses this one
-- believing it reaches anyone else.
--
-- ## No unhide
--
-- Deliberately. An "un-hide" needs a place to list what you have hidden, which is a screen
-- showing somebody the messages they asked not to see. If the need appears, the row is
-- still here and deleting it is the whole implementation — but a control nobody has asked
-- for is not built on the assumption that they will.

CREATE TABLE IF NOT EXISTS conversation.hidden_messages (
  message_id    uuid NOT NULL REFERENCES conversation.messages(message_id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL REFERENCES identity.principals(principal_id) ON DELETE CASCADE,
  -- Application clock, like every other instant in this schema.
  hidden_at     timestamptz NOT NULL,
  PRIMARY KEY (message_id, principal_id)
);

-- The read is "which messages has THIS person hidden, among the page I am about to
-- return" — principal first, because that is the selective column and the message ids come
-- from the page rather than from a range scan.
CREATE INDEX IF NOT EXISTS hidden_messages_reader_idx
  ON conversation.hidden_messages (principal_id, message_id);

COMMENT ON TABLE conversation.hidden_messages IS
  'One person choosing not to see one message. NOT a redaction: the message is untouched, '
  'every other reader still sees it, and the audit ledger is unaffected (rule 8, BR-09). '
  'There is deliberately no un-hide — see 0026.';
