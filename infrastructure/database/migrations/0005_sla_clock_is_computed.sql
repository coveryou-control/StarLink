-- =====================================================================================
-- 0005 — The SLA clock is COMPUTED, never stored. Doc §23.5.
--
-- Migration 0001 gave `service_cases` four columns that hold a clock:
-- `sla_first_response_due`, `sla_resolution_due`, `sla_breached`, `sla_breached_at`.
-- §23.5 says the opposite, in its own words:
--
--   "The clock is computed, never stored as a countdown. Elapsed working time is derived
--    from start, stops and the calendar — so a calendar correction fixes history rather
--    than leaving it wrong."
--   "A holiday added retrospectively re-derives correctly."
--
-- A stored deadline is precisely what a retroactive calendar correction cannot fix. Add a
-- forgotten holiday and every open case keeps the deadline it was given, unless somebody
-- writes a backfill and remembers to run it. That is the failure the rule exists to
-- prevent, and keeping the columns "just in case" guarantees someone eventually populates
-- them.
--
-- Safe to drop now, and cheap: nothing in the application ever wrote them. The only write
-- anywhere was a test fixture planting `sla_breached = true` to prove a customer cannot
-- see it (`customer-isolation.test.ts`), and one read in `customer-store.ts` that this
-- release replaces with a derived value.
--
-- `sla_targets` is NOT touched. Targets are configuration — versioned, effective-dated,
-- and the input to the computation. It is the DERIVED deadline that must not be stored.
-- =====================================================================================

-- Partial indexes over the dropped columns go first; Postgres would drop them with the
-- column anyway, but naming them here makes the loss deliberate rather than incidental.
-- `service_cases_running_clock_idx` existed to let a breach sweep touch only live clocks.
-- Its replacement indexes the clock's INPUT (state + when the case started), because that
-- is what a computed sweep filters on.
DROP INDEX IF EXISTS conversation.service_cases_running_clock_idx;
DROP INDEX IF EXISTS conversation.service_cases_breach_idx;

ALTER TABLE conversation.service_cases
  DROP COLUMN IF EXISTS sla_first_response_due,
  DROP COLUMN IF EXISTS sla_resolution_due,
  DROP COLUMN IF EXISTS sla_breached,
  DROP COLUMN IF EXISTS sla_breached_at;

-- The breach sweep's query shape: open cases in a team, oldest first. Everything else it
-- needs — the target, the calendar, the elapsed working time — is computed on read.
CREATE INDEX service_cases_open_clock_idx
  ON conversation.service_cases (owning_team_id, created_at)
  WHERE state IN ('NEW', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'WAITING_INTERNAL');

COMMENT ON TABLE conversation.sla_targets IS
  'SLA configuration (doc §23.5). Targets are stored; DEADLINES ARE NOT. A deadline is '
  'derived on read from the case start, the stops, and the business calendar in force — '
  'so correcting a calendar corrects history. See migration 0005.';

-- `first_response_at` and `resolved_at` STAY. They are observations — the instant a thing
-- happened — not derived deadlines. The computation needs them as its stop points, and no
-- calendar correction can change when somebody actually replied.
COMMENT ON COLUMN conversation.service_cases.first_response_at IS
  'When a customer-visible reply was first sent. An OBSERVATION, not a deadline: the '
  'first-response clock stops here. An internal note never sets it (§23.5).';
