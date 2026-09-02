-- Threads in a channel (design screen 03).
--
-- ## Why a new column and not `reply_to_message_id`
--
-- They answer different questions and one cannot do both jobs.
--
-- `reply_to_message_id` is a QUOTE: "this message is about that one". It changes how a
-- message is rendered and nothing else — the reply still belongs to the main timeline, and
-- UC-E16 is explicit that it is context rather than structure.
--
-- `thread_parent_id` is CONTAINMENT: "this message is inside that one's thread". It changes
-- where a message appears — a threaded reply is deliberately NOT in the channel's timeline,
-- which is the entire point of threading a side conversation out of a busy channel.
--
-- Overloading the quote column would have made every existing quoted reply disappear from
-- the timeline it was sent to. That is not a migration, it is a data loss with a nice name.
--
-- ## The root is a message, and only a root has a thread
--
-- `thread_parent_id` points at a message in the same conversation that is itself not
-- threaded. One level, enforced by the send path: a thread of threads is a tree nobody can
-- read on a phone, and every product that allowed one has since taken it away.
--
-- ## Counters are derived, never stored
--
-- "3 replies · last reply 2m ago" is a COUNT and a MAX over this column, taken with the
-- page that needs it. A stored counter is a second copy of a fact the rows already carry,
-- and it is wrong the first time a write path forgets to bump it — which, per §46 rule 9,
-- is the shape of defect this codebase refuses on principle: no state that exists only in
-- one place's bookkeeping.

ALTER TABLE conversation.messages
  ADD COLUMN IF NOT EXISTS thread_parent_id uuid REFERENCES conversation.messages(message_id);

COMMENT ON COLUMN conversation.messages.thread_parent_id IS
  'The message this one is a threaded reply to. NULL for a message in the main timeline. '
  'Distinct from reply_to_message_id, which quotes without moving the message out of it.';

-- ## "Also send to channel"
--
-- The design's checkbox, and it is one message rather than two. A threaded reply is out of
-- the channel's timeline by definition; this says "and also put THIS one back in it". Two
-- rows would be two messages — two sequence numbers, two read-receipt positions, two
-- notifications and two things to edit — for one thing somebody said once.
--
-- So the main timeline's predicate is "not threaded, OR threaded and asked to appear here",
-- and the message is a single row that is in two places.

ALTER TABLE conversation.messages
  ADD COLUMN IF NOT EXISTS also_send_to_channel boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN conversation.messages.also_send_to_channel IS
  'A threaded reply that also appears in the channel timeline. Meaningless, and ignored, '
  'when thread_parent_id is NULL.';

-- Every read of a thread is "the replies to this root, in order", and every channel page
-- needs "how many replies, and when was the last" for the roots on it. One index shape
-- serves both: the count and the MAX are answered from it without touching the heap.
CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON conversation.messages (thread_parent_id, seq)
  WHERE thread_parent_id IS NOT NULL;
