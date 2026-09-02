-- =====================================================================================
-- 0008 — coalescing carries a count, and notification preferences get a home
--
-- Two gaps in the Phase 8 pipeline, both of which were parameters nothing supplied.
--
-- 1. COALESCING WITH A COUNT (§29.5)
--
--    §29.5 does not say "suppress the duplicates" — it says **"'3 new messages', not
--    three notifications"**. Suppression alone produces "you have an update" no matter
--    how many arrived, which is a worse notification than the three it replaced: the
--    recipient cannot tell whether to look now.
--
--    The count belongs on the row rather than in application memory, because the events
--    it counts arrive in different requests and possibly different processes. An
--    in-memory tally would be lost on the restart it most needs to survive.
--
-- 2. PREFERENCES (§29.6)
--
--    §29.6 puts preferences "per principal, per channel, per category", and until now
--    `optedOutOf` was a field on a request object that no caller ever populated — a
--    preference system that could be tested and could not be exercised.
--
--    IN-APP IS DELIBERATELY NOT EXPRESSIBLE HERE. §29.6: it "is not disableable — it is
--    the unread mechanism". The CHECK constraint enforces that, so the way to disable
--    in-app notification is to change this schema, which is a conversation, rather than
--    to insert a row, which is not.
--
--    No default rows are seeded. An absent row means opted in, which is the state the
--    system is already in; seeding a global default would be inventing a business value
--    (rule 10) where the absence of a preference is a perfectly good answer.
-- =====================================================================================

-- Zero, not one: the row's own existence is the first notification. The count is how many
-- FURTHER events were folded into it, and the renderer adds one.
ALTER TABLE conversation.notification_outbox
  ADD COLUMN coalesced_count integer NOT NULL DEFAULT 0;

CREATE TABLE conversation.notification_preferences (
  principal_id  uuid NOT NULL REFERENCES identity.principals(principal_id),
  channel       text NOT NULL,
  -- NULL means "every category". A per-category row overrides it.
  category_id   text REFERENCES conversation.categories(category_id),
  opted_out     boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One row per principal × channel × category. `COALESCE` in the key because NULL is a
  -- real value here — the all-categories row — and a plain unique index would let a
  -- principal hold two of them.
  CONSTRAINT notification_preferences_channel_check
    CHECK (channel IN ('EMAIL', 'PUSH', 'CUSTOMER_CHANNEL'))
);

CREATE UNIQUE INDEX notification_preferences_key
  ON conversation.notification_preferences (principal_id, channel, COALESCE(category_id, '*'));
