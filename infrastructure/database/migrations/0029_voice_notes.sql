-- Voice notes.
--
-- A voice note is an ATTACHMENT, not a new kind of message. It goes through the same
-- grant → upload → scan → promote → bind pipeline as a PDF, is authorised by the same
-- ladder, and rides the same realtime frame. Nothing here creates a second messaging
-- path; §28's rules apply to it unchanged.
--
-- One thing an audio attachment needs that a document does not: its LENGTH, known before
-- the bytes are fetched. A thread shows "7:34" beside a play button, and the only other
-- way to learn that is to download the file — which would defeat the lazy download grant
-- (§28.4 audits every issuance) and make a list of ten voice notes ten audited downloads
-- nobody asked for.
--
-- Nullable, because every attachment already in this table has no duration and most never
-- will. A document with a duration would be the odd thing, not a voice note without one.
ALTER TABLE conversation.attachments
  ADD COLUMN IF NOT EXISTS duration_ms integer;

-- The duration arrives from the recorder, which is the client, so it is bounded here as
-- well as validated at the edge. A negative or absurd value is a bug or a lie, and either
-- way it must not reach a bubble that renders it: the constraint is what stops "-1:00" or
-- a four-hour voice note being a thing the database will hold.
--
-- Twelve hours rather than a tighter number on purpose. The PRODUCT limit is configurable
-- (`SL_VOICE_NOTE_MAX_SECONDS`) and belongs in configuration, not in a migration nobody
-- can change without a deploy; this is only the outer bound of physical plausibility, so
-- that raising the product limit never requires a schema change.
ALTER TABLE conversation.attachments
  DROP CONSTRAINT IF EXISTS attachments_duration_sane;

ALTER TABLE conversation.attachments
  ADD CONSTRAINT attachments_duration_sane
  CHECK (duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 43200000));
