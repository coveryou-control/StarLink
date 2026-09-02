-- =====================================================================================
-- 0010 — per-notification read state
--
-- §19.6 specifies a "Notification list — server-owned; the client polls or receives an
-- event · actionable items only (§29.2)", and §20.7's `Notification created` row gives
-- its recovery path: "Notification list on load", authorized "personal room, self only".
-- What neither specifies is how an item LEAVES the list.
--
-- Everything the document says about read marking is about conversations — FR-READ-1
-- "unread is per person per conversation", FR-READ-2 "read state is recorded on thread
-- open", FR-READ-4 "must not write on every scroll event". A notification item has no
-- equivalent rule.
--
-- **This is therefore an engineering choice with no source behind it**, taken on
-- 2026-08-28 and recorded as such in STARLINK_OPEN_QUESTIONS.md (N-19). It is a UI
-- mechanism, not a business value: nothing here sets a policy, a target or a threshold.
--
-- ## Why per-notification rather than derived from the conversation
--
-- The obvious cheaper design is "a notification is read when its target conversation has
-- been opened", reusing `conversation.read_state`, which already exists and already
-- implements FR-READ-2's on-open discipline. It was rejected for one reason:
-- `ROLE_OR_ACCESS_CHANGED` has no target conversation. Under the derived design that
-- notification could never be cleared — and it is precisely the one somebody will later
-- need to show was delivered and seen.
--
-- ## Why a column and not a table
--
-- Read state is one nullable timestamp per notification, written at most once, by the
-- one principal the row already names. A join table would model a many-to-many that does
-- not exist: a notification row has exactly one recipient (that is what makes the
-- dedupe key work).
-- =====================================================================================

ALTER TABLE conversation.notification_outbox
  ADD COLUMN read_at timestamptz;

-- The bell's only hot query: this recipient's unread in-app items, newest first.
-- Partial, because a read notification is never fetched by it and a full index would
-- grow without bound as history accumulates.
CREATE INDEX notification_unread_idx
  ON conversation.notification_outbox (recipient_id, created_at DESC)
  WHERE read_at IS NULL AND channel = 'INAPP' AND state = 'SENT';
