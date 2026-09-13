-- Mute returns, and it expires.
--
-- Migration 0018 removed it, on the reasoning that a notification is how StarLink tells
-- somebody a conversation needs them and a switch turning that off for one thread is a
-- switch for missing the thread that mattered. That reasoning was accepted at the time and
-- the column was dropped so that reinstating it would have to be a deliberate act rather
-- than an afternoon's wiring. This is that deliberate act: it was asked for on 2026-09-04,
-- with the durations named.
--
-- ## Why this is not simply the old column back
--
-- What 0018 removed was `muted boolean` — a switch with no end. The objection to it holds:
-- somebody silences the busy group on a Tuesday, and in March they are the last to hear
-- about the thing that mattered, with nothing to remind them why.
--
-- `muted_until timestamptz` cannot do that. Every mute has an end, the longest offered is a
-- day, and the state heals itself: an expired row needs no cleanup because a comparison
-- against `now()` is the whole of the read. There is no "mute forever" and the UI must not
-- grow one — that is the difference between quietening something and abandoning it.
--
-- ## What it is still not allowed to touch
--
-- §29.6 makes the in-app unread count a fact, not a preference, and this does not change
-- it. A muted conversation still counts unread, still bolds its row, still appears in the
-- Unread filter. The only thing suppressed is the interruption: the sound and the system
-- notification. You can always see what you missed; you are simply not pulled away from
-- what you were doing to see it.
--
-- Nobody else can tell. Like `pinned`, this is one person's row about one conversation.
--
-- ## Why a timestamp and not "minutes from now"
--
-- Storing the DURATION would need the read to know when it was set and to do the
-- arithmetic on every list query, and the answer would change if the row were ever copied
-- or restored. An absolute instant is what the comparison actually wants.
--
-- Stamped by the APPLICATION clock, never by the database's `now()` on write — this
-- machine's clock has run a minute behind the managed database before, and a period whose
-- ends come from two clocks is a period that can be empty. The read compares against the
-- application clock too, passed as a parameter.

ALTER TABLE conversation.conversation_preferences
  ADD COLUMN IF NOT EXISTS muted_until timestamptz;

COMMENT ON COLUMN conversation.conversation_preferences.muted_until IS
  'When this person''s mute of this conversation runs out. NULL means not muted, and so '
  'does any instant in the past — an expired mute needs no cleanup. Suppresses the sound '
  'and the system notification only; the unread count is a fact (§29.6), not a preference. '
  'There is deliberately no way to store "forever": see 0021 and, for why it was removed '
  'in the first place, 0018.';

-- Only rows that are actually muted, and only while they are.
--
-- The overwhelming majority of preference rows have a NULL here, and the read is always
-- "is this one muted right now" for one principal. A partial index keeps out the rows that
-- can never match. It cannot be partial on `muted_until > now()` — that is not IMMUTABLE
-- and Postgres refuses it in an index predicate — so the predicate is the null check and
-- the instant comparison happens on the rows it leaves.
CREATE INDEX IF NOT EXISTS conversation_preferences_muted_idx
  ON conversation.conversation_preferences (principal_id, conversation_id)
  WHERE muted_until IS NOT NULL;

COMMENT ON TABLE conversation.conversation_preferences IS
  'One row per person per conversation, written only when they change something: whether it '
  'is pinned to the top of their own list, and whether they have quietened it until an '
  'instant that has to arrive. Neither is visible to anybody else.';
