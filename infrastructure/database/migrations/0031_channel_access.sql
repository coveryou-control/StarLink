-- What a channel lets people do, and who "people" is.
--
-- Three independent questions, because the product asks them independently:
--
--   1. WHO CAN SEE IT      — discovery. Whether the channel appears in the directory at all.
--   2. WHO CAN READ IT     — content. Whether the messages can be fetched.
--   3. WHO CAN POST IN IT  — contribution.
--
-- They nest. Reading requires seeing; posting requires reading. That is enforced by the
-- shape of the enums rather than by a rule somebody has to remember: `read_access` is
-- expressed relative to who can SEE, and `post_access` relative to who can READ, so an
-- incoherent combination cannot be spelled.
--
-- The worked example from the brief:
--
--   Technology  — visible to everyone, readable by members, postable by members.
--                 Everybody can find it and ask to join; only the team reads the traffic.
--
-- ## Fail closed, everywhere
--
-- A channel with `visibility = 'DEPARTMENTS'` and no audience row is visible to NOBODY, not
-- to everybody. Same for `SELECTED`. There is no cross-table CHECK that could require an
-- audience row (the rows arrive after the channel), so the safety comes from the direction
-- of the default: an unanswered question denies. Rule 4, one level down.
--
-- ## Blank is not a wildcard
--
-- §27.2 again: an absent attribute is absent, never blank, and a blank must not match a
-- blank and thereby grant something. `scope_id` is therefore checked non-blank at the
-- column, so a department named '' cannot be inserted and then matched by an employee whose
-- department is also unset.

-- --------------------------------------------------------------------------------------
-- The three policies
-- --------------------------------------------------------------------------------------

/*
   Who the channel is even visible to.

   'EVERYONE'    — any active employee finds it in the directory.
   'DEPARTMENTS' — only members of the departments/teams in `channel_audience`.
   'SELECTED'    — only the individually named principals in `channel_audience`.
*/
CREATE TYPE conversation.channel_visibility AS ENUM ('EVERYONE', 'DEPARTMENTS', 'SELECTED');

/*
   Who may read the messages, expressed relative to who may SEE the channel.

   'ANYONE_WHO_CAN_SEE' — an open channel: finding it is enough to read it.
   'MEMBERS'            — a visible but closed channel. This is the interesting one, and the
                          reason read and visibility are separate columns: a person can be
                          told a channel exists, and that they are not in it, which is what
                          makes joining a thing somebody can ask for rather than guess at.
*/
CREATE TYPE conversation.channel_read_access AS ENUM ('ANYONE_WHO_CAN_SEE', 'MEMBERS');

/*
   Who may post, expressed relative to who may READ.

   'ANYONE_WHO_CAN_READ' — a discussion space.
   'MEMBERS'             — read may be wider than write.
   'ADMINS'              — an announcement-shaped channel: a few publishers, many readers.
                           Note this is NOT the same object as INTERNAL_ANNOUNCEMENT, which
                           is company-wide by construction and materialises every employee
                           as a participant. A channel with ADMINS posting is a NOTICE BOARD
                           FOR ONE AUDIENCE, which is a different thing and why both exist.
*/
CREATE TYPE conversation.channel_post_access AS ENUM ('ANYONE_WHO_CAN_READ', 'MEMBERS', 'ADMINS');

/*
   What the channel is FOR — the directory's grouping, and nothing else.

   Deliberately not a category taxonomy (rule 10 forbids inventing one). These four are
   structural facts about a room's subject, chosen by whoever creates it, and the product
   uses them only to decide which heading the row sits under. No permission turns on it.
*/
CREATE TYPE conversation.channel_purpose AS ENUM ('DEPARTMENT', 'TEAM', 'PROJECT', 'OTHER');

