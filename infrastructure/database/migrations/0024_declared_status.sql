-- What somebody says they are doing.
--
-- Asked for on 2026-09-04: online and offline are already automatic; add "busy", "in a
-- meeting" and "away".
--
-- ## This is NOT presence, and the distinction is the whole design
--
-- §21.9 is explicit that presence is not availability — "a phone entering a lift is not
-- leave" — which is why `use-presence.ts` reports one thing only: does this colleague
-- currently hold a realtime lease. It never says "away" and never says "busy", because
-- inferring either from a socket is inferring a fact about a person from a fact about a
-- network.
--
-- A DECLARED status is the opposite: the person said it. Nothing is inferred, nothing is
-- guessed from idle time, and no keyboard is watched. That is why it can carry words §21.9
-- refuses to let presence carry.
--
-- The two are shown together and never merged. Somebody can be offline with "in a meeting"
-- set (they closed the laptop and went), and online with it too (they are in a meeting
-- with the laptop open). Collapsing them into one indicator would lose exactly the
-- information the reader wants.
--
-- ## Still not availability
--
-- Nothing routes on this and nothing may. It does not touch queue eligibility, capacity,
-- or whether somebody can be assigned work — those come from `identity.agent_states` and
-- the work orchestrator, which are a different question with different consequences. This
-- is a courtesy to the colleague about to message you.
--
-- ## Why StarLink owns it and rule 11 is not breached
--
-- Rule 11 forbids a second Customer Master, Opportunity model, Consent engine, Work
-- Orchestrator or permanent user AUTHORITY. This is none of those: HRMS is still the only
-- source of who somebody is, what they are called, and what team they are on. "I am in a
-- meeting for the next hour" is not an identity fact and HRMS has no opinion about it —
-- there is no upstream to adapt to, so there is nothing being duplicated.
--
-- It lives in the `identity` schema because it is keyed by principal, and §35.4 permits
-- only three schemas. It is named for what it is so nobody mistakes it for a mirror of
-- HRMS.
--
-- ## Why it expires
--
-- Because people forget. A status with no end becomes a lie within a day — the colleague
-- who set "in a meeting" on Tuesday morning is not still in it on Friday, and a reader who
-- has been burned by that once stops believing any of them. `clears_at` is required for
-- everything except AVAILABLE, which is the absence of a claim and cannot go stale.
--
-- Like every other effective period here, both ends are stamped by the APPLICATION clock,
-- never by the database's `now()` — see CLAUDE.md.

CREATE TABLE IF NOT EXISTS identity.declared_status (
  principal_id  uuid PRIMARY KEY REFERENCES identity.principals(principal_id) ON DELETE CASCADE,
  -- A CHECK rather than an enum type: adding a word to an enum takes an exclusive lock on
  -- every table using it, and this list will grow when somebody asks for "on leave".
  status        text NOT NULL CHECK (status IN ('AVAILABLE', 'BUSY', 'IN_A_MEETING', 'AWAY')),
  set_at        timestamptz NOT NULL,
  -- NULL only for AVAILABLE, which is the absence of a claim. Enforced below rather than
  -- left to the application: a status that never clears is the defect this column exists
  -- to prevent, and "the API always sets it" is not a property.
  clears_at     timestamptz,
  CONSTRAINT declared_status_expires
    CHECK (status = 'AVAILABLE' OR clears_at IS NOT NULL)
);

COMMENT ON TABLE identity.declared_status IS
  'What a person SAYS they are doing — set by them, never inferred. Distinct from presence '
  '(a realtime lease, §21.9) and from availability (agent_states, which routing reads). '
  'Nothing may route on this. Everything except AVAILABLE carries an expiry, because a '
  'status that cannot go stale is one nobody has to remember to clear — see 0024.';

COMMENT ON COLUMN identity.declared_status.clears_at IS
  'When the claim stops being true. An elapsed row reads as AVAILABLE with no sweep '
  'needed, so nothing has to run for the status to expire.';
