-- Per-person, per-conversation preferences: the design's CONVERSATION section.
--
-- Screen 02's information panel ends with two switches, "Mute notifications" and "Pin to
-- top". They are the only controls in the reference that had nothing behind them, and a
-- switch that writes nowhere is the one thing a settings surface must never contain — so
-- this is the table that makes them real rather than the reason to leave them out.
--
-- ## Whose preference
--
-- The principal's, not the conversation's. Muting a thread is a statement about what YOU
-- want to be told, and pinning it is a statement about where YOU want it; neither is a
-- property of the conversation and neither is visible to anybody else in it. The primary
-- key says so.
--
-- ## What "muted" is allowed to mean
--
-- §29.6 makes the in-app notification "the unread mechanism", and explicitly not a
-- preference — so mute does NOT touch the unread count. A muted conversation still shows
-- its unread badge in the list, because that is how the product tells you a thread has
-- moved. What it stops is the NOTIFICATION: no row in `notification_outbox` for this
-- principal from this conversation, so nothing reaches the bell, the email or the push.
--
-- The distinction is the whole of §29.6's point. "How many messages have I not read" is a
-- fact and stays visible; "interrupt me about it" is a preference and is now one.
--
-- ## Rows are written on demand
--
-- No row means both false, which is the default for every conversation anybody has ever
-- opened. Materialising a row per principal per conversation to store two falses would be
-- a table the size of `participants` holding no information.

CREATE TABLE IF NOT EXISTS conversation.conversation_preferences (
  principal_id    uuid NOT NULL REFERENCES identity.principals(principal_id),
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(conversation_id),
  muted           boolean NOT NULL DEFAULT false,
  pinned          boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, conversation_id)
);

-- The list joins on (principal, conversation) and sorts pinned first; the primary key
-- serves the join. This partial index serves the OTHER direction — "which conversations has
-- this person pinned" — without carrying the overwhelming majority of rows, which are a
-- mute with no pin or a row that exists only because something was once toggled back.
CREATE INDEX IF NOT EXISTS conversation_preferences_pinned_idx
  ON conversation.conversation_preferences (principal_id)
  WHERE pinned;

COMMENT ON TABLE conversation.conversation_preferences IS
  'One row per person per conversation, written only when they change something. muted '
  'suppresses notifications and never the unread count (§29.6); pinned sorts the thread to '
  'the top of that person''s list and nobody else''s.';
