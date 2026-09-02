-- =====================================================================================
-- PLACEHOLDER CALENDARS AND SLA TARGETS — D-21, D-22, D-23.
--
-- ## These are the two values the architecture explicitly refuses to propose
--
-- §23.1: "No default hours are proposed. Inventing '10:00–19:00, Monday to Saturday'
-- would be inventing a business fact."
-- §44.5 D-22: "None proposed… We will not invent these."
--
-- Nothing below overturns that. These rows are a STAND-IN chosen by the engineering lead
-- on 2026-08-27 so the clocks can run and the §23.6 pipeline can be exercised end to end
-- before the business answers. Every row carries `is_seed_placeholder = true`, which is
-- what §68 gate 8 — "team calendars, SLA rules… configured and signed off" — reads.
--
-- **Provenance of the hours, stated plainly.** 10:00–19:30 Monday to Saturday is what sir
-- said on 2026-08-25. That answer was RETRACTED the same day: he had been answering a
-- question about a different product, and nothing was built on it at the time. It is used
-- here because a plausible stand-in is more useful than an arbitrary one, NOT because it
-- has been confirmed. It has not. Ask again against StarLink before the pilot.
--
-- **Provenance of the targets.** Thirty minutes is the figure §23.5's own worked examples
-- use throughout, so a seeded system behaves like the diagrams in the document. Eight
-- working hours for resolution is roughly one working day. Neither is a business promise.
--
-- Re-runnable and non-destructive: `ON CONFLICT DO NOTHING` throughout, so a lead who has
-- corrected a calendar in the admin console does not have it overwritten by a developer
-- running the seeder.
-- =====================================================================================

-- ── Business calendars (D-21) ────────────────────────────────────────────────────────
--
-- Monday to Saturday, 10:00–19:30 local, `Asia/Kolkata`. Weekday numbering is 0 = Sunday,
-- so 1–6 is Mon–Sat and Sunday is absent, which is how a closed day is expressed.
-- 10:00 = minute 600; 19:30 = minute 1170.
--
-- The timezone is EXPLICIT on every row. §23.1: "One timezone per calendar. Explicit,
-- never inferred from a server clock." A process running in UTC and a laptop in IST must
-- agree about whether Claims was open at 19:05.
--
-- Holidays are EMPTY, and that is a real gap rather than a claim that there are none.
-- India has a long public-holiday list and the business has not supplied theirs; an empty
-- array means every one of those days currently reads as a working day. §23.5 makes this
-- recoverable — "a holiday added retrospectively re-derives correctly" — so adding them
-- later fixes history rather than only the future.
INSERT INTO conversation.business_calendars
  (calendar_id, team_id, timezone, version, effective_from, working_windows, holidays, exceptions, is_seed_placeholder)
SELECT
  ('018f2c5a-ca1e-7000-8000-' || lpad(row_number() OVER (ORDER BY t.team_id)::text, 12, '0'))::uuid,
  t.team_id,
  'Asia/Kolkata',
  1,
  timestamptz '2020-01-01 00:00:00+00',
  '[{"weekday":1,"openMinute":600,"closeMinute":1170},
    {"weekday":2,"openMinute":600,"closeMinute":1170},
    {"weekday":3,"openMinute":600,"closeMinute":1170},
    {"weekday":4,"openMinute":600,"closeMinute":1170},
    {"weekday":5,"openMinute":600,"closeMinute":1170},
    {"weekday":6,"openMinute":600,"closeMinute":1170}]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  true
FROM identity.teams t
WHERE t.team_id IN
  ('fresh-sales','retention','corporate-sales','renewals','support','claims','grievance','triage')
  AND NOT EXISTS (
    SELECT 1 FROM conversation.business_calendars c WHERE c.team_id = t.team_id
  );

-- ── SLA targets (D-22, D-23) ─────────────────────────────────────────────────────────
--
-- Scoped to the TEAM. D-22 permits "per category or per team"; team is the coarser of the
-- two and therefore the smaller thing to correct when the business answers. The
-- CATEGORY-over-TEAM precedence is built and tested, so tightening Claims later is a row,
-- not a change.
--
-- `basis = 'BUSINESS_HOURS'` on every row — §44.5 D-23's recommendation (a), for teams
-- staffed only during their hours. §23.2's warning is the reason: "A 24×7 target without
-- 24×7 staffing breaches every night — that is a staffing decision wearing an SLA
-- costume." Nobody is rostered here overnight, so nothing here pretends otherwise.
--
-- `warning_pct = 80` is the column's existing schema default, and is itself D-25's to
-- confirm. At 80% of the target §23.6 says: "notify the OWNER. Nothing else. Quiet nudge."
INSERT INTO conversation.sla_targets
  (sla_target_id, scope_kind, scope_id, clock, target_seconds, basis, warning_pct, version, effective_from, is_seed_placeholder)
SELECT
  ('018f2c5a-51a0-7000-8000-' || lpad((row_number() OVER (ORDER BY t.team_id, c.clock))::text, 12, '0'))::uuid,
  'TEAM',
  t.team_id,
  c.clock,
  c.target_seconds,
  'BUSINESS_HOURS',
  80,
  1,
  timestamptz '2020-01-01 00:00:00+00',
  true
FROM identity.teams t
CROSS JOIN (VALUES
  -- Thirty minutes of WORKING time. §23.5's worked example: a message at 18:55 has five
  -- minutes counted before the close and the remaining twenty-five the next morning.
  ('FIRST_RESPONSE', 30 * 60),
  -- Eight working hours ≈ one working day on a 9.5-hour window.
  ('RESOLUTION', 8 * 3600)
) AS c(clock, target_seconds)
WHERE t.team_id IN
  ('fresh-sales','retention','corporate-sales','renewals','support','claims','grievance','triage')
  AND NOT EXISTS (
    SELECT 1 FROM conversation.sla_targets s
     WHERE s.scope_kind = 'TEAM' AND s.scope_id = t.team_id AND s.clock = c.clock
  );

-- ── NOT seeded, still ────────────────────────────────────────────────────────────────
--
-- An ESCALATION-clock target. §23.5 defines the clock — it "starts on escalation, stops
-- when the receiving function makes first contact" — but nothing in the document proposes
-- a duration for it, and unlike first response there is no worked example to borrow. A
-- target invented for it would be the least grounded number in this file.
--
-- Holidays, as noted above. The single largest known gap in these placeholders.
