-- =====================================================================================
-- 0011 — message reactions and structured mentions
--
-- Both exist because Stage 1 is an internal chat product and both are ordinary chat
-- capabilities. Neither introduces a business value: a reaction is a person's own mark on
-- a message, and a mention is a reference to a principal the sender chose. Nothing here
-- sets a policy, a target, a threshold or a category.
--
-- ## Reactions: a table, not a column
--
-- A reaction is (message, principal, emoji) and the interesting query is "what is on this
-- message" for a page of messages. A jsonb column on `messages` would make every reaction
-- a read-modify-write of the message row — two people reacting at once would lose one —
-- and would put a mutable, contended field on the one table the whole product appends to.
--
-- The primary key is the whole tuple, which is the deduplication: reacting twice with the
-- same emoji is idempotent rather than an error, and un-reacting is a delete of a row the
-- caller can name without reading first.
--
-- `ON DELETE CASCADE` from messages, because a reaction to a message that no longer exists
-- is not a fact worth keeping. The audit ledger, which is append-only and governed
-- separately, is where the durable record of activity lives (rule 8).
--
-- ## Mentions: a column on the message
--
-- A mention is part of what the message SAYS. It is written once, in the same transaction
-- as the body, never edited independently and never queried across messages — so it is a
-- property of the row, not a relation. Storing it in a side table would introduce a second
-- write that could fail after the message committed, which is exactly the drift §17 exists
-- to prevent.
--
-- jsonb rather than a uuid[] because a mention carries an OFFSET and a LENGTH as well as a
-- principal: the renderer has to know which run of characters to mark, and reconstructing
-- that by searching the body for a display name is how "@Priya Nair" in a quotation gets
-- highlighted as a mention of somebody who was never mentioned.
--
-- `@all` is a mention with `kind = 'ALL'` and no principal, in the same array. A separate
-- boolean column would make "mentions everyone" a different shape from "mentions Priya",
-- and every reader would have to handle two cases to answer one question.
-- =====================================================================================

CREATE TABLE conversation.message_reactions (
  message_id   uuid NOT NULL REFERENCES conversation.messages(message_id) ON DELETE CASCADE,
  principal_id uuid NOT NULL,
  -- The emoji itself, not an id. There is no reaction catalogue and there should not be
  -- one: a catalogue is a configuration entity awaiting sign-off (rule 10), where a
  -- character is just what the person pressed. Bounded so the column cannot become a
  -- general-purpose text field on a hot table.
  emoji        text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, principal_id, emoji)
);

-- The only hot query: every reaction on a page of messages, fetched by message id.
-- Covered by the primary key's leading column, so no second index is created — an index
-- that duplicates a prefix of the PK costs writes and buys nothing.

-- Who reacted, for the "you and 3 others" summary the client renders. Not an index: the
-- set per message is small by construction and the PK ordering already groups it.

ALTER TABLE conversation.messages
  ADD COLUMN mentions jsonb;

-- Deliberately NOT NOT NULL DEFAULT '[]'. A message with no mentions is the overwhelming
-- majority, and NULL costs nothing to store where an empty array costs a jsonb header on
-- every row of the largest table in the schema. Readers treat NULL and [] identically.

COMMENT ON COLUMN conversation.messages.mentions IS
  'Structured mentions: [{"kind":"PRINCIPAL","principalId":uuid,"offset":int,"length":int}] '
  'or {"kind":"ALL","offset":int,"length":int}. NULL means none. Written with the body, '
  'never separately.';
