-- Profile and group pictures.
--
-- Asked for on 2026-09-04: let people change their own picture, and a group's.
--
-- ## Why the bytes live here and not in object storage
--
-- StarLink has an object-storage pipeline and it is the right one for ATTACHMENTS: a grant
-- is issued, the client uploads to quarantine, a scanner reports, the object is promoted,
-- and a download needs an audited short-lived grant (§28.1, ADR-012). Every step of that
-- exists because an attachment is an arbitrary file of arbitrary size that one colleague
-- hands another.
--
-- An avatar is none of those things. It is a square image under a quarter of a megabyte,
-- it belongs to the person or the group rather than to a conversation — so it does not fit
-- `attachments.conversation_id`, which is NOT NULL — and it is shown to everybody who can
-- already see the name beside it, so there is nothing for a per-object grant to protect.
-- Running it through quarantine-and-promote would add three round trips, a scanner
-- dependency and an unbound-object sweep to store a thumbnail.
--
-- ## What replaces the scanner
--
-- The client re-encodes through a canvas before upload: the image is decoded to pixels and
-- written back out as PNG or JPEG. Anything that was not pixels — an SVG's script, a
-- polyglot's trailing payload, EXIF carrying location — does not survive that round trip,
-- because none of it is pixels. The server then accepts only three content types and
-- rejects anything whose bytes do not begin with that type's magic number, so a caller
-- bypassing the browser cannot simply relabel a file.
--
-- That is stronger than scanning for this shape of input, not weaker: a scanner looks for
-- known-bad, and re-encoding discards everything that is not the one thing we want.
--
-- ## Size
--
-- `bytea` with a hard ceiling enforced in the application and restated here. 256 KB is
-- roughly four times what a 256px PNG needs, so the limit is never reached by an honest
-- client and is a wall for a dishonest one. At that ceiling a thousand employees is 256 MB
-- worst case and realistically a tenth of it.

CREATE TABLE IF NOT EXISTS identity.principal_avatars (
  principal_id  uuid PRIMARY KEY REFERENCES identity.principals(principal_id) ON DELETE CASCADE,
  image         bytea NOT NULL,
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- Stamped by the application clock, like every other instant in this schema. Used as a
  -- cache-buster in the URL so a changed picture appears without a hard reload.
  updated_at    timestamptz NOT NULL,
  CONSTRAINT principal_avatar_size CHECK (octet_length(image) BETWEEN 1 AND 262144)
);

COMMENT ON TABLE identity.principal_avatars IS
  'One picture per person, uploaded by them. Bytes rather than object storage: an avatar '
  'is a sub-256KB square shown to everybody who can already see the name beside it, so the '
  'grant-quarantine-scan-promote pipeline attachments need buys nothing here. Safety comes '
  'from canvas re-encoding on the client plus a magic-number check on the server — see 0025.';

CREATE TABLE IF NOT EXISTS conversation.conversation_avatars (
  conversation_id uuid PRIMARY KEY
    REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  image           bytea NOT NULL,
  content_type    text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- Who set it. A group picture is shared, so like a pinned message it is an act with an
  -- author, and the audit ledger carries the act itself.
  set_by          uuid NOT NULL REFERENCES identity.principals(principal_id),
  updated_at      timestamptz NOT NULL,
  CONSTRAINT conversation_avatar_size CHECK (octet_length(image) BETWEEN 1 AND 262144)
);

COMMENT ON TABLE conversation.conversation_avatars IS
  'One picture per group. Only INTERNAL_GROUP conversations get one — a one-to-one is '
  'already drawn with the other person''s own avatar, and giving it a second would let one '
  'side change how the other appears in their own list.';
