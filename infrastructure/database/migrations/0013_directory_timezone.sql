-- Where a colleague works, in the one sense the directory could not already answer.
--
-- `identity.principals` already carries `employee_id`, `manager_id` and `branch`, and the
-- product never exposed any of them — the information panel the design specifies has an
-- Employee ID, a "Reports to", a Location and a Local time, and three of those four were
-- sitting in this table unread.
--
-- The fourth needs a column. A timezone is not derivable from a branch name without a
-- lookup table nobody has agreed (rule 10: never invent a business value), so it is stored
-- and it is NULLABLE — a principal HRMS has not told us about renders no local time rather
-- than a guessed one. Nothing defaults it.
--
-- IANA names, not offsets: an offset is wrong twice a year in every country that shifts,
-- and is wrong permanently the moment a government changes the rule.

ALTER TABLE identity.principals
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN identity.principals.timezone IS
  'IANA zone (e.g. Asia/Kolkata). NULL when the directory has not supplied one; the '
  'employee panel then shows no local time rather than assuming the reader''s own.';
