-- =====================================================================================
-- PLACEHOLDER BUSINESS CONFIGURATION — every row is marked `is_seed_placeholder = true`.
--
-- ## Read this before changing anything here
--
-- Nothing in this file is a business decision. Every value is transcribed from a
-- recommendation the architecture document itself marks PROPOSED, awaiting confirmation
-- from the business (§44, status vocabulary: DECIDED · PROPOSED · NEEDS DISCUSSION ·
-- NO PROPOSAL). The document's own instruction, §44.5:
--
--   "No SLA duration, working-hour range or category list is invented below — the
--    framework is proposed; the values are yours."
--
-- So this file exists to make the system testable and demonstrable, NOT to answer
-- anything. The implementation plan's risk table sanctions exactly this: "Config entities
-- ship with FAKE seeds; pilot gate blocks on sign-off, build does not."
--
-- ## What the placeholder flag is for
--
-- `is_seed_placeholder` is carried all the way to the surfaces. `PgCategoryReader`
-- reports it as `provisional`, and the customer widget renders it. §68 gate 8 — "routing
-- categories, team calendars, SLA rules, fallback/cover rules, agent concurrency and
-- customer-visible statuses are configured and signed off" — is what clears it.
--
-- **A row with this flag set must never reach a real customer.** That is the whole point
-- of the flag. It is not decoration and it is not a TODO comment; it is the thing the
-- pilot gate reads.
--
-- ## Two things deliberately absent
--
--   * **WORKING HOURS.** §23.1: "No default hours are proposed. Inventing '10:00–19:00,
--     Monday to Saturday' would be inventing a business fact." D-21 has no proposal to
--     transcribe, so there is no calendar row below. A team with no calendar is treated
--     as after-hours — acknowledged, queued, no promise — which is the honest reading.
--   * **SLA DURATIONS.** §44.5 D-22: "None proposed… We will not invent these." The
--     target rows below exist only where the document gives a number to copy; it gives
--     none, so they are absent too.
--
-- Those two are the only Phase 6 items the architecture refuses to answer. Everything
-- else here has a source line.
-- =====================================================================================

-- ── Teams (§7.2 department table, with the headcounts the document records) ───────────
-- Names and sizes are from §3's directory analysis, not invented. Marked provisional
-- because the mapping of department → StarLink "team" is D-17's to confirm.
INSERT INTO identity.teams (team_id, display_name, department) VALUES
  ('fresh-sales',    'Fresh Sales',    'Sales'),
  ('retention',      'Retention',      'Sales'),
  ('corporate-sales','Corporate Sales','Sales'),
  ('renewals',       'Renewals',       'Sales'),
  ('support',        'Support',        'Service'),
  ('claims',         'Claims',         'Claims'),
  ('grievance',      'Grievance',      'Grievance'),
  ('triage',         'Triage',         'Service')
ON CONFLICT (team_id) DO NOTHING;

-- ── Categories — §21.6 "Illustrative categories — PROPOSED, not approved" ─────────────
--
-- Transcribed from the table in §21.6, including its `relationship_shaped` column, which
-- the document states per row rather than leaving open:
--
--   Sales                    → Fresh Sales (63)          "queue-shaped, no prior relationship"
--   Renewals                 → Retention (21), Renewals (19)  "relationship-shaped"
--   Existing policy/service  → Support (18)              "queue with continuity"
--   Claims                   → Claims (4)                "case-shaped"
--   Grievance                → Grievance (1)             "one person; a real single point of failure"
--   Other / not sure         → Triage, then reroute
--
-- "Other / not sure" is not filler. §21.6: "Without it a customer who cannot classify
-- their own problem either abandons or picks wrongly, and a wrong category means wrong
-- routing, wrong team and a wrong clock."
--
-- Renewals maps to ONE team here although the document names two candidates (Retention
-- and Renewals). A category maps to exactly one team in the schema, and choosing between
-- two candidate teams is D-17's, not this file's — `renewals` is used because it shares
-- the category's name. Flagged, and to be corrected on sign-off.
INSERT INTO conversation.categories
  (category_id, parent_id, display_name, owning_team_id, relationship_shaped, default_priority, active, is_seed_placeholder)
VALUES
  ('sales',      NULL, 'Sales',                   'fresh-sales', false, 'NORMAL', true, true),
  ('renewals',   NULL, 'Renewals',                'renewals',    true,  'NORMAL', true, true),
  ('service',    NULL, 'Existing policy / service','support',    false, 'NORMAL', true, true),
  ('claims',     NULL, 'Claims',                  'claims',      false, 'HIGH',   true, true),
  ('grievance',  NULL, 'Grievance',               'grievance',   false, 'HIGH',   true, true),
  -- N-50 / D-14 (2026-08-31). The Project Head's taxonomy names seven conversation types
  -- and this one was absent entirely: a customer with a failed premium debit or a payment
  -- they cannot trace had no topic to pick, and would have landed in triage. Added as a
  -- placeholder like every other row here — the wording and the owning team are still the
  -- business's to confirm (D-17/D-18).
  ('payment',    NULL, 'Payment / transaction',   'support',     false, 'HIGH',   true, true),
  ('other',      NULL, 'Other / not sure',        'triage',      false, 'NORMAL', true, true)