CREATE TABLE conversation.channels (
  conversation_id  uuid PRIMARY KEY
                     REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  purpose          conversation.channel_purpose NOT NULL DEFAULT 'OTHER',
  -- The line under the name in the directory. Optional: a channel called "Security
  -- Incidents" does not need one, and a mandatory field produces "Security Incidents
  -- channel" in every row.
  description      text,
  visibility       conversation.channel_visibility NOT NULL,
  read_access      conversation.channel_read_access NOT NULL,
  post_access      conversation.channel_post_access NOT NULL,
  -- Retired rather than deleted, on the same principle as participation (BR-09/§24.3): the
  -- messages stay answerable. An archived channel leaves the directory and refuses new
  -- posts; its members keep their history.
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channels_description_not_blank CHECK (description IS NULL OR btrim(description) <> '')
);

/*
   Who is in the audience, when the audience is not everybody.

   Rows exist only for `visibility` of 'DEPARTMENTS' or 'SELECTED'. For 'EVERYONE' the table
   is empty for that channel, and the reader does not consult it.
*/
CREATE TYPE conversation.channel_audience_kind AS ENUM ('DEPARTMENT', 'TEAM', 'PRINCIPAL');

CREATE TABLE conversation.channel_audience (
  conversation_id uuid NOT NULL
                    REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  scope_kind      conversation.channel_audience_kind NOT NULL,
  -- A department name, a team name, or a principal id as text. Text rather than three
  -- nullable typed columns: the three are compared against the actor's own attribute list,
  -- which is `readonly string[]` for departments and teams alike.
  scope_id        text NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, scope_kind, scope_id),
  CONSTRAINT channel_audience_scope_not_blank CHECK (btrim(scope_id) <> '')
);

CREATE INDEX channel_audience_scope_idx ON conversation.channel_audience (scope_kind, scope_id);

-- --------------------------------------------------------------------------------------
-- What the conversations table has to learn
-- --------------------------------------------------------------------------------------

/*
   Fourth copy of "which types are internal", and 0015 explains why that is on purpose: a
   literal list means adding a type without deciding this question fails on the first write,
   whereas `LIKE 'INTERNAL%'` would have silently accepted it.

   A channel has no lifecycle for the same reason a group has none (D-15). There is no case,
   no customer, and nothing to resolve.
*/
ALTER TABLE conversation.conversations
  DROP CONSTRAINT conversations_state_presence;

ALTER TABLE conversation.conversations
  ADD CONSTRAINT conversations_state_presence CHECK (
    (conversation_type IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP', 'INTERNAL_ANNOUNCEMENT',
                           'INTERNAL_CHANNEL')
      AND state IS NULL)
    OR (conversation_type NOT IN ('INTERNAL_DIRECT', 'INTERNAL_GROUP', 'INTERNAL_ANNOUNCEMENT',
                                  'INTERNAL_CHANNEL')
      AND state IS NOT NULL)
  );

/*
   A channel is found by its NAME, so it has to have one.

   Groups may be untitled — they render as the names of the people in them, which is a
   reasonable thing for a private thread among four colleagues to be called. A channel is
   discovered by strangers in a directory; "Rishitt, Rahul and 12 others" is not a channel.
*/
ALTER TABLE conversation.conversations
  ADD CONSTRAINT channel_has_a_name CHECK (
    conversation_type <> 'INTERNAL_CHANNEL'
    OR (title IS NOT NULL AND btrim(title) <> '')
  );

/*
   And one name each, case-insensitively.

   Two channels called "Technology" is a support ticket: people join the wrong one and
   wonder why the room is quiet. Partial, so it constrains channels and nothing else — every
   other conversation type is free to share a title, and most do.

   An ARCHIVED channel keeps its name reserved, and that is the honest behaviour rather than
   a limitation being excused: `archived_at` lives on `conversation.channels` and a partial
   index on `conversation.conversations` cannot see another table, but more to the point a
   second "Technology" whose history is a different room is exactly the confusion this index
   exists to prevent. Freeing the word is a rename of the archived one, which is a
   deliberate act by somebody who can see both.
*/
CREATE UNIQUE INDEX channels_one_name_each
  ON conversation.conversations (lower(btrim(title)))
  WHERE conversation_type = 'INTERNAL_CHANNEL';

/* The directory's own query: every channel, newest activity first, archived excluded. */
CREATE INDEX channels_directory_idx
  ON conversation.channels (archived_at, purpose)
  WHERE archived_at IS NULL;
