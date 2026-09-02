-- =====================================================================================
-- 0007 — A scan may REJECT a file without the scanner having failed. Doc §28.2, §59.
--
-- Migration 0001 constrained `attachment_scan_results.verdict` to
-- CLEAN · INFECTED · SUSPICIOUS · FAILED. Four values that do not cover the outcome
-- §28.2 actually produces most often: a file refused on POLICY rather than on content.
--
-- An executable declared as a PDF, a file whose measured size exceeds the ceiling, a
-- container whose type cannot be determined — none of these is malware, none is merely
-- "suspicious", and calling any of them FAILED would say the scanner broke when in fact
-- it worked perfectly and the file did not pass.
--
-- That distinction is not pedantry. It is the difference between two operational
-- questions with different answers:
--
--   "Is our scanner healthy?"        — FAILED counts against it. REJECTED does not.
--   "Are we blocking bad uploads?"   — REJECTED and INFECTED are the evidence.
--
-- Collapsing them would make a scanner outage look like a busy week of policy
-- enforcement, and a busy week look like an outage.
--
-- Expand-only: the constraint is widened, never narrowed, so every row written under
-- 0001 remains valid and nothing needs rewriting.
-- =====================================================================================

ALTER TABLE conversation.attachment_scan_results
  DROP CONSTRAINT IF EXISTS scan_verdict_check;

ALTER TABLE conversation.attachment_scan_results
  ADD CONSTRAINT scan_verdict_check
  CHECK (verdict IN ('CLEAN', 'INFECTED', 'SUSPICIOUS', 'REJECTED', 'FAILED'));

COMMENT ON COLUMN conversation.attachment_scan_results.verdict IS
  'CLEAN · INFECTED (malware, terminal) · SUSPICIOUS (flagged, not conclusive) · '
  'REJECTED (failed policy: MIME mismatch, oversized, undeterminable type) · '
  'FAILED (the scan itself could not complete). REJECTED and FAILED are deliberately '
  'distinct: one is the pipeline working, the other is it broken (migration 0007).';