ON CONFLICT (category_id) DO NOTHING;

-- Sub-categories — §21.6's "Plausible sub-categories (PROPOSED)" column.
-- Two levels, sub-category OPTIONAL: §44.5 D-18, "Every mandatory field is a place a
-- customer abandons."
INSERT INTO conversation.categories
  (category_id, parent_id, display_name, owning_team_id, relationship_shaped, active, is_seed_placeholder)
VALUES
  ('sales.new-policy',       'sales',     'New policy',        'fresh-sales', false, true, true),
  ('sales.quotation',        'sales',     'Quotation',         'fresh-sales', false, true, true),
  ('sales.product-question', 'sales',     'Product question',  'fresh-sales', false, true, true),
  ('renewals.due',           'renewals',  'Renewal due',       'renewals',    true,  true, true),
  ('renewals.premium',       'renewals',  'Premium change',    'renewals',    true,  true, true),
  ('renewals.lapse',         'renewals',  'Lapse',             'renewals',    true,  true, true),
  ('service.update-details', 'service',   'Update details',    'support',     false, true, true),
  ('service.documents',      'service',   'Documents',         'support',     false, true, true),
  ('service.endorsement',    'service',   'Endorsement',       'support',     false, true, true),
  ('claims.new',             'claims',    'New claim',         'claims',      false, true, true),
  ('claims.status',          'claims',    'Claim status',      'claims',      false, true, true),
  ('claims.documents',       'claims',    'Documents',         'claims',      false, true, true),
  ('grievance.complaint',    'grievance', 'Complaint',         'grievance',   false, true, true),
  ('grievance.escalation',   'grievance', 'Escalation',        'grievance',   false, true, true)
ON CONFLICT (category_id) DO NOTHING;

-- ── Agent concurrency — §54's engineering envelope, not a staffing decision ───────────
--
-- §54 gives an explicit initial acceptance envelope: "Active agent chats — Configurable
-- 3–6 per chat-qualified agent by role/complexity", to be "revised with production
-- telemetry". §55 adds: "Agent concurrency should never be a hard-coded '5 chats each'."
--
-- Seeded at the lower bound of the document's own range. A TEAM-scoped policy, so it
-- applies to everyone on the team without asserting anything about an individual;
-- per-principal rows are a lead's to add once D-05 takes a position on whether a ceiling
-- makes someone unavailable at all (§21.9: "At or over a workload ceiling — Optional;
-- needs a business position").
--
-- `work_weights` carries §55's "conversation complexity" idea: "Claims/grievance/high-risk
-- cases may consume more than one chat capacity unit; simple sales FAQ less."
INSERT INTO conversation.capacity_policies
  (policy_id, scope_kind, scope_id, capacity_units, work_weights, reservation_ttl_sec, is_seed_placeholder)
VALUES
  ('018f2c5a-5eed-7000-8000-000000000001', 'TEAM', 'fresh-sales', 3,
   '{"default": 1, "sales": 1}'::jsonb, 120, true),
  ('018f2c5a-5eed-7000-8000-000000000002', 'TEAM', 'renewals', 3,
   '{"default": 1, "renewals": 1}'::jsonb, 120, true),
  ('018f2c5a-5eed-7000-8000-000000000003', 'TEAM', 'support', 3,
   '{"default": 1, "service": 1}'::jsonb, 120, true),
  ('018f2c5a-5eed-7000-8000-000000000004', 'TEAM', 'claims', 3,
   '{"default": 2, "claims": 2}'::jsonb, 120, true),
  ('018f2c5a-5eed-7000-8000-000000000005', 'TEAM', 'grievance', 3,
   '{"default": 2, "grievance": 2}'::jsonb, 120, true),
  ('018f2c5a-5eed-7000-8000-000000000006', 'TEAM', 'triage', 3,
   '{"default": 1}'::jsonb, 120, true)
ON CONFLICT (policy_id) DO NOTHING;

-- ── NOT SEEDED, and deliberately ─────────────────────────────────────────────────────
--
-- conversation.business_calendars  — D-21. §23.1 refuses to propose hours, so there is
--                                    nothing to transcribe. Every team therefore reads as
--                                    after-hours until the business supplies its hours:
--                                    acknowledged and queued, with no promise made.
--
-- conversation.sla_targets         — D-22. §44.5 refuses to propose durations. The
--                                    `basis` column ('BUSINESS_HOURS' | 'CALENDAR_24X7')
--                                    is where D-23's answer lands; the document proposes
--                                    BUSINESS_HOURS for teams staffed only in hours, but
--                                    a basis without a duration is not a row.
--
-- Both are the two roots §44.6 names: "D-17 and D-21 are the two new roots. Nothing in
-- the customer journey can be finalised without them, and both are questions only the
-- business can answer."
