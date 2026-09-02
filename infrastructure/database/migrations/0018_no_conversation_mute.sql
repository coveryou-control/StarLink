-- Mute is removed. Being told is not a per-conversation preference.
--
-- `conversation_preferences` shipped with two columns because screen 02's information panel
-- draws two switches. The product decision on 2026-09-02 is that the first of them must not
-- exist: a notification is how StarLink tells somebody a conversation needs them, and a
-- switch that turns that off for one thread is a switch for missing the thread that mattered.
-- §29.6 already says as much about the in-app unread count; this extends the same reasoning
-- one layer out, to the notification itself.
--
-- ## Dropped, not left unread
--
-- A column nothing writes and nothing reads is an invitation: the next person to want mute
-- finds the storage already there and wires it back up without the decision being taken
-- again. Removing it makes reinstating mute a schema change, which is the size of decision
-- it is.
--
-- What survives is `pinned`, which is about ORDER rather than attention — it changes where a
-- conversation sits in your own list and tells nobody anything.
--
-- Quiet hours on the settings screen are untouched and are a different thing: they are a
-- property of the DEVICE ("do not make noise on this laptop between these times"), they
-- apply to everything equally, and they cannot single out the one conversation somebody
-- would rather not hear about.

ALTER TABLE conversation.conversation_preferences
  DROP COLUMN IF EXISTS muted;

COMMENT ON TABLE conversation.conversation_preferences IS
  'One row per person per conversation, written only when they change something. Today that '
  'is pinning: it sorts the thread to the top of that person''s own list and nobody else''s. '
  'There is deliberately no mute — see 0018.';
