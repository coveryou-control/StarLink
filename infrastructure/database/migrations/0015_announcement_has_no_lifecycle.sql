-- An announcement has no lifecycle either.
--
-- `conversations_state_presence` is the database's own copy of D-15: an internal
-- conversation has no `state`, a customer one must have one. It named the two internal types
-- literally, so the first announcement insert was refused by a constraint that was correct
-- about the rule and out of date about the list.
--
-- That is the guard working, and it is worth saying why it is left as a literal list rather
-- than replaced with something cleverer: `conversation_type NOT LIKE 'INTERNAL%'` would have
-- silently accepted this new type without anybody deciding it should, which is the failure
-- mode the check exists to prevent. A refused INSERT and a one-line migration is the
-- cheapest possible way to be asked the question.
--
-- Third copy of "which types are internal", after `conversations.ts` and the check in
-- `internal-types.test.ts`. The two in TypeScript are held together by that test; this one is
-- held by the fact that adding a type without touching it fails on the first write.

ALTER TABLE conversation.conversations
  DROP CONSTRAINT conversations_state_presence;

ALTER TABLE conversation.conversations
  ADD CONSTRAINT conversations_state_presence CHECK (
    (conversation_type IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP', 'INTERNAL_ANNOUNCEMENT')
      AND state IS NULL)
    OR (conversation_type NOT IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP', 'INTERNAL_ANNOUNCEMENT')
      AND state IS NOT NULL)
  );
