-- The group's creator is its admin, and something finally reads that.
--
-- Asked for on 2026-09-04: mark the creator in the members list, and let only them remove
-- people.
--
-- ## Almost nothing to do, which is the point
--
-- `conversation.participants.role` has existed since the first migration, defaulting to
-- 'PARTICIPANT', with a note saying it is there so nobody has to migrate before somebody
-- can hold a role. And `createInternalConversation` has been writing 'CREATOR' for the
-- person who started the conversation since it was written. The fact has been in the
-- database all along; what was missing was any code that read it.
--
-- So this migration adds no column and invents no second word. Writing 'ADMIN' beside the
-- existing 'CREATOR' would have left two spellings of one fact, and the first query to ask
-- for one of them would have been wrong half the time. The permission attaches to the role
-- that is already there.
--
-- ## What it does fix
--
-- Conversations created before `createInternalConversation` existed — and any produced by
-- a path that inserted participants directly — have a `created_by` and no CREATOR row. The
-- UPDATE below gives those groups their admin, so the label is not mysteriously absent on
-- exactly the oldest conversations.
--
-- Only INTERNAL_GROUP. A one-to-one has no membership to administer, and a customer
-- conversation's authority is OWNERSHIP (§21) — a different model, with an exclusion
-- constraint behind it, which must not acquire a second one (rule 11).
--
-- ## There is deliberately no second admin
--
-- Appointing one is a real feature with real questions behind it: may an admin demote
-- another, and what happens when the last one leaves a group people are still using?
-- Answering those by default would be inventing a business value, which rule 10 forbids.
-- `docs/STARLINK_OPEN_QUESTIONS.md` is where that goes when somebody wants it.

UPDATE conversation.participants p
   SET role = 'CREATOR'
  FROM conversation.conversations c
 WHERE c.conversation_id = p.conversation_id
   AND c.conversation_type = 'INTERNAL_GROUP'
   AND c.created_by = p.principal_id
   AND p.role = 'PARTICIPANT'
   -- Only where the group has no CREATOR at all. Without this, a conversation whose
   -- creator left and was re-added as a plain participant would silently regain the
   -- authority they had given up.
   AND NOT EXISTS (
     SELECT 1 FROM conversation.participants existing
      WHERE existing.conversation_id = p.conversation_id
        AND existing.role = 'CREATOR'
   );

COMMENT ON COLUMN conversation.participants.role IS
  'PARTICIPANT for almost everybody. CREATOR marks whoever started the conversation and, '
  'in an INTERNAL_GROUP, is the only person permitted to remove members — see 0023. There '
  'is deliberately no way to appoint a second: that needs answers (may one demote another? '
  'what happens when the last one leaves?) that are business decisions, not defaults.';

-- No new index. Finding a conversation's creator is a lookup by conversation, and the
-- primary key already leads with `conversation_id`. Written down so the next person does
-- not add one on the assumption that a new predicate needs one.
