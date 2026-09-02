-- =====================================================================================
-- 0006 — Case state history, and a record of what we NOTIFIED. Doc §24.11, §23.5, §23.6.
--
-- §24.11 names *SLA State* as a V1 entity and says what it holds: "Per case per clock:
-- started-at, stop-at, **pause spans**, breach flag and breach time."
--
-- Pause spans are the part that could not be computed from anything we stored. §23.5
-- requires the resolution clock to stop while we are waiting on the customer (D-22), and
-- answering "how long was it paused" needs to know WHEN it was waiting — historically,
-- not just now. `service_cases.state` is a single current value; it cannot say that a
-- case was WAITING_CUSTOMER from Tuesday to Thursday.
--
-- So state changes become an append-only, dated episode series, exactly like
-- `ownership_episodes`. §24.3 already lists the data that may never be overwritten —
-- messages, ownership, audit, participant changes — for one reason: "who was responsible
-- on the day must stay answerable". The same argument applies to "what state was it in on
-- the day", because that is now an input to an SLA number somebody may dispute.
--
-- ## This does not reintroduce a stored countdown
--
-- Migration 0005 removed the stored deadlines because §23.5 requires the clock to be
-- computed. Nothing here contradicts that. What is stored below is OBSERVATIONS — the
-- instant a state was entered, the instant it was left — which are facts that happened.
-- The derived values (elapsed, remaining, breached) are still computed on read, so a
-- corrected calendar still corrects history.
--
-- The distinction is worth holding on to: store what happened, derive what it means.
-- =====================================================================================

CREATE TABLE conversation.case_state_episodes (
  episode_id      uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  state           conversation.conversation_state NOT NULL,
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  -- Who caused the change. NULL for a system transition (after-hours queueing, the
  -- reopen-window expiry sweep) — those have no principal and inventing one would put a
  -- person's name against something nobody did.
  entered_by      uuid REFERENCES identity.principals(principal_id),
  -- §21.4 requires a reason on some transitions (resolve carries the outcome; a
  -- staff-initiated reopen carries why). Enforced in the domain, recorded here.
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_state_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- A conversation is in exactly one state at any instant, guaranteed by the DATABASE
  -- rather than by application discipline — the same shape as `ownership_no_overlap`.
  -- Two concurrent transitions cannot both commit, so a race cannot produce a history
  -- that says a case was ACTIVE and RESOLVED at the same moment, which would make the
  -- pause-span arithmetic silently wrong rather than visibly broken.
  CONSTRAINT case_state_no_overlap EXCLUDE USING gist (
    conversation_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

-- The clock's own query: every episode for one conversation, in order.
CREATE INDEX case_state_episodes_conversation_idx
  ON conversation.case_state_episodes (conversation_id, effective_from);

-- The pause-span query, and the only one that runs across conversations: which cases are
-- currently waiting, and since when. Partial, because a closed episode is history.
CREATE INDEX case_state_episodes_live_idx
  ON conversation.case_state_episodes (state, effective_from)
  WHERE effective_to IS NULL;

-- =====================================================================================
-- What we TOLD somebody, which is not the same as what is true.
--
-- §23.6 escalates in stages: warning to the owner, then breach to the owner and lead,
-- then an escalation level. Each must happen ONCE. Breach state is computed on every
-- read, so without a record of having notified, a sweep running every minute would send
-- a breach notification every minute for as long as the case stayed breached.
--
-- Deliberately a record of an ACTION rather than a cached verdict. If a calendar is later
-- corrected and the breach un-happens, this row still correctly says we notified someone
-- on Tuesday — because we did. The truth is recomputed; the history of our behaviour is
-- not rewritten.
-- =====================================================================================

CREATE TABLE conversation.sla_notifications (
  conversation_id uuid NOT NULL REFERENCES conversation.conversations(conversation_id) ON DELETE CASCADE,
  clock           text NOT NULL,
  level           text NOT NULL,
  notified_at     timestamptz NOT NULL DEFAULT now(),
  -- The computed elapsed time at the moment we acted, kept so a later dispute can see
  -- what the system believed when it sent the notification, even if the calendar has
  -- since changed what the answer would be.
  elapsed_seconds integer NOT NULL,
  CONSTRAINT sla_notification_clock_check CHECK (clock IN ('FIRST_RESPONSE', 'RESOLUTION', 'ESCALATION')),
  CONSTRAINT sla_notification_level_check CHECK (level IN ('WARNING', 'BREACH', 'ESCALATION')),
  PRIMARY KEY (conversation_id, clock, level)
);

COMMENT ON TABLE conversation.case_state_episodes IS
  'Append-only state history (§24.3, §24.11). Supplies the pause spans the resolution '
  'clock subtracts. Observations only — derived SLA values are computed on read (§23.5).';

COMMENT ON TABLE conversation.sla_notifications IS
  'What was notified, once per case per clock per level (§23.6). A record of our action, '
  'not a cached verdict: a corrected calendar changes what is true, never what we did.';
